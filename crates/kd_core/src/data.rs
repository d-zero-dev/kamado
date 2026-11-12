//! The `data` that templates receive: the files of `data.dir` (JSON, YAML,
//! and HTML / text read as strings), keyed by file name without extension,
//! with `data.values` on top. The core runs no JavaScript: a data file that is a
//! script (`.ts`, `.mts`, `.js`, `.mjs`) is run by the Node side, which gives the
//! values (or the failures) in; see [`Executed`].

use std::collections::HashMap;
use std::fs;
use std::sync::Arc;

use kd_config::Config;
use kd_jsonc::Value;

/// What running a data file that is a script came to.
#[derive(Debug, Clone, PartialEq)]
pub enum Executed {
	/// The value of the key.
	Value(Value),
	/// Why it has no value: a page that reads the key fails, the others do not.
	Failed(String),
}

/// The script files of `data.dir`: the keys that the Node side has to run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptFile {
	pub key: String,
	/// The absolute path of the file.
	pub path: String,
}

/// The extensions of data files that are scripts.
pub const SCRIPT_EXTENSIONS: [&str; 4] = [".ts", ".mts", ".js", ".mjs"];

/// Whether a file name is a type declaration (`types.d.ts`): it has no value, so it is not a
/// data file.
fn is_declaration(name: &str) -> bool {
	let lower = name.to_ascii_lowercase();
	lower.ends_with(".d.ts") || lower.ends_with(".d.mts")
}

/// The merged data and the hashes that pages are checked against: a page
/// rendered by JavaScript is rebuilt when a key it read changed.
pub(crate) struct Data {
	pub value: Value,
	/// The keys of data files that failed to run, with the reason. They are not in
	/// `value`; a page that reads one fails.
	pub errors: Vec<(String, String)>,
	/// The hashes, kept apart from `value`: the value goes to the renderers while
	/// the build goes on deciding which pages are up to date.
	pub hashes: Hashes,
}

/// The hash of `data` as a whole and of each top-level key.
///
/// Shared, not copied: the dev server takes one for each page it renders, and a build
/// compares it with the record of every page.
#[derive(Debug, Clone, Default)]
pub(crate) struct Hashes(Arc<HashesInner>);

#[derive(Debug, Default)]
struct HashesInner {
	whole: String,
	keys: HashMap<String, String>,
	/// The hash of a key that is not there: of nothing at all.
	absent: String,
}

impl Hashes {
	/// The hash of one top-level key: of its value in JSON, or, for a key that is
	/// not there, of nothing at all (a page that read a missing key must be
	/// rebuilt when the key appears, and not when another one changes).
	pub(crate) fn key_hash(&self, key: &str) -> &str {
		self.0.keys.get(key).unwrap_or(&self.0.absent)
	}

	/// What a page that read `keys` (`None`: every key) depends on, to be stored
	/// in the manifest.
	pub(crate) fn deps_of(&self, keys: Option<&[String]>) -> kd_build::DataDeps {
		match keys {
			None => kd_build::DataDeps::All(self.0.whole.clone()),
			Some(keys) => kd_build::DataDeps::Keys(
				keys.iter()
					.map(|k| (k.clone(), self.key_hash(k).to_owned()))
					.collect(),
			),
		}
	}

	/// Why the page is out of date, for `--verbose`: the first key it read that changed,
	/// or that it depends on every key. `None` when nothing it read changed.
	pub(crate) fn why_changed(&self, deps: &kd_build::DataDeps) -> Option<String> {
		match deps {
			kd_build::DataDeps::None => Some("there is no record of what the page read".to_owned()),
			kd_build::DataDeps::All(hash) => (*hash != self.0.whole)
				.then(|| "the page depends on every key of data, and data changed".to_owned()),
			kd_build::DataDeps::Keys(keys) => keys
				.iter()
				.find(|(k, h)| self.key_hash(k) != h.as_str())
				.map(|(k, _)| format!("data.{k} changed")),
		}
	}

	/// Whether what the page depended on is as it was.
	pub(crate) fn unchanged(&self, deps: &kd_build::DataDeps) -> bool {
		match deps {
			// A page rendered by JavaScript always has a record; none means it was
			// not traced, so it is rebuilt.
			kd_build::DataDeps::None => false,
			kd_build::DataDeps::All(hash) => *hash == self.0.whole,
			kd_build::DataDeps::Keys(keys) => {
				keys.iter().all(|(k, h)| self.key_hash(k) == h.as_str())
			}
		}
	}
}

/// A cheap stamp of the data directory: the name, size and modification time
/// of every file in it. A different stamp means the data may have changed
/// (the dev server compares it before every request instead of reading the
/// files).
pub(crate) fn stamp(config: &Config) -> String {
	let Some(dir) = &config.data.dir else {
		return String::new();
	};
	let mut parts: Vec<String> = fs::read_dir(dir)
		.into_iter()
		.flatten()
		.filter_map(Result::ok)
		.filter_map(|e| {
			// Through a link, as `load` reads the file it points to.
			let meta = fs::metadata(e.path()).ok()?;
			let modified = meta
				.modified()
				.ok()?
				.duration_since(std::time::UNIX_EPOCH)
				.ok()?;
			Some(format!(
				"{}:{}:{}.{}",
				e.file_name().to_string_lossy(),
				meta.len(),
				modified.as_secs(),
				modified.subsec_nanos()
			))
		})
		.collect();
	parts.sort();
	parts.join("|")
}

/// `executed` with a failure for each script file that has no entry: a file that was added
/// while the dev server runs, before the Node side has run it.
pub(crate) fn with_pending(
	config: &Config,
	executed: &[(String, Executed)],
) -> Vec<(String, Executed)> {
	let mut all = executed.to_vec();
	for file in script_files(config).unwrap_or_default() {
		if !all.iter().any(|(k, _)| *k == file.key) {
			all.push((
				file.key,
				Executed::Failed("the data file has not run yet".to_owned()),
			));
		}
	}
	all
}

/// The reasons that data files failed, as the object a context carries, or `None` when
/// none did.
pub(crate) fn errors_json(errors: &[(String, String)]) -> Option<Value> {
	(!errors.is_empty()).then(|| {
		Value::Object(
			errors
				.iter()
				.map(|(k, why)| (k.clone(), Value::String(why.clone())))
				.collect(),
		)
	})
}

/// The files of the data directory in name order (not recursively; files
/// starting with `.` are skipped).
fn files_of(dir: &str) -> Result<Vec<String>, String> {
	let mut files: Vec<String> = Vec::new();
	for entry in fs::read_dir(dir).map_err(|e| format!("cannot read data.dir {dir}: {e}"))? {
		let entry = entry.map_err(|e| format!("cannot read data.dir {dir}: {e}"))?;
		let name = entry
			.file_name()
			.into_string()
			.map_err(|n| format!("{dir}: the file name {n:?} is not valid UTF-8"))?;
		// A link to a file counts as the file (the pages are found the same way).
		if !name.starts_with('.') && fs::metadata(entry.path()).is_ok_and(|m| m.is_file()) {
			files.push(name);
		}
	}
	files.sort();
	Ok(files)
}

/// The data files that are scripts, in name order: what the Node side has to
/// run before the core can load the data. Two files with the same key are both
/// listed; `data_plan` refuses them.
///
/// # Errors
///
/// A message when the directory cannot be read.
pub(crate) fn script_files(config: &Config) -> Result<Vec<ScriptFile>, String> {
	let Some(dir) = &config.data.dir else {
		return Ok(Vec::new());
	};
	let mut found: Vec<ScriptFile> = Vec::new();
	for name in files_of(dir)? {
		let Some(i) = name.rfind('.').filter(|&i| i > 0) else {
			continue;
		};
		if !SCRIPT_EXTENSIONS.contains(&name[i..].to_ascii_lowercase().as_str())
			|| is_declaration(&name)
		{
			continue;
		}
		let path = format!("{}/{name}", dir.trim_end_matches('/'));
		found.push(ScriptFile {
			key: name[..i].to_owned(),
			path,
		});
	}
	Ok(found)
}

/// Reads the data directory (not recursively; files starting with `.` are
/// skipped) in name order. `executed` has what the Node side made of each
/// script file.
///
/// # Errors
///
/// A message with the file name for an unreadable file, invalid JSON or
/// YAML, a script file that has no entry in `executed`, or two files with the
/// same key.
pub(crate) fn load(config: &Config, executed: &[(String, Executed)]) -> Result<Data, String> {
	let mut members: Vec<(String, Value)> = Vec::new();
	let mut errors: Vec<(String, String)> = Vec::new();
	if let Some(dir) = &config.data.dir {
		for name in files_of(dir)? {
			let path = format!("{}/{name}", dir.trim_end_matches('/'));
			let (stem, ext) = match name.rfind('.') {
				Some(i) if i > 0 => (&name[..i], name[i..].to_ascii_lowercase()),
				_ => continue,
			};
			if is_declaration(&name) {
				continue;
			}
			let read = || {
				fs::read_to_string(&path).map_err(|e| format!("cannot read data file {path}: {e}"))
			};
			let value = match ext.as_str() {
				".json" => kd_jsonc::parse(&read()?)
					.map_err(|e| format!("{path}:{}:{}: {}", e.line, e.column, e.message))?,
				".yml" | ".yaml" => kd_yaml::parse(&read()?).map_err(|e| format!("{path}: {e}"))?,
				".html" | ".htm" | ".txt" => Value::String(read()?),
				e if SCRIPT_EXTENSIONS.contains(&e) => {
					match executed.iter().find(|(k, _)| k == stem) {
						Some((_, Executed::Value(value))) => value.clone(),
						Some((_, Executed::Failed(why))) => {
							if members.iter().any(|(k, _)| k == stem)
								|| errors.iter().any(|(k, _)| k == stem)
							{
								return Err(format!(
									"{path}: another data file already defines the key {stem:?}"
								));
							}
							errors.push((stem.to_owned(), why.clone()));
							continue;
						}
						None => {
							return Err(format!(
								"{path}: a script data file was not run (the Node side gives the value of each)"
							));
						}
					}
				}
				// Formats that look like data but are not read: said, not skipped, so
				// that `data.xxx` is not silently undefined in the templates.
				".jsonc" | ".json5" | ".toml" | ".csv" | ".cjs" => {
					return Err(format!(
						"{path}: {ext} files are not read as data (JSON, YAML, HTML, text and \
						 .ts/.mts/.js/.mjs scripts are); convert it, or give `data.values` the value"
					));
				}
				_ => continue,
			};
			if members.iter().any(|(k, _)| k == stem) || errors.iter().any(|(k, _)| k == stem) {
				return Err(format!(
					"{path}: another data file already defines the key {stem:?}"
				));
			}
			members.push((stem.to_owned(), value));
		}
	}
	// `data.values` is written in the config, so it wins over the files.
	if let Value::Object(values) = &config.data.values {
		for (key, value) in values {
			match members.iter_mut().find(|(k, _)| k == key) {
				Some(existing) => existing.1 = value.clone(),
				None => members.push((key.clone(), value.clone())),
			}
			// A value the config gives is the value, whether or not the file of that key ran.
			errors.retain(|(k, _)| k != key);
		}
	}
	// A key that failed has a hash of its reason: a page that read it is built
	// again when it fails differently, or runs.
	let mut keys: HashMap<String, String> = members
		.iter()
		.map(|(k, v)| {
			let hash = kd_hash::sha256(format!("=\0{}", v.to_json()).as_bytes());
			(k.clone(), kd_hash::to_hex(&hash))
		})
		.collect();
	for (k, why) in &errors {
		let hash = kd_hash::sha256(format!("!\0{why}").as_bytes());
		keys.insert(k.clone(), kd_hash::to_hex(&hash));
	}
	let value = Value::Object(members);
	let mut whole = value.to_json();
	for (k, why) in &errors {
		whole.push_str(&format!("\0!{k}\0{why}"));
	}
	let hash = kd_hash::to_hex(&kd_hash::sha256(whole.as_bytes()));
	let hashes = Hashes(Arc::new(HashesInner {
		whole: hash,
		keys,
		absent: kd_hash::to_hex(&kd_hash::sha256(b"-")),
	}));
	Ok(Data {
		value,
		errors,
		hashes,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config(dir: &str) -> Config {
		let json = format!(
			"{{\"dir\":{{\"input\":\"{dir}\",\"output\":\"{dir}/out\"}},\"data\":{{\"dir\":\"{dir}/data\"}}}}"
		);
		kd_config::parse(&json, dir, None).unwrap()
	}

	fn scratch(name: &str) -> String {
		let dir = format!(
			"{}/kd_core_data_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		);
		let _ = fs::remove_dir_all(&dir);
		fs::create_dir_all(format!("{dir}/data")).unwrap();
		dir
	}

	#[test]
	fn a_link_to_a_data_file_is_read_like_the_file() {
		let dir = scratch("link");
		fs::write(format!("{dir}/real.json"), "{\"a\":1}").unwrap();
		std::os::unix::fs::symlink(
			format!("{dir}/real.json"),
			format!("{dir}/data/linked.json"),
		)
		.unwrap();

		let data = load(&config(&dir), &[]).unwrap();

		assert_eq!(data.value.to_json(), "{\"linked\":{\"a\":1}}");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn formats_that_are_not_read_as_data_are_an_error_not_a_silent_gap() {
		let dir = scratch("unsupported");
		fs::write(format!("{dir}/data/site.jsonc"), "{}").unwrap();

		let message = load(&config(&dir), &[]).err().unwrap();

		assert!(
			message.contains("site.jsonc: .jsonc files are not read as data"),
			"{message}"
		);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_page_depends_on_the_keys_it_read_and_not_on_the_others() {
		let dir = scratch("keys");
		fs::write(format!("{dir}/data/a.json"), "{\"n\":1}").unwrap();
		fs::write(format!("{dir}/data/b.json"), "{\"n\":1}").unwrap();
		let before = load(&config(&dir), &[]).unwrap();
		let read = ["a".to_owned(), "missing".to_owned()];
		let deps = before.hashes.deps_of(Some(&read));
		fs::write(format!("{dir}/data/b.json"), "{\"n\":2}").unwrap();
		let other_key = load(&config(&dir), &[]).unwrap();
		fs::write(format!("{dir}/data/a.json"), "{\"n\":2}").unwrap();
		let own_key = load(&config(&dir), &[]).unwrap();
		fs::write(format!("{dir}/data/missing.json"), "1").unwrap();
		let added = load(&config(&dir), &[]).unwrap();

		assert!(before.hashes.unchanged(&deps));
		assert!(other_key.hashes.unchanged(&deps), "b is not read");
		assert!(!own_key.hashes.unchanged(&deps), "a changed");
		assert!(
			!added.hashes.unchanged(&deps),
			"a key that was missing appeared"
		);
		assert!(
			!other_key.hashes.unchanged(&before.hashes.deps_of(None)),
			"every key"
		);
		assert!(!before.hashes.unchanged(&kd_build::DataDeps::None));
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn why_a_page_is_out_of_date_names_the_key_and_never_the_value() {
		let dir = scratch("why");
		fs::write(format!("{dir}/data/a.json"), "{\"secret\":1}").unwrap();
		fs::write(format!("{dir}/data/b.json"), "1").unwrap();
		let before = load(&config(&dir), &[]).unwrap();
		let keys = ["a".to_owned(), "b".to_owned()];
		let by_keys = before.hashes.deps_of(Some(&keys));
		let every = before.hashes.deps_of(None);
		fs::write(format!("{dir}/data/b.json"), "2").unwrap();
		let after = load(&config(&dir), &[]).unwrap();

		assert_eq!(
			after.hashes.why_changed(&by_keys).as_deref(),
			Some("data.b changed")
		);
		assert!(
			after
				.hashes
				.why_changed(&every)
				.is_some_and(|w| w.contains("every key"))
		);
		assert!(
			after
				.hashes
				.why_changed(&kd_build::DataDeps::None)
				.is_some_and(|w| w.contains("no record"))
		);
		assert_eq!(before.hashes.why_changed(&by_keys), None);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn other_files_in_the_directory_are_left_alone() {
		let dir = scratch("other");
		fs::write(format!("{dir}/data/README.md"), "notes").unwrap();
		fs::write(format!("{dir}/data/.hidden.json"), "{").unwrap();
		fs::write(format!("{dir}/data/t.txt"), "text").unwrap();

		let data = load(&config(&dir), &[]).unwrap();

		assert_eq!(data.value.to_json(), "{\"t\":\"text\"}");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn script_files_are_found_by_key_and_not_read() {
		let dir = scratch("scripts");
		fs::write(format!("{dir}/data/news.ts"), "export default []").unwrap();
		fs::write(format!("{dir}/data/rates.MJS"), "export default {}").unwrap();
		fs::write(format!("{dir}/data/site.json"), "{}").unwrap();
		fs::write(format!("{dir}/data/old.cjs"), "").unwrap();

		let found = script_files(&config(&dir)).unwrap();

		assert_eq!(
			found.iter().map(|f| f.key.as_str()).collect::<Vec<_>>(),
			["news", "rates"]
		);
		assert!(found[0].path.ends_with("/data/news.ts"));
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn the_value_a_script_file_ran_to_is_the_value_of_its_key() {
		let dir = scratch("executed");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		fs::write(format!("{dir}/data/a.json"), "{\"n\":1}").unwrap();
		let given = [(
			"news".to_owned(),
			Executed::Value(kd_jsonc::parse("[1,2]").unwrap()),
		)];

		let data = load(&config(&dir), &given).unwrap();

		assert_eq!(data.value.to_json(), "{\"a\":{\"n\":1},\"news\":[1,2]}");
		assert!(data.errors.is_empty());
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_script_file_that_was_not_run_is_an_error_naming_it() {
		let dir = scratch("not_run");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();

		let message = load(&config(&dir), &[]).err().unwrap();

		assert!(
			message.contains("news.ts: a script data file was not run"),
			"{message}"
		);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_key_of_a_script_file_cannot_be_given_by_another_file_too() {
		let dir = scratch("twice");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		fs::write(format!("{dir}/data/news.json"), "[]").unwrap();
		let given = [("news".to_owned(), Executed::Value(Value::Array(Vec::new())))];

		let message = load(&config(&dir), &given).err().unwrap();

		assert!(
			message.contains("already defines the key \"news\""),
			"{message}"
		);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_failed_key_has_no_value_and_a_hash_of_its_reason() {
		let dir = scratch("failed");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		let failed = |why: &str| [("news".to_owned(), Executed::Failed(why.to_owned()))];
		let reads = ["news".to_owned()];

		let first = load(&config(&dir), &failed("timed out")).unwrap();
		let same = load(&config(&dir), &failed("timed out")).unwrap();
		let other = load(&config(&dir), &failed("refused")).unwrap();
		let ran = load(
			&config(&dir),
			&[("news".to_owned(), Executed::Value(Value::Null))],
		)
		.unwrap();

		assert_eq!(first.value.to_json(), "{}");
		assert_eq!(first.errors, [("news".to_owned(), "timed out".to_owned())]);
		let deps = first.hashes.deps_of(Some(&reads));
		assert!(same.hashes.unchanged(&deps));
		assert!(!other.hashes.unchanged(&deps), "a different failure");
		assert!(!ran.hashes.unchanged(&deps), "it runs now");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_value_in_the_config_is_the_key_also_when_its_script_failed() {
		let dir = scratch("values_win");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		let json = format!(
			"{{\"dir\":{{\"input\":\"{dir}\",\"output\":\"{dir}/out\"}},\"data\":{{\"dir\":\"{dir}/data\",\"values\":{{\"news\":[1]}}}}}}"
		);
		let config = kd_config::parse(&json, &dir, None).unwrap();
		let failed = [("news".to_owned(), Executed::Failed("down".to_owned()))];

		let data = load(&config, &failed).unwrap();

		assert_eq!(data.value.to_json(), "{\"news\":[1]}");
		assert!(data.errors.is_empty(), "the page can read the value");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_type_declaration_is_not_a_data_file() {
		let dir = scratch("declaration");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		fs::write(format!("{dir}/data/types.d.ts"), "export {};").unwrap();
		fs::write(format!("{dir}/data/more.d.mts"), "export {};").unwrap();
		let given = [("news".to_owned(), Executed::Value(Value::Null))];

		let found = script_files(&config(&dir)).unwrap();
		let data = load(&config(&dir), &given).unwrap();

		assert_eq!(found.len(), 1);
		assert_eq!(data.value.to_json(), "{\"news\":null}");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn a_script_file_that_was_added_fails_its_readers_until_it_has_run() {
		let dir = scratch("pending");
		fs::write(format!("{dir}/data/news.ts"), "").unwrap();
		fs::write(format!("{dir}/data/old.ts"), "").unwrap();
		let given = [("old".to_owned(), Executed::Value(Value::Null))];

		let all = with_pending(&config(&dir), &given);
		let data = load(&config(&dir), &all).unwrap();

		assert_eq!(data.value.to_json(), "{\"old\":null}");
		assert_eq!(
			data.errors,
			[(
				"news".to_owned(),
				"the data file has not run yet".to_owned()
			)]
		);
		let _ = fs::remove_dir_all(&dir);
	}
}
