//! Number and unit rules: postcss-convert-values.
//!
//! `0px` becomes `0`, `0.50` becomes `.5`, `1000ms` becomes `1s`, `360deg`
//! becomes `1turn`, `opacity` is clamped to 0..1. Lengths are not converted
//! between units (`1in` stays), as cssnano is configured not to.
//!
//! Deliberate differences from cssnano, each for a result that never differs
//! from the input's meaning:
//! - `0%` becomes `0` only in properties where the two are the same thing
//!   (see [`percent_may_drop`]); `height: 0%` is not `height: 0` when the
//!   containing block's height is not known.
//! - Words inside `var()` and `env()` are left alone: a fallback `0px` may
//!   end up inside a `calc()` where a bare `0` is invalid.
//! - `0%` stays in `rgb()`, `lab()`, `oklch()` and the other colour functions.

use crate::value::{ValueNode, parse, stringify, unit, walk};

const LENGTH_UNITS: [&str; 15] = [
	"em", "ex", "ch", "rem", "vw", "vh", "vmin", "vmax", "cm", "mm", "q", "in", "pt", "pc", "px",
];

const NOT_A_LENGTH: [&str; 5] = [
	"descent-override",
	"ascent-override",
	"font-stretch",
	"size-adjust",
	"line-gap-override",
];

/// Functions whose arguments keep `0px` and `0%`.
const KEEP_ZERO_FUNCTIONS: [&str; 15] = [
	"calc",
	"color-mix",
	"min",
	"max",
	"clamp",
	"hsl",
	"hsla",
	"hwb",
	"linear",
	"rgb",
	"rgba",
	"lab",
	"lch",
	"oklab",
	"oklch",
];

/// Functions in which a zero percentage is the same as a zero length.
const SHAPE_FUNCTIONS: [&str; 5] = ["polygon", "inset", "circle", "ellipse", "translate"];

/// What the minifier knows about where a declaration sits.
///
/// # Example
///
/// ```
/// use kd_css::numeric::{convert_values, DeclContext};
///
/// let in_keyframes = DeclContext { in_keyframes: true, ..DeclContext::default() };
/// // `0%` stays in a `stroke-dasharray` of a keyframe.
/// assert_eq!(convert_values("stroke-dasharray", "0% 0px", &in_keyframes), "0% 0px");
/// ```
#[derive(Debug, Clone, Copy, Default)]
pub struct DeclContext {
	/// The declaration is in a keyframe block.
	pub in_keyframes: bool,
	/// The declaration is an `initial-value` in an `@property` whose syntax
	/// is a percentage or a length-percentage.
	pub percent_syntax: bool,
}

/// `String(number)` of JavaScript, for the range where it is plain decimal;
/// `None` outside it (exponent notation).
///
/// # Example
///
/// ```
/// use kd_css::numeric::js_number;
///
/// assert_eq!(js_number(0.5).as_deref(), Some("0.5"));
/// assert_eq!(js_number(-0.0).as_deref(), Some("0"));
/// assert_eq!(js_number(1e21), None);
/// ```
pub fn js_number(n: f64) -> Option<String> {
	if !n.is_finite() {
		return None;
	}
	if n == 0.0 {
		return Some("0".to_owned());
	}
	let a = n.abs();
	if !(1e-6..1e21).contains(&a) {
		return None;
	}
	Some(format!("{n}"))
}

/// cssnano's `dropLeadingZero`: `0.5` -> `.5`, `-0.5` -> `-.5`.
fn drop_leading_zero(n: f64) -> Option<String> {
	let s = js_number(n)?;
	if n % 1.0 != 0.0 {
		if let Some(rest) = s.strip_prefix("0.") {
			return Some(format!(".{rest}"));
		}
		if let Some(rest) = s.strip_prefix("-0.") {
			return Some(format!("-.{rest}"));
		}
	}
	Some(s)
}

fn convert_unit(number: f64, original: &str, conversions: &[(&str, f64)]) -> Option<String> {
	let factor = conversions.iter().find(|(u, _)| *u == original)?.1;
	let base = number * factor;
	let mut shortest: Option<String> = None;
	for (u, f) in conversions {
		if *u == original {
			continue;
		}
		let value = format!("{}{}", drop_leading_zero(base / f)?, u);
		if shortest.as_ref().is_none_or(|s| value.len() < s.len()) {
			shortest = Some(value);
		}
	}
	shortest
}

/// A number with a unit, as short as the unit conversions allow.
fn convert(number: f64, unit: &str) -> Option<String> {
	let mut value = format!("{}{}", drop_leading_zero(number)?, unit);
	let lower = unit.to_ascii_lowercase();
	let mut converted = None;
	if lower == "s" || lower == "ms" {
		converted = convert_unit(number, &lower, &[("s", 1000.0), ("ms", 1.0)]);
	}
	if lower == "turn" || lower == "deg" {
		converted = convert_unit(number, &lower, &[("turn", 360.0), ("deg", 1.0)]);
	}
	if let Some(c) = converted
		&& c.len() < value.len()
	{
		value = c;
	}
	Some(value)
}

fn parse_number(text: &str) -> Option<f64> {
	let t = text.strip_prefix('+').unwrap_or(text);
	t.parse::<f64>().ok()
}

/// Rewrites one word. `keep_length` keeps units on zero lengths, `keep_percent`
/// keeps `%` on zero.
fn convert_word(word: &mut String, keep_length: bool, keep_percent: bool) {
	let Some((number, unit_text)) = unit(word) else {
		return;
	};
	let u = unit_text.strip_prefix('.').unwrap_or(unit_text);
	let Some(num) = parse_number(number) else {
		return;
	};
	if num == 0.0 {
		let lower = u.to_ascii_lowercase();
		let drop =
			(LENGTH_UNITS.contains(&lower.as_str()) && !keep_length) || (u == "%" && !keep_percent);
		let mut value = format!("0{}", if drop { "" } else { u });
		if value == "0ms" {
			value = "0s".to_owned();
		}
		*word = value;
	} else if let Some(v) = convert(num, u) {
		*word = v;
	}
}

fn clamp_opacity(word: &mut String) {
	let Some((number, u)) = unit(word) else {
		return;
	};
	let Some(num) = parse_number(number) else {
		return;
	};
	let u = u.to_owned();
	if num > 1.0 {
		*word = if u == "%" {
			match js_number(num) {
				Some(n) => format!("{n}{u}"),
				None => return,
			}
		} else {
			format!("1{u}")
		};
	} else if num < 0.0 {
		*word = format!("0{u}");
	}
}

/// Properties in which `0%` and `0` mean the same.
///
/// # Example
///
/// ```
/// use kd_css::numeric::percent_may_drop;
///
/// assert!(percent_may_drop("margin-left"));
/// assert!(!percent_may_drop("height"));
/// ```
pub fn percent_may_drop(prop: &str) -> bool {
	let p = prop
		.strip_prefix('-')
		.map_or(prop, |r| r.split_once('-').map_or(r, |(_, x)| x));
	p.starts_with("margin")
		|| p.starts_with("padding")
		|| p.starts_with("background")
		|| p.starts_with("mask")
		|| p.starts_with("border") && p.contains("radius")
		|| p.ends_with("-origin")
		|| p == "object-position"
		|| p.ends_with("transform")
		|| p == "translate"
		|| p == "scale"
		|| p == "opacity"
		|| p == "font-size"
		|| p == "clip-path"
		|| p == "shape-outside"
		|| p.contains("gap")
}

fn keeps_zero_unit(prop: &str, ctx: &DeclContext) -> bool {
	matches!(prop, "stroke-dashoffset" | "stroke-width" | "line-height")
		|| (ctx.in_keyframes && matches!(prop, "border-image-width" | "stroke-dasharray"))
		|| (prop == "initial-value" && ctx.percent_syntax)
}

fn convert_nested(nodes: &mut [ValueNode]) {
	walk(nodes, &mut |n| match n {
		ValueNode::Word(w) => {
			convert_word(w, true, true);
			true
		}
		ValueNode::Function { name, .. } => {
			let l = name.to_ascii_lowercase();
			!(l == "var" || l == "env" || l == "url")
		}
		_ => true,
	});
}

/// Applies the number rules to the value of declaration `prop` (lower case).
///
/// # Example
///
/// ```
/// use kd_css::numeric::{convert_values, DeclContext};
///
/// let ctx = DeclContext::default();
/// assert_eq!(convert_values("margin", "0px 0.50em", &ctx), "0 .5em");
/// assert_eq!(convert_values("transition-duration", "500ms", &ctx), ".5s");
/// assert_eq!(convert_values("flex", "1 1 0%", &ctx), "1 1 0%");
/// ```
pub fn convert_values(prop: &str, value: &str, ctx: &DeclContext) -> String {
	if prop.contains("flex") || prop.starts_with("--") || NOT_A_LENGTH.contains(&prop) {
		return value.to_owned();
	}
	// Nothing to convert without a digit.
	if !value.bytes().any(|b| b.is_ascii_digit()) {
		return value.to_owned();
	}
	let mut nodes = parse(value);
	let keep_length = keeps_zero_unit(prop, ctx);
	let keep_percent = keep_length || !percent_may_drop(prop);
	let opacity = prop == "opacity" || prop == "shape-image-threshold";
	walk(&mut nodes, &mut |n| match n {
		ValueNode::Word(w) => {
			convert_word(w, keep_length, keep_percent);
			if opacity {
				clamp_opacity(w);
			}
			true
		}
		ValueNode::Function { name, nodes, .. } => {
			let l = name.to_ascii_lowercase();
			if KEEP_ZERO_FUNCTIONS.contains(&l.as_str()) {
				convert_nested(nodes);
				return false;
			}
			if l == "url" || l == "var" || l == "env" {
				return false;
			}
			if !keep_percent && SHAPE_FUNCTIONS.contains(&l.as_str()) {
				// Zero percentages in a shape or a translation are zero lengths.
				walk(nodes, &mut |n| {
					if let ValueNode::Word(w) = n {
						convert_word(w, keep_length, false);
					}
					true
				});
				return false;
			}
			true
		}
		_ => true,
	});
	stringify(&nodes)
}
