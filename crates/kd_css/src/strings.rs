//! Strings and URLs: postcss-normalize-string and postcss-normalize-url.
//!
//! A string is written with double quotes unless it holds a double quote
//! that would need escaping and no single quote; backslash-newline pairs
//! (line continuations) are removed. A `url()` argument loses its quotes when
//! it can be written without, and `./` and `a/../` in a relative path are
//! resolved.
//!
//! Differences from cssnano: hosts and ports of absolute URLs are not
//! normalised, `//` inside a path is not collapsed, and a path with a query,
//! a fragment, a backslash or a percent escape is left alone.

use crate::value::{ValueNode, parse, stringify, walk};

/// The pieces of the inside of a string.
struct Counts {
	single: usize,
	double: usize,
	escaped_single: usize,
	escaped_double: usize,
}

/// Rewrites the inside of a string for the wrapping quote `quote`, returning
/// the new inside and the quote to use.
fn normalize_inside(inside: &str, quote: char) -> (String, char) {
	let b = inside.as_bytes();
	let mut counts = Counts {
		single: 0,
		double: 0,
		escaped_single: 0,
		escaped_double: 0,
	};
	let mut i = 0;
	while i < b.len() {
		match b[i] {
			b'\'' => counts.single += 1,
			b'"' => counts.double += 1,
			b'\\' => match b.get(i + 1) {
				Some(b'\'') => {
					counts.escaped_single += 1;
					i += 1;
				}
				Some(b'"') => {
					counts.escaped_double += 1;
					i += 1;
				}
				Some(b'\n') => i += 1,
				_ => {}
			},
			_ => {}
		}
		i += 1;
	}
	let quotes = counts.single + counts.double + counts.escaped_single + counts.escaped_double > 0;
	let mut q = quote;
	let mut change_children = false;
	if !quotes {
		q = '"';
	} else if counts.single == 0 && counts.double == 0 {
		if q == '\'' && counts.escaped_single > 0 && counts.escaped_double == 0 {
			q = '"';
		}
		if q == '"' && counts.escaped_double > 0 && counts.escaped_single == 0 {
			q = '\'';
		}
		change_children = true;
	}
	// Rebuild: drop `\`+newline, unescape the quote the wrapper is not.
	let mut out = String::with_capacity(inside.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'\\' {
			match b.get(i + 1) {
				Some(b'\n') => {
					i += 2;
					continue;
				}
				Some(b'"') if change_children && q == '\'' => {
					out.push('"');
					i += 2;
					continue;
				}
				Some(b'\'') if change_children && q == '"' => {
					out.push('\'');
					i += 2;
					continue;
				}
				Some(_) => {
					// Keep the escape and the escaped character together.
					out.push('\\');
					let len = inside[i + 1..].chars().next().map_or(1, char::len_utf8);
					out.push_str(&inside[i + 1..i + 1 + len]);
					i += 1 + len;
					continue;
				}
				None => {
					out.push('\\');
					i += 1;
					continue;
				}
			}
		}
		let len = inside[i..].chars().next().map_or(1, char::len_utf8);
		out.push_str(&inside[i..i + len]);
		i += len;
	}
	(out, q)
}

/// Normalises every string of a parsed value.
pub fn normalize_strings_in(nodes: &mut [ValueNode]) {
	walk(nodes, &mut |n| {
		if let ValueNode::Str { quote, value, .. } = n {
			let (v, q) = normalize_inside(value, *quote);
			*value = v;
			*quote = q;
		}
		true
	});
}

/// `postcss-normalize-string` on a text that may hold strings.
///
/// # Example
///
/// ```
/// use kd_css::strings::normalize_strings;
///
/// assert_eq!(normalize_strings("'a'"), "\"a\"");
/// assert_eq!(normalize_strings("'a\\'b'"), "\"a'b\"");
/// assert_eq!(normalize_strings("'a\"b'"), "'a\"b'");
/// ```
pub fn normalize_strings(text: &str) -> String {
	if !text.contains(['\'', '"']) {
		return text.to_owned();
	}
	let mut nodes = parse(text);
	normalize_strings_in(&mut nodes);
	stringify(&nodes)
}

fn is_absolute_url(url: &str) -> bool {
	let b = url.as_bytes();
	// A Windows drive path `c:\`.
	if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
		return false;
	}
	if !b.first().is_some_and(u8::is_ascii_alphabetic) {
		return false;
	}
	for (i, &c) in b.iter().enumerate() {
		if c == b':' {
			return true;
		}
		if i > 0 && !(c.is_ascii_alphanumeric() || matches!(c, b'+' | b'-' | b'.')) {
			return false;
		}
	}
	false
}

fn is_data_url(url: &str) -> bool {
	let lower = url.to_ascii_lowercase();
	lower.starts_with("data:") && lower.contains(',')
}

/// Resolves `.` and `..` segments of a relative or root-relative path, the
/// way `path.normalize` does, for paths that are plain enough to be sure.
fn normalize_path(url: &str) -> String {
	if url.contains(['?', '#', '\\', '%', ':']) || url.starts_with("//") {
		return url.to_owned();
	}
	let absolute = url.starts_with('/');
	let trailing = url.ends_with('/');
	let mut out: Vec<&str> = Vec::new();
	for seg in url.split('/') {
		match seg {
			"" | "." => {}
			".." => {
				if out.last().is_some_and(|l| *l != "..") {
					out.pop();
				} else if !absolute {
					out.push("..");
				}
			}
			s => out.push(s),
		}
	}
	let mut path = out.join("/");
	if absolute {
		path.insert(0, '/');
	}
	if trailing && !path.is_empty() && !path.ends_with('/') {
		path.push('/');
	}
	if path.is_empty() {
		// `.` or `./`: path.normalize gives `.` / `./`.
		return if trailing {
			"./".to_owned()
		} else {
			".".to_owned()
		};
	}
	path
}

fn needs_escape(c: char) -> bool {
	c.is_whitespace() || matches!(c, '(' | ')' | '"' | '\'')
}

/// Rewrites the `url()` functions of a parsed value.
fn normalize_urls_in(nodes: &mut [ValueNode]) {
	walk(nodes, &mut |n| {
		let ValueNode::Function {
			name,
			before,
			after,
			nodes,
			..
		} = n
		else {
			return true;
		};
		if !name.eq_ignore_ascii_case("url") {
			return true;
		}
		before.clear();
		after.clear();
		let Some(first) = nodes.first_mut() else {
			return false;
		};
		let mut replacement: Option<ValueNode> = None;
		match first {
			ValueNode::Str { value, .. } => {
				let mut v = value.trim().to_owned();
				// Only the first line continuation goes (the pattern has no `g`).
				if let Some(pos) = v.find("\\\n").or_else(|| v.find("\\\r")) {
					v.replace_range(pos..pos + 2, "");
				}
				if v.is_empty() {
					replacement = Some(ValueNode::Word(v));
				} else if is_data_url(&v) {
					*value = v;
				} else {
					v = convert_url(&v);
					let has_special = v.chars().any(|c| c.is_control() || c == '\\');
					if !has_special && !v.chars().any(needs_escape) {
						replacement = Some(ValueNode::Word(v));
					} else if !has_special {
						let escaped = escape_url(&v);
						if escaped.encode_utf16().count() < v.encode_utf16().count() + 2 {
							replacement = Some(ValueNode::Word(escaped));
						} else {
							*value = v;
						}
					} else {
						*value = v;
					}
				}
			}
			ValueNode::Word(w) => {
				let t = w.trim().to_owned();
				if t.is_empty() || is_data_url(&t) || t.contains(['\\', ' ']) {
					*w = t;
				} else {
					*w = convert_url(&t);
				}
			}
			_ => {}
		}
		if let Some(r) = replacement {
			*first = r;
		}
		false
	});
}

fn convert_url(url: &str) -> String {
	if is_absolute_url(url) || url.starts_with("//") {
		url.to_owned()
	} else {
		normalize_path(url)
	}
}

fn escape_url(url: &str) -> String {
	let mut out = String::with_capacity(url.len() + 4);
	for c in url.chars() {
		if needs_escape(c) {
			out.push('\\');
		}
		out.push(c);
	}
	out
}

/// `postcss-normalize-url` on a declaration value.
///
/// # Example
///
/// ```
/// use kd_css::strings::normalize_urls;
///
/// assert_eq!(normalize_urls("url( \"a.png\" )"), "url(a.png)");
/// assert_eq!(normalize_urls("url(\"a(b).png\")"), "url(\"a(b).png\")");
/// assert_eq!(normalize_urls("url(./a/../b.png)"), "url(b.png)");
/// ```
pub fn normalize_urls(value: &str) -> String {
	if !value.contains(['u', 'U']) {
		return value.to_owned();
	}
	let mut nodes = parse(value);
	normalize_urls_in(&mut nodes);
	stringify(&nodes)
}
