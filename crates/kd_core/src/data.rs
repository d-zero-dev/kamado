//! The `data` that templates receive: the files of `data.dir` (JSON, YAML,
//! and HTML / text read as strings), keyed by file name without extension,
//! with `data.values` on top. Static data only: v3 never runs a data file.

use std::fs;

use kd_config::Config;
use kd_jsonc::Value;

/// The merged data and its hash (part of the environment digest of every
/// page that is rendered by JavaScript: any change to the data rebuilds
/// them).
pub(crate) struct Data {
	pub value: Value,
	pub hash: String,
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

/// Reads the data directory (not recursively; files starting with `.` are
/// skipped) in name order.
///
/// # Errors
///
/// A message with the file name for an unreadable file, invalid JSON or
/// YAML, or two files with the same key.
pub(crate) fn load(config: &Config) -> Result<Data, String> {
	let mut members: Vec<(String, Value)> = Vec::new();
	if let Some(dir) = &config.data.dir {
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
		for name in files {
			let path = format!("{}/{name}", dir.trim_end_matches('/'));
			let (stem, ext) = match name.rfind('.') {
				Some(i) if i > 0 => (&name[..i], name[i..].to_ascii_lowercase()),
				_ => continue,
			};
			let read = || {
				fs::read_to_string(&path).map_err(|e| format!("cannot read data file {path}: {e}"))
			};
			let value = match ext.as_str() {
				".json" => kd_jsonc::parse(&read()?)
					.map_err(|e| format!("{path}:{}:{}: {}", e.line, e.column, e.message))?,
				".yml" | ".yaml" => kd_yaml::parse(&read()?).map_err(|e| format!("{path}: {e}"))?,
				".html" | ".htm" | ".txt" => Value::String(read()?),
				// Formats that look like data but are not read: said, not skipped, so
				// that `data.xxx` is not silently undefined in the templates.
				".jsonc" | ".json5" | ".toml" | ".csv" | ".js" | ".mjs" | ".cjs" | ".ts" => {
					return Err(format!(
						"{path}: {ext} files are not read as data (JSON, YAML, HTML and text are); \
						 convert it, or give `data.values` the value"
					));
				}
				_ => continue,
			};
			if members.iter().any(|(k, _)| k == stem) {
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
		}
	}
	let value = Value::Object(members);
	let hash = kd_hash::to_hex(&kd_hash::sha256(value.to_json().as_bytes()));
	Ok(Data { value, hash })
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

		let data = load(&config(&dir)).unwrap();

		assert_eq!(data.value.to_json(), "{\"linked\":{\"a\":1}}");
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn formats_that_are_not_read_as_data_are_an_error_not_a_silent_gap() {
		let dir = scratch("unsupported");
		fs::write(format!("{dir}/data/site.jsonc"), "{}").unwrap();

		let message = load(&config(&dir)).err().unwrap();

		assert!(
			message.contains("site.jsonc: .jsonc files are not read as data"),
			"{message}"
		);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn other_files_in_the_directory_are_left_alone() {
		let dir = scratch("other");
		fs::write(format!("{dir}/data/README.md"), "notes").unwrap();
		fs::write(format!("{dir}/data/.hidden.json"), "{").unwrap();
		fs::write(format!("{dir}/data/t.txt"), "text").unwrap();

		let data = load(&config(&dir)).unwrap();

		assert_eq!(data.value.to_json(), "{\"t\":\"text\"}");
		let _ = fs::remove_dir_all(&dir);
	}
}
