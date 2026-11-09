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
//! line.

use std::fmt;

use crate::{Error, Value, parse, resolve_plain, top_level_entries};

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

/// Where the front matter sits in a document, as byte offsets.
struct Fence {
	/// First byte of the opening `---`.
	open_start: usize,
	/// The YAML between the fences: `yaml_start..yaml_end`.
	yaml_start: usize,
	yaml_end: usize,
	/// First byte after the closing `---` line (and its line break).
	body_start: usize,
	/// The line break of the opening fence.
	eol: &'static str,
}

/// The line break the document uses: the first one it has (`\n` if it has none).
fn eol_of(doc: &str) -> &'static str {
	match doc.find('\n') {
		Some(i) if i > 0 && doc.as_bytes()[i - 1] == b'\r' => "\r\n",
		_ => "\n",
	}
}

fn bom_len(doc: &str) -> usize {
	if doc.starts_with('\u{FEFF}') { 3 } else { 0 }
}

fn find_fence(doc: &str) -> Result<Option<Fence>, EditError> {
	let open_start = bom_len(doc);
	let Some(after) = doc[open_start..].strip_prefix("---") else {
		return Ok(None);
	};
	let (eol, rest) = if let Some(r) = after.strip_prefix("\r\n") {
		("\r\n", r)
	} else if let Some(r) = after.strip_prefix('\n') {
		("\n", r)
	} else if after.is_empty() {
		("\n", after)
	} else {
		// `---x` is not a fence.
		return Ok(None);
	};
	let yaml_start = open_start + 3 + eol.len();
	let mut offset = 0;
	for line in rest.split_inclusive('\n') {
		let t = line.strip_suffix('\n').unwrap_or(line);
		let t = t.strip_suffix('\r').unwrap_or(t);
		if t == "---" {
			return Ok(Some(Fence {
				open_start,
				yaml_start,
				yaml_end: yaml_start + offset,
				body_start: yaml_start + offset + line.len(),
				eol,
			}));
		}
		offset += line.len();
	}
	Err(EditError::Parse(Error {
		line: 1,
		column: 1,
		message: "front matter is not closed with a '---' line".to_string(),
	}))
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
		return Ok(format!(
			"{}{}: {rendered}{}{}",
			&doc[..at + e.start],
			&yaml[e.start..e.key_end],
			fence.eol,
			&doc[at + e.end..]
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
/// line break after the closing one); comments that remain keep them.
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

fn render_string(s: &str) -> String {
	let indicator = s
		.chars()
		.next()
		.is_some_and(|c| "-?:,[]{}#&*!|>'\"%@`".contains(c));
	let plain_ok = !s.is_empty()
		&& matches!(resolve_plain(s), Value::String(_))
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
			"---\nbody: x\nlist:\n  - 1\n  - 2\nlast: z\n---\n"
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
			"---\nbody: x\nnext: 1\n---\n"
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
