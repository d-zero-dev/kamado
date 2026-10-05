//! The two-step build as strings in and out, without any Node-API in sight:
//! `prepare` returns the render jobs and the context the templates need;
//! `finish` takes the HTML that JavaScript rendered. The state between the
//! two calls lives here, in a process-wide table keyed by a handle, because
//! the calls may come from different threads (the main thread and workers).

use std::collections::HashMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use kd_jsonc::Value;

static NEXT: AtomicU64 = AtomicU64::new(1);

struct Entry {
	prepared: kd_core::Prepared,
	loaded: kd_core::Loaded,
}

static STORE: Mutex<Option<HashMap<u64, Entry>>> = Mutex::new(None);

fn store() -> std::sync::MutexGuard<'static, Option<HashMap<u64, Entry>>> {
	STORE.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn options_from_json(json: &str) -> Result<kd_core::BuildOptions, String> {
	crate::build_options_from_json(json)
}

/// Plans a build. The result is a JSON object:
/// `{ "handle": "…", "jobs": [{ "page": 0, "main": "/abs.mjs" | null, "layout": … }], "context": {…} | null }`.
///
/// # Errors
///
/// Any error of the plan, as a message.
pub(crate) fn prepare(
	config_path: &str,
	options_json: &str,
	runtime: &str,
) -> Result<String, String> {
	let options = options_from_json(options_json)?;
	let loaded = kd_core::load(config_path)?;
	let prepared = kd_core::prepare(&loaded, &options, runtime)?;
	let jobs = Value::Array(
		prepared
			.jobs()
			.iter()
			.map(|j| {
				let opt = |s: &Option<String>| {
					s.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
				};
				Value::Object(vec![
					("page".to_owned(), Value::Number(j.page as f64)),
					("main".to_owned(), opt(&j.main)),
					("layout".to_owned(), opt(&j.layout)),
					("content".to_owned(), opt(&j.content)),
				])
			})
			.collect(),
	);
	let context = prepared.context_json().unwrap_or("null").to_owned();
	let handle = NEXT.fetch_add(1, Ordering::SeqCst);
	store()
		.get_or_insert_with(HashMap::new)
		.insert(handle, Entry { prepared, loaded });
	Ok(format!(
		"{{\"handle\":\"{handle}\",\"jobs\":{},\"context\":{context}}}",
		jobs.to_json()
	))
}

/// Finishes a build with the rendered pages (`[[page, "html"], …]`); the
/// report as JSON.
///
/// # Errors
///
/// An unknown handle, invalid input, or any error of the build.
pub(crate) fn finish(handle: &str, rendered_json: &str) -> Result<String, String> {
	let id: u64 = handle
		.parse()
		.map_err(|_| format!("finish: {handle:?} is not a handle"))?;
	let Some(entry) = store().as_mut().and_then(|s| s.remove(&id)) else {
		return Err(format!("finish: no prepared build for handle {handle}"));
	};
	let value = kd_jsonc::parse(rendered_json).map_err(|e| format!("rendered pages: {e}"))?;
	let Value::Array(items) = value else {
		return Err("rendered pages: expected an array".to_owned());
	};
	let mut rendered = Vec::with_capacity(items.len());
	for item in &items {
		let pair = item.as_array().filter(|a| a.len() == 2);
		let (page, html) = pair
			.and_then(|a| Some((a[0].as_f64()?, a[1].as_str()?)))
			.ok_or("rendered pages: each item must be [page, html]")?;
		rendered.push((page as usize, html.to_owned()));
	}
	let report = entry.prepared.finish(rendered)?;
	kd_core::write_report(&entry.loaded.config, &report)?;
	Ok(report.to_json())
}

/// Forgets a prepared build (the caller gave up on it).
pub(crate) fn abort(handle: &str) {
	if let Ok(id) = handle.parse::<u64>()
		&& let Some(s) = store().as_mut()
	{
		s.remove(&id);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	fn site(name: &str) -> String {
		let root = kd_site_free_normalize(&format!(
			"{}/kd_napi_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		));
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(format!("{root}/src")).unwrap();
		root
	}

	fn kd_site_free_normalize(path: &str) -> String {
		path.replace("//", "/")
	}

	#[test]
	fn a_jsx_site_is_prepared_rendered_elsewhere_and_finished() {
		let root = site("flow");
		fs::write(
			format!("{root}/src/index.tsx"),
			"export const meta = { title: 'T' };\nexport default () => <p>x</p>;\n",
		)
		.unwrap();
		fs::write(
			format!("{root}/kamado.config.jsonc"),
			r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache" } }"#,
		)
		.unwrap();
		let config = format!("{root}/kamado.config.jsonc");
		let prepared = prepare(&config, "{}", "file:///runtime.js").unwrap();
		let value = kd_jsonc::parse(&prepared).unwrap();
		let handle = value
			.get("handle")
			.and_then(|h| h.as_str())
			.unwrap()
			.to_owned();
		let jobs = value.get("jobs").and_then(|j| j.as_array()).unwrap();
		assert_eq!(jobs.len(), 1);
		assert_eq!(jobs[0].get("page").and_then(Value::as_f64), Some(0.0));
		assert!(
			jobs[0]
				.get("main")
				.and_then(|m| m.as_str())
				.unwrap()
				.ends_with("/src/index.tsx.mjs")
		);
		assert_eq!(jobs[0].get("layout"), Some(&Value::Null));
		assert!(value.get("context").and_then(|c| c.get("pages")).is_some());

		let report = finish(&handle, r#"[[0, "<p>x</p>"]]"#).unwrap();
		assert!(report.contains("\"status\":\"built\""));
		assert_eq!(
			fs::read_to_string(format!("{root}/out/index.html")).unwrap(),
			"<p>x</p>\n"
		);
		// A handle is used once.
		assert!(
			finish(&handle, "[]")
				.unwrap_err()
				.contains("no prepared build")
		);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn bad_input_is_reported_not_trusted() {
		assert!(finish("x", "[]").unwrap_err().contains("not a handle"));
		assert!(
			finish("999999", "[]")
				.unwrap_err()
				.contains("no prepared build")
		);
		abort("not a handle");
	}
}
