//! The editor of the pages as strings in and out (see `kd_core::Ui`). The editor of a
//! project lives in a process-wide table, keyed by a handle, so that the JavaScript side can
//! keep it across requests.
//!
//! Every answer is JSON: the rows (`uiPages`), the values of a key (`uiValues`), `{ "version" }`
//! (`uiRefresh`), the result of an
//! edit (`uiEdit`, and `uiEditBatch` for several made as one; an edit that is refused is a
//! result with `"ok": false`, not an error) and
//! `{ "warning" }` (`uiClose`). A request that is not one, a site that cannot be planned and
//! a handle that is not open are errors.
//!
//! The calls of one editor are made one after another (a lock around it), and each runs to
//! the end before the next starts: an edit reads the files, checks them, writes them and
//! updates what the editor knows in one call, so no other call sees it half done.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kd_core::Ui;
use kd_jsonc::Value;

static NEXT: AtomicU64 = AtomicU64::new(1);

type Editors = HashMap<u64, Arc<Mutex<Ui>>>;

static EDITORS: Mutex<Option<Editors>> = Mutex::new(None);

fn editors() -> std::sync::MutexGuard<'static, Option<Editors>> {
	EDITORS.lock().unwrap_or_else(|e| e.into_inner())
}

fn get(handle: &str) -> Result<Arc<Mutex<Ui>>, String> {
	let id: u64 = handle
		.parse()
		.map_err(|_| format!("{handle:?} is not a handle"))?;
	editors()
		.as_ref()
		.and_then(|e| e.get(&id))
		.map(Arc::clone)
		.ok_or_else(|| format!("no editor for handle {handle}"))
}

/// Runs `f` on the editor of `handle`.
fn with<T>(handle: &str, f: impl FnOnce(&mut Ui) -> Result<T, String>) -> Result<T, String> {
	let editor = get(handle)?;
	let mut ui = editor.lock().unwrap_or_else(|e| e.into_inner());
	f(&mut ui)
}

/// Plans the site of a project and keeps the editor; the answer is its handle.
pub(crate) fn open(config_path: &str, options_json: &str) -> Result<String, String> {
	let options = crate::build_options_from_json(options_json)?;
	let loaded = kd_core::load(config_path)?;
	let ui = Ui::open(loaded, &options)?;
	let handle = NEXT.fetch_add(1, Ordering::SeqCst);
	editors()
		.get_or_insert_with(HashMap::new)
		.insert(handle, Arc::new(Mutex::new(ui)));
	Ok(handle.to_string())
}

/// A page of rows (`queryJson`: `{ "offset", "limit", "q"? }`).
pub(crate) fn pages(handle: &str, query_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.pages(query_json))
}

/// The values of a metadata key over every page (`queryJson`: `{ "key", "limit" }`).
pub(crate) fn values(handle: &str, query_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.values(query_json))
}

/// Plans the site again.
pub(crate) fn refresh(handle: &str) -> Result<String, String> {
	with(handle, |ui| {
		let version = ui.refresh()?;
		Ok(Value::Object(vec![("version".to_owned(), Value::Number(version as f64))]).to_json())
	})
}

/// Every page of the plan, for a sync: the entry of `kamado pages` with the hashes of its files,
/// and the hash of `pages.overrides`.
pub(crate) fn sync_pages(handle: &str) -> Result<String, String> {
	with(handle, |ui| Ok(ui.sync_pages()))
}

/// The keys that cannot be edited, for the pages at `urls` (`{ "urls" }`), for a sync.
pub(crate) fn sync_locked(handle: &str, query_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.sync_locked(query_json))
}

/// The git blob ids of the files the pages at `urls` are read from (`{ "urls", "format" }`).
pub(crate) fn diff_files(handle: &str, query_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.diff_files(query_json))
}

/// The difference between the pages at `urls` and HEAD (`{ "urls", "format", "head" }`).
pub(crate) fn diff(handle: &str, query_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.diff(query_json))
}

/// Makes one edit.
pub(crate) fn edit(handle: &str, edit_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.edit(edit_json))
}

/// Makes the edits of a batch as one: all of them, or none.
pub(crate) fn edit_batch(handle: &str, batch_json: &str) -> Result<String, String> {
	with(handle, |ui| ui.edit_batch(batch_json))
}

/// The port and the browser setting of `devServer`, and the input and output directories:
/// `{ "port", "open", "inputDir", "outputDir", "overrides", "syncFunctions" }` (`syncFunctions` is
/// the operations of `ui.syncFunctions`, each `{ "name", "label", "script" }` with the script
/// absolute).
pub(crate) fn server(handle: &str) -> Result<String, String> {
	with(handle, |ui| {
		let settings = ui.server();
		Ok(Value::Object(vec![
			("port".to_owned(), Value::Number(f64::from(settings.port))),
			("open".to_owned(), Value::Bool(settings.open)),
			(
				"inputDir".to_owned(),
				Value::String(settings.input_dir.to_owned()),
			),
			(
				"outputDir".to_owned(),
				Value::String(settings.output_dir.to_owned()),
			),
			(
				"overrides".to_owned(),
				settings
					.overrides
					.map_or(Value::Null, |path| Value::String(path.to_owned())),
			),
			("syncFunctions".to_owned(), settings.sync_functions_json()),
		])
		.to_json())
	})
}

/// Forgets the editor, writing the plan cache if it has to be.
pub(crate) fn close(handle: &str) -> Result<String, String> {
	let editor = get(handle)?;
	let warning = editor.lock().unwrap_or_else(|e| e.into_inner()).close();
	if let Some(e) = editors().as_mut() {
		e.remove(&handle.parse::<u64>().unwrap_or(0));
	}
	Ok(Value::Object(vec![(
		"warning".to_owned(),
		warning.map_or(Value::Null, Value::String),
	)])
	.to_json())
}
