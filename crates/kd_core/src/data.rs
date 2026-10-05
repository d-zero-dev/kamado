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
			let meta = e.metadata().ok()?;
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
		let mut files: Vec<String> = fs::read_dir(dir)
			.map_err(|e| format!("cannot read data.dir {dir}: {e}"))?
			.filter_map(Result::ok)
			.filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
			.filter_map(|e| e.file_name().into_string().ok())
			.filter(|name| !name.starts_with('.'))
			.collect();
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
