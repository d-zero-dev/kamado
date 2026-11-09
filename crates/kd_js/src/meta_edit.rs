//! Position-preserving edits of `export const meta = { ... }`.
//!
//! The property that changes is replaced, added after the last one in the
//! layout the object already uses (one per line or inline, the indentation, a
//! trailing comma or none), or removed with its comma and its line; every
//! other byte of the module stays. The object has to be a literal (§4 of the
//! RFC), so no expression is ever rewritten.
//!
//! A value that is written is a literal in the style of the file: strings use
//! the quote the object's strings use most (`"` if there is no string), a key
//! that is a valid identifier is written bare, an array is `[a, b]` and an
//! object `{ k: v }` on one line. The way the replaced value was written (a
//! template literal, a number in hex) is not kept.
//!
//! The way members are laid out (which line, which indentation, which comma) is the same as
//! in `kd_jsonc::edit` and `kd_js::meta_edit`, and the code is written out in both: `kd_js`
//! depends on no other crate, and a crate for ten functions that three layouts of text share
//! would be a dependency of its own. A change to the rules of one is a change to the other.
//!
//! A property whose key is written twice cannot be edited: the later one wins
//! when the module is read, so which one to rewrite is not a question the
//! text answers.

use std::fmt;

use crate::lexer::SyntaxError;
use crate::meta::{Member, MetaPlace, ObjectLayout, locate_meta};
use crate::{Const, strings};

/// Why an edit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
	/// The module does not parse, or `meta` is not a literal.
	Syntax(SyntaxError),
	/// The metadata cannot be edited property by property; the message says
	/// why.
	NotEditable(String),
	/// There is no such key.
	NoSuchKey(String),
}

impl fmt::Display for EditError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			EditError::Syntax(e) => write!(f, "{e}"),
			EditError::NotEditable(why) => f.write_str(why),
			EditError::NoSuchKey(k) => write!(f, "no such key: {k}"),
		}
	}
}

impl std::error::Error for EditError {}

impl From<SyntaxError> for EditError {
	fn from(e: SyntaxError) -> Self {
		EditError::Syntax(e)
	}
}

/// The keys the `meta` object writes more than once (each listed once).
///
/// # Errors
///
/// A [`SyntaxError`] as for [`crate::extract_meta`].
///
/// # Example
///
/// ```
/// let src = "export const meta = { a: 1, b: 2, a: 3 };";
/// assert_eq!(kd_js::meta_edit::duplicate_keys(src, false, true).unwrap(), ["a"]);
/// ```
pub fn duplicate_keys(src: &str, jsx: bool, ts: bool) -> Result<Vec<String>, SyntaxError> {
	let MetaPlace::Object(layout) = locate_meta(src, jsx, ts)? else {
		return Ok(Vec::new());
	};
	let mut out: Vec<String> = Vec::new();
	for (i, m) in layout.members.iter().enumerate() {
		if layout.members[..i].iter().any(|p| p.key == m.key) && !out.contains(&m.key) {
			out.push(m.key.clone());
		}
	}
	Ok(out)
}

/// Why the metadata of the module cannot be edited at all, or `None` if it
/// can (a module without `meta` can get one).
///
/// # Errors
///
/// A [`SyntaxError`] as for [`crate::extract_meta`].
///
/// # Example
///
/// ```
/// use kd_js::meta_edit::not_editable_reason;
/// assert_eq!(not_editable_reason("export const meta = { a: 1 };", false, true).unwrap(), None);
/// assert!(not_editable_reason("export const meta = null;", false, true).unwrap().is_some());
/// ```
pub fn not_editable_reason(src: &str, jsx: bool, ts: bool) -> Result<Option<String>, SyntaxError> {
	Ok(match locate_meta(src, jsx, ts)? {
		MetaPlace::NotAnObject => Some("`meta` is not an object literal".to_string()),
		_ => None,
	})
}

/// Sets `key` of `meta` to `value`: the value is replaced if the key exists,
/// and the property is added after the last one if not. A module without
/// `meta` gets `export const meta = { key: value };` after its last `import`
/// (or, with none, before its first statement, below any comment at the top).
///
/// # Errors
///
/// [`EditError::Syntax`] if the module does not parse, and
/// [`EditError::NotEditable`] if `meta` is not an object literal or the key is
/// written twice.
///
/// # Example
///
/// ```
/// use kd_js::{Const, meta_edit::set_key};
/// let src = "export const meta = {\n\ttitle: 'Old', // the title\n} as const;\n";
/// let out = set_key(src, false, true, "title", &Const::Str("New".into())).unwrap();
/// assert_eq!(out, "export const meta = {\n\ttitle: 'New', // the title\n} as const;\n");
/// let out = set_key(&out, false, true, "layout", &Const::Str("x".into())).unwrap();
/// assert_eq!(out, "export const meta = {\n\ttitle: 'New', // the title\n\tlayout: 'x',\n} as const;\n");
/// ```
pub fn set_key(
	src: &str,
	jsx: bool,
	ts: bool,
	key: &str,
	value: &Const,
) -> Result<String, EditError> {
	if key == "__proto__" {
		// In an object literal `__proto__: v` sets the prototype, even in quotes, and makes
		// no property: a key that reads back as a key and is none when the module runs.
		return Err(EditError::NotEditable(
			"`__proto__` cannot be a key of an object literal".to_string(),
		));
	}
	match locate_meta(src, jsx, ts)? {
		MetaPlace::NotAnObject => Err(EditError::NotEditable(
			"`meta` is not an object literal".to_string(),
		)),
		MetaPlace::Missing {
			insert_at,
			after_import,
		} => {
			let decl = format!(
				"export const meta = {};",
				render(&Const::Object(vec![(key.to_string(), value.clone())]), '"')
			);
			let (head, tail) = (&src[..insert_at], &src[insert_at..]);
			let nl = eol_of(src);
			Ok(if after_import {
				let lead = if head.is_empty() || head.ends_with('\n') {
					nl.to_string()
				} else {
					format!("{nl}{nl}")
				};
				let gap = if tail.is_empty() || tail.starts_with('\n') || tail.starts_with("\r\n") {
					""
				} else {
					nl
				};
				format!("{head}{lead}{decl}{nl}{gap}{tail}")
			} else {
				format!("{head}{decl}{nl}{nl}{tail}")
			})
		}
		MetaPlace::Object(layout) => {
			let quote = if layout.prefers_single_quotes {
				'\''
			} else {
				'"'
			};
			if layout.members.iter().filter(|m| m.key == key).count() > 1 {
				return Err(EditError::NotEditable(format!(
					"the key \"{key}\" is written more than once in `meta`"
				)));
			}
			if let Some(m) = layout.members.iter().find(|m| m.key == key) {
				// A string that replaces a string keeps the quote it was
				// written with.
				let quote = match src.as_bytes().get(m.value_start) {
					Some(b'\'') => '\'',
					Some(b'"') => '"',
					_ => quote,
				};
				return Ok(format!(
					"{}{}{}",
					&src[..m.value_start],
					render(value, quote),
					&src[m.value_end..]
				));
			}
			let style = style_of(src, &layout);
			let head = format!("{}{}", render_key(key, quote), style.key_sep);
			Ok(insert_member(
				src,
				&layout,
				&style,
				&head,
				&render(value, quote),
			))
		}
	}
}

/// Removes the property `key` from `meta`, with its comma and the line it sat
/// on (and a `//` comment at the end of that line).
///
/// # Errors
///
/// [`EditError::NoSuchKey`] if `meta` has no such key; the others as for
/// [`set_key`].
///
/// # Example
///
/// ```
/// use kd_js::meta_edit::delete_key;
/// let src = "export const meta = {\n\ta: 1,\n\tb: 2,\n};\n";
/// assert_eq!(delete_key(src, false, true, "a").unwrap(), "export const meta = {\n\tb: 2,\n};\n");
/// ```
pub fn delete_key(src: &str, jsx: bool, ts: bool, key: &str) -> Result<String, EditError> {
	let layout = match locate_meta(src, jsx, ts)? {
		MetaPlace::Object(layout) => layout,
		MetaPlace::NotAnObject => {
			return Err(EditError::NotEditable(
				"`meta` is not an object literal".to_string(),
			));
		}
		MetaPlace::Missing { .. } => return Err(EditError::NoSuchKey(key.to_string())),
	};
	let hits: Vec<usize> = layout
		.members
		.iter()
		.enumerate()
		.filter(|(_, m)| m.key == key)
		.map(|(i, _)| i)
		.collect();
	match hits.as_slice() {
		[] => Err(EditError::NoSuchKey(key.to_string())),
		[idx] => Ok(remove_member(src, &layout, *idx)),
		_ => Err(EditError::NotEditable(format!(
			"the key \"{key}\" is written more than once in `meta`"
		))),
	}
}

/// The line break the text uses: the first one it has (`\n` if it has none), so that what is
/// added to a file with `\r\n` line breaks has them too.
fn eol_of(text: &str) -> &'static str {
	match text.find('\n') {
		Some(i) if i > 0 && text.as_bytes()[i - 1] == b'\r' => "\r\n",
		_ => "\n",
	}
}

/// One level of indentation, read from the first indented line of the text (a tab if no line
/// is indented).
fn indent_unit(text: &str) -> String {
	for line in text.lines().skip(1) {
		let lead: String = line
			.chars()
			.take_while(|c| matches!(c, ' ' | '\t'))
			.collect();
		if !lead.is_empty() && lead.len() < line.len() {
			return lead;
		}
	}
	"\t".to_string()
}

fn line_start(text: &str, at: usize) -> usize {
	text[..at].rfind('\n').map_or(0, |i| i + 1)
}

fn line_end(text: &str, at: usize) -> usize {
	text[at..].find('\n').map_or(text.len(), |i| at + i)
}

fn is_blank(s: &str) -> bool {
	s.chars().all(|c| matches!(c, ' ' | '\t' | '\r'))
}

fn only_a_line_comment(s: &str) -> bool {
	let t = s.trim_start_matches([' ', '\t']);
	t.is_empty() || t.starts_with("//") || t == "\r"
}

struct Style {
	multiline: bool,
	indent: String,
	gap: String,
	key_sep: String,
	trailing_comma: bool,
}

fn style_of(src: &str, lay: &ObjectLayout) -> Style {
	let Some(last) = lay.members.last() else {
		return Style {
			multiline: false,
			indent: String::new(),
			gap: String::new(),
			key_sep: ": ".to_string(),
			trailing_comma: false,
		};
	};
	let before = if lay.members.len() >= 2 {
		let prev = &lay.members[lay.members.len() - 2];
		prev.comma.map_or(prev.value_end, |c| c + 1)
	} else {
		lay.open + 1
	};
	let gap = &src[before..last.key_start];
	let ls = line_start(src, last.key_start);
	let lead = &src[ls..last.key_start];
	let sep = &src[last.key_end..last.value_start];
	Style {
		multiline: gap.contains('\n'),
		indent: if is_blank(lead) {
			lead.to_string()
		} else {
			String::new()
		},
		gap: if is_blank(gap) {
			gap.to_string()
		} else {
			" ".to_string()
		},
		key_sep: if sep.contains(':') && sep.chars().all(|c| matches!(c, ' ' | '\t' | ':')) {
			sep.to_string()
		} else {
			": ".to_string()
		},
		trailing_comma: last.comma.is_some(),
	}
}

fn insert_member(src: &str, lay: &ObjectLayout, style: &Style, head: &str, value: &str) -> String {
	let Some(last) = lay.members.last() else {
		let interior = &src[lay.open + 1..lay.close];
		let ls = line_start(src, lay.open);
		let base: String = src[ls..lay.open]
			.chars()
			.take_while(|c| matches!(c, ' ' | '\t'))
			.collect();
		let (eol, unit) = (eol_of(src), indent_unit(src));
		let replacement = if interior.contains('\n') {
			if interior.chars().all(char::is_whitespace) {
				format!("{eol}{base}{unit}{head}{value},{eol}{base}")
			} else {
				format!("{eol}{base}{unit}{head}{value},{interior}")
			}
		} else {
			format!(" {head}{value} ")
		};
		return format!(
			"{}{}{}",
			&src[..lay.open + 1],
			replacement,
			&src[lay.close..]
		);
	};
	let after_last = last.comma.map_or(last.value_end, |c| c + 1);
	if style.multiline {
		let eol = line_end(src, after_last);
		// Before the \r of a \r\n, so that the line break the member brings is the only one.
		let place_at_eol = eol <= lay.close && only_a_line_comment(&src[after_last..eol]);
		let at = match (place_at_eol, eol.checked_sub(1)) {
			(true, Some(before)) if before >= after_last && src.as_bytes()[before] == b'\r' => {
				before
			}
			(true, _) => eol,
			(false, _) => after_last,
		};
		let tail = if style.trailing_comma { "," } else { "" };
		let member = format!("{}{}{head}{value}{tail}", eol_of(src), style.indent);
		let mut out = String::with_capacity(src.len() + member.len() + 1);
		out.push_str(&src[..last.value_end]);
		if !style.trailing_comma {
			out.push(',');
		}
		out.push_str(&src[last.value_end..at]);
		out.push_str(&member);
		out.push_str(&src[at..]);
		out
	} else {
		let member = if style.trailing_comma {
			format!("{}{head}{value},", style.gap)
		} else {
			format!(",{}{head}{value}", style.gap)
		};
		format!("{}{}{}", &src[..after_last], member, &src[after_last..])
	}
}

fn remove_member(src: &str, lay: &ObjectLayout, idx: usize) -> String {
	let m: &Member = &lay.members[idx];
	let after = m.comma.map_or(m.value_end, |c| c + 1);
	let ls = line_start(src, m.key_start);
	let le = line_end(src, after);
	let alone = is_blank(&src[ls..m.key_start])
		&& le <= lay.close
		&& only_a_line_comment(&src[after..le])
		&& ls > lay.open;
	let previous_comma = if m.comma.is_none() && idx > 0 {
		lay.members[idx - 1].comma
	} else {
		None
	};
	let mut out = String::with_capacity(src.len());
	if alone {
		let end = if le < src.len() { le + 1 } else { le };
		out.push_str(&src[..ls]);
		out.push_str(&src[end..]);
		if let Some(c) = previous_comma {
			// `c` is before every byte removed above, so it has the same
			// offset in `out`.
			out.replace_range(c..=c, "");
		}
	} else if m.comma.is_some() {
		let mut end = after;
		while matches!(src.as_bytes().get(end), Some(b' ' | b'\t')) {
			end += 1;
		}
		out.push_str(&src[..m.key_start]);
		out.push_str(&src[end..]);
	} else if let Some(c) = previous_comma {
		// Only the comma before the property goes, and the blanks between it and the
		// property; a comment in between stays.
		let gap = &src[c + 1..m.key_start];
		out.push_str(&src[..c]);
		if !is_blank(gap) {
			out.push_str(gap);
		}
		out.push_str(&src[m.value_end..]);
	} else {
		out.push_str(&src[..m.key_start]);
		out.push_str(&src[m.value_end..]);
	}
	collapse_if_empty(&out, lay)
}

/// `{ }` and `{\n}` left behind by removing the only property become `{}`.
fn collapse_if_empty(out: &str, lay: &ObjectLayout) -> String {
	if lay.members.len() != 1 {
		return out.to_string();
	}
	let rest = &out[lay.open + 1..];
	let trimmed = rest.trim_start();
	if trimmed.starts_with('}') {
		let skipped = rest.len() - trimmed.len();
		return format!("{}{}", &out[..lay.open + 1], &out[lay.open + 1 + skipped..]);
	}
	out.to_string()
}

fn render_key(key: &str, quote: char) -> String {
	let ident = key
		.chars()
		.next()
		.is_some_and(|c| c.is_ascii_alphabetic() || matches!(c, '_' | '$'))
		&& key
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '$'));
	if ident {
		key.to_string()
	} else {
		strings::quote_with(key, quote)
	}
}

fn render(value: &Const, quote: char) -> String {
	match value {
		Const::Null => "null".to_string(),
		Const::Bool(true) => "true".to_string(),
		Const::Bool(false) => "false".to_string(),
		Const::Num(n) => render_number(*n),
		Const::Str(s) => strings::quote_with(s, quote),
		Const::Array(items) => {
			let parts: Vec<String> = items.iter().map(|v| render(v, quote)).collect();
			format!("[{}]", parts.join(", "))
		}
		Const::Object(members) if members.is_empty() => "{}".to_string(),
		Const::Object(members) => {
			let parts: Vec<String> = members
				.iter()
				.map(|(k, v)| format!("{}: {}", render_key(k, quote), render(v, quote)))
				.collect();
			format!("{{ {} }}", parts.join(", "))
		}
	}
}

fn render_number(n: f64) -> String {
	if !n.is_finite() {
		"null".to_string()
	} else if n.fract() == 0.0 && n.abs() < 1e15 {
		format!("{}", n as i64)
	} else if n.abs() >= 1e15 || (n != 0.0 && n.abs() < 1e-6) {
		// Rust never writes an exponent otherwise: `1e-300` would be 300 digits.
		format!("{n:e}")
	} else {
		format!("{n}")
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::extract_meta;

	fn s(v: &str) -> Const {
		Const::Str(v.to_string())
	}

	fn n(v: f64) -> Const {
		Const::Num(v)
	}

	fn set(src: &str, key: &str, v: &Const) -> String {
		set_key(src, false, true, key, v).unwrap()
	}

	fn del(src: &str, key: &str) -> String {
		delete_key(src, false, true, key).unwrap()
	}

	fn meta(src: &str) -> Const {
		extract_meta(src, false, true).unwrap().unwrap()
	}

	#[test]
	fn replacing_a_value_keeps_the_rest_of_the_module() {
		let src = "import { x } from './x';\n\n// the page\nexport const meta = {\n\ttitle: 'Old', // t\n\tlayout: \"x\",\n} as const satisfies Meta;\n\nexport default () => null;\n";
		let out = set(src, "title", &s("New"));
		assert_eq!(
			out,
			"import { x } from './x';\n\n// the page\nexport const meta = {\n\ttitle: 'New', // t\n\tlayout: \"x\",\n} as const satisfies Meta;\n\nexport default () => null;\n"
		);
		assert_eq!(
			meta(&out),
			object(vec![("title", s("New")), ("layout", s("x"))])
		);
	}

	fn object(members: Vec<(&str, Const)>) -> Const {
		Const::Object(
			members
				.into_iter()
				.map(|(k, v)| (k.to_string(), v))
				.collect(),
		)
	}

	#[test]
	fn parentheses_signs_and_templates_are_part_of_the_value() {
		let src = "export const meta = ({ a: (1), b: -2, c: `t`, d: +3 }) as const;\n";
		assert_eq!(
			set(src, "a", &n(9.0)),
			"export const meta = ({ a: 9, b: -2, c: `t`, d: +3 }) as const;\n"
		);
		assert_eq!(
			set(src, "b", &n(9.0)),
			"export const meta = ({ a: (1), b: 9, c: `t`, d: +3 }) as const;\n"
		);
		assert_eq!(
			set(src, "c", &s("x")),
			"export const meta = ({ a: (1), b: -2, c: \"x\", d: +3 }) as const;\n"
		);
		assert_eq!(
			set(src, "d", &n(9.0)),
			"export const meta = ({ a: (1), b: -2, c: `t`, d: 9 }) as const;\n"
		);
	}

	#[test]
	fn a_new_string_uses_the_quote_the_object_uses_most() {
		let single = "export const meta = { a: 'x', b: 'y', c: \"z\" };\n";
		assert_eq!(
			set(single, "d", &s("w")),
			"export const meta = { a: 'x', b: 'y', c: \"z\", d: 'w' };\n"
		);
		let double = "export const meta = { a: \"x\" };\n";
		assert_eq!(
			set(double, "d", &s("it's")),
			"export const meta = { a: \"x\", d: \"it's\" };\n"
		);
		assert_eq!(
			set(single, "d", &s("it's")),
			"export const meta = { a: 'x', b: 'y', c: \"z\", d: 'it\\'s' };\n"
		);
	}

	#[test]
	fn keys_that_are_not_identifiers_are_quoted() {
		let src = "export const meta = { a: 1 };\n";
		assert_eq!(
			set(src, "og:title", &s("T")),
			"export const meta = { a: 1, \"og:title\": \"T\" };\n"
		);
		assert_eq!(
			set(src, "1st", &n(1.0)),
			"export const meta = { a: 1, \"1st\": 1 };\n"
		);
	}

	#[test]
	fn adding_follows_the_layout_of_the_object() {
		assert_eq!(
			set("export const meta = {\n\ta: 1,\n\tb: 2\n};\n", "c", &n(3.0)),
			"export const meta = {\n\ta: 1,\n\tb: 2,\n\tc: 3\n};\n"
		);
		assert_eq!(
			set(
				"export const meta = {\n\ta: 1,\n\tb: 2,\n};\n",
				"c",
				&n(3.0)
			),
			"export const meta = {\n\ta: 1,\n\tb: 2,\n\tc: 3,\n};\n"
		);
		assert_eq!(
			set("export const meta = {\n  a: 1, // one\n};\n", "b", &n(2.0)),
			"export const meta = {\n  a: 1, // one\n  b: 2,\n};\n"
		);
		assert_eq!(
			set("export const meta = { a: 1 };\n", "b", &n(2.0)),
			"export const meta = { a: 1, b: 2 };\n"
		);
		assert_eq!(
			set("export const meta = {a:1};\n", "b", &n(2.0)),
			"export const meta = {a:1,b:2};\n"
		);
	}

	#[test]
	fn adding_to_an_empty_object() {
		assert_eq!(
			set("export const meta = {};\n", "a", &n(1.0)),
			"export const meta = { a: 1 };\n"
		);
		assert_eq!(
			set("export const meta = {\n};\n", "a", &n(1.0)),
			"export const meta = {\n\ta: 1,\n};\n"
		);
	}

	#[test]
	fn arrays_and_objects_are_written_on_one_line() {
		let v = Const::Object(vec![
			("title".to_string(), s("T")),
			(
				"tags".to_string(),
				Const::Array(vec![s("a"), n(1.0), Const::Null]),
			),
			("og:x".to_string(), Const::Bool(true)),
		]);
		let out = set("export const meta = { a: 1 };\n", "og", &v);
		assert_eq!(
			out,
			"export const meta = { a: 1, og: { title: \"T\", tags: [\"a\", 1, null], \"og:x\": true } };\n"
		);
		assert_eq!(
			meta(&out),
			object(vec![
				("a", n(1.0)),
				(
					"og",
					object(vec![
						("title", s("T")),
						("tags", Const::Array(vec![s("a"), n(1.0), Const::Null])),
						("og:x", Const::Bool(true)),
					]),
				),
			])
		);
	}

	#[test]
	fn deleting_removes_the_line_the_comma_and_a_trailing_comment() {
		let src = "export const meta = {\n\ta: 1, // one\n\tb: 2,\n\tc: 3\n};\n";
		assert_eq!(
			del(src, "a"),
			"export const meta = {\n\tb: 2,\n\tc: 3\n};\n"
		);
		assert_eq!(
			del(src, "c"),
			"export const meta = {\n\ta: 1, // one\n\tb: 2\n};\n"
		);
	}

	#[test]
	fn deleting_from_an_inline_object() {
		assert_eq!(
			del("export const meta = { a: 1, b: 2, c: 3 };\n", "b"),
			"export const meta = { a: 1, c: 3 };\n"
		);
		assert_eq!(
			del("export const meta = { a: 1, b: 2 };\n", "b"),
			"export const meta = { a: 1 };\n"
		);
		assert_eq!(
			del("export const meta = { a: 1 };\n", "a"),
			"export const meta = {};\n"
		);
	}

	#[test]
	fn deleting_the_last_property_keeps_the_comments_between_it_and_the_one_before() {
		assert_eq!(
			del("export const meta = { a: 1, /* keep */ b: 2 };\n", "b"),
			"export const meta = { a: 1 /* keep */  };\n"
		);
		assert_eq!(
			del("export const meta = { a: 1, // note\n  b: 2 };\n", "b"),
			"export const meta = { a: 1 // note\n   };\n"
		);
	}

	#[test]
	fn what_is_added_follows_the_line_breaks_and_the_indentation_of_the_file() {
		assert_eq!(
			set(
				"export const meta = {\r\n\ta: 1,\r\n\tb: 2,\r\n};\r\n",
				"c",
				&n(3.0)
			),
			"export const meta = {\r\n\ta: 1,\r\n\tb: 2,\r\n\tc: 3,\r\n};\r\n"
		);
		assert_eq!(
			set("export const meta = {\r\n};\r\n", "c", &n(3.0)),
			"export const meta = {\r\n\tc: 3,\r\n};\r\n"
		);
		// a module without meta
		assert_eq!(
			set("import a from 'a';\r\nexport default a;\r\n", "t", &n(1.0)),
			"import a from 'a';\r\n\r\nexport const meta = { t: 1 };\r\n\r\nexport default a;\r\n"
		);
		assert_eq!(
			set("export default 1;\r\n", "t", &n(1.0)),
			"export const meta = { t: 1 };\r\n\r\nexport default 1;\r\n"
		);
		// four spaces
		assert_eq!(
			set(
				"export default 1;\nexport const meta = {\n    o: {\n    },\n};\n",
				"z",
				&n(1.0)
			),
			"export default 1;\nexport const meta = {\n    o: {\n    },\n    z: 1,\n};\n"
		);
	}

	#[test]
	fn the_proto_key_is_no_key_of_an_object_literal() {
		assert!(matches!(
			set_key(
				"export const meta = { a: 1 };",
				false,
				true,
				"__proto__",
				&s("x")
			)
			.unwrap_err(),
			EditError::NotEditable(_)
		));
		assert!(matches!(
			set_key("export default 1;", false, true, "__proto__", &s("x")).unwrap_err(),
			EditError::NotEditable(_)
		));
	}

	#[test]
	fn the_specifiers_of_type_only_statements_are_found_though_they_are_no_imports() {
		let src = "import type { A } from '../a';\nexport type { B } from \"./b\";\nimport { c } from './c';\nexport const meta = {};\n";
		let parsed = crate::parser::Parser::parse(src, false, true).unwrap();
		let erased: Vec<&str> = parsed
			.info
			.erased_imports
			.iter()
			.map(|&(start, end)| &src[start..end])
			.collect();
		assert_eq!(erased, ["'../a'", "\"./b\""]);
		let imported: Vec<&str> = parsed
			.imports
			.iter()
			.map(|i| i.specifier.as_str())
			.collect();
		assert_eq!(imported, ["./c"]);
	}

	#[test]
	fn numbers_are_written_so_that_they_read_back() {
		for value in [
			0.0,
			-0.0,
			1.0,
			-1.0,
			0.5,
			-0.25,
			1e15,
			1e21,
			-1e21,
			1e-6,
			1e-7,
			1e-300,
			1.7976931348623157e308,
			123456789012345680.0,
			0.1 + 0.2,
		] {
			let out = set("export const meta = { a: 0 };", "a", &n(value));
			let Const::Object(members) = meta(&out) else {
				panic!("object")
			};
			assert_eq!(members[0].1, n(value), "{value:e} in {out}");
			assert!(out.len() < 60, "{out}");
		}
	}

	#[test]
	fn deleting_a_missing_key_or_from_a_module_without_meta_is_an_error() {
		assert_eq!(
			delete_key("export const meta = {};", false, true, "a").unwrap_err(),
			EditError::NoSuchKey("a".to_string())
		);
		assert_eq!(
			delete_key("export default 1;", false, true, "a").unwrap_err(),
			EditError::NoSuchKey("a".to_string())
		);
	}

	#[test]
	fn a_key_written_twice_cannot_be_edited_but_the_others_can() {
		let src = "export const meta = { a: 1, b: 2, a: 3 };\n";
		assert_eq!(duplicate_keys(src, false, true).unwrap(), ["a"]);
		assert!(matches!(
			set_key(src, false, true, "a", &n(9.0)).unwrap_err(),
			EditError::NotEditable(_)
		));
		assert!(matches!(
			delete_key(src, false, true, "a").unwrap_err(),
			EditError::NotEditable(_)
		));
		assert_eq!(
			set(src, "b", &n(9.0)),
			"export const meta = { a: 1, b: 9, a: 3 };\n"
		);
	}

	#[test]
	fn meta_that_is_not_an_object_cannot_be_edited() {
		for src in ["export const meta = null;\n", "export const meta = [1];\n"] {
			assert!(not_editable_reason(src, false, true).unwrap().is_some());
			assert!(matches!(
				set_key(src, false, true, "a", &n(1.0)).unwrap_err(),
				EditError::NotEditable(_)
			));
		}
	}

	#[test]
	fn a_module_without_meta_gets_one_after_the_last_import() {
		let src =
			"import a from './a';\nimport {\n\tb,\n} from './b';\n\nexport default () => a + b;\n";
		assert_eq!(
			set(src, "title", &s("T")),
			"import a from './a';\nimport {\n\tb,\n} from './b';\n\nexport const meta = { title: \"T\" };\n\nexport default () => a + b;\n"
		);
		let out = set(src, "title", &s("T"));
		assert_eq!(
			meta(&out),
			Const::Object(vec![("title".to_string(), s("T"))])
		);
	}

	#[test]
	fn a_module_without_meta_gets_one_after_its_directives() {
		let src = "'use strict';\n\nexport default () => null;\n";
		assert_eq!(
			set(src, "title", &s("T")),
			"'use strict';\n\nexport const meta = { title: \"T\" };\n\nexport default () => null;\n"
		);
		let src = "\"use client\"\nexport default () => null;\n";
		let out = set(src, "title", &s("T"));
		assert!(
			out.starts_with("\"use client\"\n\nexport const meta"),
			"{out}"
		);
		assert_eq!(
			meta(&out),
			Const::Object(vec![("title".to_string(), s("T"))])
		);
		// a string that is not a directive is code
		let src = "'a' + 'b';\nexport default () => null;\n";
		assert!(set(src, "t", &n(1.0)).starts_with("export const meta"));
	}

	#[test]
	fn the_declaration_goes_after_the_whole_import_statement() {
		// code on the line of the import
		let src = "import a from 'a'; const x = 1;\nexport default () => a + x;\n";
		let out = set(src, "t", &n(1.0));
		assert_eq!(
			out,
			"import a from 'a';\n\nexport const meta = { t: 1 };\n\n const x = 1;\nexport default () => a + x;\n"
		);
		// a block comment that goes on to the next lines
		let src = "import a from 'a'; /* multi\nline */\nexport default () => a;\n";
		let out = set(src, "t", &n(1.0));
		assert!(out.contains("/* multi\nline */"), "{out}");
		assert_eq!(meta(&out), Const::Object(vec![("t".to_string(), n(1.0))]));
		// import attributes
		let src =
			"import data from './d.json' with { type: 'json' };\nexport default () => data;\n";
		let out = set(src, "t", &n(1.0));
		assert_eq!(
			out,
			"import data from './d.json' with { type: 'json' };\n\nexport const meta = { t: 1 };\n\nexport default () => data;\n"
		);
		// a line comment after the import stays on its line
		let src = "import a from 'a'; // the a\nexport default () => a;\n";
		assert_eq!(
			set(src, "t", &n(1.0)),
			"import a from 'a'; // the a\n\nexport const meta = { t: 1 };\n\nexport default () => a;\n"
		);
	}

	#[test]
	fn the_declaration_goes_below_the_imports_of_types_too() {
		let src = "import a from 'a';\nimport type { T } from './t';\nexport default () => a;\n";
		assert_eq!(
			set(src, "t", &n(1.0)),
			"import a from 'a';\nimport type { T } from './t';\n\nexport const meta = { t: 1 };\n\nexport default () => a;\n"
		);
		// a module that has nothing but types imported
		let src = "import type { T } from './t';\nexport default () => 1;\n";
		assert_eq!(
			set(src, "t", &n(1.0)),
			"import type { T } from './t';\n\nexport const meta = { t: 1 };\n\nexport default () => 1;\n"
		);
	}

	#[test]
	fn a_module_without_imports_gets_meta_below_the_comment_at_the_top() {
		let src = "/** @jsxImportSource kamado */\n\nexport default () => null;\n";
		assert_eq!(
			set(src, "title", &s("T")),
			"/** @jsxImportSource kamado */\n\nexport const meta = { title: \"T\" };\n\nexport default () => null;\n"
		);
		assert_eq!(set("", "a", &n(1.0)), "export const meta = { a: 1 };\n\n");
	}

	#[test]
	fn meta_with_a_type_annotation_and_jsx_modules_are_edited_too() {
		let src = "export const meta: Meta = { a: 1 };\nexport default () => <p />;\n";
		let out = set_key(src, true, true, "a", &n(2.0)).unwrap();
		assert_eq!(
			out,
			"export const meta: Meta = { a: 2 };\nexport default () => <p />;\n"
		);
		let js = "export const meta = { a: 1 };\nexport default () => <p />;\n";
		assert_eq!(
			set_key(js, true, false, "b", &n(2.0)).unwrap(),
			"export const meta = { a: 1, b: 2 };\nexport default () => <p />;\n"
		);
	}

	#[test]
	fn a_module_that_does_not_parse_is_a_syntax_error() {
		assert!(matches!(
			set_key("export const meta = {", false, true, "a", &n(1.0)).unwrap_err(),
			EditError::Syntax(_)
		));
		assert!(matches!(
			set_key("export const meta = { a: foo };", false, true, "a", &n(1.0)).unwrap_err(),
			EditError::Syntax(_)
		));
	}

	#[test]
	fn every_edit_reads_back_as_the_intended_meta() {
		let src = "export const meta = {\n\ttitle: 'T',\n\ttags: ['a', 'b'],\n\t'og:image': \"x.png\",\n};\n";
		let tags = || Const::Array(vec![s("a"), s("b")]);
		let out = set(src, "title", &s("U"));
		assert_eq!(
			meta(&out),
			object(vec![
				("title", s("U")),
				("tags", tags()),
				("og:image", s("x.png")),
			])
		);
		let out = set(src, "new", &Const::Array(vec![n(1.0), s("x")]));
		assert_eq!(
			meta(&out),
			object(vec![
				("title", s("T")),
				("tags", tags()),
				("og:image", s("x.png")),
				("new", Const::Array(vec![n(1.0), s("x")])),
			])
		);
		let out = del(src, "tags");
		let Const::Object(rest) = meta(&out) else {
			panic!("object")
		};
		let keys: Vec<&str> = rest.iter().map(|(k, _)| k.as_str()).collect();
		assert_eq!(keys, ["title", "og:image"]);
	}
}
