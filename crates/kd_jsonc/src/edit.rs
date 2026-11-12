//! Position-preserving edits of JSONC text.
//!
//! The parser drops comments, quoting and layout, and [`crate::Value::to_json`]
//! writes compact JSON, so rewriting a sidecar or `pages.overrides` through
//! them would erase every comment and reflow the file. These functions change
//! only the member that is edited: a value is replaced in place, a member is
//! added after the last one in the layout the object already uses (one line
//! per member or inline, the indentation, a trailing comma or none), and a
//! member is removed with its comma and the line it sat on.
//!
//! The way members are laid out (which line, which indentation, which comma) is the same as
//! in `kd_jsonc::edit` and `kd_js::meta_edit`, and the code is written out in both: `kd_js`
//! depends on no other crate, and a crate for ten functions that three layouts of text share
//! would be a dependency of its own. A change to the rules of one is a change to the other.
//!
//! Why not a full pretty-printer: the files are written by people and by
//! other tools, so "the same bytes everywhere else" is the contract, and no
//! style of ours would match all of them.
//!
//! A value that is written (`set_member`, `push_element`) is compact JSON, wherever it goes.
//!
//! The items of an array are laid out by the same rules as the members of an object
//! (`push_element` adds after the last item, `delete_element` removes one with its comma):
//! `pages.overrides` is an array of entries, and a page that is added or removed is one item.

use std::fmt;

use crate::{Error, Parser, Value, parse};

/// One step of the path to a container: an object key or an array index.
///
/// # Example
///
/// ```
/// use kd_jsonc::edit::{Seg, member_range};
/// let text = r#"{ "pages": [ { "url": "/a/" } ] }"#;
/// let path = [Seg::Key("pages"), Seg::Index(0)];
/// let (start, end) = member_range(text, &path, "url").unwrap().unwrap();
/// assert_eq!(&text[start..end], r#""/a/""#);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Seg<'a> {
	/// The value of an object key.
	Key(&'a str),
	/// The item of an array.
	Index(usize),
}

/// Why an edit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
	/// The text is not valid JSONC.
	Parse(Error),
	/// The path does not lead to a value.
	NoSuchPath(String),
	/// The path leads to a value that is not an object or an array.
	NotAContainer(String),
	/// The object has no such key.
	NoSuchKey(String),
}

impl fmt::Display for EditError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			EditError::Parse(e) => write!(f, "invalid JSON: {e}"),
			EditError::NoSuchPath(p) => write!(f, "no such path: {p}"),
			EditError::NotAContainer(p) => write!(f, "not an object or an array: {p}"),
			EditError::NoSuchKey(k) => write!(f, "no such key: {k}"),
		}
	}
}

impl std::error::Error for EditError {}

impl From<Error> for EditError {
	fn from(e: Error) -> Self {
		EditError::Parse(e)
	}
}

/// One member of an object or one item of an array, as byte offsets.
#[derive(Debug, Clone)]
struct Entry {
	key: Option<String>,
	/// First byte of the key (object) or of the value (array).
	start: usize,
	/// End of the key's closing quote (object); `start` for an array item.
	key_end: usize,
	value_start: usize,
	value_end: usize,
	/// The `,` after this entry, if any.
	comma: Option<usize>,
}

#[derive(Debug, Clone)]
struct Layout {
	open: usize,
	close: usize,
	object: bool,
	entries: Vec<Entry>,
}

fn path_text(path: &[Seg<'_>]) -> String {
	let mut out = String::from("$");
	for seg in path {
		match seg {
			Seg::Key(k) => {
				out.push('.');
				out.push_str(k);
			}
			Seg::Index(i) => out.push_str(&format!("[{i}]")),
		}
	}
	out
}

/// Reads the container at the cursor. With `until`, it stops at the entry that `until` names
/// (a container on the way to a value need not be read to its end, and nor does the value of
/// the entry that is wanted, unless its end is: the flag): the layout it returns then has no
/// `close`.
fn scan_container(
	p: &mut Parser<'_>,
	at: &str,
	until: Option<(&Seg<'_>, bool)>,
) -> Result<Layout, EditError> {
	let open = p.pos;
	let object = match p.peek() {
		Some(b'{') => true,
		Some(b'[') => false,
		_ => return Err(EditError::NotAContainer(at.to_string())),
	};
	let closer = if object { b'}' } else { b']' };
	p.pos += 1;
	let mut entries = Vec::new();
	loop {
		p.skip_trivia()?;
		match p.peek() {
			Some(c) if c == closer => {
				return Ok(Layout {
					open,
					close: p.pos,
					object,
					entries,
				});
			}
			None => return Err(EditError::NoSuchPath(at.to_string())),
			Some(_) => {}
		}
		let start = p.pos;
		let (key, key_end) = if object {
			let k = p.parse_string()?;
			let end = p.pos;
			p.skip_trivia()?;
			// The text was parsed once already, so this is the ':'.
			p.pos += 1;
			p.skip_trivia()?;
			(Some(k), end)
		} else {
			(None, start)
		};
		let value_start = p.pos;
		let wanted = match until {
			Some((Seg::Key(k), _)) => key.as_deref() == Some(*k),
			Some((Seg::Index(n), _)) => !object && entries.len() == *n,
			None => false,
		};
		if wanted && matches!(until, Some((_, false))) {
			entries.push(Entry {
				key,
				start,
				key_end,
				value_start,
				value_end: value_start,
				comma: None,
			});
			return Ok(Layout {
				open,
				close: usize::MAX,
				object,
				entries,
			});
		}
		p.parse_value()?;
		let value_end = p.pos;
		p.skip_trivia()?;
		let comma = if p.peek() == Some(b',') {
			let c = p.pos;
			p.pos += 1;
			Some(c)
		} else {
			None
		};
		entries.push(Entry {
			key,
			start,
			key_end,
			value_start,
			value_end,
			comma,
		});
		if wanted {
			return Ok(Layout {
				open,
				close: usize::MAX,
				object,
				entries,
			});
		}
	}
}

/// Goes down `path` and returns the parser at the start of the value it leads to, with the entry
/// that holds the value (none for the root). If `validate`, the whole text is parsed first (a
/// text with a syntax error or a repeated key is refused before any offset is trusted).
fn descend<'a>(
	text: &'a str,
	path: &[Seg<'_>],
	validate: bool,
	end_of_last: bool,
) -> Result<(Parser<'a>, Option<Entry>), EditError> {
	if validate {
		parse(text)?;
	}
	let bom = if text.starts_with('\u{FEFF}') { 3 } else { 0 };
	let mut p = Parser {
		bytes: text.as_bytes(),
		pos: bom,
		depth: 0,
	};
	p.skip_trivia()?;
	let mut held: Option<Entry> = None;
	for (i, seg) in path.iter().enumerate() {
		let here = path_text(&path[..i]);
		let last = i + 1 == path.len();
		let lay = scan_container(&mut p, &here, Some((seg, last && end_of_last)))?;
		let entry = match seg {
			Seg::Key(k) => lay.entries.iter().find(|e| e.key.as_deref() == Some(*k)),
			Seg::Index(n) if !lay.object => lay.entries.get(*n),
			Seg::Index(_) => None,
		};
		let Some(entry) = entry else {
			return Err(EditError::NoSuchPath(path_text(&path[..=i])));
		};
		p.pos = entry.value_start;
		held = Some(entry.clone());
	}
	Ok((p, held))
}

/// The layout of the object or array at `path`.
fn locate(text: &str, path: &[Seg<'_>], validate: bool) -> Result<Layout, EditError> {
	let (mut p, _) = descend(text, path, validate, false)?;
	scan_container(&mut p, &path_text(path), None)
}

/// The byte range of the value at `path` (an object member, an array item).
fn range_of(text: &str, path: &[Seg<'_>], validate: bool) -> Result<(usize, usize), EditError> {
	let (_, held) = descend(text, path, validate, true)?;
	held.map(|e| (e.value_start, e.value_end))
		.ok_or_else(|| EditError::NoSuchPath(path_text(path)))
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

/// True if the rest of a line holds nothing but blanks or a `//` comment.
fn only_a_line_comment(s: &str) -> bool {
	let t = s.trim_start_matches([' ', '\t']);
	t.is_empty() || t.starts_with("//") || t == "\r"
}

/// How the entries of a container are laid out, read from its last entry.
struct Style {
	multiline: bool,
	indent: String,
	/// Whitespace between the previous token and the last entry (inline layout).
	gap: String,
	/// The text between a key and its value (`": "`, `":"`).
	key_sep: String,
	trailing_comma: bool,
}

fn style_of(text: &str, lay: &Layout) -> Style {
	let Some(last) = lay.entries.last() else {
		return Style {
			multiline: false,
			indent: String::new(),
			gap: String::new(),
			key_sep: ": ".to_string(),
			trailing_comma: false,
		};
	};
	let before = if lay.entries.len() >= 2 {
		let prev = &lay.entries[lay.entries.len() - 2];
		prev.comma.map_or(prev.value_end, |c| c + 1)
	} else {
		lay.open + 1
	};
	let gap = &text[before..last.start];
	let multiline = gap.contains('\n');
	let ls = line_start(text, last.start);
	let lead = &text[ls..last.start];
	let indent = if is_blank(lead) {
		lead.to_string()
	} else {
		String::new()
	};
	let key_sep = if lay.object {
		let sep = &text[last.key_end..last.value_start];
		if sep.contains(':') && sep.chars().all(|c| matches!(c, ' ' | '\t' | ':')) {
			sep.to_string()
		} else {
			": ".to_string()
		}
	} else {
		String::new()
	};
	Style {
		multiline,
		indent,
		gap: if is_blank(gap) {
			gap.to_string()
		} else {
			" ".to_string()
		},
		key_sep,
		trailing_comma: last.comma.is_some(),
	}
}

/// Inserts one entry (`head` is `"key": ` for an object, empty for an array,
/// `value` the text of the value) after the last entry, or into an empty
/// container.
fn insert_entry(text: &str, lay: &Layout, head: &str, value: &str) -> String {
	let Some(last) = lay.entries.last() else {
		let interior = &text[lay.open + 1..lay.close];
		let base = {
			let ls = line_start(text, lay.open);
			let lead = &text[ls..lay.open];
			let indent: String = lead
				.chars()
				.take_while(|c| matches!(c, ' ' | '\t'))
				.collect();
			indent
		};
		let (eol, unit) = (eol_of(text), indent_unit(text));
		let replacement = if interior.contains('\n') {
			if is_blank(&interior.replace('\n', "")) {
				format!("{eol}{base}{unit}{head}{value}{eol}{base}")
			} else {
				format!("{eol}{base}{unit}{head}{value}{interior}")
			}
		} else if lay.object {
			format!(" {head}{value} ")
		} else {
			format!("{head}{value}")
		};
		return format!(
			"{}{}{}",
			&text[..lay.open + 1],
			replacement,
			&text[lay.close..]
		);
	};
	let style = style_of(text, lay);
	let after_last = last.comma.map_or(last.value_end, |c| c + 1);
	if style.multiline {
		let eol = line_end(text, after_last);
		let place_at_eol = eol <= lay.close && only_a_line_comment(&text[after_last..eol]);
		// Before the \r of a \r\n, so that the line break the member brings is the only one.
		let at = match (place_at_eol, eol.checked_sub(1)) {
			(true, Some(before)) if before >= after_last && text.as_bytes()[before] == b'\r' => {
				before
			}
			(true, _) => eol,
			(false, _) => after_last,
		};
		let tail = if style.trailing_comma { "," } else { "" };
		let member = format!("{}{}{head}{value}{tail}", eol_of(text), style.indent);
		let mut out = String::with_capacity(text.len() + member.len() + 1);
		out.push_str(&text[..last.value_end]);
		if !style.trailing_comma {
			out.push(',');
		}
		out.push_str(&text[last.value_end..at]);
		out.push_str(&member);
		out.push_str(&text[at..]);
		out
	} else {
		let member = if style.trailing_comma {
			format!("{}{head}{value},", style.gap)
		} else {
			format!(",{}{head}{value}", style.gap)
		};
		format!("{}{}{}", &text[..after_last], member, &text[after_last..])
	}
}

fn key_head(text: &str, lay: &Layout, key: &str) -> String {
	let style = style_of(text, lay);
	let mut head = Value::String(key.to_string()).to_json();
	head.push_str(&style.key_sep);
	head
}

/// Sets `key` of the object at `path` to `value`: the value is replaced in
/// place if the key exists, and the member is added after the last one if
/// not.
///
/// # Errors
///
/// [`EditError`] if the text is not valid, or `path` does not lead to an
/// object.
///
/// # Example
///
/// ```
/// use kd_jsonc::Value;
/// use kd_jsonc::edit::set_member;
/// let text = "{\n\t// the title\n\t\"title\": \"A\",\n\t\"layout\": \"x\"\n}\n";
/// let out = set_member(text, &[], "title", &Value::String("B".into())).unwrap();
/// assert_eq!(out, "{\n\t// the title\n\t\"title\": \"B\",\n\t\"layout\": \"x\"\n}\n");
/// let out = set_member(&out, &[], "og", &Value::Bool(true)).unwrap();
/// assert!(out.ends_with("\t\"layout\": \"x\",\n\t\"og\": true\n}\n"));
/// ```
pub fn set_member(
	text: &str,
	path: &[Seg<'_>],
	key: &str,
	value: &Value,
) -> Result<String, EditError> {
	set_member_in(text, path, key, value, true)
}

fn set_member_in(
	text: &str,
	path: &[Seg<'_>],
	key: &str,
	value: &Value,
	validate: bool,
) -> Result<String, EditError> {
	let lay = locate(text, path, validate)?;
	if !lay.object {
		return Err(EditError::NotAContainer(path_text(path)));
	}
	let rendered = value.to_json();
	if let Some(e) = lay.entries.iter().find(|e| e.key.as_deref() == Some(key)) {
		return Ok(format!(
			"{}{}{}",
			&text[..e.value_start],
			rendered,
			&text[e.value_end..]
		));
	}
	let head = key_head(text, &lay, key);
	Ok(insert_entry(text, &lay, &head, &rendered))
}

/// Removes `key` from the object at `path`, with its comma and the line it
/// sat on (and a `//` comment at the end of that line).
///
/// # Errors
///
/// [`EditError::NoSuchKey`] if the object has no such key; the others as for
/// [`set_member`].
///
/// # Example
///
/// ```
/// use kd_jsonc::edit::delete_member;
/// let text = "{\n\t\"a\": 1, // one\n\t\"b\": 2\n}\n";
/// assert_eq!(delete_member(text, &[], "b").unwrap(), "{\n\t\"a\": 1 // one\n}\n");
/// ```
pub fn delete_member(text: &str, path: &[Seg<'_>], key: &str) -> Result<String, EditError> {
	delete_member_in(text, path, key, true)
}

fn delete_member_in(
	text: &str,
	path: &[Seg<'_>],
	key: &str,
	validate: bool,
) -> Result<String, EditError> {
	let lay = locate(text, path, validate)?;
	if !lay.object {
		return Err(EditError::NotAContainer(path_text(path)));
	}
	let Some(idx) = lay
		.entries
		.iter()
		.position(|e| e.key.as_deref() == Some(key))
	else {
		return Err(EditError::NoSuchKey(key.to_string()));
	};
	Ok(remove_entry(text, &lay, idx))
}

/// Adds `value` as the last item of the array at `path`, in the layout the array already uses
/// (one line per item or inline, the indentation, a trailing comma or none). An empty array
/// that is written on one line gets the item on that line; one that spans lines gets it on a
/// line of its own, one level deeper than the array.
///
/// # Errors
///
/// [`EditError`] if the text is not valid, or `path` does not lead to an array.
///
/// # Example
///
/// ```
/// use kd_jsonc::edit::{Seg, push_element};
/// let text = "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }\n\t]\n}\n";
/// let entry = kd_jsonc::parse(r#"{"url":"/b/","virtual":true}"#).unwrap();
/// assert_eq!(
///     push_element(text, &[Seg::Key("pages")], &entry).unwrap(),
///     "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{\"url\":\"/b/\",\"virtual\":true}\n\t]\n}\n"
/// );
/// ```
pub fn push_element(text: &str, path: &[Seg<'_>], value: &Value) -> Result<String, EditError> {
	push_element_in(text, path, value, true)
}

fn push_element_in(
	text: &str,
	path: &[Seg<'_>],
	value: &Value,
	validate: bool,
) -> Result<String, EditError> {
	let lay = locate(text, path, validate)?;
	if lay.object {
		return Err(EditError::NotAContainer(path_text(path)));
	}
	Ok(insert_entry(text, &lay, "", &value.to_json()))
}

/// Removes the item `index` of the array at `path`, with its comma and the lines it sat on
/// (and a `//` comment at the end of its last line).
///
/// # Errors
///
/// [`EditError::NoSuchPath`] if the array has no such item; the others as for
/// [`push_element`].
///
/// # Example
///
/// ```
/// use kd_jsonc::edit::{Seg, delete_element};
/// let text = "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" }\n\t]\n}\n";
/// assert_eq!(
///     delete_element(text, &[Seg::Key("pages")], 1).unwrap(),
///     "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }\n\t]\n}\n"
/// );
/// ```
pub fn delete_element(text: &str, path: &[Seg<'_>], index: usize) -> Result<String, EditError> {
	delete_element_in(text, path, index, true)
}

fn delete_element_in(
	text: &str,
	path: &[Seg<'_>],
	index: usize,
	validate: bool,
) -> Result<String, EditError> {
	let lay = locate(text, path, validate)?;
	if lay.object {
		return Err(EditError::NotAContainer(path_text(path)));
	}
	if index >= lay.entries.len() {
		return Err(EditError::NoSuchPath(format!(
			"{}[{index}]",
			path_text(path)
		)));
	}
	Ok(remove_entry(text, &lay, index))
}

fn remove_entry(text: &str, lay: &Layout, idx: usize) -> String {
	let e = &lay.entries[idx];
	let after = e.comma.map_or(e.value_end, |c| c + 1);
	let ls = line_start(text, e.start);
	let le = line_end(text, after);
	let alone_on_its_lines = is_blank(&text[ls..e.start])
		&& le <= lay.close
		&& only_a_line_comment(&text[after..le])
		&& ls > lay.open;
	// The comma that must go with the entry: its own, or, for the last entry
	// that had none, the previous entry's.
	let previous_comma = if e.comma.is_none() && idx > 0 {
		lay.entries[idx - 1].comma
	} else {
		None
	};
	let mut out = String::with_capacity(text.len());
	if alone_on_its_lines {
		let end = if le < text.len() { le + 1 } else { le };
		let start_cut = ls;
		out.push_str(&text[..start_cut]);
		out.push_str(&text[end..]);
	} else if e.comma.is_some() {
		let mut end = after;
		while matches!(text.as_bytes().get(end), Some(b' ' | b'\t')) {
			end += 1;
		}
		out.push_str(&text[..e.start]);
		out.push_str(&text[end..]);
	} else if let Some(c) = previous_comma {
		// Only the comma before the entry goes, and the blanks between it and the entry;
		// a comment in between stays.
		let gap = &text[c + 1..e.start];
		out.push_str(&text[..c]);
		if !is_blank(gap) {
			out.push_str(gap);
		}
		out.push_str(&text[e.value_end..]);
		return collapse_if_empty(&out, lay);
	} else {
		out.push_str(&text[..e.start]);
		out.push_str(&text[e.value_end..]);
	}
	if let (Some(c), true) = (previous_comma, alone_on_its_lines) {
		// `c` is before every byte removed above, so it has the same offset
		// in `out`.
		out.replace_range(c..=c, "");
	}
	collapse_if_empty(&out, lay)
}

/// `{ }` and `{\n}` left behind by removing the only member become `{}`.
fn collapse_if_empty(out: &str, lay: &Layout) -> String {
	if lay.entries.len() != 1 {
		return out.to_string();
	}
	let Ok(fresh) = locate_at(out, lay.open) else {
		return out.to_string();
	};
	let interior = &out[fresh.open + 1..fresh.close];
	if fresh.entries.is_empty() && interior.chars().all(char::is_whitespace) {
		return format!("{}{}", &out[..fresh.open + 1], &out[fresh.close..]);
	}
	out.to_string()
}

/// The layout of the container whose opening bracket is at `open`.
fn locate_at(text: &str, open: usize) -> Result<Layout, EditError> {
	let mut p = Parser {
		bytes: text.as_bytes(),
		pos: open,
		depth: 0,
	};
	scan_container(&mut p, "$", None)
}

/// The byte range of the value of `key` in the object at `path` (`None` if the object has no
/// such key): what a caller needs to know, before editing, whether a member is there and
/// where.
///
/// # Errors
///
/// As for [`set_member`].
///
/// # Example
///
/// ```
/// use kd_jsonc::edit::member_range;
/// let text = r#"{ "a": 1, "b": [2, 3] }"#;
/// let (start, end) = member_range(text, &[], "b").unwrap().unwrap();
/// assert_eq!(&text[start..end], "[2, 3]");
/// ```
pub fn member_range(
	text: &str,
	path: &[Seg<'_>],
	key: &str,
) -> Result<Option<(usize, usize)>, EditError> {
	let lay = locate(text, path, true)?;
	Ok(lay
		.entries
		.iter()
		.find(|e| e.key.as_deref() == Some(key))
		.map(|e| (e.value_start, e.value_end)))
}

/// Text that the caller has parsed (with [`crate::parse`] or a parser built on it) and found
/// valid: the edits of it skip the validation that [`set_member`] and [`delete_member`] make,
/// and read no more of the text than the way to the container they edit. Why: the validation
/// is a parse of the whole text, and on a file of megabytes (the `pages.overrides` of a site of a
/// hundred thousand pages) it is most of what an edit costs. A text that is not valid gives
/// no error or a wrong one, and what is written has to be checked by whoever trusts the text.
///
/// # Example
///
/// ```
/// use kd_jsonc::{Value, edit::{Seg, trusted}};
/// let text = r#"{ "pages": [ { "url": "/a/" }, { "url": "/b/" } ] }"#;
/// kd_jsonc::parse(text).unwrap();
/// let edited = trusted(text)
///     .set_member(&[Seg::Key("pages"), Seg::Index(1)], "url", &Value::String("/c/".into()))
///     .unwrap();
/// assert_eq!(edited, r#"{ "pages": [ { "url": "/a/" }, { "url": "/c/" } ] }"#);
/// ```
#[derive(Debug, Clone, Copy)]
pub struct Trusted<'a>(&'a str);

/// Marks `text` as parsed and valid (see [`Trusted`]).
#[must_use]
pub fn trusted(text: &str) -> Trusted<'_> {
	Trusted(text)
}

impl Trusted<'_> {
	/// [`set_member`] without the validation.
	///
	/// # Errors
	///
	/// As for [`set_member`].
	pub fn set_member(
		&self,
		path: &[Seg<'_>],
		key: &str,
		value: &Value,
	) -> Result<String, EditError> {
		set_member_in(self.0, path, key, value, false)
	}

	/// [`delete_member`] without the validation.
	///
	/// # Errors
	///
	/// As for [`delete_member`].
	pub fn delete_member(&self, path: &[Seg<'_>], key: &str) -> Result<String, EditError> {
		delete_member_in(self.0, path, key, false)
	}

	/// [`push_element`] without the validation.
	///
	/// # Errors
	///
	/// As for [`push_element`].
	pub fn push_element(&self, path: &[Seg<'_>], value: &Value) -> Result<String, EditError> {
		push_element_in(self.0, path, value, false)
	}

	/// [`delete_element`] without the validation.
	///
	/// # Errors
	///
	/// As for [`delete_element`].
	pub fn delete_element(&self, path: &[Seg<'_>], index: usize) -> Result<String, EditError> {
		delete_element_in(self.0, path, index, false)
	}

	/// The byte range of the value at `path`: an object member or an array item.
	///
	/// # Errors
	///
	/// [`EditError::NoSuchPath`] if the path leads to no value.
	pub fn value_range(&self, path: &[Seg<'_>]) -> Result<(usize, usize), EditError> {
		range_of(self.0, path, false)
	}

	/// The byte range of the value of every entry of the container at `path` (the items of an
	/// array, the members of an object, in the order they are written), read in one pass. Why:
	/// [`Trusted::value_range`] of each item reads the container again each time, and a batch
	/// of edits of the items of an array of a hundred thousand would read it a hundred
	/// thousand times.
	///
	/// # Errors
	///
	/// [`EditError::NoSuchPath`] if the path leads to no container.
	///
	/// # Example
	///
	/// ```
	/// use kd_jsonc::edit::{Seg, trusted};
	/// let text = r#"{ "pages": [ { "url": "/a/" }, 2 ] }"#;
	/// let ranges = trusted(text).entry_ranges(&[Seg::Key("pages")]).unwrap();
	/// assert_eq!(&text[ranges[0].0..ranges[0].1], r#"{ "url": "/a/" }"#);
	/// assert_eq!(&text[ranges[1].0..ranges[1].1], "2");
	/// ```
	pub fn entry_ranges(&self, path: &[Seg<'_>]) -> Result<Vec<(usize, usize)>, EditError> {
		let lay = locate(self.0, path, false)?;
		Ok(lay
			.entries
			.iter()
			.map(|e| (e.value_start, e.value_end))
			.collect())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn the_ranges_of_every_entry_are_read_in_one_pass() {
		let text = "{\n\t// c\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }, // a\n\t\t[1, 2],\n\t\t\"x\"\n\t]\n}\n";
		let ranges = trusted(text).entry_ranges(&[Seg::Key("pages")]).unwrap();
		let got: Vec<&str> = ranges.iter().map(|&(a, b)| &text[a..b]).collect();
		assert_eq!(got, vec![r#"{ "url": "/a/" }"#, "[1, 2]", r#""x""#]);
		for (i, &(a, b)) in ranges.iter().enumerate() {
			assert_eq!(
				trusted(text)
					.value_range(&[Seg::Key("pages"), Seg::Index(i)])
					.unwrap(),
				(a, b)
			);
		}
		let members = trusted(r#"{ "a": 1, "b": [2] }"#)
			.entry_ranges(&[])
			.unwrap();
		assert_eq!(members.len(), 2);
		assert!(trusted(text).entry_ranges(&[Seg::Key("nope")]).is_err());
	}

	#[test]
	fn the_ranges_of_the_entries_of_the_odd_shapes_an_array_can_have() {
		let ranges = |text: &str, path: &[Seg<'_>]| -> Vec<String> {
			trusted(text)
				.entry_ranges(path)
				.unwrap()
				.into_iter()
				.map(|(a, b)| text[a..b].to_string())
				.collect()
		};
		let pages = [Seg::Key("pages")];
		assert_eq!(ranges(r#"{ "pages": [] }"#, &pages), Vec::<String>::new());
		assert_eq!(ranges(r#"{ "pages": [ ] }"#, &pages), Vec::<String>::new());
		// a trailing comma, and strings and comments that hold what ends or separates a value
		assert_eq!(
			ranges("{ \"pages\": [ \"a,]\", /* ], */ \"b\" , ] }", &pages),
			vec!["\"a,]\"", "\"b\""]
		);
		// the entries of a container deeper in the document
		assert_eq!(
			ranges(
				r#"{ "a": { "pages": [1, [2, 3], {"k": [4]}] } }"#,
				&[Seg::Key("a"), Seg::Key("pages")]
			),
			vec!["1", "[2, 3]", r#"{"k": [4]}"#]
		);
		// a path that leads to something that is not a container
		assert!(trusted(r#"{ "pages": 1 }"#).entry_ranges(&pages).is_err());
	}

	fn s(v: &str) -> Value {
		Value::String(v.to_string())
	}

	fn n(v: f64) -> Value {
		Value::Number(v)
	}

	#[test]
	fn replacing_a_value_changes_only_that_value() {
		let text = "// head\n{\n\t\"title\": \"A\", // a\n\t/* x */ \"layout\": \"x\",\n}\n";
		assert_eq!(
			set_member(text, &[], "title", &s("B")).unwrap(),
			"// head\n{\n\t\"title\": \"B\", // a\n\t/* x */ \"layout\": \"x\",\n}\n"
		);
		assert_eq!(
			set_member(text, &[], "layout", &n(1.0)).unwrap(),
			"// head\n{\n\t\"title\": \"A\", // a\n\t/* x */ \"layout\": 1,\n}\n"
		);
	}

	#[test]
	fn setting_the_same_value_changes_no_byte() {
		let text = "{\n\t\"a\": 1,\n\t\"b\": [1, 2]\n}\n";
		let out = set_member(text, &[], "a", &n(1.0)).unwrap();
		assert_eq!(out, text);
	}

	#[test]
	fn a_bom_is_kept() {
		let text = "\u{FEFF}{\"a\":1}";
		assert_eq!(
			set_member(text, &[], "a", &n(2.0)).unwrap(),
			"\u{FEFF}{\"a\":2}"
		);
	}

	#[test]
	fn adding_follows_the_layout_of_a_multiline_object() {
		let text = "{\n\t\"a\": 1,\n\t\"b\": 2\n}\n";
		assert_eq!(
			set_member(text, &[], "c", &n(3.0)).unwrap(),
			"{\n\t\"a\": 1,\n\t\"b\": 2,\n\t\"c\": 3\n}\n"
		);
	}

	#[test]
	fn adding_keeps_a_trailing_comma_style() {
		let text = "{\n  \"a\": 1,\n  \"b\": 2,\n}\n";
		assert_eq!(
			set_member(text, &[], "c", &n(3.0)).unwrap(),
			"{\n  \"a\": 1,\n  \"b\": 2,\n  \"c\": 3,\n}\n"
		);
	}

	#[test]
	fn adding_goes_after_a_line_comment_of_the_last_member() {
		let text = "{\n\t\"a\": 1 // one\n}\n";
		assert_eq!(
			set_member(text, &[], "b", &n(2.0)).unwrap(),
			"{\n\t\"a\": 1, // one\n\t\"b\": 2\n}\n"
		);
	}

	#[test]
	fn adding_to_an_inline_object_keeps_its_spacing() {
		assert_eq!(
			set_member(r#"{"a":1}"#, &[], "b", &n(2.0)).unwrap(),
			r#"{"a":1,"b":2}"#
		);
		assert_eq!(
			set_member(r#"{ "a": 1 }"#, &[], "b", &n(2.0)).unwrap(),
			r#"{ "a": 1, "b": 2 }"#
		);
	}

	#[test]
	fn adding_to_an_empty_object() {
		assert_eq!(
			set_member("{}", &[], "a", &n(1.0)).unwrap(),
			r#"{ "a": 1 }"#
		);
		assert_eq!(
			set_member("{\n}\n", &[], "a", &n(1.0)).unwrap(),
			"{\n\t\"a\": 1\n}\n"
		);
		assert_eq!(
			set_member("{\n\t\"m\": {\n\t}\n}\n", &[Seg::Key("m")], "a", &n(1.0)).unwrap(),
			"{\n\t\"m\": {\n\t\t\"a\": 1\n\t}\n}\n"
		);
	}

	#[test]
	fn nested_values_are_written_compact() {
		let v = parse(r#"{"x":[1,{"y":null}]}"#).unwrap();
		assert_eq!(
			set_member("{\n\t\"a\": 1\n}\n", &[], "og", &v).unwrap(),
			"{\n\t\"a\": 1,\n\t\"og\": {\"x\":[1,{\"y\":null}]}\n}\n"
		);
	}

	#[test]
	fn deleting_a_member_removes_its_line_and_comma() {
		let text = "{\n\t\"a\": 1,\n\t\"b\": 2,\n\t\"c\": 3\n}\n";
		assert_eq!(
			delete_member(text, &[], "b").unwrap(),
			"{\n\t\"a\": 1,\n\t\"c\": 3\n}\n"
		);
		assert_eq!(
			delete_member(text, &[], "a").unwrap(),
			"{\n\t\"b\": 2,\n\t\"c\": 3\n}\n"
		);
	}

	#[test]
	fn deleting_the_last_member_removes_the_comma_before_it() {
		let text = "{\n\t\"a\": 1,\n\t\"b\": 2\n}\n";
		assert_eq!(delete_member(text, &[], "b").unwrap(), "{\n\t\"a\": 1\n}\n");
	}

	#[test]
	fn deleting_the_last_member_of_a_trailing_comma_object_keeps_the_style() {
		let text = "{\n\t\"a\": 1,\n\t\"b\": 2,\n}\n";
		assert_eq!(
			delete_member(text, &[], "b").unwrap(),
			"{\n\t\"a\": 1,\n}\n"
		);
	}

	#[test]
	fn deleting_removes_a_comment_at_the_end_of_the_line() {
		let text = "{\n\t\"a\": 1, // one\n\t\"b\": 2 // two\n}\n";
		assert_eq!(
			delete_member(text, &[], "a").unwrap(),
			"{\n\t\"b\": 2 // two\n}\n"
		);
	}

	#[test]
	fn deleting_a_member_whose_value_spans_lines() {
		let text = "{\n\t\"a\": 1,\n\t\"o\": {\n\t\t\"x\": 1\n\t},\n\t\"b\": 2\n}\n";
		assert_eq!(
			delete_member(text, &[], "o").unwrap(),
			"{\n\t\"a\": 1,\n\t\"b\": 2\n}\n"
		);
	}

	#[test]
	fn deleting_from_an_inline_object() {
		assert_eq!(
			delete_member(r#"{"a":1,"b":2,"c":3}"#, &[], "b").unwrap(),
			r#"{"a":1,"c":3}"#
		);
		assert_eq!(
			delete_member(r#"{ "a": 1, "b": 2 }"#, &[], "b").unwrap(),
			r#"{ "a": 1 }"#
		);
		assert_eq!(
			delete_member(r#"{ "a": 1, "b": 2 }"#, &[], "a").unwrap(),
			r#"{ "b": 2 }"#
		);
	}

	#[test]
	fn deleting_the_last_member_keeps_the_comments_between_it_and_the_one_before() {
		assert_eq!(
			delete_member(r#"{ "a": 1, /* keep */ "b": 2 }"#, &[], "b").unwrap(),
			r#"{ "a": 1 /* keep */  }"#
		);
		assert_eq!(
			delete_member("{ \"a\": 1, // note\n  \"b\": 2 }", &[], "b").unwrap(),
			"{ \"a\": 1 // note\n   }"
		);
	}

	#[test]
	fn deleting_the_only_member_leaves_an_empty_object() {
		assert_eq!(delete_member(r#"{ "a": 1 }"#, &[], "a").unwrap(), "{}");
		assert_eq!(
			delete_member("{\n\t\"a\": 1\n}\n", &[], "a").unwrap(),
			"{}\n"
		);
	}

	#[test]
	fn deleting_the_only_member_keeps_a_comment_that_remains() {
		assert_eq!(
			delete_member("{\n\t// note\n\t\"a\": 1\n}\n", &[], "a").unwrap(),
			"{\n\t// note\n}\n"
		);
	}

	#[test]
	fn deleting_a_missing_key_is_an_error() {
		assert_eq!(
			delete_member("{}", &[], "a").unwrap_err(),
			EditError::NoSuchKey("a".to_string())
		);
	}

	#[test]
	fn edits_reach_into_nested_objects_and_arrays() {
		let text = "{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\", \"meta\": { \"t\": 1 } }\n\t]\n}\n";
		let path = [Seg::Key("pages"), Seg::Index(0), Seg::Key("meta")];
		assert_eq!(
			set_member(text, &path, "t", &n(2.0)).unwrap(),
			"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\", \"meta\": { \"t\": 2 } }\n\t]\n}\n"
		);
		assert_eq!(
			set_member(text, &path, "u", &s("x")).unwrap(),
			"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\", \"meta\": { \"t\": 1, \"u\": \"x\" } }\n\t]\n}\n"
		);
		assert_eq!(
			set_member(text, &[Seg::Key("pages"), Seg::Index(0)], "url", &s("/b/")).unwrap(),
			"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/b/\", \"meta\": { \"t\": 1 } }\n\t]\n}\n"
		);
	}

	#[test]
	fn a_path_that_leads_nowhere_is_an_error() {
		let text = r#"{"a":{"b":1}}"#;
		assert_eq!(
			set_member(text, &[Seg::Key("x")], "k", &n(1.0)).unwrap_err(),
			EditError::NoSuchPath("$.x".to_string())
		);
		assert_eq!(
			set_member(text, &[Seg::Key("a"), Seg::Key("b")], "k", &n(1.0)).unwrap_err(),
			EditError::NotAContainer("$.a.b".to_string())
		);
		assert_eq!(
			set_member(text, &[Seg::Index(0)], "k", &n(1.0)).unwrap_err(),
			EditError::NoSuchPath("$[0]".to_string())
		);
	}

	#[test]
	fn invalid_text_is_refused_before_any_edit() {
		assert!(matches!(
			set_member("{\"a\":", &[], "a", &n(1.0)).unwrap_err(),
			EditError::Parse(_)
		));
		assert!(matches!(
			set_member(r#"{"a":1,"a":2}"#, &[], "a", &n(1.0)).unwrap_err(),
			EditError::Parse(_)
		));
	}

	#[test]
	fn every_edit_reads_back_as_the_intended_value() {
		let text = "{\n\t// c\n\t\"a\": 1,\n\t\"b\": { \"x\": [1, 2] },\n}\n";
		let after = parse(&set_member(text, &[], "n", &s("v")).unwrap()).unwrap();
		assert_eq!(after, parse(r#"{"a":1,"b":{"x":[1,2]},"n":"v"}"#).unwrap());
		let after = parse(&delete_member(text, &[], "b").unwrap()).unwrap();
		assert_eq!(after, parse(r#"{"a":1}"#).unwrap());
	}

	#[test]
	fn what_is_added_follows_the_line_breaks_and_the_indentation_of_the_file() {
		assert_eq!(
			set_member("{\r\n\t\"a\": 1,\r\n\t\"b\": 2\r\n}\r\n", &[], "c", &n(3.0)).unwrap(),
			"{\r\n\t\"a\": 1,\r\n\t\"b\": 2,\r\n\t\"c\": 3\r\n}\r\n"
		);
		assert_eq!(
			set_member("{\r\n}\r\n", &[], "c", &n(3.0)).unwrap(),
			"{\r\n\t\"c\": 3\r\n}\r\n"
		);
		assert_eq!(
			set_member(
				"{\n    \"o\": {\n    }\n}\n",
				&[Seg::Key("o")],
				"a",
				&n(1.0)
			)
			.unwrap(),
			"{\n    \"o\": {\n        \"a\": 1\n    }\n}\n"
		);
	}

	#[test]
	fn trusted_text_is_edited_without_reading_past_the_way_to_the_container() {
		let text = r#"{ "pages": [ { "url": "/a/" }, { "url": "/b/" }, { "url": "/c/" } ] }"#;
		let path = [Seg::Key("pages"), Seg::Index(1)];
		let edited = trusted(text).set_member(&path, "url", &s("/x/")).unwrap();
		assert_eq!(
			edited,
			r#"{ "pages": [ { "url": "/a/" }, { "url": "/x/" }, { "url": "/c/" } ] }"#
		);
		assert_eq!(
			trusted(text).delete_member(&path, "url").unwrap(),
			r#"{ "pages": [ { "url": "/a/" }, {}, { "url": "/c/" } ] }"#
		);
		let (start, end) = trusted(text).value_range(&path).unwrap();
		assert_eq!(&text[start..end], r#"{ "url": "/b/" }"#);
		let (start, end) = trusted(text).value_range(&[Seg::Key("pages")]).unwrap();
		assert!(text[start..end].starts_with("[ {"));
		// what comes after the entry that is wanted is not read: a text that is broken there is
		// edited, where the validating functions refuse it
		let broken = r#"{ "pages": [ { "url": "/a/" }, { "url": "/b/" }, !!! ] }"#;
		assert_eq!(
			trusted(broken).set_member(&path, "url", &s("/x/")).unwrap(),
			r#"{ "pages": [ { "url": "/a/" }, { "url": "/x/" }, !!! ] }"#
		);
		assert!(matches!(
			set_member(broken, &path, "url", &s("/x/")).unwrap_err(),
			EditError::Parse(_)
		));
		assert_eq!(
			trusted(text).value_range(&[Seg::Key("pages"), Seg::Index(9)]),
			Err(EditError::NoSuchPath("$.pages[9]".to_string()))
		);
	}

	#[test]
	fn pushing_follows_the_layout_of_a_multiline_array() {
		let text =
			"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" }\n\t]\n}\n";
		let entry = parse(r#"{"url":"/c/","virtual":true}"#).unwrap();
		assert_eq!(
			push_element(text, &[Seg::Key("pages")], &entry).unwrap(),
			"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" },\n\t\t{\"url\":\"/c/\",\"virtual\":true}\n\t]\n}\n"
		);
	}

	#[test]
	fn pushing_keeps_a_trailing_comma_style_and_goes_after_a_line_comment() {
		let text = "[\n  1,\n  2, // two\n]\n";
		assert_eq!(
			push_element(text, &[], &n(3.0)).unwrap(),
			"[\n  1,\n  2, // two\n  3,\n]\n"
		);
		let text = "[\n  1,\n  2 // two\n]\n";
		assert_eq!(
			push_element(text, &[], &n(3.0)).unwrap(),
			"[\n  1,\n  2, // two\n  3\n]\n"
		);
	}

	#[test]
	fn pushing_to_an_inline_array_keeps_its_spacing() {
		assert_eq!(push_element("[1,2]", &[], &n(3.0)).unwrap(), "[1,2,3]");
		assert_eq!(
			push_element("[ 1, 2 ]", &[], &n(3.0)).unwrap(),
			"[ 1, 2, 3 ]"
		);
	}

	#[test]
	fn pushing_to_an_empty_array() {
		assert_eq!(push_element("[]", &[], &n(1.0)).unwrap(), "[1]");
		assert_eq!(
			push_element("{\n\t\"pages\": [\n\t]\n}\n", &[Seg::Key("pages")], &n(1.0)).unwrap(),
			"{\n\t\"pages\": [\n\t\t1\n\t]\n}\n"
		);
		assert_eq!(
			push_element(
				"{\r\n  \"pages\": [\r\n  ]\r\n}\r\n",
				&[Seg::Key("pages")],
				&n(1.0)
			)
			.unwrap(),
			"{\r\n  \"pages\": [\r\n    1\r\n  ]\r\n}\r\n"
		);
	}

	#[test]
	fn pushing_to_what_is_not_an_array_is_an_error() {
		assert_eq!(
			push_element(r#"{"pages":{}}"#, &[Seg::Key("pages")], &n(1.0)).unwrap_err(),
			EditError::NotAContainer("$.pages".to_string())
		);
		assert_eq!(
			push_element(r#"{"pages":1}"#, &[Seg::Key("pages")], &n(1.0)).unwrap_err(),
			EditError::NotAContainer("$.pages".to_string())
		);
		assert!(matches!(
			push_element("[1,", &[], &n(1.0)).unwrap_err(),
			EditError::Parse(_)
		));
	}

	#[test]
	fn deleting_an_item_removes_its_lines_and_comma() {
		let text = "[\n\t{ \"url\": \"/a/\" },\n\t{\n\t\t\"url\": \"/b/\"\n\t}, // b\n\t{ \"url\": \"/c/\" }\n]\n";
		assert_eq!(
			delete_element(text, &[], 1).unwrap(),
			"[\n\t{ \"url\": \"/a/\" },\n\t{ \"url\": \"/c/\" }\n]\n"
		);
		assert_eq!(
			delete_element(text, &[], 2).unwrap(),
			"[\n\t{ \"url\": \"/a/\" },\n\t{\n\t\t\"url\": \"/b/\"\n\t} // b\n]\n"
		);
		assert_eq!(delete_element("[1,2,3]", &[], 0).unwrap(), "[2,3]");
		assert_eq!(delete_element("[ 1, 2 ]", &[], 1).unwrap(), "[ 1 ]");
	}

	#[test]
	fn deleting_the_only_item_leaves_an_empty_array() {
		assert_eq!(delete_element("[ 1 ]", &[], 0).unwrap(), "[]");
		assert_eq!(
			delete_element(
				"{\n\t\"pages\": [\n\t\t1\n\t]\n}\n",
				&[Seg::Key("pages")],
				0
			)
			.unwrap(),
			"{\n\t\"pages\": []\n}\n"
		);
	}

	#[test]
	fn deleting_an_item_that_is_not_there_is_an_error() {
		assert_eq!(
			delete_element("[1]", &[], 1).unwrap_err(),
			EditError::NoSuchPath("$[1]".to_string())
		);
		assert_eq!(
			delete_element(r#"{"a":1}"#, &[], 0).unwrap_err(),
			EditError::NotAContainer("$".to_string())
		);
	}

	#[test]
	fn items_are_pushed_and_deleted_in_trusted_text_and_read_back_as_intended() {
		let text = r#"{ "version": 1, "pages": [ { "url": "/a/" }, { "url": "/b/" } ] }"#;
		let path = [Seg::Key("pages")];
		let pushed = trusted(text).push_element(&path, &s("x")).unwrap();
		assert_eq!(
			parse(&pushed).unwrap(),
			parse(r#"{"version":1,"pages":[{"url":"/a/"},{"url":"/b/"},"x"]}"#).unwrap()
		);
		let deleted = trusted(text).delete_element(&path, 0).unwrap();
		assert_eq!(
			parse(&deleted).unwrap(),
			parse(r#"{"version":1,"pages":[{"url":"/b/"}]}"#).unwrap()
		);
	}

	#[test]
	fn member_range_finds_the_value() {
		let text = "{ \"a\": \"x\", \"b\": { \"c\": 1 } }";
		let (s, e) = member_range(text, &[], "b").unwrap().unwrap();
		assert_eq!(&text[s..e], "{ \"c\": 1 }");
		assert_eq!(member_range(text, &[], "zz").unwrap(), None);
	}
}
