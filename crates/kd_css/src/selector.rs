//! Selector minification, the part of postcss-minify-selectors and
//! postcss-unique-selectors that does not depend on the browsers targeted:
//! white space around combinators and inside attribute selectors goes, quotes
//! around attribute values go where an identifier would do, `*` before
//! another simple selector goes, `::before` becomes `:before` (and the other
//! three CSS 2 pseudo-elements), `:nth-child(1)` becomes `:first-child`,
//! `even` becomes `2n` and `2n+1` becomes `odd`, duplicates inside `:is()`,
//! `:not()` and the like go, and the selectors of a list are de-duplicated
//! and sorted.
//!
//! Anything the scanner does not understand is copied through, so an exotic
//! selector is at worst left unminified. cssnano's `:is()` folding of
//! selector lists with a shared prefix is not done.

/// Splits at the commas that are not inside parentheses, brackets or strings.
fn split_top_level(s: &str) -> Vec<&str> {
	let b = s.as_bytes();
	let mut out = Vec::new();
	let mut depth = 0usize;
	let mut start = 0;
	let mut i = 0;
	while i < b.len() {
		match b[i] {
			b'\\' => i += 1,
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
			b'(' | b'[' => depth += 1,
			b')' | b']' => depth = depth.saturating_sub(1),
			b',' if depth == 0 => {
				out.push(&s[start..i]);
				start = i + 1;
			}
			_ => {}
		}
		i += 1;
	}
	out.push(&s[start..]);
	out
}

fn is_ws(c: u8) -> bool {
	matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

/// Whether an attribute value can be written without quotes.
fn can_unquote(v: &str) -> bool {
	if v.is_empty() || v == "-" || v.contains('\\') {
		return false;
	}
	let b = v.as_bytes();
	for &c in b {
		let bad =
			matches!(c, 0x00..=0x2c | b'.' | b'/' | 0x3a..=0x40 | 0x5b..=0x5e | b'`' | 0x7b..=0x7f);
		if bad {
			return false;
		}
	}
	// 0x80..=0x9f (C1 controls) are two bytes 0xC2 0x80..0x9f in UTF-8.
	if v.chars().any(|c| ('\u{80}'..='\u{9f}').contains(&c)) {
		return false;
	}
	// Not a digit, `-digit` or `--` at the start.
	let starts_digit = b[0].is_ascii_digit();
	let starts_dash_digit = b[0] == b'-' && b.get(1).is_some_and(u8::is_ascii_digit);
	let starts_double_dash = b[0] == b'-' && b.get(1) == Some(&b'-');
	!(starts_digit || starts_dash_digit || starts_double_dash)
}

/// Pseudo-classes and pseudo-elements whose arguments are selector lists.
fn takes_selector_list(name: &str) -> bool {
	matches!(
		name,
		":is"
			| ":where"
			| ":not" | ":has"
			| ":matches"
			| ":-webkit-any"
			| ":-moz-any"
			| ":any" | ":host"
			| ":host-context"
			| "::slotted"
			| ":slotted"
			| "::cue" | "::cue-region"
	)
}

fn is_nth(name: &str) -> bool {
	matches!(
		name,
		":nth-child" | ":nth-last-child" | ":nth-of-type" | ":nth-last-of-type"
	)
}

/// Collapses runs of white space outside strings to one space and trims.
pub(crate) fn collapse_ws(s: &str) -> String {
	let b = s.as_bytes();
	let mut out = String::with_capacity(s.len());
	let mut i = 0;
	let mut pending = false;
	while i < b.len() {
		let c = b[i];
		if is_ws(c) {
			pending = !out.is_empty();
			i += 1;
			continue;
		}
		if pending {
			out.push(' ');
			pending = false;
		}
		match c {
			b'"' | b'\'' => {
				let start = i;
				i += 1;
				while i < b.len() && b[i] != c {
					if b[i] == b'\\' {
						i += 1;
					}
					i += 1;
				}
				i = (i + 1).min(b.len());
				out.push_str(&s[start..i]);
			}
			b'\\' => {
				let start = i;
				i = (i + 2).min(b.len());
				while i < b.len() && !s.is_char_boundary(i) {
					i += 1;
				}
				out.push_str(&s[start..i]);
			}
			_ => {
				let start = i;
				i += 1;
				while i < b.len() && !s.is_char_boundary(i) {
					i += 1;
				}
				out.push_str(&s[start..i]);
			}
		}
	}
	out
}

/// Normalises the argument of `:nth-*`: white space around `+` goes, then
/// `even` -> `2n`, `2n+1` -> `odd`. Returns the argument and whether it is
/// exactly `1`.
fn nth_argument(arg: &str) -> (String, bool) {
	let trimmed = arg.trim_matches(|c: char| c.is_ascii() && is_ws(c as u8));
	let (an_b, of) = match find_of(trimmed) {
		Some(pos) => (&trimmed[..pos], Some(&trimmed[pos + 4..])),
		None => (trimmed, None),
	};
	let mut an = collapse_ws(an_b);
	// No white space around `+`.
	while let Some(pos) = an.find(" +") {
		an.replace_range(pos..pos + 2, "+");
	}
	while let Some(pos) = an.find("+ ") {
		an.replace_range(pos..pos + 2, "+");
	}
	let lower = an.to_ascii_lowercase();
	if of.is_none() && an == "1" {
		return (an, true);
	}
	if of.is_none() {
		if lower == "even" {
			an = "2n".to_owned();
		} else if lower == "2n+1" {
			an = "odd".to_owned();
		}
	}
	match of {
		Some(list) => (format!("{an} of {}", minify_inner_list(list)), false),
		None => (an, false),
	}
}

/// The position of ` of ` (case-insensitive) in an `an+b of S` argument.
fn find_of(s: &str) -> Option<usize> {
	let b = s.as_bytes();
	let mut i = 0;
	while i + 4 <= b.len() {
		if is_ws(b[i]) && b[i + 1..i + 3].eq_ignore_ascii_case(b"of") && is_ws(b[i + 3]) {
			return Some(i);
		}
		i += 1;
	}
	None
}

/// A selector list inside a pseudo-class: each selector minified, duplicates
/// dropped, order kept.
fn minify_inner_list(s: &str) -> String {
	let mut out: Vec<String> = Vec::new();
	for part in split_top_level(s) {
		let m = minify_complex(part, false);
		if !out.contains(&m) {
			out.push(m);
		}
	}
	out.join(",")
}

/// Index of the `)` that closes the `(` at `open`, or the end.
fn matching_paren(b: &[u8], open: usize) -> usize {
	let mut depth = 0usize;
	let mut i = open;
	while i < b.len() {
		match b[i] {
			b'\\' => i += 1,
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
			b'(' => depth += 1,
			b')' => {
				depth -= 1;
				if depth == 0 {
					return i;
				}
			}
			_ => {}
		}
		i += 1;
	}
	b.len()
}

/// Minifies the inside of `[...]` (without the brackets).
fn minify_attribute(inner: &str) -> String {
	let b = inner.as_bytes();
	let mut i = 0;
	while i < b.len() && is_ws(b[i]) {
		i += 1;
	}
	// The attribute name, with an optional namespace.
	let name_start = i;
	while i < b.len() && !is_ws(b[i]) && !matches!(b[i], b'=' | b'~' | b'^' | b'$' | b'*') {
		if b[i] == b'|' && b.get(i + 1) == Some(&b'=') {
			break;
		}
		if b[i] == b'\\' {
			i += 1;
		}
		i += 1;
	}
	let i0 = i.min(b.len());
	let name = &inner[name_start..i0];
	let mut i = i0;
	while i < b.len() && is_ws(b[i]) {
		i += 1;
	}
	if i >= b.len() {
		return format!("[{name}]");
	}
	// The operator.
	let op_start = i;
	if matches!(b[i], b'~' | b'|' | b'^' | b'$' | b'*') {
		i += 1;
	}
	if b.get(i) != Some(&b'=') {
		return format!("[{}]", collapse_ws(inner));
	}
	i += 1;
	let op = &inner[op_start..i];
	while i < b.len() && is_ws(b[i]) {
		i += 1;
	}
	if i >= b.len() {
		return format!("[{}]", collapse_ws(inner));
	}
	// The value.
	let (value, quoted) = if b[i] == b'"' || b[i] == b'\'' {
		let q = b[i];
		let start = i + 1;
		i += 1;
		while i < b.len() && b[i] != q {
			if b[i] == b'\\' {
				i += 1;
			}
			i += 1;
		}
		let end = i.min(b.len());
		i = (i + 1).min(b.len());
		(&inner[start..end], Some(q))
	} else {
		let start = i;
		while i < b.len() && !is_ws(b[i]) {
			if b[i] == b'\\' {
				i += 1;
			}
			i += 1;
		}
		let end = i.min(b.len());
		i = end;
		(&inner[start..end], None)
	};
	while i < b.len() && is_ws(b[i]) {
		i += 1;
	}
	let flag = inner[i.min(b.len())..].trim_end_matches(|c: char| c.is_ascii() && is_ws(c as u8));
	let value_text = match quoted {
		Some(_) if can_unquote(value) => value.to_owned(),
		Some(q) => {
			let q = q as char;
			format!("{q}{value}{q}")
		}
		None => value.to_owned(),
	};
	let unquoted = quoted.is_none() || can_unquote(value);
	if flag.is_empty() {
		format!("[{name}{op}{value_text}]")
	} else if unquoted {
		format!("[{name}{op}{value_text} {flag}]")
	} else {
		format!("[{name}{op}{value_text}{flag}]")
	}
}

/// Minifies one complex selector (no top-level commas).
fn minify_complex(sel: &str, keyframe: bool) -> String {
	let s = sel.trim_matches(|c: char| c.is_ascii() && is_ws(c as u8));
	if keyframe {
		let lower = s.to_ascii_lowercase();
		if lower == "from" {
			return "0%".to_owned();
		}
		if s == "100%" {
			return "to".to_owned();
		}
	}
	let b = s.as_bytes();
	let mut out = String::with_capacity(s.len());
	let mut i = 0;
	// Whether the last thing written is a combinator (or nothing yet), so
	// that white space after it is dropped.
	let mut after_combinator = true;
	let mut compound_start = true;
	while i < b.len() {
		let c = b[i];
		if is_ws(c) {
			while i < b.len() && is_ws(b[i]) {
				i += 1;
			}
			// Descendant combinator, unless a combinator follows or ends.
			if i < b.len()
				&& !matches!(b[i], b'>' | b'+' | b'~')
				&& !(b[i] == b'|' && b.get(i + 1) == Some(&b'|'))
			{
				if !after_combinator {
					out.push(' ');
				}
				after_combinator = true;
				compound_start = true;
			}
			continue;
		}
		match c {
			b'>' | b'+' | b'~' => {
				out.push(c as char);
				i += 1;
				after_combinator = true;
				compound_start = true;
			}
			b'|' if b.get(i + 1) == Some(&b'|') => {
				out.push_str("||");
				i += 2;
				after_combinator = true;
				compound_start = true;
			}
			b'[' => {
				let mut j = i + 1;
				while j < b.len() && b[j] != b']' {
					match b[j] {
						b'\\' => j += 1,
						b'"' | b'\'' => {
							let q = b[j];
							j += 1;
							while j < b.len() && b[j] != q {
								if b[j] == b'\\' {
									j += 1;
								}
								j += 1;
							}
						}
						_ => {}
					}
					j += 1;
				}
				let end = j.min(b.len());
				out.push_str(&minify_attribute(&s[i + 1..end]));
				i = (end + 1).min(b.len());
				after_combinator = false;
				compound_start = false;
			}
			b':' => {
				let start = i;
				i += 1;
				if b.get(i) == Some(&b':') {
					i += 1;
				}
				let name_start = i;
				while i < b.len()
					&& (b[i].is_ascii_alphanumeric() || matches!(b[i], b'-' | b'_') || b[i] >= 0x80)
				{
					i += 1;
				}
				// Escapes in a pseudo name are left alone.
				let name = format!(
					"{}{}",
					&s[start..name_start],
					s[name_start..i].to_ascii_lowercase()
				);
				if b.get(i) == Some(&b'(') {
					let close = matching_paren(b, i);
					let args = &s[i + 1..close.min(b.len())];
					let lname = name.to_ascii_lowercase();
					if is_nth(&lname) {
						let (arg, one) = nth_argument(args);
						if one {
							let replaced = match lname.as_str() {
								":nth-child" => ":first-child",
								":nth-of-type" => ":first-of-type",
								":nth-last-child" => ":last-child",
								_ => ":last-of-type",
							};
							out.push_str(replaced);
						} else {
							out.push_str(&s[start..name_start]);
							out.push_str(&s[name_start..i]);
							out.push('(');
							out.push_str(&arg);
							out.push(')');
						}
					} else if takes_selector_list(&lname) {
						out.push_str(&s[start..i]);
						out.push('(');
						out.push_str(&minify_inner_list(args));
						out.push(')');
					} else {
						out.push_str(&s[start..i]);
						out.push('(');
						out.push_str(&collapse_ws(args));
						out.push(')');
					}
					i = (close + 1).min(b.len());
				} else {
					let lname = name.to_ascii_lowercase();
					if matches!(
						lname.as_str(),
						"::before" | "::after" | "::first-letter" | "::first-line"
					) {
						out.push_str(&s[start + 1..i]);
					} else {
						out.push_str(&s[start..i]);
					}
				}
				after_combinator = false;
				compound_start = false;
			}
			b'*' if compound_start && matches!(b.get(i + 1), Some(b'.' | b'#' | b'[' | b':')) => {
				// A universal selector before another simple selector.
				i += 1;
				compound_start = false;
				after_combinator = false;
			}
			b'"' | b'\'' => {
				// A stray string: copy it.
				let start = i;
				i += 1;
				while i < b.len() && b[i] != c {
					if b[i] == b'\\' {
						i += 1;
					}
					i += 1;
				}
				i = (i + 1).min(b.len());
				out.push_str(&s[start..i]);
				after_combinator = false;
				compound_start = false;
			}
			b'\\' => {
				out.push('\\');
				i += 1;
				if i < b.len() {
					if b[i].is_ascii_hexdigit() {
						let mut n = 0;
						while n < 6 && i < b.len() && b[i].is_ascii_hexdigit() {
							out.push(b[i] as char);
							i += 1;
							n += 1;
						}
						if i < b.len() && is_ws(b[i]) {
							out.push(' ');
							if b[i] == b'\r' && b.get(i + 1) == Some(&b'\n') {
								i += 1;
							}
							i += 1;
						}
					} else {
						let start = i;
						i += 1;
						while i < b.len() && !s.is_char_boundary(i) {
							i += 1;
						}
						out.push_str(&s[start..i]);
					}
				}
				after_combinator = false;
				compound_start = false;
			}
			_ => {
				let start = i;
				i += 1;
				while i < b.len() && !s.is_char_boundary(i) {
					i += 1;
				}
				out.push_str(&s[start..i]);
				after_combinator = false;
				compound_start = false;
			}
		}
	}
	out
}

/// Compares like JavaScript's default `Array.prototype.sort` on strings.
fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
	a.encode_utf16().cmp(b.encode_utf16())
}

/// Minifies a selector list (the prelude of a style rule).
///
/// `keyframe` is true for the selectors of keyframe blocks (`from`, `100%`).
///
/// # Example
///
/// ```
/// use kd_css::selector::minify_selector_list;
///
/// assert_eq!(minify_selector_list("a  >  b , a>b,  c", false), "a>b,c");
/// assert_eq!(minify_selector_list("input[type=\"text\"]::before", false), "input[type=text]:before");
/// ```
pub fn minify_selector_list(sel: &str, keyframe: bool) -> String {
	let trimmed = sel.trim_matches(|c: char| c.is_ascii() && is_ws(c as u8));
	// A selector ending in `:` is a mixin of some preprocessor: leave it.
	if trimmed.ends_with(':') {
		return trimmed.to_owned();
	}
	let parts = split_top_level(trimmed);
	if parts.len() == 1 {
		return minify_complex(parts[0], keyframe);
	}
	let mut list: Vec<String> = Vec::with_capacity(parts.len());
	for part in parts {
		let m = minify_complex(part, keyframe);
		list.push(m);
	}
	list.sort_by(|a, b| js_cmp(a, b));
	list.dedup();
	list.join(",")
}
