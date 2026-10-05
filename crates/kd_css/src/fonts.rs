//! Font values: postcss-minify-font-values. `font-weight: normal` is `400`,
//! `bold` is `700`, family names lose their quotes when they can be written
//! as identifiers and shorter, duplicate families go, and the same rules apply
//! to the family list at the end of the `font` shorthand.

use crate::value::{ValueNode, parse, stringify, unit};

fn push_node_text(out: &mut String, n: &ValueNode) {
	crate::value::push_node(out, n);
}

/// `normal` -> `400`, `bold` -> `700`.
pub fn minify_weight(value: &str) -> String {
	let lower = value.to_ascii_lowercase();
	match lower.as_str() {
		"normal" => "400".to_owned(),
		"bold" => "700".to_owned(),
		_ => value.to_owned(),
	}
}

fn is_escape_char(c: char) -> bool {
	matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | ':')
}

fn is_simple_escape(c: char) -> bool {
	matches!(
		c,
		' ' | '!'
			| '"' | '#'
			| '$' | '%'
			| '&' | '\''
			| '(' | ')'
			| '*' | '+'
			| ',' | '.'
			| '/' | ';'
			| '<' | '='
			| '>' | '?'
			| '@' | '['
			| '\\' | ']'
			| '^' | '`'
			| '{' | '|'
			| '}' | '~'
	)
}

/// cssnano's `customEscape`.
fn custom_escape(s: &str, for_string: bool) -> String {
	let mut out = String::new();
	for c in s.chars() {
		if !for_string && is_escape_char(c) {
			out.push('\\');
			out.push_str(&format!("{:x}", c as u32));
			out.push(' ');
		} else if !for_string && is_simple_escape(c) {
			out.push('\\');
			out.push(c);
		} else {
			out.push(c);
		}
	}
	if !for_string {
		let b = out.as_bytes();
		if b.first() == Some(&b'-') && b.get(1).is_some_and(|c| *c == b'-' || c.is_ascii_digit()) {
			out = format!("\\-{}", &out[1..]);
		}
		if let Some(first) = s.chars().next()
			&& first.is_ascii_digit()
		{
			out = format!("\\3{first} {}", &out[1..]);
		}
	}
	out
}

fn is_identifier_character(s: &str) -> bool {
	!s.is_empty()
		&& s.chars()
			.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || (c as u32) >= 0xa0)
}

fn is_invalid_identifier(s: &str) -> bool {
	let b = s.as_bytes();
	(b.first() == Some(&b'-') && b.get(1).is_some_and(u8::is_ascii_digit))
		|| b.first().is_some_and(u8::is_ascii_digit)
		|| s.starts_with("--")
}

/// cssnano's `escapeIdentifierSequence`.
fn escape_identifier_sequence(s: &str) -> String {
	let parts: Vec<&str> = s.split(['\t', '\n', '\u{c}', '\r', ' ']).collect();
	let mut result: Vec<String> = Vec::new();
	for (index, sub) in parts.iter().enumerate() {
		if sub.is_empty() {
			result.push(String::new());
			continue;
		}
		let escaped = custom_escape(sub, false);
		if is_identifier_character(sub) && is_invalid_identifier(sub) && index != 0 {
			// Not the first item: escape the space before it instead.
			if let Some(prev) = result.last_mut() {
				prev.push('\\');
			}
			result.push(custom_escape(sub, true));
		} else {
			result.push(escaped);
		}
	}
	let mut joined = result.join(" ");
	// Runs of two or more spaces: every pair becomes `\ ` (with an optional
	// escape already ending in a space kept).
	joined = collapse_consecutive_spaces(&joined);
	// Trailing spaces that are not part of an escape.
	if joined.ends_with(' ') && !ends_with_hex_escape_space(&joined) {
		joined.pop();
		joined.push_str("\\ ");
	}
	if joined.starts_with(' ') {
		joined = format!("\\ {}", &joined[1..]);
	}
	joined
}

fn ends_with_hex_escape_space(s: &str) -> bool {
	// /\\[a-fA-F0-9]{0,6}\x20$/
	let b = s.as_bytes();
	if b.last() != Some(&b' ') {
		return false;
	}
	let mut i = b.len() - 1;
	let mut n = 0;
	while i > 0 && b[i - 1].is_ascii_hexdigit() && n < 6 {
		i -= 1;
		n += 1;
	}
	i > 0 && b[i - 1] == b'\\'
}

/// `s.replace(/(\\(?:[a-fA-F0-9]{1,6}\x20|\x20))?(\x20{2,})/g, ...)`.
fn collapse_consecutive_spaces(s: &str) -> String {
	let b = s.as_bytes();
	let mut out = String::new();
	let mut i = 0;
	while i < b.len() {
		// Find the next run of two or more spaces, possibly preceded by an
		// escape `\<hex> ` or `\ `.
		if b[i] == b' ' {
			let mut j = i;
			while j < b.len() && b[j] == b' ' {
				j += 1;
			}
			let count = j - i;
			if count >= 2 {
				let escapes = count / 2;
				let mut parts: Vec<String> = vec!["\\ ".to_owned(); escapes];
				if count % 2 == 1 {
					parts[escapes - 1].push_str("\\ ");
				}
				out.push(' ');
				out.push_str(&parts.join(" "));
				i = j;
				continue;
			}
		}
		if b[i] == b'\\' {
			// An escape followed by spaces: group 1 is kept.
			let mut j = i + 1;
			let mut n = 0;
			while j < b.len() && b[j].is_ascii_hexdigit() && n < 6 {
				j += 1;
				n += 1;
			}
			let esc_end = if n > 0 && b.get(j) == Some(&b' ') {
				Some(j + 1)
			} else if n == 0 && b.get(i + 1) == Some(&b' ') {
				Some(i + 2)
			} else {
				None
			};
			if let Some(e) = esc_end {
				let mut k = e;
				while k < b.len() && b[k] == b' ' {
					k += 1;
				}
				if k - e >= 2 {
					let count = k - e;
					let escapes = count / 2;
					let mut parts: Vec<String> = vec!["\\ ".to_owned(); escapes];
					if count % 2 == 1 {
						parts[escapes - 1].push_str("\\ ");
					}
					out.push_str(&s[i..e]);
					out.push(' ');
					out.push_str(&parts.join(" "));
					i = k;
					continue;
				}
			}
		}
		let ch_len = s[i..].chars().next().map_or(1, char::len_utf8);
		out.push_str(&s[i..i + ch_len]);
		i += ch_len;
	}
	out
}

const KEYWORDS: [&str; 9] = [
	"sans-serif",
	"serif",
	"fantasy",
	"cursive",
	"monospace",
	"system-ui",
	"inherit",
	"initial",
	"unset",
];

fn is_keyword(value: &str) -> bool {
	let lower = value.to_ascii_lowercase();
	KEYWORDS.iter().any(|k| lower.contains(k))
}

/// Options of the family minifier.
#[derive(Clone, Copy)]
pub struct FamilyOptions {
	pub remove_quotes: bool,
}

/// cssnano's `minify-family`: the nodes of a family list become one word.
fn minify_family(nodes: &[ValueNode], opts: FamilyOptions) -> Vec<ValueNode> {
	// Families as (kind, text); words are merged across spaces.
	enum Item {
		Str {
			quote: char,
			value: String,
			unclosed: bool,
		},
		Other(String),
		Word(String),
	}
	let mut family: Vec<Item> = Vec::new();
	let mut last: Option<usize> = None;
	for (index, node) in nodes.iter().enumerate() {
		match node {
			ValueNode::Str {
				quote,
				value,
				unclosed,
			} => {
				family.push(Item::Str {
					quote: *quote,
					value: value.clone(),
					unclosed: *unclosed,
				});
			}
			ValueNode::Function { .. } => {
				let mut s = String::new();
				push_node_text(&mut s, node);
				family.push(Item::Other(s));
			}
			ValueNode::Word(w) | ValueNode::UnicodeRange(w) => {
				let idx = match last {
					Some(i) => i,
					None => {
						family.push(Item::Word(String::new()));
						let i = family.len() - 1;
						last = Some(i);
						i
					}
				};
				if let Item::Word(s) = &mut family[idx] {
					s.push_str(w);
				}
			}
			ValueNode::Space(_) => {
				if let Some(i) = last
					&& index != nodes.len() - 1
					&& let Item::Word(s) = &mut family[i]
				{
					s.push(' ');
				}
			}
			_ => last = None,
		}
		// A string or function between words ends the current word run? In
		// postcss-minify-font-values `last` is only reset by other node types.
	}
	let mut normalized: Vec<String> = family
		.into_iter()
		.map(|item| match item {
			Item::Word(s) | Item::Other(s) => s,
			Item::Str {
				quote,
				value,
				unclosed,
			} => {
				let quoted = {
					let mut s = String::new();
					s.push(quote);
					s.push_str(&value);
					if !unclosed {
						s.push(quote);
					}
					s
				};
				let starts_digit = value.chars().next().is_some_and(|c| c.is_ascii_digit());
				if !opts.remove_quotes || is_keyword(&value) || starts_digit {
					return quoted;
				}
				let escaped = escape_identifier_sequence(&value);
				if utf16_len(&escaped) < utf16_len(&value) + 2 {
					escaped
				} else {
					quoted
				}
			}
		})
		.collect();
	// Duplicates (but `monospace` may repeat: `monospace, monospace`).
	let mut seen: Vec<String> = Vec::new();
	normalized.retain(|item| {
		if item.eq_ignore_ascii_case("monospace") {
			return true;
		}
		if seen.contains(item) {
			false
		} else {
			seen.push(item.clone());
			true
		}
	});
	vec![ValueNode::Word(normalized.join(","))]
}

fn utf16_len(s: &str) -> usize {
	s.encode_utf16().count()
}

/// `font-family`.
pub fn minify_font_family(value: &str) -> String {
	let tree = parse(value);
	stringify(&minify_family(
		&tree,
		FamilyOptions {
			remove_quotes: true,
		},
	))
}

const STYLE: [&str; 2] = ["italic", "oblique"];
const WEIGHT: [&str; 12] = [
	"100", "200", "300", "400", "500", "600", "700", "800", "900", "bold", "lighter", "bolder",
];
const STRETCH: [&str; 8] = [
	"ultra-condensed",
	"extra-condensed",
	"condensed",
	"semi-condensed",
	"semi-expanded",
	"expanded",
	"extra-expanded",
	"ultra-expanded",
];
const SIZE: [&str; 9] = [
	"xx-small", "x-small", "small", "medium", "large", "x-large", "xx-large", "larger", "smaller",
];

/// The `font` shorthand: weights are minified and the family list too.
pub fn minify_font(value: &str) -> String {
	let mut nodes = parse(value);
	let mut family_start: Option<usize> = None;
	let mut has_size = false;
	let mut to_splice: Vec<usize> = Vec::new();
	let len = nodes.len();
	for i in 0..len {
		if matches!(nodes[i], ValueNode::Str { .. }) && i > 0 && !nodes[i - 1].is_space() {
			to_splice.push(i);
		}
		let next_is_space = nodes.get(i + 1).is_some_and(ValueNode::is_space);
		match &mut nodes[i] {
			ValueNode::Word(w) => {
				if has_size {
					continue;
				}
				let lower = w.to_ascii_lowercase();
				let boundary = matches!(lower.as_str(), "normal" | "inherit" | "initial" | "unset")
					|| unit(&lower).is_some();
				if boundary || STYLE.contains(&lower.as_str()) || lower == "small-caps" {
					family_start = Some(i);
				} else if WEIGHT.contains(&lower.as_str()) {
					*w = minify_weight(&lower);
					family_start = Some(i);
				} else if STRETCH.contains(&lower.as_str()) {
					family_start = Some(i);
				} else if SIZE.contains(&lower.as_str()) {
					family_start = Some(i);
					has_size = true;
				}
			}
			ValueNode::Function { .. } => {
				if next_is_space {
					family_start = Some(i);
				}
			}
			ValueNode::Div { value: '/', .. } => {
				family_start = Some(i + 1);
				break;
			}
			_ => {}
		}
	}
	// Spaces missing before strings. cssnano inserts them one after the
	// other at the indexes found before any insertion, so every one but the
	// first lands one place too early (and `Arial,"B"` ends up with a space
	// before the comma); from the back, each lands where it belongs.
	for &idx in to_splice.iter().rev() {
		nodes.insert(idx.min(nodes.len()), ValueNode::new_space());
	}
	let opts = FamilyOptions {
		remove_quotes: true,
	};
	match family_start {
		Some(fs) => {
			let start = (fs + 2).min(nodes.len());
			let family = minify_family(&nodes[start..], opts);
			let mut head: Vec<ValueNode> = nodes[..start].to_vec();
			head.extend(family);
			stringify(&head)
		}
		// No boundary found (`font: caption`): the whole value is the "family".
		None => stringify(&minify_family(&nodes, opts)),
	}
}
