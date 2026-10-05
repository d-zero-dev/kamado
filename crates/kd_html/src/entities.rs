//! Named and numeric character references.
//!
//! Decoding follows the HTML spec's character reference rules (§13.2.5.72):
//! `&name;` for every named reference, `&legacy` without a semicolon for the
//! 106 legacy names (but never when followed by `=` or an alphanumeric inside
//! an attribute value), and `&#123;` / `&#x7B;` numerics with the spec's
//! replacement of invalid code points.
//!
//! Encoding is the inverse used by `html.entities`: a non-ASCII character is
//! replaced by its named reference. The preferred name per character is the
//! rule v2's `characterEntities` used (see `scripts/generate-entities.mjs`).

use crate::entities_table::{DECODE, ENCODE, LEGACY};

/// The replacement text of a named reference (`name` without `&` and `;`).
///
/// # Example
///
/// ```
/// assert_eq!(kd_html::entities::named("amp"), Some("&"));
/// assert_eq!(kd_html::entities::named("copy"), Some("©"));
/// assert_eq!(kd_html::entities::named("nope"), None);
/// ```
#[must_use]
pub fn named(name: &str) -> Option<&'static str> {
	DECODE
		.binary_search_by(|(n, _)| (*n).cmp(name))
		.ok()
		.map(|i| DECODE[i].1)
}

/// Whether `name` may be written without a trailing semicolon.
#[must_use]
pub fn is_legacy(name: &str) -> bool {
	LEGACY.binary_search(&name).is_ok()
}

/// The preferred named reference for a non-ASCII character, without `&;`.
///
/// # Example
///
/// ```
/// assert_eq!(kd_html::entities::name_of("©"), Some("copy"));
/// assert_eq!(kd_html::entities::name_of("a"), None);
/// ```
#[must_use]
pub fn name_of(character: &str) -> Option<&'static str> {
	ENCODE
		.binary_search_by(|(c, _)| (*c).cmp(character))
		.ok()
		.map(|i| ENCODE[i].1)
}

/// Windows-1252 replacements for the C1 control range (`&#128;`–`&#159;`),
/// as the HTML spec specifies for numeric references.
const C1: [Option<char>; 32] = [
	Some('\u{20AC}'),
	None,
	Some('\u{201A}'),
	Some('\u{0192}'),
	Some('\u{201E}'),
	Some('\u{2026}'),
	Some('\u{2020}'),
	Some('\u{2021}'),
	Some('\u{02C6}'),
	Some('\u{2030}'),
	Some('\u{0160}'),
	Some('\u{2039}'),
	Some('\u{0152}'),
	None,
	Some('\u{017D}'),
	None,
	None,
	Some('\u{2018}'),
	Some('\u{2019}'),
	Some('\u{201C}'),
	Some('\u{201D}'),
	Some('\u{2022}'),
	Some('\u{2013}'),
	Some('\u{2014}'),
	Some('\u{02DC}'),
	Some('\u{2122}'),
	Some('\u{0161}'),
	Some('\u{203A}'),
	Some('\u{0153}'),
	None,
	Some('\u{017E}'),
	Some('\u{0178}'),
];

/// The character a numeric reference stands for, after the spec's fix-ups:
/// 0 and out-of-range values and surrogates become U+FFFD, and the C1
/// range maps through Windows-1252.
fn numeric(code: u32) -> char {
	match code {
		0 => '\u{FFFD}',
		0x80..=0x9F => {
			C1[(code - 0x80) as usize].unwrap_or(char::from_u32(code).unwrap_or('\u{FFFD}'))
		}
		_ => char::from_u32(code).unwrap_or('\u{FFFD}'),
	}
}

/// How a reference is being decoded: in text, or inside an attribute value,
/// where a legacy name without `;` followed by `=` or an alphanumeric is left
/// alone (so `?a=1&copy=2` in a URL survives).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Context {
	Text,
	Attribute,
}

/// Decodes every character reference in `input`.
///
/// # Example
///
/// ```
/// use kd_html::entities::{decode, Context};
/// assert_eq!(decode("a &amp; b &lt;c&gt; &#169; &#x1F600;", Context::Text), "a & b <c> © 😀");
/// assert_eq!(decode("?x=1&copy=2", Context::Attribute), "?x=1&copy=2");
/// assert_eq!(decode("&copy 2026", Context::Text), "© 2026");
/// ```
#[must_use]
pub fn decode(input: &str, context: Context) -> String {
	if !input.contains('&') {
		return input.to_string();
	}
	let bytes = input.as_bytes();
	let mut out = String::with_capacity(input.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] != b'&' {
			// Copy up to the next '&' in one go (all UTF-8 boundaries are safe: '&' is ASCII).
			let next = input[i..].find('&').map_or(input.len(), |p| i + p);
			out.push_str(&input[i..next]);
			i = next;
			continue;
		}
		match decode_one(&input[i..], context) {
			Some((text, consumed)) => {
				out.push_str(&text);
				i += consumed;
			}
			None => {
				out.push('&');
				i += 1;
			}
		}
	}
	out
}

/// Decodes the reference at the start of `rest` (which begins with `&`).
/// Returns the replacement and the number of bytes consumed.
pub(crate) fn decode_one(rest: &str, context: Context) -> Option<(String, usize)> {
	let after = &rest[1..];
	if let Some(num) = after.strip_prefix('#') {
		let (digits, radix, prefix_len) = match num.strip_prefix(['x', 'X']) {
			Some(hex) => (hex, 16, 3),
			None => (num, 10, 2),
		};
		let len = digits
			.bytes()
			.take_while(|b| {
				if radix == 16 {
					b.is_ascii_hexdigit()
				} else {
					b.is_ascii_digit()
				}
			})
			.count();
		if len == 0 {
			return None;
		}
		// Saturate: anything this large is out of range anyway.
		let code = u32::from_str_radix(&digits[..len], radix).unwrap_or(u32::MAX);
		let mut consumed = prefix_len + len;
		if digits[len..].starts_with(';') {
			consumed += 1;
		}
		return Some((numeric(code).to_string(), consumed));
	}
	// Named: the longest matching name, with `;` or (legacy) without it.
	let name_len = after.bytes().take_while(u8::is_ascii_alphanumeric).count();
	if name_len == 0 {
		return None;
	}
	let candidate = &after[..name_len];
	if after[name_len..].starts_with(';')
		&& let Some(text) = named(candidate)
	{
		return Some((text.to_string(), 1 + name_len + 1));
	}
	// Legacy names match as the longest *prefix* of the alphanumeric run
	// (`&copyright` → `©` + "right"), unless an attribute value continues the
	// run with `=` or an alphanumeric.
	for end in (1..=name_len).rev() {
		let prefix = &candidate[..end];
		if is_legacy(prefix) {
			let next = after[end..].chars().next();
			if context == Context::Attribute
				&& matches!(next, Some(c) if c == '=' || c.is_ascii_alphanumeric())
			{
				return None;
			}
			return named(prefix).map(|t| (t.to_string(), 1 + end));
		}
	}
	None
}

/// Replaces non-ASCII characters by their named references and leaves
/// everything else as is. Text inside `<script>`, `<style>` and tags is the
/// caller's concern: this works on one string at a time.
///
/// # Example
///
/// ```
/// assert_eq!(kd_html::entities::encode_non_ascii("© 2026 — ok"), "&copy; 2026 &mdash; ok");
/// assert_eq!(kd_html::entities::encode_non_ascii("日本語"), "日本語");
/// ```
#[must_use]
pub fn encode_non_ascii(input: &str) -> String {
	if input.is_ascii() {
		return input.to_string();
	}
	let mut out = String::with_capacity(input.len());
	let mut buf = [0u8; 4];
	for ch in input.chars() {
		if (ch as u32) < 127 {
			out.push(ch);
			continue;
		}
		match name_of(ch.encode_utf8(&mut buf)) {
			Some(name) => {
				out.push('&');
				out.push_str(name);
				out.push(';');
			}
			None => out.push(ch),
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn text(s: &str) -> String {
		decode(s, Context::Text)
	}

	fn attr(s: &str) -> String {
		decode(s, Context::Attribute)
	}

	#[test]
	fn table_sizes_match_the_whatwg_data() {
		assert_eq!(DECODE.len(), 2125);
		// Single-code-point characters only: verified against v2's
		// `characterEntities` for every one of them when the table was generated.
		assert_eq!(ENCODE.len(), 1414);
		assert_eq!(LEGACY.len(), 106);
		assert!(
			DECODE.windows(2).all(|w| w[0].0 < w[1].0),
			"DECODE must be sorted for binary search"
		);
		assert!(
			LEGACY.windows(2).all(|w| w[0] < w[1]),
			"LEGACY must be sorted"
		);
		assert!(
			ENCODE.windows(2).all(|w| w[0].0 < w[1].0),
			"ENCODE must be sorted"
		);
	}

	#[test]
	fn named_lookups() {
		assert_eq!(named("amp"), Some("&"));
		assert_eq!(named("AMP"), Some("&"));
		assert_eq!(named("lt"), Some("<"));
		assert_eq!(named("nbsp"), Some("\u{A0}"));
		assert_eq!(named("hellip"), Some("\u{2026}"));
		assert_eq!(named("NotEqualTilde"), Some("\u{2242}\u{338}"));
		assert_eq!(named("amp;"), None);
		assert_eq!(named(""), None);
		assert!(is_legacy("copy"));
		assert!(is_legacy("amp"));
		assert!(!is_legacy("hellip"));
	}

	#[test]
	fn decodes_named_references_with_semicolon() {
		assert_eq!(
			text("a &amp; b &lt;i&gt; &quot;q&quot; &hellip;"),
			"a & b <i> \"q\" \u{2026}"
		);
		assert_eq!(
			text("&notit;"),
			"¬it;",
			"legacy prefix wins when the long name does not exist"
		);
		assert_eq!(text("&unknown; &amp"), "&unknown; &");
	}

	#[test]
	fn legacy_names_decode_without_a_semicolon_in_text() {
		assert_eq!(text("&copy 2026"), "© 2026");
		assert_eq!(text("&ampx"), "&x");
		assert_eq!(text("&copyright"), "©right");
		assert_eq!(
			text("&hellip"),
			"&hellip",
			"non-legacy names need the semicolon"
		);
	}

	#[test]
	fn in_attributes_a_legacy_name_followed_by_equals_or_alphanumeric_is_literal() {
		assert_eq!(attr("?a=1&copy=2"), "?a=1&copy=2");
		assert_eq!(attr("?a=1&copyx"), "?a=1&copyx");
		assert_eq!(attr("?a=1&copy;"), "?a=1©");
		assert_eq!(attr("?a=1&copy&b"), "?a=1©&b");
		assert_eq!(attr("&amp;"), "&");
	}

	#[test]
	fn numeric_references() {
		assert_eq!(text("&#65;&#x41;&#X41;&#169;&#x1F600;"), "AAA©😀");
		assert_eq!(text("&#65 b"), "A b", "the semicolon is optional");
		assert_eq!(text("&#x;&#;&#xZ;"), "&#x;&#;&#xZ;");
	}

	#[test]
	fn numeric_references_use_the_spec_replacements() {
		assert_eq!(text("&#0;"), "\u{FFFD}");
		assert_eq!(text("&#xD800;"), "\u{FFFD}", "surrogates");
		assert_eq!(text("&#x110000;"), "\u{FFFD}", "beyond Unicode");
		assert_eq!(text("&#99999999999999999999;"), "\u{FFFD}", "overflow");
		assert_eq!(
			text("&#128;&#153;&#159;"),
			"€™Ÿ",
			"C1 maps through Windows-1252"
		);
		assert_eq!(
			text("&#129;"),
			"\u{81}",
			"unassigned C1 stays a control character"
		);
	}

	#[test]
	fn stray_ampersands_are_left_alone() {
		assert_eq!(text("a & b"), "a & b");
		assert_eq!(text("&"), "&");
		assert_eq!(text("&&amp;&"), "&&&");
		assert_eq!(text("AT&T"), "AT&T");
		assert_eq!(text("no references"), "no references");
	}

	#[test]
	fn multibyte_text_around_references_is_preserved() {
		assert_eq!(text("日本&amp;語 &copy; é"), "日本&語 © é");
	}

	#[test]
	fn encode_prefers_lowercase_names_and_skips_ascii() {
		assert_eq!(name_of("©"), Some("copy"));
		assert_eq!(name_of("®"), Some("reg"));
		assert_eq!(name_of("\u{2014}"), Some("mdash"));
		assert_eq!(name_of("&"), None);
		assert_eq!(name_of("日"), None);
		assert_eq!(encode_non_ascii("© 2026 — ok"), "&copy; 2026 &mdash; ok");
		assert_eq!(encode_non_ascii("ascii only <&>"), "ascii only <&>");
		assert_eq!(encode_non_ascii("日本語"), "日本語");
		// Roman numeral three has no named reference, so it stays as the character
		// (a project that needs `&#8546;` writes that mapping in `html.entities`).
		assert_eq!(name_of("Ⅲ"), None);
		assert_eq!(encode_non_ascii("Ⅲ"), "Ⅲ");
	}

	#[test]
	fn characters_that_are_a_base_plus_a_combining_mark_are_not_encoded() {
		// `&nang;` stands for U+2220 U+20D2. v2 replaced one code point at a time,
		// so only the base would have been touched; the table skips such names.
		assert_eq!(named("nang"), Some("\u{2220}\u{20D2}"));
		assert_eq!(name_of("\u{2220}\u{20D2}"), None);
		assert_eq!(name_of("\u{2220}"), Some("ang"));
		assert_eq!(encode_non_ascii("\u{2220}\u{20D2}"), "&ang;\u{20D2}");
	}

	#[test]
	fn decode_then_encode_roundtrips_known_characters() {
		assert_eq!(
			encode_non_ascii(&text("&copy; &reg; &euro; &yen;")),
			"&copy; &reg; &euro; &yen;"
		);
	}
}

/// Which characters the serializer writes as character references
/// (`html.entities`).
///
/// # Example
///
/// ```
/// use kd_html::entities::Entities;
/// assert_eq!(Entities::All.apply("© é"), "&copy; &eacute;");
/// let some = Entities::Custom(vec![('©', "&#169;".to_owned())]);
/// assert_eq!(some.apply("© é"), "&#169; é");
/// assert_eq!(Entities::None.apply("© é"), "© é");
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum Entities {
	/// Write characters as they are.
	#[default]
	None,
	/// Every character with a named reference, by its preferred name.
	All,
	/// Only these characters, each with its own replacement text.
	Custom(Vec<(char, String)>),
}

impl Entities {
	/// Applies the mode to already-escaped text or an attribute value.
	#[must_use]
	pub fn apply(&self, text: &str) -> String {
		match self {
			Entities::None => text.to_owned(),
			Entities::All => encode_non_ascii(text),
			Entities::Custom(map) => {
				let mut out = String::with_capacity(text.len());
				for ch in text.chars() {
					match map.iter().find(|(c, _)| *c == ch) {
						Some((_, replacement)) => out.push_str(replacement),
						None => out.push(ch),
					}
				}
				out
			}
		}
	}

	/// Whether the mode changes anything.
	#[must_use]
	pub fn is_none(&self) -> bool {
		matches!(self, Entities::None) || matches!(self, Entities::Custom(m) if m.is_empty())
	}
}
