//! Glob matching with the semantics of fast-glob / picomatch that kamado
//! configs rely on.
//!
//! Supported syntax: `*` (within one path segment), `?` (one character),
//! `**` (as a whole segment: zero or more segments), `[abc]` / `[a-z]` /
//! `[!a]` / `[^a]` character classes, `{a,b}` alternatives (nestable) and
//! `\` to escape the next character. A leading `!` marks a negated pattern.
//!
//! Why `dot: false`: `*`, `?`, `**` and classes never match a segment that
//! starts with `.`; such a segment is matched only when the pattern segment
//! starts with a literal `.`. This mirrors fast-glob's default and keeps
//! `.git`, `.kamado` and editor droppings out of a build.
//!
//! Why not extglobs (`@(a|b)`, `+(x)`, ...): no config used them, they are
//! rarely understood by readers, and supporting them makes `(` significant.
//! They are rejected with a clear error instead of being silently treated as
//! literals.
//!
//! Matching is case sensitive and paths use `/` as the separator. Callers
//! normalize OS paths before matching.

use std::fmt;

/// A compiled glob.
///
/// # Example
///
/// ```
/// let p = kd_glob::Pattern::new("**/*.{html,tsx}").unwrap();
/// assert!(p.matches("pages/about/index.tsx"));
/// assert!(!p.matches("pages/.draft/index.tsx"));
/// ```
#[derive(Debug, Clone)]
pub struct Pattern {
	source: String,
	negated: bool,
	alternatives: Vec<Vec<Segment>>,
}

#[derive(Debug, Clone, PartialEq)]
enum Segment {
	/// `**`: zero or more whole segments (none starting with `.`).
	Globstar,
	Tokens(Vec<Token>),
}

#[derive(Debug, Clone, PartialEq)]
enum Token {
	Char(char),
	/// `*`
	Any,
	/// `?`
	One,
	Class {
		negated: bool,
		ranges: Vec<(char, char)>,
	},
}

/// A pattern syntax error with the 0-based character offset in the source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	pub offset: usize,
	pub message: String,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "glob syntax error at {}: {}", self.offset, self.message)
	}
}

impl std::error::Error for Error {}

impl Pattern {
	/// Compiles a glob.
	pub fn new(source: &str) -> Result<Pattern, Error> {
		let (negated, body) = match source.strip_prefix('!') {
			Some(rest) => (true, rest),
			None => (false, source),
		};
		let body = body.strip_prefix("./").unwrap_or(body);
		let expanded = expand_braces(body)?;
		let mut alternatives = Vec::with_capacity(expanded.len());
		for alt in expanded {
			alternatives.push(compile_segments(&alt)?);
		}
		Ok(Pattern {
			source: source.to_string(),
			negated,
			alternatives,
		})
	}

	/// The pattern as written.
	#[must_use]
	pub fn source(&self) -> &str {
		&self.source
	}

	/// True when the pattern was written with a leading `!`.
	#[must_use]
	pub fn is_negated(&self) -> bool {
		self.negated
	}

	/// Tests a `/`-separated relative path. A leading `./` is ignored.
	/// Negation is **not** applied here: a negated pattern matches the same
	/// paths as its body, and callers decide what to do with `is_negated()`.
	#[must_use]
	pub fn matches(&self, path: &str) -> bool {
		let path = path.strip_prefix("./").unwrap_or(path);
		let segments: Vec<&str> = path.split('/').collect();
		self.alternatives
			.iter()
			.any(|alt| match_segments(alt, &segments))
	}

	/// True when the pattern ends in `**` and its leading segments match
	/// `dir` exactly, i.e. everything below `dir` is matched. A walker uses it
	/// to skip an ignored directory without descending into it.
	///
	/// This treats `dir/**` as covering the whole subtree, including entries
	/// whose names start with `.` (which `matches` alone would not match under
	/// `dot: false`): "ignore this directory" is how a config reader means it.
	///
	/// # Example
	///
	/// ```
	/// let p = kd_glob::Pattern::new("_includes/**").unwrap();
	/// assert!(p.covers_dir("_includes"));
	/// assert!(!p.covers_dir("pages"));
	/// assert!(!kd_glob::Pattern::new("_includes/*.html").unwrap().covers_dir("_includes"));
	/// ```
	#[must_use]
	pub fn covers_dir(&self, dir: &str) -> bool {
		let dir = dir.strip_prefix("./").unwrap_or(dir);
		let segments: Vec<&str> = dir.split('/').collect();
		self.alternatives.iter().any(|alt| match alt.split_last() {
			Some((Segment::Globstar, lead)) => match_segments(lead, &segments) && !lead.is_empty(),
			_ => false,
		})
	}

	/// The longest leading run of path segments that contain no glob
	/// characters, joined with `/`. A directory walker can start from here.
	/// Empty when the first segment is already a glob (or the pattern has
	/// alternatives that disagree).
	///
	/// # Example
	///
	/// ```
	/// assert_eq!(kd_glob::Pattern::new("src/pages/**/*.tsx").unwrap().literal_prefix(), "src/pages");
	/// assert_eq!(kd_glob::Pattern::new("**/*.css").unwrap().literal_prefix(), "");
	/// ```
	#[must_use]
	pub fn literal_prefix(&self) -> String {
		let mut common: Option<Vec<String>> = None;
		for alt in &self.alternatives {
			let mut prefix = Vec::new();
			// The last segment names a file, never a directory to start from.
			for seg in alt.iter().take(alt.len().saturating_sub(1)) {
				match seg {
					Segment::Tokens(tokens)
						if tokens.iter().all(|t| matches!(t, Token::Char(_))) =>
					{
						prefix.push(
							tokens
								.iter()
								.map(|t| match t {
									Token::Char(c) => *c,
									_ => unreachable!(),
								})
								.collect::<String>(),
						);
					}
					_ => break,
				}
			}
			common = Some(match common {
				None => prefix,
				Some(existing) => existing
					.iter()
					.zip(prefix.iter())
					.take_while(|(a, b)| a == b)
					.map(|(a, _)| a.clone())
					.collect(),
			});
		}
		common.unwrap_or_default().join("/")
	}
}

/// The most brace-free patterns one glob may expand to. Why: every group multiplies the
/// count (`{a,b}{c,d}{e,f}...` is 2^N), so a glob of a few hundred bytes could otherwise
/// use up the memory and the time of the build. Real globs expand to a few dozen. The
/// bound is also the cost per path: `matches` tries every alternative, for every file
/// the walk meets.
pub const MAX_BRACE_EXPANSIONS: usize = 1_000;

/// The most `{` groups one inside another or one after another. Why: the expansion
/// recurses once per group, and a long run of them would overflow the stack before the
/// count above is reached. Groups in a row have at least two alternatives each, so more
/// than ten of them already exceed [`MAX_BRACE_EXPANSIONS`]: the bound matters for
/// nested groups, which multiply less.
pub const MAX_BRACE_DEPTH: usize = 32;

/// Expands `{a,b}` groups (nested allowed) into brace-free patterns.
/// Escaped braces and braces inside classes are left alone. A glob that expands to more
/// than [`MAX_BRACE_EXPANSIONS`] patterns, or has more than [`MAX_BRACE_DEPTH`] groups
/// nested or in a row, is an error.
fn expand_braces(source: &str) -> Result<Vec<String>, Error> {
	let chars: Vec<char> = source.chars().collect();
	let mut results = Vec::new();
	expand_into(&chars, 0, String::new(), &mut results, 0)?;
	Ok(results)
}

fn expand_into(
	chars: &[char],
	start: usize,
	prefix: String,
	out: &mut Vec<String>,
	depth: usize,
) -> Result<(), Error> {
	let mut i = start;
	let mut current = prefix;
	while i < chars.len() {
		match chars[i] {
			'\\' if i + 1 < chars.len() => {
				current.push('\\');
				current.push(chars[i + 1]);
				i += 2;
			}
			'[' => {
				// Copy a class verbatim so `{` inside it is literal.
				let end = find_class_end(chars, i).ok_or(Error {
					offset: i,
					message: "unterminated character class '['".to_string(),
				})?;
				current.extend(&chars[i..=end]);
				i = end + 1;
			}
			'{' => {
				if depth >= MAX_BRACE_DEPTH {
					return Err(Error {
						offset: i,
						message: format!(
							"more than {MAX_BRACE_DEPTH} brace groups nested or in a row"
						),
					});
				}
				let end = find_brace_end(chars, i).ok_or(Error {
					offset: i,
					message: "unterminated brace group '{'".to_string(),
				})?;
				let options = split_alternatives(&chars[i + 1..end]);
				if options.len() < 2 {
					return Err(Error {
						offset: i,
						message: "a brace group needs at least two alternatives".to_string(),
					});
				}
				let rest = &chars[end + 1..];
				for option in options {
					let mut branch: Vec<char> = option;
					branch.extend_from_slice(rest);
					expand_into(&branch, 0, current.clone(), out, depth + 1)?;
				}
				return Ok(());
			}
			'}' => {
				return Err(Error {
					offset: i,
					message: "unmatched '}'".to_string(),
				});
			}
			c => {
				current.push(c);
				i += 1;
			}
		}
	}
	if out.len() >= MAX_BRACE_EXPANSIONS {
		return Err(Error {
			offset: 0,
			message: format!("the braces expand to more than {MAX_BRACE_EXPANSIONS} patterns"),
		});
	}
	out.push(current);
	Ok(())
}

fn find_class_end(chars: &[char], open: usize) -> Option<usize> {
	let mut i = open + 1;
	if matches!(chars.get(i), Some('!' | '^')) {
		i += 1;
	}
	// A `]` right after the opening is a literal member.
	if chars.get(i) == Some(&']') {
		i += 1;
	}
	while i < chars.len() {
		match chars[i] {
			'\\' => i += 2,
			']' => return Some(i),
			_ => i += 1,
		}
	}
	None
}

fn find_brace_end(chars: &[char], open: usize) -> Option<usize> {
	let mut depth = 0usize;
	let mut i = open;
	while i < chars.len() {
		match chars[i] {
			'\\' => i += 2,
			'[' => {
				i = find_class_end(chars, i)? + 1;
			}
			'{' => {
				depth += 1;
				i += 1;
			}
			'}' => {
				depth -= 1;
				if depth == 0 {
					return Some(i);
				}
				i += 1;
			}
			_ => i += 1,
		}
	}
	None
}

/// Splits the inside of a brace group on top-level commas.
fn split_alternatives(inner: &[char]) -> Vec<Vec<char>> {
	let mut options = Vec::new();
	let mut current = Vec::new();
	let mut depth = 0usize;
	let mut i = 0;
	while i < inner.len() {
		match inner[i] {
			'\\' if i + 1 < inner.len() => {
				current.push('\\');
				current.push(inner[i + 1]);
				i += 2;
				continue;
			}
			// A class is copied verbatim so its `,` `{` `}` are literal, in
			// agreement with `find_brace_end`.
			'[' => {
				if let Some(end) = find_class_end(inner, i) {
					current.extend(&inner[i..=end]);
					i = end + 1;
					continue;
				}
			}
			'{' => depth += 1,
			'}' => depth = depth.saturating_sub(1),
			',' if depth == 0 => {
				options.push(std::mem::take(&mut current));
				i += 1;
				continue;
			}
			_ => {}
		}
		current.push(inner[i]);
		i += 1;
	}
	options.push(current);
	options
}

fn compile_segments(pattern: &str) -> Result<Vec<Segment>, Error> {
	let mut segments = Vec::new();
	let mut offset = 0;
	for raw in pattern.split('/') {
		if raw == "**" {
			// `**/**` is `**`; keeping one avoids needless work in the matcher.
			if !matches!(segments.last(), Some(Segment::Globstar)) {
				segments.push(Segment::Globstar);
			}
		} else {
			segments.push(Segment::Tokens(compile_tokens(raw, offset)?));
		}
		offset += raw.chars().count() + 1;
	}
	Ok(segments)
}

fn compile_tokens(segment: &str, base_offset: usize) -> Result<Vec<Token>, Error> {
	let chars: Vec<char> = segment.chars().collect();
	let mut tokens = Vec::new();
	let mut i = 0;
	while i < chars.len() {
		let c = chars[i];
		match c {
			'\\' => {
				let next = chars.get(i + 1).ok_or(Error {
					offset: base_offset + i,
					message: "trailing backslash".to_string(),
				})?;
				tokens.push(Token::Char(*next));
				i += 2;
			}
			'*' => {
				// `a**b` behaves like `a*b`; collapse runs.
				if !matches!(tokens.last(), Some(Token::Any)) {
					tokens.push(Token::Any);
				}
				i += 1;
			}
			'?' => {
				tokens.push(Token::One);
				i += 1;
			}
			'[' => {
				let end = find_class_end(&chars, i).ok_or(Error {
					offset: base_offset + i,
					message: "unterminated character class '['".to_string(),
				})?;
				tokens.push(parse_class(&chars[i + 1..end]));
				i = end + 1;
			}
			'(' | ')' | '|' => {
				return Err(Error {
					offset: base_offset + i,
					message: format!(
						"'{c}' is not supported (extglob syntax); escape it with a backslash to match it literally"
					),
				});
			}
			c => {
				tokens.push(Token::Char(c));
				i += 1;
			}
		}
	}
	Ok(tokens)
}

fn parse_class(inner: &[char]) -> Token {
	let mut i = 0;
	let negated = matches!(inner.first(), Some('!' | '^'));
	if negated {
		i = 1;
	}
	let mut ranges = Vec::new();
	while i < inner.len() {
		let mut lo = inner[i];
		if lo == '\\' && i + 1 < inner.len() {
			i += 1;
			lo = inner[i];
		}
		i += 1;
		if i + 1 < inner.len() && inner[i] == '-' {
			let mut hi = inner[i + 1];
			let mut consumed = 2;
			if hi == '\\' && i + 2 < inner.len() {
				hi = inner[i + 2];
				consumed = 3;
			}
			ranges.push((lo, hi));
			i += consumed;
		} else {
			ranges.push((lo, lo));
		}
	}
	Token::Class { negated, ranges }
}

/// Dynamic programming over (pattern segment, path segment): `table[i][j]` is
/// whether `pattern[i..]` matches `path[j..]`. Why not plain recursion: with
/// several `**` the number of ways to split the path grows exponentially, and
/// `discover` runs every pattern against every file, so one unlucky config
/// glob would hang the build. This is O(pattern x path) segment matches.
fn match_segments(pattern: &[Segment], path: &[&str]) -> bool {
	let n = pattern.len();
	let m = path.len();
	let mut table = vec![vec![false; m + 1]; n + 1];
	table[n][m] = true;
	for i in (0..n).rev() {
		match &pattern[i] {
			Segment::Globstar if i == n - 1 => {
				// A trailing `**` consumes at least one segment (`a/**` does not
				// match `a`), and none of them may be a dot-segment.
				let mut all_plain = true;
				for j in (0..m).rev() {
					all_plain = all_plain && !path[j].starts_with('.');
					table[i][j] = all_plain;
				}
			}
			Segment::Globstar => {
				for j in (0..=m).rev() {
					// Zero segments, or one more non-dot segment and stay on `**`.
					table[i][j] =
						table[i + 1][j] || (j < m && !path[j].starts_with('.') && table[i][j + 1]);
				}
			}
			Segment::Tokens(tokens) => {
				for j in 0..m {
					table[i][j] = table[i + 1][j + 1] && match_tokens(tokens, path[j]);
				}
			}
		}
	}
	table[0][0]
}

fn match_tokens(tokens: &[Token], segment: &str) -> bool {
	// dot: false — only a literal leading '.' in the pattern matches a dot-segment.
	if segment.starts_with('.') && !matches!(tokens.first(), Some(Token::Char('.'))) {
		return false;
	}
	let chars: Vec<char> = segment.chars().collect();
	match_tokens_at(tokens, &chars)
}

/// Whether a single-character token accepts `c`. `Any` never reaches here.
fn single_matches(token: &Token, c: char) -> bool {
	match token {
		Token::One => true,
		Token::Char(x) => *x == c,
		Token::Class { negated, ranges } => {
			ranges.iter().any(|&(lo, hi)| lo <= c && c <= hi) != *negated
		}
		Token::Any => false,
	}
}

/// Wildcard matching with the "remember the last `*`" technique: on a
/// mismatch, retry from the last star with one more character swallowed.
/// O(tokens x chars) worst case; recursion would be exponential in the
/// number of stars (`*a*a*a*b` against `aaaa...`).
fn match_tokens_at(tokens: &[Token], chars: &[char]) -> bool {
	let (mut ti, mut ci) = (0usize, 0usize);
	let mut star: Option<(usize, usize)> = None;
	while ci < chars.len() {
		match tokens.get(ti) {
			Some(Token::Any) => {
				star = Some((ti, ci));
				ti += 1;
				continue;
			}
			Some(token) if single_matches(token, chars[ci]) => {
				ti += 1;
				ci += 1;
				continue;
			}
			_ => {}
		}
		match star {
			Some((star_ti, star_ci)) => {
				ti = star_ti + 1;
				ci = star_ci + 1;
				star = Some((star_ti, star_ci + 1));
			}
			None => return false,
		}
	}
	while matches!(tokens.get(ti), Some(Token::Any)) {
		ti += 1;
	}
	ti == tokens.len()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn m(pattern: &str, path: &str) -> bool {
		Pattern::new(pattern).unwrap().matches(path)
	}

	#[test]
	fn star_stays_within_one_segment() {
		assert!(m("*.html", "index.html"));
		assert!(!m("*.html", "a/index.html"));
		assert!(m("a/*.html", "a/index.html"));
		assert!(!m("a/*.html", "a/b/index.html"));
		assert!(m("*", "abc"));
		assert!(m("a*c", "abbbc"));
		assert!(m("a*c", "ac"));
		assert!(!m("a*c", "ab"));
	}

	#[test]
	fn question_mark_matches_exactly_one_character() {
		assert!(m("?.html", "a.html"));
		assert!(!m("?.html", "ab.html"));
		assert!(!m("?.html", ".html"));
		assert!(m("日?語.html", "日本語.html"));
	}

	#[test]
	fn globstar_matches_zero_or_more_segments() {
		assert!(m("**/*.html", "index.html"));
		assert!(m("**/*.html", "a/index.html"));
		assert!(m("**/*.html", "a/b/c/index.html"));
		assert!(m("a/**/b", "a/b"));
		assert!(m("a/**/b", "a/x/b"));
		assert!(m("a/**/b", "a/x/y/b"));
		assert!(!m("a/**/b", "a/x/y"));
		assert!(m("a/**", "a/x"));
		assert!(m("a/**", "a/x/y.z"));
		assert!(!m("a/**", "a"));
		assert!(!m("a/**", "b/x"));
	}

	#[test]
	fn globstar_inside_a_segment_is_a_plain_star() {
		assert!(m("a**b", "axxb"));
		assert!(!m("a**b", "ax/xb"));
	}

	#[test]
	fn dotfiles_need_a_literal_dot() {
		assert!(!m("*", ".env"));
		assert!(!m("**/*.html", ".hidden/index.html"));
		assert!(!m("**/*.html", "a/.hidden/index.html"));
		assert!(!m("*.html", ".index.html"));
		assert!(!m("?env", ".env"));
		assert!(!m("[.]env", ".env"));
		assert!(m(".*", ".env"));
		assert!(m(".hidden/**/*.html", ".hidden/a/index.html"));
		assert!(m("**/.kamado/*", "a/.kamado/cache"));
	}

	#[test]
	fn character_classes() {
		assert!(m("[abc].html", "b.html"));
		assert!(!m("[abc].html", "d.html"));
		assert!(m("[a-c].html", "c.html"));
		assert!(!m("[a-c].html", "d.html"));
		assert!(m("[!a].html", "b.html"));
		assert!(!m("[!a].html", "a.html"));
		assert!(m("[^a].html", "b.html"));
		assert!(m("[]a].html", "].html"));
		assert!(m("[\\]].html", "].html"));
		assert!(m("[a-cx-z]", "y"));
		assert!(!m("[a-cx-z]", "m"));
	}

	#[test]
	fn brace_alternatives_expand_including_nested_groups() {
		assert!(m("**/*.{html,tsx}", "a/b.tsx"));
		assert!(m("**/*.{html,tsx}", "a/b.html"));
		assert!(!m("**/*.{html,tsx}", "a/b.css"));
		assert!(m("{a,b}/**", "b/x/y"));
		assert!(m("a{b,c{d,e}}f", "abf"));
		assert!(m("a{b,c{d,e}}f", "acdf"));
		assert!(m("a{b,c{d,e}}f", "acef"));
		assert!(!m("a{b,c{d,e}}f", "acf"));
		assert!(m("{_includes,drafts}/**", "drafts/x.html"));
	}

	#[test]
	fn braces_inside_classes_and_escaped_braces_are_literal() {
		assert!(m("a[{]b", "a{b"));
		assert!(m("a\\{b,c\\}d", "a{b,c}d"));
	}

	#[test]
	fn escapes_make_metacharacters_literal() {
		assert!(m("a\\*b", "a*b"));
		assert!(!m("a\\*b", "axb"));
		assert!(m("a\\?b", "a?b"));
		assert!(m("\\(x\\)", "(x)"));
	}

	#[test]
	fn leading_dot_slash_is_ignored_on_both_sides() {
		assert!(m("./a/*.html", "a/index.html"));
		assert!(m("a/*.html", "./a/index.html"));
	}

	#[test]
	fn negation_is_reported_not_applied() {
		let p = Pattern::new("!**/*.spec.ts").unwrap();
		assert!(p.is_negated());
		assert!(p.matches("a/b.spec.ts"));
		assert!(!Pattern::new("**/*.spec.ts").unwrap().is_negated());
	}

	#[test]
	fn literal_prefix_for_walker_pruning() {
		assert_eq!(
			Pattern::new("src/pages/**/*.tsx").unwrap().literal_prefix(),
			"src/pages"
		);
		assert_eq!(Pattern::new("**/*.css").unwrap().literal_prefix(), "");
		assert_eq!(Pattern::new("a/b/c.html").unwrap().literal_prefix(), "a/b");
		assert_eq!(Pattern::new("index.html").unwrap().literal_prefix(), "");
		assert_eq!(Pattern::new("a/{b,c}/*.css").unwrap().literal_prefix(), "a");
		assert_eq!(Pattern::new("{a,b}/x/*.css").unwrap().literal_prefix(), "");
		assert_eq!(
			Pattern::new("a/x\\*y/*.css").unwrap().literal_prefix(),
			"a/x*y"
		);
	}

	#[test]
	fn pathological_patterns_finish_quickly() {
		// These took minutes with plain backtracking.
		let stars = format!("{}b", "*a".repeat(10));
		assert!(!m(&stars, &"a".repeat(40)));
		let globstars = "**/a/".repeat(8) + "b";
		assert!(!m(&globstars, &"a/".repeat(40)));
		assert!(m(
			&format!("{}b", "*a".repeat(10)),
			&format!("{}b", "a".repeat(40))
		));
		let mut deep = "x/".repeat(200);
		deep.push('y');
		assert!(m("**/y", &deep));
	}

	#[test]
	fn consecutive_globstars_collapse() {
		assert!(m("**/**/a.html", "a.html"));
		assert!(m("**/**/a.html", "x/y/a.html"));
		assert!(!m("a/**/**", "a"));
		assert!(m("a/**/**", "a/b"));
	}

	#[test]
	fn star_matching_edge_cases() {
		assert!(m("*", ""));
		assert!(m("a*", "a"));
		assert!(m("*a", "ba"));
		assert!(!m("*a", "ab"));
		assert!(m("a*b*c", "aXbYc"));
		assert!(!m("a*b*c", "aXbY"));
		assert!(m("*.*", "a.b"));
		assert!(m("[a-c]*[x-z]", "bxxxz"));
	}

	#[test]
	fn character_classes_inside_braces_keep_their_commas() {
		assert!(m("{a,[,]b}", "a"));
		assert!(m("{a,[,]b}", ",b"));
		assert!(!m("{a,[,]b}", "b"));
		assert!(m("x{[{],y}z", "x{z"));
		assert!(m("x{[{],y}z", "xyz"));
	}

	#[test]
	fn covers_dir_for_pruning() {
		let p = Pattern::new("_includes/**").unwrap();
		assert!(p.covers_dir("_includes"));
		assert!(!p.covers_dir("_includes/sub"));
		assert!(!p.covers_dir("pages"));
		assert!(
			Pattern::new("**/node_modules/**")
				.unwrap()
				.covers_dir("a/node_modules")
		);
		assert!(
			Pattern::new("**/node_modules/**")
				.unwrap()
				.covers_dir("node_modules")
		);
		assert!(Pattern::new("{a,b}/**").unwrap().covers_dir("b"));
		assert!(!Pattern::new("**").unwrap().covers_dir("anything"));
		assert!(!Pattern::new("a/*.html").unwrap().covers_dir("a"));
	}

	#[test]
	fn case_sensitive() {
		assert!(!m("*.HTML", "index.html"));
		assert!(m("*.HTML", "index.HTML"));
	}

	#[test]
	fn braces_that_expand_to_exactly_the_limit_are_accepted() {
		// A group of ten and a group of a hundred alternatives: 10 * 100 is exactly the limit.
		let group = |n: usize| {
			format!(
				"{{{}}}",
				(0..n).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
			)
		};
		let pattern = format!("{}{}", group(10), group(100));
		assert_eq!(MAX_BRACE_EXPANSIONS, 10 * 100);
		let p = Pattern::new(&pattern).unwrap();
		assert!(p.matches("00"));
		assert!(p.matches("999"));
		assert!(!p.matches("5"));
	}

	#[test]
	fn braces_that_expand_to_one_more_than_the_limit_are_an_error() {
		// A group of eleven and a group of a hundred: 11 * 100 = 1100.
		let group = |n: usize| {
			format!(
				"{{{}}}",
				(0..n).map(|i| i.to_string()).collect::<Vec<_>>().join(",")
			)
		};
		let err = Pattern::new(&format!("{}{}", group(11), group(100))).unwrap_err();
		assert_eq!(err.message, "the braces expand to more than 1000 patterns");
	}

	#[test]
	fn groups_in_a_row_that_multiply_past_the_limit_are_an_error() {
		// 2^10 = 1024 alternatives, from a pattern of 50 characters.
		let err = Pattern::new(&"{a,b}".repeat(10)).unwrap_err();
		assert_eq!(err.message, "the braces expand to more than 1000 patterns");
	}

	#[test]
	fn groups_in_a_row_under_the_limit_are_accepted() {
		// 2^9 = 512 alternatives.
		let p = Pattern::new(&"{a,b}".repeat(9)).unwrap();
		assert!(p.matches("ababababa"));
	}

	#[test]
	fn a_hundred_thousand_groups_end_in_an_error_not_in_a_stack_overflow() {
		let err = Pattern::new(&"{a,b}".repeat(100_000)).unwrap_err();
		assert_eq!(err.message, "more than 32 brace groups nested or in a row");
	}

	#[test]
	fn a_deep_nesting_of_braces_is_an_error() {
		let pattern = format!("{}a,b{}", "{".repeat(100_000), ",c}".repeat(100_000));
		let err = Pattern::new(&pattern).unwrap_err();
		assert_eq!(err.message, "more than 32 brace groups nested or in a row");
	}

	#[test]
	fn nesting_up_to_the_depth_limit_is_accepted() {
		// `{{{a,b},c},d}` is 3 deep: one more level per `{`.
		let levels = 32;
		let pattern = format!("{}a,b{}", "{".repeat(levels), ",c}".repeat(levels));
		let p = Pattern::new(&pattern).unwrap();
		assert!(p.matches("a"));
		assert!(p.matches("c"));
	}

	#[test]
	fn rejects_extglobs_and_malformed_patterns() {
		let err = Pattern::new("@(a|b)").unwrap_err();
		assert_eq!(err.offset, 1);
		assert!(err.message.contains("extglob"));
		assert_eq!(
			Pattern::new("a[bc").unwrap_err().message,
			"unterminated character class '['"
		);
		assert_eq!(
			Pattern::new("a{b,c").unwrap_err().message,
			"unterminated brace group '{'"
		);
		assert_eq!(Pattern::new("a}b").unwrap_err().message, "unmatched '}'");
		assert_eq!(
			Pattern::new("a{b}c").unwrap_err().message,
			"a brace group needs at least two alternatives"
		);
		assert_eq!(
			Pattern::new("abc\\").unwrap_err().message,
			"trailing backslash"
		);
	}

	#[test]
	fn source_is_kept_verbatim() {
		assert_eq!(Pattern::new("!./a/**").unwrap().source(), "!./a/**");
	}
}
