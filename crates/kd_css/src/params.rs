//! At-rule preludes: postcss-minify-params for `@media` and `@supports`
//! (white space inside conditions goes, `all and` goes, aspect ratios are
//! reduced, the comma separated queries of a list are sorted and
//! de-duplicated), the same white space rules for `@container`, and a plain
//! white space collapse for every other at-rule.

use crate::selector::collapse_ws;
use crate::strings::normalize_strings;
use crate::value::{ValueNode, parse, push_node, stringify};

fn gcd(a: u64, b: u64) -> u64 {
	if b == 0 { a } else { gcd(b, a % b) }
}

fn reduce_nodes(nodes: &mut [ValueNode]) {
	for n in nodes.iter_mut() {
		match n {
			ValueNode::Div { before, after, .. } => {
				before.clear();
				after.clear();
			}
			ValueNode::Function {
				before,
				after,
				nodes: inner,
				..
			} => {
				before.clear();
				let custom = inner
					.first()
					.and_then(ValueNode::word)
					.is_some_and(|w| w.starts_with("--"))
					&& inner.get(2).is_none();
				*after = if custom {
					" ".to_owned()
				} else {
					String::new()
				};
				// `(min-aspect-ratio: 32/18)` is `16/9`.
				if inner.len() > 4
					&& let Some(name) = inner[0].word()
					&& name.to_ascii_lowercase().find("-aspect-ratio") == Some(3)
					&& let (Some(a), Some(b)) = (inner[2].word(), inner[4].word())
					&& let (Ok(x), Ok(y)) = (a.parse::<u64>(), b.parse::<u64>())
					&& x > 0 && y > 0
				{
					let d = gcd(x, y);
					inner[2] = ValueNode::Word((x / d).to_string());
					inner[4] = ValueNode::Word((y / d).to_string());
				}
				reduce_nodes(inner);
			}
			ValueNode::Space(s) => *s = " ".to_owned(),
			_ => {}
		}
	}
}

/// The prelude of `@media`, `@supports` (`sort`: also order the queries) or
/// `@container`.
fn condition(params: &str, sort: bool, is_media: bool) -> String {
	let mut nodes = parse(params);
	reduce_nodes(&mut nodes);
	// `all` at the start of a single query.
	if is_media && !nodes.iter().any(|n| n.is_div(',')) {
		let is_all = nodes
			.first()
			.and_then(ValueNode::word)
			.is_some_and(|w| w.eq_ignore_ascii_case("all"));
		if is_all {
			if nodes.len() == 1 {
				nodes.clear();
			} else if nodes.len() >= 5
				&& nodes[1].is_space()
				&& nodes[2]
					.word()
					.is_some_and(|w| w.eq_ignore_ascii_case("and"))
				&& nodes[3].is_space()
			{
				nodes.drain(0..4);
			}
		}
	}
	if !sort {
		return stringify(&nodes);
	}
	let mut parts: Vec<String> = Vec::new();
	let mut current = String::new();
	for n in &nodes {
		if n.is_div(',') {
			parts.push(std::mem::take(&mut current));
		} else {
			push_node(&mut current, n);
		}
	}
	parts.push(current);
	parts.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
	parts.dedup();
	parts.join(",")
}

/// Minifies the prelude of an at-rule called `name` (without the `@`).
///
/// # Example
///
/// ```
/// use kd_css::params::minify_params;
///
/// assert_eq!(minify_params("media", "screen  and ( min-width : 100px ) , print"), "print,screen and (min-width:100px)");
/// assert_eq!(minify_params("media", "all and (min-width:1px)"), "(min-width:1px)");
/// assert_eq!(minify_params("layer", "a ,  b"), "a , b");
/// ```
pub fn minify_params(name: &str, params: &str) -> String {
	let lower = name.to_ascii_lowercase();
	let params = normalize_strings(params);
	match lower.as_str() {
		"media" | "supports" => condition(&params, true, lower == "media"),
		"container" => condition(&params, false, false),
		"charset" => params,
		"import"
		| "namespace"
		| "layer"
		| "page"
		| "keyframes"
		| "-webkit-keyframes"
		| "-moz-keyframes"
		| "-o-keyframes"
		| "property"
		| "counter-style"
		| "font-palette-values"
		| "font-feature-values"
		| "scope"
		| "starting-style"
		| "position-try"
		| "view-transition" => collapse_ws(&params),
		_ => params,
	}
}

/// Minifies a media query list as found in a `media` attribute.
///
/// # Example
///
/// ```
/// assert_eq!(kd_css::minify_media_query("screen  and (min-width: 100px)"), "screen and (min-width:100px)");
/// assert_eq!(kd_css::minify_media_query("all"), "");
/// ```
pub fn minify_media_query_text(source: &str) -> String {
	let trimmed = source.trim_matches(|c: char| matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c'));
	let cleaned = strip_comments(trimmed);
	condition(&cleaned, true, true)
}

fn strip_comments(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut rest = s;
	while let Some(i) = rest.find("/*") {
		out.push_str(&rest[..i]);
		out.push(' ');
		match rest[i + 2..].find("*/") {
			Some(j) => rest = &rest[i + 2 + j + 2..],
			None => {
				rest = "";
			}
		}
	}
	out.push_str(rest);
	out
}
