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
use std::sync::Arc;

use kd_jsonc::Value;
use kd_jsonc::edit::Seg;
use kd_site::meta::{Meta, Overrides};
use kd_site::{Dirs, PageFile};

use crate::natural;
use crate::nav_order::ORDER_KEY;
use crate::plan_cache::{CachedPage, PlanCache};
use crate::session::PlanSettings;
use crate::{BuildOptions, Loaded, Page, PageKind, Plan};

mod batch;
mod diff;
mod moves;

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

/// What the command that serves the editor reads of the config (see [`Ui::server`]). A
/// struct and not a tuple: the input and the output directory are both strings, and which is
/// which is not for the order of a tuple to say.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ServerSettings<'a> {
	/// `devServer.port`
	pub port: u16,
	/// `devServer.open`
	pub open: bool,
	/// `dir.input`, absolute
	pub input_dir: &'a str,
	/// `dir.output`, absolute
	pub output_dir: &'a str,
	/// `pages.overrides`, absolute, if the site has one
	pub overrides: Option<&'a str>,
	/// `ui.syncFunctions`, with the scripts made absolute
	pub sync_functions: &'a [kd_config::SyncFunction],
}

impl ServerSettings<'_> {
	/// The operations of `ui.syncFunctions` as the command serving the editor reads them: an
	/// array of `{ "name", "label", "script" }` (the label as written, the script absolute).
	/// The command keeps the script paths to itself; the screen is told the names and labels
	/// only.
	pub fn sync_functions_json(&self) -> Value {
		Value::Array(
			self.sync_functions
				.iter()
				.map(|f| {
					Value::Object(vec![
						("name".to_owned(), Value::String(f.name.clone())),
						("label".to_owned(), label_json(&f.label)),
						("script".to_owned(), Value::String(f.script.clone())),
					])
				})
				.collect(),
		)
	}
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
	/// The names of the layouts in `pages.layouts.dir`, or `None` when there is no such
	/// setting. Read when the handle is opened and refreshed, not for each page of rows.
	layouts: Option<Vec<String>>,
	file_info: HashMap<String, FileInfo>,
	/// The order of every page for the last sort asked for, with the version of the plan it was
	/// made on. Making it takes a key per page and a merge sort, which a page turn, a search or
	/// a refocus of the screen must not pay again; an edit or a new plan changes the version.
	sort_cache: Option<(u64, Sort, Arc<Vec<usize>>)>,
	/// What was made of the files of HEAD (see `diff`).
	head: diff::HeadCache,
	/// The files the last edit set aside to remove and could not remove (with the reason): the
	/// answer to that edit says them as a warning. Emptied when the next edit begins.
	left_behind: Vec<String>,
	/// What the commits of the batch being made have done so far (see `edit_batch`); `None` when
	/// no batch is being made.
	batch: Option<Journal>,
	/// The page files the input directory has, kept up to date from what the commits of the
	/// batch being made did, so that planning again after each of them does not walk the
	/// directory again (see `FoundFiles`). `None` when no batch is being made.
	found: Option<batch::FoundFiles>,
	/// Where the pages are by their paths, kept for the batch being made (see `patch_plan`).
	index: Option<batch::PlanIndex>,
	/// The URLs whose entries in `pages.overrides` the edits of the batch changed since the
	/// plan was last brought up to date (see `patch_plan`).
	touched: BTreeSet<String>,
	/// How many times the site was planned again from its files since the handle was opened (the
	/// tests of a batch count them: a batch of many edits plans it once, at the end).
	plans: u64,
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

/// A label as written: the text, or the object from language to text.
fn label_json(label: &kd_config::Label) -> Value {
	match label {
		kd_config::Label::Text(text) => Value::String(text.clone()),
		kd_config::Label::Translations(pairs) => Value::Object(
			pairs
				.iter()
				.map(|(language, text)| (language.clone(), Value::String(text.clone())))
				.collect(),
		),
	}
}

/// How the config presents the metadata keys (`ui.keys`, RFC §14.2), as the screen reads it:
/// an object from key to `{ "label"?, "description"? }` in the order written, each a text or an
/// object from language to text. A key the config gives neither is an empty object.
///
/// The texts go as written, not chosen for a language: the language is the screen's (the
/// person can change it without the core being asked again), so the rule that picks a text
/// (RFC §14.2) lives there and only there. The keys go whether or not a page has them; the
/// columns are still the keys the pages hold.
fn keys_json(ui: &kd_config::UiConfig) -> Value {
	Value::Object(
		ui.keys
			.iter()
			.map(|(name, key)| {
				let mut fields = Vec::new();
				if let Some(l) = &key.label {
					fields.push(("label".to_owned(), label_json(l)));
				}
				if let Some(d) = &key.description {
					fields.push(("description".to_owned(), label_json(d)));
				}
				(name.clone(), Value::Object(fields))
			})
			.collect(),
	)
}

/// The names a layout can be given: the files `<name>.tsx` and `<name>.jsx` directly in
/// `pages.layouts.dir`, by the name without the extension, each once, in the order of their
/// bytes. The rule is the one that finds the layout of a page (a name with a path or `.` or `..`
/// is none), so a name from here is always found. `None` when `pages.layouts.dir` is not set; a
/// directory that is not there has no layouts.
fn read_layouts(config: &kd_config::Config) -> Result<Option<Vec<String>>, String> {
	let Some(dir) = &config.pages.layouts_dir else {
		return Ok(None);
	};
	let entries = match fs::read_dir(dir) {
		Ok(entries) => entries,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Some(Vec::new())),
		Err(e) => return Err(format!("cannot read pages.layouts.dir {dir}: {e}")),
	};
	let mut names: BTreeSet<String> = BTreeSet::new();
	for entry in entries {
		let entry = entry.map_err(|e| format!("cannot read pages.layouts.dir {dir}: {e}"))?;
		let Ok(file_name) = entry.file_name().into_string() else {
			continue;
		};
		let Some(name) = file_name
			.strip_suffix(".tsx")
			.or_else(|| file_name.strip_suffix(".jsx"))
		else {
			continue;
		};
		if name.is_empty() || name == "." || name == ".." || name.contains(['/', '\\', '\0']) {
			continue;
		}
		// A link is followed, as the build does; a directory called `x.tsx` is not a layout.
		if fs::metadata(entry.path()).is_ok_and(|m| m.is_file()) {
			names.insert(name.to_owned());
		}
	}
	Ok(Some(names.into_iter().collect()))
}

/// Removes the directories a move left empty: the one the file was in, then its parent, and so
/// on, up to but not including `root`. A directory that holds anything is not removed (nor are
/// the ones above it), and neither is one that is a link.
fn prune_empty_dirs(from: &str, root: &str) {
	let prefix = format!("{}/", root.trim_end_matches('/'));
	let mut at = std::path::Path::new(from).parent();
	while let Some(dir) = at {
		let Some(name) = dir.to_str() else {
			break;
		};
		if !name.starts_with(&prefix) || fs::remove_dir(dir).is_err() {
			break;
		}
		at = dir.parent();
	}
}

/// The path a person typed for a page file, read from the input directory: `\` is `/`, a
/// leading `/` is the input directory, and `.`, `..` and empty segments are folded. A path that
/// ends in `/` (or `.`, `..`) names a directory, and the file is `index` with the extension of the
/// page; a name without an extension gets it. Returns the path relative to the input directory.
fn typed_path(typed: &str, ext: &str) -> F<String> {
	let (mut parts, directory) = typed_parts(typed)?;
	if directory {
		parts.push(format!("index{ext}"));
	} else if let Some(last) = parts.last_mut() {
		let own = kd_site::path::extname(last);
		if own.is_empty() {
			last.push_str(ext);
		} else if own != ext {
			return fail(
				"invalid",
				format!(
					"the extension of the file cannot change: {last:?} has {own:?}, the file has {ext:?}"
				),
			);
		}
	}
	Ok(parts.join("/"))
}

/// The segments of a path a person typed, read from the input directory (see [`typed_path`]),
/// and whether the path names a directory (it ends in `/`, `.` or `..`).
fn typed_parts(typed: &str) -> F<(Vec<String>, bool)> {
	if typed.is_empty() {
		return fail("invalid", "the path is empty");
	}
	if typed.contains('\0') {
		return fail("invalid", "the path has a NUL character");
	}
	let typed = typed.replace('\\', "/");
	let segments: Vec<&str> = typed.split('/').collect();
	let directory = matches!(segments.last().copied(), Some("" | "." | ".."));
	let mut parts: Vec<String> = Vec::new();
	for segment in segments {
		match segment {
			"" | "." => {}
			".." => {
				if parts.pop().is_none() {
					return fail(
						"invalid",
						format!("{typed:?} is outside the input directory"),
					);
				}
			}
			name => parts.push(name.to_string()),
		}
	}
	Ok((parts, directory))
}

/// The extensions a page file has, in the order a file is looked for when only the URL of the
/// page is known (a virtual page that is given a file without a path). They are the ones
/// `crate::page_kind` takes; a test holds the two together.
const PAGE_EXTENSIONS: [&str; 4] = [".html", ".tsx", ".jsx", ".htm"];

/// The path a person typed for a page file that is not there yet, relative to the input
/// directory. It is folded as [`typed_path`] folds one, but nothing is filled in: there is no
/// file whose extension the name could take, so the name is written with its extension, which
/// is what makes the file a page and says of which kind.
fn typed_new_path(typed: &str) -> F<String> {
	let (parts, directory) = typed_parts(typed)?;
	let ext = match parts.last() {
		Some(name) if !directory => kd_site::path::extname(name).to_ascii_lowercase(),
		_ => String::new(),
	};
	if !PAGE_EXTENSIONS.contains(&ext.as_str()) {
		return fail(
			"invalid",
			format!(
				"{typed:?} does not name a page file: write the name of the file with its extension ({})",
				PAGE_EXTENSIONS.join(", ")
			),
		);
	}
	Ok(parts.join("/"))
}

/// What a page file holds when it is made: nothing for an HTML page, and for a module the
/// least a page needs to be built, a component that renders nothing.
fn new_page_text(path: &str) -> &'static str {
	match kd_site::path::extname(path).to_ascii_lowercase().as_str() {
		".tsx" | ".jsx" => "export default function Page() {\n\treturn null;\n}\n",
		_ => "",
	}
}

/// Whether there is anything at `path`: a file, a directory, or a link (also one that leads
/// nowhere: writing through it would make a file somewhere else). What cannot be looked at
/// is in the way as much as what can.
fn taken(path: &str) -> bool {
	!matches!(fs::symlink_metadata(path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
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
	hash_expected(expect, field, path, current.as_deref())
}

/// Checks that `current`, the hash of the file at `path` as it was just read (`None`: there is
/// no such file), is the one `expect` has for `field`.
fn hash_expected(expect: &Value, field: &str, path: &str, current: Option<&str>) -> F<()> {
	match expect.get(field) {
		None => fail(
			"invalid",
			format!("`expect.{field}` (the hash of {path}) is required for this change"),
		),
		Some(Value::Null) if current.is_none() => Ok(()),
		Some(Value::String(h)) if current == Some(h.as_str()) => Ok(()),
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

/// The text of one entry of `pages.overrides` (`entry`: the entry on its own, as the file has
/// it) once `change` is made to a key of its `meta`; `expected` is what the entry reads as,
/// and is changed the same way. The one place that says how a key is set or deleted in an entry,
/// for the edit of one key and for the keys of a batch, which make the same change to many.
fn change_entry(
	path: &str,
	url: &str,
	entry: &str,
	change: &KeyChange,
	expected: &mut Value,
) -> F<String> {
	use kd_jsonc::edit::{EditError as E, trusted};
	let overrides_fail = |e: E| Fail {
		code: "invalid",
		message: format!("{path}: {e}"),
	};
	let meta_path = [Seg::Key("meta")];
	let edited = match change {
		KeyChange::Set(k, v) => match trusted(entry).set_member(&meta_path, k, v) {
			Ok(text) => text,
			// The entry has no `meta` yet, or a `meta` that is `null` (which the plan reads
			// as none): the key is the first of a new one.
			Err(E::NoSuchPath(_) | E::NotAContainer(_)) => {
				let meta = Value::Object(vec![(k.clone(), v.clone())]);
				trusted(entry)
					.set_member(&[], "meta", &meta)
					.map_err(overrides_fail)?
			}
			Err(e) => return Err(overrides_fail(e)),
		},
		KeyChange::Delete(k) => match trusted(entry).delete_member(&meta_path, k) {
			Ok(text) => text,
			Err(E::NoSuchPath(_) | E::NoSuchKey(_)) => {
				return fail("invalid", format!("{url} has no key {k:?} in {path}"));
			}
			Err(e) => return Err(overrides_fail(e)),
		},
	};
	if let Value::Object(members) = expected {
		match members.iter_mut().find(|(k, _)| k == "meta") {
			Some((_, Value::Object(meta))) => *meta = change.apply(meta),
			// a `meta` that is `null` is replaced by the one the key makes
			Some((_, slot)) => {
				if let KeyChange::Set(k, v) = change {
					*slot = Value::Object(vec![(k.clone(), v.clone())]);
				}
			}
			None => {
				if let KeyChange::Set(k, v) = change {
					members.push((
						"meta".to_string(),
						Value::Object(vec![(k.clone(), v.clone())]),
					));
				}
			}
		}
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
		let entry = change_entry(
			path,
			url,
			&text[entry_start..entry_end],
			change,
			&mut expected,
		)?;
		edited = format!("{}{entry}{}", &text[..entry_start], &text[entry_end..]);
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

/// A change to the entries of `pages.overrides`, as the model of the file (what it reads as)
/// has it.
enum EntryChange<'a> {
	/// An entry after the last.
	Add(kd_site::meta::Override),
	Remove(&'a str),
	Change(EntryEdit<'a>),
	/// The entry of `old` with the URL `new`, in the same place.
	Rename {
		old: &'a str,
		new: &'a str,
	},
}

/// The entry of `url` made virtual or not, with the keys `add` set in its `meta` and the keys
/// `take` taken out of it.
struct EntryEdit<'a> {
	url: &'a str,
	is_virtual: bool,
	add: &'a Meta,
	take: &'a [String],
}

impl EntryChange<'_> {
	/// The URLs whose entries this changes.
	fn urls(&self) -> Vec<&str> {
		match self {
			EntryChange::Add(entry) => vec![entry.url.as_str()],
			EntryChange::Remove(url) => vec![url],
			EntryChange::Change(edit) => vec![edit.url],
			EntryChange::Rename { old, new } => vec![old, new],
		}
	}
}

/// What `pages.overrides` reads as once `change` is made to it. The one place that says so,
/// for the model that is checked against the file that was written (a single edit) and for the
/// model that is kept up to date by hand while a batch is made.
fn model_after(model: &mut Overrides, change: &EntryChange<'_>) {
	match change {
		EntryChange::Add(entry) => {
			model.order.push(entry.url.clone());
			model.by_url.insert(entry.url.clone(), entry.clone());
		}
		EntryChange::Remove(url) => {
			if let Some(idx) = model.order.iter().position(|u| u == url) {
				model.order.remove(idx);
			}
			model.by_url.remove(*url);
		}
		EntryChange::Change(edit) => {
			if let Some(entry) = model.by_url.get_mut(edit.url) {
				entry.is_virtual = edit.is_virtual;
				for (key, value) in edit.add.iter() {
					entry.meta = KeyChange::Set(key.clone(), value.clone()).apply(&entry.meta);
				}
				for key in edit.take {
					entry.meta.retain(|(k, _)| k != key);
				}
			}
		}
		EntryChange::Rename { old, new } => {
			if let Some(mut entry) = model.by_url.remove(*old) {
				entry.url = (*new).to_string();
				model.by_url.insert((*new).to_string(), entry);
			}
			if let Some(idx) = model.order.iter().position(|u| u == old) {
				model.order[idx] = (*new).to_string();
			}
		}
	}
}

/// The entry of a page as it is written when it is added to `pages.overrides`: the members a
/// reader needs and no others (`virtual` only when it is, `meta` only when there is some).
fn overrides_entry_value(entry: &kd_site::meta::Override) -> Value {
	let mut members = vec![("url".to_string(), Value::String(entry.url.clone()))];
	if entry.is_virtual {
		members.push(("virtual".to_string(), Value::Bool(true)));
	}
	if !entry.meta.is_empty() {
		members.push(("meta".to_string(), Value::Object(entry.meta.clone())));
	}
	if let Some(lastmod) = &entry.lastmod {
		members.push(("lastmod".to_string(), Value::String(lastmod.clone())));
	}
	Value::Object(members)
}

/// Checks that `edited`, the text of `pages.overrides` once its entries were changed, reads
/// as `expected`. The whole text is read, where an edit of one key reads the entry it
/// changed: a change of the entries themselves (one added, one removed, one made virtual or
/// not) is followed by a new plan of the site, which reads the whole file anyway, and the
/// items of the array before and after the change are not at the same offsets to compare.
fn checked_overrides(path: &str, edited: String, expected: &Overrides) -> F<String> {
	match Overrides::parse(&edited) {
		Ok(after) if after == *expected => Ok(edited),
		Ok(_) => fail(
			"invalid",
			format!("the edit would not read back as written in {path}; nothing was written"),
		),
		Err(e) => fail(
			"invalid",
			format!("the edit would leave {path} unreadable: {e}"),
		),
	}
}

fn overrides_edit_fail(path: &str, e: &kd_jsonc::edit::EditError) -> Fail {
	Fail {
		code: "invalid",
		message: format!("{path}: {e}"),
	}
}

/// The text of `pages.overrides` with `entry` added after its last entry. `before` is what
/// `text` reads as.
///
/// With `verify` the text is read back and has to read as the model says (the text of a single
/// edit); without, the caller keeps the model (see `Ui::follow_entries`) and the text is read
/// back once, when the batch it is part of is made.
fn add_overrides_entry(
	path: &str,
	text: &str,
	before: &Overrides,
	entry: kd_site::meta::Override,
	verify: bool,
) -> F<String> {
	if before.by_url.contains_key(&entry.url) {
		return fail(
			"collision",
			format!("{path} has an entry for {} already", entry.url),
		);
	}
	let edited = kd_jsonc::edit::trusted(text)
		.push_element(&[Seg::Key("pages")], &overrides_entry_value(&entry))
		.map_err(|e| overrides_edit_fail(path, &e))?;
	if !verify {
		return Ok(edited);
	}
	let mut expected = before.clone();
	model_after(&mut expected, &EntryChange::Add(entry));
	checked_overrides(path, edited, &expected)
}

/// The text of `pages.overrides` without the entry of `url`. `before` is what `text` reads as.
fn remove_overrides_entry(
	path: &str,
	text: &str,
	before: &Overrides,
	url: &str,
	verify: bool,
) -> F<String> {
	let Some(idx) = before.order.iter().position(|u| u == url) else {
		return fail("invalid", format!("{path} has no entry for {url}"));
	};
	let edited = kd_jsonc::edit::trusted(text)
		.delete_element(&[Seg::Key("pages")], idx)
		.map_err(|e| overrides_edit_fail(path, &e))?;
	if !verify {
		return Ok(edited);
	}
	let mut expected = before.clone();
	model_after(&mut expected, &EntryChange::Remove(url));
	checked_overrides(path, edited, &expected)
}

/// The text of `pages.overrides` with the entry of `url` made virtual or not, and with the
/// keys `add` added to its `meta` and the keys `take` taken from it. The other members of the
/// entry, and the keys of its `meta` that are not named, keep their bytes. A `meta` that the
/// keys taken leave empty goes with them. `before` is what `text` reads as.
fn change_overrides_entry(
	path: &str,
	text: &str,
	before: &Overrides,
	edit: &EntryEdit<'_>,
	verify: bool,
) -> F<String> {
	use kd_jsonc::edit::{EditError as E, trusted};
	let EntryEdit {
		url,
		is_virtual,
		add,
		take,
	} = *edit;
	let Some(idx) = before.order.iter().position(|u| u == url) else {
		return fail("invalid", format!("{path} has no entry for {url}"));
	};
	let bad = |e: E| overrides_edit_fail(path, &e);
	if !before.by_url.contains_key(url) {
		return fail("invalid", format!("{path} has no entry for {url}"));
	}
	let mut meta_now = before.by_url[url].meta.clone();
	// The entry is found once and edited as a text of its own: each key is then a walk over
	// the entry and not over the file, which is megabytes on a site of a hundred thousand
	// pages.
	let (start, end) = trusted(text)
		.value_range(&[Seg::Key("pages"), Seg::Index(idx)])
		.map_err(bad)?;
	let meta_path = [Seg::Key("meta")];
	let mut edited = if is_virtual {
		trusted(&text[start..end])
			.set_member(&[], "virtual", &Value::Bool(true))
			.map_err(bad)?
	} else {
		// (Only the entry of a virtual page is made not virtual, and that one says `virtual`.)
		trusted(&text[start..end])
			.delete_member(&[], "virtual")
			.map_err(bad)?
	};
	for (key, value) in add {
		edited = match trusted(&edited).set_member(&meta_path, key, value) {
			Ok(edited) => edited,
			// The entry has no `meta` yet, or a `meta` that is `null` (which reads as none).
			Err(E::NoSuchPath(_) | E::NotAContainer(_)) => trusted(&edited)
				.set_member(
					&[],
					"meta",
					&Value::Object(vec![(key.clone(), value.clone())]),
				)
				.map_err(bad)?,
			Err(e) => return Err(bad(e)),
		};
		meta_now = KeyChange::Set(key.clone(), value.clone()).apply(&meta_now);
	}
	for key in take {
		edited = trusted(&edited)
			.delete_member(&meta_path, key)
			.map_err(bad)?;
		meta_now.retain(|(k, _)| k != key);
	}
	if !take.is_empty() && meta_now.is_empty() {
		edited = trusted(&edited).delete_member(&[], "meta").map_err(bad)?;
	}
	let whole = format!("{}{edited}{}", &text[..start], &text[end..]);
	if !verify {
		return Ok(whole);
	}
	let mut expected = before.clone();
	model_after(&mut expected, &EntryChange::Change(EntryEdit { ..*edit }));
	checked_overrides(path, whole, &expected)
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

/// One change a [`Txn::commit`] made to the file system, in the order it was made.
enum Event {
	/// A file or a directory moved from the first name to the second.
	Rename(String, String),
	/// A file written, with what it held before (`None`: there was no such file).
	Write(String, Option<Vec<u8>>),
	/// Directories made for a move or a write, to be removed (those that are empty) if it is
	/// put back.
	MadeDirs(Vec<String>),
}

/// What changes made together have done, so that all of them can be put back. A single edit
/// keeps one for the length of its [`Txn::commit`]; a batch of edits (RFC §14.2) keeps one for
/// all its commits, and puts all of them back if any fails.
#[derive(Default)]
struct Journal {
	events: Vec<Event>,
	/// The names the files to remove were set aside under, until the changes are made.
	aside: Vec<String>,
	/// The places the moves and the removals left, whose empty directories are removed once
	/// the changes are made (with the input directory they stop at).
	pruned: Vec<(String, String)>,
	/// The file whose writes are held back (see `deferred`), when a batch is being made.
	defer: Option<String>,
	/// What the commits wrote to the file `defer` names, not written yet: a batch that changes
	/// many entries of `pages.overrides` writes it once, where one edit after another would
	/// read, edit, check and write the whole file each time. The handle's copy is what the
	/// edits read meanwhile (see `Ui::overrides_expected`); the file is written by
	/// `Ui::flush_overrides`, and what was not written is not there to put back.
	deferred: Option<String>,
}

impl Journal {
	/// Puts back what the events had done, last first: the files written get what they held
	/// (a file that was not there is removed), the files moved go back, and the directories
	/// made for them are removed. Returns what could not be put back, each with the reason.
	fn put_back(&mut self) -> Vec<String> {
		let mut stuck: Vec<String> = Vec::new();
		for event in self.events.drain(..).rev() {
			match event {
				Event::Write(path, old) => {
					let done = match old {
						Some(old) => fs::write(&path, old),
						None => fs::remove_file(&path),
					};
					if let Err(e) = done {
						stuck.push(format!("{path}: {e}"));
					}
				}
				Event::Rename(from, to) => {
					if let Err(e) = fs::rename(&to, &from) {
						stuck.push(format!("{to}: {e}"));
					}
				}
				Event::MadeDirs(dirs) => {
					for dir in dirs {
						// A directory that is not empty now holds something that is not ours: it
						// stays.
						let _ = fs::remove_dir(&dir);
					}
				}
			}
		}
		self.aside.clear();
		self.pruned.clear();
		self.deferred = None;
		stuck
	}

	/// Everything is made: the files that were set aside go for good (what cannot be removed
	/// is returned, with the reason, and stays where it is), and the directories the moves and
	/// the removals left empty are removed.
	fn finish(&mut self) -> Vec<String> {
		let mut left: Vec<String> = Vec::new();
		for hold in self.aside.drain(..) {
			if let Err(e) = fs::remove_file(&hold) {
				left.push(format!("{hold} ({e})"));
			}
		}
		for (from, root) in self.pruned.drain(..) {
			prune_empty_dirs(&from, &root);
		}
		self.events.clear();
		left
	}
}

/// The name a file that is to be removed has until the other changes are made: in the same
/// directory (a rename there cannot cross a file system), hidden, and with an extension that
/// is not a page's (a plan made while the file has this name reads no page of it). A name that
/// is taken (a file that an editor which was stopped half way left behind) is not used and not
/// touched: the next free one is, with a number, so that what was left never stands in the way
/// of removing a file again.
fn set_aside_name(path: &str) -> String {
	let dir = kd_site::path::dirname(path);
	let name = kd_site::path::basename(path);
	let base = format!("{dir}/.{name}.kamado-removed");
	let mut candidate = base.clone();
	let mut n = 0u32;
	// Only a name that is seen to be there is passed over. One that cannot be looked at (too
	// long for a name, a directory that cannot be searched) is tried: the rename then says why
	// it cannot be, where looking for a free name would never end.
	while fs::symlink_metadata(&candidate).is_ok() {
		n += 1;
		candidate = format!("{base}.{n}");
	}
	candidate
}

/// Files to write, move and remove together: all of them or none.
#[derive(Default)]
struct Txn {
	renames: Vec<(String, String)>,
	/// The files to remove. Each is set aside under another name before anything is written and
	/// removed for good once everything is: until then a rename brings it back as it was (its
	/// mode, and a link as a link), which writing its bytes again would not.
	removes: Vec<String>,
	writes: Vec<(String, String)>,
	/// The text `pages.overrides` has once the writes are made, if they include it, and
	/// whether the handle's copy of it was not the text that was edited (so the new text has to
	/// be parsed, and the parsed form cannot be changed in place).
	overrides_after: Option<(String, bool)>,
	/// The input directory: when the moves are made, the directories they leave empty are
	/// removed up to (not including) it.
	prune_to: Option<String>,
}

impl Txn {
	/// Makes the changes; if one fails, the ones made are undone: the files written get what
	/// they held (a file that was not there is removed), the files moved and the files set
	/// aside to be removed go back, and the directories made for them are removed. What could
	/// not be put back is in the message.
	///
	/// The last step is removing for good the files that were set aside, and it is not part of
	/// "all or none": by then every change is made (the files are gone from their names, and
	/// what was written says so). A set-aside file that cannot be removed is left where it is,
	/// hidden, as a directory that cannot be removed is left by a move. Why not undo: the files
	/// removed before it cannot come back, and taking back what was written would leave the
	/// site saying less than the files do. What was left is returned (the set-aside names, with
	/// the reason), so that the answer to the edit says it: an edit that is made and leaves a
	/// file behind is a success with a warning, not a failure.
	fn commit(self) -> F<Vec<String>> {
		self.commit_with(None)
	}

	/// [`Txn::commit`] on its own, or, with a `batch` journal, as one of the commits of a batch.
	///
	/// With a `batch` journal the changes are recorded in it and nothing is put back or finished
	/// here: the batch puts back all its commits when one fails, and finishes them all when the
	/// last is made. The answer is then empty.
	fn commit_with(self, batch: Option<&mut Journal>) -> F<Vec<String>> {
		let shared = batch.is_some();
		let mut local = Journal::default();
		let journal = match batch {
			Some(journal) => journal,
			None => &mut local,
		};
		// What went wrong, with what could not be put back when this commit is on its own.
		let undo = |journal: &mut Journal, failed: Fail| -> Fail {
			if shared {
				return failed;
			}
			let stuck = journal.put_back();
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
				let made = fs::create_dir_all(parent);
				if !new_dirs.is_empty() {
					journal.events.push(Event::MadeDirs(new_dirs));
				}
				if let Err(e) = made {
					return Err(undo(journal, io_fail(to, &e)));
				}
			}
			if let Err(e) = fs::rename(from, to) {
				return Err(undo(journal, io_fail(from, &e)));
			}
			journal.events.push(Event::Rename(from.clone(), to.clone()));
		}
		for path in &self.removes {
			let hold = set_aside_name(path);
			if let Err(e) = fs::rename(path, &hold) {
				return Err(undo(journal, io_fail(path, &e)));
			}
			journal
				.events
				.push(Event::Rename(path.clone(), hold.clone()));
			journal.aside.push(hold);
		}
		for (path, text) in &self.writes {
			if shared && journal.defer.as_deref() == Some(path.as_str()) {
				journal.deferred = Some(text.clone());
				continue;
			}
			// A file that is new can be in a directory that is new.
			if let Some(parent) = std::path::Path::new(path).parent() {
				let new_dirs = missing_dirs(parent);
				if !new_dirs.is_empty() {
					let created = fs::create_dir_all(parent);
					journal.events.push(Event::MadeDirs(new_dirs));
					if let Err(e) = created {
						return Err(undo(journal, io_fail(path, &e)));
					}
				}
			}
			let old = match fs::read(path) {
				Ok(bytes) => Some(bytes),
				Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
				Err(e) => return Err(undo(journal, io_fail(path, &e))),
			};
			// Recorded before the write, so that a write that fails half way (the file is
			// truncated first) is undone too.
			journal.events.push(Event::Write(path.clone(), old));
			if let Err(e) = fs::write(path, text) {
				return Err(undo(journal, io_fail(path, &e)));
			}
		}
		// Everything is made, so nothing is put back: what was left empty can go.
		if let Some(root) = &self.prune_to {
			for from in self
				.renames
				.iter()
				.map(|(from, _)| from)
				.chain(&self.removes)
			{
				journal.pruned.push((from.clone(), root.clone()));
			}
		}
		if shared {
			return Ok(Vec::new());
		}
		// Everything is made: what was set aside goes for good (see above for one that stays).
		Ok(journal.finish())
	}
}

/// A query that keeps this fraction of the pages or less (one in this many) sorts only those,
/// when the order of every page is not at hand: sorting a hundred thousand pages to show a
/// handful of rows is what a search after a sort would otherwise cost, once for each version.
const SMALL_QUERY_DIVISOR: usize = 8;

/// The column `sort` orders by (the identifiers of RFC §14.2).
#[derive(Clone, PartialEq, Eq)]
enum SortColumn {
	Url,
	InputPath,
	Virtual,
	OutputPath,
	Parent,
	Depth,
	Meta(String),
}

/// What a `sort.key` that names no column is answered with.
const SORT_KEY_REASON: &str = "query: `sort.key` must be `url`, `inputPath`, `virtual`, `outputPath`, `parent`, `depth` or `meta:<key>`";

/// What `meta:order` is answered with: the key places a page among its siblings only (RFC §6),
/// so ordering every page by it would mean nothing.
const SORT_ORDER_REASON: &str = "query: `sort.key` cannot be `meta:order`: it places a page among its siblings, and is not an order of all the pages";

/// The order a query asks for.
#[derive(Clone, PartialEq, Eq)]
struct Sort {
	column: SortColumn,
	/// Largest first. The pages that have no value in the column are last either way.
	desc: bool,
}

/// What `uiPages` was asked for.
struct Query {
	offset: usize,
	limit: usize,
	q: Option<String>,
	sort: Option<Sort>,
	/// The URL of a page whose window is wanted instead of the one at `offset`.
	locate: Option<String>,
}

/// The `sort` of a query: `None` when there is none (absent or `null`), an error naming the
/// field when `key` is not the identifier of a column or `desc` is not a boolean. The length
/// of a `meta:` key is not limited here; the server of `kamado ui` limits it.
fn parse_sort(v: &Value) -> Result<Option<Sort>, String> {
	let spec = match v.get("sort") {
		None | Some(Value::Null) => return Ok(None),
		Some(s @ Value::Object(_)) => s,
		Some(_) => return Err("query: `sort` must be an object".to_string()),
	};
	let column = match spec.get("key") {
		Some(Value::String(k)) if k == "url" => SortColumn::Url,
		Some(Value::String(k)) if k == "inputPath" => SortColumn::InputPath,
		Some(Value::String(k)) if k == "virtual" => SortColumn::Virtual,
		Some(Value::String(k)) if k == "outputPath" => SortColumn::OutputPath,
		Some(Value::String(k)) if k == "parent" => SortColumn::Parent,
		Some(Value::String(k)) if k == "depth" => SortColumn::Depth,
		Some(Value::String(k)) => match k.strip_prefix("meta:") {
			Some("order") => return Err(SORT_ORDER_REASON.to_string()),
			Some(name) if !name.is_empty() => SortColumn::Meta(name.to_string()),
			_ => return Err(SORT_KEY_REASON.to_string()),
		},
		_ => return Err(SORT_KEY_REASON.to_string()),
	};
	let desc = match spec.get("desc") {
		None | Some(Value::Null) => false,
		Some(Value::Bool(b)) => *b,
		Some(_) => return Err("query: `sort.desc` must be a boolean".to_string()),
	};
	Ok(Some(Sort { column, desc }))
}

/// The member `key` of a request, which must be a non-negative integer.
fn non_negative(v: &Value, key: &str) -> Result<usize, String> {
	match v.get(key) {
		Some(Value::Number(n)) if *n >= 0.0 && n.fract() == 0.0 && *n < 1e15 => Ok(*n as usize),
		_ => Err(format!("query: `{key}` must be a non-negative integer")),
	}
}

/// What `uiValues` was asked for: the name of the metadata key (the column `meta:<key>`), and
/// the most values to answer with.
struct ValuesQuery {
	key: String,
	limit: usize,
}

fn parse_values_query(json: &str) -> Result<ValuesQuery, String> {
	let v = kd_jsonc::parse(json).map_err(|e| format!("query: invalid JSON: {e}"))?;
	let key = match v.get("key") {
		Some(Value::String(k)) => match k.strip_prefix("meta:") {
			Some(name) if !name.is_empty() => name.to_string(),
			_ => return Err("query: `key` must be `meta:<key>`".to_string()),
		},
		_ => return Err("query: `key` must be `meta:<key>`".to_string()),
	};
	Ok(ValuesQuery {
		key,
		limit: non_negative(&v, "limit")?,
	})
}

fn parse_query(json: &str) -> Result<Query, String> {
	let v = kd_jsonc::parse(json).map_err(|e| format!("query: invalid JSON: {e}"))?;
	let number = |key: &str| non_negative(&v, key);
	let q = match v.get("q") {
		None | Some(Value::Null) => None,
		Some(Value::String(s)) if s.is_empty() => None,
		Some(Value::String(s)) => Some(s.to_lowercase()),
		Some(_) => return Err("query: `q` must be a string".to_string()),
	};
	let locate = match v.get("locate") {
		None | Some(Value::Null) => None,
		Some(Value::String(s)) => Some(s.clone()),
		Some(_) => return Err("query: `locate` must be a string".to_string()),
	};
	Ok(Query {
		offset: number("offset")?,
		limit: number("limit")?,
		q,
		sort: parse_sort(&v)?,
		locate,
	})
}

/// The change an edit asks for.
enum Change {
	Key(KeyChange),
	MoveUrl(String),
	/// The path of the page file, as typed (relative to the input directory).
	MovePath(String),
	/// Puts a key back as HEAD has it (`None`: the key that makes the URL), with what HEAD holds of the files.
	Revert {
		key: Option<String>,
		head: std::collections::HashMap<String, diff::HeadFile>,
	},
	/// A page that is not there yet: a page file at `path` (as typed, relative to the input
	/// directory), or a virtual page when there is no path. `url` is the URL it is to have;
	/// without one, it is the URL the place of the file gives.
	Create {
		url: Option<String>,
		path: Option<String>,
	},
	/// The page file and its sidecar go, and the page stays as an entry of `pages.overrides`.
	Virtualize,
	/// A virtual page gets a page file at the path (as typed), or where its URL says when
	/// there is no path.
	Materialize(Option<String>),
	/// The page goes: its files, and its entry in `pages.overrides`.
	DeletePage,
}

/// What an edit was, when it was made.
enum Done {
	/// The page it leaves has this URL.
	Page(String),
	/// It leaves no page.
	Gone,
}

struct Edit {
	/// The URL of the page to change; empty for a page that is made (`Change::Create` has
	/// the URL the new page is to have).
	url: String,
	expect: Value,
	change: Change,
}

fn parse_edit(json: &str) -> Result<Edit, String> {
	let v = kd_jsonc::parse(json).map_err(|e| format!("edit: invalid JSON: {e}"))?;
	let creates = matches!(
		v.get("change").and_then(|c| c.get("op")),
		Some(Value::String(op)) if op == "create"
	);
	let url = match v.get("url") {
		Some(Value::String(s)) => Some(s.clone()),
		None | Some(Value::Null) if creates => None,
		_ => return Err("edit: `url` (a string) is required".to_string()),
	};
	// The path of a page file that is to be made: a string, or none.
	let new_path = |change: &Value, op: &str| match change.get("path") {
		Some(Value::String(p)) => Ok(Some(p.clone())),
		None | Some(Value::Null) => Ok(None),
		Some(_) => Err(format!(
			"edit: `change.path` must be a string or null for \"{op}\""
		)),
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
		Some(Value::String(op)) if op == "movePath" => match change.get("path") {
			Some(Value::String(p)) => Change::MovePath(p.clone()),
			_ => {
				return Err(
					"edit: `change.path` (a string) is required for \"movePath\"".to_string(),
				);
			}
		},
		Some(Value::String(op)) if op == "revert" => Change::Revert {
			key: match change.get("key") {
				Some(Value::String(k)) if !k.is_empty() => Some(k.clone()),
				None | Some(Value::Null) => None,
				Some(_) => {
					return Err(
						"edit: `change.key` must be a non-empty string or null for \"revert\""
							.to_string(),
					);
				}
			},
			head: diff::parse_head(change.get("head")).map_err(|e| format!("edit: {e}"))?,
		},
		Some(Value::String(op)) if op == "create" => {
			let path = new_path(change, "create")?;
			if url.is_none() && path.is_none() {
				return Err(
					"edit: `url` (a string) or `change.path` (a string) is required for \"create\""
						.to_string(),
				);
			}
			Change::Create {
				url: url.clone(),
				path,
			}
		}
		Some(Value::String(op)) if op == "virtualize" => Change::Virtualize,
		Some(Value::String(op)) if op == "materialize" => {
			Change::Materialize(new_path(change, "materialize")?)
		}
		Some(Value::String(op)) if op == "deletePage" => Change::DeletePage,
		_ => {
			return Err(
				"edit: `change.op` must be \"set\", \"delete\", \"moveUrl\", \"movePath\", \"revert\", \"create\", \"virtualize\", \"materialize\" or \"deletePage\""
					.to_string(),
			);
		}
	};
	Ok(Edit {
		url: match &change {
			Change::Create { .. } => String::new(),
			_ => url.unwrap_or_default(),
		},
		expect,
		change,
	})
}

impl Ui {
	/// Plans the site and keeps the plan, and reads the names of the layouts in
	/// `pages.layouts.dir` (RFC §14.2).
	///
	/// # Errors
	///
	/// A message for any problem with the plan, as for `kamado pages`, and for a
	/// `pages.layouts.dir` that is there but cannot be read (it is not a directory, or it is not
	/// readable).
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
			layouts: None,
			file_info: HashMap::new(),
			sort_cache: None,
			head: diff::HeadCache::default(),
			left_behind: Vec::new(),
			batch: None,
			found: None,
			index: None,
			touched: BTreeSet::new(),
			plans: 0,
		};
		ui.layouts = read_layouts(&ui.loaded.config)?;
		ui.plan_again(on_disk)?;
		Ok(ui)
	}

	/// Plans the site again. `disk` is the plan cache of the last build, used when this
	/// handle has none of its own yet. If the site cannot be read, nothing of the handle
	/// changes.
	fn plan_again(&mut self, disk: Option<PlanCache>) -> Result<(), String> {
		self.plans += 1;
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
		let found = self.found.as_ref().map(batch::FoundFiles::list);
		let (mut plan, learned) = crate::plan_cached(&self.loaded.config, self.jobs, known, found)?;
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

	/// Puts the pages of the plan in the order the plan gives them (RFC §6), after the metadata
	/// of a page was changed in memory.
	fn arrange_plan(&mut self) {
		let pages = std::mem::take(&mut self.plan.pages);
		self.plan.pages = crate::nav_order::arrange(pages);
		// What was made of the places of the pages (the order of every page for a sort) names
		// pages by their place, which is not what it was.
		self.sort_cache = None;
		self.reindex();
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
		if self.index.is_some() {
			self.index = Some(batch::PlanIndex::of(&self.plan));
		}
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
		// The key that places a page is a column even when no page has it yet (RFC §14.2): a
		// person who wants to put a page somewhere starts by writing it.
		// (Unless it is the key that makes the URL, which is no column.)
		if field.as_deref() != Some(ORDER_KEY) {
			self.columns.insert(ORDER_KEY.to_owned());
		}
	}

	/// Reads the plan again (the files are `stat`ed, and only the ones that changed are
	/// read), and the names of the layouts in `pages.layouts.dir` again, and returns the new
	/// version. If the site or the layouts directory cannot be read, nothing of the handle
	/// changes.
	///
	/// # Errors
	///
	/// A message for any problem with the plan, or for a `pages.layouts.dir` that cannot be read.
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
		// Read first: a directory that cannot be read leaves the handle as it was, as a site that
		// cannot be planned does.
		let layouts = read_layouts(&self.loaded.config)?;
		self.plan_again(None)?;
		self.layouts = layouts;
		Ok(self.version)
	}

	/// What `devServer` of the config says about the port and the browser, for the command
	/// that serves the editor: it listens on the port after the dev server's and opens the
	/// browser when the dev server would. The input and output directories come with them:
	/// the screen shows the paths of the files from these, and the paths of the machine do
	/// not leave the process.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let settings = ui.server();
	/// assert!(settings.port > 0 && settings.input_dir.starts_with('/'));
	/// ```
	#[must_use]
	pub fn server(&self) -> ServerSettings<'_> {
		let config = &self.loaded.config;
		ServerSettings {
			port: config.dev_server.port,
			open: config.dev_server.open,
			input_dir: &config.dir.input,
			output_dir: &config.dir.output,
			overrides: config.pages.overrides.as_deref(),
			sync_functions: &config.ui.sync_functions,
		}
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
		let in_overrides = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&self.plan.pages[i].file.url))
			.is_some_and(|o| o.meta.iter().any(|(k, _)| k == key));
		self.origin_given(i, key, in_overrides)
	}

	/// The file the value of `key` of the page `i` comes from, given whether `pages.overrides`
	/// has it for the page (the answer of the model the caller reads: the handle's, or the one a
	/// batch keeps by hand while it is made).
	fn origin_given(&self, i: usize, key: &str, in_overrides: bool) -> Origin {
		let page = &self.plan.pages[i];
		if page.is_virtual || in_overrides {
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

	/// The order of every page for `sort` when it was made on the plan as it is now.
	fn cached_order(&self, sort: &Sort) -> Option<Arc<Vec<usize>>> {
		match &self.sort_cache {
			Some((version, cached, order)) if *version == self.version && cached == sort => {
				Some(Arc::clone(order))
			}
			_ => None,
		}
	}

	/// Every page in the order `sort` asks for, from the cache while the plan is the one it was
	/// made on.
	fn sorted_all(&mut self, sort: &Sort) -> Arc<Vec<usize>> {
		if let Some(order) = self.cached_order(sort) {
			return order;
		}
		let all: Vec<usize> = (0..self.plan.pages.len()).collect();
		let order = Arc::new(self.sorted(sort, &all));
		self.sort_cache = Some((self.version, sort.clone(), Arc::clone(&order)));
		order
	}

	/// Puts the pages `indices` names (in the order of the plan) in the order `sort` asks for. A
	/// page that has no value in the column (no such key, `null`, a virtual page's `inputPath`)
	/// goes last whichever way the column runs; pages that compare equal keep the order of the
	/// plan.
	fn sorted(&self, sort: &Sort, indices: &[usize]) -> Vec<usize> {
		let pages: Vec<&Page> = indices.iter().map(|&i| &self.plan.pages[i]).collect();
		let input_dir = self
			.loaded
			.config
			.dir
			.input
			.trim_end_matches('/')
			.to_owned();
		let mut present: Vec<usize> = Vec::new();
		let mut missing: Vec<usize> = Vec::new();
		let order = |o: std::cmp::Ordering| if sort.desc { o.reverse() } else { o };
		// Each page's key is made once, so that a comparison of a pair makes (almost) no string.
		fn arrange<K>(
			indices: &[usize],
			keys: Vec<Option<K>>,
			present: &mut Vec<usize>,
			missing: &mut Vec<usize>,
			cmp: impl Fn(&K, &K) -> std::cmp::Ordering,
		) {
			let mut at: Vec<usize> = Vec::new();
			for (n, key) in keys.iter().enumerate() {
				if key.is_some() {
					at.push(n);
				} else {
					missing.push(indices[n]);
				}
			}
			natural::sort_stable(&mut at, |&a, &b| match (&keys[a], &keys[b]) {
				(Some(x), Some(y)) => cmp(x, y),
				_ => std::cmp::Ordering::Equal,
			});
			present.extend(at.into_iter().map(|n| indices[n]));
		}
		match &sort.column {
			SortColumn::Url => {
				let keys: Vec<Option<natural::Path>> = pages
					.iter()
					.map(|p| Some(natural::Path::new(&p.file.url)))
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(natural::path(a, b))
				});
			}
			SortColumn::InputPath => {
				let keys: Vec<Option<natural::Path>> = pages
					.iter()
					.map(|p| {
						(!p.is_virtual).then(|| {
							let rel = kd_site::path::relative(&input_dir, &p.file.input_path);
							natural::Path::new(&format!("/{rel}"))
						})
					})
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(natural::path(a, b))
				});
			}
			SortColumn::Virtual => {
				let keys: Vec<Option<bool>> = pages.iter().map(|p| Some(p.is_virtual)).collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(a.cmp(b))
				});
			}
			SortColumn::OutputPath => {
				let output_dir = self
					.loaded
					.config
					.dir
					.output
					.trim_end_matches('/')
					.to_owned();
				let keys: Vec<Option<natural::Path>> = pages
					.iter()
					.map(|p| {
						let rel = kd_site::path::relative(&output_dir, &p.file.output_path);
						Some(natural::Path::new(&format!("/{rel}")))
					})
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(natural::path(a, b))
				});
			}
			SortColumn::Parent => {
				let keys: Vec<Option<natural::Path>> = pages
					.iter()
					.map(|p| {
						let (_, parent) = kd_site::url_depth_and_parent(&p.file.url);
						parent.map(|url| natural::Path::new(&url))
					})
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(natural::path(a, b))
				});
			}
			SortColumn::Depth => {
				let keys: Vec<Option<usize>> = pages
					.iter()
					.map(|p| Some(kd_site::url_depth_and_parent(&p.file.url).0))
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(a.cmp(b))
				});
			}
			SortColumn::Meta(key) => {
				let keys: Vec<Option<natural::Key>> = pages
					.iter()
					.map(|p| {
						let (_, value) = p.meta.iter().find(|(k, _)| k == key)?;
						match value {
							Value::Null => None,
							Value::String(s) => Some(natural::Key::new(s)),
							other => Some(natural::Key::new(&other.to_json())),
						}
					})
					.collect();
				arrange(indices, keys, &mut present, &mut missing, |a, b| {
					order(natural::numerical(a, b))
				});
			}
		}
		present.extend(missing);
		present
	}

	/// Every page of the plan, for a sync (RFC §14.2, "同期"): what a script is given and what
	/// the difference of its answer is made from. A JSON object with `version`,
	/// `overridesHash`, `inputDir` and `overridesFile` (absolute, or `null`), `outputPathField` (the key that decides the URL,
	/// or `null`), `warnings`, and `pages`: for each page, in the order of the plan, the entry
	/// of `kamado pages` (RFC §14.1) with `hashes` (`input` and `sidecar`, as `pages` gives
	/// them). The keys that cannot be edited are not here: see `sync_locked`.
	///
	/// The rows of `pages` are not made for this: a sync needs every page at once, with the paths
	/// of the entry and the slug and stem and extension, which the rows (made for a screen of at
	/// most 5,000) do not carry. The hashes are those the rows carry, so that a page edit asked
	/// after this is told the same thing as one asked after `pages`.
	pub fn sync_pages(&mut self) -> String {
		let n = self.plan.pages.len();
		let mut pages = Vec::with_capacity(n);
		for page in &self.plan.pages {
			let Value::Object(mut fields) = crate::page_map::entry_json(page) else {
				continue;
			};
			let hash_of = |path: &str| {
				page.deps
					.get(path)
					.map(|d| d.hash.as_str())
					.filter(|h| *h != kd_build::MISSING_FILE_HASH)
					.map_or(Value::Null, |h| Value::String(h.to_owned()))
			};
			let (input, sidecar) = if page.is_virtual {
				(Value::Null, Value::Null)
			} else {
				(
					hash_of(&page.file.input_path),
					hash_of(&crate::sidecar_path(&page.file.input_path)),
				)
			};
			fields.push((
				"hashes".to_owned(),
				Value::Object(vec![
					("input".to_owned(), input),
					("sidecar".to_owned(), sidecar),
				]),
			));
			pages.push(Value::Object(fields));
		}
		Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			("overridesHash".to_owned(), self.overrides_hash_json()),
			(
				"inputDir".to_owned(),
				Value::String(self.loaded.config.dir.input.clone()),
			),
			(
				"overridesFile".to_owned(),
				self.loaded
					.config
					.pages
					.overrides
					.clone()
					.map_or(Value::Null, Value::String),
			),
			(
				"outputPathField".to_owned(),
				self.output_path_field()
					.map_or(Value::Null, |f| Value::String(f.to_owned())),
			),
			("pages".to_owned(), Value::Array(pages)),
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
		.to_json()
	}

	/// The keys that cannot be edited, for the pages at `urls` (`{ "urls": [...] }`), for a sync
	/// (RFC §14.2, "同期"): `{ "version", "locked": { "<url>": { "<key>": "<why>" } } }`, with an
	/// object (maybe empty) for each URL a page has, and none for a URL no page has.
	///
	/// Apart from `sync_pages` because it is the expensive half: telling whether a key can be
	/// edited reads and parses the page file, which for 100,000 pages is most of the time of
	/// listing them. A sync needs it for the pages whose keys it would change, and only for them.
	///
	/// # Errors
	///
	/// A message when `query_json` is not `{ "urls": [strings] }`.
	pub fn sync_locked(&mut self, query_json: &str) -> Result<String, String> {
		let query = kd_jsonc::parse(query_json).map_err(|e| format!("sync: invalid JSON: {e}"))?;
		let Some(Value::Array(urls)) = query.get("urls") else {
			return Err("sync: `urls` (an array of strings) is required".to_owned());
		};
		let mut wanted = Vec::with_capacity(urls.len());
		let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
		for url in urls {
			let Value::String(url) = url else {
				return Err("sync: `urls` must hold strings".to_owned());
			};
			// A URL asked for twice is told once: the answer is an object, and a key written
			// twice is not one that reads back.
			if seen.insert(url.as_str()) {
				wanted.push(url.as_str());
			}
		}
		let at: HashMap<&str, usize> = self
			.plan
			.pages
			.iter()
			.enumerate()
			.map(|(i, page)| (page.file.url.as_str(), i))
			.collect();
		let found: Vec<(String, usize)> = wanted
			.iter()
			.filter_map(|url| at.get(url).map(|&i| ((*url).to_owned(), i)))
			.collect();
		drop(at);
		let mut locked = Vec::with_capacity(found.len());
		for (url, i) in found {
			let row = self.page_json(i);
			let mut keys = Vec::new();
			if let Some(Value::Object(meta)) = row.get("meta") {
				for (key, cell) in meta {
					if cell.get("editable") == Some(&Value::Bool(false)) {
						let why = match cell.get("reason") {
							Some(Value::String(r)) => r.clone(),
							_ => "the key cannot be edited".to_owned(),
						};
						keys.push((key.clone(), Value::String(why)));
					}
				}
			}
			locked.push((url, Value::Object(keys)));
		}
		Ok(Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			("locked".to_owned(), Value::Object(locked)),
		])
		.to_json())
	}

	/// A page of rows, as the JSON of RFC §14.2. `query_json` is
	/// `{ "offset", "limit", "q"?, "sort"?: { "key", "desc"? } }`; `key` is `url`, `inputPath`,
	/// `virtual` or `meta:<key>`, and the order is the natural one of `@d-zero/shared` over every
	/// page that matches, not only the window.
	/// The plan is not made again; each row of the window reads its page file once (until it
	/// changes) to tell which keys can be edited, and a query `q` looks through the URL and the
	/// text values of every page. The answer also has `layouts`: the names of the layouts in
	/// `pages.layouts.dir` as they were when the handle was opened or last refreshed (`null`
	/// when that is not set, `[]` when the directory is not there).
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
		let n = self.plan.pages.len();
		// The plan's place of the page `locate` names, if it has one.
		let located: Option<usize> = query
			.locate
			.as_ref()
			.and_then(|url| self.by_url.get(url).copied());
		// Where the window starts: at the window that holds the located page (a multiple of
		// `limit`), when the page is among the ones the query keeps (`at` is its place among
		// them), and at `offset` otherwise.
		let cut = |total: usize, at: Option<usize>| {
			let start = match at {
				Some(place) if query.limit > 0 => place / query.limit * query.limit,
				_ => query.offset,
			}
			.min(total);
			(start, start.saturating_add(query.limit).min(total))
		};
		// The pages of the window, and how many pages match. Every page is sorted once for the
		// plan, and the pages a query keeps are taken in that order, not sorted again for each
		// query; but when the plan has no such order yet and the query keeps a small part of the
		// pages, only those are sorted. Where the comparison has a cycle (see `natural`) the two
		// can differ; no order is promised there.
		let (total, start, ids): (usize, usize, Vec<usize>) = match (&query.q, &query.sort) {
			(None, None) => {
				let (start, end) = cut(n, located);
				(n, start, (start..end).collect())
			}
			(None, Some(sort)) => {
				let order = self.sorted_all(sort);
				let at = located.and_then(|i| order.iter().position(|&p| p == i));
				let (start, end) = cut(n, at);
				(n, start, order[start..end].to_vec())
			}
			(Some(q), sort) => {
				let kept: Vec<usize> = self
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
					.collect();
				let kept = match sort {
					None => kept,
					Some(sort) => match self.cached_order(sort) {
						None if kept.len() * SMALL_QUERY_DIVISOR <= n => self.sorted(sort, &kept),
						cached => {
							let order = cached.unwrap_or_else(|| self.sorted_all(sort));
							let mut keep = vec![false; n];
							for &i in &kept {
								keep[i] = true;
							}
							order.iter().copied().filter(|&i| keep[i]).collect()
						}
					},
				};
				let at = located.and_then(|i| kept.iter().position(|&p| p == i));
				let (start, end) = cut(kept.len(), at);
				(kept.len(), start, kept[start..end].to_vec())
			}
		};
		let rows: Vec<Value> = ids.iter().map(|&i| self.page_json(i)).collect();
		Ok(Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			("offset".to_owned(), Value::Number(start as f64)),
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
			(
				"layouts".to_owned(),
				match &self.layouts {
					Some(names) => Value::Array(names.iter().cloned().map(Value::String).collect()),
					None => Value::Null,
				},
			),
			("keys".to_owned(), keys_json(&self.loaded.config.ui)),
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

	/// The values a metadata key has over every page, for the editor of a column whose values
	/// are a few (RFC §14.2). `query_json` is `{ "key": "meta:<key>", "limit" }`. The answer is
	/// `{ "version", "key", "total", "values": [{ "value", "count" }] }`: the strings, numbers
	/// and booleans the pages hold under the key, each once with how many times it is held, the
	/// most often first (a value held as often as another comes after it when it was first met
	/// later in the order of the plan), at most `limit` of them. The items of an array count as
	/// values; `null`, an object, and an array inside an array are not values here. `total` is
	/// how many different values there are, whatever `limit` is. The number `1` and the text
	/// `"1"` are two values.
	///
	/// # Errors
	///
	/// A message for a query that is not what it should be.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let values = ui.values(r#"{"key":"meta:layout","limit":100}"#).unwrap();
	/// assert!(values.contains(r#""values":["#));
	/// ```
	pub fn values(&self, query_json: &str) -> Result<String, String> {
		let query = parse_values_query(query_json)?;
		// A value is told from the others by how it is written as JSON, which is what tells
		// the number `1` from the text `"1"`.
		let mut at: HashMap<String, usize> = HashMap::new();
		let mut found: Vec<(Value, usize)> = Vec::new();
		let mut take = |value: &Value| {
			if !matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_)) {
				return;
			}
			match at.entry(value.to_json()) {
				std::collections::hash_map::Entry::Occupied(e) => found[*e.get()].1 += 1,
				std::collections::hash_map::Entry::Vacant(e) => {
					e.insert(found.len());
					found.push((value.clone(), 1));
				}
			}
		};
		for page in &self.plan.pages {
			let Some((_, value)) = page.meta.iter().find(|(k, _)| *k == query.key) else {
				continue;
			};
			match value {
				Value::Array(items) => items.iter().for_each(&mut take),
				other => take(other),
			}
		}
		// Stable on purpose: equal counts keep the order they were first met in, which is the order
		// of the plan, so the same site gives the same list.
		found.sort_by_key(|(_, count)| std::cmp::Reverse(*count));
		let total = found.len();
		found.truncate(query.limit);
		Ok(Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			(
				"key".to_owned(),
				Value::String(format!("meta:{}", query.key)),
			),
			("total".to_owned(), Value::Number(total as f64)),
			(
				"values".to_owned(),
				Value::Array(
					found
						.into_iter()
						.map(|(value, count)| {
							Value::Object(vec![
								("value".to_owned(), value),
								("count".to_owned(), Value::Number(count as f64)),
							])
						})
						.collect(),
				),
			),
		])
		.to_json())
	}

	/// The answer to an edit that was made: the page as it is now, or `null` for a page the
	/// edit removed.
	///
	/// A file that was set aside to be removed and could not be is told in `warning`: the edit
	/// is made, and the file stays under another name.
	fn ok_json(&mut self, page: Option<usize>) -> String {
		let mut members = vec![
			("ok".to_owned(), Value::Bool(true)),
			("version".to_owned(), Value::Number(self.version as f64)),
			("overridesHash".to_owned(), self.overrides_hash_json()),
			(
				"page".to_owned(),
				page.map_or(Value::Null, |i| self.page_json(i)),
			),
		];
		if !self.left_behind.is_empty() {
			members.push((
				"warning".to_owned(),
				Value::String(format!(
					"the edit was made, but these files could not be removed and stay under another name: {}",
					self.left_behind.join("; ")
				)),
			));
		}
		Value::Object(members).to_json()
	}

	/// Makes the change of an edit on the page at `url` (a page that is made has none yet), with
	/// `expect`: the part of an edit that is the same for one edit and for each of a batch.
	/// `revert` is not made here (it needs what HEAD holds, which [`Ui::edit`] asks for first).
	fn run_change(&mut self, url: &str, change: &Change, expect: &Value) -> F<Done> {
		// A page that is made is the one edit that is not of a page that is there.
		match (change, self.by_url.get(url).copied()) {
			(Change::Create { url, path }, _) => self
				.create(url.as_deref(), path.as_deref(), expect)
				.map(Done::Page),
			(_, None) => fail("notFound", format!("there is no page with the URL {url}")),
			(Change::Key(change), Some(i)) => self.edit_key(i, expect, change).map(Done::Page),
			(Change::MoveUrl(new_url), Some(i)) => {
				self.move_url(i, expect, new_url).map(Done::Page)
			}
			(Change::MovePath(path), Some(i)) => self.move_path(i, expect, path).map(Done::Page),
			(Change::Revert { key, head }, Some(i)) => {
				self.revert(i, expect, key.as_deref(), head).map(Done::Page)
			}
			(Change::Virtualize, Some(i)) => self.virtualize(i, expect).map(Done::Page),
			(Change::Materialize(path), Some(i)) => {
				self.materialize(i, expect, path.as_deref()).map(Done::Page)
			}
			(Change::DeletePage, Some(i)) => self.delete_page(i, expect).map(|()| Done::Gone),
		}
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

	/// Makes one edit (RFC §14.2): `change.op` is `set` or `delete` (a key of the metadata),
	/// `moveUrl` (the page gets another URL), `movePath` (the page file gets another path),
	/// `create` (a page that is not there yet: a page file at a path, or a virtual page),
	/// `virtualize` (the page file goes and the page stays as an entry of `pages.overrides`),
	/// `materialize` (a virtual page gets a page file) or `deletePage` (the page goes). The
	/// paths of `movePath`, `create` and `materialize` are given relative to `dir.input`; no
	/// other edit carries a path. The directories a move or a removal leaves empty are removed
	/// once it has been made. The answer says whether the edit was made, with the page as it
	/// is now (`"page": null` when it is gone); an edit that is refused (a changed file, an
	/// invalid value, a collision) is an answer, not an error.
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
		let version = self.version;
		self.left_behind.clear();
		if let (Change::Revert { head, .. }, Some(i)) =
			(&edit.change, self.by_url.get(&edit.url).copied())
		{
			let need = self.revert_needs(i, head);
			if !need.is_empty() {
				return Ok(Ui::need_json(need));
			}
		}
		let result = self.run_change(&edit.url, &edit.change, &edit.expect);
		match result {
			Ok(done) => {
				// Planning the site again counts a version of its own: the edit is one.
				if self.version == version {
					self.version += 1;
				}
				let url = match done {
					Done::Page(url) => url,
					Done::Gone => return Ok(self.ok_json(None)),
				};
				match self.by_url.get(&url).copied() {
					Some(at) => Ok(self.ok_json(Some(at))),
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

	/// The file a change of a key of the page `i` is made in (RFC §14.2): where the key is, and
	/// for a key the page has not, the page file (the entry of `pages.overrides` for a virtual
	/// page). `exists` is whether the page has the key now and `in_overrides` whether the entry
	/// of the page has it: what the edit reads of the handle, and what a batch keeps by hand.
	/// The one place that says so, for an edit and for each key of a batch.
	fn key_origin(
		&self,
		i: usize,
		change: &KeyChange,
		exists: bool,
		in_overrides: bool,
	) -> F<Origin> {
		let key = change.key();
		if Some(key) == self.output_path_field() {
			return fail("notEditable", URL_KEY_REASON);
		}
		if exists {
			return Ok(self.origin_given(i, key, in_overrides));
		}
		match change {
			KeyChange::Delete(_) => fail("invalid", format!("the page has no key {key:?}")),
			KeyChange::Set(..) if self.plan.pages[i].is_virtual => Ok(Origin::Overrides),
			KeyChange::Set(..) => Ok(Origin::InFile),
		}
	}

	/// Sets or deletes one key of the metadata of the page `i`, in the file it comes from.
	fn edit_key(&mut self, i: usize, expect: &Value, change: &KeyChange) -> F<String> {
		let key = change.key();
		let exists = self.plan.pages[i].meta.iter().any(|(k, _)| k == key);
		let in_overrides = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&self.plan.pages[i].file.url))
			.is_some_and(|o| o.meta.iter().any(|(k, _)| k == key));
		let origin = self.key_origin(i, change, exists, in_overrides)?;
		let url = self.plan.pages[i].file.url.clone();
		let mut txn = self.key_txn(i, expect, change, origin)?;
		let overrides_after = txn.overrides_after.take();
		txn.commit_with(self.batch.as_mut())?;
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
		let before = crate::nav_order::order_of(&self.plan.pages[i].meta);
		self.reread_page(i)?;
		// What the key places is a place in the plan: when its number changed, the plan is
		// put in its order again (without reading the site: the order is made of the metadata
		// and the URLs the handle has).
		if crate::nav_order::order_of(&self.plan.pages[i].meta) != before {
			self.arrange_plan();
		}
		// A key set on this page is a column now, and one deleted from the last page that
		// had it is not.
		match change {
			KeyChange::Set(key, _) => {
				self.columns.insert(key.clone());
			}
			KeyChange::Delete(key) => {
				if key != ORDER_KEY
					&& !self
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

	/// `dir.input` without a trailing `/`, the base the paths of the page files are made from.
	fn input_dir(&self) -> String {
		self.loaded
			.config
			.dir
			.input
			.trim_end_matches('/')
			.to_string()
	}

	/// Plans the site again after the files were changed. The files are changed already, so a
	/// plan that fails is said to be so: the editor does not know what the files hold now.
	fn plan_after_files_changed(&mut self) -> F<()> {
		let left = if self.left_behind.is_empty() {
			String::new()
		} else {
			// The files an edit could not remove are told here too: this answer is the only one
			// the person gets.
			format!(
				" (these files could not be removed and stay under another name: {})",
				self.left_behind.join("; ")
			)
		};
		if let (Some(found), Some(journal)) = (&mut self.found, &self.batch) {
			let changed = found.follow(&journal.events);
			// What the commit held back of `pages.overrides` is what the handle reads from now on.
			if let (Some(text), Some(o)) = (&journal.deferred, &mut self.overrides) {
				o.text.clone_from(text);
			}
			// The plan is kept up to date by hand (see `patch_plan`); if that cannot be done, it is
			// made again, from the list of the files, and from `pages.overrides` as the file has it.
			if self.patch_plan(&changed) {
				self.touched.clear();
				return Ok(());
			}
			self.flush_overrides()?;
			self.touched.clear();
		}
		self.plan_again(None).map_err(|message| Fail {
			code: "io",
			message: format!(
				"the files were changed, but the site cannot be planned now: {message}{left}"
			),
		})
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

	/// The page file a URL names by its place: what a page that has no key of its own to say
	/// where it is can be moved to, and what a virtual page is. A page whose URL a key makes
	/// can have any URL §5 allows. A URL written another way than a page's own is refused.
	fn url_as_page(&self, url: &str) -> F<PageFile> {
		let extension = &self.loaded.config.pages.output_extension;
		let rel = kd_site::url_to_local_path(url, extension);
		let file = kd_site::page_file(&format!("{}/{rel}", self.input_dir()), &self.dirs());
		if file.url != url {
			let ext = if extension.is_empty() {
				"a file without an extension".to_string()
			} else {
				format!("a file with {extension:?}")
			};
			return fail(
				"invalid",
				format!(
					"{url:?} is not written as a page URL (it would be read as {:?}); write the URL a page has: a directory with its trailing \"/\", {ext}",
					file.url
				),
			);
		}
		Ok(file)
	}

	/// Checks that a URL a person wrote can be the URL of a page (RFC §6).
	fn check_url(url: &str) -> F<()> {
		if !url.starts_with('/') {
			return fail("invalid", format!("the URL must start with '/': {url:?}"));
		}
		if let Some(why) = kd_site::meta::not_a_page_path(url) {
			return fail("invalid", format!("the URL {url:?} {why}"));
		}
		Ok(())
	}

	/// Checks that `to` is a place for a page file: inside the input directory, not inside the
	/// output directory, and a page by `pages.files` and `pages.ignore` (RFC §14.2). `placed` is
	/// the page file it makes.
	fn check_place(&self, to: &str, placed: &PageFile) -> F<()> {
		let input_dir = self.input_dir();
		let rel_in_input = kd_site::path::relative(&input_dir, &placed.input_path);
		if climbs(&rel_in_input) || !really_inside(&input_dir, to) {
			return fail("invalid", format!("{to} is outside the input directory"));
		}
		let config = &self.loaded.config;
		let output_rel = kd_site::path::relative(&input_dir, &config.dir.output);
		if !output_rel.is_empty()
			&& !climbs(&output_rel)
			&& (rel_in_input == output_rel || rel_in_input.starts_with(&format!("{output_rel}/")))
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
		Ok(())
	}

	/// The page file to make at `rel` (relative to the input directory) for a page that is to
	/// have the URL `url` (`None`: the URL the place gives) and the metadata `meta`: its path,
	/// its text and the page file it makes. The place is checked as the place a page is moved
	/// to is, and nothing may be there, nor a `.json` of the same name (the new page would
	/// read it as its sidecar). A URL that is not the one of the place is written in the
	/// `outputPathField` key, if the site has one. The text is what [`new_page_text`] gives with
	/// the keys set as an edit sets them, so it reads back as `meta`.
	fn new_page_file(
		&self,
		rel: &str,
		url: Option<&str>,
		meta: &Meta,
	) -> F<(String, String, PageFile)> {
		let to = format!("{}/{rel}", self.input_dir());
		let placed = kd_site::page_file(&to, &self.dirs());
		self.check_place(&to, &placed)?;
		if taken(&to) {
			return fail("collision", format!("{to} already exists"));
		}
		let sidecar = crate::sidecar_path(&to);
		if taken(&sidecar) {
			return fail("collision", format!("{sidecar} already exists"));
		}
		let kind = crate::page_kind(&kd_site::path::extname(&to).to_ascii_lowercase()).map_err(
			|message| Fail {
				code: "invalid",
				message: format!("{to}: {message}"),
			},
		)?;
		let mut text = new_page_text(&to).to_string();
		let mut file = placed.clone();
		if let Some(url) = url
			&& url != placed.url
		{
			let Some(field) = self.output_path_field() else {
				return fail(
					"invalid",
					format!(
						"the file {to} would have the URL {:?}, not {url:?}",
						placed.url
					),
				);
			};
			file = kd_site::apply_meta_path_override(&placed, url, &self.dirs()).map_err(|e| {
				Fail {
					code: "invalid",
					message: format!("{url:?} cannot be the value of {field:?}: {e}"),
				}
			})?;
			if file.url != url {
				return fail(
					"invalid",
					format!(
						"{url:?} would be read as the URL {:?} when it is the value of {field:?}",
						file.url
					),
				);
			}
			let change = KeyChange::Set(field.to_string(), Value::String(url.to_string()));
			text = edit_page_text(&to, kind, &text, &change)?;
		}
		for (key, value) in meta {
			let change = KeyChange::Set(key.clone(), value.clone());
			text = edit_page_text(&to, kind, &text, &change)?;
		}
		if let Some(why) = kd_site::meta::not_a_page_path(&file.url) {
			return fail(
				"invalid",
				format!("the URL {:?} of the file {to} {why}", file.url),
			);
		}
		// The text of a page that is made is read as the plan reads it, like the text of a page
		// that is edited: a file that the plan cannot read would stop every later plan.
		crate::parse_page_text(&to, kind, text.clone()).map_err(|e| Fail {
			code: "invalid",
			message: format!("the new file {to} would be unreadable: {e}"),
		})?;
		Ok((to, text, file))
	}

	/// The `pages.overrides` file of the site and its text, read and checked against
	/// `expect.overrides`. `why` says what needs the file, for the site that has none.
	fn overrides_expected(&self, expect: &Value, why: &str) -> F<(&OverridesFile, String)> {
		let Some(o) = &self.overrides else {
			return fail(
				"invalid",
				format!("the site has no pages.overrides file, and {why}"),
			);
		};
		if self.in_overrides_session() {
			return Ok((o, o.text.clone()));
		}
		let text = read_expected(expect, "overrides", &o.path)?;
		Ok((o, text))
	}

	/// Whether the edits of a batch are being made, with `pages.overrides` held in the handle
	/// (see [`Journal::deferred`]): they read its text and its model, not the file, and change the
	/// model by hand.
	fn in_overrides_session(&self) -> bool {
		self.batch.as_ref().is_some_and(|j| j.defer.is_some())
	}

	/// In a batch: the model of `pages.overrides` takes the changes (the text is the one the
	/// commit held back), and the URLs they touch are told to `patch_plan`. Outside a batch it
	/// does nothing: the file is read again after the edit.
	fn follow_entries(&mut self, changes: &[EntryChange<'_>]) {
		if !self.in_overrides_session() {
			return;
		}
		if let Some(o) = &mut self.overrides {
			for change in changes {
				model_after(&mut o.parsed, change);
			}
		}
		for change in changes {
			for url in change.urls() {
				self.touched.insert(url.to_string());
			}
		}
	}

	/// Makes a page that is not there (RFC §14.2). With `path`, a page file at that path, with
	/// the text a new page has; `url`, if given, is the URL it must have. Without `path`, a
	/// virtual page: an entry of `pages.overrides` for `url`.
	fn create(&mut self, url: Option<&str>, path: Option<&str>, expect: &Value) -> F<String> {
		if let Some(url) = url {
			Self::check_url(url)?;
		}
		let mut txn = Txn::default();
		let new_url = match (path, url) {
			(Some(typed), _) => {
				let rel = typed_new_path(typed)?;
				let (to, text, file) = self.new_page_file(&rel, url, &Vec::new())?;
				if self.by_url.contains_key(&file.url) {
					return fail(
						"collision",
						format!("a page already has the URL {}", file.url),
					);
				}
				if let Some(why) = self.output_collision(usize::MAX, &file) {
					return fail("collision", why);
				}
				txn.writes.push((to, text));
				file.url
			}
			(None, Some(url)) => {
				let file = self.url_as_page(url)?;
				if self.by_url.contains_key(url) {
					return fail("collision", format!("a page already has the URL {url}"));
				}
				if let Some(why) = self.output_collision(usize::MAX, &file) {
					return fail("collision", why);
				}
				let (o, text) = self.overrides_expected(
					expect,
					"a page without a file is an entry of it: write the path of a file for the page",
				)?;
				let before = Self::overrides_before(o, &text)?;
				let entry = kd_site::meta::Override {
					url: url.to_string(),
					is_virtual: true,
					meta: Vec::new(),
					lastmod: None,
				};
				let path = o.path.clone();
				let edited = add_overrides_entry(
					&path,
					&text,
					&before,
					entry.clone(),
					!self.in_overrides_session(),
				)?;
				self.follow_entries(&[EntryChange::Add(entry)]);
				txn.writes.push((path, edited));
				url.to_string()
			}
			(None, None) => {
				return fail("invalid", "a new page needs a URL or the path of its file");
			}
		};
		txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(new_url)
	}

	/// Checks that the page file at `from` is one this editor removes: a file whose directory
	/// is really inside the input directory. A directory of the input tree that is a link leads
	/// to files that are somewhere else, and may be someone else's: a file is not made there
	/// nor moved there, and what is there is not removed either (it cannot be brought back).
	/// A page file that is itself a link is removed as the link it is.
	fn check_removable(&self, from: &str) -> F<()> {
		if really_inside(&self.input_dir(), from) {
			return Ok(());
		}
		fail(
			"invalid",
			format!(
				"{from} is outside the input directory (a directory on the way is a link), so it is not removed here"
			),
		)
	}

	/// Makes the page `i` virtual (RFC §14.2): its page file and its sidecar are removed, and
	/// the page stays as an entry of `pages.overrides` with the metadata it had (the key that
	/// makes the URL apart: the URL of a virtual page is the `url` of its entry). An entry the
	/// page has already is the one that is made virtual, with its keys as they are and the keys
	/// of the files added.
	fn virtualize(&mut self, i: usize, expect: &Value) -> F<String> {
		let page = self.plan.pages[i].clone();
		if page.is_virtual {
			return fail("invalid", "the page is virtual already");
		}
		let url = page.file.url.clone();
		let (o, text) = self.overrides_expected(
			expect,
			"a virtual page is an entry of it: the page cannot be made virtual",
		)?;
		let before = Self::overrides_before(o, &text)?;
		// A virtual page is where its URL says, read as the plan reads the entry, and it is
		// written to the same output path as the page was (the output of a page whose URL a key
		// makes can differ from the one its URL gives; the plan would then refuse the site after
		// the files were changed).
		let placed = self.url_as_page(&url)?;
		if placed.output_path != page.file.output_path {
			return fail(
				"invalid",
				format!(
					"as a virtual page {url} would be written to {}, not to {}: the page is not made virtual",
					placed.output_path, page.file.output_path
				),
			);
		}
		let from = page.file.input_path.clone();
		self.check_removable(&from)?;
		let (read, _) = crate::read_files(&from, None).map_err(|message| Fail {
			code: "invalid",
			message,
		})?;
		let hash_of = |dep: &kd_build::Dep| {
			(dep.hash != kd_build::MISSING_FILE_HASH).then(|| dep.hash.clone())
		};
		hash_expected(expect, "input", &from, hash_of(&read.input_dep).as_deref())?;
		hash_expected(
			expect,
			"sidecar",
			&read.sidecar,
			hash_of(&read.sidecar_dep).as_deref(),
		)?;
		let field = self.output_path_field();
		let mut from_files = kd_site::meta::merge(&[&read.in_file, &read.side]);
		from_files.retain(|(k, _)| Some(k.as_str()) != field);
		let verify = !self.in_overrides_session();
		let path = o.path.clone();
		let (edited, added) = match before.by_url.get(&url) {
			Some(entry) => {
				// What the entry says wins over the files already (§4), so its keys stay.
				let add: Meta = from_files
					.into_iter()
					.filter(|(k, _)| !entry.meta.iter().any(|(ek, _)| ek == k))
					.collect();
				let edit = EntryEdit {
					url: &url,
					is_virtual: true,
					add: &add,
					take: &[],
				};
				let edited = change_overrides_entry(&path, &text, &before, &edit, verify)?;
				self.follow_entries(&[EntryChange::Change(edit)]);
				(edited, None)
			}
			None => {
				let entry = kd_site::meta::Override {
					url: url.clone(),
					is_virtual: true,
					meta: from_files,
					lastmod: None,
				};
				let edited = add_overrides_entry(&path, &text, &before, entry.clone(), verify)?;
				(edited, Some(entry))
			}
		};
		if let Some(entry) = added {
			self.follow_entries(&[EntryChange::Add(entry)]);
		}
		let mut txn = Txn::default();
		txn.writes.push((path, edited));
		txn.removes.push(from);
		if read.sidecar_dep.hash != kd_build::MISSING_FILE_HASH {
			txn.removes.push(read.sidecar);
		}
		txn.prune_to = Some(self.input_dir());
		self.left_behind = txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(url)
	}

	/// Gives the virtual page `i` a page file (RFC §14.2): at `path` (as typed), or, without
	/// one, where its URL says, with the first of the extensions of a page that `pages.files`
	/// takes. The metadata of its entry in `pages.overrides` moves into the file, and the entry
	/// goes; an entry that says more than that (`lastmod`, the key that makes the URL, which is
	/// not written in the file unless it has to make the URL) stays without `virtual` and
	/// without the keys that moved.
	fn materialize(&mut self, i: usize, expect: &Value, path: Option<&str>) -> F<String> {
		let page = self.plan.pages[i].clone();
		if !page.is_virtual {
			return fail("invalid", "the page has a file already");
		}
		let url = page.file.url.clone();
		let (o, text) = self.overrides_expected(expect, "a virtual page is an entry of it")?;
		let before = Self::overrides_before(o, &text)?;
		let Some(entry) = before.by_url.get(&url) else {
			return fail("invalid", format!("{} has no entry for {url}", o.path));
		};
		let field = self.output_path_field();
		let (moved, kept): (Meta, Meta) = entry
			.meta
			.iter()
			.cloned()
			.partition(|(k, _)| Some(k.as_str()) != field);
		let rel = match path {
			Some(typed) => typed_new_path(typed)?,
			None => self.path_for_url(&url)?,
		};
		let (to, page_text, file) = self.new_page_file(&rel, Some(&url), &moved)?;
		if let Some(why) = self.output_collision(i, &file) {
			return fail("collision", why);
		}
		let verify = !self.in_overrides_session();
		let path = o.path.clone();
		let removes_entry = kept.is_empty() && entry.lastmod.is_none();
		let take: Vec<String> = moved.iter().map(|(k, _)| k.clone()).collect();
		let edit = EntryEdit {
			url: &url,
			is_virtual: false,
			add: &Vec::new(),
			take: &take,
		};
		let edited = if removes_entry {
			remove_overrides_entry(&path, &text, &before, &url, verify)?
		} else {
			change_overrides_entry(&path, &text, &before, &edit, verify)?
		};
		if removes_entry {
			self.follow_entries(&[EntryChange::Remove(&url)]);
		} else {
			self.follow_entries(&[EntryChange::Change(edit)]);
		}
		let mut txn = Txn::default();
		txn.writes.push((to, page_text));
		txn.writes.push((path, edited));
		txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(url)
	}

	/// Where the page file of the URL is, relative to the input directory, when nothing says
	/// which file it is: the place the URL names (§5, read backwards), with the first of the
	/// extensions of a page that makes it a page by `pages.files` and `pages.ignore` and whose
	/// place is free (no file there, and no `.json` of the same name).
	fn path_for_url(&self, url: &str) -> F<String> {
		let config = &self.loaded.config;
		let rel = kd_site::url_to_local_path(url, &config.pages.output_extension);
		let stem = rel
			.strip_suffix(config.pages.output_extension.as_str())
			.unwrap_or(&rel);
		let input_dir = self.input_dir();
		// Why each place was passed over, so that the refusal says it and not only that there
		// is none.
		let mut passed: Vec<String> = Vec::new();
		for ext in PAGE_EXTENSIONS {
			let candidate = format!("{stem}{ext}");
			let to = format!("{input_dir}/{candidate}");
			let sidecar = crate::sidecar_path(&to);
			match self.check_place(&to, &kd_site::page_file(&to, &self.dirs())) {
				Err(why) => passed.push(why.message),
				Ok(()) if taken(&to) => passed.push(format!("{to} already exists")),
				Ok(()) if taken(&sidecar) => passed.push(format!("{sidecar} already exists")),
				Ok(()) => return Ok(candidate),
			}
		}
		fail(
			"invalid",
			format!(
				"there is no place for a file of {url} ({}): write the path of the file",
				passed.join("; ")
			),
		)
	}

	/// Removes the page `i` (RFC §14.2): its page file and its sidecar, and its entry in
	/// `pages.overrides` (an entry without a page would stop the next plan; a virtual page is
	/// nothing but its entry).
	fn delete_page(&mut self, i: usize, expect: &Value) -> F<()> {
		let page = self.plan.pages[i].clone();
		let url = page.file.url.clone();
		let mut txn = Txn::default();
		if !page.is_virtual {
			let from = page.file.input_path.clone();
			self.check_removable(&from)?;
			let sidecar = crate::sidecar_path(&from);
			hash_expectation(expect, "input", &from)?;
			hash_expectation(expect, "sidecar", &sidecar)?;
			txn.removes.push(from);
			if exists(&sidecar)? {
				txn.removes.push(sidecar);
			}
			txn.prune_to = Some(self.input_dir());
		}
		// Whether the page has an entry is asked of the file as it is now, not of what the handle
		// read last: an entry written since then would be left without its page, which no plan
		// accepts. The file is read once, for the question, for the hash that is checked only
		// when there is an entry to remove, and for the edit (it is megabytes on a site of a
		// hundred thousand pages, and the handle's parsed copy answers when the text is the
		// one it read).
		let in_session = self.in_overrides_session();
		let entry_removed = match &self.overrides {
			Some(o) => {
				let now = if in_session {
					o.text.clone()
				} else {
					fs::read_to_string(&o.path).map_err(|e| io_fail(&o.path, &e))?
				};
				let before = Self::overrides_before(o, &now)?;
				if page.is_virtual || before.by_url.contains_key(&url) {
					if !in_session {
						let hash = hash_hex(now.as_bytes());
						hash_expected(expect, "overrides", &o.path, Some(hash.as_str()))?;
					}
					Some((
						o.path.clone(),
						remove_overrides_entry(&o.path, &now, &before, &url, !in_session)?,
					))
				} else {
					None
				}
			}
			None if page.is_virtual => {
				return fail(
					"invalid",
					"the site has no pages.overrides file, and a virtual page is an entry of it",
				);
			}
			None => None,
		};
		if let Some((path, edited)) = entry_removed {
			self.follow_entries(&[EntryChange::Remove(&url)]);
			txn.writes.push((path, edited));
		}
		self.left_behind = txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(())
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
		let as_page = || self.url_as_page(new_url);
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
			let ext = kd_site::path::extname(&page.file.input_path).to_string();
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
			txn = self.file_move(i, expect, &page, &to, &moved, true)?;
		}
		// The entry of the page in `pages.overrides` (a virtual page is nothing but that
		// entry) is keyed by the URL, so it follows the page.
		if overrides_entry {
			self.follow_overrides(expect, &old_url, new_url, &mut txn)?;
		}
		txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(new_url.to_string())
	}

	/// The changes that move the file of the page `i` (and its sidecar) to `to`, which is where
	/// `moved` (the page file it makes) says it is: the checks that a place for a page file has to
	/// pass (RFC §14.2), the `import`s of a module rewritten to name what they named, and the
	/// files to move. `url_changes` is whether the output path of the page changes with the move
	/// (a page whose URL a key makes keeps its URL, so it does not).
	fn file_move(
		&self,
		i: usize,
		expect: &Value,
		page: &Page,
		to: &str,
		moved: &PageFile,
		url_changes: bool,
	) -> F<Txn> {
		let input_dir = self.input_dir();
		let from = page.file.input_path.clone();
		let mut txn = Txn::default();
		self.check_place(to, moved)?;
		let sidecar_from = crate::sidecar_path(&from);
		let sidecar_to = crate::sidecar_path(to);
		let has_sidecar = exists(&sidecar_from)?;
		if occupied(to, &from) {
			return fail("collision", format!("{to} already exists"));
		}
		// A sidecar at the destination is taken even if the page has none: the moved
		// page would read it as its own.
		if occupied(&sidecar_to, &sidecar_from) {
			return fail("collision", format!("{sidecar_to} already exists"));
		}
		if url_changes && let Some(why) = self.output_collision(i, moved) {
			return fail("collision", why);
		}
		let text = read_expected(expect, "input", &from)?;
		// A sidecar that is not there is part of what the editor saw (`null`): one that has
		// appeared since is a conflict, and so is one that is gone.
		hash_expectation(expect, "sidecar", &sidecar_from)?;
		// A page's own imports are relative to where it is: they follow it.
		if page.kind == PageKind::Tsx
			&& let Some(rewritten) = rewrite_relative_imports(&from, to, &text)?
		{
			let (before, _) =
				crate::parse_page_text(&from, page.kind, text.clone()).map_err(|message| Fail {
					code: "invalid",
					message,
				})?;
			let (after, _) =
				crate::parse_page_text(to, page.kind, rewritten.clone()).map_err(|e| Fail {
					code: "invalid",
					message: format!("the new imports would leave {to} unreadable: {e}"),
				})?;
			if before != after {
				return fail(
					"invalid",
					format!("the new imports would change the metadata of {to}; nothing was moved"),
				);
			}
			txn.writes.push((to.to_string(), rewritten));
		}
		txn.renames.push((from, to.to_string()));
		if has_sidecar {
			txn.renames.push((sidecar_from, sidecar_to));
		}
		txn.prune_to = Some(input_dir);
		Ok(txn)
	}

	/// Changes the path of the file of the page `i` to what was typed (RFC §14.2): the file and
	/// its sidecar move, and the URL follows the place unless a key makes it.
	fn move_path(&mut self, i: usize, expect: &Value, typed: &str) -> F<String> {
		let page = self.plan.pages[i].clone();
		if page.is_virtual {
			return fail(
				"invalid",
				"a virtual page has no file, so it has no path to change",
			);
		}
		let input_dir = self.input_dir();
		let from = page.file.input_path.clone();
		let rel = typed_path(typed, kd_site::path::extname(&from))?;
		let to = format!("{input_dir}/{rel}");
		if to == from {
			return fail("invalid", "the path is the same as it was");
		}
		let moved = kd_site::page_file(&to, &self.dirs());
		let by_place = !self.url_from_field(&page);
		if by_place {
			if let Some(why) = kd_site::meta::not_a_page_path(&moved.url) {
				return fail(
					"invalid",
					format!("the URL {:?} of the file {to} {why}", moved.url),
				);
			}
			if moved.url != page.file.url && self.by_url.contains_key(&moved.url) {
				return fail(
					"collision",
					format!("a page already has the URL {}", moved.url),
				);
			}
		}
		let mut txn = self.file_move(i, expect, &page, &to, &moved, by_place)?;
		let new_url = if by_place {
			moved.url.clone()
		} else {
			page.file.url.clone()
		};
		let overrides_entry = self
			.overrides
			.as_ref()
			.is_some_and(|o| o.parsed.by_url.contains_key(&page.file.url));
		if by_place && overrides_entry && new_url != page.file.url {
			self.follow_overrides(expect, &page.file.url, &new_url, &mut txn)?;
		}
		txn.commit_with(self.batch.as_mut())?;
		self.plan_after_files_changed()?;
		Ok(new_url)
	}

	/// Adds to `txn` the rewrite of the entry of a page in `pages.overrides`, which is keyed by
	/// the URL, so that it has `new_url`.
	fn follow_overrides(
		&mut self,
		expect: &Value,
		old_url: &str,
		new_url: &str,
		txn: &mut Txn,
	) -> F<()> {
		if self.overrides.is_none() {
			return fail("invalid", "the site has no pages.overrides file");
		}
		let (path, edited) = {
			let (o, text) = self.overrides_expected(expect, "")?;
			let before = Self::overrides_before(o, &text)?;
			let edited =
				edit_overrides_text(&o.path, &text, &before, old_url, None, Some(new_url))?;
			(o.path.clone(), edited)
		};
		self.follow_entries(&[EntryChange::Rename {
			old: old_url,
			new: new_url,
		}]);
		txn.writes.push((path, edited));
		Ok(())
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
mod batch_tests;
#[cfg(test)]
mod diff_tests;
#[cfg(test)]
mod page_tests;
#[cfg(test)]
mod sync_tests;
#[cfg(test)]
mod tests;
