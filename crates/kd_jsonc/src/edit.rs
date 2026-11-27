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
#[derive(Debug, Clone)]
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
	insert_entries(text, lay, &[(head.to_string(), value.to_string())])
}

/// Inserts entries after the last entry, each laid out as `insert_entry` would lay it out
/// after the one before it: the same text as inserting them one at a time, and the text is
/// built once. A container with no entry takes one.
fn insert_entries(text: &str, lay: &Layout, items: &[(String, String)]) -> String {
	let Some(last) = lay.entries.last() else {
		let (head, value) = &items[0];
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
		let mut member = String::new();
		for (n, (head, value)) in items.iter().enumerate() {
			if n > 0 && !style.trailing_comma {
				member.push(',');
			}
			member.push_str(&format!("{}{}{head}{value}", eol_of(text), style.indent));
			if style.trailing_comma {
				member.push(',');
			}
		}
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
		let mut member = String::new();
		for (head, value) in items {
			if style.trailing_comma {
				member.push_str(&format!("{}{head}{value},", style.gap));
			} else {
				member.push_str(&format!(",{}{head}{value}", style.gap));
			}
		}
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

// How many times the changes were made in one pass, for the tests: a test that compares the text
// with what one by one makes passes as well when the one pass is never taken.
#[cfg(test)]
thread_local! {
	static ONE_PASS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// One change to a member of an object, for [`edit_members`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MemberOp<'a> {
	/// [`set_member`] of the key to the value.
	Set(&'a str, &'a Value),
	/// [`delete_member`] of the key.
	Delete(&'a str),
}

impl MemberOp<'_> {
	fn key(&self) -> &str {
		match self {
			MemberOp::Set(key, _) | MemberOp::Delete(key) => key,
		}
	}
}

/// Makes the changes `ops` to the members of the object at `path`, as [`set_member`] and
/// [`delete_member`] make them one after the other, and reads the text once. One by one, each
/// change reads the whole object again and builds the text again, so the members of one
/// object cost the square of how many there are.
///
/// The text is the same as one by one makes of it. A deletion is made by itself, between the
/// runs of settings before it and after it. Where one pass cannot be sure of the text, the
/// changes of a run are made one by one: a key that two of them name, an object with no
/// member, and a text that is not valid or a path that leads to no object (the first change
/// fails, as it would on its own).
///
/// # Errors
///
/// The position in `ops` of the change that failed, and why, as the one of [`set_member`] or
/// [`delete_member`] would give for it.
///
/// # Example
///
/// ```
/// use kd_jsonc::Value;
/// use kd_jsonc::edit::{MemberOp, edit_members};
/// let text = "{\n\t\"title\": \"A\",\n\t\"layout\": \"x\"\n}\n";
/// let (title, og) = (Value::String("B".into()), Value::Bool(true));
/// let out = edit_members(text, &[], &[MemberOp::Set("title", &title), MemberOp::Set("og", &og)]).unwrap();
/// assert_eq!(out, "{\n\t\"title\": \"B\",\n\t\"layout\": \"x\",\n\t\"og\": true\n}\n");
/// ```
pub fn edit_members(
	text: &str,
	path: &[Seg<'_>],
	ops: &[MemberOp<'_>],
) -> Result<String, (usize, EditError)> {
	edit_members_in(text, path, ops, true)
}

fn edit_members_in(
	text: &str,
	path: &[Seg<'_>],
	ops: &[MemberOp<'_>],
	validate: bool,
) -> Result<String, (usize, EditError)> {
	let one_by_one = || -> Result<String, (usize, EditError)> {
		let mut out = text.to_string();
		for (i, op) in ops.iter().enumerate() {
			out = match op {
				MemberOp::Set(key, value) => set_member_in(&out, path, key, value, validate),
				MemberOp::Delete(key) => delete_member_in(&out, path, key, validate),
			}
			.map_err(|e| (i, e))?;
		}
		Ok(out)
	};
	if ops.len() < 2 {
		return one_by_one();
	}
	// A deletion is made by itself, between the runs of settings before it and after it: the
	// changes are made in their order, so the text is what one by one makes of it.
	if ops.iter().any(|op| matches!(op, MemberOp::Delete(_))) {
		let mut out = text.to_string();
		let mut at = 0;
		while at < ops.len() {
			let end = match ops[at] {
				MemberOp::Delete(_) => at + 1,
				MemberOp::Set(..) => {
					at + ops[at..]
						.iter()
						.take_while(|op| matches!(op, MemberOp::Set(..)))
						.count()
				}
			};
			out = edit_members_in(&out, path, &ops[at..end], validate)
				.map_err(|(i, e)| (at + i, e))?;
			at = end;
		}
		return Ok(out);
	}
	let mut named: std::collections::HashSet<&str> = std::collections::HashSet::new();
	if !ops.iter().all(|op| named.insert(op.key())) {
		return one_by_one();
	}
	let Ok(lay) = locate(text, path, validate) else {
		return one_by_one();
	};
	if !lay.object || lay.entries.is_empty() {
		return one_by_one();
	}
	let mut by_key: std::collections::HashMap<&str, &Entry> = std::collections::HashMap::new();
	for e in &lay.entries {
		if let Some(key) = e.key.as_deref()
			&& by_key.insert(key, e).is_some()
		{
			// a key twice: which is set is for the change on its own to say
			return one_by_one();
		}
	}
	let mut replaced: Vec<(usize, usize, String)> = Vec::new();
	let mut added: Vec<(String, String)> = Vec::new();
	for op in ops {
		let MemberOp::Set(key, value) = op else {
			return one_by_one();
		};
		let rendered = value.to_json();
		if let Some(e) = by_key.get(key) {
			replaced.push((e.value_start, e.value_end, rendered));
		} else {
			added.push((key_head(text, &lay, key), rendered));
		}
	}
	// The members are added where the last one ends, and the values replaced are all before
	// that, so the places of the values are the same in the text with the members added.
	let with_added = if added.is_empty() {
		text.to_string()
	} else {
		insert_entries(text, &lay, &added)
	};
	#[cfg(test)]
	ONE_PASS.with(|c| c.set(c.get() + 1));
	replaced.sort_by_key(|(start, _, _)| *start);
	let mut out = String::with_capacity(with_added.len());
	let mut copied = 0;
	for (start, end, rendered) in &replaced {
		out.push_str(&with_added[copied..*start]);
		out.push_str(rendered);
		copied = *end;
	}
	out.push_str(&with_added[copied..]);
	Ok(out)
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

	/// [`edit_members`] without the validation.
	///
	/// # Errors
	///
	/// As for [`edit_members`].
	pub fn edit_members(
		&self,
		path: &[Seg<'_>],
		ops: &[MemberOp<'_>],
	) -> Result<String, (usize, EditError)> {
		edit_members_in(self.0, path, ops, false)
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

	/// Removes the items `indices` of the array at `path` in one pass, as [`delete_element`] removes
	/// them one after the other (in any order: the text is the same), for the layout the editor
	/// writes: one item to a line, with the lines of an item holding nothing else but a comment.
	/// `None` when the array is laid out another way, or every item goes (an array that is left
	/// empty is laid out by [`delete_element`]): the caller removes them one by one. Why: each
	/// removal reads the array and builds the text again, so a hundred thousand removals of a
	/// file of a hundred thousand items read it a hundred thousand times.
	///
	/// # Errors
	///
	/// [`EditError::NoSuchPath`] if an index is past the last item; the others as for
	/// [`delete_element`].
	///
	/// # Example
	///
	/// ```
	/// use kd_jsonc::edit::{Seg, trusted};
	/// let text = "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" },\n\t\t{ \"url\": \"/c/\" }\n\t]\n}\n";
	/// let out = trusted(text).delete_elements(&[Seg::Key("pages")], &[1, 2]).unwrap().unwrap();
	/// assert_eq!(out, "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }\n\t]\n}\n");
	/// ```
	pub fn delete_elements(
		&self,
		path: &[Seg<'_>],
		indices: &[usize],
	) -> Result<Option<String>, EditError> {
		let text = self.0;
		let lay = locate(text, path, false)?;
		if lay.object {
			return Err(EditError::NotAContainer(path_text(path)));
		}
		let mut gone: Vec<usize> = indices.to_vec();
		gone.sort_unstable();
		gone.dedup();
		if let Some(&past) = gone.iter().find(|&&i| i >= lay.entries.len()) {
			return Err(EditError::NoSuchPath(format!(
				"{}[{past}]",
				path_text(path)
			)));
		}
		if gone.is_empty() {
			return Ok(Some(text.to_string()));
		}
		if gone.len() == lay.entries.len() {
			// Every item goes: all but the last in one pass, and the last by itself, which is
			// the removal that leaves the array empty and lays it out (the one the removals
			// one after the other end with, whichever item they end with).
			let Some(rest) = self.delete_elements(path, &gone[..gone.len() - 1])? else {
				return Ok(None);
			};
			return delete_element_in(&rest, path, 0, false).map(Some);
		}
		// What is cut, by the layouts `remove_entry` knows two of that do not depend on what is
		// around an item: the items each on lines of their own (the lines go), and the items
		// each with its comma on a line shared with others (the item goes with its comma and
		// the blanks after it). In both, the last item going with no comma of its own takes the
		// previous entry's, one removal after the other: the last item that stays loses its
		// comma, and in the second layout everything from that comma to the end of the last
		// item goes.
		let alone_on_its_lines = |i: usize| {
			let e = &lay.entries[i];
			let after = e.comma.map_or(e.value_end, |c| c + 1);
			let ls = line_start(text, e.start);
			let le = line_end(text, after);
			is_blank(&text[ls..e.start])
				&& le <= lay.close
				&& only_a_line_comment(&text[after..le])
				&& ls > lay.open
		};
		// An array on one line has no item on lines of its own, and finding that out item by
		// item would read the line back and forth for each of them.
		let one_line = !text[lay.open..lay.close].contains('\n');
		let by_lines = !one_line && alone_on_its_lines(gone[0]);
		if !one_line && gone.iter().any(|&i| alone_on_its_lines(i) != by_lines) {
			return Ok(None);
		}
		// Items that share a line are all on one: once a neighbour on the line has gone, an item
		// that shared it is alone on it, and goes by lines, which the order of the removals
		// would decide.
		if !by_lines && !one_line {
			return Ok(None);
		}
		let last = lay.entries.len() - 1;
		let last_without_comma =
			gone.binary_search(&last).is_ok() && lay.entries[last].comma.is_none();
		let stays = if last_without_comma {
			(0..last).rev().find(|k| gone.binary_search(k).is_err())
		} else {
			None
		};
		let mut cuts: Vec<(usize, usize)> = Vec::with_capacity(gone.len() + 1);
		for &i in &gone {
			let e = &lay.entries[i];
			let after = e.comma.map_or(e.value_end, |c| c + 1);
			if by_lines {
				let ls = line_start(text, e.start);
				let le = line_end(text, after);
				cuts.push((ls, if le < text.len() { le + 1 } else { le }));
			} else if e.comma.is_some() {
				if stays.is_some_and(|k| i > k) {
					// inside what the last item takes with it
					continue;
				}
				let mut end = after;
				while matches!(text.as_bytes().get(end), Some(b' ' | b'\t')) {
					end += 1;
				}
				cuts.push((e.start, end));
			}
		}
		if last_without_comma {
			let comma = stays.and_then(|k| lay.entries[k].comma);
			if by_lines {
				if let Some(c) = comma {
					cuts.push((c, c + 1));
				}
			} else if let Some(c) = comma {
				// Nothing but blanks between the commas and the items that go with the last one:
				// a comment between them stays, which only one removal after the other can place.
				let first = stays.map_or(0, |k| k + 1);
				let chain_is_blank = (first..=last).all(|k| {
					let before = lay.entries[k - 1]
						.comma
						.map_or(lay.entries[k - 1].value_end, |c| c + 1);
					is_blank(&text[before..lay.entries[k].start])
				});
				if !chain_is_blank {
					return Ok(None);
				}
				cuts.push((c, lay.entries[last].value_end));
			} else {
				return Ok(None);
			}
		}
		cuts.sort_unstable();
		let mut out = String::with_capacity(text.len());
		let mut copied = 0;
		for (start, end) in cuts {
			out.push_str(&text[copied..start]);
			copied = end;
		}
		out.push_str(&text[copied..]);
		Ok(Some(out))
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

/// One step of the path an [`Appender`] keeps (a [`Seg`] that owns its key).
#[derive(Debug, Clone, PartialEq, Eq)]
enum OwnedSeg {
	Key(String),
	Index(usize),
}

/// Where the next item of an array goes, and how it is laid out, once the array has an item.
#[derive(Debug, Clone)]
struct Tail {
	/// Where the next item is inserted.
	at: usize,
	/// The end of the value of the last item: where a comma goes when the layout has none.
	value_end: usize,
	style: Style,
	eol: &'static str,
}

/// Adds items to the end of one array again and again, in place. [`Trusted::push_element`]
/// reads the array and builds the whole text again for each item, so a hundred thousand items
/// pushed that way read, and copy, a file that grows to the size of all of them a hundred
/// thousand times. An appender reads the array once; each [`Appender::push`] then costs the
/// item and the few bytes after it that move.
///
/// What it writes is what [`Trusted::push_element`] would, item by item (the same layout, the
/// same comma, the same line), which the tests check against it. The text is not parsed: it is
/// trusted to be valid, as for [`Trusted`]. When the text is not the length the appender left it
/// at (something else changed it) it reads the array again before it pushes.
///
/// # Example
///
/// ```
/// use kd_jsonc::{Value, edit::{Appender, Seg}};
/// let mut text = String::from("{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }\n\t]\n}\n");
/// let mut appender = Appender::new(&text, &[Seg::Key("pages")]).unwrap();
/// for url in ["/b/", "/c/"] {
///     let item = Value::Object(vec![("url".into(), Value::String(url.into()))]);
///     appender.push(&mut text, &item).unwrap();
/// }
/// assert_eq!(
///     text,
///     "{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{\"url\":\"/b/\"},\n\t\t{\"url\":\"/c/\"}\n\t]\n}\n"
/// );
/// ```
#[derive(Debug, Clone)]
pub struct Appender {
	path: Vec<OwnedSeg>,
	/// `None` while the array has no item: the first push lays an empty array out.
	tail: Option<Tail>,
	/// The length of the text after the last push.
	len: usize,
}

impl Appender {
	/// Reads the array at `path` of `text`.
	///
	/// # Errors
	///
	/// [`EditError::NoSuchPath`] if the path leads to no value, and [`EditError::NotAContainer`]
	/// if it leads to an object or to a value that is not an array.
	pub fn new(text: &str, path: &[Seg<'_>]) -> Result<Appender, EditError> {
		let lay = locate(text, path, false)?;
		if lay.object {
			return Err(EditError::NotAContainer(path_text(path)));
		}
		let owned = path
			.iter()
			.map(|seg| match seg {
				Seg::Key(k) => OwnedSeg::Key((*k).to_string()),
				Seg::Index(i) => OwnedSeg::Index(*i),
			})
			.collect();
		let Some(last) = lay.entries.last() else {
			return Ok(Appender {
				path: owned,
				tail: None,
				len: text.len(),
			});
		};
		let style = style_of(text, &lay);
		let after_last = last.comma.map_or(last.value_end, |c| c + 1);
		// The same place `insert_entry` puts the item at.
		let at = if style.multiline {
			let eol = line_end(text, after_last);
			let place_at_eol = eol <= lay.close && only_a_line_comment(&text[after_last..eol]);
			match (place_at_eol, eol.checked_sub(1)) {
				(true, Some(before))
					if before >= after_last && text.as_bytes()[before] == b'\r' =>
				{
					before
				}
				(true, _) => eol,
				(false, _) => after_last,
			}
		} else {
			after_last
		};
		Ok(Appender {
			path: owned,
			tail: Some(Tail {
				at,
				value_end: last.value_end,
				style,
				eol: eol_of(text),
			}),
			len: text.len(),
		})
	}

	/// The path as [`Seg`]s.
	fn segs(&self) -> Vec<Seg<'_>> {
		self.path
			.iter()
			.map(|seg| match seg {
				OwnedSeg::Key(k) => Seg::Key(k),
				OwnedSeg::Index(i) => Seg::Index(*i),
			})
			.collect()
	}

	/// Adds `value` after the last item of the array, in `text`.
	///
	/// # Errors
	///
	/// As for [`Appender::new`], when the array has to be read again.
	pub fn push(&mut self, text: &mut String, value: &Value) -> Result<(), EditError> {
		if text.len() != self.len {
			*self = Appender::new(text, &self.segs())?;
		}
		let Some(tail) = &mut self.tail else {
			// An empty array: how it is laid out is `insert_entry`'s to say; the items after the
			// first follow the layout it made.
			let segs = self.segs();
			let edited = push_element_in(text, &segs, value, false)?;
			*text = edited;
			*self = Appender::new(text, &segs)?;
			return Ok(());
		};
		let json = value.to_json();
		if tail.style.multiline {
			if !tail.style.trailing_comma {
				text.insert(tail.value_end, ',');
				tail.at += 1;
			}
			let comma = if tail.style.trailing_comma { "," } else { "" };
			let head = format!("{}{}", tail.eol, tail.style.indent);
			let member = format!("{head}{json}{comma}");
			text.insert_str(tail.at, &member);
			tail.value_end = tail.at + head.len() + json.len();
			tail.at += member.len();
		} else {
			let member = if tail.style.trailing_comma {
				format!("{}{json},", tail.style.gap)
			} else {
				format!(",{}{json}", tail.style.gap)
			};
			text.insert_str(tail.at, &member);
			tail.at += member.len();
			tail.value_end = tail.at - usize::from(tail.style.trailing_comma);
		}
		self.len = text.len();
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Pushes `values` with an appender and one by one with `push_element`: the text is the same
	/// after each.
	fn appends_as_push_element_does(text: &str, values: &[&str]) {
		let mut appended = text.to_string();
		let mut one_by_one = text.to_string();
		let mut appender = Appender::new(text, &[Seg::Key("pages")]).unwrap();
		for (n, v) in values.iter().enumerate() {
			let value = crate::parse(v).unwrap();
			appender.push(&mut appended, &value).unwrap();
			one_by_one = trusted(&one_by_one)
				.push_element(&[Seg::Key("pages")], &value)
				.unwrap();
			assert_eq!(appended, one_by_one, "after item {n} of {text:?}");
		}
		crate::parse(&appended).unwrap();
	}

	#[test]
	fn an_appender_writes_what_push_element_writes_in_each_layout() {
		let values = [
			r#"{"url":"/n1/"}"#,
			r#"{"url":"/n2/","virtual":true}"#,
			r#"{"url":"/n3/","meta":{"a":1}}"#,
			r#"{"url":"/n4/"}"#,
		];
		for text in [
			// one item per line, no trailing comma
			"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }\n\t]\n}\n",
			// one item per line, a trailing comma
			"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" },\n\t],\n}\n",
			// inline
			r#"{ "pages": [ { "url": "/a/" }, { "url": "/b/" } ] }"#,
			// compact, as the editor writes it
			r#"{"version":1,"pages":[{"url":"/a/"}]}"#,
			// a comment after the last item
			"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" } // last\n\t]\n}\n",
			"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }, // last\n\t]\n}\n",
			// line breaks of \r\n
			"{\r\n\t\"pages\": [\r\n\t\t{ \"url\": \"/a/\" }\r\n\t]\r\n}\r\n",
			"{\r\n\t\"pages\": [\r\n\t\t{ \"url\": \"/a/\" } // last\r\n\t]\r\n}\r\n",
			// two spaces of indent, and a comment before the array
			"{\n  // pages\n  \"pages\": [\n    { \"url\": \"/a/\" },\n    { \"url\": \"/b/\" }\n  ]\n}\n",
			// no item yet
			r#"{"pages":[]}"#,
			"{\n\t\"pages\": [\n\t]\n}\n",
			"{\n\t\"pages\": [ ]\n}\n",
			"{\n\t\"pages\": [\n\t\t// none\n\t]\n}\n",
		] {
			appends_as_push_element_does(text, &values);
		}
	}

	#[test]
	fn an_appender_reads_the_array_again_when_the_text_was_changed_in_between() {
		let mut text = String::from("{\"pages\":[{\"url\":\"/a/\"}]}");
		let mut appender = Appender::new(&text, &[Seg::Key("pages")]).unwrap();
		appender
			.push(&mut text, &crate::parse(r#"{"url":"/b/"}"#).unwrap())
			.unwrap();
		// something else adds an item, and the text is longer than the appender left it
		text = trusted(&text)
			.push_element(
				&[Seg::Key("pages")],
				&crate::parse(r#"{"url":"/c/"}"#).unwrap(),
			)
			.unwrap();
		appender
			.push(&mut text, &crate::parse(r#"{"url":"/d/"}"#).unwrap())
			.unwrap();
		assert_eq!(
			text,
			r#"{"pages":[{"url":"/a/"},{"url":"/b/"},{"url":"/c/"},{"url":"/d/"}]}"#
		);
	}

	#[test]
	fn an_appender_is_made_of_an_array_only() {
		assert!(matches!(
			Appender::new(r#"{"pages":{}}"#, &[Seg::Key("pages")]),
			Err(EditError::NotAContainer(_))
		));
		assert!(matches!(
			Appender::new(r#"{"pages":[]}"#, &[Seg::Key("other")]),
			Err(EditError::NoSuchPath(_))
		));
	}

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

#[cfg(test)]
mod edit_members_tests {
	use super::*;

	/// What `edit_members` has to give: the changes made one after the other.
	fn one_by_one(
		text: &str,
		path: &[Seg<'_>],
		ops: &[MemberOp<'_>],
	) -> Result<String, (usize, EditError)> {
		let mut out = text.to_string();
		for (i, op) in ops.iter().enumerate() {
			out = match op {
				MemberOp::Set(key, value) => set_member(&out, path, key, value),
				MemberOp::Delete(key) => delete_member(&out, path, key),
			}
			.map_err(|e| (i, e))?;
		}
		Ok(out)
	}

	const TEXTS: &[&str] = &[
		"{\n\t\"title\": \"A\",\n\t\"layout\": \"x\"\n}\n",
		"{\n\t\"title\": \"A\",\n\t\"layout\": \"x\",\n}\n",
		"{ \"title\": \"A\", \"layout\": \"x\" }",
		"{\"title\":\"A\",\"layout\":\"x\"}",
		"{\n\t// the title\n\t\"title\": \"A\", // first\n\n\t\"layout\": \"x\" // last\n}\n",
		"{\r\n\t\"title\": \"A\",\r\n\t\"layout\": \"x\"\r\n}\r\n",
		"{\n  \"title\":\"A\",\n  \"n\":1,\n  \"list\":[1,2],\n  \"obj\":{\"a\":1}\n}\n",
		"{}",
		"{\n}\n",
		"{ \"a\": 1, \"a\": 2 }",
		"[1, 2]",
		"{ \"title\": ",
		"{\n\t\"meta\": {\n\t\t\"title\": \"A\",\n\t\t\"n\": 1\n\t},\n\t\"url\": \"/a/\"\n}\n",
	];

	/// A small generator that gives the same numbers every run.
	struct Lcg(u64);
	impl Lcg {
		fn next(&mut self, n: usize) -> usize {
			self.0 = self
				.0
				.wrapping_mul(6_364_136_223_846_793_005)
				.wrapping_add(1_442_695_040_888_963_407);
			((self.0 >> 33) as usize) % n
		}
	}

	#[test]
	fn the_members_set_together_are_the_members_set_one_by_one() {
		let keys = [
			"title",
			"layout",
			"n",
			"list",
			"obj",
			"a",
			"new1",
			"new2",
			"new3",
			"url",
			"with \"q\"",
		];
		let values = [
			Value::String("New".into()),
			Value::String("line\nbreak".into()),
			Value::Number(7.0),
			Value::Bool(true),
			Value::Null,
			Value::Array(vec![Value::Number(1.0), Value::String("s".into())]),
			Value::Object(vec![("k".into(), Value::String("v".into()))]),
		];
		let mut rng = Lcg(0xFACADE);
		ONE_PASS.with(|c| c.set(0));
		let mut made_together = 0;
		for round in 0..6000 {
			let text = TEXTS[rng.next(TEXTS.len())];
			let count = 1 + rng.next(6);
			let mut chosen: Vec<&str> = Vec::new();
			while chosen.len() < count {
				let key = keys[rng.next(keys.len())];
				if !chosen.contains(&key) || rng.next(12) == 0 {
					chosen.push(key);
				}
			}
			let ops: Vec<MemberOp<'_>> = chosen
				.iter()
				.map(|key| {
					if rng.next(10) == 0 {
						MemberOp::Delete(key)
					} else {
						MemberOp::Set(key, &values[rng.next(values.len())])
					}
				})
				.collect();
			let expected = one_by_one(text, &[], &ops);
			let got = edit_members(text, &[], &ops);
			assert_eq!(got, expected, "round {round}: {text:?} with {ops:?}");
			if expected.is_ok() && ops.len() > 1 {
				made_together += 1;
			}
		}
		assert!(made_together > 1000, "{made_together}");
		let one_pass = ONE_PASS.with(std::cell::Cell::get);
		assert!(one_pass > 500, "{one_pass}");
	}

	#[test]
	fn the_members_of_an_object_below_a_path_are_set_together() {
		let text = "{\n\t\"meta\": {\n\t\t\"title\": \"A\"\n\t},\n\t\"url\": \"/a/\"\n}\n";
		let (title, order, nav) = (
			Value::String("B".into()),
			Value::Number(1.0),
			Value::Bool(true),
		);
		let ops = [
			MemberOp::Set("title", &title),
			MemberOp::Set("order", &order),
			MemberOp::Set("nav", &nav),
		];
		let path = [Seg::Key("meta")];
		assert_eq!(
			edit_members(text, &path, &ops),
			one_by_one(text, &path, &ops)
		);
		assert_eq!(
			trusted(text).edit_members(&path, &ops),
			one_by_one(text, &path, &ops)
		);
	}

	#[test]
	fn a_thousand_members_are_set_in_one_pass() {
		let mut text = String::from("{\n");
		for i in 0..3000 {
			text.push_str(&format!("\t\"k{i}\": 0,\n"));
		}
		text.push_str("\t\"last\": 0\n}\n");
		let values: Vec<Value> = (0..3000).map(|i| Value::Number(f64::from(i))).collect();
		let names: Vec<String> = (0..3000).map(|i| format!("k{i}")).collect();
		let ops: Vec<MemberOp<'_>> = names
			.iter()
			.zip(&values)
			.map(|(k, v)| MemberOp::Set(k, v))
			.collect();
		ONE_PASS.with(|c| c.set(0));
		let out = edit_members(&text, &[], &ops).unwrap();
		// one pass, whatever the number of members: not one by one
		assert_eq!(ONE_PASS.with(std::cell::Cell::get), 1);
		assert!(out.starts_with("{\n\t\"k0\": 0,\n\t\"k1\": 1,\n"));
		assert!(out.ends_with("\t\"k2999\": 2999,\n\t\"last\": 0\n}\n"));
	}
}

#[cfg(test)]
mod delete_elements_tests {
	use super::*;

	const ARRAYS: &[&str] = &[
		"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" },\n\t\t{ \"url\": \"/c/\" },\n\t\t{ \"url\": \"/d/\" },\n\t\t{ \"url\": \"/e/\" }\n\t]\n}\n",
		"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" },\n\t\t{ \"url\": \"/b/\" },\n\t\t{ \"url\": \"/c/\" },\n\t\t{ \"url\": \"/d/\" },\n\t\t{ \"url\": \"/e/\" },\n\t]\n}\n",
		"{\r\n\t\"pages\": [\r\n\t\t{ \"url\": \"/a/\" },\r\n\t\t{ \"url\": \"/b/\" },\r\n\t\t{ \"url\": \"/c/\" },\r\n\t\t{ \"url\": \"/d/\" },\r\n\t\t{ \"url\": \"/e/\" }\r\n\t]\r\n}\r\n",
		"{\n\t\"pages\": [\n\t\t{ \"url\": \"/a/\" }, // a\n\t\t// before b\n\t\t{ \"url\": \"/b/\" },\n\t\t{ \"url\": \"/c/\" }, // c\n\t\t{ \"url\": \"/d/\" },\n\t\t{ \"url\": \"/e/\" } // e\n\t]\n}\n",
		"{\n  \"version\": 1,\n  \"pages\": [\n    {\n      \"url\": \"/a/\"\n    },\n    {\n      \"url\": \"/b/\"\n    },\n    1,\n    2,\n    3\n  ]\n}\n",
		// not one to a line: the caller removes them one by one
		"{ \"pages\": [ { \"url\": \"/a/\" }, { \"url\": \"/b/\" }, { \"url\": \"/c/\" } ] }",
		"{\"pages\":[1,2,3,4,5]}",
		"{\n\t\"pages\": [ 1, 2,\n\t\t3, 4,\n\t\t5 ]\n}\n",
	];

	struct Lcg(u64);
	impl Lcg {
		fn next(&mut self, n: usize) -> usize {
			self.0 = self
				.0
				.wrapping_mul(6_364_136_223_846_793_005)
				.wrapping_add(1_442_695_040_888_963_407);
			((self.0 >> 33) as usize) % n
		}
	}

	/// What the items going one after the other, in the order given, leave.
	fn one_by_one(text: &str, order: &[usize]) -> String {
		let mut out = text.to_string();
		for (n, &idx) in order.iter().enumerate() {
			// an index counts from the items that are left
			let shift = order[..n].iter().filter(|&&earlier| earlier < idx).count();
			out = trusted(&out)
				.delete_element(&[Seg::Key("pages")], idx - shift)
				.unwrap();
		}
		out
	}

	#[test]
	fn the_items_removed_together_are_the_items_removed_one_by_one() {
		let mut rng = Lcg(0xDE1E7E);
		let mut together = 0;
		for round in 0..4000 {
			let text = ARRAYS[rng.next(ARRAYS.len())];
			let lay = locate(text, &[Seg::Key("pages")], false).unwrap();
			let n = lay.entries.len();
			let mut gone: Vec<usize> = (0..n).filter(|_| rng.next(3) == 0).collect();
			if gone.is_empty() || rng.next(10) == 0 {
				// now and then every item
				gone = if rng.next(2) == 0 {
					(0..n).collect()
				} else {
					vec![rng.next(n)]
				};
			}
			let got = trusted(text)
				.delete_elements(&[Seg::Key("pages")], &gone)
				.unwrap();
			let Some(got) = got else {
				continue;
			};
			together += 1;
			let mut descending = gone.clone();
			descending.reverse();
			assert_eq!(
				got,
				one_by_one(text, &descending),
				"round {round} (from the last): {text:?} without {gone:?}"
			);
			assert_eq!(
				got,
				one_by_one(text, &gone),
				"round {round} (from the first): {text:?} without {gone:?}"
			);
			crate::parse(&got).unwrap();
		}
		assert!(together > 1500, "{together}");
	}

	#[test]
	fn the_items_that_cannot_be_removed_together_are_told_so() {
		let array = |text: &str, gone: &[usize]| {
			trusted(text)
				.delete_elements(&[Seg::Key("pages")], gone)
				.unwrap()
		};
		// all of them go by the layout of the array that is left empty, which is the one of the
		// removal of the last item
		assert_eq!(
			array(ARRAYS[0], &[0, 1, 2, 3, 4]),
			Some("{\n\t\"pages\": []\n}\n".to_string())
		);
		// one item on lines of its own and one that shares its line
		assert_eq!(
			array(
				"{\n\t\"pages\": [\n\t\t1,\n\t\t2, 3,\n\t\t4\n\t]\n}\n",
				&[0, 1]
			),
			None
		);
		// a comment between the items that go with the last one
		assert_eq!(array("{\"pages\":[1, /* c */ 2, 3]}", &[1, 2]), None);
		// none
		assert_eq!(array(ARRAYS[0], &[]), Some(ARRAYS[0].to_string()));
		// past the end
		assert!(matches!(
			trusted(ARRAYS[0]).delete_elements(&[Seg::Key("pages")], &[9]),
			Err(EditError::NoSuchPath(_))
		));
	}
}
