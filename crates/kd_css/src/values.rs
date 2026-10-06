//! Declaration values: the cssnano plugins that rewrite what a property is
//! set to, in the order the default preset runs them.
//!
//! Ported here: minify-gradients, normalize-display-values,
//! reduce-transforms, colormin, normalize-timing-functions,
//! convert-values, normalize-string, normalize-unicode,
//! minify-font-values, normalize-url, normalize-repeat-style,
//! normalize-positions and normalize-whitespace, plus the reduction of
//! four-value box shorthands (`margin: 1px 2px 1px 2px` is `1px 2px`) that
//! postcss-merge-longhand does.
//!
//! Not ported: calc() constant folding, `reduce-initial`, svgo for inline
//! SVG data URLs, merging of longhands into shorthands, and the reordering
//! of shorthand components (ordered-values) except where it shortens the
//! value. Each is a size or compression gain and none changes what a
//! browser does; the report of the crate's tests says what they cost.

use crate::calc::fold_calc;
use crate::color::minify_color;
use crate::fonts::{minify_font, minify_font_family, minify_weight};
use crate::numeric::{DeclContext, convert_values};
use crate::ordered::ordered_values;
use crate::property_table::KNOWN_PROPERTIES;
use crate::strings::{normalize_strings_in, normalize_urls};
use crate::value::{ValueNode, parse, stringify, unit, walk};

/// Minifies the value of declaration `property`.
///
/// `property` is as written; the function lower-cases it where it matters.
/// Custom properties are returned unchanged.
///
/// # Example
///
/// ```
/// use kd_css::numeric::DeclContext;
/// use kd_css::values::minify_value;
///
/// let ctx = DeclContext::default();
/// assert_eq!(minify_value("color", "#FF0000", &ctx), "red");
/// assert_eq!(minify_value("margin", "0px  auto", &ctx), "0 auto");
/// assert_eq!(minify_value("--x", "#FF0000", &ctx), "#FF0000");
/// ```
pub fn minify_value(property: &str, value: &str, ctx: &DeclContext) -> String {
	if property.starts_with("--") || value.is_empty() {
		return value.to_owned();
	}
	let prop = property.to_ascii_lowercase();
	// What is not a property the minifier knows (a typo, a preprocessor's
	// own, `composes` of CSS modules) keeps its value as written, white space
	// aside: nothing says what `0px` or `RED` is there.
	if !is_known_property(&prop) {
		return normalize_whitespace(value);
	}
	let lower = value.to_ascii_lowercase();
	// Values only an old IE reads: whitespace only.
	if lower.contains("progid:") || lower.contains("expression(") {
		let mut v = value.to_owned();
		if lower.contains("progid:") && v.contains(['\'', '"']) {
			let mut nodes = parse(&v);
			normalize_strings_in(&mut nodes);
			v = stringify(&nodes);
		}
		return normalize_whitespace(&v);
	}
	let mut v = value.to_owned();
	if lower.contains("gradient") && !lower.contains("var(") && !lower.contains("env(") {
		v = minify_gradients(&v);
	}
	if prop == "display" {
		v = normalize_display(&v);
	}
	if prop.ends_with("transform") {
		v = reduce_transforms(&v);
	}
	if !(prop.starts_with("composes")
		|| prop.starts_with("font")
		|| prop == "src"
		|| prop.starts_with("filter")
		|| prop.starts_with("-webkit-tap-highlight-color"))
	{
		v = minify_colors(&prop, &v);
	}
	if is_animation_or_transition(&prop) {
		v = normalize_timing_functions(&v);
	}
	v = fold_calc(&v);
	v = convert_values(&prop, &v, ctx);
	v = ordered_values(&prop, &v);
	if v.contains(['\'', '"']) {
		let mut nodes = parse(&v);
		normalize_strings_in(&mut nodes);
		v = stringify(&nodes);
	}
	if prop == "unicode-range" {
		v = normalize_unicode(&v);
	}
	if prop.contains("font") {
		if prop == "font-weight" && !has_variable_function(&v) {
			v = minify_weight(&v);
		} else if prop == "font-family" && !has_variable_function(&v) {
			v = minify_font_family(&v);
		} else if prop == "font" {
			v = minify_font(&v);
		}
	}
	if prop != "src" && lower.contains("url(") {
		v = normalize_urls(&v);
	}
	if is_repeat_property(&prop) {
		v = normalize_repeat_style(&v);
	}
	if is_position_property(&prop) {
		v = normalize_positions(&v);
	}
	v = normalize_whitespace(&v);
	if is_box_shorthand(&prop) {
		v = reduce_box_values(&v);
	}
	shorten_nothing(&prop, v)
}

/// `border: none` and `outline: none` are `0` (no style, or no width: no
/// line), and `background: none` and `background: transparent` are `0 0` (the
/// initial value of everything but the position, which is `0 0`).
fn shorten_nothing(prop: &str, value: String) -> String {
	let nothing = value.eq_ignore_ascii_case("none");
	match strip_vendor(prop) {
		"border" | "border-top" | "border-right" | "border-bottom" | "border-left" | "outline"
			if nothing =>
		{
			"0".to_owned()
		}
		"background" if nothing || value.eq_ignore_ascii_case("transparent") => "0 0".to_owned(),
		_ => value,
	}
}

/// Whether `prop` (lower case) is a property or descriptor whose values are
/// rewritten: one of the generated table, with a vendor prefix or an IE hack
/// character (`*zoom`, `_height`) allowed in front.
///
/// # Example
///
/// ```
/// use kd_css::values::is_known_property;
///
/// assert!(is_known_property("margin"));
/// assert!(is_known_property("-webkit-box-shadow"));
/// assert!(is_known_property("*zoom"));
/// assert!(!is_known_property("composes"));
/// assert!(!is_known_property("-x-margin"));
/// ```
pub fn is_known_property(prop: &str) -> bool {
	let p = prop.strip_prefix(['*', '_']).unwrap_or(prop);
	let p = [
		"-webkit-", "-moz-", "-ms-", "-o-", "-khtml-", "-apple-", "-epub-",
	]
	.iter()
	.find_map(|v| p.strip_prefix(v))
	.unwrap_or(p);
	KNOWN_PROPERTIES.binary_search(&p).is_ok()
}

fn has_variable_function(value: &str) -> bool {
	let l = value.to_ascii_lowercase();
	l.contains("var(") || l.contains("env(")
}

fn strip_vendor(prop: &str) -> &str {
	if let Some(rest) = prop.strip_prefix('-')
		&& let Some((vendor, tail)) = rest.split_once('-')
		&& !vendor.is_empty()
		&& vendor
			.bytes()
			.all(|c| c.is_ascii_alphanumeric() || c == b'_')
	{
		return tail;
	}
	prop
}

fn is_animation_or_transition(prop: &str) -> bool {
	matches!(
		strip_vendor(prop),
		"animation" | "transition" | "animation-timing-function" | "transition-timing-function"
	)
}

fn is_repeat_property(prop: &str) -> bool {
	prop == "background" || prop == "background-repeat" || strip_vendor(prop) == "mask-repeat"
}

fn is_position_property(prop: &str) -> bool {
	prop == "background"
		|| prop == "background-position"
		|| strip_vendor(prop) == "perspective-origin"
}

fn is_box_shorthand(prop: &str) -> bool {
	matches!(
		prop,
		"margin" | "padding" | "border-width" | "border-style" | "border-color"
	)
}

fn is_variable_function(name: &str) -> bool {
	let l = name.to_ascii_lowercase();
	l == "var" || l == "env" || l == "constant"
}

fn set_text(node: &mut ValueNode, s: &str) {
	match node {
		ValueNode::Word(w) | ValueNode::Space(w) | ValueNode::UnicodeRange(w) => *w = s.to_owned(),
		ValueNode::Function { name, .. } => *name = s.to_owned(),
		ValueNode::Str { value, .. } => *value = s.to_owned(),
		ValueNode::Div { .. } | ValueNode::Comment { .. } => {}
	}
}

fn text_of(node: &ValueNode) -> String {
	node.value()
}

// ---------------------------------------------------------------------------
// colormin

fn is_math_function(node: &ValueNode) -> bool {
	matches!(node, ValueNode::Function { name, .. }
		if matches!(name.to_ascii_lowercase().as_str(), "calc" | "min" | "max" | "clamp"))
}

/// Whether a word is a colour name that is also an identifier somewhere
/// (`animation-name: tan`), where the name must not be replaced by its hex.
fn names_are_identifiers(prop: &str) -> bool {
	let p = strip_vendor(prop);
	p.starts_with("animation")
		|| p.starts_with("grid")
		|| p.starts_with("counter")
		|| p.starts_with("transition")
		|| p.starts_with("will-change")
		|| p.starts_with("view-transition")
		|| p.starts_with("anchor")
		|| p.starts_with("container")
		|| p.starts_with("list-style")
		|| p == "content"
		|| p == "quotes"
		|| p.starts_with("scroll-timeline")
		|| p.starts_with("view-timeline")
		|| p.starts_with("timeline-scope")
		|| p.starts_with("position-")
		|| p.starts_with("mask")
		|| p.starts_with("offset")
}

/// postcss-colormin on a value: the colours in it get their shortest
/// spelling. `prop` is the lower-case property (colour names are left alone in
/// properties that hold names, like `animation-name`).
///
/// # Example
///
/// ```
/// use kd_css::values::minify_colors;
///
/// assert_eq!(minify_colors("border", "1px solid #FF0000"), "1px solid red");
/// assert_eq!(minify_colors("animation-name", "tan"), "tan");
/// ```
pub fn minify_colors(prop: &str, value: &str) -> String {
	let keep_names = names_are_identifiers(prop);
	if !may_have_color(value, keep_names) {
		return value.to_owned();
	}
	let mut nodes = parse(value);
	minify_colors_in(&mut nodes, keep_names);
	stringify(&nodes)
}

/// A cheap look at a value before it is parsed: a `#`, an `rgb(` or `hsl(`,
/// or a word that is a colour name.
fn may_have_color(value: &str, keep_names: bool) -> bool {
	let b = value.as_bytes();
	if b.contains(&b'#') {
		return true;
	}
	let mut i = 0;
	while i < b.len() {
		if !b[i].is_ascii_alphabetic() {
			i += 1;
			continue;
		}
		let start = i;
		while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'-' || b[i] == b'_') {
			i += 1;
		}
		let word = &value[start..i];
		if b.get(i) == Some(&b'(')
			&& word.len() >= 3
			&& (word[..3].eq_ignore_ascii_case("rgb") || word[..3].eq_ignore_ascii_case("hsl"))
		{
			return true;
		}
		if !keep_names && crate::color::is_color_name(word) {
			return true;
		}
	}
	false
}

fn minify_colors_in(nodes: &mut Vec<ValueNode>, keep_names: bool) {
	let mut i = 0;
	while i < nodes.len() {
		// 0: leave, 1: a colour function, 2: another function, 3: a word.
		let kind = match &nodes[i] {
			ValueNode::Function { name, .. } => {
				let l = name.to_ascii_lowercase();
				if matches!(l.as_str(), "rgb" | "rgba" | "hsl" | "hsla") {
					1
				} else if matches!(l.as_str(), "calc" | "min" | "max" | "clamp") {
					0
				} else {
					2
				}
			}
			ValueNode::Word(_) => 3,
			_ => 0,
		};
		match kind {
			1 => {
				let text = stringify(&nodes[i..=i]);
				nodes[i] = ValueNode::Word(minify_color(&text));
				// colormin separates the result from a following token.
				if nodes
					.get(i + 1)
					.is_some_and(|n| matches!(n, ValueNode::Word(_) | ValueNode::Function { .. }))
				{
					nodes.insert(i + 1, ValueNode::new_space());
					i += 1;
				}
			}
			2 => {
				if let ValueNode::Function { nodes: inner, .. } = &mut nodes[i] {
					minify_colors_in(inner, keep_names);
				}
			}
			3 => {
				if let ValueNode::Word(w) = &mut nodes[i] {
					let first = w.as_bytes().first().copied().unwrap_or(0);
					if first == b'#' || (first.is_ascii_alphabetic() && !keep_names) {
						let m = minify_color(w);
						*w = m;
					}
				}
			}
			_ => {}
		}
		i += 1;
	}
}

// ---------------------------------------------------------------------------
// display

fn normalize_display(value: &str) -> String {
	let nodes = parse(value);
	if nodes.len() == 1 {
		return value.to_owned();
	}
	let values: Vec<String> = nodes
		.iter()
		.enumerate()
		.filter(|(i, _)| i % 2 == 0)
		.filter_map(|(_, n)| n.word().map(str::to_ascii_lowercase))
		.collect();
	if values.is_empty() {
		return value.to_owned();
	}
	let key = values.join(",");
	let matched = match key.as_str() {
		"block,flow" => "block",
		"block,flow-root" => "flow-root",
		"inline,flow" => "inline",
		"inline,flow-root" => "inline-block",
		"run-in,flow" => "run-in",
		"list-item,block,flow" => "list-item",
		"inline,flow,list-item" => "inline list-item",
		"block,flex" => "flex",
		"inline,flex" => "inline-flex",
		"block,grid" => "grid",
		"inline,grid" => "inline-grid",
		"inline,ruby" => "ruby",
		"block,table" => "table",
		"inline,table" => "inline-table",
		"table-cell,flow" => "table-cell",
		"table-caption,flow" => "table-caption",
		"ruby-base,flow" => "ruby-base",
		"ruby-text,flow" => "ruby-text",
		_ => return value.to_owned(),
	};
	matched.to_owned()
}

// ---------------------------------------------------------------------------
// timing functions

fn parse_float(text: &str) -> f64 {
	match unit(text) {
		Some((n, _)) => n.trim_start_matches('+').parse().unwrap_or(f64::NAN),
		None => f64::NAN,
	}
}

fn normalize_timing_functions(value: &str) -> String {
	let lower = value.to_ascii_lowercase();
	if !lower.contains("steps") && !lower.contains("cubic-bezier") {
		return value.to_owned();
	}
	let mut nodes = parse(value);
	reduce_timing(&mut nodes);
	stringify(&nodes)
}

fn reduce_timing(nodes: &mut [ValueNode]) {
	for n in nodes.iter_mut() {
		let ValueNode::Function {
			name, nodes: inner, ..
		} = n
		else {
			continue;
		};
		let lower = name.to_ascii_lowercase();
		if lower == "steps" {
			let count = inner.first().cloned();
			let position = inner.get(2).cloned();
			let is_single = matches!(&count, Some(ValueNode::Word(w)) if parse_float(w) == 1.0 && unit(w).is_some_and(|(_, u)| u.is_empty()));
			let pos_is = |a: &str, b: &str| matches!(&position, Some(ValueNode::Word(w)) if w.eq_ignore_ascii_case(a) || w.eq_ignore_ascii_case(b));
			if is_single && pos_is("start", "jump-start") {
				*n = ValueNode::Word("step-start".to_owned());
			} else if is_single && pos_is("end", "jump-end") {
				*n = ValueNode::Word("step-end".to_owned());
			} else if pos_is("end", "jump-end")
				&& let Some(c) = count
			{
				*inner = vec![c];
			} else {
				reduce_timing(inner);
			}
		} else if lower == "cubic-bezier" {
			let values: Vec<f64> = inner
				.iter()
				.enumerate()
				.filter(|(i, _)| i % 2 == 0)
				.map(|(_, n)| match n {
					ValueNode::Word(w) if unit(w).is_some_and(|(_, u)| u.is_empty()) => {
						parse_float(w)
					}
					_ => f64::NAN,
				})
				.collect();
			let keyword = if values.len() == 4 {
				match (values[0], values[1], values[2], values[3]) {
					(a, b, c, d) if a == 0.25 && b == 0.1 && c == 0.25 && d == 1.0 => Some("ease"),
					(a, b, c, d) if a == 0.0 && b == 0.0 && c == 1.0 && d == 1.0 => Some("linear"),
					(a, b, c, d) if a == 0.42 && b == 0.0 && c == 1.0 && d == 1.0 => {
						Some("ease-in")
					}
					(a, b, c, d) if a == 0.0 && b == 0.0 && c == 0.58 && d == 1.0 => {
						Some("ease-out")
					}
					(a, b, c, d) if a == 0.42 && b == 0.0 && c == 0.58 && d == 1.0 => {
						Some("ease-in-out")
					}
					_ => None,
				}
			} else {
				None
			};
			match keyword {
				Some(k) => *n = ValueNode::Word(k.to_owned()),
				None => reduce_timing(inner),
			}
		} else {
			reduce_timing(inner);
		}
	}
}

// ---------------------------------------------------------------------------
// transforms

fn transform_values(nodes: &[ValueNode]) -> Vec<Option<f64>> {
	// None stands for "not a number" (a variable or a keyword). Variables
	// are compared by text in cssnano; here they never compare equal to a
	// number, and two variables are never merged either (`scale(var(--a),
	// var(--a))` stays).
	nodes
		.iter()
		.enumerate()
		.filter(|(i, _)| i % 2 == 0)
		.map(|(_, n)| match n {
			ValueNode::Word(w) => {
				let f = parse_float(w);
				if f.is_nan() { None } else { Some(f) }
			}
			_ => None,
		})
		.collect()
}

fn reduce_transforms(value: &str) -> String {
	let mut nodes = parse(value);
	for n in nodes.iter_mut() {
		let ValueNode::Function {
			name, nodes: inner, ..
		} = n
		else {
			continue;
		};
		let lower = name.to_ascii_lowercase();
		let values = transform_values(inner);
		let is = |i: usize, x: f64| values.get(i).copied().flatten() == Some(x);
		match lower.as_str() {
			"matrix3d" if values.len() == 16 => {
				if is(15, 1.0)
					&& is(2, 0.0) && is(3, 0.0)
					&& is(6, 0.0) && is(7, 0.0)
					&& is(8, 0.0) && is(9, 0.0)
					&& is(10, 1.0) && is(11, 0.0)
					&& is(14, 0.0) && inner.len() > 26
				{
					let pick: Vec<ValueNode> = [0, 1, 2, 3, 8, 9, 10, 11, 24, 25, 26]
						.iter()
						.map(|&i| inner[i].clone())
						.collect();
					*name = "matrix".to_owned();
					*inner = pick;
				}
			}
			"rotate3d" if values.len() == 4 && inner.len() > 6 => {
				let which = if is(0, 1.0) && is(1, 0.0) && is(2, 0.0) {
					Some("rotateX")
				} else if is(0, 0.0) && is(1, 1.0) && is(2, 0.0) {
					Some("rotateY")
				} else if is(0, 0.0) && is(1, 0.0) && is(2, 1.0) {
					Some("rotate")
				} else {
					None
				};
				if let Some(w) = which {
					*name = w.to_owned();
					let angle = inner[6].clone();
					*inner = vec![angle];
				}
			}
			"rotatez" if values.len() == 1 => *name = "rotate".to_owned(),
			"scale" if values.len() == 2 && inner.len() > 2 => {
				let (a, b) = (values[0], values[1]);
				if a.is_some() && a == b {
					inner.truncate(1);
				} else if is(1, 1.0) {
					*name = "scaleX".to_owned();
					inner.truncate(1);
				} else if is(0, 1.0) {
					*name = "scaleY".to_owned();
					let second = inner[2].clone();
					*inner = vec![second];
				}
			}
			"scale3d" if values.len() == 3 && inner.len() > 4 => {
				if is(1, 1.0) && is(2, 1.0) {
					*name = "scaleX".to_owned();
					inner.truncate(1);
				} else if is(0, 1.0) && is(2, 1.0) {
					*name = "scaleY".to_owned();
					let second = inner[2].clone();
					*inner = vec![second];
				} else if is(0, 1.0) && is(1, 1.0) {
					*name = "scaleZ".to_owned();
					let third = inner[4].clone();
					*inner = vec![third];
				}
			}
			"translate" if values.len() == 2 && inner.len() > 2 => {
				if is(1, 0.0) {
					inner.truncate(1);
				} else if is(0, 0.0) {
					*name = "translateY".to_owned();
					let second = inner[2].clone();
					*inner = vec![second];
				}
			}
			"translate3d" if values.len() == 3 && inner.len() > 4 && is(0, 0.0) && is(1, 0.0) => {
				*name = "translateZ".to_owned();
				let third = inner[4].clone();
				*inner = vec![third];
			}
			_ => {}
		}
	}
	stringify(&nodes)
}

// ---------------------------------------------------------------------------
// unicode-range

fn normalize_unicode(value: &str) -> String {
	let mut nodes = parse(value);
	for n in nodes.iter_mut() {
		if let ValueNode::UnicodeRange(r) = n {
			let lower = r.to_ascii_lowercase();
			*r = unicode_range(&lower);
		}
	}
	stringify(&nodes)
}

fn unicode_range(range: &str) -> String {
	let body = &range[2..];
	let mut parts = body.split('-');
	let (Some(left), Some(right)) = (parts.next(), parts.next()) else {
		return range.to_owned();
	};
	let left: Vec<char> = left.chars().collect();
	let right: Vec<char> = right.chars().collect();
	if left.len() != right.len() {
		return range.to_owned();
	}
	let mut group = String::from("u+");
	let mut questions = 0;
	for (l, r) in left.iter().zip(right.iter()) {
		if l == r && questions == 0 {
			group.push(*l);
		} else if *l == '0' && *r == 'f' {
			questions += 1;
			group.push('?');
		} else {
			return range.to_owned();
		}
	}
	if questions < 6 {
		group
	} else {
		range.to_owned()
	}
}

// ---------------------------------------------------------------------------
// background positions and repeat styles

fn is_comma(n: &ValueNode) -> bool {
	n.is_div(',')
}

#[derive(Clone, Copy, Default)]
struct Range {
	start: Option<usize>,
	end: Option<usize>,
}

fn collect_ranges(nodes: &[ValueNode], is_keyword: &dyn Fn(&ValueNode) -> bool) -> Vec<Range> {
	let mut ranges: Vec<Option<Range>> = Vec::new();
	let mut range_index = 0;
	let mut should_continue = true;
	for (index, node) in nodes.iter().enumerate() {
		if is_comma(node) {
			range_index += 1;
			should_continue = true;
			continue;
		}
		if !should_continue {
			continue;
		}
		if node.is_div('/') {
			should_continue = false;
			continue;
		}
		while ranges.len() <= range_index {
			ranges.push(None);
		}
		let range = ranges[range_index].get_or_insert_with(Range::default);
		if let ValueNode::Function { name, .. } = node
			&& is_variable_function(name)
		{
			should_continue = false;
			range.start = None;
			range.end = None;
			continue;
		}
		let keyword = is_keyword(node);
		if range.start.is_none() && keyword {
			range.start = Some(index);
			range.end = Some(index);
			continue;
		}
		if range.start.is_some() && !node.is_space() && keyword {
			range.end = Some(index);
		}
	}
	ranges.into_iter().flatten().collect()
}

fn normalize_repeat_style(value: &str) -> String {
	let mut nodes = parse(value);
	if nodes.len() == 1 {
		return value.to_owned();
	}
	let keyword = |n: &ValueNode| {
		n.word().is_some_and(|w| {
			matches!(
				w.to_ascii_lowercase().as_str(),
				"repeat-x" | "repeat-y" | "repeat" | "space" | "round" | "no-repeat"
			)
		})
	};
	let ranges = collect_ranges(&nodes, &keyword);
	for r in ranges {
		let (Some(start), Some(end)) = (r.start, r.end) else {
			continue;
		};
		if end - start + 1 != 3 {
			continue;
		}
		let a = text_of(&nodes[start]).to_ascii_lowercase();
		let b = text_of(&nodes[start + 2]).to_ascii_lowercase();
		let matched = match (a.as_str(), b.as_str()) {
			("repeat", "no-repeat") => Some("repeat-x"),
			("no-repeat", "repeat") => Some("repeat-y"),
			("repeat", "repeat") => Some("repeat"),
			("space", "space") => Some("space"),
			("round", "round") => Some("round"),
			("no-repeat", "no-repeat") => Some("no-repeat"),
			_ => None,
		};
		if let Some(m) = matched {
			set_text(&mut nodes[start], m);
			set_text(&mut nodes[start + 1], "");
			set_text(&mut nodes[start + 2], "");
		}
	}
	stringify(&nodes)
}

fn normalize_positions(value: &str) -> String {
	let mut nodes = parse(value);
	let keyword = |n: &ValueNode| {
		let direction = n.word().is_some_and(|w| {
			matches!(
				w.to_ascii_lowercase().as_str(),
				"top" | "right" | "bottom" | "left" | "center"
			)
		});
		let dimension = n
			.word()
			.is_some_and(|w| unit(w).is_some_and(|(_, u)| !u.is_empty()));
		let number = n.word().is_some_and(|w| unit(w).is_some());
		direction || dimension || number || is_math_function(n)
	};
	let ranges = collect_ranges(&nodes, &keyword);
	for r in ranges {
		let (Some(start), Some(end)) = (r.start, r.end) else {
			continue;
		};
		let len = end - start + 1;
		if len > 3 {
			continue;
		}
		let first = text_of(&nodes[start]).to_ascii_lowercase();
		let second = if len > 2 {
			let v = text_of(&nodes[start + 2]);
			if v.is_empty() {
				None
			} else {
				Some(v.to_ascii_lowercase())
			}
		} else {
			None
		};
		let horizontal = |s: &str| match s {
			"right" => Some("100%"),
			"left" => Some("0"),
			_ => None,
		};
		let vertical = |s: &str| match s {
			"bottom" => Some("100%"),
			"top" => Some("0"),
			_ => None,
		};
		if len == 1 || second.as_deref() == Some("center") {
			if second.is_some() {
				set_text(&mut nodes[start + 2], "");
				set_text(&mut nodes[start + 1], "");
			}
			let mapped = if first == "center" {
				Some("50%")
			} else {
				horizontal(&first)
			};
			if let Some(m) = mapped {
				set_text(&mut nodes[start], m);
			}
			continue;
		}
		let Some(second) = second else {
			continue;
		};
		let is_dir = |s: &str| matches!(s, "top" | "right" | "bottom" | "left" | "center");
		if first == "center" && is_dir(&second) {
			set_text(&mut nodes[start], "");
			set_text(&mut nodes[start + 1], "");
			if let Some(h) = horizontal(&second) {
				set_text(&mut nodes[start + 2], h);
			}
			continue;
		}
		if let (Some(h), Some(v)) = (horizontal(&first), vertical(&second)) {
			set_text(&mut nodes[start], h);
			set_text(&mut nodes[start + 2], v);
		} else if let (Some(v), Some(h)) = (vertical(&first), horizontal(&second)) {
			set_text(&mut nodes[start], h);
			set_text(&mut nodes[start + 2], v);
		}
	}
	stringify(&nodes)
}

// ---------------------------------------------------------------------------
// gradients

fn parse_unit(text: &str) -> Option<(f64, String)> {
	let (n, u) = unit(text)?;
	let v: f64 = n.trim_start_matches('+').parse().ok()?;
	Some((v, u.to_owned()))
}

fn is_valid_color(word: &str) -> bool {
	word == "transparent" || crate::color::is_color(word)
}

/// The argument boundaries of a function's nodes: ranges between dividers.
fn argument_ranges(nodes: &[ValueNode]) -> Vec<(usize, usize)> {
	let mut out = Vec::new();
	let mut start = 0;
	for (i, n) in nodes.iter().enumerate() {
		if matches!(n, ValueNode::Div { .. }) {
			out.push((start, i));
			start = i + 1;
		}
	}
	out.push((start, nodes.len()));
	out
}

fn is_color_stop_argument(nodes: &[ValueNode], (start, end): (usize, usize)) -> bool {
	if start >= end {
		return false;
	}
	match &nodes[start] {
		ValueNode::Function { name, .. } => !matches!(
			name.to_ascii_lowercase().as_str(),
			"calc" | "clamp" | "max" | "min"
		),
		ValueNode::Word(w) => is_valid_color(w),
		_ => false,
	}
}

fn position_indexes(
	nodes: &[ValueNode],
	(start, end): (usize, usize),
	color_stop: bool,
) -> Vec<usize> {
	let from = if color_stop { start + 1 } else { start };
	(from..end.max(from))
		.filter(|&i| !matches!(nodes[i], ValueNode::Space(_) | ValueNode::Comment { .. }))
		.collect()
}

fn is_less_than_or_equal(a: &(f64, String), b: &(f64, String)) -> Option<bool> {
	if a.1.eq_ignore_ascii_case(&b.1) {
		return Some(a.0 >= b.0);
	}
	if a.0 == 0.0 {
		return Some(b.0 <= 0.0);
	}
	if b.0 == 0.0 {
		return Some(a.0 >= 0.0);
	}
	None
}

fn optimize_color_stops(nodes: &mut [ValueNode]) {
	let args = argument_ranges(nodes);
	let Some(first_stop) = args.iter().position(|&a| is_color_stop_argument(nodes, a)) else {
		return;
	};
	struct Stop {
		range: (usize, usize),
		positions: Vec<usize>,
	}
	let mut stops: Vec<Stop> = Vec::new();
	let mut largest: Option<(f64, String)> = None;
	let mut has_seen_stop = false;
	for &arg in &args[first_stop..] {
		let color_stop = is_color_stop_argument(nodes, arg);
		let positions = position_indexes(nodes, arg, color_stop);
		if color_stop {
			stops.push(Stop {
				range: arg,
				positions: positions.clone(),
			});
			if !has_seen_stop && positions.is_empty() {
				largest = Some((0.0, "%".to_owned()));
			}
			has_seen_stop = true;
		}
		for &p in &positions {
			let current = match &nodes[p] {
				ValueNode::Word(w) => parse_unit(w),
				_ => None,
			};
			largest = match current {
				None => None,
				Some(cur) => match &largest {
					None => Some(cur),
					Some(l) => match is_less_than_or_equal(l, &cur) {
						Some(true) => {
							set_text(&mut nodes[p], "0");
							Some(l.clone())
						}
						Some(false) => Some(cur),
						None => None,
					},
				},
			};
		}
	}
	if let Some(first) = stops.first()
		&& first.positions.len() == 1
		&& first.range.1 - first.range.0 == 3
		&& text_of(&nodes[first.positions[0]]) == "0%"
	{
		set_text(&mut nodes[first.range.0 + 1], "");
		set_text(&mut nodes[first.positions[0]], "");
	}
	if let Some(last) = stops.last()
		&& last.positions.len() == 1
		&& last.range.1 - last.range.0 == 3
		&& text_of(&nodes[last.positions[0]]) == "100%"
	{
		set_text(&mut nodes[last.range.0 + 1], "");
		set_text(&mut nodes[last.positions[0]], "");
	}
}

fn minify_gradients(value: &str) -> String {
	let mut nodes = parse(value);
	walk(&mut nodes, &mut |n| {
		let ValueNode::Function {
			name, nodes: inner, ..
		} = n
		else {
			return true;
		};
		if inner.is_empty() {
			return false;
		}
		let lower = name.to_ascii_lowercase();
		match lower.as_str() {
			"linear-gradient"
			| "repeating-linear-gradient"
			| "-webkit-linear-gradient"
			| "-webkit-repeating-linear-gradient" => {
				let first_is_to = inner[0]
					.word()
					.is_some_and(|w| w.eq_ignore_ascii_case("to"));
				let args = argument_ranges(inner);
				if first_is_to && args[0].1 - args[0].0 == 3 {
					let angle = match inner[2].word().map(str::to_ascii_lowercase).as_deref() {
						Some("top") => Some("0deg"),
						Some("right") => Some("90deg"),
						Some("bottom") => Some("180deg"),
						Some("left") => Some("270deg"),
						_ => None,
					};
					if let Some(a) = angle {
						inner.drain(0..2);
						set_text(&mut inner[0], a);
					}
				}
				optimize_color_stops(inner);
			}
			"radial-gradient"
			| "repeating-radial-gradient"
			| "conic-gradient"
			| "repeating-conic-gradient" => optimize_color_stops(inner),
			_ => return true,
		}
		false
	});
	stringify(&nodes)
}

// ---------------------------------------------------------------------------
// white space

/// Removes the white space around an IE `\9` hack (outside strings).
fn strip_ie_hack_space(value: &str) -> String {
	let b = value.as_bytes();
	let mut i = 0;
	while i < b.len() {
		match b[i] {
			b'"' | b'\'' => {
				let q = b[i];
				i += 1;
				while i < b.len() && b[i] != q {
					if b[i] == b'\\' {
						i += 1;
					}
					i += 1;
				}
			}
			b'\\' if b.get(i + 1) == Some(&b'9') => {
				let mut s = i;
				while s > 0 && b[s - 1].is_ascii_whitespace() {
					s -= 1;
				}
				let mut e = i + 2;
				while e < b.len() && b[e].is_ascii_whitespace() {
					e += 1;
				}
				if s == i && e == i + 2 {
					return value.to_owned();
				}
				return format!("{}\\9{}", &value[..s], &value[e..]);
			}
			b'\\' => i += 1,
			_ => {}
		}
		i += 1;
	}
	value.to_owned()
}

fn reduce_whitespace(nodes: &mut [ValueNode]) {
	for n in nodes.iter_mut() {
		match n {
			ValueNode::Space(s) => *s = " ".to_owned(),
			ValueNode::Div { before, after, .. } => {
				before.clear();
				after.clear();
			}
			ValueNode::Function {
				name,
				before,
				after,
				nodes: inner,
				..
			} => {
				if !is_variable_function(name) {
					before.clear();
					after.clear();
				}
				if name.eq_ignore_ascii_case("calc") {
					reduce_calc_whitespace(inner, true);
				} else {
					reduce_whitespace(inner);
				}
			}
			_ => {}
		}
	}
}

fn reduce_calc_whitespace(nodes: &mut Vec<ValueNode>, strip_operators: bool) {
	for n in nodes.iter_mut() {
		match n {
			ValueNode::Space(s) => *s = " ".to_owned(),
			ValueNode::Div { before, after, .. } => {
				before.clear();
				after.clear();
			}
			ValueNode::Function {
				name,
				before,
				after,
				nodes: inner,
				..
			} => {
				let variable = is_variable_function(name);
				if !variable {
					before.clear();
					after.clear();
				}
				reduce_calc_whitespace(inner, strip_operators && !variable);
			}
			_ => {}
		}
	}
	// `*` and `/` need no white space around them in a calc(); `+` and `-` do.
	if strip_operators {
		let is_op = |n: &ValueNode| matches!(n, ValueNode::Word(w) if w == "*" || w == "/");
		let mut i = 0;
		while i < nodes.len() {
			let around = (i > 0 && is_op(&nodes[i - 1])) || nodes.get(i + 1).is_some_and(is_op);
			if nodes[i].is_space() && around {
				nodes.remove(i);
			} else {
				i += 1;
			}
		}
	}
}

/// postcss-normalize-whitespace on a declaration value: runs of white space
/// become one space, and the space around `,`, `/` and inside parentheses
/// goes (not inside `calc()` around operators, and not inside `var()`).
///
/// # Example
///
/// ```
/// use kd_css::values::normalize_whitespace;
///
/// assert_eq!(normalize_whitespace("rgb( 0 , 0 , 0 )  1px  /  2px"), "rgb(0,0,0) 1px/2px");
/// assert_eq!(normalize_whitespace("calc( 1px  +  2px )"), "calc(1px + 2px)");
/// ```
pub fn normalize_whitespace(value: &str) -> String {
	if !value.contains(|c: char| c.is_ascii_whitespace()) && !value.contains(',') {
		return value.to_owned();
	}
	let v = if value.contains("\\9") {
		strip_ie_hack_space(value)
	} else {
		value.to_owned()
	};
	let mut nodes = parse(&v);
	reduce_whitespace(&mut nodes);
	stringify(&nodes)
}

// ---------------------------------------------------------------------------
// box shorthands

/// `a b a b` -> `a b`, `a b c b` -> `a b c`, `a a a a` -> `a`, the way
/// postcss-merge-longhand shortens `margin`, `padding` and the border
/// width, style and colour shorthands.
fn reduce_box_values(value: &str) -> String {
	let nodes = parse(value);
	let mut items: Vec<String> = Vec::new();
	let mut expect_space = false;
	for n in &nodes {
		match n {
			ValueNode::Space(_) if expect_space => expect_space = false,
			ValueNode::Word(_) | ValueNode::Function { .. } if !expect_space => {
				items.push(stringify(std::slice::from_ref(n)));
				expect_space = true;
			}
			_ => return value.to_owned(),
		}
	}
	let (t, r, b, l) = match items.len() {
		2 => (&items[0], &items[1], &items[0], &items[1]),
		3 => (&items[0], &items[1], &items[2], &items[1]),
		4 => (&items[0], &items[1], &items[2], &items[3]),
		_ => return value.to_owned(),
	};
	let mut out: Vec<&String> = vec![t, r, b, l];
	if l == r {
		out.pop();
		if b == t {
			out.pop();
			if r == t {
				out.pop();
			}
		}
	}
	out.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" ")
}
