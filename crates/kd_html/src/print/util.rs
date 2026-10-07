//! Text helpers of the HTML printer: prettier's `htmlWhitespaceUtils` (HTML
//! white space is exactly tab, line feed, form feed, carriage return and
//! space, not Unicode white space) and the few string operations the printer
//! needs around them.

pub(crate) use crate::parser::is_js_space;

/// An HTML white-space character.
#[must_use]
pub fn is_html_ws(c: char) -> bool {
	matches!(c, '\t' | '\n' | '\u{0C}' | '\r' | ' ')
}

#[must_use]
pub fn trim(text: &str) -> &str {
	text.trim_matches(is_html_ws)
}

#[must_use]
pub fn trim_start(text: &str) -> &str {
	text.trim_start_matches(is_html_ws)
}

#[must_use]
pub fn trim_end(text: &str) -> &str {
	text.trim_end_matches(is_html_ws)
}

/// The leading HTML white space of `text`.
#[must_use]
pub fn leading_ws(text: &str) -> &str {
	&text[..text.len() - trim_start(text).len()]
}

/// The trailing HTML white space of `text`.
#[must_use]
pub fn trailing_ws(text: &str) -> &str {
	&text[trim_end(text).len()..]
}

#[must_use]
pub fn has_ws(text: &str) -> bool {
	text.chars().any(is_html_ws)
}

/// `text.split(/[ws]+/)`: runs of white space separate, and a leading or
/// trailing run leaves an empty piece (as JavaScript's `split` does).
#[must_use]
pub fn split_ws(text: &str) -> Vec<&str> {
	let mut pieces = Vec::new();
	let mut start = 0;
	let mut in_ws = false;
	let mut ws_start = 0;
	for (i, c) in text.char_indices() {
		if is_html_ws(c) {
			if !in_ws {
				in_ws = true;
				ws_start = i;
			}
		} else if in_ws {
			pieces.push(&text[start..ws_start]);
			start = i;
			in_ws = false;
		}
	}
	if in_ws {
		pieces.push(&text[start..ws_start]);
		pieces.push("");
	} else {
		pieces.push(&text[start..]);
	}
	pieces
}

/// The smallest indentation of the non-blank lines, in characters (zero as
/// soon as one non-blank line is not indented).
fn min_indent(text: &str) -> usize {
	let mut min = usize::MAX;
	for line in text.split('\n') {
		if line.is_empty() {
			continue;
		}
		let indent = line.chars().take_while(|&c| is_html_ws(c)).count();
		if indent == 0 {
			return 0;
		}
		if line.chars().count() != indent && indent < min {
			min = indent;
		}
	}
	if min == usize::MAX { 0 } else { min }
}

/// Removes the common indentation (`dedentString`).
#[must_use]
pub fn dedent_string(text: &str) -> String {
	let n = min_indent(text);
	if n == 0 {
		return text.to_owned();
	}
	text.split('\n')
		.map(|line| {
			let mut chars = line.chars();
			for _ in 0..n {
				chars.next();
			}
			chars.as_str()
		})
		.collect::<Vec<_>>()
		.join("\n")
}

/// `htmlTrimPreserveIndentation`: no trailing white space, and no first line
/// when that one is blank.
#[must_use]
pub fn trim_preserve_indentation(text: &str) -> &str {
	let text = trim_end(text);
	// `^[\t\f\r ]*\n` (the first blank line, once)
	let blank = text
		.char_indices()
		.find(|&(_, c)| !matches!(c, '\t' | '\u{0C}' | '\r' | ' '));
	match blank {
		Some((i, '\n')) => &text[i + 1..],
		_ => text,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn html_white_space_is_not_unicode_white_space() {
		assert_eq!(trim("\u{A0} a \n"), "\u{A0} a");
		assert!(!is_html_ws('\u{A0}'));
		assert!(is_html_ws('\u{0C}'));
	}

	#[test]
	fn split_keeps_empty_ends_like_javascript() {
		assert_eq!(split_ws("a  b\nc"), ["a", "b", "c"]);
		assert_eq!(split_ws(" a b "), ["", "a", "b", ""]);
		assert_eq!(split_ws(""), [""]);
		assert_eq!(split_ws("abc"), ["abc"]);
		assert_eq!(split_ws("  "), ["", ""]);
	}

	#[test]
	fn dedent_removes_the_common_indentation_only() {
		assert_eq!(dedent_string("  a\n    b\n  c"), "a\n  b\nc");
		assert_eq!(dedent_string("a\n  b"), "a\n  b");
		assert_eq!(dedent_string("  a\n\n  b"), "a\n\nb");
		assert_eq!(dedent_string("\t\ta\n\t\t\tb"), "a\n\tb");
	}

	#[test]
	fn trim_preserve_indentation_drops_one_blank_first_line_and_the_trailing_white_space() {
		assert_eq!(trim_preserve_indentation("\n  a\n  b  \n"), "  a\n  b");
		assert_eq!(trim_preserve_indentation("  \n\n  a"), "\n  a");
		assert_eq!(trim_preserve_indentation("  a"), "  a");
	}
}
