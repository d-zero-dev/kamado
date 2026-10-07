//! `@custom-media`, as postcss-custom-media (which the D-ZERO PostCSS config
//! runs) resolves it: the definitions are removed and every `(--name)` in the
//! prelude of an `@media` is replaced by what the name stands for.
//!
//! ```css
//! @custom-media --md-lte (width < 992px);
//! @media (--md-lte) { a { top: 0 } }
//! /* => @media (width < 992px) { a { top: 0 } } */
//! ```
//!
//! A definition may be a list of queries (`screen, print`): a query that uses
//! it is repeated for each. A reference that is not defined is left as it is,
//! and so is a query with `not` in front of a reference (negating a list is
//! not something a replacement can say).

use std::collections::HashMap;

use crate::parse::{Body, Node};

/// Resolves the custom media queries of a style sheet.
pub(crate) fn resolve(nodes: &mut Vec<Node>) {
	let mut defined: HashMap<String, Vec<String>> = HashMap::new();
	collect(nodes, &mut defined);
	if defined.is_empty() {
		return;
	}
	// A definition may use another one: expand until nothing changes (a cycle
	// stops at the limit and leaves its references as they are).
	for _ in 0..8 {
		let snapshot = defined.clone();
		let mut changed = false;
		for alternatives in defined.values_mut() {
			let next: Vec<String> = alternatives
				.iter()
				.flat_map(|q| replace_query(q, &snapshot))
				.collect();
			if next != *alternatives {
				*alternatives = next;
				changed = true;
			}
		}
		if !changed {
			break;
		}
	}
	apply(nodes, &defined);
}

/// Removes the definitions (at any depth, the way a style sheet may nest them
/// in a `@media`) and records them; a later definition of a name wins.
fn collect(nodes: &mut Vec<Node>, defined: &mut HashMap<String, Vec<String>>) {
	nodes.retain_mut(|n| match n {
		Node::AtRule(a) if a.name.eq_ignore_ascii_case("custom-media") => {
			if let Some((name, queries)) = definition(&a.prelude) {
				defined.insert(name, queries);
			}
			false
		}
		Node::AtRule(a) => {
			if let Body::Nodes(inner) = &mut a.body {
				collect(inner, defined);
			}
			true
		}
		Node::Rule(r) => {
			collect(&mut r.nodes, defined);
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
	if !name.starts_with("--") || name.len() == 2 {
		return None;
	}
	let value = prelude[end..].trim();
	// `true` and `false` are the queries that always and never match.
	let queries = match value.to_ascii_lowercase().as_str() {
		"true" => vec!["(max-color:2147477350)".to_owned()],
		"false" => vec!["(color:2147477350)".to_owned()],
		_ => split_queries(value),
	};
	if queries.is_empty() {
		return None;
	}
	Some((name.to_owned(), queries))
}

/// Splits a media query list at the commas that are not inside parentheses.
fn split_queries(list: &str) -> Vec<String> {
	let mut out = Vec::new();
	let mut depth = 0usize;
	let mut start = 0;
	for (i, c) in list.char_indices() {
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

fn apply(nodes: &mut [Node], defined: &HashMap<String, Vec<String>>) {
	for n in nodes {
		match n {
			Node::AtRule(a) => {
				if a.name.eq_ignore_ascii_case("media") {
					a.prelude = replace_list(&a.prelude, defined);
				}
				if let Body::Nodes(inner) = &mut a.body {
					apply(inner, defined);
				}
			}
			Node::Rule(r) => apply(&mut r.nodes, defined),
			_ => {}
		}
	}
}

/// The prelude of a `@media` with the references replaced.
fn replace_list(prelude: &str, defined: &HashMap<String, Vec<String>>) -> String {
	let mut out: Vec<String> = Vec::new();
	for query in split_queries(prelude) {
		out.extend(replace_query(&query, defined));
	}
	if out.is_empty() {
		return prelude.to_owned();
	}
	out.join(", ")
}

/// One query with every `(--name)` replaced; a query that names several
/// lists comes out once for each combination.
fn replace_query(query: &str, defined: &HashMap<String, Vec<String>>) -> Vec<String> {
	let mut results = vec![String::new()];
	let mut rest = query;
	while let Some(at) = rest.find('(') {
		let head = &rest[..at];
		let after = &rest[at + 1..];
		let Some(close) = after.find(')') else {
			break;
		};
		let inner = after[..close].trim();
		let reference = inner.starts_with("--") && !inner.contains(char::is_whitespace);
		match defined.get(inner).filter(|_| reference) {
			// `not (--a)` is replaced when `--a` is one query; negating a list is
			// not something a replacement can say.
			Some(alternatives)
				if alternatives.len() == 1
					|| !head.trim_end().to_ascii_lowercase().ends_with("not") =>
			{
				let mut next = Vec::with_capacity(results.len() * alternatives.len());
				for r in &results {
					for alt in alternatives {
						next.push(format!("{r}{head}{alt}"));
					}
				}
				results = next;
			}
			_ => {
				for r in &mut results {
					r.push_str(head);
					r.push('(');
					r.push_str(&after[..close]);
					r.push(')');
				}
			}
		}
		rest = &after[close + 1..];
	}
	for r in &mut results {
		r.push_str(rest);
	}
	results.into_iter().map(|r| r.trim().to_owned()).collect()
}

#[cfg(test)]
mod tests {
	use crate::minify;

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
	fn a_list_definition_repeats_the_query() {
		let css = "@custom-media --wide (width >= 1px), print;\n@media (--wide) and (hover) { a { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (width >= 1px) and (hover),print and (hover){a{top:0}}"
		);
	}

	#[test]
	fn an_undefined_name_and_the_negation_of_a_list_stay() {
		let css = "@custom-media --l (width < 1px), print;\n@media (--b) { a { top: 0 } }\n@media not (--l) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (--b ){a{top:0}}@media not (--l ){b{top:0}}"
		);
	}

	#[test]
	fn the_negation_of_one_query_is_replaced() {
		let css = "@custom-media --a (width < 1px);\n@media not (--a) { b { top: 0 } }";
		assert_eq!(minify(css).unwrap(), "@media not (width < 1px){b{top:0}}");
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
	fn a_cycle_does_not_loop() {
		let css =
			"@custom-media --a (--b);\n@custom-media --b (--a);\n@media (--a) { a { top: 0 } }";
		assert!(minify(css).unwrap().starts_with("@media"));
	}

	#[test]
	fn true_and_false_are_queries_that_always_and_never_match() {
		let css = "@custom-media --t true;\n@custom-media --f false;\n@media (--t) { a { top: 0 } }\n@media (--f) { b { top: 0 } }";
		assert_eq!(
			minify(css).unwrap(),
			"@media (max-color:2147477350){a{top:0}}@media (color:2147477350){b{top:0}}"
		);
	}
}
