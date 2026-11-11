//! The difference between what the editor shows and what a commit holds (RFC §14.2, "HEAD との
//! 差分"), and the edit that puts a key back as the commit had it.
//!
//! Why the core does not call `git`: it is the Node side that starts processes (a `git` that is
//! missing, slow or not a repository is an answer of "no difference", not an error of the
//! editor). The core is told, for each file the window of rows touches, what HEAD holds for
//! it, and compares the metadata that comes out of it with the metadata of the plan, key by key.
//!
//! Why a file is told apart by its git blob id before its text is read: a window shows up to
//! 5,000 rows, and almost all of the files in it are what the commit holds. The id of what the
//! file holds now is made here (it is the SHA-1 or SHA-256 of `blob <length>\0<content>`), the
//! id git has for it comes from `git cat-file --batch-check`, and only the files whose ids differ
//! cost a read of their text from git and a parse here. What a text parsed to is kept by its id,
//! so that a site where every id differs (a `core.autocrlf` that changes the bytes git keeps)
//! pays for each file once, and the one large `pages.overrides` is not sent for each window.
//!
//! Why no `git status` and no rename detection: both look at the whole tree of the repository,
//! which is the cost a window of rows must not pay on a site of a hundred thousand pages. A page
//! whose file is not in HEAD at that path is an added page, whatever it was called before.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs;
use std::sync::Arc;

use kd_hash::GitObjectFormat;
use kd_jsonc::Value;
use kd_site::meta::{Meta, Overrides};

use super::{F, Fail, KeyChange, Origin, Txn, Ui, fail, hash_hex};
use crate::PageKind;

/// How many parsed files of HEAD are kept. Past this the cache is emptied when a request begins:
/// it holds a parsed page file or sidecar for each file that differs, and what it is for (a window
/// of rows, a few reverts) is far less. A site where every file differs (a `core.autocrlf` that
/// changes the bytes git keeps) and that is read in windows of more than this parses each file
/// once for each window: that cost is accepted, as the cache is not for such a site.
const MAX_CACHED: usize = 4096;

/// What HEAD holds for a file, as the caller found it (the values of `head` in RFC §14.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum HeadFile {
	/// The file is not in HEAD.
	Absent,
	/// The file is not in HEAD, and `.gitignore` applies to it: git does not track it, so it is
	/// not compared.
	Ignored,
	/// Not compared: too large, not UTF-8, or not readable.
	Skip,
	/// HEAD holds what the file holds now.
	Same,
	/// HEAD holds something else, by its blob id, and its text if the caller has read it.
	Oid { oid: String, text: Option<String> },
}

/// Reads the `head` member of a request.
pub(super) fn parse_head(value: Option<&Value>) -> Result<HashMap<String, HeadFile>, String> {
	let Some(value) = value else {
		return Ok(HashMap::new());
	};
	let Value::Object(members) = value else {
		return Err("`head` must be an object".to_string());
	};
	let mut out = HashMap::new();
	for (path, state) in members {
		let file = match state {
			Value::Null => HeadFile::Absent,
			Value::String(s) if s == "ignored" => HeadFile::Ignored,
			Value::String(s) if s == "skip" => HeadFile::Skip,
			Value::String(s) if s == "same" => HeadFile::Same,
			Value::Object(_) => {
				let Some(Value::String(oid)) = state.get("oid") else {
					return Err(format!("`head[{path:?}].oid` (a string) is required"));
				};
				let text = match state.get("text") {
					Some(Value::String(t)) => Some(t.clone()),
					None | Some(Value::Null) => None,
					Some(_) => return Err(format!("`head[{path:?}].text` must be a string")),
				};
				HeadFile::Oid {
					oid: oid.clone(),
					text,
				}
			}
			_ => {
				return Err(format!(
					"`head[{path:?}]` must be null, \"ignored\", \"skip\", \"same\" or {{ oid, text? }}"
				));
			}
		};
		out.insert(path.clone(), file);
	}
	Ok(out)
}

/// What was made of the texts of HEAD, by the blob id they have (and the kind of file they were
/// read as: the same bytes are a page in one place and a sidecar in another), and the id of the
/// `pages.overrides` file as it is now.
#[derive(Default)]
pub(super) struct HeadCache {
	/// The metadata of a page file or sidecar of HEAD; `None` when it does not read.
	parsed: HashMap<(String, &'static str), Option<Meta>>,
	/// The bytes of the texts that `parsed` was made from.
	parsed_bytes: usize,
	/// The `pages.overrides` of HEAD, by its blob id; `None` when it does not read. One only:
	/// there is one file, and it is large.
	overrides: Option<(String, Option<Arc<Overrides>>)>,
	/// The blob id of `pages.overrides` as it is now, for the hash it was made from.
	blob: Option<(String, GitObjectFormat, String)>,
	/// The blob id of a page file or a sidecar, by its path, with the SHA-256 of the bytes it was
	/// made from (the one the plan holds for the file): the file is read once for as long as the
	/// plan holds the same bytes, and not for each window and each page turn.
	blobs: HashMap<String, (String, GitObjectFormat, String)>,
}

/// How many ids of files are kept. Past this they are dropped when a request begins: a window is a
/// few thousand pages (twice as many files), and an id with its path takes a few hundred bytes, so
/// this is some ten megabytes at most.
const MAX_BLOBS: usize = 50_000;

/// How many bytes of text of HEAD the parsed files in the cache stand for. Past this the cache is
/// emptied when a request begins, as it is past [`MAX_CACHED`] files: the files are small (what is
/// kept is their metadata), and this is for the site whose files are not.
const MAX_CACHED_BYTES: usize = 64 * 1024 * 1024;

impl HeadCache {
	fn has(&self, oid: &str, tag: &'static str) -> bool {
		if tag == "overrides" {
			return self.overrides.as_ref().is_some_and(|(o, _)| o == oid);
		}
		self.parsed.contains_key(&(oid.to_owned(), tag))
	}

	/// Empties the cache when it is full. Called when a request begins and never inside one: a
	/// request decides which texts it asks for by what the cache holds, and an entry that goes
	/// after that leaves a file that is neither parsed nor given (it would show no difference).
	fn trim(&mut self) {
		if self.parsed.len() >= MAX_CACHED || self.parsed_bytes >= MAX_CACHED_BYTES {
			self.parsed.clear();
			self.parsed_bytes = 0;
		}
	}

	fn meta(
		&mut self,
		abs: &str,
		tag: &'static str,
		oid: &str,
		text: Option<&str>,
	) -> Option<Meta> {
		let key = (oid.to_owned(), tag);
		if let Some(done) = self.parsed.get(&key) {
			return done.clone();
		}
		let text = text?;
		let parsed = parse_meta(abs, tag, text);
		self.parsed_bytes += text.len();
		self.parsed.insert(key, parsed.clone());
		parsed
	}

	fn overrides(&mut self, oid: &str, text: Option<&str>) -> Option<Arc<Overrides>> {
		if let Some((o, parsed)) = &self.overrides
			&& o == oid
		{
			return parsed.clone();
		}
		let text = text?;
		let parsed = Overrides::parse(text).ok().map(Arc::new);
		self.overrides = Some((oid.to_owned(), parsed.clone()));
		parsed
	}
}

/// The metadata a page file (`html`, `tsx`, `jsx`) or a sidecar (`json`) of HEAD reads as.
fn parse_meta(abs: &str, tag: &'static str, text: &str) -> Option<Meta> {
	match tag {
		"json" => {
			let value = kd_jsonc::parse(text).ok()?;
			kd_site::meta::as_meta(&value, abs).ok()
		}
		"html" => crate::parse_page_text(abs, PageKind::Html, text.to_string())
			.ok()
			.map(|(meta, _)| meta),
		_ => crate::parse_page_text(abs, PageKind::Tsx, text.to_string())
			.ok()
			.map(|(meta, _)| meta),
	}
}

/// The value of a key of the metadata.
fn get<'a>(meta: &'a Meta, key: &str) -> Option<&'a Value> {
	meta.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

/// The files of a page that its metadata is read from, with the path that git knows each by
/// (relative to the directory of the config file, with `/`) and how a file of HEAD is read.
struct Sources {
	input: Option<File>,
	sidecar: Option<File>,
}

struct File {
	abs: String,
	rel: String,
	tag: &'static str,
}

/// What is known of a page at HEAD: the metadata of each of the files that make it, the page
/// being one that HEAD does not have, and whether what is known is not enough to put a key
/// back (a file that was not compared or that does not read).
struct PageHead {
	in_file: Meta,
	side: Meta,
	overrides: Meta,
	added: bool,
	blocked: bool,
}

impl PageHead {
	/// The metadata of the page at HEAD, merged as the plan merges it.
	fn merged(&self) -> Meta {
		let files = kd_site::meta::merge(&[&self.in_file, &self.side]);
		kd_site::meta::merge(&[&files, &self.overrides])
	}
}

/// The path of `abs` from the directory `root`, with `/`: the part below it, with a `..` for each
/// directory of `root` that `abs` is not below. `None` when either is not an absolute path or
/// holds a `.` or `..` (the paths of the plan have none).
///
/// Why only paths that start with `/`: the paths of the plan are made so on the platforms the
/// product supports, and a drive letter has no `..` to the root of another drive. A path that is
/// not one of these is not compared, which is what an unsupported platform gets.
fn relative_path(root: &str, abs: &str) -> Option<String> {
	if !root.starts_with('/') || !abs.starts_with('/') {
		return None;
	}
	let from: Vec<&str> = root.split('/').filter(|c| !c.is_empty()).collect();
	let to: Vec<&str> = abs.split('/').filter(|c| !c.is_empty()).collect();
	if from.iter().chain(&to).any(|c| matches!(*c, "." | "..")) {
		return None;
	}
	let common = from.iter().zip(&to).take_while(|(a, b)| a == b).count();
	let mut parts: Vec<&str> = vec![".."; from.len() - common];
	parts.extend(&to[common..]);
	Some(parts.join("/"))
}

/// What the page is now, for the decision of what can be put back.
struct Now {
	in_file: Meta,
	side: Meta,
	/// The entry of the page in `pages.overrides`; `None` when there is none.
	entry: Option<Meta>,
	/// Why no key of the page file can be edited.
	file_reason: Option<String>,
	/// Keys the page file writes more than once.
	duplicates: Vec<String>,
	/// Whether the sidecar is there now.
	sidecar_there: bool,
}

/// The kind of difference of a value.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Modified,
	Added,
	Deleted,
}

/// The JSON of the difference of one cell. `writes` is the files a revert would write (the places
/// a value is written, in the order of the plan); `None` when it cannot be put back.
fn diff_json(kind: Kind, head: Option<&Value>, writes: Option<&[Origin]>) -> Value {
	let mut members = vec![(
		"kind".to_owned(),
		Value::String(
			match kind {
				Kind::Modified => "modified",
				Kind::Added => "added",
				Kind::Deleted => "deleted",
			}
			.to_owned(),
		),
	)];
	if kind != Kind::Added
		&& let Some(head) = head
	{
		members.push(("head".to_owned(), head.clone()));
	}
	members.push(("revertible".to_owned(), Value::Bool(writes.is_some())));
	if let Some(origins) = writes {
		members.push((
			"writes".to_owned(),
			Value::Array(
				origins
					.iter()
					.map(|origin| Value::String(origin.name().to_owned()))
					.collect(),
			),
		));
	}
	Value::Object(members)
}

/// Whether two values are the same value. The order of the keys of an object says nothing (a
/// formatter or an editor that sorts the keys must not make a value look changed), and the order
/// of the items of a list does.
fn same_value(a: &Value, b: &Value) -> bool {
	match (a, b) {
		(Value::Object(x), Value::Object(y)) => {
			x.len() == y.len()
				&& x.iter().all(|(key, value)| {
					y.iter()
						.find(|(other, _)| other == key)
						.is_some_and(|(_, found)| same_value(value, found))
				})
		}
		(Value::Array(x), Value::Array(y)) => {
			x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same_value(p, q))
		}
		_ => a == b,
	}
}

/// The kind of difference between a value now and at HEAD, if they differ.
fn kind_of(now: Option<&Value>, head: Option<&Value>) -> Option<Kind> {
	match (now, head) {
		(Some(a), Some(b)) if same_value(a, b) => None,
		(Some(_), Some(_)) => Some(Kind::Modified),
		(Some(_), None) => Some(Kind::Added),
		(None, Some(_)) => Some(Kind::Deleted),
		(None, None) => None,
	}
}

fn urls_of(value: &Value) -> Result<Vec<String>, String> {
	let Some(Value::Array(items)) = value.get("urls") else {
		return Err("`urls` (an array of strings) is required".to_string());
	};
	items
		.iter()
		.map(|v| match v {
			Value::String(s) => Ok(s.clone()),
			_ => Err("`urls` must hold strings".to_string()),
		})
		.collect()
}

fn format_of(value: &Value) -> Result<GitObjectFormat, String> {
	match value.get("format") {
		Some(Value::String(s)) => GitObjectFormat::from_name(s)
			.ok_or_else(|| "`format` must be \"sha1\" or \"sha256\"".to_string()),
		_ => Err("`format` (\"sha1\" or \"sha256\") is required".to_string()),
	}
}

impl Ui {
	/// The path git knows a file by: relative to the directory of the config file (where `git`
	/// is run), with `/`. A file above that directory (the input directory of a site can be
	/// `../content`) is named by a path that climbs out of it with `../`; the Node side leaves out
	/// the ones above the top of the repository. `None` for a name with a line break (the paths
	/// are told to `git` one to a line) and for a path that is not an absolute one.
	fn git_path(&self, abs: &str) -> Option<String> {
		let rel = relative_path(self.loaded.config.root_dir.trim_end_matches('/'), abs)?;
		if rel.is_empty() || rel.contains(['\n', '\r', '\0']) {
			return None;
		}
		Some(rel)
	}

	fn file_of(&self, abs: &str, tag: &'static str) -> Option<File> {
		Some(File {
			abs: abs.to_owned(),
			rel: self.git_path(abs)?,
			tag,
		})
	}

	fn sources_of(&self, i: usize) -> Sources {
		let page = &self.plan.pages[i];
		if page.is_virtual {
			return Sources {
				input: None,
				sidecar: None,
			};
		}
		let input = &page.file.input_path;
		let tag = if input.ends_with(".html") || input.ends_with(".htm") {
			"html"
		} else if input.ends_with(".jsx") {
			"jsx"
		} else {
			"tsx"
		};
		Sources {
			input: self.file_of(input, tag),
			sidecar: self.file_of(&crate::sidecar_path(input), "json"),
		}
	}

	fn overrides_file(&self) -> Option<File> {
		let o = self.overrides.as_ref()?;
		self.file_of(&o.path, "overrides")
	}

	/// The pages at `urls`. A URL that no page has is skipped: the window of rows that asked can be older
	/// than the plan (another `kamado` or an editor changed the files), and that is not an error of
	/// the screen.
	fn pages_of(&self, urls: &[String]) -> Vec<usize> {
		urls.iter()
			.filter_map(|u| self.by_url.get(u).copied())
			.collect()
	}

	/// The git blob ids of the files that the pages at `urls` are read from and of
	/// `pages.overrides`, as they are now (RFC §14.2: `uiDiffFiles`).
	///
	/// # Errors
	///
	/// A message for a request that is not `{ urls, format }`, or a file that cannot be read.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let files = ui.diff_files(r#"{"urls":["/"],"format":"sha1"}"#).unwrap();
	/// assert!(files.contains(r#""files":"#));
	/// ```
	pub fn diff_files(&mut self, query_json: &str) -> Result<String, String> {
		let v = kd_jsonc::parse(query_json).map_err(|e| format!("diff: invalid JSON: {e}"))?;
		let format = format_of(&v)?;
		let pages = self.pages_of(&urls_of(&v)?);
		if self.head.blobs.len() > MAX_BLOBS {
			self.head.blobs.clear();
		}
		let mut seen: HashSet<String> = HashSet::new();
		let mut files: Vec<Value> = Vec::new();
		for i in pages {
			let sources = self.sources_of(i);
			for file in [sources.input, sources.sidecar].into_iter().flatten() {
				if seen.insert(file.rel.clone()) {
					files.push(Value::Object(vec![
						("path".to_owned(), Value::String(file.rel)),
						("blob".to_owned(), self.blob_of_file(i, &file.abs, format)?),
					]));
				}
			}
		}
		let overrides = match self.overrides_file() {
			Some(file) => {
				let (hash, text) = {
					let o = self.overrides.as_ref().expect("overrides_file has a file");
					(o.hash.clone(), &o.text)
				};
				let blob = match &self.head.blob {
					Some((h, f, blob)) if *h == hash && *f == format => blob.clone(),
					_ => kd_hash::git_blob_id(text.as_bytes(), format),
				};
				self.head.blob = Some((hash, format, blob.clone()));
				Value::Object(vec![
					("path".to_owned(), Value::String(file.rel)),
					("blob".to_owned(), Value::String(blob)),
				])
			}
			None => Value::Null,
		};
		Ok(Value::Object(vec![
			("files".to_owned(), Value::Array(files)),
			("overrides".to_owned(), overrides),
		])
		.to_json())
	}

	/// The git blob id of a file of the page `i` as it is now (`null` when it is not there).
	///
	/// The plan holds the SHA-256 of the bytes it read for each file: while that is the same the id is
	/// the one made before, so that the window of a page turn does not read and hash thousands of
	/// files again. A file that is not what the plan read (it was changed after) is read, and
	/// its id is not kept: the id is of the file as it is, and the plan is read again by the next
	/// refresh.
	fn blob_of_file(
		&mut self,
		i: usize,
		abs: &str,
		format: GitObjectFormat,
	) -> Result<Value, String> {
		let held = self.plan.pages[i].deps.get(abs).map(|d| d.hash.clone());
		if held.as_deref() == Some(kd_build::MISSING_FILE_HASH) {
			return Ok(Value::Null);
		}
		if let (Some(hash), Some((made_from, f, blob))) = (&held, self.head.blobs.get(abs))
			&& made_from == hash
			&& *f == format
		{
			return Ok(Value::String(blob.clone()));
		}
		match fs::read(abs) {
			Ok(bytes) => {
				let blob = kd_hash::git_blob_id(&bytes, format);
				if let Some(hash) = held
					&& hash == hash_hex(&bytes)
				{
					self.head
						.blobs
						.insert(abs.to_owned(), (hash, format, blob.clone()));
				}
				Ok(Value::String(blob))
			}
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
			Err(e) => Err(format!("cannot read {abs}: {e}")),
		}
	}

	/// The files of `pages` whose text of HEAD has to be given, because their id is not one that
	/// was parsed before.
	fn head_needs(&self, pages: &[usize], head: &HashMap<String, HeadFile>) -> Vec<String> {
		let mut need: Vec<String> = Vec::new();
		let mut seen: HashSet<String> = HashSet::new();
		let mut check = |file: Option<File>| {
			let Some(file) = file else {
				return;
			};
			if let Some(HeadFile::Oid { oid, text: None }) = head.get(&file.rel)
				&& !self.head.has(oid, file.tag)
				&& seen.insert(file.rel.clone())
			{
				need.push(file.rel);
			}
		};
		for &i in pages {
			let sources = self.sources_of(i);
			check(sources.input);
			check(sources.sidecar);
		}
		check(self.overrides_file());
		need
	}

	/// What the files of the page `i` held at HEAD, or `None` when the page is not to be compared
	/// (its file is not tracked, or was not compared).
	fn page_head(&mut self, i: usize, head: &HashMap<String, HeadFile>) -> Option<PageHead> {
		let sources = self.sources_of(i);
		let url = self.plan.pages[i].file.url.clone();
		let is_virtual = self.plan.pages[i].is_virtual;
		let current_ov: Option<Meta> = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&url))
			.map(|e| e.meta.clone());
		let mut blocked = false;

		// The entry of the page in `pages.overrides`.
		let ov_file = self.overrides_file();
		let (overrides, entry_at_head) = match ov_file
			.as_ref()
			.map(|f| (f, head.get(&f.rel).unwrap_or(&HeadFile::Skip)))
		{
			// A site with no `pages.overrides` has no entry.
			None => (Vec::new(), false),
			Some((_, HeadFile::Ignored | HeadFile::Same)) => {
				(current_ov.clone().unwrap_or_default(), true)
			}
			Some((_, HeadFile::Skip)) => {
				blocked = true;
				(current_ov.clone().unwrap_or_default(), true)
			}
			Some((_, HeadFile::Absent)) => (Vec::new(), false),
			Some((_, HeadFile::Oid { oid, text })) => {
				match self.head.overrides(oid, text.as_deref()) {
					Some(parsed) => match parsed.by_url.get(&url) {
						Some(entry) => (entry.meta.clone(), true),
						None => (Vec::new(), false),
					},
					None => {
						blocked = true;
						(current_ov.clone().unwrap_or_default(), true)
					}
				}
			}
		};

		if is_virtual {
			return Some(PageHead {
				in_file: Vec::new(),
				side: Vec::new(),
				overrides,
				added: !entry_at_head,
				blocked,
			});
		}

		let input = sources.input?;
		let cached = self.cache.pages.get(&self.plan.pages[i].file.input_path)?;
		let (cur_in, cur_side) = (cached.in_file.clone(), cached.side.clone());
		let side = sources.sidecar?;
		let layer = |this: &mut Self, file: &File, current: &Meta, blocks: &mut bool| match head
			.get(&file.rel)
			.unwrap_or(&HeadFile::Skip)
		{
			HeadFile::Same | HeadFile::Ignored => Some(current.clone()),
			HeadFile::Skip => {
				*blocks = true;
				Some(current.clone())
			}
			HeadFile::Absent => Some(Vec::new()),
			HeadFile::Oid { oid, text } => {
				match this.head.meta(&file.abs, file.tag, oid, text.as_deref()) {
					Some(meta) => Some(meta),
					None => {
						*blocks = true;
						Some(current.clone())
					}
				}
			}
		};
		// A page file that is ignored or was not compared is not compared at all: the page is
		// not git's.
		match head.get(&input.rel).unwrap_or(&HeadFile::Skip) {
			HeadFile::Ignored | HeadFile::Skip => return None,
			_ => {}
		}
		let added = *head.get(&input.rel).unwrap_or(&HeadFile::Skip) == HeadFile::Absent;
		let in_file = layer(self, &input, &cur_in, &mut blocked)?;
		let side_meta = layer(self, &side, &cur_side, &mut blocked)?;
		Some(PageHead {
			in_file,
			side: side_meta,
			overrides,
			added,
			blocked,
		})
	}

	/// What the page is now, as `revert_plan` needs it. Made once for a page: the keys of a page
	/// that differ are many, and each asks the same of the files.
	fn now_of(&mut self, i: usize) -> Now {
		let (in_file, side) = match self.cache.pages.get(&self.plan.pages[i].file.input_path) {
			Some(c) => (c.in_file.clone(), c.side.clone()),
			None => (Vec::new(), Vec::new()),
		};
		let url = self.plan.pages[i].file.url.clone();
		let entry: Option<Meta> = self
			.overrides
			.as_ref()
			.and_then(|o| o.parsed.by_url.get(&url))
			.map(|e| e.meta.clone());
		let (file_reason, duplicates) = self.in_file_info(i);
		let sidecar = crate::sidecar_path(&self.plan.pages[i].file.input_path);
		let sidecar_there = self.plan.pages[i]
			.deps
			.get(&sidecar)
			.is_some_and(|d| d.hash != kd_build::MISSING_FILE_HASH);
		Now {
			in_file,
			side,
			entry,
			file_reason,
			duplicates,
			sidecar_there,
		}
	}

	/// The edits that put `key` of the page `i` back as `at_head` has it: for each of the files that
	/// make the page, the change that makes the key what it was there. Why only the files whose
	/// key differs: the merged value is the same at HEAD when each file's is, and a file that
	/// is not touched is not read or written. `field` is the `outputPathField` key (the `url`
	/// column), which is in the page file and the sidecar and never in `pages.overrides`.
	fn revert_plan(
		&self,
		i: usize,
		key: &str,
		at_head: &PageHead,
		now: &Now,
		field: bool,
	) -> Result<Vec<(Origin, KeyChange)>, String> {
		if at_head.added {
			return Err("the page is not in HEAD".to_string());
		}
		if at_head.blocked {
			return Err("what HEAD holds of the files of the page cannot be compared".to_string());
		}
		let is_virtual = self.plan.pages[i].is_virtual;
		let mut plan: Vec<(Origin, KeyChange)> = Vec::new();
		let layers = [
			(Origin::InFile, Some(&now.in_file), &at_head.in_file),
			(Origin::Sidecar, Some(&now.side), &at_head.side),
			(Origin::Overrides, now.entry.as_ref(), &at_head.overrides),
		];
		for (origin, current, then) in layers {
			if is_virtual && origin != Origin::Overrides {
				continue;
			}
			if field && origin == Origin::Overrides {
				continue;
			}
			let now_value = current.and_then(|m| get(m, key));
			let then_value = get(then, key);
			if match (now_value, then_value) {
				(Some(a), Some(b)) => same_value(a, b),
				(None, None) => true,
				_ => false,
			} {
				continue;
			}
			let change = match then_value {
				Some(v) => KeyChange::Set(key.to_owned(), v.clone()),
				None => KeyChange::Delete(key.to_owned()),
			};
			match origin {
				Origin::InFile => {
					if let Some(reason) = &now.file_reason {
						return Err(reason.clone());
					}
					if now.duplicates.iter().any(|d| d == key) {
						return Err("the key is written more than once in `meta`".to_string());
					}
				}
				Origin::Sidecar => {
					if !now.sidecar_there {
						return Err(
							"the sidecar of the page is not there to be changed".to_string()
						);
					}
				}
				Origin::Overrides => {
					if self.overrides.is_none() || now.entry.is_none() {
						return Err(
							"the page has no entry in pages.overrides (none is added)".to_string()
						);
					}
				}
			}
			plan.push((origin, change));
		}
		if plan.is_empty() {
			return Err("the value is what HEAD has".to_string());
		}
		Ok(plan)
	}

	/// The difference between the pages at `urls` and HEAD (RFC §14.2: `uiDiff`).
	///
	/// # Errors
	///
	/// A message for a request that is not `{ urls, format, head }`.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let mut ui = kd_core::Ui::open(loaded, &kd_core::BuildOptions::default()).unwrap();
	/// let answer = ui
	///     .diff(r#"{"urls":["/"],"format":"sha1","head":{}}"#)
	///     .unwrap();
	/// assert!(answer.contains(r#""pages":"#));
	/// ```
	pub fn diff(&mut self, query_json: &str) -> Result<String, String> {
		let v = kd_jsonc::parse(query_json).map_err(|e| format!("diff: invalid JSON: {e}"))?;
		// The format is only checked: what `diff` compares is told by the caller (the ids of
		// `uiDiffFiles`), so nothing here makes an id.
		format_of(&v)?;
		let pages = self.pages_of(&urls_of(&v)?);
		let head = parse_head(v.get("head"))?;
		self.head.trim();
		let need = self.head_needs(&pages, &head);
		if !need.is_empty() {
			return Ok(Value::Object(vec![(
				"need".to_owned(),
				Value::Array(need.into_iter().map(Value::String).collect()),
			)])
			.to_json());
		}
		let field = self.output_path_field().map(str::to_owned);
		let mut out: Vec<(String, Value)> = Vec::new();
		let mut columns: BTreeSet<String> = BTreeSet::new();
		for i in pages {
			let Some(at_head) = self.page_head(i, &head) else {
				continue;
			};
			// Made when the first key that differs asks for it, and once for the page.
			let mut now_of_page: Option<Now> = None;
			let url = self.plan.pages[i].file.url.clone();
			let is_virtual = self.plan.pages[i].is_virtual;
			let mut members: Vec<(String, Value)> = Vec::new();
			if at_head.added {
				members.push(("url".to_owned(), diff_json(Kind::Added, None, None)));
				if !is_virtual {
					members.push(("inputPath".to_owned(), diff_json(Kind::Added, None, None)));
				}
			} else if let Some(field) = &field
				&& !is_virtual
			{
				let page = &self.plan.pages[i];
				let (cur_in, cur_side) = match self.cache.pages.get(&page.file.input_path) {
					Some(c) => (c.in_file.clone(), c.side.clone()),
					None => (Vec::new(), Vec::new()),
				};
				let now = kd_site::meta::merge(&[&cur_in, &cur_side]);
				let then = kd_site::meta::merge(&[&at_head.in_file, &at_head.side]);
				if let Some(kind) = kind_of(get(&now, field), get(&then, field)) {
					let now = now_of_page.get_or_insert_with(|| self.now_of(i));
					let writes = self
						.revert_plan(i, field, &at_head, now, true)
						.ok()
						.map(|plan| plan.iter().map(|(origin, _)| *origin).collect::<Vec<_>>());
					members.push((
						"url".to_owned(),
						diff_json(kind, get(&then, field), writes.as_deref()),
					));
				}
			}
			let now = self.plan.pages[i].meta.clone();
			let then = at_head.merged();
			let keys: BTreeSet<&String> = now
				.iter()
				.chain(then.iter())
				.map(|(k, _)| k)
				.filter(|k| Some(k.as_str()) != field.as_deref())
				.collect();
			let mut parsed: Vec<(String, Value)> = Vec::new();
			for key in keys {
				let Some(kind) = kind_of(get(&now, key), get(&then, key)) else {
					continue;
				};
				let writes = if at_head.added {
					None
				} else {
					let now = now_of_page.get_or_insert_with(|| self.now_of(i));
					self.revert_plan(i, key, &at_head, now, false)
						.ok()
						.map(|plan| plan.iter().map(|(origin, _)| *origin).collect::<Vec<_>>())
				};
				if kind == Kind::Deleted && !self.columns.contains(key.as_str()) {
					columns.insert(key.clone());
				}
				parsed.push((
					key.clone(),
					diff_json(kind, get(&then, key), writes.as_deref()),
				));
			}
			if !parsed.is_empty() {
				members.push(("meta".to_owned(), Value::Object(parsed)));
			}
			if !members.is_empty() {
				out.push((url, Value::Object(members)));
			}
		}
		Ok(Value::Object(vec![
			("version".to_owned(), Value::Number(self.version as f64)),
			("pages".to_owned(), Value::Object(out)),
			(
				"columns".to_owned(),
				Value::Array(columns.into_iter().map(Value::String).collect()),
			),
		])
		.to_json())
	}

	/// The paths of the files of page `i` whose text of HEAD has to be given for a revert of its
	/// key (see [`Ui::head_needs`]).
	pub(super) fn revert_needs(
		&mut self,
		i: usize,
		head: &HashMap<String, HeadFile>,
	) -> Vec<String> {
		self.head.trim();
		self.head_needs(&[i], head)
	}

	/// Puts back `key` of the page `i` as HEAD has it (`key` is `None` for the `outputPathField`
	/// key, the `url` column): each file that makes the page and has another value for it is
	/// written, all or none. Returns the URL the page has afterwards.
	pub(super) fn revert(
		&mut self,
		i: usize,
		expect: &Value,
		key: Option<&str>,
		head: &HashMap<String, HeadFile>,
	) -> F<String> {
		let field = self.output_path_field().map(str::to_owned);
		let (name, is_field) = match key {
			Some(k) => {
				if Some(k) == field.as_deref() {
					return fail(
						"notEditable",
						"this key sets the URL of the page; put the URL back instead",
					);
				}
				(k.to_owned(), false)
			}
			None => match field {
				Some(f) if !self.plan.pages[i].is_virtual => (f, true),
				_ => {
					return fail(
						"invalid",
						"the URL of this page is not made by a key, so there is no key to put back",
					);
				}
			},
		};
		let Some(at_head) = self.page_head(i, head) else {
			return fail("notEditable", "the page is not compared with HEAD");
		};
		let now = self.now_of(i);
		let plan = self
			.revert_plan(i, &name, &at_head, &now, is_field)
			.map_err(|message| Fail {
				code: "notEditable",
				message,
			})?;
		let old_input = self.plan.pages[i].file.input_path.clone();
		let url = self.plan.pages[i].file.url.clone();
		let mut txn = Txn::default();
		let mut overrides_change: Option<KeyChange> = None;
		for (origin, change) in &plan {
			let part = self.key_txn(i, expect, change, *origin)?;
			txn.writes.extend(part.writes);
			if part.overrides_after.is_some() {
				txn.overrides_after = part.overrides_after;
				overrides_change = Some(change.clone());
			}
		}
		let overrides_after = txn.overrides_after.take();
		txn.commit()?;
		if is_field {
			// The URL is made by the key: the page has the URL of HEAD now, and the plan says which.
			self.plan_after_files_changed()?;
			let moved = self
				.plan
				.pages
				.iter()
				.find(|p| !p.is_virtual && p.file.input_path == old_input)
				.map(|p| p.file.url.clone());
			return moved.map_or_else(
				|| {
					fail(
						"io",
						"the files were changed, but the page is not in the plan now",
					)
				},
				Ok,
			);
		}
		let mut failed: Option<Fail> = None;
		if let (Some(change), Some(after)) = (&overrides_change, overrides_after)
			&& let Err(e) = self.after_key_edit(i, change, Some(after))
		{
			failed = Some(e);
		}
		for (origin, change) in &plan {
			if *origin == Origin::Overrides {
				continue;
			}
			if let Err(e) = self.after_key_edit(i, change, None) {
				failed = Some(e);
			}
		}
		if let Some(e) = failed {
			// The files are written, so the revert is made; what this handle knows is not what the
			// files hold, and the site is read again to make it so.
			self.plan_again(None).map_err(|message| Fail {
				code: "io",
				message: format!(
					"the files were written, but the site cannot be read now: {message} ({})",
					e.message
				),
			})?;
		}
		Ok(url)
	}

	/// The answer that asks for the text of files of HEAD (`code` `need`).
	pub(super) fn need_json(need: Vec<String>) -> String {
		Value::Object(vec![
			("ok".to_owned(), Value::Bool(false)),
			("code".to_owned(), Value::String("need".to_owned())),
			(
				"message".to_owned(),
				Value::String("the text of these files of HEAD is needed".to_owned()),
			),
			(
				"need".to_owned(),
				Value::Array(need.into_iter().map(Value::String).collect()),
			),
		])
		.to_json()
	}
}
