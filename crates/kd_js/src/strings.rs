//! Decoding and encoding of string literals.

/// The value of a JavaScript string literal (`raw` includes the quotes).
/// A malformed escape is kept as written: the parser has already accepted
/// the literal, and only module specifiers and a few constants are decoded.
#[must_use]
pub fn decode(raw: &str) -> String {
	let inner = &raw[1..raw.len().saturating_sub(1).max(1)];
	let mut out = String::with_capacity(inner.len());
	let mut chars = inner.chars().peekable();
	while let Some(c) = chars.next() {
		if c != '\\' {
			out.push(c);
			continue;
		}
		let Some(e) = chars.next() else {
			out.push('\\');
			break;
		};
		match e {
			'n' => out.push('\n'),
			't' => out.push('\t'),
			'r' => out.push('\r'),
			'b' => out.push('\u{8}'),
			'f' => out.push('\u{c}'),
			'v' => out.push('\u{b}'),
			'0' if !chars.peek().is_some_and(char::is_ascii_digit) => out.push('\0'),
			'x' => {
				let hex: String = chars.clone().take(2).collect();
				match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
					Some(ch) if hex.len() == 2 => {
						out.push(ch);
						chars.nth(1);
					}
					_ => out.push_str("\\x"),
				}
			}
			'u' => {
				let braced = chars.peek() == Some(&'{');
				let hex: String = if braced {
					chars.clone().skip(1).take_while(|&c| c != '}').collect()
				} else {
					chars.clone().take(4).collect()
				};
				let consumed = if braced { hex.chars().count() + 2 } else { 4 };
				match u32::from_str_radix(&hex, 16).ok().and_then(char::from_u32) {
					Some(ch) if braced || hex.len() == 4 => {
						out.push(ch);
						if consumed > 0 {
							chars.nth(consumed - 1);
						}
					}
					_ => out.push_str("\\u"),
				}
			}
			'\r' => {
				if chars.peek() == Some(&'\n') {
					chars.next();
				}
			}
			'\n' | '\u{2028}' | '\u{2029}' => {}
			other => out.push(other),
		}
	}
	out
}

/// A JavaScript string literal (double quotes) for `text`.
#[must_use]
pub fn quote(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	for c in text.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\u{2028}' => out.push_str("\\u2028"),
			'\u{2029}' => out.push_str("\\u2029"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn escapes_are_decoded() {
		assert_eq!(decode(r#""a\nb\t\x41B\u{43}\0""#), "a\nb\tABC\0");
		assert_eq!(decode("'it\\'s'"), "it's");
		assert_eq!(decode("'a\\\nb'"), "ab");
	}

	#[test]
	fn quoting_round_trips_through_decode() {
		let s = "a\"b\\c\nd\u{2028}e\u{1}f日本";
		assert_eq!(decode(&quote(s)), s);
	}
}
