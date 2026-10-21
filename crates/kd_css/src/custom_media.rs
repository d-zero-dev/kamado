//! `@custom-media` ([Media Queries 5 §10]): the definitions are removed and
//! every `(--name)` in the prelude of an `@media` is resolved, the way
//! postcss-custom-media (the version the D-ZERO PostCSS config of v2 pins)
//! resolves it; `scripts/check-css-custom-media.mjs` compares the two.
//!
//! ```css
//! @custom-media --md-lte (width < 992px);
//! @media (--md-lte) { a { top: 0 } }
//! /* => @media (width < 992px) { a { top: 0 } } */
//! ```
//!
//! `(--name)` is true when the query list of the definition matches. A query
//! that is only the reference becomes that list, and a reference to one plain
//! feature such as `(width < 1px)` becomes that feature where it is written.
//! Anything else (a list, a media type, `(a) and (b)`, `not (a)`) is not
//! written in its place, as postcss-custom-media does not (in places such as
//! `not (--name)` or `((--name) or (hover))` it could not be): the rule is
//! then written twice, once in `@media <definition>` with the reference made
//! a query that always matches, and once in `@media <negated definition>` with
//! a query that never matches. Each such reference of a query doubles the
//! rule.
//!
//! ```css
//! @custom-media --l (width < 1px), print;
//! @media not (--l) { a { top: 0 } }
//! /* => @media (width < 1px), print { @media not (max-color:2147477350) { a { top: 0 } } }
//!       @media not print { @media not all and (width < 1px) {
//!         @media not (color:2147477350) { a { top: 0 } } } } */
//! ```
//!
//! A reference that is not defined is left as it is (a browser does not know
//! it, so the query does not match), and so is one to a definition in a loop:
//! Media Queries 5 leaves every definition of a loop undefined, and a
//! definition that uses one of them resolves up to that reference.
//!
//! Where postcss-custom-media departs from the specification, the
//! specification is followed: it drops only one name of each loop and
//! resolves the others; it negates `not screen and (a)` as `screen, (a)`,
//! which matches more than `screen and (a)` does; it takes the definition in
//! the cascade layer of the highest priority, where Media Queries 5 takes the
//! last one; and it removes a `@layer` block left empty by the removal of its
//! definitions, which can move the layer in the layer order.
//!
//! A style sheet that is not minified is resolved in its text
//! ([`resolve_text`]) to the same rules: the tree of the parser does not keep
//! the white space and the comments it is written with.
//!
//! [Media Queries 5 §10]: https://drafts.csswg.org/mediaqueries-5/#custom-mq

use std::collections::{HashMap, HashSet};

use crate::parse::{AtRule, Body, Comment, Node, parse_stylesheet};
use crate::print::Mark;

/// A query that always matches (`true` in a definition): no device has that
/// many colors per component. postcss-custom-media writes the same one.
const ALWAYS: &str = "(max-color:2147477350)";
/// A query that never matches (`false` in a definition).
const NEVER: &str = "(color:2147477350)";

/// Resolves the custom media queries of a style sheet.
pub(crate) fn resolve(nodes: &mut Vec<Node>) {
	let Some(defined) = definitions(nodes, &mut Vec::new(), false) else {
		return;
	};
	*nodes = expand(std::mem::take(nodes), &defined, 0);
}

/// Finds the definitions of `nodes` and returns the names that resolve,
/// without the ones of a loop; `None` when nothing is defined. `removed`
/// receives the offset of every definition, which is removed from `nodes`
/// unless `keep`.
fn definitions(
	nodes: &mut Vec<Node>,
	removed: &mut Vec<usize>,
	keep: bool,
) -> Option<HashMap<String, Vec<String>>> {
	let mut defined: HashMap<String, Vec<String>> = HashMap::new();
	collect(nodes, &mut defined, removed, keep);
	if defined.is_empty() {
		return None;
	}
	let looped: Vec<String> = defined
		.keys()
		.filter(|name| reaches_itself(name, &defined))
		.cloned()
		.collect();
	for name in &looped {
		defined.remove(name);
	}
	Some(defined)
}

/// Whether the definition of `name` refers back to `name`, directly or
/// through other definitions.
fn reaches_itself(name: &str, defined: &HashMap<String, Vec<String>>) -> bool {
	let mut seen: HashSet<&str> = HashSet::new();
	let mut stack = vec![name];
	while let Some(current) = stack.pop() {
		let Some(queries) = defined.get(current) else {
			continue;
		};
		for query in queries {
			for (_, _, next) in references(query) {
				if next == name {
					return true;
				}
				if seen.insert(next) {
					stack.push(next);
				}
			}
		}
	}
	false
}

/// The references `(--name)` of a query in order, with their byte ranges:
/// the groups that hold only a name and stand where a `<media-in-parens>`
/// does, at the top of the query or in a group that holds a condition. A
/// name in a function (`var(--name)`) or in the value of a feature
/// (`(width: (--name))`) is not one, as postcss-custom-media does not take
/// it for one.
fn references(query: &str) -> Vec<(usize, usize, &str)> {
	let mut out = Vec::new();
	collect_references(query, 0, &mut out);
	out
}

fn collect_references<'a>(text: &'a str, offset: usize, out: &mut Vec<(usize, usize, &'a str)>) {
	for part in parts(text) {
		let Part::Group {
			start,
			end,
			function: false,
		} = part
		else {
			continue;
		};
		let inner = &text[start + 1..end - 1];
		if is_name(inner.trim()) {
			out.push((offset + start, offset + end, inner.trim()));
		} else if is_condition_parts(&parts(inner.trim()), true) {
			let lead = inner.len() - inner.trim_start().len();
			collect_references(inner.trim(), offset + start + 1 + lead, out);
		}
	}
}

fn is_name(text: &str) -> bool {
	text.starts_with("--") && !text.contains(|c: char| c.is_whitespace() || c == '(')
}

/// Removes the definitions (unless `keep`) and records them; the last
/// definition of a name in the style sheet wins (Media Queries 5, whatever
/// cascade layer it is in).
///
/// A definition counts at the top level and inside `@layer`, `@scope`,
/// `@container` and style rules, and is left as it is (not defined) inside
/// any other at-rule (`@media`, `@supports`, `@starting-style`). No
/// specification says whether a definition in an at-rule holds only while
/// its condition does, so the line is drawn where postcss-custom-media draws
/// it. An `@layer` block left empty stays, here and in the later steps of the
/// minifier: it still places the layer in the layer order.
fn collect(
	nodes: &mut Vec<Node>,
	defined: &mut HashMap<String, Vec<String>>,
	removed: &mut Vec<usize>,
	keep: bool,
) {
	nodes.retain_mut(|n| match n {
		Node::AtRule(a) if a.name.eq_ignore_ascii_case("custom-media") => {
			let Some((name, queries)) = definition(&a.prelude) else {
				return true;
			};
			defined.insert(name, queries);
			removed.push(a.offset);
			keep
		}
		Node::AtRule(a) => {
			let counted = ["layer", "scope", "container"]
				.iter()
				.any(|name| a.name.eq_ignore_ascii_case(name));
			if counted && let Body::Nodes(inner) = &mut a.body {
				collect(inner, defined, removed, keep);
			}
			true
		}
		Node::Rule(r) => {
			collect(&mut r.nodes, defined, removed, keep);
			true
		}
		_ => true,
	});
}

/// `--name (width < 1px), print` as the name and its queries.
fn definition(prelude: &str) -> Option<(String, Vec<String>)> {
	let prelude = prelude.trim();
	let end = prelude
		.find(|c: char| c.is_whitespace())
		.unwrap_or(prelude.len());
	let name = &prelude[..end];
	// `--` alone is not a `<dashed-ident>` an author may use (CSS Values 4
	// reserves it), though postcss-custom-media defines it.
	if !name.starts_with("--") || name.len() == 2 {
		return None;
	}
	let value = prelude[end..].trim();
	let queries = match value.to_ascii_lowercase().as_str() {
		"true" => vec![ALWAYS.to_owned()],
		"false" => vec![NEVER.to_owned()],
		_ => split_queries(value),
	};
	if queries.is_empty() {
		return None;
	}
	Some((name.to_owned(), queries))
}

/// Splits a media query list at the commas that are not inside parentheses
/// or strings.
fn split_queries(list: &str) -> Vec<String> {
	let mut out = Vec::new();
	let mut depth = 0usize;
	let mut start = 0;
	let mut scan = Scan::default();
	for (i, c) in list.char_indices() {
		if !scan.is_code(c) {
			continue;
		}
		match c {
			'(' => depth += 1,
			')' => depth = depth.saturating_sub(1),
			',' if depth == 0 => {
				out.push(list[start..i].trim().to_owned());
				start = i + 1;
			}
			_ => {}
		}
	}
	out.push(list[start..].trim().to_owned());
	out.retain(|q| !q.is_empty());
	out
}

/// Where a scan of a prelude is: in a string (`"("` is no parenthesis) or
/// after a backslash (`\(` is none either).
#[derive(Default)]
struct Scan {
	quote: Option<char>,
	escaped: bool,
}

impl Scan {
	/// Whether `c`, the next character, is a quote, a parenthesis or a comma
	/// that counts, or any character outside a string; it is not when it is
	/// escaped or in a string.
	fn is_code(&mut self, c: char) -> bool {
		if self.escaped {
			self.escaped = false;
			return false;
		}
		if c == '\\' {
			self.escaped = true;
			return false;
		}
		match self.quote {
			Some(q) => {
				if c == q {
					self.quote = None;
				}
				false
			}
			None => {
				if c == '"' || c == '\'' {
					self.quote = Some(c);
				}
				true
			}
		}
	}
}

/// The nodes with every `@media` that uses a definition resolved, at any
/// depth. `depth` is how many blocks hold them.
fn expand(nodes: Vec<Node>, defined: &HashMap<String, Vec<String>>, depth: usize) -> Vec<Node> {
	let mut out = Vec::with_capacity(nodes.len());
	for node in nodes {
		expand_node(node, defined, depth, &mut out);
	}
	out
}

fn expand_node(
	node: Node,
	defined: &HashMap<String, Vec<String>>,
	depth: usize,
	out: &mut Vec<Node>,
) {
	match node {
		Node::AtRule(mut a) => {
			if a.name.eq_ignore_ascii_case("media") && a.prelude.contains("--") {
				// The steps that write in place go on in a loop (a definition
				// that uses another, a list after the one resolved): each one
				// takes a reference away.
				while let Some(pieces) = resolve_list(&a.prelude, defined) {
					if pieces.iter().all(|p| p.wrappers.is_empty()) {
						let list: Vec<&str> = pieces.iter().map(|p| p.prelude.as_str()).collect();
						a.prelude = list.join(", ");
						continue;
					}
					// A rule nested deeper than the parser takes would overflow
					// the stack of the later steps: it stays as it is.
					let wrapped = pieces.iter().map(|p| p.wrappers.len()).max().unwrap_or(0);
					if depth + 1 + wrapped > crate::parse::MAX_NESTING {
						break;
					}
					// The block is resolved once, before it is copied.
					if let Body::Nodes(inner) = &mut a.body {
						*inner = expand(std::mem::take(inner), defined, depth + 1 + wrapped);
					}
					for n in build(pieces, &a) {
						expand_node(n, defined, depth, out);
					}
					return;
				}
			}
			if let Body::Nodes(inner) = &mut a.body {
				*inner = expand(std::mem::take(inner), defined, depth + 1);
			}
			out.push(Node::AtRule(a));
		}
		Node::Rule(mut r) => {
			r.nodes = expand(std::mem::take(&mut r.nodes), defined, depth + 1);
			out.push(Node::Rule(r));
		}
		other => out.push(other),
	}
}

/// One `@media` that a step of the resolution makes: `prelude`, inside one
/// `@media` for each of `wrappers` (the innermost first).
struct Piece {
	prelude: String,
	wrappers: Vec<String>,
}

impl Piece {
	fn plain(prelude: String) -> Self {
		Self {
			prelude,
			wrappers: Vec::new(),
		}
	}
}

/// Resolves the references of the queries of the list in order, the way
/// postcss-custom-media takes one step at a time on the first query that has
/// one: the references written in place are all resolved in one pass, up to
/// the first that writes the rule twice, whose pieces end the list. `None`
/// when nothing changes.
fn resolve_list(prelude: &str, defined: &HashMap<String, Vec<String>>) -> Option<Vec<Piece>> {
	let mut done: Vec<String> = Vec::new();
	let mut todo: std::collections::VecDeque<String> = split_queries(prelude).into();
	let mut changed = false;
	while let Some(query) = todo.pop_front() {
		match resolve_query(&query, defined) {
			None => done.push(query),
			Some(pieces) if pieces.iter().all(|p| p.wrappers.is_empty()) => {
				// What a step writes may use definitions again: it is looked at
				// next, where it stands.
				changed = true;
				for piece in pieces.iter().rev() {
					for q in split_queries(&piece.prelude).into_iter().rev() {
						todo.push_front(q);
					}
				}
			}
			Some(pieces) => {
				let mut out: Vec<Piece> = done.into_iter().map(Piece::plain).collect();
				out.extend(pieces);
				out.extend(todo.into_iter().map(Piece::plain));
				return Some(out);
			}
		}
	}
	changed.then(|| vec![Piece::plain(done.join(", "))])
}

/// Resolves the first defined reference of one query. A query that is not
/// well formed (`cannot (--a)`) never matches whatever its references stand
/// for, and is left as it is.
fn resolve_query(query: &str, defined: &HashMap<String, Vec<String>>) -> Option<Vec<Piece>> {
	if !is_well_formed(query) {
		return None;
	}
	// The query is only the reference: it becomes the list.
	if let Some(queries) = plain_feature(query)
		.filter(|feature| is_name(feature))
		.and_then(|name| defined.get(name))
	{
		return Some(vec![Piece::plain(queries.join(", "))]);
	}
	let (start, end, queries) = first_reference(query, defined)?;
	let (before, after) = (&query[..start], &query[end..]);
	// A definition that is one plain feature is written in place.
	if let [only] = queries.as_slice()
		&& let Some(feature) = plain_feature(only)
	{
		return Some(vec![Piece::plain(format!("{before}({feature}){after}"))]);
	}
	Some(vec![
		Piece {
			prelude: format!("{before}{ALWAYS}{after}"),
			wrappers: vec![queries.join(", ")],
		},
		Piece {
			prelude: format!("{before}{NEVER}{after}"),
			wrappers: queries.iter().map(|q| negate(q).join(", ")).collect(),
		},
	])
}

/// The byte range of the first `(--name)` of the query whose name is
/// defined, and its definition.
fn first_reference<'a>(
	query: &str,
	defined: &'a HashMap<String, Vec<String>>,
) -> Option<(usize, usize, &'a Vec<String>)> {
	references(query)
		.into_iter()
		.find_map(|(start, end, name)| Some((start, end, defined.get(name)?)))
}

/// The feature of a query that is one feature in parentheses, as
/// `width < 1px` of `(width < 1px)` or `((width < 1px))`: no media type, no
/// `and`, `or` or `not`, no function.
fn plain_feature(query: &str) -> Option<&str> {
	let mut text = query.trim();
	let mut stripped = false;
	loop {
		match parts(text).as_slice() {
			[
				Part::Group {
					start: 0,
					end,
					function: false,
				},
			] if *end == text.len() => {
				text = text[1..text.len() - 1].trim();
				stripped = true;
			}
			_ => break,
		}
	}
	let inner = parts(text);
	// A function may be in the value (`width > calc(1px + 1px)`).
	let feature = inner.iter().all(|part| match part {
		Part::Word { text, .. } => !["and", "or", "not"].iter().any(|k| is_keyword(text, k)),
		Part::Group { function, .. } => *function,
	});
	(stripped && feature && !text.is_empty()).then_some(text)
}

fn is_keyword(word: &str, keyword: &str) -> bool {
	word.eq_ignore_ascii_case(keyword)
}

/// The queries that match where `query` does not (De Morgan's laws over a
/// media type and a condition), written the way postcss-custom-media writes
/// them: `not all and (a)`, `not print`, `(a)` for `not (a)`.
fn negate(query: &str) -> Vec<String> {
	let query = query.trim();
	// A query that is not well formed never matches, so its negation always
	// does. (postcss-custom-media writes the query again as it is, which
	// never matches either, so that `not (--name)` never applies.)
	if !is_well_formed(query) {
		return vec!["all".to_owned()];
	}
	let parts = parts(query);
	let word_is = |i: usize, keyword| matches!(parts.get(i), Some(Part::Word { text, .. }) if is_keyword(text, keyword));
	if is_condition_parts(&parts, true) {
		if word_is(0, "not") {
			// `not` is ASCII and the first part, so 3 is a character boundary.
			return vec![query[3..].trim().to_owned()];
		}
		if parts.len() > 1 {
			return vec![format!("not all and ({query})")];
		}
		return vec![format!("not all and {query}")];
	}
	// `[not | only] <media-type> [and <condition>]`.
	let negated = word_is(0, "not");
	let typed = if negated || word_is(0, "only") {
		&parts[1..]
	} else {
		&parts[..]
	};
	let media_type = match typed.first() {
		Some(Part::Word { text, .. }) => *text,
		_ => "",
	};
	let condition = match typed.get(1) {
		Some(Part::Word { at, .. }) => Some(query[at + 3..].trim()),
		_ => None,
	};
	match (negated, condition) {
		(true, Some(condition)) => vec![format!("{media_type} and {condition}")],
		(true, None) => vec![media_type.to_owned()],
		(false, Some(condition)) => {
			let mut out = vec![format!("not {media_type}")];
			out.extend(negate(condition));
			out
		}
		(false, None) => vec![format!("not {media_type}")],
	}
}

/// Whether the parts of a query outside parentheses fit a `<media-query>`
/// (Media Queries 4 §3): a `<media-condition>` (`(a)`, `not (a)`,
/// `(a) and (b) and (c)`, `(a) or (b)`, not `and` and `or` mixed) or
/// `[not | only] <media-type> [and <media-condition-without-or>]`. What is in
/// the parentheses is not looked at. A function (`foo(x)`, a
/// `<general-enclosed>` that never matches) makes the query one that
/// postcss-custom-media does not resolve, and so it is not taken as well
/// formed here either: what it would resolve to never matches anyway.
fn is_well_formed(query: &str) -> bool {
	let parts = parts(query.trim());
	if is_condition_parts(&parts, true) {
		return true;
	}
	let typed = match parts.first() {
		Some(Part::Word { text, .. }) if is_keyword(text, "not") || is_keyword(text, "only") => {
			&parts[1..]
		}
		_ => &parts[..],
	};
	match typed {
		[
			Part::Word {
				text: media_type, ..
			},
		] => !is_reserved(media_type),
		[
			Part::Word {
				text: media_type, ..
			},
			Part::Word { text: and, .. },
			condition @ ..,
		] => {
			!is_reserved(media_type)
				&& is_keyword(and, "and")
				&& is_condition_parts(condition, false)
		}
		_ => false,
	}
}

/// A `<media-condition>` (with `or` when `or_allowed`) of groups that are not
/// functions.
fn is_condition_parts(parts: &[Part<'_>], or_allowed: bool) -> bool {
	let group = |part: &Part<'_>| {
		matches!(
			part,
			Part::Group {
				function: false,
				..
			}
		)
	};
	match parts {
		[Part::Word { text, .. }, last] => is_keyword(text, "not") && group(last),
		[first, rest @ ..] if group(first) => {
			let Some(Part::Word { text: joiner, .. }) = rest.first() else {
				return rest.is_empty();
			};
			(is_keyword(joiner, "and") || (or_allowed && is_keyword(joiner, "or")))
				&& rest.chunks(2).all(|pair| match pair {
					[Part::Word { text, .. }, last] => {
						text.eq_ignore_ascii_case(joiner) && group(last)
					}
					_ => false,
				})
		}
		_ => false,
	}
}

/// The words a media type cannot be. (`layer` is one too in Media Queries 5,
/// but postcss-custom-media takes it for a media type, and a query with it
/// never matches either way.)
fn is_reserved(word: &str) -> bool {
	["and", "or", "not", "only"]
		.iter()
		.any(|k| is_keyword(word, k))
}

/// A part of a query outside parentheses, with its byte offsets.
enum Part<'a> {
	Word {
		at: usize,
		text: &'a str,
	},
	/// `( ... )` from `start` to `end` (past the `)`), or a function such as
	/// `foo( ... )` (a name glued to `(`, as the CSS tokenizer reads it).
	Group {
		start: usize,
		end: usize,
		function: bool,
	},
}

/// The parts of a query outside parentheses: `screen`, `and`, a group.
fn parts(query: &str) -> Vec<Part<'_>> {
	let mut out = Vec::new();
	let mut depth = 0usize;
	let mut word = None;
	let mut open = (0, false);
	let mut scan = Scan::default();
	for (i, c) in query.char_indices() {
		if !scan.is_code(c) || c == '"' || c == '\'' {
			// An escaped character or a string is a part of the word it is in.
			if depth == 0 && !c.is_whitespace() {
				word.get_or_insert(i);
			}
			continue;
		}
		match c {
			'(' => {
				if depth == 0 {
					let function = word.take();
					open = (function.unwrap_or(i), function.is_some());
				}
				depth += 1;
			}
			')' if depth > 0 => {
				depth -= 1;
				if depth == 0 {
					out.push(Part::Group {
						start: open.0,
						end: i + 1,
						function: open.1,
					});
				}
			}
			_ if depth > 0 => {}
			_ if c.is_whitespace() || c == ')' => {
				if let Some(s) = word.take() {
					out.push(Part::Word {
						at: s,
						text: &query[s..i],
					});
				}
				// A `)` that closes nothing is a part of its own, which no
				// grammar here accepts.
				if c == ')' {
					out.push(Part::Word { at: i, text: ")" });
				}
			}
			_ => {
				word.get_or_insert(i);
			}
		}
	}
	if depth > 0 {
		// A group left open runs to the end.
		out.push(Part::Group {
			start: open.0,
			end: query.len(),
			function: true,
		});
	} else if let Some(s) = word {
		out.push(Part::Word {
			at: s,
			text: &query[s..],
		});
	}
	out
}

/// The `@media` rules of the pieces, each with a copy of the block of `rule`.
/// When nothing is wrapped the pieces stay one list.
fn build(pieces: Vec<Piece>, rule: &AtRule) -> Vec<Node> {
	let with = |prelude: String, body: Body| {
		Node::AtRule(AtRule {
			name: rule.name.clone(),
			prelude,
			space: rule.space,
			body,
			offset: rule.offset,
			block: rule.block,
			end: rule.end,
		})
	};
	if pieces.iter().all(|p| p.wrappers.is_empty()) {
		let list: Vec<String> = pieces.into_iter().map(|p| p.prelude).collect();
		return vec![with(list.join(", "), rule.body.clone())];
	}
	pieces
		.into_iter()
		.map(|p| {
			let mut node = with(p.prelude, rule.body.clone());
			for wrapper in p.wrappers {
				node = with(wrapper, Body::Nodes(vec![node]));
			}
			node
		})
		.collect()
}

// ---------------------------------------------------------------------------
// Resolving without reprinting

/// Resolves the custom media queries of a style sheet in its text: what the
/// tree of the parser drops (white space, comments) stays as written. A
/// definition goes (with its line, when only definitions are on it), a
/// reference written in place replaces the prelude of its `@media`, and an
/// `@media` whose rule is written more than once becomes its copies, each
/// opening its wrapping `@media` rules where the rule began and closing them
/// where it ended: one per line when the rule begins its line, side by side
/// when it is in the middle of one. `marks`, when given, receives where every line
/// that is copied and every part that is written came from.
pub(crate) fn resolve_text(source: &str, marks: Option<&mut Vec<Mark>>) -> String {
	let mut text = Text {
		source,
		defined: HashMap::new(),
		removed: HashSet::new(),
		out: String::with_capacity(source.len()),
		marks,
		cursor: 0,
		line_cut: None,
	};
	// A style sheet that defines nothing is copied without building its tree:
	// a build that does not minify should not pay for parsing it.
	let needle = b"@custom-media";
	let bytes = source.as_bytes();
	let mut nodes = if source.match_indices('@').any(|(i, _)| {
		bytes
			.get(i..i + needle.len())
			.is_some_and(|w| w.eq_ignore_ascii_case(needle))
	}) {
		// A block nested too deep is not in the tree: its text is copied.
		parse_stylesheet(source).nodes
	} else {
		Vec::new()
	};
	let mut removed = Vec::new();
	if let Some(defined) = definitions(&mut nodes, &mut removed, true) {
		text.defined = defined;
		text.removed = removed.into_iter().collect();
		text.walk(&nodes, 0);
	}
	text.copy(source.len());
	text.out
}

struct Text<'s, 'm> {
	source: &'s str,
	defined: HashMap<String, Vec<String>>,
	/// The offsets of the definitions that go.
	removed: HashSet<usize>,
	out: String,
	marks: Option<&'m mut Vec<Mark>>,
	/// How far the source has been written.
	cursor: usize,
	/// While the definitions removed last are all that has been on their
	/// line: where the line starts in the source, and the lengths of `out`
	/// and of the marks at that point.
	line_cut: Option<(usize, usize, usize)>,
}

impl Text<'_, '_> {
	/// Copies the source from the cursor to `to`.
	fn copy(&mut self, to: usize) {
		let from = self.cursor;
		if from >= to {
			return;
		}
		if let Some(marks) = self.marks.as_deref_mut() {
			let base = self.out.len();
			marks.push(Mark {
				out: base,
				src: from,
			});
			// Every line starts with a mark, whatever its line break (`\r\n`
			// is one, as it is to [`line_start`]).
			let bytes = &self.source.as_bytes()[from..to];
			for (i, &b) in bytes.iter().enumerate() {
				let ends_line = match b {
					b'\n' | b'\x0c' => true,
					b'\r' => bytes.get(i + 1) != Some(&b'\n'),
					_ => false,
				};
				if ends_line && from + i + 1 < to {
					marks.push(Mark {
						out: base + i + 1,
						src: from + i + 1,
					});
				}
			}
		}
		self.out.push_str(&self.source[from..to]);
		self.cursor = to;
	}

	/// Writes `text`, which stands for the source at `src`.
	fn write(&mut self, text: &str, src: usize) {
		if text.is_empty() {
			return;
		}
		if let Some(marks) = self.marks.as_deref_mut() {
			marks.push(Mark {
				out: self.out.len(),
				src,
			});
		}
		self.out.push_str(text);
	}

	fn walk(&mut self, nodes: &[Node], depth: usize) {
		for node in nodes {
			match node {
				Node::AtRule(a) if self.removed.contains(&a.offset) => self.remove(a),
				Node::AtRule(a) => {
					self.line_cut = None;
					if a.name.eq_ignore_ascii_case("media") && a.prelude.contains("--") {
						let nodes = resolved(a, &self.defined, depth);
						match nodes.as_slice() {
							[Node::AtRule(r)] if wraps_the_block(r) => {
								if r.prelude != a.prelude {
									let (from, to) = prelude_span(self.source, a);
									self.copy(from);
									self.write(&r.prelude, from);
									self.cursor = to;
								}
							}
							_ => {
								self.copies(a, &nodes, depth);
								continue;
							}
						}
					}
					if let Body::Nodes(inner) = &a.body {
						self.walk(inner, depth + 1);
					}
				}
				Node::Rule(r) => {
					self.line_cut = None;
					self.walk(&r.nodes, depth + 1);
				}
				_ => self.line_cut = None,
			}
		}
	}

	/// Removes the definition `a`: with its line when nothing but white space
	/// and other definitions is on it, otherwise with the white space after it
	/// (and before it, when it ends its line).
	fn remove(&mut self, a: &AtRule) {
		let bytes = self.source.as_bytes();
		let line = line_start(self.source, a.offset);
		let after = bytes[a.end..]
			.iter()
			.position(|&b| !is_blank(b))
			.map_or(bytes.len(), |i| a.end + i);
		let newline = match &bytes[after..] {
			[b'\r', b'\n', ..] => Some(2),
			[b'\n' | b'\r' | b'\x0c', ..] => Some(1),
			[] => Some(0),
			_ => None,
		};
		let continued = self
			.line_cut
			.filter(|&(at, ..)| at == line && self.cursor == a.offset);
		let first = bytes[line..a.offset].iter().all(|&b| is_blank(b));
		if !first && continued.is_none() {
			let from = match newline {
				Some(_) => {
					a.offset
						- bytes[..a.offset]
							.iter()
							.rev()
							.take_while(|&&b| is_blank(b))
							.count()
				}
				None => a.offset,
			};
			self.copy(from.max(self.cursor));
			self.cursor = after;
			self.line_cut = None;
			return;
		}
		let cut = continued.unwrap_or_else(|| {
			self.copy(line);
			let marks = self.marks.as_deref().map_or(0, Vec::len);
			(line, self.out.len(), marks)
		});
		match newline {
			Some(n) => {
				self.out.truncate(cut.1);
				if let Some(marks) = self.marks.as_deref_mut() {
					marks.truncate(cut.2);
				}
				self.cursor = after + n;
				self.line_cut = None;
			}
			None => {
				self.copy(a.offset);
				self.cursor = after;
				self.line_cut = Some(cut);
			}
		}
	}

	/// Writes `a` as the `@media` rules [`resolved`] made of it, its block
	/// copied (with what is in it resolved) wherever they hold it.
	fn copies(&mut self, a: &AtRule, nodes: &[Node], depth: usize) {
		self.copy(a.offset);
		// A rule that begins its line has its copies on lines of their own,
		// indented as it is; one in the middle of a line, on the same line.
		let line = line_start(self.source, a.offset);
		let before = &self.source[line..a.offset];
		let between = if before.bytes().all(is_blank) {
			format!("{}{before}", line_break(self.source, line))
		} else {
			" ".to_owned()
		};
		let closers = crate::parse::closers_of_text(&self.source[a.block..a.end]);
		let mut pending = Pending::default();
		for (i, node) in nodes.iter().enumerate() {
			if i > 0 {
				self.put(&mut pending, &between, a.offset);
			}
			self.copy_in(a, node, depth, &closers, &mut pending);
		}
		self.flush(&mut pending);
		self.cursor = a.end;
	}

	/// Writes `node`, an `@media` that [`resolved`] made of `a` (at `depth`),
	/// with the block of `a` where the stand-in for it is.
	fn copy_in(
		&mut self,
		a: &AtRule,
		node: &Node,
		depth: usize,
		closers: &str,
		pending: &mut Pending,
	) {
		let Node::AtRule(r) = node else {
			return;
		};
		let Body::Nodes(inner) = &r.body else {
			return;
		};
		self.put(pending, &format!("@{} {}", a.name, r.prelude), a.offset);
		if wraps_the_block(r) {
			if self.source[a.block..a.end].starts_with('{') {
				self.put(pending, " ", a.offset);
			}
			self.flush(pending);
			self.cursor = a.block;
			if let Body::Nodes(block) = &a.body {
				self.walk(block, depth + 1);
			}
			self.copy(a.end);
			self.put(pending, closers, a.end);
			return;
		}
		self.put(pending, " { ", a.offset);
		for (i, child) in inner.iter().enumerate() {
			if i > 0 {
				self.put(pending, " ", a.offset);
			}
			self.copy_in(a, child, depth + 1, closers, pending);
		}
		self.put(pending, " }", a.end);
	}

	/// Adds `text`, which stands for the source at `src`, to what is written
	/// next: runs that stand for the same place are one mark.
	fn put(&mut self, pending: &mut Pending, text: &str, src: usize) {
		if !pending.text.is_empty() && pending.src != src {
			self.flush(pending);
		}
		if pending.text.is_empty() {
			pending.src = src;
		}
		pending.text.push_str(text);
	}

	fn flush(&mut self, pending: &mut Pending) {
		self.write(&pending.text, pending.src);
		pending.text.clear();
	}
}

/// Text to write and the place in the source it stands for.
#[derive(Default)]
struct Pending {
	text: String,
	src: usize,
}

/// The line break the source uses: the one that ends the line before
/// `line`, or the first one, or `\n` when it has none.
fn line_break(source: &str, line: usize) -> &str {
	let bytes = source.as_bytes();
	let at = if line > 0 {
		line - 1
	} else {
		match bytes
			.iter()
			.position(|&b| matches!(b, b'\n' | b'\r' | b'\x0c'))
		{
			Some(i) => i,
			None => return "\n",
		}
	};
	match (bytes[at], bytes.get(at + 1)) {
		(b'\r', Some(b'\n')) => &source[at..at + 2],
		(b'\n', _) if at > 0 && bytes[at - 1] == b'\r' => &source[at - 1..at + 1],
		_ => &source[at..at + 1],
	}
}

/// Where the line of `offset` begins: past the last newline (CSS Syntax 3
/// §3.3 reads `\r`, `\r\n` and `\x0c` as one too) before it.
fn line_start(source: &str, offset: usize) -> usize {
	source.as_bytes()[..offset]
		.iter()
		.rposition(|&b| matches!(b, b'\n' | b'\r' | b'\x0c'))
		.map_or(0, |i| i + 1)
}

fn is_blank(b: u8) -> bool {
	b == b' ' || b == b'\t'
}

/// The span of the prelude of `a` in the source, without the white space
/// around it.
fn prelude_span(source: &str, a: &AtRule) -> (usize, usize) {
	let from = a.offset + 1 + a.name.len();
	let text = &source[from..a.block];
	let start = from + (text.len() - text.trim_start().len());
	(start, from + text.trim_end().len())
}

/// The `@media` rules `a` becomes once it is resolved, with an empty comment
/// standing in for its block: what [`expand_node`] makes of it, so that the
/// copies nest as the minifier nests them.
fn resolved(a: &AtRule, defined: &HashMap<String, Vec<String>>, depth: usize) -> Vec<Node> {
	let probe = AtRule {
		name: a.name.clone(),
		prelude: a.prelude.clone(),
		space: a.space,
		body: Body::Nodes(vec![Node::Comment(Comment {
			text: String::new(),
			offset: a.offset,
		})]),
		offset: a.offset,
		block: a.block,
		end: a.end,
	};
	let mut nodes = Vec::new();
	expand_node(Node::AtRule(probe), defined, depth, &mut nodes);
	nodes
}

/// Whether `r`, one of the rules [`resolved`] makes, holds the block itself.
fn wraps_the_block(r: &AtRule) -> bool {
	matches!(&r.body, Body::Nodes(inner) if matches!(inner.as_slice(), [Node::Comment(_)]))
}

#[cfg(test)]
mod tests {
	use crate::{minify, resolve_custom_media, resolve_custom_media_with_marks};

	#[test]
	fn a_name_is_replaced_by_its_query_and_the_definition_goes() {
		let css = "@custom-media --md-lte (width < 992px);\n@media (--md-lte) { a { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media (width < 992px){a{top:0}}");
	}

	#[test]
	fn a_reference_next_to_other_conditions_and_inside_a_rule_is_replaced() {
		let css = "@custom-media --sm (576px <= width);\na { @media screen and (--sm) and (hover) { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"a{@media screen and (576px <= width) and (hover){top:0}}"
		);
	}

	#[test]
	fn a_query_that_is_only_the_reference_becomes_the_list() {
		let css = "@custom-media --l (width < 1px), print;\n@custom-media --c (width >= 1px) and (hover);\n@media (--l) { a { top: 0 } }\n@media ( --c ) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width < 1px),print{a{top:0}}@media (width >= 1px) and (hover){b{top:0}}"
		);
	}

	#[test]
	fn the_negation_of_one_feature_is_replaced() {
		let css = "@custom-media --a (width < 1px);\n@media not (--a) { b { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media not (width < 1px){b{top:0}}");
	}

	#[test]
	fn a_negation_in_parentheses_is_replaced_in_a_query_and_in_a_definition() {
		let css = "@custom-media --narrow (width < 100px);\n@custom-media --wide (not (--narrow));\n@media (--wide) { a { top: 0 } }\n@media (not (--narrow)) { b { left: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (not (width < 100px)){a{top:0}b{left:0}}"
		);
	}

	#[test]
	fn a_feature_in_parentheses_is_replaced_in_place() {
		let css = "@custom-media --a ((width < 1px));\n@media ((--a) and (hover)) { a { top: 0 } }\n@media (not ( --a )) { b { left: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media ((width < 1px) and (hover)){a{top:0}}@media (not (width < 1px)){b{left:0}}"
		);
	}

	#[test]
	fn a_list_next_to_a_condition_writes_the_rule_for_when_it_matches_and_when_not() {
		let css = "@custom-media --wide (width >= 1px), print;\n@media (--wide) and (hover) { a { top: 0 } b { left: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width >= 1px),print{@media (max-color:2147477350) and (hover){a{top:0}b{left:0}}}@media not print{@media not all and (width >= 1px){@media (color:2147477350) and (hover){a{top:0}b{left:0}}}}"
		);
	}

	#[test]
	fn a_negated_list_in_parentheses_and_next_to_or_is_resolved() {
		let css = "@custom-media --l (width < 1px), print;\n@media (not (--l)) { a { top: 0 } }\n@media (--l) or (color) { b { left: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width < 1px),print{@media (not (max-color:2147477350)){a{top:0}}}@media not print{@media not all and (width < 1px){@media (not (color:2147477350)){a{top:0}}}}@media (width < 1px),print{@media (max-color:2147477350) or (color){b{left:0}}}@media not print{@media not all and (width < 1px){@media (color:2147477350) or (color){b{left:0}}}}"
		);
	}

	#[test]
	fn a_condition_after_not_is_negated_in_parentheses() {
		let css =
			"@custom-media --a (width >= 1px) and (hover);\n@media NOT (--a) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width >= 1px) and (hover){@media NOT (max-color:2147477350){a{top:0}}}@media not all and ((width >= 1px) and (hover)){@media NOT (color:2147477350){a{top:0}}}"
		);
	}

	#[test]
	fn a_media_type_is_negated_by_de_morgan() {
		let css = "@custom-media --s screen;\n@custom-media --o only screen and (hover);\n@custom-media --n not screen and (hover);\n@media not (--s) { a { top: 0 } }\n@media (--o) and (color) { b { top: 0 } }\n@media (--n) and (color) { c { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media screen{@media not (max-color:2147477350){a{top:0}}}@media not screen{@media not (color:2147477350){a{top:0}}}@media only screen and (hover){@media (max-color:2147477350) and (color){b{top:0}}}@media not all and (hover),not screen{@media (color:2147477350) and (color){b{top:0}}}@media not screen and (hover){@media (max-color:2147477350) and (color){c{top:0}}}@media screen and (hover){@media (color:2147477350) and (color){c{top:0}}}"
		);
	}

	#[test]
	fn a_negated_condition_is_negated_by_dropping_not() {
		let css = "@custom-media --n not (hover);\n@media (--n) and (color) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media not (hover){@media (max-color:2147477350) and (color){a{top:0}}}@media (hover){@media (color:2147477350) and (color){a{top:0}}}"
		);
	}

	#[test]
	fn a_function_in_a_query_does_not_hide_a_reference() {
		let css = "@custom-media --l (width < 1px), print;\n@media (width > calc(1px + 1px)) and (--l) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width < 1px),print{@media (width > calc(1px + 1px)) and (max-color:2147477350){a{top:0}}}@media not print{@media not all and (width < 1px){@media (width > calc(1px + 1px)) and (color:2147477350){a{top:0}}}}"
		);
	}

	#[test]
	fn every_query_of_a_list_and_every_reference_of_a_query_is_resolved() {
		let css = "@custom-media --l (width < 1px), print;\n@custom-media --a (hover);\n@media (--l), (--a) and (--l) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width < 1px){a{top:0}}@media print{a{top:0}}@media (width < 1px),print{@media (hover) and (max-color:2147477350){a{top:0}}}@media not print{@media not all and (width < 1px){@media (hover) and (color:2147477350){a{top:0}}}}"
		);
	}

	#[test]
	fn a_reference_inside_another_block_is_resolved_there() {
		let css = "@custom-media --l (width < 1px), print;\n@supports (display: grid) { @media not (--l) { a { top: 0 } } }";
		assert_eq!(
			minify(css).unwrap(),
			"@supports (display:grid){@media (width < 1px),print{@media not (max-color:2147477350){a{top:0}}}@media not print{@media not all and (width < 1px){@media not (color:2147477350){a{top:0}}}}}"
		);
	}

	#[test]
	fn a_definition_that_uses_a_list_is_resolved_through_it() {
		let css = "@custom-media --x (--y) and (hover);\n@custom-media --y screen;\n@media (--x) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media screen{@media (max-color:2147477350) and (hover){a{top:0}}}@media not screen{@media (color:2147477350) and (hover){a{top:0}}}"
		);
	}

	#[test]
	fn an_undefined_name_stays() {
		let css = "@custom-media --a (width < 1px);\n@media (--b), print { a { top: 0 } }\n@media (--a) and (--b) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (--b ),print{a{top:0}}@media (width < 1px) and (--b ){b{top:0}}"
		);
	}

	#[test]
	fn a_query_that_is_not_well_formed_stays() {
		let css = "@custom-media --l (x:1), print;\n@media cannot (--l) { a { top: 0 } }\n@media (--l) foo { b { top: 0 } }\n@media screen (--l) { c { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media cannot (--l ){a{top:0}}@media (--l ) foo{b{top:0}}@media screen (--l ){c{top:0}}"
		);
	}

	#[test]
	fn a_definition_in_a_conditional_rule_is_not_defined_and_stays() {
		let css = "@media screen { @custom-media --a (width < 1px); }\n@supports (display: grid) { @custom-media --b (hover); }\n@media (--a) and (--b) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media screen{@custom-media --a (width < 1px)}@supports (display:grid){@custom-media --b (hover)}@media (--a ) and (--b ){a{top:0}}"
		);
	}

	#[test]
	fn a_definition_in_a_layer_counts_and_the_last_one_wins_whatever_the_layer() {
		let css = "@layer x, y;\n@layer y { @custom-media --a (width < 1px); }\n@layer x { @custom-media --a (width > 2px); }\na { @custom-media --b (hover); }\n@media (--a) and (--b) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@layer x, y;@layer y{}@layer x{}@media (width > 2px) and (hover){a{top:0}}"
		);
	}

	#[test]
	fn a_definition_without_a_name_stays() {
		let css = "@custom-media foo (width < 1px);\n@media (--foo) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@custom-media foo (width < 1px);@media (--foo ){a{top:0}}"
		);
	}

	#[test]
	fn the_negation_of_a_definition_with_a_function_matches_everything() {
		let css = "@custom-media --a foo(x);\n@custom-media --b not(hover);\n@media not (--a) { a { top: 0 } }\n@media not (--b) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media foo(x){@media not (max-color:2147477350){a{top:0}}}@media{@media not (color:2147477350){a{top:0}}}@media not(hover){@media not (max-color:2147477350){b{top:0}}}@media{@media not (color:2147477350){b{top:0}}}"
		);
	}

	#[test]
	fn a_name_in_the_value_of_a_feature_or_in_a_function_is_not_a_reference() {
		let css = "@custom-media --l (x:1), print;\n@media (foo (--l)) { a { top: 0 } }\n@media (foo: (--l)) { b { top: 0 } }\n@media ((--l) foo) { c { top: 0 } }\n@media (width > calc((--l))) { d { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (foo (--l )){a{top:0}}@media (foo:(--l )){b{top:0}}@media ((--l ) foo){c{top:0}}@media (width > calc((--l ))){d{top:0}}"
		);
	}

	#[test]
	fn a_query_with_a_function_or_a_glued_keyword_stays() {
		let css = "@custom-media --a (x:1);\n@media (c) and foo(y) and (--a) { a { top: 0 } }\n@media not(--a) { b { top: 0 } }\n@media screen and(--a) { c { top: 0 } }\n@media not (--a) and (b) { d { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (c) and foo(y) and (--a ){a{top:0}}@media not(--a ){b{top:0}}@media screen and(--a ){c{top:0}}@media not (--a ) and (b){d{top:0}}"
		);
	}

	#[test]
	fn layer_is_taken_for_a_media_type() {
		let css = "@custom-media --l (x:1), print;\n@media layer and (--l) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (x:1),print{@media layer and (max-color:2147477350){a{top:0}}}@media not print{@media not all and (x:1){@media layer and (color:2147477350){a{top:0}}}}"
		);
	}

	#[test]
	fn a_definition_named_only_dashes_or_without_queries_stays() {
		let css = "@custom-media -- (x:1);\n@custom-media --a;\n@media (--) { a { top: 0 } }\n@media (--a) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@custom-media -- (x:1);@custom-media --a;@media (-- ){a{top:0}}@media (--a ){b{top:0}}"
		);
	}

	#[test]
	fn a_definition_in_a_container_or_a_scope_counts() {
		let css = "@container x { @custom-media --a (x:1); }\n@scope (.a) { @custom-media --b (y:1); }\n@media (--a) and (--b) { a { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media (x:1) and (y:1){a{top:0}}");
	}

	#[test]
	fn true_is_a_keyword_in_any_case() {
		let css = "@custom-media --t TRUE;\n@media not (--t) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media not (max-color:2147477350){b{top:0}}"
		);
	}

	#[test]
	fn a_parenthesis_in_a_string_is_not_a_group() {
		let css = "@custom-media --a (x:1);\n@media (--a) and (y: \"(\") { a { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media (x:1) and (y:\"(\"){a{top:0}}");
	}

	#[test]
	fn the_negation_of_a_definition_that_is_not_well_formed_matches_everything() {
		let css = "@custom-media --x (aé) not;\n@media not (--x) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (aé) not{@media not (max-color:2147477350){a{top:0}}}@media{@media not (color:2147477350){a{top:0}}}"
		);
	}

	#[test]
	fn an_escaped_parenthesis_and_a_comma_in_a_string_are_not_syntax() {
		let css = "@custom-media --a (x:1);\n@custom-media --l (y:\",\"), print;\n@media (--a) and (x: a\\(b) { a { top: 0 } }\n@media (y: \"(\"), (--a) { b { top: 0 } }\n@media (--l) { c { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (x:1) and (x:a\\(b){a{top:0}}@media (x:1),(y:\"(\"){b{top:0}}@media (y:\",\"),print{c{top:0}}"
		);
	}

	#[test]
	fn a_rule_that_would_be_nested_too_deep_stays() {
		let list: Vec<String> = (0..300).map(|i| format!("(a:{i})")).collect();
		let css = format!(
			"@custom-media --l {};\n@media not (--l) {{ a {{ top: 0 }} }}",
			list.join(", ")
		);
		assert_eq!(minify(&css).unwrap(), "@media not (--l ){a{top:0}}");
	}

	#[test]
	fn many_references_of_one_prelude_are_resolved_without_deep_recursion() {
		let refs = vec!["(--a)"; 5000].join(", ");
		let css = format!("@custom-media --a (x:1);\n@media {refs} {{ a {{ top: 0 }} }}");
		// The minifier keeps one of the queries that are the same.
		assert_eq!(minify(&css).unwrap(), "@media (x:1){a{top:0}}");
	}

	#[test]
	fn the_argument_of_a_function_is_not_a_reference() {
		let css = "@custom-media --md (width < 992px);\n@custom-media --x (min-width: var(--x));\n@media (min-width: var(--md)) { a { top: 0 } }\n@media (--x) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (min-width:var(--md )){a{top:0}}@media (min-width:var(--x )){b{top:0}}"
		);
	}

	#[test]
	fn and_and_or_mixed_is_not_well_formed() {
		let css = "@custom-media --l (x:1), print;\n@media (a) and (b) or (--l) { a { top: 0 } }\n@media (a) only (--l) { b { top: 0 } }\n@media screen and (a) or (--l) { c { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (a) and (b) or (--l ){a{top:0}}@media (a) only (--l ){b{top:0}}@media screen and (a) or (--l ){c{top:0}}"
		);
	}

	#[test]
	fn a_definition_in_another_at_rule_is_not_defined() {
		let css =
			"@starting-style { @custom-media --a (width < 1px); }\n@media (--a) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@starting-style{@custom-media --a (width < 1px)}@media (--a ){a{top:0}}"
		);
	}

	#[test]
	fn a_definition_may_use_another_one_in_any_order() {
		let css = "@custom-media --b (--a) and (hover);\n@custom-media --a (width < 1px);\n@media (--b) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width < 1px) and (hover){a{top:0}}"
		);
	}

	#[test]
	fn a_long_chain_of_definitions_is_resolved() {
		let mut css = "@custom-media --n0 (x:1);\n".to_owned();
		for i in 1..=12 {
			css.push_str(&format!("@custom-media --n{i} (--n{});\n", i - 1));
		}
		css.push_str("@media (--n12) { a { top: 0 } }");
		assert_eq!(minify(&css).unwrap(), "@media (x:1){a{top:0}}");
	}

	#[test]
	fn a_cycle_does_not_loop() {
		let css =
			"@custom-media --a (--b);\n@custom-media --b (--a);\n@media (--a) { a { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media (--a ){a{top:0}}");
	}

	#[test]
	fn every_definition_of_a_loop_is_undefined() {
		let css = "@custom-media --a (not (--a));\n@custom-media --b (--c) and (hover);\n@custom-media --c (not (--b));\n@custom-media --d (--a);\n@media (--a) { a { top: 0 } }\n@media (--b) { b { top: 0 } }\n@media (--d) { c { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (--a ){a{top:0}}@media (--b ){b{top:0}}@media (--a ){c{top:0}}"
		);
	}

	#[test]
	fn true_and_false_are_queries_that_always_and_never_match() {
		let css = "@custom-media --t true;\n@custom-media --f false;\n@media (--t) { a { top: 0 } }\n@media (--f) and (hover) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (max-color:2147477350){a{top:0}}@media (color:2147477350) and (hover){b{top:0}}"
		);
	}

	#[test]
	fn without_minifying_a_reference_is_replaced_and_the_definition_goes() {
		let css = "@custom-media --narrow (width < 100px);\n@media (--narrow) { a { top: 0 } }";
		assert_eq!(
			resolve_custom_media(css),
			"@media (width < 100px) { a { top: 0 } }"
		);
	}

	#[test]
	fn without_minifying_everything_else_stays_as_written() {
		let css = "/* note */\n@custom-media --narrow (width < 100px);\n\n@media  (--narrow)  {\n  a  { top : 0 } /* x */\n}\n";
		assert_eq!(
			resolve_custom_media(css),
			"/* note */\n\n@media  (width < 100px)  {\n  a  { top : 0 } /* x */\n}\n"
		);
	}

	#[test]
	fn without_minifying_a_definition_that_shares_its_line_goes_with_the_space_after_it() {
		let css = "@layer x { @custom-media --a (x:1); }\na { @custom-media --b (y:1);  top: 0 }\n@media (--a) and (--b) { b { top: 0 } }";
		assert_eq!(
			resolve_custom_media(css),
			"@layer x { }\na { top: 0 }\n@media (x:1) and (y:1) { b { top: 0 } }"
		);
	}

	#[test]
	fn without_minifying_the_wrapping_media_rules_open_on_the_first_line_and_close_on_the_last() {
		let css = "@custom-media --l (width < 1px), print;\n  @media not (--l) {\n    b { top: 0 }\n  }\n";
		assert_eq!(
			resolve_custom_media(css),
			"  @media (width < 1px), print { @media not (max-color:2147477350) {\n    b { top: 0 }\n  } }\n  @media not print { @media not all and (width < 1px) { @media not (color:2147477350) {\n    b { top: 0 }\n  } } }\n"
		);
	}

	#[test]
	fn without_minifying_a_reference_in_a_copied_block_is_resolved_in_every_copy() {
		let css = "@custom-media --l (width < 1px), print;\n@custom-media --a (hover);\n@media not (--l) {\n  @media (--a) { b { top: 0 } }\n}";
		assert_eq!(
			resolve_custom_media(css),
			"@media (width < 1px), print { @media not (max-color:2147477350) {\n  @media (hover) { b { top: 0 } }\n} }\n@media not print { @media not all and (width < 1px) { @media not (color:2147477350) {\n  @media (hover) { b { top: 0 } }\n} } }"
		);
	}

	#[test]
	fn without_minifying_a_block_left_open_at_the_end_is_closed_before_its_wrappers() {
		let css = "@custom-media --l (width < 1px), print;\n@media not (--l) { b { content: \"x";
		assert_eq!(
			resolve_custom_media(css),
			"@media (width < 1px), print { @media not (max-color:2147477350) { b { content: \"x\"}} }\n@media not print { @media not all and (width < 1px) { @media not (color:2147477350) { b { content: \"x\"}} } }"
		);
	}

	#[test]
	fn without_minifying_a_url_or_a_backslash_left_open_at_the_end_does_not_take_in_the_wrappers() {
		// The block as written, and what closes it.
		for (block, closers) in [
			("{ a { b: url(x }", ")}}"),
			("{ a { b: url(x\\", "fffd)}}"),
			("{ a { top: 0 } \\", "fffd}"),
			("{ a { b: \"x\\", "\n\"}}"),
			("{ a { top: 0 } /* x", "*/}"),
		] {
			let css = format!("@custom-media --l (width < 1px), print;\n@media not (--l) {block}");
			let out = resolve_custom_media(&css);
			assert_eq!(
				out,
				format!(
					"@media (width < 1px), print {{ @media not (max-color:2147477350) {block}{closers} }}\n@media not print {{ @media not all and (width < 1px) {{ @media not (color:2147477350) {block}{closers} }} }}"
				)
			);
			let nodes = crate::parse::parse_stylesheet(&out).nodes;
			let preludes: Vec<&str> = nodes
				.iter()
				.filter_map(|n| match n {
					crate::parse::Node::AtRule(a) => Some(a.prelude.as_str()),
					_ => None,
				})
				.collect();
			assert_eq!(preludes, ["(width < 1px), print", "not print"], "{out}");
		}
	}

	#[test]
	fn without_minifying_a_line_of_definitions_goes_and_a_definition_at_the_end_of_a_line_takes_the_space_before_it()
	 {
		for (css, out) in [
			// Two definitions are all the line holds.
			(
				"@custom-media --n (x:1);@custom-media --m (y:1);\n@media (--n) and (--m) {}",
				"@media (x:1) and (y:1) {}",
			),
			(
				"  @custom-media --n (x:1); @custom-media --m (y:1);\t\n@media (--n) and (--m) {}",
				"@media (x:1) and (y:1) {}",
			),
			// The last line, without a line break.
			(
				"@media (--a) {}\n  @custom-media --a (x:1);",
				"@media (x:1) {}\n",
			),
			// Something before it on the line, nothing after it.
			(
				"/* x */ @custom-media --n (x:1);\n@media (--n) {}",
				"/* x */\n@media (x:1) {}",
			),
			// Something after it on the line: the indentation stays.
			(
				"  @custom-media --n (x:1); a { top: 0 }\n@media (--n) {}",
				"  a { top: 0 }\n@media (x:1) {}",
			),
			// A rule between two definitions keeps the line.
			(
				"@custom-media --l (width < 1px), print;\n@custom-media --a (x:1); @media not (--l) {} @custom-media --b (y:1);\n",
				"@media (width < 1px), print { @media not (max-color:2147477350) {} } @media not print { @media not all and (width < 1px) { @media not (color:2147477350) {} } }\n",
			),
		] {
			assert_eq!(resolve_custom_media(css), out, "{css}");
		}
	}

	#[test]
	fn without_minifying_the_copies_are_separated_by_the_line_break_of_the_source() {
		let css = "@custom-media --l (width < 1px), print;\r\n@media not (--l) {\r\n  a { top: 0 }\r\n}\r\n";
		assert_eq!(
			resolve_custom_media(css),
			"@media (width < 1px), print { @media not (max-color:2147477350) {\r\n  a { top: 0 }\r\n} }\r\n@media not print { @media not all and (width < 1px) { @media not (color:2147477350) {\r\n  a { top: 0 }\r\n} } }\r\n"
		);
	}

	#[test]
	fn without_minifying_the_copies_of_two_references_nest_as_the_minifier_nests_them() {
		let css = "@custom-media --a screen;\n@custom-media --b print;\n@media (--a) and (--b) { a { top: 0 } }\n";
		let out = resolve_custom_media(css);
		assert_eq!(
			out,
			"@media screen { @media print { @media (max-color:2147477350) and (max-color:2147477350) { a { top: 0 } } } @media not print { @media (max-color:2147477350) and (color:2147477350) { a { top: 0 } } } }\n@media not screen { @media print { @media (color:2147477350) and (max-color:2147477350) { a { top: 0 } } } @media not print { @media (color:2147477350) and (color:2147477350) { a { top: 0 } } } }\n"
		);
		assert_eq!(minify(&out).unwrap(), minify(css).unwrap());
	}

	#[test]
	fn without_minifying_a_line_after_a_carriage_return_or_a_form_feed_is_marked() {
		let css = "@custom-media --n (x:1);\ra {}\x0cb {}\r\nc {}";
		let (out, marks) = resolve_custom_media_with_marks(css);
		assert_eq!(out, "a {}\x0cb {}\r\nc {}");
		let pairs: Vec<(usize, usize)> = marks.iter().map(|m| (m.out, m.src)).collect();
		assert_eq!(pairs, [(0, 25), (5, 30), (11, 36)]);
	}

	#[test]
	fn without_minifying_an_at_media_without_a_block_is_copied_with_its_semicolon() {
		let css = "@custom-media --l (width < 1px), print;\n@media not (--l);\n";
		assert_eq!(
			resolve_custom_media(css),
			"@media (width < 1px), print { @media not (max-color:2147477350); }\n@media not print { @media not all and (width < 1px) { @media not (color:2147477350); } }\n"
		);
	}

	#[test]
	fn without_minifying_the_copies_are_marked_where_the_rule_and_its_block_came_from() {
		let css =
			"@custom-media --l (width < 1px), print;\n@media not (--l) {\n  a { top: 0 }\n}\n";
		let (_, marks) = resolve_custom_media_with_marks(css);
		let pairs: Vec<(usize, usize)> = marks.iter().map(|m| (m.out, m.src)).collect();
		// Each copy: its wrapping `@media` rules at `@media` (40), its block
		// at `{` (57) and the two lines after it, its closing braces at the
		// end of the rule (75). The line break before the second copy stands
		// for `@media` too, with its wrapping rules.
		assert_eq!(
			pairs,
			[
				(0, 40),
				(64, 57),
				(66, 59),
				(81, 74),
				(82, 75),
				(84, 40),
				(169, 57),
				(171, 59),
				(186, 74),
				(187, 75),
				(191, 75)
			]
		);
	}

	/// What each way of writing a reference becomes, as written.
	#[test]
	fn without_minifying_each_kind_of_reference_is_written_out() {
		for (css, out) in [
			(
				"@custom-media --c (width >= 1px) and (hover);\n@media ( --c ) { b { top: 0 } }",
				"@media (width >= 1px) and (hover) { b { top: 0 } }",
			),
			(
				"@custom-media --a (width < 1px);\n@media NOT (--a) { a { top: 0 } }",
				"@media NOT (width < 1px) { a { top: 0 } }",
			),
			(
				"@custom-media --l (width < 1px), print;\n@supports (display: grid) { @media not (--l) { a { top: 0 } } }",
				"@supports (display: grid) { @media (width < 1px), print { @media not (max-color:2147477350) { a { top: 0 } } } @media not print { @media not all and (width < 1px) { @media not (color:2147477350) { a { top: 0 } } } } }",
			),
			(
				"@custom-media --a (--b);\n@custom-media --b (--a);\n@media (--a) { a { top: 0 } }",
				"@media (--a) { a { top: 0 } }",
			),
			(
				"@custom-media --t true;\n@custom-media --f false;\n@media (--t) { a { top: 0 } }\n@media (--f) and (hover) { b { top: 0 } }",
				"@media (max-color:2147477350) { a { top: 0 } }\n@media (color:2147477350) and (hover) { b { top: 0 } }",
			),
			(
				"@custom-media --sm (576px <= width);\na { @media screen and (--sm) and (hover) { top: 0 } }",
				"a { @media screen and (576px <= width) and (hover) { top: 0 } }",
			),
			(
				"@layer x, y;\n@layer y { @custom-media --a (width < 1px); }\n@layer x { @custom-media --a (width > 2px); }\n@media (--a) { a { top: 0 } }",
				"@layer x, y;\n@layer y { }\n@layer x { }\n@media (width > 2px) { a { top: 0 } }",
			),
			(
				"@custom-media --x (--y) and (hover);\n@custom-media --y screen;\n@media (--x) { a { top: 0 } }",
				"@media screen { @media (max-color:2147477350) and (hover) { a { top: 0 } } }\n@media not screen { @media (color:2147477350) and (hover) { a { top: 0 } } }",
			),
		] {
			assert_eq!(resolve_custom_media(css), out, "{css}");
		}
	}

	#[test]
	fn without_minifying_a_definition_goes_with_its_line_whatever_ends_the_line() {
		let css = "@custom-media --a (x:1);\r\n@custom-media --b (y:1);\r@custom-media --c (z:1);\x0c@media (--a) and (--b) and (--c) {}\r\n";
		assert_eq!(
			resolve_custom_media(css),
			"@media (x:1) and (y:1) and (z:1) {}\r\n"
		);
	}

	#[test]
	fn without_minifying_the_copies_of_a_rule_in_the_middle_of_a_line_stay_on_it() {
		let css = "@custom-media --l (width < 1px), print;\na { @media not (--l) { top: 0 } }\n";
		assert_eq!(
			resolve_custom_media(css),
			"a { @media (width < 1px), print { @media not (max-color:2147477350) { top: 0 } } @media not print { @media not all and (width < 1px) { @media not (color:2147477350) { top: 0 } } } }\n"
		);
	}

	/// Around the limit of nesting, the copies of a block resolve what is in
	/// them the way the minifier does.
	#[test]
	fn without_minifying_a_reference_near_the_limit_of_nesting_is_resolved_as_the_minifier_does() {
		// The parser takes the outer blocks, two `@media` and `a`.
		for outer in 240..=crate::parse::MAX_NESTING - 3 {
			let css = format!(
				"@custom-media --l (width < 1px), print;\n{}@media not (--l) {{ @media not (--l) {{ a {{ top: 0 }} }} }}{}",
				"@supports (x) {".repeat(outer),
				"}".repeat(outer)
			);
			// What the minifier writes may nest deeper than the parser reads, so
			// the `@media` rules are compared, not the minified texts.
			let media = |css: &str| -> Vec<String> {
				css.split("@media")
					.skip(1)
					.map(|rest| {
						rest[..rest.find('{').unwrap()]
							.chars()
							.filter(|c| !c.is_whitespace())
							.collect()
					})
					.collect()
			};
			let out = resolve_custom_media(&css);
			assert_eq!(media(&out), media(&minify(&css).unwrap()), "{outer}");
			// Up to 250 blocks every reference is resolved; past that, the
			// inner one of the copy wrapped three deep would nest past the limit
			// and stays as written.
			assert_eq!(out.contains("(--l)"), outer > 250, "{outer}");
		}
	}

	#[test]
	fn without_minifying_a_style_sheet_without_definitions_is_returned_as_it_is() {
		let deep = format!("{}a{{top:0}}{}", "@media x{".repeat(300), "}".repeat(300));
		for css in [
			"@media (--a) { a { top : 0 } } /* c */",
			"@custom-media foo (x:1);\n@media (--foo) { a { top: 0 } }",
			deep.as_str(),
		] {
			assert_eq!(resolve_custom_media(css), css);
		}
	}

	#[test]
	fn without_minifying_every_line_and_every_rewritten_part_is_marked_where_it_came_from() {
		let css =
			"@custom-media --n (width < 1px);\na {\n  b: c\n}\n@media (--n) {\n  d { e: f }\n}\n";
		let (out, marks) = resolve_custom_media_with_marks(css);
		assert_eq!(
			out,
			"a {\n  b: c\n}\n@media (width < 1px) {\n  d { e: f }\n}\n"
		);
		let pairs: Vec<(usize, usize)> = marks.iter().map(|m| (m.out, m.src)).collect();
		// The four lines after the definition, the new query, the rest of the
		// line of `@media` and the two lines after it.
		assert_eq!(
			pairs,
			[
				(0, 33),
				(4, 37),
				(11, 44),
				(13, 46),
				(20, 53),
				(33, 58),
				(36, 61),
				(49, 74)
			]
		);
	}

	/// Resolving without minifying, then minifying, gives what minifying gives.
	#[test]
	fn without_minifying_the_resolution_is_the_one_of_the_minifier() {
		let cases = [
			"@custom-media --md-lte (width < 992px);\n@media (--md-lte) { a { top: 0 } }",
			"@custom-media --sm (576px <= width);\na { @media screen and (--sm) and (hover) { top: 0 } }",
			"@custom-media --l (width < 1px), print;\n@custom-media --c (width >= 1px) and (hover);\n@media (--l) { a { top: 0 } }\n@media ( --c ) { b { top: 0 } }",
			"@custom-media --narrow (width < 100px);\n@custom-media --wide (not (--narrow));\n@media (--wide) { a { top: 0 } }\n@media (not (--narrow)) { b { left: 0 } }",
			"@custom-media --wide (width >= 1px), print;\n@media (--wide) and (hover) { a { top: 0 } b { left: 0 } }",
			"@custom-media --l (width < 1px), print;\n@media (not (--l)) { a { top: 0 } }\n@media (--l) or (color) { b { left: 0 } }",
			"@custom-media --a (width >= 1px) and (hover);\n@media NOT (--a) { a { top: 0 } }",
			"@custom-media --s screen;\n@custom-media --o only screen and (hover);\n@custom-media --n not screen and (hover);\n@media not (--s) { a { top: 0 } }\n@media (--o) and (color) { b { top: 0 } }\n@media (--n) and (color) { c { top: 0 } }",
			"@custom-media --l (width < 1px), print;\n@custom-media --a (hover);\n@media (--l), (--a) and (--l) { a { top: 0 } }",
			"@custom-media --l (width < 1px), print;\n@supports (display: grid) { @media not (--l) { a { top: 0 } } }",
			"@custom-media --x (--y) and (hover);\n@custom-media --y screen;\n@media (--x) { a { top: 0 } }",
			"@media screen { @custom-media --a (width < 1px); }\n@supports (display: grid) { @custom-media --b (hover); }\n@media (--a) and (--b) { a { top: 0 } }",
			"@layer x, y;\n@layer y { @custom-media --a (width < 1px); }\n@layer x { @custom-media --a (width > 2px); }\na { @custom-media --b (hover); }\n@media (--a) and (--b) { a { top: 0 } }",
			"@custom-media --a foo(x);\n@custom-media --b not(hover);\n@media not (--a) { a { top: 0 } }\n@media not (--b) { b { top: 0 } }",
			"@custom-media --a (not (--a));\n@custom-media --b (--c) and (hover);\n@custom-media --c (not (--b));\n@custom-media --d (--a);\n@media (--a) { a { top: 0 } }\n@media (--b) { b { top: 0 } }\n@media (--d) { c { top: 0 } }",
			"@custom-media --t true;\n@custom-media --f false;\n@media (--t) { a { top: 0 } }\n@media (--f) and (hover) { b { top: 0 } }",
			"@custom-media --l (width < 1px), print;\n@media not (--l) {\n  @media not (--l) { b { top: 0 } }\n}",
			"@custom-media --a screen;\n@custom-media --b print;\n@media (--a) and (--b) { a { top: 0 } }",
			"@custom-media --l (width < 1px), print;\n@media not (--l) { a { b: c\\",
		];
		for css in cases {
			assert_eq!(
				minify(&resolve_custom_media(css)).unwrap(),
				minify(css).unwrap(),
				"{css}"
			);
		}
	}
}
