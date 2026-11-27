//! Position-preserving edits of YAML front matter.
//!
//! The parser reads front matter into a value and keeps neither the comments
//! nor the way each value was written, and there is no YAML writer. Rewriting
//! the block from the value would drop every comment and re-quote every
//! string, so these functions edit the text: the entry that changes is
//! replaced, appended or removed, and every other byte stays.
//!
//! Only entries at the top level of a block mapping are edited, and not in a
//! document that uses anchors, aliases or merge keys: the parser expands them
//! while reading, so replacing the entry that holds an anchor would leave the
//! aliases that point to it unresolved, and an entry that comes from a merge
//! has no text of its own to replace or remove.
//!
//! A value that is written is a plain scalar when it reads back as the same
//! string, a double-quoted one when it does not, and one line of flow
//! (`{"a":1}`, `["x","y"]`) for an array or an object. The way the replaced
//! entry was written is not kept, and neither is a comment at the end of its
//! line, with one exception: a string that replaces a block scalar (`|`, `>`)
//! is written as one too, with the same indent, so that a long text that
//! changes by a word changes by a line in the file, not by the whole value. A
//! value that a block cannot hold (a control character, a space at the end of
//! a line, nothing at all) is written as above.
//!
//! A plain scalar is also quoted when it is a date or a number to the readers
//! of YAML 1.1 that front matter meets (gray-matter reads it with js-yaml): the
//! parser here reads `2026-11-25` and `1_000` as strings, and they must stay
//! strings for the next reader of the file.
//!
//! The fences are found by the function the reader uses, so a document is
//! edited where it is read.

use std::fmt;

use crate::{Error, Fence, Value, bom_len, parse, resolve_plain, top_level_entries};

/// Why an edit was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EditError {
	/// The front matter is not valid YAML.
	Parse(Error),
	/// The front matter cannot be edited entry by entry; the message says why.
	NotEditable(String),
	/// There is no such key.
	NoSuchKey(String),
}

impl fmt::Display for EditError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			EditError::Parse(e) => write!(f, "invalid front matter: {e}"),
			EditError::NotEditable(why) => f.write_str(why),
			EditError::NoSuchKey(k) => write!(f, "no such key: {k}"),
		}
	}
}

impl std::error::Error for EditError {}

/// The line break the document uses: the first one it has (`\n` if it has none).
fn eol_of(doc: &str) -> &'static str {
	match doc.find('\n') {
		Some(i) if i > 0 && doc.as_bytes()[i - 1] == b'\r' => "\r\n",
		_ => "\n",
	}
}

/// The fences of the front matter, as the reader finds them ([`crate::split_front_matter`]).
fn find_fence(doc: &str) -> Result<Option<Fence>, EditError> {
	crate::find_fence(doc).map_err(EditError::Parse)
}

fn parse_yaml(yaml: &str) -> Result<Value, EditError> {
	parse(yaml).map_err(|e| {
		EditError::Parse(Error {
			// Line 1 of the YAML is line 2 of the file.
			line: e.line + 1,
			..e
		})
	})
}

/// Why the keys of the front matter of `doc` cannot be edited, or `None` if
/// they can (a document with no front matter can have one added).
///
/// # Errors
///
/// [`EditError::Parse`] if the front matter is not valid.
///
/// # Example
///
/// ```
/// use kd_yaml::edit::not_editable_reason;
/// assert_eq!(not_editable_reason("---\ntitle: A\n---\n<p></p>").unwrap(), None);
/// assert!(not_editable_reason("---\nbase: &b {x: 1}\nuse: *b\n---\n").unwrap().is_some());
/// ```
pub fn not_editable_reason(doc: &str) -> Result<Option<String>, EditError> {
	let Some(fence) = find_fence(doc)? else {
		return Ok(None);
	};
	let yaml = &doc[fence.yaml_start..fence.yaml_end];
	match parse_yaml(yaml)? {
		Value::Null => return Ok(None),
		Value::Object(_) => {}
		_ => return Ok(Some("the front matter is not a mapping".to_string())),
	}
	match top_level_entries(yaml) {
		Ok(Some(found)) if found.uses_anchors => Ok(Some(
			"the front matter uses anchors, aliases or merge keys, which are expanded when it is read, so one entry cannot be rewritten alone".to_string(),
		)),
		Ok(Some(_)) => Ok(None),
		Ok(None) => Ok(Some(
			"the front matter is not a block mapping starting at the first column".to_string(),
		)),
		Err(e) => Err(EditError::Parse(e)),
	}
}

/// Sets `key` to `value` in the front matter of `doc`: the entry is replaced
/// if the key exists and appended to the end of the front matter if not; a
/// document without front matter gets one. Setting a key to the value it
/// already has returns `doc` as it was.
///
/// A string is written plain when it reads back as the same string, and double-quoted when it
/// does not, or when other readers of YAML would take it for a date or a number (`2026-11-25`,
/// `1_000`). A string that replaces a block scalar (`|`, `>`) is written as a block scalar with
/// the same indent, and only the lines that changed change; one that a block cannot hold is
/// written as above.
///
/// # Errors
///
/// [`EditError::Parse`] if the front matter is not valid, and
/// [`EditError::NotEditable`] if it cannot be edited entry by entry.
///
/// # Example
///
/// ```
/// use kd_yaml::{Value, edit::set_key};
/// let doc = "---\n# page\ntitle: Old\nlayout: x\n---\n<p>hi</p>\n";
/// let out = set_key(doc, "title", &Value::String("New".into())).unwrap();
/// assert_eq!(out, "---\n# page\ntitle: New\nlayout: x\n---\n<p>hi</p>\n");
///
/// let doc = "---\nnote: |\n  one\n  two\n---\n";
/// let out = set_key(doc, "note", &Value::String("one\ntwo\nthree\n".into())).unwrap();
/// assert_eq!(out, "---\nnote: |\n  one\n  two\n  three\n---\n");
/// ```
pub fn set_key(doc: &str, key: &str, value: &Value) -> Result<String, EditError> {
	if key == "<<" {
		// The parser reads `<<` as a merge key even when it is quoted.
		return Err(EditError::NotEditable(
			"`<<` is a merge key and cannot be used as a key".to_string(),
		));
	}
	let rendered = render_value(value);
	let Some(fence) = find_fence(doc)? else {
		let bom = bom_len(doc);
		let eol = eol_of(doc);
		return Ok(format!(
			"{}---{eol}{}: {rendered}{eol}---{eol}{}",
			&doc[..bom],
			render_key(key),
			&doc[bom..]
		));
	};
	if let Some(why) = not_editable_reason(doc)? {
		return Err(EditError::NotEditable(why));
	}
	let yaml = &doc[fence.yaml_start..fence.yaml_end];
	let current = parse_yaml(yaml)?;
	if current.get(key) == Some(value) {
		return Ok(doc.to_string());
	}
	let found = if matches!(current, Value::Null) {
		None
	} else {
		top_level_entries(yaml).map_err(EditError::Parse)?
	};
	let existing = found
		.as_ref()
		.and_then(|f| f.entries.iter().find(|e| e.key == key));
	if let Some(e) = existing {
		let at = fence.yaml_start;
		// a block scalar stays one when the new value can be written as one
		let (written, swallowed) = block_replacement(
			&yaml[e.key_end..e.end],
			&doc[at + e.end..],
			value,
			fence.eol,
		)
		.unwrap_or_else(|| (format!(": {rendered}{}", fence.eol), 0));
		return Ok(format!(
			"{}{}{written}{}",
			&doc[..at + e.start],
			&yaml[e.start..e.key_end],
			&doc[at + e.end + swallowed..]
		));
	}
	Ok(format!(
		"{}{}: {rendered}{}{}",
		&doc[..fence.yaml_end],
		render_key(key),
		fence.eol,
		&doc[fence.yaml_end..]
	))
}

/// Removes the entry `key` from the front matter of `doc`, with every line
/// of its value. If nothing but blanks is left, the fences go too (and the
/// line break after the closing one); comments that remain keep them. What follows the
/// `---` of a closing line (spaces or tabs) is the start of the body, and stays with it.
///
/// # Errors
///
/// [`EditError::NoSuchKey`] if the key is not there; the others as for
/// [`set_key`].
///
/// # Example
///
/// ```
/// use kd_yaml::edit::delete_key;
/// let doc = "---\ntitle: A\nlayout: x\n---\n<p>hi</p>\n";
/// assert_eq!(delete_key(doc, "layout").unwrap(), "---\ntitle: A\n---\n<p>hi</p>\n");
/// assert_eq!(delete_key("---\ntitle: A\n---\n<p>hi</p>\n", "title").unwrap(), "<p>hi</p>\n");
/// ```
pub fn delete_key(doc: &str, key: &str) -> Result<String, EditError> {
	let Some(fence) = find_fence(doc)? else {
		return Err(EditError::NoSuchKey(key.to_string()));
	};
	if let Some(why) = not_editable_reason(doc)? {
		return Err(EditError::NotEditable(why));
	}
	let yaml = &doc[fence.yaml_start..fence.yaml_end];
	let found = top_level_entries(yaml).map_err(EditError::Parse)?;
	let Some(e) = found
		.as_ref()
		.and_then(|f| f.entries.iter().find(|e| e.key == key))
	else {
		return Err(EditError::NoSuchKey(key.to_string()));
	};
	let left = format!("{}{}", &yaml[..e.start], &yaml[e.end..]);
	if left.trim().is_empty() {
		return Ok(format!(
			"{}{}",
			&doc[..fence.open_start],
			&doc[fence.body_start..]
		));
	}
	Ok(format!(
		"{}{}{}",
		&doc[..fence.yaml_start],
		left,
		&doc[fence.yaml_end..]
	))
}

// How many times the changes were made in one pass, for the tests: a test that compares the text
// with what one by one makes passes as well when the one pass is never taken.
#[cfg(test)]
thread_local! {
	static ONE_PASS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// One change to a key of the front matter, for [`edit_keys`].
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum KeyOp<'a> {
	/// `set_key` of the key to the value.
	Set(&'a str, &'a Value),
	/// `delete_key` of the key.
	Delete(&'a str),
}

impl KeyOp<'_> {
	fn key(&self) -> &str {
		match self {
			KeyOp::Set(key, _) | KeyOp::Delete(key) => key,
		}
	}
}

/// Makes the changes `ops` to the keys of the front matter of `doc`, as [`set_key`] and
/// [`delete_key`] make them one after the other, and reads and writes the front matter once.
/// One by one, each change reads the whole front matter several times and writes it out again,
/// so the keys of one page cost the square of how many there are.
///
/// The text is the same as one by one makes of it. Where one pass cannot be sure of that, the
/// changes are made one by one: a key that two of the changes name, a document without front
/// matter or with front matter that cannot be edited (the first change fails, as it would on
/// its own), a block scalar that keeps the blank lines after it (`|+`), and the deletion of
/// every key (the fences go, and a key set after that makes new ones).
///
/// # Errors
///
/// The position in `ops` of the change that failed, and why, as the one of [`set_key`] or
/// [`delete_key`] would give for it: the changes before it are made, and the first that fails is
/// the one told.
///
/// # Example
///
/// ```
/// use kd_yaml::{Value, edit::{KeyOp, edit_keys}};
/// let doc = "---\n# page\ntitle: Old\nlayout: x\n---\n<p>hi</p>\n";
/// let new = Value::String("New".into());
/// let order = Value::Number(2.0);
/// let out = edit_keys(
///     doc,
///     &[KeyOp::Set("title", &new), KeyOp::Delete("layout"), KeyOp::Set("order", &order)],
/// )
/// .unwrap();
/// assert_eq!(out, "---\n# page\ntitle: New\norder: 2\n---\n<p>hi</p>\n");
/// ```
pub fn edit_keys(doc: &str, ops: &[KeyOp<'_>]) -> Result<String, (usize, EditError)> {
	use std::collections::{HashMap, HashSet};
	let one_by_one = || -> Result<String, (usize, EditError)> {
		let mut out = doc.to_string();
		for (i, op) in ops.iter().enumerate() {
			out = match op {
				KeyOp::Set(key, value) => set_key(&out, key, value),
				KeyOp::Delete(key) => delete_key(&out, key),
			}
			.map_err(|e| (i, e))?;
		}
		Ok(out)
	};
	let mut named: HashSet<&str> = HashSet::new();
	if ops.len() < 2 || !ops.iter().all(|op| named.insert(op.key())) || named.contains("<<") {
		return one_by_one();
	}
	let Ok(Some(fence)) = find_fence(doc) else {
		return one_by_one();
	};
	if !matches!(not_editable_reason(doc), Ok(None)) {
		return one_by_one();
	}
	let yaml = &doc[fence.yaml_start..fence.yaml_end];
	let Ok(current) = parse_yaml(yaml) else {
		return one_by_one();
	};
	let found = if matches!(current, Value::Null) {
		None
	} else {
		match top_level_entries(yaml) {
			Ok(found) => found,
			Err(_) => return one_by_one(),
		}
	};
	let entries = found.as_ref().map_or(&[][..], |f| &f.entries[..]);
	let by_key: HashMap<&str, &crate::EntrySpan> =
		entries.iter().map(|e| (e.key.as_str(), e)).collect();
	// What replaces which bytes of the YAML (the entries are apart, so the places are too), and
	// what is added at its end.
	let mut changes: Vec<(usize, usize, String)> = Vec::new();
	let mut appended = String::new();
	let mut deleted = false;
	for (i, op) in ops.iter().enumerate() {
		match op {
			KeyOp::Set(key, value) => {
				if current.get(key) == Some(value) {
					continue;
				}
				let rendered = render_value(value);
				if let Some(e) = by_key.get(key) {
					let (written, swallowed) = block_replacement(
						&yaml[e.key_end..e.end],
						&doc[fence.yaml_start + e.end..],
						value,
						fence.eol,
					)
					.unwrap_or_else(|| (format!(": {rendered}{}", fence.eol), 0));
					if swallowed > 0 {
						return one_by_one();
					}
					changes.push((e.key_end, e.end, written));
				} else {
					appended.push_str(&format!("{}: {rendered}{}", render_key(key), fence.eol));
				}
			}
			KeyOp::Delete(key) => {
				let Some(e) = by_key.get(key) else {
					return Err((i, EditError::NoSuchKey((*key).to_string())));
				};
				changes.push((e.start, e.end, String::new()));
				deleted = true;
			}
		}
	}
	changes.sort_by_key(|(start, _, _)| *start);
	let mut written = String::with_capacity(yaml.len() + appended.len());
	let mut copied = 0;
	for (start, end, text) in &changes {
		written.push_str(&yaml[copied..*start]);
		written.push_str(text);
		copied = *end;
	}
	written.push_str(&yaml[copied..]);
	if deleted && written.trim().is_empty() {
		return one_by_one();
	}
	#[cfg(test)]
	ONE_PASS.with(|c| c.set(c.get() + 1));
	Ok(format!(
		"{}{written}{appended}{}",
		&doc[..fence.yaml_start],
		&doc[fence.yaml_end..]
	))
}

fn render_key(key: &str) -> String {
	let simple = key
		.chars()
		.next()
		.is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
		&& key
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
		&& matches!(resolve_plain(key), Value::String(_));
	if simple {
		key.to_string()
	} else {
		Value::String(key.to_string()).to_json()
	}
}

fn render_value(value: &Value) -> String {
	match value {
		Value::String(s) => render_string(s),
		other => other.to_json(),
	}
}

/// A cursor over the bytes of a plain scalar, for the shapes [`reads_as_yaml_1_1_scalar`] tests.
struct Cursor<'a> {
	b: &'a [u8],
	i: usize,
}

impl Cursor<'_> {
	/// Takes between `min` and `max` ASCII digits (as many as there are, up to `max`).
	fn digits(&mut self, min: usize, max: usize) -> bool {
		let start = self.i;
		while self.i - start < max && self.b.get(self.i).is_some_and(u8::is_ascii_digit) {
			self.i += 1;
		}
		self.i - start >= min
	}

	/// Takes the bytes that `ok` accepts, and says how many there were.
	fn run(&mut self, ok: fn(u8) -> bool) -> usize {
		let start = self.i;
		while self.b.get(self.i).is_some_and(|b| ok(*b)) {
			self.i += 1;
		}
		self.i - start
	}

	/// Takes `c`, if it is next.
	fn eat(&mut self, c: u8) -> bool {
		let found = self.b.get(self.i) == Some(&c);
		self.i += usize::from(found);
		found
	}

	/// Takes any spaces and tabs, and says how many there were.
	fn blanks(&mut self) -> usize {
		let start = self.i;
		while matches!(self.b.get(self.i), Some(b' ' | b'\t')) {
			self.i += 1;
		}
		self.i - start
	}

	fn done(&self) -> bool {
		self.i == self.b.len()
	}
}

/// Whether `s` is a timestamp as YAML 1.1 writes it (js-yaml `!!timestamp`): a date
/// (`2026-11-25`), or a date and a time (`2026-11-25T10:00:00Z`, `2026-11-25 10:00:00.5 +9`).
///
/// This copies, by hand, the two patterns of `lib/js-yaml/type/timestamp.js` of js-yaml 3.14, the
/// version gray-matter 4.0.3 depends on (https://yaml.org/type/timestamp.html is the spec). If
/// gray-matter moves to another reader, compare with its pattern again.
fn is_yaml_1_1_timestamp(s: &str) -> bool {
	let mut c = Cursor {
		b: s.as_bytes(),
		i: 0,
	};
	if !(c.digits(4, 4) && c.eat(b'-')) {
		return false;
	}
	let at_month = c.i;
	if c.digits(2, 2) && c.eat(b'-') && c.digits(2, 2) && c.done() {
		return true;
	}
	c.i = at_month;
	if !(c.digits(1, 2) && c.eat(b'-') && c.digits(1, 2)) {
		return false;
	}
	if !(c.eat(b'T') || c.eat(b't') || c.blanks() > 0) {
		return false;
	}
	if !(c.digits(1, 2) && c.eat(b':') && c.digits(2, 2) && c.eat(b':') && c.digits(2, 2)) {
		return false;
	}
	if c.eat(b'.') {
		c.digits(0, usize::MAX);
	}
	let before_zone = c.i;
	c.blanks();
	let zone = c.eat(b'Z')
		|| ((c.eat(b'-') || c.eat(b'+')) && c.digits(1, 2) && (!c.eat(b':') || c.digits(2, 2)));
	if !zone {
		c.i = before_zone;
	}
	c.done()
}

/// Whether `s` is a number as YAML 1.1 writes it and the core schema does not (js-yaml `!!int`,
/// `!!float`): digits with `_` in them (`1_000`, `1_0.5`, `0x1_F`), a binary number (`0b101`),
/// or a base 60 number with `:` (`1:30`, `12:30:45`, `1:30.5`). A sign may come first.
///
/// The shapes follow `lib/js-yaml/type/int.js` and `float.js` of js-yaml 3.14, the version
/// gray-matter 4.0.3 depends on (https://yaml.org/type/int.html and float.html are the spec).
///
/// The shapes are a little wider than what js-yaml 3 reads as a number (it wants `[0-5]?[0-9]` after
/// a `:`, so `1:99` stays a string there): readers differ at the edges, and a string that is quoted
/// when it did not have to be reads the same everywhere.
fn is_yaml_1_1_number(s: &str) -> bool {
	let r = s.strip_prefix(['-', '+']).unwrap_or(s);
	let underscore = r.contains('_');
	let only = |digits: &str, ok: fn(u8) -> bool| !digits.is_empty() && digits.bytes().all(ok);
	if let Some(digits) = r.strip_prefix("0b").or_else(|| r.strip_prefix("0B")) {
		return only(digits, |c| matches!(c, b'0' | b'1' | b'_'));
	}
	// without a `_` the core schema reads `0x1F` as a number already
	if let Some(digits) = r.strip_prefix("0x").or_else(|| r.strip_prefix("0X")) {
		return underscore && only(digits, |c| c.is_ascii_hexdigit() || c == b'_');
	}
	let mut c = Cursor {
		b: r.as_bytes(),
		i: 0,
	};
	let whole = c.run(|d| d.is_ascii_digit() || d == b'_');
	let digit_first = r.as_bytes().first().is_some_and(u8::is_ascii_digit);
	if whole > 0 && !digit_first {
		return false;
	}
	// `:` and one or two digits, any number of times: base 60
	let mut base_60 = false;
	while digit_first && c.eat(b':') {
		if !c.digits(1, 2) {
			return false;
		}
		base_60 = true;
	}
	// the fraction (a number may start with it), and the exponent
	if c.eat(b'.') {
		c.run(|d| d.is_ascii_digit() || d == b'_');
	} else if !digit_first {
		return false;
	}
	if c.eat(b'e') || c.eat(b'E') {
		let _ = c.eat(b'-') || c.eat(b'+');
		if !c.digits(1, usize::MAX) {
			return false;
		}
	}
	c.done() && (underscore || base_60)
}

/// Whether other readers of YAML read the plain scalar `s` as a date or a number, although the
/// core schema (which `resolve_plain` follows) reads it as a string. gray-matter, whose rules
/// RFC section 4 names, reads front matter with js-yaml 3, which resolves the YAML 1.1 types:
/// `2026-11-25` is a `Date` and `1_000` or `1:30` is a number. It is a string in kamado, so a
/// string written plain would change type for the next reader of the same front matter.
fn reads_as_yaml_1_1_scalar(s: &str) -> bool {
	is_yaml_1_1_timestamp(s) || is_yaml_1_1_number(s)
}

fn render_string(s: &str) -> String {
	let indicator = s
		.chars()
		.next()
		.is_some_and(|c| "-?:,[]{}#&*!|>'\"%@`".contains(c));
	let plain_ok = !s.is_empty()
		&& matches!(resolve_plain(s), Value::String(_))
		&& !reads_as_yaml_1_1_scalar(s)
		&& !indicator
		&& s == s.trim()
		&& !s.contains(": ")
		&& !s.contains(" #")
		&& !s.ends_with(':')
		&& !s.chars().any(char::is_control);
	if plain_ok {
		s.to_string()
	} else {
		Value::String(s.to_string()).to_json()
	}
}

/// How the value of an entry was written, when it is a block scalar (`|` or `>`).
struct BlockStyle {
	/// `>` (folded), not `|` (literal).
	folded: bool,
	/// The columns every line of the value is indented by.
	indent: usize,
	/// The digit of the header that gives the indent (`|2`), 1 to 9.
	explicit: Option<u8>,
	/// The lines as written, without the indent. The blank lines at the end are not here.
	lines: Vec<String>,
}

/// Reads how a block scalar was written. `entry` is the text of the entry after its key: the
/// `:`, the header line and the lines of the value. `None` if the value is not a block scalar,
/// or one that is not written as the parser reads it.
fn read_block_style(entry: &str) -> Option<BlockStyle> {
	let rest = entry
		.trim_start_matches([' ', '\t'])
		.strip_prefix(':')?
		.trim_start_matches([' ', '\t']);
	let folded = match rest.chars().next()? {
		'|' => false,
		'>' => true,
		_ => return None,
	};
	let after = &rest[1..];
	let header_end = after.find('\n').unwrap_or(after.len());
	let header = after[..header_end].trim_end_matches('\r');
	let indicators = header
		.bytes()
		.take(2)
		.take_while(|b| matches!(b, b'-' | b'+' | b'1'..=b'9'))
		.count();
	let explicit = header[..indicators]
		.bytes()
		.find(u8::is_ascii_digit)
		.map(|d| d - b'0');
	// only blanks, or a comment after the blanks, may follow the indicators
	let tail = &header[indicators..];
	if !(tail.is_empty()
		|| tail.starts_with([' ', '\t']) && {
			let t = tail.trim_start_matches([' ', '\t']);
			t.is_empty() || t.starts_with('#')
		}) {
		return None;
	}
	let body = after[header_end..].strip_prefix('\n').unwrap_or("");
	let raw: Vec<&str> = body
		.split_terminator('\n')
		.map(|l| l.strip_suffix('\r').unwrap_or(l))
		.collect();
	let spaces = |l: &str| l.len() - l.trim_start_matches(' ').len();
	let indent = match explicit {
		// the parent is the top-level mapping, at column 0
		Some(n) => usize::from(n),
		None => spaces(raw.iter().find(|l| spaces(l) < l.len())?),
	};
	let mut lines = Vec::with_capacity(raw.len());
	for l in raw {
		if spaces(l) == l.len() {
			lines.push(String::new());
		} else if spaces(l) >= indent {
			lines.push(l[indent..].to_string());
		} else {
			return None;
		}
	}
	while lines.last().is_some_and(String::is_empty) {
		lines.pop();
	}
	// a block with no line has no indent to keep
	if lines.is_empty() {
		return None;
	}
	Some(BlockStyle {
		folded,
		indent,
		explicit,
		lines,
	})
}

/// The text of an entry after its key, with `value` written as the block scalar the entry had,
/// and how many bytes of `after` (the text that follows the entry) it replaces; or `None` if the
/// entry was not a block scalar, `value` is not a string, `value` cannot be written as one, or
/// what is written would not read back as `value`.
///
/// The blank lines that follow an entry are not part of it, but when the block keeps the line
/// breaks at its end (`|+`) they are the value's own: they are replaced with it, or they would be
/// counted twice.
fn block_replacement(
	entry: &str,
	after: &str,
	value: &Value,
	eol: &str,
) -> Option<(String, usize)> {
	let Value::String(s) = value else {
		return None;
	};
	let style = read_block_style(entry)?;
	let text = render_block(s, &style, eol)?;
	// the lines after the entry that the parser reads as blank (spaces only), and those of them
	// that are empty (a line with spaces is not replaced: they stay, and the check below sees them)
	let len_of = |blank: fn(&str) -> bool| {
		after
			.split_inclusive('\n')
			.take_while(|l| blank(l.trim_end_matches(['\r', '\n'])))
			.map(str::len)
			.sum::<usize>()
	};
	let blank = len_of(|l| l.trim_start_matches(' ').is_empty());
	let empty = len_of(str::is_empty);
	let keep = text.lines().next().is_some_and(|h| h.ends_with('+'));
	let (swallowed, left) = if keep {
		(empty, &after[empty..blank])
	} else {
		(0, &after[..blank])
	};
	// A line of spaces that is longer than the indent is part of the value to readers that do not
	// take it for blank (js-yaml), and the line breaks that `+` keeps at the end of the last entry
	// are not counted by readers that end the front matter at the first line break before the
	// closing `---` (gray-matter). Neither shows when this parser reads it back, so they are
	// not written as a block.
	if left
		.lines()
		.any(|l| l.trim_end_matches('\r').len() > style.indent)
		|| (keep && after[blank..].starts_with("---"))
	{
		return None;
	}
	// read it back with what follows it, as it will be in the document
	match parse(&format!("k{text}{left}n: 1\n")) {
		Ok(Value::Object(pairs)) if matches!(pairs.as_slice(), [(_, Value::String(r)), (_, Value::Number(_))] if r == s) => {
			Some((text, swallowed))
		}
		_ => None,
	}
}

/// `s` as a block scalar of the style `style`: the header and the lines, each with its line
/// break `eol`. `None` for what a block cannot hold as it is: nothing but newlines, a control
/// character other than `\n` (a tab included), a space at the end of a line, and a first line
/// that starts with a space where the header does not give the indent.
fn render_block(s: &str, style: &BlockStyle, eol: &str) -> Option<String> {
	let body = s.trim_end_matches('\n');
	let newlines = s.len() - body.len();
	if body.is_empty()
		|| body
			.chars()
			.any(|c| (c.is_control() && c != '\n') || matches!(c, '\u{2028}' | '\u{2029}'))
		|| body.split('\n').any(|l| l.ends_with(' '))
	{
		return None;
	}
	let lines = if style.folded {
		fold_lines(body, style)?
	} else {
		body.split('\n').map(str::to_string).collect()
	};
	if style.explicit.is_none() && lines.iter().find(|l| !l.is_empty())?.starts_with(' ') {
		return None;
	}
	let mut out = String::from(if style.folded { ": >" } else { ": |" });
	if let Some(digit) = style.explicit {
		out.push(char::from(b'0' + digit));
	}
	out.push_str(match newlines {
		0 => "-",
		1 => "",
		_ => "+",
	});
	out.push_str(eol);
	let pad = " ".repeat(style.indent);
	for l in &lines {
		if !l.is_empty() {
			out.push_str(&pad);
			out.push_str(l);
		}
		out.push_str(eol);
	}
	// every newline after the first at the end is a blank line the value keeps
	for _ in 1..newlines {
		out.push_str(eol);
	}
	Some(out)
}

/// The lines of a folded block that reads as `body` (which has no newline at its end). A
/// newline of the value is a blank line, and the text between newlines is folded at the
/// single spaces. Each paragraph (the text between newlines, and the lines that the old block
/// had between blank lines) keeps the lines of the old block that did not change, from its start
/// and from its end, and what changed is folded again at the width of the longest old line
/// (80 if the old block was one line). `None` if a line starts with a space: it would not fold.
fn fold_lines(body: &str, style: &BlockStyle) -> Option<Vec<String>> {
	let mut paragraphs: Vec<(usize, &str)> = Vec::new();
	let mut gap = 0;
	for (i, text) in body.split('\n').enumerate() {
		gap += usize::from(i > 0);
		if text.is_empty() {
			continue;
		}
		if text.starts_with(' ') {
			return None;
		}
		paragraphs.push((gap, text));
		gap = 0;
	}
	let mut old: Vec<(usize, Vec<&str>)> = Vec::new();
	let (mut gap, mut inside) = (0, false);
	for l in &style.lines {
		if l.is_empty() {
			gap += 1;
			inside = false;
		} else if inside && let Some((_, lines)) = old.last_mut() {
			lines.push(l);
		} else {
			old.push((gap, vec![l]));
			(gap, inside) = (0, true);
		}
	}
	let text_lines = style.lines.iter().filter(|l| !l.is_empty()).count();
	let width = if text_lines < 2 {
		80
	} else {
		style.lines.iter().map(|l| l.chars().count()).max()?
	};
	let mut out = Vec::new();
	for (i, (gap, text)) in paragraphs.iter().enumerate() {
		out.extend(std::iter::repeat_n(String::new(), *gap));
		match old.get(i) {
			Some((before, lines)) if before == gap => out.extend(refold(lines, text, width)),
			_ => out.extend(fold_at(text, width)),
		}
	}
	Some(out)
}

/// The lines for `text`, where a paragraph had the lines `old`: the lines at the start and at
/// the end that `text` still has stay as they were, and what is between them is folded again.
fn refold(old: &[&str], text: &str, width: usize) -> Vec<String> {
	let (mut head, mut at) = (0, 0);
	while let Some(line) = old.get(head) {
		let Some(after) = text[at..].strip_prefix(line) else {
			break;
		};
		if after.is_empty() {
			(head, at) = (head + 1, text.len());
		} else if after.starts_with(' ') && !after[1..].starts_with(' ') {
			(head, at) = (head + 1, at + line.len() + 1);
		} else {
			break;
		}
	}
	let rest = &text[at..];
	let (mut tail, mut end) = (0, rest.len());
	while tail < old.len() - head {
		let line = old[old.len() - 1 - tail];
		let Some(before) = rest[..end].strip_suffix(line) else {
			break;
		};
		if before.is_empty() {
			(tail, end) = (tail + 1, 0);
			break;
		}
		if before.ends_with(' ') && !before[..before.len() - 1].ends_with(' ') {
			(tail, end) = (tail + 1, before.len() - 1);
		} else {
			break;
		}
	}
	let mut lines: Vec<String> = old[..head].iter().map(|l| (*l).to_string()).collect();
	if end > 0 {
		lines.extend(fold_at(&rest[..end], width));
	}
	lines.extend(old[old.len() - tail..].iter().map(|l| (*l).to_string()));
	lines
}

/// `text` in lines of at most `width` characters, broken at single spaces (a line is longer
/// when a word is, and a run of spaces is not broken).
fn fold_at(text: &str, width: usize) -> Vec<String> {
	let b = text.as_bytes();
	let mut lines: Vec<String> = Vec::new();
	let mut start = 0;
	let mut line = String::new();
	for i in 0..=b.len() {
		let breaks = i == b.len()
			|| (b[i] == b' '
				&& i > 0 && b[i - 1] != b' '
				&& b.get(i + 1).is_some_and(|n| *n != b' '));
		if !breaks {
			continue;
		}
		let word = &text[start..i];
		if line.is_empty() {
			line.push_str(word);
		} else if line.chars().count() + 1 + word.chars().count() <= width {
			line.push(' ');
			line.push_str(word);
		} else {
			lines.push(std::mem::replace(&mut line, word.to_string()));
		}
		start = i + 1;
	}
	if !line.is_empty() {
		lines.push(line);
	}
	lines
}

#[cfg(test)]
mod tests {
	use super::*;

	fn s(v: &str) -> Value {
		Value::String(v.to_string())
	}

	#[test]
	fn replacing_an_entry_keeps_every_other_byte() {
		let doc = "\u{FEFF}---\n# the page\ntitle: Old # note\nlayout:   x\n\ntags: [a, b]\n---\n<p>hi</p>\n";
		assert_eq!(
			set_key(doc, "title", &s("New")).unwrap(),
			"\u{FEFF}---\n# the page\ntitle: New\nlayout:   x\n\ntags: [a, b]\n---\n<p>hi</p>\n"
		);
	}

	#[test]
	fn replacing_a_multiline_entry_replaces_all_its_lines() {
		let doc = "---\nbody: |\n  one\n  two\nlist:\n  - 1\n  - 2\nlast: z\n---\n";
		assert_eq!(
			set_key(doc, "body", &s("x")).unwrap(),
			// Behavior change: a literal block stays a literal block when its value is replaced by a string
			// "---\nbody: x\nlist:\n  - 1\n  - 2\nlast: z\n---\n" // previous
			"---\nbody: |-\n  x\nlist:\n  - 1\n  - 2\nlast: z\n---\n"
		);
		assert_eq!(
			set_key(doc, "list", &Value::Array(vec![Value::Number(3.0)])).unwrap(),
			"---\nbody: |\n  one\n  two\nlist: [3]\nlast: z\n---\n"
		);
	}

	#[test]
	fn the_key_keeps_the_way_it_was_written() {
		let doc = "---\n\"og:title\": a\n---\n";
		assert_eq!(
			set_key(doc, "og:title", &s("b")).unwrap(),
			"---\n\"og:title\": b\n---\n"
		);
	}

	#[test]
	fn setting_the_value_an_entry_has_changes_nothing() {
		let doc = "---\ntitle: \"Quoted\"\nn: 01\n---\n";
		assert_eq!(set_key(doc, "title", &s("Quoted")).unwrap(), doc);
	}

	#[test]
	fn a_new_key_goes_to_the_end_of_the_front_matter() {
		let doc = "---\ntitle: A\n# trailing\n---\nbody";
		assert_eq!(
			set_key(doc, "layout", &s("x")).unwrap(),
			"---\ntitle: A\n# trailing\nlayout: x\n---\nbody"
		);
	}

	#[test]
	fn a_document_without_front_matter_gets_one_after_the_bom() {
		assert_eq!(
			set_key("<p>x</p>\n", "title", &s("T")).unwrap(),
			"---\ntitle: T\n---\n<p>x</p>\n"
		);
		assert_eq!(
			set_key("\u{FEFF}<p>x</p>", "title", &s("T")).unwrap(),
			"\u{FEFF}---\ntitle: T\n---\n<p>x</p>"
		);
		assert_eq!(
			set_key("---x\n", "title", &s("T")).unwrap(),
			"---\ntitle: T\n---\n---x\n"
		);
	}

	#[test]
	fn an_empty_or_comment_only_front_matter_takes_a_new_key() {
		assert_eq!(
			set_key("---\n---\nbody", "a", &Value::Bool(true)).unwrap(),
			"---\na: true\n---\nbody"
		);
		assert_eq!(
			set_key("---\n# only\n---\nbody", "a", &Value::Bool(true)).unwrap(),
			"---\n# only\na: true\n---\nbody"
		);
	}

	#[test]
	fn crlf_documents_stay_crlf() {
		let doc = "---\r\ntitle: A\r\nlayout: x\r\n---\r\nbody\r\n";
		assert_eq!(
			set_key(doc, "title", &s("B")).unwrap(),
			"---\r\ntitle: B\r\nlayout: x\r\n---\r\nbody\r\n"
		);
		assert_eq!(
			set_key(doc, "n", &Value::Number(1.0)).unwrap(),
			"---\r\ntitle: A\r\nlayout: x\r\nn: 1\r\n---\r\nbody\r\n"
		);
		assert_eq!(
			delete_key(doc, "layout").unwrap(),
			"---\r\ntitle: A\r\n---\r\nbody\r\n"
		);
	}

	#[test]
	fn the_blank_lines_and_comments_after_an_entry_belong_to_what_follows() {
		let doc = "---\nlist:\n  - 1\n\n# about layout\nlayout: x\nbody: |\n  text\n\n# about last\nlast: z\n---\n";
		assert_eq!(
			delete_key(doc, "list").unwrap(),
			"---\n\n# about layout\nlayout: x\nbody: |\n  text\n\n# about last\nlast: z\n---\n"
		);
		assert_eq!(
			set_key(doc, "list", &s("x")).unwrap(),
			"---\nlist: x\n\n# about layout\nlayout: x\nbody: |\n  text\n\n# about last\nlast: z\n---\n"
		);
		assert_eq!(
			delete_key(doc, "body").unwrap(),
			"---\nlist:\n  - 1\n\n# about layout\nlayout: x\n\n# about last\nlast: z\n---\n"
		);
	}

	#[test]
	fn a_keep_block_scalar_reads_the_same_whatever_else_is_edited() {
		let doc = "---\nbody: |+\n  text\n\n\nnext: 1\n---\n";
		let body = |doc: &str| {
			crate::split_front_matter(doc)
				.unwrap()
				.0
				.unwrap()
				.get("body")
				.cloned()
		};
		assert_eq!(body(doc), Some(s("text\n\n\n")));
		// something else is set, added, deleted: the blank lines of the scalar are still its own
		let out = set_key(doc, "next", &Value::Number(2.0)).unwrap();
		assert_eq!(out, "---\nbody: |+\n  text\n\n\nnext: 2\n---\n");
		assert_eq!(body(&out), Some(s("text\n\n\n")));
		let out = set_key(doc, "added", &Value::Number(2.0)).unwrap();
		assert_eq!(body(&out), Some(s("text\n\n\n")));
		let out = delete_key(doc, "next").unwrap();
		assert_eq!(body(&out), Some(s("text\n\n\n")));
		// the scalar itself is replaced, and what follows it is as it was
		let out = set_key(doc, "body", &s("x")).unwrap();
		assert_eq!(body(&out), Some(s("x")));
		let meta = crate::split_front_matter(&out).unwrap().0.unwrap();
		assert_eq!(meta.get("next"), Some(&Value::Number(1.0)));
		let out = delete_key(doc, "body").unwrap();
		let meta = crate::split_front_matter(&out).unwrap().0.unwrap();
		assert_eq!(meta.to_json(), r#"{"next":1}"#);
	}

	#[test]
	fn an_indented_hash_line_in_a_block_scalar_is_part_of_the_value() {
		let doc = "---\nbody: |\n  line\n  # not a comment\nnext: 1\n---\n";
		assert_eq!(delete_key(doc, "body").unwrap(), "---\nnext: 1\n---\n");
		assert_eq!(
			set_key(doc, "body", &s("x")).unwrap(),
			// Behavior change: a literal block stays a literal block when its value is replaced by a string
			// "---\nbody: x\nnext: 1\n---\n" // previous
			"---\nbody: |-\n  x\nnext: 1\n---\n"
		);
	}

	#[test]
	fn deleting_removes_the_entry_and_keeps_the_comments_between() {
		let doc = "---\na: 1\n# about b\nb:\n  - x\n  - y\nc: 3\n---\n";
		assert_eq!(
			delete_key(doc, "b").unwrap(),
			"---\na: 1\n# about b\nc: 3\n---\n"
		);
	}

	#[test]
	fn deleting_the_last_key_removes_the_fences() {
		assert_eq!(delete_key("---\na: 1\n---\nbody\n", "a").unwrap(), "body\n");
		assert_eq!(
			delete_key("\u{FEFF}---\r\na: 1\r\n---\r\nbody", "a").unwrap(),
			"\u{FEFF}body"
		);
	}

	#[test]
	fn deleting_the_last_key_keeps_the_fences_while_a_comment_remains() {
		assert_eq!(
			delete_key("---\n# keep\na: 1\n---\nbody", "a").unwrap(),
			"---\n# keep\n---\nbody"
		);
	}

	#[test]
	fn deleting_a_missing_key_is_an_error() {
		assert_eq!(
			delete_key("---\na: 1\n---\n", "z").unwrap_err(),
			EditError::NoSuchKey("z".to_string())
		);
		assert_eq!(
			delete_key("body", "z").unwrap_err(),
			EditError::NoSuchKey("z".to_string())
		);
	}

	#[test]
	fn anchors_aliases_and_merge_keys_make_the_front_matter_not_editable() {
		for doc in [
			"---\nbase: &b {x: 1}\nuse: *b\n---\n",
			"---\nbase: &b\n  x: 1\nuse:\n  <<: *b\n---\n",
			"---\nitems: [&a 1, *a]\n---\n",
		] {
			assert!(not_editable_reason(doc).unwrap().is_some(), "{doc}");
			assert!(matches!(
				set_key(doc, "x", &s("y")).unwrap_err(),
				EditError::NotEditable(_)
			));
			assert!(matches!(
				delete_key(doc, "base").unwrap_err(),
				EditError::NotEditable(_)
			));
		}
	}

	#[test]
	fn a_front_matter_that_is_not_a_mapping_is_not_editable() {
		let doc = "---\n- a\n- b\n---\n";
		assert!(not_editable_reason(doc).unwrap().is_some());
		assert!(matches!(
			set_key(doc, "x", &s("y")).unwrap_err(),
			EditError::NotEditable(_)
		));
	}

	#[test]
	fn invalid_front_matter_is_a_parse_error_with_the_line_in_the_file() {
		let err = set_key("---\na: [\n---\n", "x", &s("y")).unwrap_err();
		assert!(matches!(err, EditError::Parse(_)), "{err}");
		assert!(matches!(
			set_key("---\na: 1\n", "x", &s("y")).unwrap_err(),
			EditError::Parse(_)
		));
	}

	#[test]
	fn every_value_reads_back_as_written() {
		let values = [
			s("plain"),
			s("日本語のタイトル"),
			s(""),
			s("null"),
			s("true"),
			s("123"),
			s("1.5"),
			s("~"),
			s("- item"),
			s("# not a comment"),
			s("a: b"),
			s("a #b"),
			s("ends:"),
			s(" padded "),
			s("two\nlines"),
			s("tab\there"),
			s("quote \" inside"),
			s("'single'"),
			s("*star"),
			s("&amp"),
			s("!bang"),
			s("%percent"),
			s("@at"),
			s("`tick"),
			s("2026-01-02"),
			s("/about/history/"),
			Value::Null,
			Value::Bool(false),
			Value::Number(-12.0),
			Value::Number(0.25),
			Value::Array(vec![s("a"), Value::Number(1.0), Value::Null]),
			parse("{og: {title: T, image: \"x: y\"}, list: [1, [2, 3]]}").unwrap(),
		];
		for v in values {
			let doc = "---\ntitle: Old\n---\nbody\n".to_string();
			let out = set_key(&doc, "k", &v).unwrap();
			let (meta, body) = crate::split_front_matter(&out).unwrap();
			assert_eq!(body, "body\n", "{v:?}");
			assert_eq!(meta.unwrap().get("k"), Some(&v), "{out:?}");
			let out = set_key(&doc, "title", &v).unwrap();
			let (meta, _) = crate::split_front_matter(&out).unwrap();
			assert_eq!(meta.unwrap().get("title"), Some(&v), "{out:?}");
		}
	}

	#[test]
	fn a_fence_with_spaces_at_the_end_of_its_line_is_edited_as_a_fence() {
		// An entry is replaced in the front matter the file has; no second front matter is added
		// above it, and the fence lines keep their bytes.
		let doc = "--- \ntitle: old\n---\n<p>body</p>\n";
		assert_eq!(
			set_key(doc, "title", &s("new")).unwrap(),
			"--- \ntitle: new\n---\n<p>body</p>\n"
		);
		let doc = "---\ntitle: old\n--- \n<p>body</p>\n";
		assert_eq!(
			set_key(doc, "title", &s("new")).unwrap(),
			"---\ntitle: new\n--- \n<p>body</p>\n"
		);
		assert_eq!(
			set_key(doc, "layout", &s("x")).unwrap(),
			"---\ntitle: old\nlayout: x\n--- \n<p>body</p>\n"
		);
		let doc = "---\t\ntitle: old\n---\t\n<p>body</p>\n";
		assert_eq!(
			set_key(doc, "title", &s("new")).unwrap(),
			"---\t\ntitle: new\n---\t\n<p>body</p>\n"
		);
		assert_eq!(
			set_key("---\r\ntitle: A\r\n--- \r\nbody", "layout", &s("x")).unwrap(),
			"---\r\ntitle: A\r\nlayout: x\r\n--- \r\nbody"
		);
		// the value the file has: nothing changes, whichever fence it has
		for doc in [
			"--- \ntitle: T\n---\n<p>body</p>\n",
			"--- \ntitle: T\n--- \n<p>body</p>\n",
			"---\ntitle: T\n--- \n<p>body</p>\n",
			"---\ntitle: T\n---\t\n<p>body</p>\n",
		] {
			assert_eq!(set_key(doc, "title", &s("T")).unwrap(), doc);
		}
	}

	#[test]
	fn what_follows_the_closing_fence_stays_when_the_fences_go() {
		// What the closing line holds after `---` is the start of the body (as it is read).
		assert_eq!(
			delete_key("---\na: 1\n--- \nbody\n", "a").unwrap(),
			" \nbody\n"
		);
		assert_eq!(
			delete_key("--- \na: 1\n---\nbody\n", "a").unwrap(),
			"body\n"
		);
		assert_eq!(
			delete_key("---\na: 1\n---\t\r\nbody", "a").unwrap(),
			"\t\r\nbody"
		);
		assert_eq!(
			delete_key("--- \n# keep\na: 1\n--- \nbody", "a").unwrap(),
			"--- \n# keep\n--- \nbody"
		);
	}

	#[test]
	fn what_is_not_a_fence_is_not_edited_as_one() {
		// `---yaml` and `--- x` are not an opening fence: the document has no front matter, so
		// one is added (the text is body, as it is read).
		assert_eq!(
			set_key("---yaml\ntitle: T\n---\nbody", "a", &s("x")).unwrap(),
			"---\na: x\n---\n---yaml\ntitle: T\n---\nbody"
		);
		// no closing line: the file is refused, as it is when it is read
		for doc in [
			"---\ntitle: T\n----\nbody",
			"---\ntitle: T\n---foo\nbody",
			"---\ntitle: T\nbody",
			"--- ",
			"---\t",
		] {
			let not_closed = "front matter is not closed with a '---' line";
			assert!(
				matches!(set_key(doc, "a", &s("x")).unwrap_err(), EditError::Parse(e) if e.message == not_closed),
				"{doc:?}"
			);
			assert!(
				matches!(delete_key(doc, "title").unwrap_err(), EditError::Parse(e) if e.message == not_closed),
				"{doc:?}"
			);
		}
	}

	#[test]
	fn a_fence_with_spaces_is_found_after_a_byte_order_mark_and_at_the_end_of_the_file() {
		assert_eq!(
			set_key("\u{FEFF}--- \ntitle: A\n---\nb", "title", &s("B")).unwrap(),
			"\u{FEFF}--- \ntitle: B\n---\nb"
		);
		assert_eq!(
			delete_key("\u{FEFF}--- \na: 1\n---\nb", "a").unwrap(),
			"\u{FEFF}b"
		);
		// the closing line is the last line, and has no line break
		assert_eq!(
			set_key("---\na: 1\n--- ", "a", &Value::Number(2.0)).unwrap(),
			"---\na: 2\n--- "
		);
		assert_eq!(
			set_key("---\na: 1\n---\t", "b", &s("x")).unwrap(),
			"---\na: 1\nb: x\n---\t"
		);
	}

	#[test]
	fn a_string_that_other_yaml_readers_take_for_a_date_or_a_number_is_quoted() {
		// gray-matter (js-yaml 3) reads each of these, written plain, as a Date or a number; js-yaml
		// 4 does for some. kamado reads them as strings, and the file has to hold what they read.
		for (v, written) in [
			("2026-11-25", "\"2026-11-25\""),
			("2026-11-25T10:00:00Z", "\"2026-11-25T10:00:00Z\""),
			(
				"2026-11-25t10:00:00.5+09:00",
				"\"2026-11-25t10:00:00.5+09:00\"",
			),
			("2026-11-25 10:00:00", "\"2026-11-25 10:00:00\""),
			("2026-1-5 1:02:03 -5", "\"2026-1-5 1:02:03 -5\""),
			("1_000", "\"1_000\""),
			("07_55", "\"07_55\""),
			("-1_0", "\"-1_0\""),
			("+1_000_000", "\"+1_000_000\""),
			("0b101", "\"0b101\""),
			("-0b1_0", "\"-0b1_0\""),
			("0x1_F", "\"0x1_F\""),
			("1_0.5", "\"1_0.5\""),
			(".5_0", "\".5_0\""),
			("1:30", "\"1:30\""),
			("12:30:45", "\"12:30:45\""),
			("190:20:30", "\"190:20:30\""),
			("-1:30", "\"-1:30\""),
			("1:30.5", "\"1:30.5\""),
			// wider than what js-yaml 3 reads as a number (`[0-5]?[0-9]` after a `:`); quoting
			// more than needed reads the same everywhere
			("1:99", "\"1:99\""),
			("0:30", "\"0:30\""),
		] {
			let out = set_key("---\nt: x\n---\n", "t", &s(v)).unwrap();
			assert_eq!(out, format!("---\nt: {written}\n---\n"), "{v}");
			let (meta, _) = crate::split_front_matter(&out).unwrap();
			assert_eq!(meta.unwrap().get("t"), Some(&s(v)), "{out:?}");
		}
	}

	#[test]
	fn a_string_that_no_reader_takes_for_a_date_or_a_number_gets_no_extra_quotes() {
		for (v, written) in [
			("yes", "yes"),
			("no", "no"),
			("on", "on"),
			("2026-11", "2026-11"),
			("2026-11-25-1", "2026-11-25-1"),
			("10:30 AM", "10:30 AM"),
			("12:30:45pm", "12:30:45pm"),
			("v1_000", "v1_000"),
			("a_b", "a_b"),
			("1-2-3", "1-2-3"),
			("0b", "0b"),
			("0b2", "0b2"),
			("1:a", "1:a"),
			("Mar 3", "Mar 3"),
			// the core schema reads these as numbers, so they are quoted anyway
			("0777", "\"0777\""),
			("0755", "\"0755\""),
			("0o17", "\"0o17\""),
			("0x1F", "\"0x1F\""),
			("1e3", "\"1e3\""),
			("2026", "\"2026\""),
			("1.5", "\"1.5\""),
		] {
			let out = set_key("---\nt: x\n---\n", "t", &s(v)).unwrap();
			assert_eq!(out, format!("---\nt: {written}\n---\n"), "{v}");
		}
	}

	#[test]
	fn a_literal_block_stays_a_literal_block() {
		let doc = "---\ntitle: T\nnote: |\n  line one\n  line two\nlayout: sub\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("line one\nline two\nline three\n")).unwrap(),
			"---\ntitle: T\nnote: |\n  line one\n  line two\n  line three\nlayout: sub\n---\n"
		);
		assert_eq!(
			set_key(doc, "note", &s("line one\nline 2\n")).unwrap(),
			"---\ntitle: T\nnote: |\n  line one\n  line 2\nlayout: sub\n---\n"
		);
		// a blank line and an indented line are lines of the value
		assert_eq!(
			set_key(doc, "note", &s("one\n\n  indented\ntwo\n")).unwrap(),
			"---\ntitle: T\nnote: |\n  one\n\n    indented\n  two\nlayout: sub\n---\n"
		);
	}

	#[test]
	fn the_chomping_indicator_follows_the_newlines_at_the_end_of_the_new_value() {
		let doc = "---\nnote: |\n  a\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("a\nb")).unwrap(),
			"---\nnote: |-\n  a\n  b\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "note", &s("a\nb\n")).unwrap(),
			"---\nnote: |\n  a\n  b\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "note", &s("a\nb\n\n\n")).unwrap(),
			"---\nnote: |+\n  a\n  b\n\n\nnext: 1\n---\n"
		);
		// whichever the old one was
		for old in ["|-", "|+", "|"] {
			let doc = format!("---\nnote: {old}\n  a\nnext: 1\n---\n");
			for (new, written) in [
				("a\nb", "---\nnote: |-\n  a\n  b\nnext: 1\n---\n"),
				("a\nb\n", "---\nnote: |\n  a\n  b\nnext: 1\n---\n"),
				("a\nb\n\n", "---\nnote: |+\n  a\n  b\n\nnext: 1\n---\n"),
			] {
				assert_eq!(
					set_key(&doc, "note", &s(new)).unwrap(),
					written,
					"{old} {new:?}"
				);
			}
		}
		// the same for a folded block
		for old in [">-", ">+", ">"] {
			let doc = format!("---\nd: {old}\n  a b\nnext: 1\n---\n");
			for (new, written) in [
				("p q", "---\nd: >-\n  p q\nnext: 1\n---\n"),
				("p q\n", "---\nd: >\n  p q\nnext: 1\n---\n"),
				("p q\n\n\n", "---\nd: >+\n  p q\n\n\nnext: 1\n---\n"),
			] {
				assert_eq!(
					set_key(&doc, "d", &s(new)).unwrap(),
					written,
					"{old} {new:?}"
				);
			}
		}
	}

	#[test]
	fn the_indent_of_a_block_is_kept() {
		let doc = "---\nnote: |\n    four\n    spaces\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("four\nspaces\nmore\n")).unwrap(),
			"---\nnote: |\n    four\n    spaces\n    more\nnext: 1\n---\n"
		);
		// an indicator the old one had stays
		let doc = "---\nnote: |2\n    two more\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("  two more\nx\n")).unwrap(),
			"---\nnote: |2\n    two more\n  x\nnext: 1\n---\n"
		);
		// it is what lets the first line start with a space; without it the value is not a block
		let doc = "---\nnote: |\n  two\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("  two more\n")).unwrap(),
			"---\nnote: \"  two more\\n\"\nnext: 1\n---\n"
		);
		// a folded block: the indicator stays, and so does a one-column indent
		let doc = "---\nd: >2\n    a b\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("c d\n")).unwrap(),
			"---\nd: >2\n  c d\nnext: 1\n---\n"
		);
		let doc = "---\nd: >1\n a b\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("c d\n")).unwrap(),
			"---\nd: >1\n c d\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "d", &s("  c\n")).unwrap(),
			"---\nd: \"  c\\n\"\nnext: 1\n---\n"
		);
	}

	#[test]
	fn a_folded_block_changes_only_the_lines_that_changed() {
		let doc =
			"---\ntitle: T\ndescription: >-\n  long text one\n  continues here\nlayout: sub\n---\n";
		// words added at the end: the first line stays, the rest is folded again at the width of
		// the longest line the block had (14)
		assert_eq!(
			set_key(
				doc,
				"description",
				&s("long text one continues here (edited)")
			)
			.unwrap(),
			"---\ntitle: T\ndescription: >-\n  long text one\n  continues here\n  (edited)\nlayout: sub\n---\n"
		);
		// a word of the first line changed: the last line stays
		assert_eq!(
			set_key(doc, "description", &s("long text ONE continues here")).unwrap(),
			"---\ntitle: T\ndescription: >-\n  long text ONE\n  continues here\nlayout: sub\n---\n"
		);
		// words taken from the end
		assert_eq!(
			set_key(doc, "description", &s("long text one continues")).unwrap(),
			"---\ntitle: T\ndescription: >-\n  long text one\n  continues\nlayout: sub\n---\n"
		);
		assert_eq!(
			set_key(doc, "description", &s("long text one")).unwrap(),
			"---\ntitle: T\ndescription: >-\n  long text one\nlayout: sub\n---\n"
		);
		// the first and the last line stay, the middle is new
		let doc = "---\nd: >-\n  first line\n  old middle\n  last line\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("first line new middle words last line")).unwrap(),
			"---\nd: >-\n  first line\n  new middle\n  words\n  last line\n---\n"
		);
	}

	#[test]
	fn a_folded_block_keeps_its_paragraphs() {
		let doc = "---\nd: >\n  one two\n  three\n\n  four five\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("one two three\nfour five six\n")).unwrap(),
			"---\nd: >\n  one two\n  three\n\n  four five\n  six\nnext: 1\n---\n"
		);
		// a paragraph more: the ones that are as they were stay
		let out = set_key(doc, "d", &s("one two three\nfour five\nnew\n")).unwrap();
		assert_eq!(
			out,
			"---\nd: >\n  one two\n  three\n\n  four five\n\n  new\nnext: 1\n---\n"
		);
		// two newlines are two blank lines
		let out = set_key(doc, "d", &s("one two three\n\nfour five\n")).unwrap();
		let (meta, _) = crate::split_front_matter(&out).unwrap();
		assert_eq!(
			meta.unwrap().get("d"),
			Some(&s("one two three\n\nfour five\n"))
		);
		assert!(
			out.starts_with("---\nd: >\n  one two\n  three\n\n\n  four five\n"),
			"{out:?}"
		);
	}

	#[test]
	fn a_folded_block_that_had_one_line_is_folded_at_eighty() {
		// ten words of ten characters: seven fit in 80 (76), eight do not (87)
		let doc = "---\nd: >-\n  short\nnext: 1\n---\n";
		let words = "abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij";
		assert_eq!(
			set_key(doc, "d", &s(words)).unwrap(),
			"---\nd: >-\n  abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij abcdefghij\n  abcdefghij abcdefghij abcdefghij\nnext: 1\n---\n"
		);
	}

	#[test]
	fn a_folded_block_is_folded_at_a_width_counted_in_characters() {
		// the longest old line is 7 characters (19 bytes); four of the new words fit in 7
		// characters ("あ い う え"), and would not in 7 bytes
		let doc = "---\nd: >-\n  日本語 日本語\n  日本語 日本語\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("あ い う え お か き")).unwrap(),
			"---\nd: >-\n  あ い う え\n  お か き\nnext: 1\n---\n"
		);
	}

	#[test]
	fn a_folded_block_is_not_broken_inside_a_word_or_a_run_of_spaces() {
		// a word longer than the width has a line to itself
		let doc = "---\nd: >-\n  ab cd\n  ef gh\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("xxxxxxxxxxxxxxxxxxxx yz")).unwrap(),
			"---\nd: >-\n  xxxxxxxxxxxxxxxxxxxx\n  yz\nnext: 1\n---\n"
		);
		// two spaces are not a place to break: they stay inside the line
		let doc = "---\nd: >-\n  alpha beta\n  gamma  delta\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("alpha beta gamma  delta epsilon")).unwrap(),
			"---\nd: >-\n  alpha beta\n  gamma  delta\n  epsilon\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "d", &s("alpha beta gamma  delta  epsilon zeta")).unwrap(),
			"---\nd: >-\n  alpha beta\n  gamma  delta  epsilon\n  zeta\nnext: 1\n---\n"
		);
	}

	#[test]
	fn a_paragraph_added_in_the_middle_of_a_folded_block_folds_the_ones_after_it_again() {
		let doc = "---\nd: >\n  one\n\n  two\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "d", &s("one\nnew\ntwo\n")).unwrap(),
			"---\nd: >\n  one\n\n  new\n\n  two\nnext: 1\n---\n"
		);
	}

	#[test]
	fn fold_at_breaks_at_single_spaces_up_to_the_width() {
		assert_eq!(fold_at("aaa  bbb ccc", 5), ["aaa  bbb", "ccc"]);
		assert_eq!(fold_at("a b c d", 3), ["a b", "c d"]);
		assert_eq!(fold_at("a b c d", 1), ["a", "b", "c", "d"]);
		assert_eq!(fold_at("word", 2), ["word"]);
	}

	#[test]
	fn a_value_that_a_block_cannot_hold_is_written_plain_or_quoted() {
		let literal = "---\nnote: |\n  a\n  b\nnext: 1\n---\n";
		let folded = "---\nnote: >-\n  a\n  b\nnext: 1\n---\n";
		for doc in [literal, folded] {
			for (v, written) in [
				("", "\"\""),
				("\n", "\"\\n\""),
				("a\tb\n", "\"a\\tb\\n\""),
				("a\u{7}b", "\"a\\u0007b\""),
				("trailing \nspace", "\"trailing \\nspace\""),
				("  leading", "\"  leading\""),
			] {
				let out = set_key(doc, "note", &s(v)).unwrap();
				assert_eq!(
					out,
					format!("---\nnote: {written}\nnext: 1\n---\n"),
					"{doc:?} {v:?}"
				);
			}
		}
		// a folded block has no line that starts with a space (it would not fold)
		assert_eq!(
			set_key(folded, "note", &s("a\n  b")).unwrap(),
			"---\nnote: \"a\\n  b\"\nnext: 1\n---\n"
		);
		// a value that is not a string replaces the block
		assert_eq!(
			set_key(literal, "note", &Value::Number(5.0)).unwrap(),
			"---\nnote: 5\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(literal, "note", &Value::Null).unwrap(),
			"---\nnote: null\nnext: 1\n---\n"
		);
		// and a value that was not a block is not made one
		assert_eq!(
			set_key("---\nt: old\n---\n", "t", &s("a\nb\n")).unwrap(),
			"---\nt: \"a\\nb\\n\"\n---\n"
		);
	}

	#[test]
	fn the_blank_lines_a_keep_block_holds_go_with_its_value() {
		let value = |doc: &str, key: &str| {
			crate::split_front_matter(doc)
				.unwrap()
				.0
				.unwrap()
				.get(key)
				.cloned()
		};
		// the blank lines after `|+` are its value's, so they are replaced, not counted again
		let doc = "---\nnote: |+\n  a\n\n\nnext: 1\n---\n";
		assert_eq!(value(doc, "note"), Some(s("a\n\n\n")));
		assert_eq!(
			set_key(doc, "note", &s("b\n\n\n")).unwrap(),
			"---\nnote: |+\n  b\n\n\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "note", &s("b\n\n")).unwrap(),
			"---\nnote: |+\n  b\n\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "note", &s("b\n\n\n\n\n")).unwrap(),
			"---\nnote: |+\n  b\n\n\n\n\nnext: 1\n---\n"
		);
		// written without `+`, the lines after it are not its value, and stay
		assert_eq!(
			set_key(doc, "note", &s("b\n")).unwrap(),
			"---\nnote: |\n  b\n\n\nnext: 1\n---\n"
		);
		// a folded block that keeps its line breaks is the same
		let doc = "---\nd: >+\n  a b\n\n\nnext: 1\n---\n";
		assert_eq!(value(doc, "d"), Some(s("a b\n\n\n")));
		assert_eq!(
			set_key(doc, "d", &s("c d\n\n\n")).unwrap(),
			"---\nd: >+\n  c d\n\n\nnext: 1\n---\n"
		);
		assert_eq!(
			set_key(doc, "d", &s("c d\n\n")).unwrap(),
			"---\nd: >+\n  c d\n\nnext: 1\n---\n"
		);
		// the blank lines between entries are not the value of a block that has no `+`; they stay
		// unless the new value is written with one, which makes its own
		let doc = "---\nnote: |\n  a\n\n# about next\nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "note", &s("b\n")).unwrap(),
			"---\nnote: |\n  b\n\n# about next\nnext: 1\n---\n"
		);
		let out = set_key(doc, "note", &s("b\n\n\n")).unwrap();
		assert_eq!(out, "---\nnote: |+\n  b\n\n\n# about next\nnext: 1\n---\n");
		assert_eq!(value(&out, "note"), Some(s("b\n\n\n")));
		// a line of spaces after the entry is not replaced, and what is written has to read back
		// as the value with it: here it would add a newline, so the value is not a block
		let doc = "---\nnote: |\n  a\n  \nnext: 1\n---\n";
		let out = set_key(doc, "note", &s("b\n\n")).unwrap();
		let meta = crate::split_front_matter(&out).unwrap().0.unwrap();
		assert_eq!(meta.get("note"), Some(&s("b\n\n")), "{out:?}");
		assert_eq!(meta.get("next"), Some(&Value::Number(1.0)), "{out:?}");
		assert!(!out.contains("|+"), "{out:?}");
		// the last entry: the line breaks `+` keeps would be right before the closing fence, where
		// gray-matter does not count one of them, so the value is quoted instead
		let doc = "---\nnext: 1\nnote: |+\n  a\n\n---\nbody\n";
		assert_eq!(
			set_key(doc, "note", &s("b\n\n\n")).unwrap(),
			"---\nnext: 1\nnote: \"b\\n\\n\\n\"\n\n---\nbody\n"
		);
		let doc = "---\nnext: 1\nnote: |\n  a\n---\nbody\n";
		assert_eq!(
			set_key(doc, "note", &s("b\n\n")).unwrap(),
			"---\nnext: 1\nnote: \"b\\n\\n\"\n---\nbody\n"
		);
		// without `+` the last entry is a block as any other
		assert_eq!(
			set_key(doc, "note", &s("b\n")).unwrap(),
			"---\nnext: 1\nnote: |\n  b\n---\nbody\n"
		);
	}

	#[test]
	fn a_block_with_no_line_has_no_indent_to_keep() {
		// the value is the empty string, and nothing says how far a line is indented
		for doc in [
			"---\nnote: |\nnext: 1\n---\n",
			"---\nnote: >-\nnext: 1\n---\n",
			"---\nnote: |+\n\n\nnext: 1\n---\n",
		] {
			let out = set_key(doc, "note", &s("x\n")).unwrap();
			let meta = crate::split_front_matter(&out).unwrap().0.unwrap();
			assert_eq!(meta.get("note"), Some(&s("x\n")), "{out:?}");
			assert_eq!(meta.get("next"), Some(&Value::Number(1.0)), "{out:?}");
			assert!(out.contains("note: \"x\\n\"\n"), "{out:?}");
		}
	}

	#[test]
	fn the_comment_on_the_header_of_a_block_goes_with_the_value_it_replaces() {
		assert_eq!(
			set_key("---\nnote: |  # about it\n  a\n---\n", "note", &s("b\n")).unwrap(),
			"---\nnote: |\n  b\n---\n"
		);
		assert_eq!(
			set_key("---\nnote: >-  # about it\n  a\n---\n", "note", &s("b")).unwrap(),
			"---\nnote: >-\n  b\n---\n"
		);
	}

	#[test]
	fn what_is_not_a_line_end_for_this_parser_is_not_written_in_a_block() {
		// U+2028 and U+2029 end a line to some readers (YAML 1.1); U+0085 and `\r` are control
		// characters. Each of these values is written as a scalar, which reads back as it is.
		let doc = "---\nnote: |\n  a\nnext: 1\n---\n";
		for v in ["a\u{2028}b", "a\u{2029}b\n", "a\u{85}b\n", "a\rb\n"] {
			let out = set_key(doc, "note", &s(v)).unwrap();
			let meta = crate::split_front_matter(&out).unwrap().0.unwrap();
			assert_eq!(meta.get("note"), Some(&s(v)), "{out:?}");
			assert!(!out.contains("note: |"), "{out:?}");
		}
	}

	#[test]
	fn a_line_of_spaces_after_a_block_is_blank_only_up_to_the_indent() {
		// as long as the indent (or shorter), it is a blank line to every reader
		assert_eq!(
			set_key("---\nk: |\n  a\n  \nnext: 1\n---\n", "k", &s("new\n")).unwrap(),
			"---\nk: |\n  new\n  \nnext: 1\n---\n"
		);
		// longer, js-yaml reads it as a line of the value (spaces and a newline), which this
		// parser does not: the value is not written as a block
		let doc = "---\nk: |\n  a\n   \nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "k", &s("new\n")).unwrap(),
			"---\nk: \"new\\n\"\n   \nnext: 1\n---\n"
		);
		let doc = "---\nk: |+\n  a\n   \nnext: 1\n---\n";
		assert_eq!(
			set_key(doc, "k", &s("new\n\n")).unwrap(),
			"---\nk: \"new\\n\\n\"\n   \nnext: 1\n---\n"
		);
	}

	#[test]
	fn a_block_keeps_the_line_breaks_of_the_file() {
		let doc = "---\r\nnote: |\r\n  a\r\n  b\r\nnext: 1\r\n---\r\nbody";
		assert_eq!(
			set_key(doc, "note", &s("a\nb\nc\n")).unwrap(),
			"---\r\nnote: |\r\n  a\r\n  b\r\n  c\r\nnext: 1\r\n---\r\nbody"
		);
		let doc = "---\r\nnote: >-\r\n  a b\r\nnext: 1\r\n---\r\nbody";
		assert_eq!(
			set_key(doc, "note", &s("a b\nc")).unwrap(),
			"---\r\nnote: >-\r\n  a b\r\n\r\n  c\r\nnext: 1\r\n---\r\nbody"
		);
	}

	#[test]
	fn setting_the_value_a_block_has_changes_nothing() {
		for doc in [
			"---\nnote: |\n  a\n  b\n---\n",
			"---\nnote: >-\n  a\n  b\n---\n",
			"---\nnote: |+\n  a\n\n\nnext: 1\n---\n",
			"---\nnote: |  # about it\n  a\n---\n",
		] {
			let value = crate::split_front_matter(doc)
				.unwrap()
				.0
				.unwrap()
				.get("note")
				.cloned()
				.unwrap();
			assert_eq!(set_key(doc, "note", &value).unwrap(), doc);
		}
	}

	#[test]
	fn keys_that_are_not_simple_are_quoted() {
		assert!(matches!(
			set_key("---\nx: 1\n---\n", "<<", &s("v")).unwrap_err(),
			EditError::NotEditable(_)
		));
		for key in ["og:title", "a b", "123", "true", "日本語"] {
			let out = set_key("---\nx: 1\n---\n", key, &s("v")).unwrap();
			let (meta, _) = crate::split_front_matter(&out).unwrap();
			assert_eq!(meta.unwrap().get(key), Some(&s("v")), "{out:?}");
		}
		let out = set_key("---\nx: 1\n---\n", "plain_key-1", &s("v")).unwrap();
		assert_eq!(out, "---\nx: 1\nplain_key-1: v\n---\n");
	}

	#[test]
	fn what_is_not_edited_stays_byte_for_byte_across_many_layouts() {
		// the front matter before, and what it is after `sub` is set to "C"
		let layouts = [
			("title: A\nsub: B\n", "title: A\nsub: C\n"),
			("title: A\n\n\nsub: B\n", "title: A\n\n\nsub: C\n"),
			(
				"# c1\ntitle: A # c2\n# c3\nsub: B\n# c4\n",
				"# c1\ntitle: A # c2\n# c3\nsub: C\n# c4\n",
			),
			("title: 'A'\nsub: \"B\"\n", "title: 'A'\nsub: C\n"),
			(
				"title: |\n  long\n  text\nsub: B\n",
				"title: |\n  long\n  text\nsub: C\n",
			),
			(
				"title: >-\n  folded\n  text\n\nsub: B\n",
				"title: >-\n  folded\n  text\n\nsub: C\n",
			),
			(
				"title:\n  - a\n  - b\nsub: B\n",
				"title:\n  - a\n  - b\nsub: C\n",
			),
			(
				"title: {a: 1,\n  b: 2}\nsub: B\n",
				"title: {a: 1,\n  b: 2}\nsub: C\n",
			),
			(
				"title: multi\n  line plain\nsub: B\n",
				"title: multi\n  line plain\nsub: C\n",
			),
			(
				"sub: B\ntitle: |\n  long\n\n# about last\nlast: z\n",
				"sub: C\ntitle: |\n  long\n\n# about last\nlast: z\n",
			),
		];
		for (before, after) in layouts {
			let doc = format!("---\n{before}---\n<p>x</p>\n");
			let expected = format!("---\n{after}---\n<p>x</p>\n");
			assert_eq!(set_key(&doc, "sub", &s("C")).unwrap(), expected, "{doc:?}");
		}
	}

	#[test]
	fn a_document_without_front_matter_gets_one_in_its_own_line_breaks() {
		assert_eq!(
			set_key("<p>x</p>\r\n", "t", &s("T")).unwrap(),
			"---\r\nt: T\r\n---\r\n<p>x</p>\r\n"
		);
		assert_eq!(
			set_key("\u{FEFF}<p>x</p>\r\n<p>y</p>\r\n", "t", &s("T")).unwrap(),
			"\u{FEFF}---\r\nt: T\r\n---\r\n<p>x</p>\r\n<p>y</p>\r\n"
		);
	}

	#[test]
	fn entries_are_found_only_in_a_block_mapping_at_the_first_column() {
		for yaml in [
			"{a: 1}\n",
			"  a: 1\n  b: 2\n",
			"- a\n- b\n",
			"just text\n",
			"",
		] {
			assert_eq!(top_level_entries(yaml).unwrap(), None, "{yaml:?}");
		}
		let found = top_level_entries("a: 1\nb: [x, y]\n").unwrap().unwrap();
		assert_eq!(found.entries.len(), 2);
		assert!(!found.uses_anchors);
	}

	#[test]
	fn every_way_to_write_an_anchor_an_alias_or_a_merge_is_noticed() {
		for yaml in [
			"a: &x 1\nb: *x\n",
			"base: {x: 1}\nuse:\n  <<: {y: 2}\n",
			"list:\n  - &a 1\n  - 2\n",
			"m: {<<: {x: 1}, y: 2}\n",
			"a: {k: &v 1, l: *v}\n",
			"<<: {x: 1}\ntitle: T\n",
		] {
			let found = top_level_entries(yaml).unwrap().unwrap();
			assert!(found.uses_anchors, "{yaml:?}");
		}
	}
}

#[cfg(test)]
mod edit_keys_tests {
	use super::*;

	/// What `edit_keys` has to give: the changes made one after the other.
	fn one_by_one(doc: &str, ops: &[KeyOp<'_>]) -> Result<String, (usize, EditError)> {
		let mut out = doc.to_string();
		for (i, op) in ops.iter().enumerate() {
			out = match op {
				KeyOp::Set(key, value) => set_key(&out, key, value),
				KeyOp::Delete(key) => delete_key(&out, key),
			}
			.map_err(|e| (i, e))?;
		}
		Ok(out)
	}

	const DOCS: &[&str] = &[
		"---\ntitle: A\nlayout: x\n---\n<p>body</p>\n",
		"---\n# the page\ntitle: A\n\n# the layout\nlayout: x # trailing\n\n\norder: 1\n---\n<p>body</p>\n",
		"---\ntitle: A\nnote: |\n  one\n  two\nother: >\n  folded text\n  more\ntail: end\n---\n",
		"---\nnote: |-\n  one\n  two\n---\nbody\n",
		"---\nnote: |+\n  one\n\n\nnext: 1\n---\n",
		"---\na: 1\nb: [1, 2]\nc: {x: 1}\nd:\n  - p\n  - q\ne:\n  nested: true\n---\n",
		"---\n\"quoted key\": 1\n'single': 2\nplain: three words here\nmulti: first\n  second\n---\n",
		"---\r\ntitle: A\r\nlayout: x\r\n---\r\nbody\r\n",
		"\u{FEFF}---\ntitle: A\n---\nbody\n",
		"---\n---\nbody\n",
		"---\n# only a comment\n---\nbody\n",
		"---\ntitle: A \n--- \nbody\n",
		"body without front matter\n",
		"---\ntitle: A\nbase: &b {x: 1}\nuse: *b\n---\n",
		"---\nonly: 1\n---\n",
		"---\ntitle: A\nlayout: x\n---",
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
	fn the_changes_made_together_are_the_changes_made_one_by_one() {
		let keys = [
			"title",
			"layout",
			"order",
			"note",
			"other",
			"tail",
			"next",
			"a",
			"b",
			"c",
			"d",
			"e",
			"only",
			"plain",
			"multi",
			"quoted key",
			"single",
			"new1",
			"new2",
			"new3",
			"use",
		];
		let values = [
			Value::String("New".into()),
			Value::String("two\nlines\n".into()),
			Value::String(
				"a longer text that goes on, and on, and on, to be folded at a width somewhere in it"
					.into(),
			),
			Value::String("2026-11-25".into()),
			Value::String("x: y # z".into()),
			Value::Number(7.0),
			Value::Bool(true),
			Value::Null,
			Value::Array(vec![Value::Number(1.0), Value::String("s".into())]),
			Value::Object(vec![("k".into(), Value::String("v".into()))]),
		];
		let mut rng = Lcg(0x5EED);
		ONE_PASS.with(|c| c.set(0));
		let mut made_together = 0;
		for round in 0..6000 {
			let doc = DOCS[rng.next(DOCS.len())];
			let count = 1 + rng.next(6);
			// distinct keys most of the time, a repeated one now and then
			let mut chosen: Vec<&str> = Vec::new();
			while chosen.len() < count {
				let key = keys[rng.next(keys.len())];
				if !chosen.contains(&key) || rng.next(12) == 0 {
					chosen.push(key);
				}
			}
			let ops: Vec<KeyOp<'_>> = chosen
				.iter()
				.map(|key| {
					if rng.next(3) == 0 {
						KeyOp::Delete(key)
					} else {
						KeyOp::Set(key, &values[rng.next(values.len())])
					}
				})
				.collect();
			let expected = one_by_one(doc, &ops);
			let got = edit_keys(doc, &ops);
			assert_eq!(got, expected, "round {round}: {doc:?} with {ops:?}");
			if expected.is_ok() && ops.len() > 1 {
				made_together += 1;
			}
		}
		// the cases are not all ones that fail at the first change, and the one pass was taken
		assert!(made_together > 1000, "{made_together}");
		let one_pass = ONE_PASS.with(std::cell::Cell::get);
		assert!(one_pass > 1000, "{one_pass}");
	}

	#[test]
	fn the_keys_of_one_front_matter_are_changed_together_whatever_their_number() {
		let mut doc = String::from("---\n");
		for i in 0..3000 {
			doc.push_str(&format!("k{i}: 0\n"));
		}
		doc.push_str("---\nbody\n");
		let values: Vec<Value> = (0..3000).map(|i| Value::Number(f64::from(i))).collect();
		let names: Vec<String> = (0..3000).map(|i| format!("k{i}")).collect();
		let ops: Vec<KeyOp<'_>> = names
			.iter()
			.zip(&values)
			.map(|(k, v)| KeyOp::Set(k, v))
			.collect();
		ONE_PASS.with(|c| c.set(0));
		let out = edit_keys(&doc, &ops).unwrap();
		// one pass, whatever the number of keys: not one by one
		assert_eq!(ONE_PASS.with(std::cell::Cell::get), 1);
		assert!(out.starts_with("---\nk0: 0\nk1: 1\nk2: 2\n"));
		assert!(out.ends_with("k2999: 2999\n---\nbody\n"));
		assert_eq!(out.matches("\nk").count(), 3000);
	}

	#[test]
	fn the_change_that_fails_is_the_first_that_does() {
		let doc = "---\na: 1\nb: 2\n---\n";
		let one = Value::Number(1.0);
		let err = edit_keys(
			doc,
			&[
				KeyOp::Set("a", &one),
				KeyOp::Delete("zz"),
				KeyOp::Delete("yy"),
			],
		)
		.unwrap_err();
		assert_eq!(err, (1, EditError::NoSuchKey("zz".to_string())));
	}
}
