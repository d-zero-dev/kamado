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
//! - Two adjacent blocks of `@media`, `@supports`, `@container` or a named
//!   `@layer` with the same prelude exchange rules the way cssnano does: the
//!   rules of the second block (up to the first nested at-rule that holds a
//!   rule) go to the end of the first, and what is not a rule (`@font-face`,
//!   `@layer p, q;`, comments) stays in the second block. Nothing moves when
//!   the last rule of the first block or the first rule of the second is inside
//!   a nested at-rule: cssnano moves a rule only next to a rule that stands in
//!   an equal block. An anonymous `@layer` is never joined: each of them is a
//!   layer of its own, and joining two changes the cascade (cssnano does it).
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

/// Whether an at-rule is a block whose rules can be moved into a neighbour with
/// the same prelude: a conditional group rule, or a named `@layer` block.
/// cssnano joins anonymous `@layer` blocks too, which is wrong: each of them
/// is a layer of its own, and joining two changes the cascade.
fn is_joinable(a: &AtRule) -> bool {
	if !matches!(a.body, Body::Nodes(_)) {
		return false;
	}
	match a.name.to_ascii_lowercase().as_str() {
		"media" | "supports" | "container" => true,
		"layer" => !a.prelude.trim().is_empty(),
		_ => false,
	}
}

/// Whether a block holds a style rule at any depth.
fn holds_rule(nodes: &[Node]) -> bool {
	nodes.iter().any(|n| match n {
		Node::Rule(_) => true,
		Node::AtRule(a) => matches!(&a.body, Body::Nodes(inner) if holds_rule(inner)),
		_ => false,
	})
}

/// Whether the style rule that comes last in a block is a child of the block
/// and not of a nested at-rule. cssnano moves the rules of a block into an
/// earlier block with the same prelude one by one, a rule next to the rule
/// before it, and only when both stand in equal blocks: with a rule of a
/// nested `@media` in between, nothing moves.
fn ends_with_own_rule(children: &[Node]) -> bool {
	for n in children.iter().rev() {
		match n {
			Node::Rule(_) => return true,
			Node::AtRule(a) if matches!(&a.body, Body::Nodes(inner) if holds_rule(inner)) => {
				return false;
			}
			_ => {}
		}
	}
	false
}

/// The same for the rule that comes first.
fn starts_with_own_rule(children: &[Node]) -> bool {
	for n in children {
		match n {
			Node::Rule(_) => return true,
			Node::AtRule(a) if matches!(&a.body, Body::Nodes(inner) if holds_rule(inner)) => {
				return false;
			}
			_ => {}
		}
	}
	false
}

/// The children of the second of two blocks that go into the first, and those
/// that stay: the rules, up to the first nested at-rule that holds a rule of
/// its own (from there on, a rule is not next to a rule of the first block).
/// Whatever is not a rule (nested layers and statements, `@font-face`,
/// comments) stays where it is.
fn split_movable(children: Vec<Node>) -> (Vec<Node>, Vec<Node>) {
	let mut moved = Vec::new();
	let mut stays = Vec::new();
	let mut stopped = false;
	for n in children {
		match &n {
			Node::Rule(_) if !stopped => moved.push(n),
			Node::AtRule(a) if matches!(&a.body, Body::Nodes(inner) if holds_rule(inner)) => {
				stopped = true;
				stays.push(n);
			}
			_ => stays.push(n),
		}
	}
	(moved, stays)
}

/// Merges the neighbouring rules and the neighbouring blocks of every list in
/// the tree (see the documentation of the module for what is merged and what
/// is not).
pub fn merge_rules(nodes: &mut Vec<Node>) {
	// `@media x{a} @media x{b}` is `@media x{a b}`.
	let mut joined: Vec<Node> = Vec::with_capacity(nodes.len());
	for mut n in nodes.drain(..) {
		if let Node::AtRule(a) = &mut n
			&& is_joinable(a)
			&& let Some(Node::AtRule(prev)) = joined.last_mut()
			&& is_joinable(prev)
			&& prev.name.eq_ignore_ascii_case(&a.name)
			&& prev.prelude == a.prelude
			&& let Body::Nodes(more) = &mut a.body
			&& let Body::Nodes(into) = &mut prev.body
			&& ends_with_own_rule(into)
			&& starts_with_own_rule(more)
			// No declaration after a nested rule (see below).
			&& !(into.iter().any(|n| matches!(n, Node::Rule(_) | Node::AtRule(_)))
				&& more.iter().any(|n| matches!(n, Node::Declaration(_))))
		{
			let (moved, stays) = split_movable(std::mem::take(more));
			into.extend(moved);
			if stays.is_empty() {
				continue;
			}
			*more = stays;
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
