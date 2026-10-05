//! The order of the parts of a shorthand: postcss-ordered-values. Parts that
//! may come in any order are written in one canonical order, so that equal
//! values are equal text (which discard-duplicates and gzip both like).
//!
//! Ported: `border` and its sides, `outline`, `column-rule`, `box-shadow`,
//! `transition`, `animation`, `columns` and `flex-flow`. Not ported: `list-style`
//! (cssnano gets `list-style: square inside url(a.png)` wrong) and the `grid-*`
//! rules, which split text by hand.
//!
//! Unlike cssnano, a value with a part that the rule does not recognise (a
//! second colour, an unknown keyword in `flex-flow`) is left as it is, and
//! never loses a part.

use crate::value::{ValueNode, parse, stringify, unit, walk};

fn strip_vendor(prop: &str) -> &str {
	if let Some(rest) = prop.strip_prefix('-')
		&& let Some((vendor, tail)) = rest.split_once('-')
		&& !vendor.is_empty()
		&& vendor.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_')
	{
		return tail;
	}
	prop
}

fn is_math(name: &str) -> bool {
	matches!(
		strip_vendor(&name.to_ascii_lowercase()),
		"calc" | "clamp" | "max" | "min"
	)
}

const BORDER_STYLES: [&str; 11] = [
	"none", "auto", "hidden", "dotted", "dashed", "solid", "double", "groove", "ridge", "inset",
	"outset",
];
const BORDER_WIDTHS: [&str; 3] = ["thin", "medium", "thick"];

fn text(n: &ValueNode) -> String {
	stringify(std::slice::from_ref(n))
}

/// `border: red solid 1px` -> `1px solid red`; with `drop_defaults` also the
/// parts that are the initial value (`border: 1px solid currentColor` is
/// `border: 1px solid`, `medium none` is `none`).
fn border(nodes: &[ValueNode], drop_defaults: bool) -> Option<String> {
	let (mut width, mut style, mut color): (Option<String>, Option<String>, Option<String>) =
		(None, None, None);
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Word(w) => {
				let l = w.to_ascii_lowercase();
				if BORDER_STYLES.contains(&l.as_str()) {
					if style.replace(w.clone()).is_some() {
						return None;
					}
				} else if BORDER_WIDTHS.contains(&l.as_str()) || unit(&l).is_some() {
					if width.replace(w.clone()).is_some() {
						return None;
					}
				} else if color.replace(w.clone()).is_some() {
					return None;
				}
			}
			ValueNode::Function { name, .. } => {
				if is_math(name) {
					if width.replace(text(n)).is_some() {
						return None;
					}
				} else if color.replace(text(n)).is_some() {
					return None;
				}
			}
			_ => return None,
		}
	}
	if drop_defaults {
		let is = |part: &Option<String>, default: &str| {
			part.as_deref().is_some_and(|p| p.eq_ignore_ascii_case(default))
		};
		let (w, s, c) = (is(&width, "medium"), is(&style, "none"), is(&color, "currentcolor"));
		if w {
			width = None;
		}
		if s {
			style = None;
		}
		if c {
			color = None;
		}
		if width.is_none() && style.is_none() && color.is_none() {
			// Everything was the default: `none` says it in one word.
			return Some("none".to_owned());
		}
	}
	let parts: Vec<String> = [width, style, color].into_iter().flatten().collect();
	Some(parts.join(" "))
}

fn border_keeping_defaults(nodes: &[ValueNode]) -> Option<String> {
	border(nodes, false)
}

fn border_dropping_defaults(nodes: &[ValueNode]) -> Option<String> {
	border(nodes, true)
}

/// `box-shadow: 0 0 1px red inset` -> `inset 0 0 1px red`.
fn box_shadow(nodes: &[ValueNode]) -> Option<String> {
	let mut shadows: Vec<String> = Vec::new();
	let mut inset = String::new();
	let mut lengths: Vec<String> = Vec::new();
	let mut color = String::new();
	let flush = |inset: &mut String, lengths: &mut Vec<String>, color: &mut String| {
		let mut parts: Vec<String> = Vec::new();
		if !inset.is_empty() {
			parts.push(std::mem::take(inset));
		}
		parts.append(lengths);
		if !color.is_empty() {
			parts.push(std::mem::take(color));
		}
		parts.join(" ")
	};
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Div { value: ',', .. } => {
				shadows.push(flush(&mut inset, &mut lengths, &mut color));
			}
			ValueNode::Word(w) => {
				if unit(w).is_some() {
					lengths.push(w.clone());
				} else if w.eq_ignore_ascii_case("inset") {
					if !inset.is_empty() {
						return None;
					}
					inset = w.clone();
				} else {
					if !color.is_empty() {
						return None;
					}
					color = w.clone();
				}
			}
			ValueNode::Function { name, .. } => {
				if is_math(name) {
					return None;
				}
				if !color.is_empty() {
					return None;
				}
				color = text(n);
			}
			_ => return None,
		}
	}
	shadows.push(flush(&mut inset, &mut lengths, &mut color));
	Some(shadows.join(","))
}

fn is_timing_keyword(l: &str) -> bool {
	matches!(
		l,
		"ease" | "ease-in" | "ease-in-out" | "ease-out" | "linear" | "step-end" | "step-start"
	)
}

/// The groups of a comma separated list, without the spaces.
fn groups(nodes: &[ValueNode]) -> Option<Vec<Vec<&ValueNode>>> {
	let mut out: Vec<Vec<&ValueNode>> = vec![Vec::new()];
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Div { value: ',', .. } => out.push(Vec::new()),
			ValueNode::Word(_) | ValueNode::Function { .. } => out.last_mut()?.push(n),
			_ => return None,
		}
	}
	Some(out)
}

/// `transition: 1s opacity ease` -> `opacity 1s ease`.
fn transition(nodes: &[ValueNode]) -> Option<String> {
	let mut list: Vec<String> = Vec::new();
	for group in groups(nodes)? {
		let (mut property, mut time1, mut timing, mut time2) =
			(Vec::new(), Vec::new(), Vec::new(), Vec::new());
		for n in group {
			let t = text(n);
			match n {
				ValueNode::Function { name, .. }
					if matches!(name.to_ascii_lowercase().as_str(), "cubic-bezier" | "linear" | "steps") =>
				{
					timing.push(t);
				}
				ValueNode::Word(w) if unit(w).is_some() => {
					if time1.is_empty() {
						time1.push(t);
					} else {
						time2.push(t);
					}
				}
				ValueNode::Word(w) if is_timing_keyword(&w.to_ascii_lowercase()) => timing.push(t),
				_ => property.push(t),
			}
		}
		let parts: Vec<String> = [property, time1, timing, time2].concat();
		list.push(parts.join(" "));
	}
	Some(list.join(","))
}

fn time_unit(n: &ValueNode) -> Option<(String, String)> {
	match n {
		ValueNode::Word(w) => unit(w).map(|(a, b)| (a.to_owned(), b.to_owned())),
		ValueNode::Function { name, nodes, .. } if is_math(&name.to_ascii_lowercase()) => {
			for p in nodes {
				if let Some((a, b)) = time_unit(p)
					&& !b.is_empty()
					&& b != "%"
				{
					return Some((a, b));
				}
			}
			None
		}
		_ => None,
	}
}

/// `animation: 2s ease-in foo` -> `foo 2s ease-in`.
fn animation(nodes: &[ValueNode]) -> Option<String> {
	let mut list: Vec<String> = Vec::new();
	for group in groups(nodes)? {
		// name, duration, timing, delay, iteration, direction, fill, play state
		let mut slots: [Vec<String>; 8] = Default::default();
		for n in group {
			let t = text(n);
			let l = n.value().to_ascii_lowercase();
			let is_time = time_unit(n).is_some_and(|(_, u)| matches!(u.as_str(), "s" | "ms"));
			let is_timing = matches!(n, ValueNode::Function { .. })
				&& matches!(l.as_str(), "cubic-bezier" | "linear" | "steps" | "frames")
				|| (matches!(n, ValueNode::Word(_)) && is_timing_keyword(&l));
			let is_iteration = l == "infinite" || time_unit(n).is_some_and(|(_, u)| u.is_empty());
			let is_direction = matches!(l.as_str(), "normal" | "reverse" | "alternate" | "alternate-reverse");
			let is_fill = matches!(l.as_str(), "none" | "forwards" | "backwards" | "both");
			let is_play = matches!(l.as_str(), "running" | "paused");
			// Slot 1 duration, 2 timing, 3 delay, 4 iteration, 5 direction, 6 fill, 7 play state.
			let target = if is_time && slots[1].is_empty() {
				1
			} else if is_timing && slots[2].is_empty() {
				2
			} else if is_time && slots[3].is_empty() {
				3
			} else if is_iteration && slots[4].is_empty() {
				4
			} else if is_direction && slots[5].is_empty() {
				5
			} else if is_fill && slots[6].is_empty() {
				6
			} else if is_play && slots[7].is_empty() {
				7
			} else {
				0
			};
			// A keyword with no slot left (`ease 1s ease`) may be the name or a
			// repeated part: which one is for the browser to say, so the
			// value is left alone.
			let keyword_like =
				is_time || is_timing || is_iteration || is_direction || is_fill || is_play;
			if target == 0 && keyword_like {
				return None;
			}
			slots[target].push(t);
		}
		if slots[0].len() > 1 {
			return None;
		}
		let parts: Vec<String> = slots.concat();
		list.push(parts.join(" "));
	}
	Some(list.join(","))
}

/// `columns: 2 100px` -> `100px 2`.
fn columns(nodes: &[ValueNode]) -> Option<String> {
	let mut widths: Vec<String> = Vec::new();
	let mut other: Vec<String> = Vec::new();
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Word(w) => {
				if unit(w).is_some_and(|(_, u)| !u.is_empty()) {
					widths.push(w.clone());
				} else {
					other.push(w.clone());
				}
			}
			_ => return None,
		}
	}
	(widths.len() == 1 && other.len() == 1).then(|| format!("{} {}", widths[0], other[0]))
}

/// `flex-flow: wrap row` -> `row wrap`.
fn flex_flow(nodes: &[ValueNode]) -> Option<String> {
	let (mut direction, mut wrap) = (None, None);
	for n in nodes {
		match n {
			ValueNode::Space(_) => {}
			ValueNode::Word(w) => {
				let l = w.to_ascii_lowercase();
				if matches!(l.as_str(), "row" | "row-reverse" | "column" | "column-reverse") {
					if direction.replace(w.clone()).is_some() {
						return None;
					}
				} else if matches!(l.as_str(), "nowrap" | "wrap" | "wrap-reverse") {
					if wrap.replace(w.clone()).is_some() {
						return None;
					}
				} else {
					return None;
				}
			}
			_ => return None,
		}
	}
	let parts: Vec<String> = [direction, wrap].into_iter().flatten().collect();
	Some(parts.join(" "))
}

fn should_abort(nodes: &mut [ValueNode]) -> bool {
	let mut abort = false;
	walk(nodes, &mut |n| {
		match n {
			ValueNode::Comment { .. } => abort = true,
			ValueNode::Function { name, .. }
				if matches!(name.to_ascii_lowercase().as_str(), "var" | "env" | "constant") =>
			{
				abort = true;
			}
			ValueNode::Word(w) if w.contains("___CSS_LOADER_IMPORT___") => abort = true,
			_ => {}
		}
		!abort
	});
	abort
}

/// Writes the parts of the shorthand `prop` (lower case) in the canonical
/// order; any other property, and any value the rules do not fully
/// understand, comes back unchanged.
///
/// # Example
///
/// ```
/// use kd_css::ordered::ordered_values;
///
/// assert_eq!(ordered_values("border", "red solid 1px"), "1px solid red");
/// assert_eq!(ordered_values("transition", "1s opacity ease-in"), "opacity 1s ease-in");
/// assert_eq!(ordered_values("margin", "1px 2px"), "1px 2px");
/// ```
pub fn ordered_values(prop: &str, value: &str) -> String {
	let rule = match strip_vendor(prop) {
		"animation" => animation,
		"outline" | "column-rule" => border_keeping_defaults,
		"border" | "border-block" | "border-inline" | "border-block-end" | "border-block-start"
		| "border-inline-end" | "border-inline-start" | "border-top" | "border-right"
		| "border-bottom" | "border-left" => border_dropping_defaults,
		"box-shadow" => box_shadow,
		"flex-flow" => flex_flow,
		"transition" => transition,
		"columns" => columns,
		_ => return value.to_owned(),
	};
	let mut nodes = parse(value);
	if nodes.len() < 2 || should_abort(&mut nodes) {
		return value.to_owned();
	}
	rule(&nodes).unwrap_or_else(|| value.to_owned())
}
