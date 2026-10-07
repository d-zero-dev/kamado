//! Merging adjacent rules: the part of postcss-merge-rules that cannot change
//! what a browser does.
//!
//! - Two adjacent rules with the same selector become one rule with both
//!   rules' declarations in order.
//! - Two adjacent rules with the same declarations become one rule with both
//!   selector lists, but only when every selector is made of things all
//!   browsers parse. A browser drops a whole rule when one selector in its list
//!   is one it does not know, so `a::-webkit-x{c}` and `a::-moz-x{c}` must not
//!   share a rule, and neither must selectors with `:is()`, `:has()` or
//!   `::part()`. cssnano decides that from the browsers it is configured for;
//!   here the list of what is always safe is short and fixed.
//!
//! Not done: merging only some declarations (`a{x:1;y:2} b{x:1;z:3}`), and
//! merging rules that are not neighbours.

use crate::parse::{AtRule, Body, Node, Rule};
use crate::selector::minify_selector_list;

/// Pseudo-classes every browser has had since CSS 2 or 3.
const SAFE_PSEUDO_CLASSES: [&str; 17] = [
	"hover",
	"active",
	"focus",
	"visited",
	"link",
	"first-child",
	"last-child",
	"only-child",
	"first-of-type",
	"last-of-type",
	"only-of-type",
	"empty",
	"root",
	"checked",
	"disabled",
	"enabled",
	"target",
];

const SAFE_PSEUDO_ELEMENTS: [&str; 4] = ["before", "after", "first-line", "first-letter"];

fn is_ident_byte(c: u8) -> bool {
	c.is_ascii_alphanumeric() || c == b'-' || c == b'_'
}

/// Whether a minified selector list uses only what every browser parses.
fn is_safe_selector_list(sel: &str) -> bool {
	let b = sel.as_bytes();
	if b.is_empty() || !sel.is_ascii() || sel.contains('\\') {
		return false;
	}
	// Split at the top-level commas.
	let mut depth = 0usize;
	let mut start = 0;
	let mut parts: Vec<&str> = Vec::new();
	for (i, &c) in b.iter().enumerate() {
		match c {
			b'(' | b'[' => {
				depth += 1;
				// `:not(` inside `:not(` is read by recursion; nothing safe
				// nests more than a few levels.
				if depth > 4 {
					return false;
				}
			}
			b')' | b']' => depth = depth.saturating_sub(1),
			b',' if depth == 0 => {
				parts.push(&sel[start..i]);
				start = i + 1;
			}
			_ => {}
		}
	}
	parts.push(&sel[start..]);
	parts.iter().all(|p| is_safe_complex(p))
}

fn is_safe_complex(s: &str) -> bool {
	let b = s.as_bytes();
	if b.is_empty() {
		return false;
	}
	let mut i = 0;
	// A selector may not start or end with a combinator here.
	let is_comb = |c: u8| matches!(c, b'>' | b'+' | b'~' | b' ');
	if is_comb(b[0]) || is_comb(b[b.len() - 1]) {
		return false;
	}
	while i < b.len() {
		let c = b[i];
		match c {
			b'>' | b'+' | b'~' | b' ' | b'*' => i += 1,
			b'.' | b'#' => {
				i += 1;
				let st = i;
				while i < b.len() && is_ident_byte(b[i]) {
					i += 1;
				}
				if i == st {
					return false;
				}
			}
			b'[' => {
				// An attribute selector: to the matching bracket, quotes aside.
				// A space outside quotes is the `i` flag, which old browsers
				// reject.
				let mut j = i + 1;
				while j < b.len() && b[j] != b']' {
					if b[j] == b'"' || b[j] == b'\'' {
						let q = b[j];
						j += 1;
						while j < b.len() && b[j] != q {
							j += 1;
						}
					} else if b[j] == b' ' {
						return false;
					}
					j += 1;
				}
				if j >= b.len() {
					return false;
				}
				i = j + 1;
			}
			b':' => {
				i += 1;
				if b.get(i) == Some(&b':') {
					i += 1;
				}
				let st = i;
				while i < b.len() && is_ident_byte(b[i]) {
					i += 1;
				}
				let name = &s[st..i];
				if b.get(i) == Some(&b'(') {
					let mut depth = 0usize;
					let mut j = i;
					while j < b.len() {
						match b[j] {
							b'(' => depth += 1,
							b')' => {
								depth -= 1;
								if depth == 0 {
									break;
								}
							}
							_ => {}
						}
						j += 1;
					}
					if j >= b.len() {
						return false;
					}
					let arg = &s[i + 1..j];
					let ok = match name {
						"nth-child" | "nth-last-child" | "nth-of-type" | "nth-last-of-type" => {
							!arg.is_empty()
								&& arg
									.bytes()
									.all(|c| c.is_ascii_digit() || matches!(c, b'n' | b'+' | b'-'))
								|| arg == "odd" || arg == "even"
						}
						// `:not()` with one simple selector inside.
						"not" => !arg.contains([',', ' ', '>', '+', '~']) && is_safe_complex(arg),
						_ => false,
					};
					if !ok {
						return false;
					}
					i = j + 1;
				} else if !SAFE_PSEUDO_CLASSES.contains(&name)
					&& !SAFE_PSEUDO_ELEMENTS.contains(&name)
				{
					return false;
				}
			}
			c if is_ident_byte(c) => {
				while i < b.len() && is_ident_byte(b[i]) {
					i += 1;
				}
			}
			_ => return false,
		}
	}
	true
}

fn only_declarations(r: &Rule) -> bool {
	r.nodes.iter().all(|n| matches!(n, Node::Declaration(_)))
}

fn same_block(a: &Rule, b: &Rule) -> bool {
	a.nodes.len() == b.nodes.len()
		&& a.nodes.iter().zip(&b.nodes).all(|(x, y)| match (x, y) {
			(Node::Declaration(p), Node::Declaration(q)) => {
				p.property == q.property && p.value == q.value && p.important == q.important
			}
			_ => false,
		})
}

/// Whether an at-rule is a conditional group rule whose blocks can be joined
/// when two of them with the same prelude are neighbours.
fn is_joinable(a: &AtRule) -> bool {
	matches!(
		a.name.to_ascii_lowercase().as_str(),
		"media" | "supports" | "container"
	) && matches!(a.body, Body::Nodes(_))
}

/// Merges the neighbouring rules of every list in the tree.
pub fn merge_rules(nodes: &mut Vec<Node>) {
	// `@media x{a} @media x{b}` is `@media x{a b}`.
	let mut joined: Vec<Node> = Vec::with_capacity(nodes.len());
	for n in nodes.drain(..) {
		if let Node::AtRule(a) = &n
			&& is_joinable(a)
			&& let Some(Node::AtRule(prev)) = joined.last_mut()
			&& is_joinable(prev)
			&& prev.name.eq_ignore_ascii_case(&a.name)
			&& prev.prelude == a.prelude
			&& let Body::Nodes(more) = &a.body
			&& let Body::Nodes(into) = &mut prev.body
			// No declaration after a nested rule (see below).
			&& !(into.iter().any(|n| matches!(n, Node::Rule(_) | Node::AtRule(_)))
				&& more.iter().any(|n| matches!(n, Node::Declaration(_))))
		{
			into.extend(more.iter().cloned());
			continue;
		}
		joined.push(n);
	}
	*nodes = joined;
	for n in nodes.iter_mut() {
		match n {
			Node::Rule(r) => merge_rules(&mut r.nodes),
			Node::AtRule(a) => {
				if let Body::Nodes(children) = &mut a.body {
					merge_rules(children);
				}
			}
			_ => {}
		}
	}
	// Same selector. Rules with nested rules are left alone: a declaration
	// after a nested rule is read differently by browsers before and after
	// the change to the nesting specification, so what follows what must not
	// change.
	let mut out: Vec<Node> = Vec::with_capacity(nodes.len());
	for n in nodes.drain(..) {
		if let Node::Rule(r) = &n
			&& let Some(Node::Rule(prev)) = out.last_mut()
			&& prev.selector == r.selector
			&& only_declarations(prev)
			&& only_declarations(r)
		{
			prev.nodes.extend(r.nodes.iter().cloned());
			continue;
		}
		out.push(n);
	}
	// Same declarations. The selectors that join the last rule are collected
	// and written once when the run ends: minifying the growing list at every
	// step takes time quadratic in the length of the run (tens of thousands of
	// utility classes with one declaration took more than a minute).
	let mut merged: Vec<Node> = Vec::with_capacity(out.len());
	let mut joined: Option<String> = None;
	let mut last_is_safe = false;
	let finish = |merged: &mut Vec<Node>, joined: &mut Option<String>| {
		if let Some(list) = joined.take()
			&& let Some(Node::Rule(prev)) = merged.last_mut()
		{
			prev.selector = minify_selector_list(&list, false);
		}
	};
	for n in out {
		if let Node::Rule(r) = &n
			&& let Some(Node::Rule(prev)) = merged.last_mut()
			&& only_declarations(prev)
			&& only_declarations(r)
			&& !r.nodes.is_empty()
			&& same_block(prev, r)
			&& last_is_safe
			&& is_safe_selector_list(&r.selector)
		{
			let list = joined.get_or_insert_with(|| prev.selector.clone());
			list.push(',');
			list.push_str(&r.selector);
			continue;
		}
		finish(&mut merged, &mut joined);
		last_is_safe = matches!(&n, Node::Rule(r) if is_safe_selector_list(&r.selector));
		merged.push(n);
	}
	finish(&mut merged, &mut joined);
	*nodes = merged;
}
