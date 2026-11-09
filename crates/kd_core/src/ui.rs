//! The engine behind `kamado ui` (RFC §14.2): the pages of the site as rows to show and to
//! edit, and the edits written back to the files they came from.
//!
//! The plan is made once and kept in the handle (with the plan cache, in memory), so that
//! showing a page of rows costs the rows and not the site. An edit reads the files it
//! touches again, checks them against the hashes the editor saw, and writes them only if
//! the result reads back as the edit says: what is written is checked with the readers the
//! plan uses.
//!
//! Why the hashes are of the files and not the fingerprints of the plan cache: those are
//! `(size, mtime)`, and a value replaced by another of the same length leaves them as they
//! were when the clock of the file system is coarse.

use std::collections::{BTreeSet, HashMap};
use std::fs;

use kd_jsonc::Value;
use kd_jsonc::edit::Seg;
use kd_site::meta::{Meta, Overrides};
use kd_site::{Dirs, PageFile};

use crate::plan_cache::{CachedPage, PlanCache};
use crate::session::PlanSettings;
use crate::{BuildOptions, Loaded, Page, PageKind, Plan};

/// What the editor shows for a key whose value comes from the URL.
const URL_KEY_REASON: &str = "this key sets the URL of the page; change the URL instead";

/// The file a value of the merged metadata was set in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Origin {
	InFile,
	Sidecar,
	Overrides,
}

impl Origin {
	fn name(self) -> &'static str {
		match self {
			Origin::InFile => "inFile",
			Origin::Sidecar => "sidecar",
			Origin::Overrides => "overrides",
		}
	}
}

/// Why an edit was not made: the `code` of the answer and a message.
#[derive(Debug)]
struct Fail {
	code: &'static str,
	message: String,
}

type F<T> = Result<T, Fail>;

fn fail<T>(code: &'static str, message: impl Into<String>) -> F<T> {
	Err(Fail {
		code,
		message: message.into(),
	})
}

fn io_fail(path: &str, e: &std::io::Error) -> Fail {
	Fail {
		code: "io",
		message: format!("{path}: {e}"),
	}
}

/// A change of one key of the metadata.
#[derive(Debug, Clone)]
enum KeyChange {
	Set(String, Value),
	Delete(String),
}

impl KeyChange {
	fn key(&self) -> &str {
		match self {
			KeyChange::Set(k, _) | KeyChange::Delete(k) => k,
		}
	}

	/// What the metadata of a layer reads as once the change is made.
	fn apply(&self, meta: &Meta) -> Meta {
		let mut out = meta.clone();
		match self {
			KeyChange::Set(key, value) => match out.iter_mut().find(|(k, _)| k == key) {
				Some(slot) => slot.1 = value.clone(),
				None => out.push((key.clone(), value.clone())),
			},
			KeyChange::Delete(key) => out.retain(|(k, _)| k != key),
		}
		out
	}
}

/// What the editor needs to know about a page file to say which keys it can edit.
#[derive(Debug, Clone)]
struct FileInfo {
	hash: String,
	/// Why no key of the file can be edited.
	reason: Option<String>,
	/// Keys the file writes more than once.
	duplicates: Vec<String>,
}

/// The `pages.overrides` file as it was read.
#[derive(Debug, Clone)]
struct OverridesFile {
	path: String,
	text: String,
	hash: String,
	parsed: Overrides,
}

/// The editor of the pages of one site.
pub struct Ui {
	loaded: Loaded,
	jobs: usize,
	cache_dir: String,
	incremental: bool,
	plan: Plan,
	/// What reading the page files gave, by input path (also where each key of a page comes
	/// from: the file and the sidecar are kept apart).
	cache: PlanCache,
	/// The plan cache differs from what is on disk.
	cache_dirty: bool,
	overrides: Option<OverridesFile>,
	version: u64,
	by_url: HashMap<String, usize>,
	columns: BTreeSet<String>,
	file_info: HashMap<String, FileInfo>,
}

fn hash_hex(bytes: &[u8]) -> String {
	kd_hash::to_hex(&kd_hash::sha256(bytes))
}

/// The SHA-256 of a file, or `None` if there is no such file.
fn file_hash(path: &str) -> Result<Option<String>, std::io::Error> {
	match fs::read(path) {
		Ok(bytes) => Ok(Some(hash_hex(&bytes))),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(e) => Err(e),
	}
}

fn value_to_const(v: &Value) -> kd_js::Const {
	match v {
		Value::Null => kd_js::Const::Null,
		Value::Bool(b) => kd_js::Const::Bool(*b),
		Value::Number(n) => kd_js::Const::Num(*n),
		Value::String(s) => kd_js::Const::Str(s.clone()),
		Value::Array(items) => kd_js::Const::Array(items.iter().map(value_to_const).collect()),
		Value::Object(members) => kd_js::Const::Object(
			members
				.iter()
				.map(|(k, v)| (k.clone(), value_to_const(v)))
				.collect(),
		),
	}
}

/// Whether `target` is inside `dir` once the links on the way are followed: a directory of the
/// input tree that is a link to somewhere else would take a moved page out of the tree, and
/// the names alone do not tell. The directories that `target` has yet to make are inside the
/// deepest one it has.
fn really_inside(dir: &str, target: &str) -> bool {
	let Ok(root) = fs::canonicalize(dir) else {
		return false;
	};
	let mut at = std::path::Path::new(target).parent();
	while let Some(parent) = at {
		if parent.exists() {
			return fs::canonicalize(parent).is_ok_and(|real| real.starts_with(&root));
		}
		at = parent.parent();
	}
	false
}

/// Whether a relative path leaves the directory it is relative to (a segment that only starts
/// with `..`, as `..foo`, is a name).
fn climbs(rel: &str) -> bool {
	rel == ".." || rel.starts_with("../")
}

/// Reads a file that the editor read before, and checks it is as it was: its hash is the one
/// `expect` has for `field`. One read gives the text and the hash.
fn read_expected(expect: &Value, field: &str, path: &str) -> F<String> {
	let bytes = fs::read(path).map_err(|e| io_fail(path, &e))?;
	let current = hash_hex(&bytes);
	match expect.get(field) {
		None => {
			return fail(
				"invalid",
				format!("`expect.{field}` (the hash of {path}) is required for this change"),
			);
		}
		Some(Value::String(h)) if *h == current => {}
		Some(_) => {
			return fail(
				"conflict",
				format!("{path} was changed after it was read; load the pages again"),
			);
		}
	}
	String::from_utf8(bytes).map_err(|_| Fail {
		code: "invalid",
		message: format!("{path}: file is not valid UTF-8"),
	})
}

fn hash_expectation(expect: &Value, field: &str, path: &str) -> F<()> {
	let current = file_hash(path).map_err(|e| io_fail(path, &e))?;
	match expect.get(field) {
		None => fail(
			"invalid",
			format!("`expect.{field}` (the hash of {path}) is required for this change"),
		),
		Some(Value::Null) if current.is_none() => Ok(()),
		Some(Value::String(h)) if current.as_deref() == Some(h.as_str()) => Ok(()),
		Some(_) => fail(
			"conflict",
			format!("{path} was changed after it was read; load the pages again"),
		),
	}
}

/// Edits the text of a page (front matter or `export const meta`) and checks that the page
/// reads back as the change says: its metadata, and for an HTML page its body too.
fn edit_page_text(input_path: &str, kind: PageKind, text: &str, change: &KeyChange) -> F<String> {
	let (before, body_before) = crate::parse_page_text(input_path, kind, text.to_string())
		.map_err(|message| Fail {
			code: "invalid",
			message,
		})?;
	let expected = change.apply(&before);
	let edited = match kind {
		PageKind::Html => match change {
			KeyChange::Set(k, v) => kd_yaml::edit::set_key(text, k, v),
			KeyChange::Delete(k) => kd_yaml::edit::delete_key(text, k),
		}
		.map_err(|e| match e {
			kd_yaml::edit::EditError::NotEditable(message) => Fail {
				code: "notEditable",
				message,
			},
			other => Fail {
				code: "invalid",
				message: other.to_string(),
			},
		})?,
		PageKind::Tsx => {
			let ts = !input_path.ends_with(".jsx");
			match change {
				KeyChange::Set(k, v) => {
					kd_js::meta_edit::set_key(text, true, ts, k, &value_to_const(v))
				}
				KeyChange::Delete(k) => kd_js::meta_edit::delete_key(text, true, ts, k),
			}
			.map_err(|e| match e {
				kd_js::meta_edit::EditError::NotEditable(message) => Fail {
					code: "notEditable",
					message,
				},
				other => Fail {
					code: "invalid",
					message: other.to_string(),
				},
			})?
		}
	};
	let (after, body_after) =
		crate::parse_page_text(input_path, kind, edited.clone()).map_err(|e| Fail {
			code: "invalid",
			message: format!("the edit would leave {input_path} unreadable: {e}"),
		})?;
	// The body of a TSX page is the module itself, which the edit changes; the body of an HTML
	// page is what follows the front matter, and an edit of the front matter leaves it alone.
	let body_changed = kind == PageKind::Html && body_before != body_after;
	if after != expected || body_changed {
		return fail(
			"invalid",
			format!("the edit would not read back as written in {input_path}; nothing was written"),
		);
	}
	Ok(edited)
}

/// Edits the text of a sidecar `.json` and checks that it reads back as the change says.
fn edit_sidecar_text(path: &str, text: &str, change: &KeyChange) -> F<String> {
	let parse_meta = |text: &str| -> Result<Meta, String> {
		let value = kd_jsonc::parse(text)
			.map_err(|e| format!("{path}:{}:{}: {}", e.line, e.column, e.message))?;
		kd_site::meta::as_meta(&value, path)
	};
	let before = parse_meta(text).map_err(|message| Fail {
		code: "invalid",
		message,
	})?;
	let expected = change.apply(&before);
	let edited = match change {
		KeyChange::Set(k, v) => kd_jsonc::edit::set_member(text, &[], k, v),
		KeyChange::Delete(k) => kd_jsonc::edit::delete_member(text, &[], k),
	}
	.map_err(|e| Fail {
		code: match e {
			kd_jsonc::edit::EditError::NotAContainer(_) => "notEditable",
			_ => "invalid",
		},
		message: format!("{path}: {e}"),
	})?;
	let after = parse_meta(&edited).map_err(|e| Fail {
		code: "invalid",
		message: format!("the edit would leave {path} unreadable: {e}"),
	})?;
	if after != expected {
		return fail(
			"invalid",
			format!("the edit would not read back as written in {path}; nothing was written"),
		);
	}
	Ok(edited)
}

/// Edits the entry of `url` in the text of `pages.overrides`: `change` is made to its `meta`,
/// and its `url` becomes `new_url` if that is given. `before` is what `text` reads as, so
/// `text` is known to be valid and is not parsed again (the file can be megabytes): what is
/// checked is what was changed. Everything before and after the entry must be the bytes it
/// was, and the entry must read as the change says.
fn edit_overrides_text(
	path: &str,
	text: &str,
	before: &Overrides,
	url: &str,
	change: Option<&KeyChange>,
	new_url: Option<&str>,
) -> F<String> {
	use kd_jsonc::edit::{EditError as E, trusted};
	let Some(idx) = before.order.iter().position(|u| u == url) else {
		return fail("invalid", format!("{path} has no entry for {url}"));
	};
	let entry_path = [Seg::Key("pages"), Seg::Index(idx)];
	let overrides_fail = |e: E| Fail {
		code: "invalid",
		message: format!("{path}: {e}"),
	};
	let (entry_start, entry_end) = trusted(text)
		.value_range(&entry_path)
		.map_err(overrides_fail)?;
	let mut expected = kd_jsonc::parse(&text[entry_start..entry_end]).map_err(|e| Fail {
		code: "invalid",
		message: format!("{path}: {e}"),
	})?;
	let mut edited = text.to_string();
	if let Some(change) = change {
		let meta_path = [Seg::Key("pages"), Seg::Index(idx), Seg::Key("meta")];
		match change {
			KeyChange::Set(k, v) => match trusted(&edited).set_member(&meta_path, k, v) {
				Ok(text) => edited = text,
				// the entry has no `meta` yet
				Err(E::NoSuchPath(_)) => {
					let meta = Value::Object(vec![(k.clone(), v.clone())]);
					edited = trusted(&edited)
						.set_member(&entry_path, "meta", &meta)
						.map_err(overrides_fail)?;
				}
				Err(e) => return Err(overrides_fail(e)),
			},
			KeyChange::Delete(k) => match trusted(&edited).delete_member(&meta_path, k) {
				Ok(text) => edited = text,
				Err(E::NoSuchPath(_) | E::NoSuchKey(_)) => {
					return fail("invalid", format!("{url} has no key {k:?} in {path}"));
				}
				Err(e) => return Err(overrides_fail(e)),
			},
		}
		if let Value::Object(members) = &mut expected {
			match members.iter_mut().find(|(k, _)| k == "meta") {
				Some((_, Value::Object(meta))) => *meta = change.apply(meta),
				_ => {
					if let KeyChange::Set(k, v) = change {
						members.push((
							"meta".to_string(),
							Value::Object(vec![(k.clone(), v.clone())]),
						));
					}
				}
			}
		}
	}
	if let Some(new_url) = new_url {
		if before.by_url.contains_key(new_url) {
			return fail(
				"collision",
				format!("{path} has an entry for {new_url} already"),
			);
		}
		edited = trusted(&edited)
			.set_member(&entry_path, "url", &Value::String(new_url.to_string()))
			.map_err(overrides_fail)?;
		if let Value::Object(members) = &mut expected {
			match members.iter_mut().find(|(k, _)| k == "url") {
				Some((_, v)) => *v = Value::String(new_url.to_string()),
				None => members.push(("url".to_string(), Value::String(new_url.to_string()))),
			}
		}
	}
	let unreadable = |e: &dyn std::fmt::Display| Fail {
		code: "invalid",
		message: format!("the edit would leave {path} unreadable: {e}"),
	};
	let (after_start, after_end) = trusted(&edited)
		.value_range(&entry_path)
		.map_err(|e| unreadable(&e))?;
	let outside_is_as_it_was = after_start == entry_start
		&& text[..entry_start] == edited[..entry_start]
		&& text[entry_end..] == edited[after_end..];
	let entry = kd_jsonc::parse(&edited[after_start..after_end]).map_err(|e| unreadable(&e))?;
	if !outside_is_as_it_was || entry != expected {
		return fail(
			"invalid",
			format!("the edit would not read back as written in {path}; nothing was written"),
		);
	}
	Ok(edited)
}

/// Whether `target` is a file other than `source`. A file system that does not tell cases
/// apart answers for the new spelling of the name of the file that is being moved, and that
/// is not another file. A file that cannot be looked at is in the way as much as one that can.
fn occupied(target: &str, source: &str) -> bool {
	match fs::symlink_metadata(target) {
		Ok(_) => {}
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
		Err(_) => return true,
	}
	match (fs::canonicalize(target), fs::canonicalize(source)) {
		(Ok(a), Ok(b)) => a != b,
		_ => true,
	}
}

/// Whether there is a file at `path`. A file that cannot be looked at is an error and not a
/// missing file (a sidecar that is there but cannot be read must not be left behind).
fn exists(path: &str) -> F<bool> {
	match fs::metadata(path) {
		Ok(_) => Ok(true),
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
		Err(e) => Err(io_fail(path, &e)),
	}
}

/// The directories on the way to `path` that do not exist yet, the deepest first.
fn missing_dirs(path: &std::path::Path) -> Vec<String> {
	let mut out = Vec::new();
	let mut at = path;
	while !at.exists() {
		out.push(at.to_string_lossy().into_owned());
		match at.parent() {
			Some(parent) => at = parent,
			None => break,
		}
	}
	out
}

/// Moves the relative `import`s, `export ... from`s and `import()`s of a page (type-only ones
/// too) so that they name the files they named when the page is at `to_path` and not at
/// `from_path`. `None` if there is nothing to change.
fn rewrite_relative_imports(from_path: &str, to_path: &str, text: &str) -> F<Option<String>> {
	let ts = !from_path.ends_with(".jsx");
	let parsed = kd_js::parser::Parser::parse(text, true, ts).map_err(|e| Fail {
		code: "invalid",
		message: format!("{from_path}:{e}"),
	})?;
	let from_dir = kd_site::path::dirname(from_path);
	let to_dir = kd_site::path::dirname(to_path);
	let mut specifiers: Vec<(usize, usize, String)> = parsed
		.imports
		.iter()
		.map(|r| (r.start, r.end, r.specifier.clone()))
		.collect();
	specifiers.extend(
		parsed
			.info
			.erased_imports
			.iter()
			.map(|&(start, end)| (start, end, kd_js::strings::decode(&text[start..end]))),
	);
	specifiers.sort();
	specifiers.dedup_by_key(|s| s.0);
	let mut edits: Vec<(usize, usize, String)> = Vec::new();
	for (start, end, specifier) in specifiers {
		let relative = specifier == "."
			|| specifier == ".."
			|| specifier.starts_with("./")
			|| specifier.starts_with("../");
		if !relative {
			continue;
		}
		// A query or a fragment is not part of the path.
		let (path_part, suffix) =
			specifier.split_at(specifier.find(['?', '#']).unwrap_or(specifier.len()));
		let target = kd_site::path::join(&from_dir, path_part);
		let mut moved = kd_site::path::relative(&to_dir, &target);
		if moved.is_empty() {
			moved = ".".to_string();
		} else if moved != ".." && !moved.starts_with("../") {
			moved = format!("./{moved}");
		}
		if path_part.ends_with('/') && !moved.ends_with('/') {
			moved.push('/');
		}
		let moved = format!("{moved}{suffix}");
		if moved == specifier {
			continue;
		}
		let Some(quote) = text[start..]
			.chars()
			.next()
			.filter(|c| matches!(c, '\'' | '"'))
		else {
			// not a string literal (a template literal): nothing to be sure of, nothing changed
			continue;
		};
		edits.push((start, end, kd_js::strings::quote_with(&moved, quote)));
	}
	if edits.is_empty() {
		return Ok(None);
	}
	let mut out = text.to_string();
	for (start, end, literal) in edits.into_iter().rev() {
		out.replace_range(start..end, &literal);
	}
	Ok(Some(out))
}

/// Puts back what a failed [`Txn::commit`] had done: the files written get what they held (a
/// file that was not there is removed), the files moved go back, and the directories made for
/// them are removed. Returns what could not be put back, each with the reason.
fn put_back(
	renamed: &[(String, String)],
	written: &[(String, Option<Vec<u8>>)],
	made: &[String],
) -> Vec<String> {
	let mut stuck: Vec<String> = Vec::new();
	for (path, old) in written.iter().rev() {
		let done = match old {
			Some(old) => fs::write(path, old),
			None => fs::remove_file(path),
		};
		if let Err(e) = done {
			stuck.push(format!("{path}: {e}"));
		}
	}
	for (from, to) in renamed.iter().rev() {
		if let Err(e) = fs::rename(to, from) {
			stuck.push(format!("{to}: {e}"));
		}
	}
	for dir in made {
		// A directory that is not empty now holds something that is not ours: it stays.
		let _ = fs::remove_dir(dir);
	}
	stuck
}

/// Files to write and move together: all of them or none.
#[derive(Default)]
struct Txn {
	renames: Vec<(String, String)>,
	writes: Vec<(String, String)>,
	/// The text `pages.overrides` has once the writes are made, if they include it, and
	/// whether the handle's copy of it was not the text that was edited (so the new text has to
	/// be parsed, and the parsed form cannot be changed in place).
	overrides_after: Option<(String, bool)>,
}

impl Txn {
	/// Makes the changes; if one fails, the ones made are undone: the files written get what
	/// they held (a file that was not there is removed), the files moved go back, and the
	/// directories made for them are removed. What could not be put back is in the message.
	fn commit(self) -> F<()> {
		let mut renamed: Vec<(String, String)> = Vec::new();
		// What each file held before it was written (`None`: there was no such file).
		let mut written: Vec<(String, Option<Vec<u8>>)> = Vec::new();
		let mut made: Vec<String> = Vec::new();
		let undo = |renamed: &[(String, String)],
		            written: &[(String, Option<Vec<u8>>)],
		            made: &[String],
		            failed: Fail|
		 -> Fail {
			let stuck = put_back(renamed, written, made);
			if stuck.is_empty() {
				failed
			} else {
				Fail {
					code: failed.code,
					message: format!(
						"{}; these could not be put back: {}",
						failed.message,
						stuck.join("; ")
					),
				}
			}
		};
		for (from, to) in &self.renames {
			if let Some(parent) = std::path::Path::new(to).parent() {
				let new_dirs = missing_dirs(parent);
				if let Err(e) = fs::create_dir_all(parent) {
					made.extend(new_dirs);
					return Err(undo(&renamed, &written, &made, io_fail(to, &e)));
				}
				made.extend(new_dirs);
			}
			if let Err(e) = fs::rename(from, to) {
				return Err(undo(&renamed, &written, &made, io_fail(from, &e)));
			}
			renamed.push((from.clone(), to.clone()));
		}
		for (path, text) in &self.writes {
			let old = match fs::read(path) {
				Ok(bytes) => Some(bytes),
				Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
				Err(e) => return Err(undo(&renamed, &written, &made, io_fail(path, &e))),
			};
			// Recorded before the write, so that a write that fails half way (the file is
			// truncated first) is undone too.
			written.push((path.clone(), old));
			if let Err(e) = fs::write(path, text) {
				return Err(undo(&renamed, &written, &made, io_fail(path, &e)));
			}
		}
		Ok(())
	}
}

/// What `uiPages` was asked for.
struct Query {
	offset: usize,
	limit: usize,
	q: Option<String>,
}

fn parse_query(json: &str) -> Result<Query, String> {
	let v = kd_jsonc::parse(json).map_err(|e| format!("query: invalid JSON: {e}"))?;
	let number = |key: &str| -> Result<usize, String> {
		match v.get(key) {
			Some(Value::Number(n)) if *n >= 0.0 && n.fract() == 0.0 && *n < 1e15 => Ok(*n as usize),
			_ => Err(format!("query: `{key}` must be a non-negative integer")),
		}
	};
	let q = match v.get("q") {
		None | Some(Value::Null) => None,
		Some(Value::String(s)) if s.is_empty() => None,
		Some(Value::String(s)) => Some(s.to_lowercase()),
		Some(_) => return Err("query: `q` must be a string".to_string()),
	};
	Ok(Query {
		offset: number("offset")?,
		limit: number("limit")?,
		q,
	})
}

/// The change an edit asks for.
enum Change {
	Key(KeyChange),
	MoveUrl(String),
}

struct Edit {
	url: String,
	expect: Value,
	change: Change,
}

fn parse_edit(json: &str) -> Result<Edit, String> {
	let v = kd_jsonc::parse(json).map_err(|e| format!("edit: invalid JSON: {e}"))?;
	let url = match v.get("url") {
		Some(Value::String(s)) => s.clone(),
		_ => return Err("edit: `url` (a string) is required".to_string()),
	};
	let expect = match v.get("expect") {
		Some(e @ Value::Object(_)) => e.clone(),
		None => Value::Object(Vec::new()),
		Some(_) => return Err("edit: `expect` must be an object".to_string()),
	};
	let Some(change) = v.get("change") else {
		return Err("edit: `change` is required".to_string());
	};
	let key = || match change.get("key") {
		Some(Value::String(k)) if !k.is_empty() => Ok(k.clone()),
		_ => Err("edit: `change.key` (a non-empty string) is required".to_string()),
	};
	let change = match change.get("op") {
		Some(Value::String(op)) if op == "set" => {
			let value = change
				.get("value")
				.ok_or_else(|| "edit: `change.value` is required for \"set\"".to_string())?
				.clone();
			Change::Key(KeyChange::Set(key()?, value))
		}
		Some(Value::String(op)) if op == "delete" => Change::Key(KeyChange::Delete(key()?)),
		Some(Value::String(op)) if op == "moveUrl" => match change.get("url") {
			Some(Value::String(u)) => Change::MoveUrl(u.clone()),
			_ => {
				return Err("edit: `change.url` (a string) is required for \"moveUrl\"".to_string());
			}
		},
		_ => {
			return Err("edit: `change.op` must be \"set\", \"delete\" or \"moveUrl\"".to_string());
		}
	};
	Ok(Edit {
		url,
		expect,
		change,
	})
}

impl Ui {
	/// Plans the site and keeps the plan.
	///
	/// # Errors
	///
	/// A message for any problem with the plan, as for `kamado pages`.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let json = ui.pages(r#"{"offset":0,"limit":100}"#).unwrap();
	/// assert!(json.contains(r#""total":"#));
	/// ```
	pub fn open(loaded: Loaded, options: &BuildOptions) -> Result<Ui, String> {
		let PlanSettings {
			jobs,
			cache_dir,
			incremental,
		} = crate::session::plan_settings(&loaded, options);
		let on_disk = if incremental && !options.force {
			crate::plan_cache::load(&cache_dir)
		} else {
			None
		};
		let mut ui = Ui {
			loaded,
			jobs,
			cache_dir,
			incremental,
			plan: Plan::default(),
			cache: PlanCache::default(),
			cache_dirty: false,
			overrides: None,
			version: 0,
			by_url: HashMap::new(),
			columns: BTreeSet::new(),
			file_info: HashMap::new(),
		};
		ui.plan_again(on_disk)?;
		Ok(ui)
	}

	/// Plans the site again. `disk` is the plan cache of the last build, used when this
	/// handle has none of its own yet. If the site cannot be read, nothing of the handle
	/// changes.
	fn plan_again(&mut self, disk: Option<PlanCache>) -> Result<(), String> {
		let overrides = match &self.loaded.config.pages.overrides {
			Some(path) => {
				let text = fs::read_to_string(path)
					.map_err(|e| format!("cannot read pages.overrides {path}: {e}"))?;
				let parsed = Overrides::parse(&text).map_err(|e| format!("{path}: {e}"))?;
				Some(OverridesFile {
					path: path.clone(),
					hash: hash_hex(text.as_bytes()),
					text,
					parsed,
				})
			}
			None => None,
		};
		let known: Option<&PlanCache> = match &disk {
			Some(d) => Some(d),
			None if !self.cache.pages.is_empty() => Some(&self.cache),
			None => None,
		};
		let (mut plan, learned) = crate::plan_cached(&self.loaded.config, self.jobs, known, None)?;
		// The editor never builds a page, and the text of every HTML page and the source of
		// every TSX page is megabytes on a big site: it is not kept.
		for page in &mut plan.pages {
			page.body = None;
			page.body_pending = false;
		}
		let changed = learned.changed;
		// An empty cache of the plan is the cache of a site with no page file left, or the
		// plan was made of the cache that was given (nothing new to keep).
		let no_page_file_left = plan.pages.iter().all(|p| p.is_virtual);
		if !learned.cache.pages.is_empty() || no_page_file_left {
			self.cache = learned.cache;
		} else if let Some(d) = disk {
			self.cache = d;
		}
		if changed {
			self.cache_dirty = true;
		}
		self.plan = plan;
		self.overrides = overrides;
		self.reindex();
		self.version += 1;
		Ok(())
	}

	fn reindex(&mut self) {
		self.by_url = self
			.plan
			.pages
			.iter()
			.enumerate()
			.map(|(i, p)| (p.file.url.clone(), i))
			.collect();
		self.reindex_columns();
	}

	/// The keys of the metadata of all pages, but the one that sets the URL.
	fn reindex_columns(&mut self) {
		let field = self.loaded.config.pages.output_path_field.clone();
		self.columns = self
			.plan
			.pages
			.iter()
			.flat_map(|p| p.meta.iter().map(|(k, _)| k))
			.filter(|k| Some(*k) != field.as_ref())
			.cloned()
			.collect();
	}

	/// Reads the plan again (the files are `stat`ed, and only the ones that changed are
	/// read) and returns the new version. If the site cannot be read, nothing of the handle
	/// changes.
	///
	/// # Errors
	///
	/// A message for any problem with the plan.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let before = ui.refresh().unwrap();
	/// assert!(ui.refresh().unwrap() > before);
	/// ```
	pub fn refresh(&mut self) -> Result<u64, String> {
		self.plan_again(None)?;
		Ok(self.version)
	}

	/// The plan cache is kept in memory while the handle is open; this writes it for the next
	/// `kamado` that reads it, if the handle is incremental and the cache changed. Why only
	/// now and not after each edit, as an incremental `kamado pages` writes it after each
	/// plan: an editor makes many edits, and the cache of a big site is tens of megabytes.
	/// What is not written is not lost: the files an edit wrote have a new modification
	/// time, so the next reader reads them again.
	///
	/// Returns a warning if the cache could not be written.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// assert_eq!(ui.close(), None);
	/// ```
	pub fn close(&mut self) -> Option<String> {
		if self.incremental && self.cache_dirty {
			self.cache_dirty = false;
			if let Err(e) = crate::plan_cache::save(&self.cache_dir, &self.cache) {
				return Some(format!("plan cache: {e}"));
			}
		}
		None
	}

	fn output_path_field(&self) -> Option<&str> {
		self.loaded.config.pages.output_path_field.as_deref()
	}

	/// Where the value of `key` of the page `i` was set.
	fn origin_of(&self, i: usize, key: &str) -> Origin {
		let page = &self.plan.pages[i];
		if page.is_virtual {
			return Origin::Overrides;
		}
		let in_overrides = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&page.file.url))
			.is_some_and(|o| o.meta.iter().any(|(k, _)| k == key));
		if in_overrides {
			return Origin::Overrides;
		}
		let in_sidecar = self
			.cache
			.pages
			.get(&page.file.input_path)
			.is_some_and(|c| c.side.iter().any(|(k, _)| k == key));
		if in_sidecar {
			Origin::Sidecar
		} else {
			Origin::InFile
		}
	}

	/// Why no key of the page file can be edited, and the keys it writes twice.
	fn in_file_info(&mut self, i: usize) -> (Option<String>, Vec<String>) {
		let page = &self.plan.pages[i];
		if page.is_virtual {
			return (None, Vec::new());
		}
		let path = page.file.input_path.clone();
		let hash = page.deps.get(&path).map(|d| d.hash.clone());
		if let (Some(info), Some(h)) = (self.file_info.get(&path), &hash)
			&& info.hash == *h
		{
			return (info.reason.clone(), info.duplicates.clone());
		}
		let kind = page.kind;
		let Ok(text) = fs::read_to_string(&path) else {
			return (Some(format!("{path} cannot be read")), Vec::new());
		};
		let (reason, duplicates) = match kind {
			PageKind::Html => match kd_yaml::edit::not_editable_reason(&text) {
				Ok(reason) => (reason, Vec::new()),
				Err(e) => (
					Some(format!("the front matter cannot be read: {e}")),
					Vec::new(),
				),
			},
			PageKind::Tsx => {
				let ts = !path.ends_with(".jsx");
				match (
					kd_js::meta_edit::not_editable_reason(&text, true, ts),
					kd_js::meta_edit::duplicate_keys(&text, true, ts),
				) {
					(Ok(reason), Ok(duplicates)) => (reason, duplicates),
					(Err(e), _) | (_, Err(e)) => {
						(Some(format!("the module cannot be read: {e}")), Vec::new())
					}
				}
			}
		};
		if let Some(hash) = hash {
			self.file_info.insert(
				path,
				FileInfo {
					hash,
					reason: reason.clone(),
					duplicates: duplicates.clone(),
				},
			);
		}
		(reason, duplicates)
	}

	fn page_json(&mut self, i: usize) -> Value {
		let (reason, duplicates) = self.in_file_info(i);
		let field = self.output_path_field().map(str::to_owned);
		let page = &self.plan.pages[i];
		let f = &page.file;
		let (depth, parent) = kd_site::url_depth_and_parent(&f.url);
		let hash_of = |path: &str| {
			page.deps
				.get(path)
				.map(|d| d.hash.as_str())
				.filter(|h| *h != kd_build::MISSING_FILE_HASH)
				.map_or(Value::Null, |h| Value::String(h.to_owned()))
		};
		let (input_hash, sidecar_hash) = if page.is_virtual {
			(Value::Null, Value::Null)
		} else {
			(
				hash_of(&f.input_path),
				hash_of(&crate::sidecar_path(&f.input_path)),
			)
		};
		let meta: Vec<(String, Value)> = page
			.meta
			.iter()
			.map(|(key, value)| {
				let origin = self.origin_of(i, key);
				let why: Option<String> = if Some(key.as_str()) == field.as_deref() {
					Some(URL_KEY_REASON.to_owned())
				} else if origin == Origin::InFile {
					match &reason {
						Some(r) => Some(r.clone()),
						None if duplicates.contains(key) => {
							Some("the key is written more than once in `meta`".to_owned())
						}
						None => None,
					}
				} else {
					None
				};
				let mut cell = vec![
					("value".to_owned(), value.clone()),
					("origin".to_owned(), Value::String(origin.name().to_owned())),
					("editable".to_owned(), Value::Bool(why.is_none())),
				];
				if let Some(why) = why {
					cell.push(("reason".to_owned(), Value::String(why)));
				}
				(key.clone(), Value::Object(cell))
			})
			.collect();
		Value::Object(vec![
			("url".to_owned(), Value::String(f.url.clone())),
			(
				"inputPath".to_owned(),
				if page.is_virtual {
					Value::Null
				} else {
					Value::String(f.input_path.clone())
				},
			),
			(
				"outputPath".to_owned(),
				Value::String(f.output_path.clone()),
			),
			("virtual".to_owned(), Value::Bool(page.is_virtual)),
			("depth".to_owned(), Value::Number(depth as f64)),
			(
				"parent".to_owned(),
				parent.map_or(Value::Null, Value::String),
			),
			(
				"hashes".to_owned(),
				Value::Object(vec![
					("input".to_owned(), input_hash),
					("sidecar".to_owned(), sidecar_hash),
				]),
			),
			("meta".to_owned(), Value::Object(meta)),
		])
	}

	fn overrides_hash_json(&self) -> Value {
		self.overrides
			.as_ref()
			.map_or(Value::Null, |o| Value::String(o.hash.clone()))
	}

	/// A page of rows, as the JSON of RFC §14.2. `query_json` is `{ "offset", "limit", "q"? }`.
	/// The plan is not made again; each row of the window reads its page file once (until it
	/// changes) to tell which keys can be edited, and a query `q` looks through the URL and the
	/// text values of every page.
	///
	/// # Errors
	///
	/// A message for a query that is not what it should be.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let rows = ui.pages(r#"{"offset":0,"limit":100,"q":"about"}"#).unwrap();
	/// assert!(rows.contains(r#""pages":["#));
	/// ```
	pub fn pages(&mut self, query_json: &str) -> Result<String, String> {
		let query = parse_query(query_json)?;
		let matches: Vec<usize> = match &query.q {
			None => (0..self.plan.pages.len()).collect(),
			Some(q) => self
				.plan
				.pages
				.iter()
				.enumerate()
				.filter(|(_, p)| {
					p.file.url.to_lowercase().contains(q.as_str())
						|| p.meta.iter().any(
							|(_, v)| matches!(v, Value::String(s) if s.to_lowercase().contains(q.as_str())),
						)
				})
				.map(|(i, _)| i)
				.collect(),
		};
		let total = matches.len();
		let start = query.offset.min(total);
		let end = start.saturating_add(query.limit).min(total);
		let rows: Vec<Value> = matches[start..end]
			.iter()
			.map(|&i| self.page_json(i))
			.collect();
		Ok(Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			("total".to_owned(), Value::Number(total as f64)),
			(
				"columns".to_owned(),
				Value::Array(
					self.columns
						.iter()
						.map(|c| Value::String(c.clone()))
						.collect(),
				),
			),
			("overridesHash".to_owned(), self.overrides_hash_json()),
			("pages".to_owned(), Value::Array(rows)),
			(
				"warnings".to_owned(),
				Value::Array(
					self.plan
						.warnings
						.iter()
						.map(|w| Value::String(w.clone()))
						.collect(),
				),
			),
		])
		.to_json())
	}

	fn ok_json(&mut self, i: usize) -> String {
		Value::Object(vec![
			("ok".to_owned(), Value::Bool(true)),
			("version".to_owned(), Value::Number(self.version as f64)),
			("overridesHash".to_owned(), self.overrides_hash_json()),
			("page".to_owned(), self.page_json(i)),
		])
		.to_json()
	}

	fn fail_json(&mut self, fail: &Fail, current: Option<usize>) -> String {
		let mut members = vec![
			("ok".to_owned(), Value::Bool(false)),
			("code".to_owned(), Value::String(fail.code.to_owned())),
			("message".to_owned(), Value::String(fail.message.clone())),
		];
		if let Some(i) = current {
			members.push(("current".to_owned(), self.page_json(i)));
		}
		Value::Object(members).to_json()
	}

	/// Makes one edit (RFC §14.2). The answer says whether it was made; an edit that is
	/// refused (a changed file, an invalid value, a collision) is an answer, not an error.
	///
	/// # Errors
	///
	/// A message for an edit request that is not what it should be.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let answer = ui
	///     .edit(r#"{"url":"/about/","expect":{"input":null},"change":{"op":"delete","key":"title"}}"#)
	///     .unwrap();
	/// assert!(answer.contains(r#""ok":"#));
	/// ```
	pub fn edit(&mut self, edit_json: &str) -> Result<String, String> {
		let edit = parse_edit(edit_json)?;
		let Some(&i) = self.by_url.get(&edit.url) else {
			let f = Fail {
				code: "notFound",
				message: format!("there is no page with the URL {}", edit.url),
			};
			return Ok(self.fail_json(&f, None));
		};
		let version = self.version;
		let result = match &edit.change {
			Change::Key(change) => self.edit_key(i, &edit.expect, change),
			Change::MoveUrl(new_url) => self.move_url(i, &edit.expect, new_url),
		};
		match result {
			Ok(url) => {
				// Planning the site again counts a version of its own: the edit is one.
				if self.version == version {
					self.version += 1;
				}
				match self.by_url.get(&url).copied() {
					Some(at) => Ok(self.ok_json(at)),
					None => {
						let f = Fail {
							code: "io",
							message: format!(
								"the files were changed, but no page has the URL {url} now"
							),
						};
						Ok(self.fail_json(&f, None))
					}
				}
			}
			Err(mut f) => {
				if f.code == "conflict" {
					// `current` must carry the hashes of what the files hold now, or the
					// editor that sends them back is refused again until it reads the site.
					let reread = self
						.plan_again(None)
						.map_err(|e| e.to_string())
						.and_then(|()| {
							// The plan cache takes a file of the size and time it had for the file
							// it was: the page is read for what it is.
							match self.by_url.get(&edit.url).copied() {
								Some(at) => self.reread_page(at).map_err(|f| f.message),
								None => Ok(()),
							}
						});
					if let Err(e) = reread {
						f.message.push_str(&format!(
							" (the site could not be read again, so `current` is what was read last: {e})"
						));
					}
				}
				let current = self.by_url.get(&edit.url).copied();
				Ok(self.fail_json(&f, current))
			}
		}
	}

	/// Sets or deletes one key of the metadata of the page `i`, in the file it comes from.
	fn edit_key(&mut self, i: usize, expect: &Value, change: &KeyChange) -> F<String> {
		let key = change.key();
		if Some(key) == self.output_path_field() {
			return fail("notEditable", URL_KEY_REASON);
		}
		let exists = self.plan.pages[i].meta.iter().any(|(k, _)| k == key);
		let origin = if exists {
			self.origin_of(i, key)
		} else {
			match change {
				KeyChange::Delete(_) => {
					return fail("invalid", format!("the page has no key {key:?}"));
				}
				KeyChange::Set(..) if self.plan.pages[i].is_virtual => Origin::Overrides,
				KeyChange::Set(..) => Origin::InFile,
			}
		};
		let url = self.plan.pages[i].file.url.clone();
		let mut txn = self.key_txn(i, expect, change, origin)?;
		let overrides_after = txn.overrides_after.take();
		txn.commit()?;
		if let Err(e) = self.after_key_edit(i, change, overrides_after) {
			// The file is written, so the edit is made; what this handle knows is not what
			// the files hold, and the site is read again to make it so.
			self.plan_again(None).map_err(|message| Fail {
				code: "io",
				message: format!(
					"the file was written, but the site cannot be read now: {message} ({})",
					e.message
				),
			})?;
		}
		Ok(url)
	}

	/// What `pages.overrides` reads as: the parsed file if `text` is the text it was read from,
	/// else `text` parsed (the file was changed by someone else since).
	fn overrides_before<'a>(
		o: &'a OverridesFile,
		text: &str,
	) -> F<std::borrow::Cow<'a, Overrides>> {
		if o.text == text {
			return Ok(std::borrow::Cow::Borrowed(&o.parsed));
		}
		Overrides::parse(text)
			.map(std::borrow::Cow::Owned)
			.map_err(|e| Fail {
				code: "invalid",
				message: format!("{}: {e}", o.path),
			})
	}

	/// The write that makes `change` in `origin`, with the files checked.
	fn key_txn(&self, i: usize, expect: &Value, change: &KeyChange, origin: Origin) -> F<Txn> {
		let page = &self.plan.pages[i];
		let mut txn = Txn::default();
		match origin {
			Origin::InFile => {
				let path = &page.file.input_path;
				let text = read_expected(expect, "input", path)?;
				let edited = edit_page_text(path, page.kind, &text, change)?;
				if edited != text {
					txn.writes.push((path.clone(), edited));
				}
			}
			Origin::Sidecar => {
				let path = crate::sidecar_path(&page.file.input_path);
				let text = read_expected(expect, "sidecar", &path)?;
				let edited = edit_sidecar_text(&path, &text, change)?;
				if edited != text {
					txn.writes.push((path, edited));
				}
			}
			Origin::Overrides => {
				let Some(o) = &self.overrides else {
					return fail("invalid", "the site has no pages.overrides file");
				};
				let text = read_expected(expect, "overrides", &o.path)?;
				let before = Self::overrides_before(o, &text)?;
				let edited = edit_overrides_text(
					&o.path,
					&text,
					&before,
					&page.file.url,
					Some(change),
					None,
				)?;
				if edited != text {
					txn.writes.push((o.path.clone(), edited.clone()));
					txn.overrides_after = Some((edited, o.text != text));
				}
			}
		}
		Ok(txn)
	}

	/// Brings what the handle knows about page `i` up to date after its files were written.
	/// `overrides_after` is the text of `pages.overrides`, if the edit wrote it, and whether the
	/// copy the handle held was not the text that was edited: if it was, the entry of the page is
	/// changed in the parsed form the same way (the file is not read again); if not, the handle
	/// knows nothing it can rely on and reads the site again.
	fn after_key_edit(
		&mut self,
		i: usize,
		change: &KeyChange,
		overrides_after: Option<(String, bool)>,
	) -> F<()> {
		if let Some((text, copy_was_stale)) = overrides_after {
			if copy_was_stale {
				return self.plan_again(None).map_err(|message| Fail {
					code: "io",
					message: format!(
						"the file was written, but the site cannot be read now: {message}"
					),
				});
			}
			let url = self.plan.pages[i].file.url.clone();
			if let Some(o) = &mut self.overrides {
				if let Some(entry) = o.parsed.by_url.get_mut(&url) {
					entry.meta = change.apply(&entry.meta);
				}
				o.hash = hash_hex(text.as_bytes());
				o.text = text;
			}
		}
		self.reread_page(i)?;
		// A key set on this page is a column now, and one deleted from the last page that
		// had it is not.
		match change {
			KeyChange::Set(key, _) => {
				self.columns.insert(key.clone());
			}
			KeyChange::Delete(key) => {
				if !self
					.plan
					.pages
					.iter()
					.any(|p| p.meta.iter().any(|(k, _)| k == key))
				{
					self.columns.remove(key);
				}
			}
		}
		Ok(())
	}

	/// Reads the files of page `i` (no plan cache: the files themselves, whatever size and time
	/// they have) and takes what they say: its metadata and the hashes of its files. Why not
	/// the plan cache: a file that is rewritten with as many bytes in the same tick of the
	/// clock of the file system looks as it did (RFC §11), and the editor needs the hash of
	/// the file as it is.
	fn reread_page(&mut self, i: usize) -> F<()> {
		let page = &self.plan.pages[i];
		let url = page.file.url.clone();
		let override_meta: Option<Meta> = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&url))
			.map(|o| o.meta.clone());
		if page.is_virtual {
			self.plan.pages[i].meta = override_meta.unwrap_or_default();
			return Ok(());
		}
		let input = page.file.input_path.clone();
		let (read, _) = crate::read_files(&input, None).map_err(|message| Fail {
			code: "invalid",
			message,
		})?;
		let mut meta = kd_site::meta::merge(&[&read.in_file, &read.side]);
		if let Some(o) = &override_meta {
			meta = kd_site::meta::merge(&[&meta, o]);
		}
		let deps = std::collections::BTreeMap::from([
			(input.clone(), read.input_dep.clone()),
			(read.sidecar.clone(), read.sidecar_dep.clone()),
		]);
		self.cache.pages.insert(
			input,
			CachedPage {
				kind: read.kind,
				in_file: read.in_file,
				input_dep: read.input_dep,
				side: read.side,
				sidecar: read.sidecar,
				sidecar_dep: read.sidecar_dep,
			},
		);
		self.cache_dirty = true;
		let page = &mut self.plan.pages[i];
		page.meta = meta;
		page.deps = deps;
		Ok(())
	}

	fn dirs(&self) -> Dirs<'_> {
		let c = &self.loaded.config;
		Dirs {
			input_dir: &c.dir.input,
			output_dir: &c.dir.output,
			output_extension: &c.pages.output_extension,
		}
	}

	/// Whether the output path of `file` is taken by another page, or is a source file.
	fn output_collision(&self, skip: usize, file: &PageFile) -> Option<String> {
		for (j, p) in self.plan.pages.iter().enumerate() {
			if j != skip && p.file.output_path == file.output_path {
				return Some(format!(
					"the page {} is written to {} as well",
					p.file.url, file.output_path
				));
			}
			if !p.is_virtual && p.file.input_path == file.output_path {
				return Some(format!(
					"{} is the source file of {}",
					file.output_path, p.file.url
				));
			}
		}
		None
	}

	/// Moves the page `i` to `new_url`, in the way its URL is made (RFC §14.2).
	fn move_url(&mut self, i: usize, expect: &Value, new_url: &str) -> F<String> {
		let old_url = self.plan.pages[i].file.url.clone();
		if !new_url.starts_with('/') {
			return fail(
				"invalid",
				format!("the URL must start with '/': {new_url:?}"),
			);
		}
		if let Some(why) = kd_site::meta::not_a_page_path(new_url) {
			return fail("invalid", format!("the URL {new_url:?} {why}"));
		}
		if new_url == old_url {
			return fail("invalid", "the URL is the same as it was");
		}
		let (input_dir, extension) = {
			let c = &self.loaded.config;
			(
				c.dir.input.trim_end_matches('/').to_string(),
				c.pages.output_extension.clone(),
			)
		};
		// The page file a URL names by its place: what a page that has no key of its own to say
		// where it is can be moved to. A page whose URL a key makes can have any URL §5 allows.
		let as_page = || -> F<PageFile> {
			let rel = kd_site::url_to_local_path(new_url, &extension);
			let file = kd_site::page_file(&format!("{input_dir}/{rel}"), &self.dirs());
			if file.url != new_url {
				let ext = if extension.is_empty() {
					"a file without an extension".to_string()
				} else {
					format!("a file with {extension:?}")
				};
				return fail(
					"invalid",
					format!(
						"{new_url:?} is not written as a page URL (it would be read as {:?}); write the URL a page has: a directory with its trailing \"/\", {ext}",
						file.url
					),
				);
			}
			Ok(file)
		};
		if self.by_url.contains_key(new_url) {
			return fail("collision", format!("a page already has the URL {new_url}"));
		}
		let mut txn = Txn::default();
		let overrides_entry = self
			.overrides
			.as_ref()
			.is_some_and(|o| o.parsed.by_url.contains_key(&old_url));
		let page = self.plan.pages[i].clone();
		if page.is_virtual {
			if let Some(why) = self.output_collision(i, &as_page()?) {
				return fail("collision", why);
			}
		} else if self.url_from_field(&page) {
			let field = self
				.output_path_field()
				.map(str::to_owned)
				.unwrap_or_default();
			let base = kd_site::page_file(&page.file.input_path, &self.dirs());
			let moved =
				kd_site::apply_meta_path_override(&base, new_url, &self.dirs()).map_err(|e| {
					Fail {
						code: "invalid",
						message: format!("{new_url:?} cannot be the value of {field:?}: {e}"),
					}
				})?;
			if moved.url != new_url {
				return fail(
					"invalid",
					format!(
						"{new_url:?} would be read as the URL {:?} when it is the value of {field:?}",
						moved.url
					),
				);
			}
			if let Some(why) = self.output_collision(i, &moved) {
				return fail("collision", why);
			}
			let change = KeyChange::Set(field.clone(), Value::String(new_url.to_string()));
			txn = self.key_txn(i, expect, &change, self.field_origin(&page, &field))?;
		} else {
			as_page()?;
			let from = page.file.input_path.clone();
			let ext = kd_site::path::extname(&from).to_string();
			let rel = kd_site::url_to_local_path(new_url, &extension);
			let stem = rel.strip_suffix(extension.as_str()).unwrap_or(&rel);
			let to = format!("{input_dir}/{stem}{ext}");
			let moved = kd_site::page_file(&to, &self.dirs());
			if moved.url != new_url {
				let hint = match self.output_path_field() {
					Some(field) => format!("; the {field:?} key can give a page any URL"),
					None => String::new(),
				};
				return fail(
					"invalid",
					format!(
						"the URL {new_url:?} cannot be made by moving the file: the file {to} would have the URL {:?}{hint}",
						moved.url
					),
				);
			}
			let rel_in_input = kd_site::path::relative(&input_dir, &moved.input_path);
			if climbs(&rel_in_input) || !really_inside(&input_dir, &to) {
				return fail("invalid", format!("{to} is outside the input directory"));
			}
			let config = &self.loaded.config;
			let output_rel = kd_site::path::relative(&input_dir, &config.dir.output);
			if !output_rel.is_empty()
				&& !climbs(&output_rel)
				&& (rel_in_input == output_rel
					|| rel_in_input.starts_with(&format!("{output_rel}/")))
			{
				return fail("invalid", format!("{to} is inside the output directory"));
			}
			let matches_any = |globs: &[String]| -> Result<bool, Fail> {
				let patterns = crate::compile_globs(globs).map_err(|message| Fail {
					code: "invalid",
					message,
				})?;
				Ok(patterns.iter().any(|p| p.matches(&rel_in_input)))
			};
			if !matches_any(&config.pages.files)? || matches_any(&config.pages.ignore)? {
				return fail(
					"invalid",
					format!(
						"{rel_in_input} is not a page by pages.files and pages.ignore, so the page would leave the site"
					),
				);
			}
			let sidecar_from = crate::sidecar_path(&from);
			let sidecar_to = crate::sidecar_path(&to);
			let has_sidecar = exists(&sidecar_from)?;
			if occupied(&to, &from) {
				return fail("collision", format!("{to} already exists"));
			}
			// A sidecar at the destination is taken even if the page has none: the moved
			// page would read it as its own.
			if occupied(&sidecar_to, &sidecar_from) {
				return fail("collision", format!("{sidecar_to} already exists"));
			}
			if let Some(why) = self.output_collision(i, &moved) {
				return fail("collision", why);
			}
			let text = read_expected(expect, "input", &from)?;
			// A sidecar that is not there is part of what the editor saw (`null`): one that has
			// appeared since is a conflict, and so is one that is gone.
			hash_expectation(expect, "sidecar", &sidecar_from)?;
			// A page's own imports are relative to where it is: they follow it.
			if page.kind == PageKind::Tsx
				&& let Some(rewritten) = rewrite_relative_imports(&from, &to, &text)?
			{
				let (before, _) =
					crate::parse_page_text(&from, page.kind, text.clone()).map_err(|message| {
						Fail {
							code: "invalid",
							message,
						}
					})?;
				let (after, _) = crate::parse_page_text(&to, page.kind, rewritten.clone())
					.map_err(|e| Fail {
						code: "invalid",
						message: format!("the new imports would leave {to} unreadable: {e}"),
					})?;
				if before != after {
					return fail(
						"invalid",
						format!(
							"the new imports would change the metadata of {to}; nothing was moved"
						),
					);
				}
				txn.writes.push((to.clone(), rewritten));
			}
			txn.renames.push((from, to));
			if has_sidecar {
				txn.renames.push((sidecar_from, sidecar_to));
			}
		}
		// The entry of the page in `pages.overrides` (a virtual page is nothing but that
		// entry) is keyed by the URL, so it follows the page.
		if overrides_entry {
			let Some(o) = &self.overrides else {
				return fail("invalid", "the site has no pages.overrides file");
			};
			let text = read_expected(expect, "overrides", &o.path)?;
			let before = Self::overrides_before(o, &text)?;
			let edited =
				edit_overrides_text(&o.path, &text, &before, &old_url, None, Some(new_url))?;
			txn.writes.push((o.path.clone(), edited));
		}
		txn.commit()?;
		self.plan_again(None).map_err(|message| Fail {
			code: "io",
			message: format!(
				"the files were changed, but the site cannot be planned now: {message}"
			),
		})?;
		Ok(new_url.to_string())
	}

	/// Whether the URL of the page is made by the `outputPathField` key. The plan reads the
	/// key from the page file and its sidecar and not from `pages.overrides`, so a key that
	/// only the overrides have does not make the URL.
	fn url_from_field(&self, page: &Page) -> bool {
		let Some(field) = self.output_path_field() else {
			return false;
		};
		self.cache
			.pages
			.get(&page.file.input_path)
			.is_some_and(|c| {
				let meta = kd_site::meta::merge(&[&c.in_file, &c.side]);
				matches!(
					meta.iter().find(|(k, _)| k == field),
					Some((_, Value::String(p))) if !p.is_empty()
				)
			})
	}

	/// The file the `outputPathField` key of the page is in: the sidecar if it has the key,
	/// else the page file.
	fn field_origin(&self, page: &Page, field: &str) -> Origin {
		let in_sidecar = self
			.cache
			.pages
			.get(&page.file.input_path)
			.is_some_and(|c| c.side.iter().any(|(k, _)| k == field));
		if in_sidecar {
			Origin::Sidecar
		} else {
			Origin::InFile
		}
	}
}

#[cfg(test)]
mod tests;
