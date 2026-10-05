//! A small regular-expression subset for attribute-name patterns
//! (`removeAttr` with `/^data-/`).
//!
//! Supported, with JavaScript's meaning: literals, `.`, classes `[a-z_]` /
//! `[^…]`, the escapes `\d \D \w \W \s \S \. \- …`, the anchors `^` and `$`,
//! groups `( )` and `(?: )`, alternation `|`, and the quantifiers `* + ?
//! {n} {n,} {n,m}` (a trailing lazy `?` is accepted). Not supported, and
//! rejected when compiling: back-references, lookaround, named groups,
//! flags. Why a subset and not a regex engine: the one use is matching
//! attribute names, and the build must not depend on a regex crate.
//!
//! Matching is a backtracking search with a step budget, so a pathological
//! pattern fails the build with an error instead of hanging it.

use std::cell::Cell;

const STEP_BUDGET: u64 = 2_000_000;
const MAX_REPEAT: usize = 1000;
const MAX_DEPTH: usize = 64;

/// A pattern that failed to compile, or a match that ran out of budget.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatternError(pub String);

impl std::fmt::Display for PatternError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

impl std::error::Error for PatternError {}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ClassItem {
	Range(char, char),
	Digit(bool),
	Word(bool),
	Space(bool),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Node {
	Char(char),
	Any,
	Class {
		negated: bool,
		items: Vec<ClassItem>,
	},
	Start,
	End,
	Group(Vec<Vec<Node>>),
	Repeat {
		node: Box<Node>,
		min: usize,
		max: Option<usize>,
	},
}

/// A compiled pattern.
///
/// # Example
///
/// ```
/// let p = kd_html::pattern::Pattern::new("^data-(x|y)\\d+$").unwrap();
/// assert_eq!(p.is_match("data-x12"), Ok(true));
/// assert_eq!(p.is_match("data-z1"), Ok(false));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pattern {
	alternatives: Vec<Vec<Node>>,
}

struct Compiler {
	chars: Vec<char>,
	pos: usize,
}

impl Compiler {
	fn err<T>(&self, message: &str) -> Result<T, PatternError> {
		Err(PatternError(format!("invalid pattern: {message}")))
	}

	fn peek(&self) -> Option<char> {
		self.chars.get(self.pos).copied()
	}

	fn alternatives(&mut self, depth: usize) -> Result<Vec<Vec<Node>>, PatternError> {
		if depth > MAX_DEPTH {
			return self.err("groups are nested too deeply");
		}
		let mut alternatives = vec![self.sequence(depth)?];
		while self.peek() == Some('|') {
			self.pos += 1;
			alternatives.push(self.sequence(depth)?);
		}
		Ok(alternatives)
	}

	fn sequence(&mut self, depth: usize) -> Result<Vec<Node>, PatternError> {
		let mut seq = Vec::new();
		while let Some(c) = self.peek() {
			if c == '|' || c == ')' {
				break;
			}
			let atom = self.atom(depth)?;
			seq.push(self.quantified(atom)?);
		}
		Ok(seq)
	}

	fn atom(&mut self, depth: usize) -> Result<Node, PatternError> {
		let c = self.peek().unwrap();
		self.pos += 1;
		match c {
			'.' => Ok(Node::Any),
			'^' => Ok(Node::Start),
			'$' => Ok(Node::End),
			'(' => {
				if self.peek() == Some('?') {
					self.pos += 1;
					if self.peek() != Some(':') {
						return self.err("only `(?:` groups are supported");
					}
					self.pos += 1;
				}
				let alternatives = self.alternatives(depth + 1)?;
				if self.peek() != Some(')') {
					return self.err("a `)` is missing");
				}
				self.pos += 1;
				Ok(Node::Group(alternatives))
			}
			'[' => self.class(),
			'\\' => {
				let Some(e) = self.peek() else {
					return self.err("a backslash at the end");
				};
				self.pos += 1;
				match e {
					'd' | 'D' | 'w' | 'W' | 's' | 'S' => Ok(Node::Class {
						negated: false,
						items: vec![shorthand(e)],
					}),
					'0'..='9' | 'k' | 'b' | 'B' | 'p' | 'P' | 'u' | 'x' | 'c' => {
						self.err("back-references and unicode escapes are not supported")
					}
					'n' => Ok(Node::Char('\n')),
					't' => Ok(Node::Char('\t')),
					'r' => Ok(Node::Char('\r')),
					other => Ok(Node::Char(other)),
				}
			}
			'*' | '+' | '?' | '{' => self.err("a quantifier has nothing to repeat"),
			other => Ok(Node::Char(other)),
		}
	}

	fn class(&mut self) -> Result<Node, PatternError> {
		let negated = self.peek() == Some('^');
		if negated {
			self.pos += 1;
		}
		let mut items = Vec::new();
		loop {
			let Some(c) = self.peek() else {
				return self.err("a `]` is missing");
			};
			self.pos += 1;
			if c == ']' {
				break;
			}
			let lo = if c == '\\' {
				let Some(e) = self.peek() else {
					return self.err("a backslash at the end");
				};
				self.pos += 1;
				match e {
					'd' | 'D' | 'w' | 'W' | 's' | 'S' => {
						items.push(shorthand(e));
						continue;
					}
					'n' => '\n',
					't' => '\t',
					'r' => '\r',
					other => other,
				}
			} else {
				c
			};
			if self.peek() == Some('-') && self.chars.get(self.pos + 1).is_some_and(|&n| n != ']') {
				self.pos += 1;
				let mut hi = self.peek().unwrap();
				self.pos += 1;
				if hi == '\\' {
					let Some(e) = self.peek() else {
						return self.err("a backslash at the end");
					};
					self.pos += 1;
					hi = e;
				}
				if hi < lo {
					return self.err("a class range is out of order");
				}
				items.push(ClassItem::Range(lo, hi));
			} else {
				items.push(ClassItem::Range(lo, lo));
			}
		}
		Ok(Node::Class { negated, items })
	}

	fn quantified(&mut self, atom: Node) -> Result<Node, PatternError> {
		let (min, max) = match self.peek() {
			Some('*') => (0, None),
			Some('+') => (1, None),
			Some('?') => (0, Some(1)),
			Some('{') => {
				let start = self.pos;
				let Some(close) = self.chars[start..].iter().position(|&c| c == '}') else {
					return self.err("a `}` is missing");
				};
				let body: String = self.chars[start + 1..start + close].iter().collect();
				let parsed = match body.split_once(',') {
					None => body.parse::<usize>().ok().map(|n| (n, Some(n))),
					Some((lo, "")) => lo.parse::<usize>().ok().map(|n| (n, None)),
					Some((lo, hi)) => lo
						.parse::<usize>()
						.ok()
						.zip(hi.parse::<usize>().ok())
						.map(|(a, b)| (a, Some(b))),
				};
				let Some((min, max)) = parsed else {
					return self.err("an invalid `{}` quantifier");
				};
				if max.is_some_and(|m| m < min)
					|| min > MAX_REPEAT
					|| max.is_some_and(|m| m > MAX_REPEAT)
				{
					return self.err("a `{}` quantifier is out of range");
				}
				self.pos = start + close;
				(min, max)
			}
			_ => return Ok(atom),
		};
		self.pos += 1;
		// A lazy marker is accepted and ignored: the question is only whether
		// a match exists, which does not depend on the order of the search.
		if self.peek() == Some('?') {
			self.pos += 1;
		}
		if matches!(atom, Node::Start | Node::End) {
			return self.err("an anchor cannot be repeated");
		}
		Ok(Node::Repeat {
			node: Box::new(atom),
			min,
			max,
		})
	}
}

fn shorthand(c: char) -> ClassItem {
	match c {
		'd' => ClassItem::Digit(true),
		'D' => ClassItem::Digit(false),
		'w' => ClassItem::Word(true),
		'W' => ClassItem::Word(false),
		's' => ClassItem::Space(true),
		_ => ClassItem::Space(false),
	}
}

fn class_matches(items: &[ClassItem], negated: bool, c: char) -> bool {
	let hit = items.iter().any(|item| match item {
		ClassItem::Range(lo, hi) => (*lo..=*hi).contains(&c),
		ClassItem::Digit(yes) => c.is_ascii_digit() == *yes,
		ClassItem::Word(yes) => (c.is_ascii_alphanumeric() || c == '_') == *yes,
		// JavaScript's `\s`: Unicode white space plus the BOM, without U+0085.
		ClassItem::Space(yes) => ((c.is_whitespace() && c != '\u{85}') || c == '\u{feff}') == *yes,
	});
	hit != negated
}

struct Matcher<'a> {
	input: &'a [char],
	steps: Cell<u64>,
}

type Cont<'k> = &'k mut dyn FnMut(usize) -> bool;

impl Matcher<'_> {
	fn tick(&self) -> bool {
		let n = self.steps.get() + 1;
		self.steps.set(n);
		n <= STEP_BUDGET
	}

	fn seq(&self, nodes: &[Node], pos: usize, k: Cont<'_>) -> bool {
		if !self.tick() {
			return false;
		}
		let Some((first, rest)) = nodes.split_first() else {
			return k(pos);
		};
		self.node(first, pos, &mut |next| self.seq(rest, next, k))
	}

	fn alternatives(&self, alternatives: &[Vec<Node>], pos: usize, k: Cont<'_>) -> bool {
		for alternative in alternatives {
			if self.seq(alternative, pos, k) {
				return true;
			}
		}
		false
	}

	fn node(&self, node: &Node, pos: usize, k: Cont<'_>) -> bool {
		match node {
			Node::Char(c) => self.input.get(pos) == Some(c) && k(pos + 1),
			Node::Any => {
				self.input
					.get(pos)
					.is_some_and(|c| !matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
					&& k(pos + 1)
			}
			Node::Class { negated, items } => {
				self.input
					.get(pos)
					.is_some_and(|&c| class_matches(items, *negated, c))
					&& k(pos + 1)
			}
			Node::Start => pos == 0 && k(pos),
			Node::End => pos == self.input.len() && k(pos),
			Node::Group(alternatives) => self.alternatives(alternatives, pos, k),
			Node::Repeat { node, min, max } => self.repeat(node, *min, *max, 0, pos, k),
		}
	}

	fn repeat(
		&self,
		node: &Node,
		min: usize,
		max: Option<usize>,
		count: usize,
		pos: usize,
		k: Cont<'_>,
	) -> bool {
		if !self.tick() {
			return false;
		}
		let can_more = max.is_none_or(|m| count < m);
		let more = |this: &Self, k: Cont<'_>| {
			can_more
				&& this.node(node, pos, &mut |next| {
					// An empty iteration beyond the minimum cannot make
					// progress; stop it so `(a*)*` terminates.
					(next != pos || count < min) && this.repeat(node, min, max, count + 1, next, k)
				})
		};
		if count < min {
			return more(self, k);
		}
		more(self, k) || k(pos)
	}
}

impl Pattern {
	/// Compiles `source` (the text between the slashes).
	///
	/// # Errors
	///
	/// A [`PatternError`] for syntax outside the supported subset.
	pub fn new(source: &str) -> Result<Pattern, PatternError> {
		let mut compiler = Compiler {
			chars: source.chars().collect(),
			pos: 0,
		};
		let alternatives = compiler.alternatives(0)?;
		if compiler.pos != compiler.chars.len() {
			return compiler.err("an unmatched `)`");
		}
		Ok(Pattern { alternatives })
	}

	/// Whether the pattern matches anywhere in `text` (a JavaScript
	/// `RegExp.test`).
	///
	/// # Errors
	///
	/// A [`PatternError`] when the search exceeded its step budget.
	pub fn is_match(&self, text: &str) -> Result<bool, PatternError> {
		let input: Vec<char> = text.chars().collect();
		let matcher = Matcher {
			input: &input,
			steps: Cell::new(0),
		};
		for start in 0..=input.len() {
			if matcher.alternatives(&self.alternatives, start, &mut |_| true) {
				return Ok(true);
			}
			if matcher.steps.get() > STEP_BUDGET {
				return Err(PatternError(
					"the pattern took too many steps on an attribute name".to_owned(),
				));
			}
		}
		Ok(false)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn is(pattern: &str, text: &str) -> bool {
		Pattern::new(pattern).unwrap().is_match(text).unwrap()
	}

	#[test]
	fn literals_anchors_and_search() {
		assert!(is("data", "x-data-y"));
		assert!(is("^data", "data-x"));
		assert!(!is("^data", "x-data"));
		assert!(is("data$", "x-data"));
		assert!(!is("^data$", "data-x"));
		assert!(is("", "anything"));
	}

	#[test]
	fn dot_classes_and_shorthands() {
		assert!(is("^d.t.$", "data"));
		assert!(is("^[a-c]+$", "abcabc"));
		assert!(!is("^[^a-c]+$", "abc"));
		assert!(is("^[a-z-]+$", "data-x"));
		assert!(is("^\\d{2,3}$", "123"));
		assert!(!is("^\\d{2,3}$", "1234"));
		assert!(is("^\\w+$", "a_1"));
		assert!(is("^\\s$", "\u{a0}"));
		assert!(is("^[\\d_]+$", "1_2"));
		assert!(is("a\\.b", "a.b"));
		assert!(!is("a\\.b", "axb"));
	}

	#[test]
	fn alternation_groups_and_quantifiers() {
		assert!(is("^(on|data)-", "on-x"));
		assert!(is("^(?:on|data)-", "data-x"));
		assert!(!is("^(?:on|data)-", "aria-x"));
		assert!(is("^a(bc)*d$", "abcbcd"));
		assert!(is("^a(bc)*d$", "ad"));
		assert!(is("^ab?c$", "ac"));
		assert!(
			is("^(a*){2}$", ""),
			"an empty iteration counts toward the minimum"
		);
		assert!(is("^a{0}b$", "b"));
		assert!(is("^a.*?b", "aXXb"));
		assert!(is("^(a*)*$", "aaaa"), "empty iterations terminate");
	}

	#[test]
	fn unsupported_or_broken_syntax_is_rejected() {
		for bad in [
			"(", ")", "[a", "a**", "*a", "(?=a)", "\\1", "a{2,1}", "a{x}", "^*", "[z-a]",
			"(?<n>a)", "\\", "\\u0041",
		] {
			assert!(Pattern::new(bad).is_err(), "`{bad}` should not compile");
		}
	}

	#[test]
	fn a_pathological_pattern_fails_instead_of_hanging() {
		let p = Pattern::new("^(a+)+$").unwrap();
		let text = format!("{}b", "a".repeat(40));
		assert!(p.is_match(&text).is_err());
	}

	#[test]
	fn multibyte_text_is_matched_by_characters() {
		assert!(is("^.$", "日"));
		assert!(is("^data-.+$", "data-日本"));
	}
}
