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
	/// HTML handed over with `feed`, until `finish`.
	rendered: Vec<(usize, String)>,
}

static STORE: Mutex<Option<HashMap<u64, Entry>>> = Mutex::new(None);

fn store() -> std::sync::MutexGuard<'static, Option<HashMap<u64, Entry>>> {
	STORE.lock().unwrap_or_else(|e| e.into_inner())
}

pub(crate) fn options_from_json(json: &str) -> Result<kd_core::BuildOptions, String> {
	crate::build_options_from_json(json)
}

/// Plans a build. The result is a JSON object:
/// `{ "handle": "…", "jobs": [{ "page": 0, "main": "/abs.mjs" | null, "layout": … }], "context": {…} | null, "scripts": {…} | null }`
/// (`scripts` is the request for esbuild).
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
					(
						"entry".to_owned(),
						j.entry.map_or(Value::Null, |n| Value::Number(n as f64)),
					),
					("layout".to_owned(), opt(&j.layout)),
					("content".to_owned(), opt(&j.content)),
				])
			})
			.collect(),
	);
	let context = prepared.context_json().unwrap_or("null").to_owned();
	let scripts = prepared.script_request_json().unwrap_or("null").to_owned();
	let handle = NEXT.fetch_add(1, Ordering::SeqCst);
	store().get_or_insert_with(HashMap::new).insert(
		handle,
		Entry {
			prepared,
			loaded,
			rendered: Vec::new(),
		},
	);
	Ok(format!(
		"{{\"handle\":\"{handle}\",\"jobs\":{},\"context\":{context},\"scripts\":{scripts}}}",
		jobs.to_json()
	))
}

/// Takes HTML that JavaScript rendered: frames of a little-endian `u32` page
/// index, a `u32` byte length and that many bytes of UTF-8.
///
/// # Errors
///
/// An unknown handle, a frame that is cut short, or text that is not UTF-8.
pub(crate) fn feed(handle: &str, mut bytes: &[u8]) -> Result<(), String> {
	let id: u64 = handle
		.parse()
		.map_err(|_| format!("feed: {handle:?} is not a handle"))?;
	// Decoded before the table is locked: the work is the copying.
	let mut pages = Vec::new();
	while !bytes.is_empty() {
		let (head, rest) = bytes
			.split_first_chunk::<8>()
			.ok_or("feed: a frame is cut short")?;
		let page = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
		let len = u32::from_le_bytes([head[4], head[5], head[6], head[7]]) as usize;
		if rest.len() < len {
			return Err("feed: a frame is cut short".to_owned());
		}
		let (text, rest) = rest.split_at(len);
		let html = String::from_utf8(text.to_vec()).map_err(|_| "feed: page is not UTF-8")?;
		pages.push((page, html));
		bytes = rest;
	}
	let mut store = store();
	let Some(entry) = store.as_mut().and_then(|s| s.get_mut(&id)) else {
		return Err(format!("feed: no prepared build for handle {handle}"));
	};
	entry.rendered.extend(pages);
	Ok(())
}

/// Finishes a build with what JavaScript made, as JSON:
/// `{ "pages": [[page, "html"], …], "scripts": [{ "id", "code", "inputs": […] }, …] }`.
/// The result is the report as JSON.
///
/// # Errors
///
/// An unknown handle, invalid input, or any error of the build.
pub(crate) fn finish(handle: &str, results_json: &str) -> Result<String, String> {
	let id: u64 = handle
		.parse()
		.map_err(|_| format!("finish: {handle:?} is not a handle"))?;
	let Some(mut entry) = store().as_mut().and_then(|s| s.remove(&id)) else {
		return Err(format!("finish: no prepared build for handle {handle}"));
	};
	let value = kd_jsonc::parse(results_json).map_err(|e| format!("results: {e}"))?;
	let items = match value.get("pages") {
		None => &[][..],
		Some(Value::Array(items)) => items.as_slice(),
		Some(_) => return Err("results: pages must be an array".to_owned()),
	};
	// What `feed` took, then what the JSON carries.
	let mut rendered = std::mem::take(&mut entry.rendered);
	rendered.reserve(items.len());
	for item in items {
		let pair = item.as_array().filter(|a| a.len() == 2);
		let (page, html) = pair
			.and_then(|a| Some((a[0].as_f64()?, a[1].as_str()?)))
			// `as usize` would turn a negative number or NaN into page 0.
			.filter(|(page, _)| page.fract() == 0.0 && *page >= 0.0)
			.ok_or("results: each page must be [page, html] with a page number")?;
		rendered.push((page as usize, html.to_owned()));
	}
	let script_items = match value.get("scripts") {
		None => &[][..],
		Some(Value::Array(items)) => items.as_slice(),
		Some(_) => return Err("results: scripts must be an array".to_owned()),
	};
	let mut scripts = Vec::with_capacity(script_items.len());
	for item in script_items {
		let parsed = (|| {
			let inputs = item
				.get("inputs")?
				.as_array()?
				.iter()
				.map(|v| v.as_str().map(str::to_owned))
				.collect::<Option<Vec<_>>>()?;
			Some(kd_core::ScriptOutput {
				id: item.get("id")?.as_f64()? as usize,
				code: item.get("code")?.as_str()?.to_owned(),
				inputs,
			})
		})();
		scripts.push(parsed.ok_or("results: each script must be { id, code, inputs: [path, …] }")?);
	}
	let report = entry.prepared.finish(rendered, scripts)?;
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
		// The page is the first function of a chunk file.
		assert!(
			jobs[0]
				.get("main")
				.and_then(|m| m.as_str())
				.unwrap()
				.contains("/__chunks__/")
		);
		assert_eq!(jobs[0].get("entry").and_then(Value::as_f64), Some(0.0));
		assert_eq!(jobs[0].get("layout"), Some(&Value::Null));
		assert!(value.get("context").and_then(|c| c.get("pages")).is_some());

		let report = finish(&handle, r#"{"pages":[[0,"<p>x</p>"]]}"#).unwrap();
		assert!(report.contains("\"status\":\"built\""));
		assert_eq!(
			fs::read_to_string(format!("{root}/out/index.html")).unwrap(),
			"<p>x</p>\n"
		);
		// A handle is used once.
		assert!(
			finish(&handle, "{}")
				.unwrap_err()
				.contains("no prepared build")
		);
		let _ = fs::remove_dir_all(&root);
	}

	fn frame(page: u32, html: &str) -> Vec<u8> {
		let mut out = page.to_le_bytes().to_vec();
		out.extend_from_slice(&(html.len() as u32).to_le_bytes());
		out.extend_from_slice(html.as_bytes());
		out
	}

	#[test]
	fn html_fed_in_frames_is_what_finish_writes() {
		let root = site("feed");
		fs::write(
			format!("{root}/src/a.tsx"),
			"export default () => <p>a</p>;\n",
		)
		.unwrap();
		fs::write(
			format!("{root}/src/b.tsx"),
			"export default () => <p>b</p>;\n",
		)
		.unwrap();
		fs::write(
			format!("{root}/kamado.config.jsonc"),
			r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache" } }"#,
		)
		.unwrap();
		let prepared = prepare(
			&format!("{root}/kamado.config.jsonc"),
			"{}",
			"file:///runtime.js",
		)
		.unwrap();
		let handle = kd_jsonc::parse(&prepared)
			.unwrap()
			.get("handle")
			.and_then(|h| h.as_str())
			.unwrap()
			.to_owned();

		// Two calls, as two workers would make them; the text is not ASCII.
		feed(&handle, &frame(1, "<p>b é</p>")).unwrap();
		feed(&handle, &frame(0, "<p>a</p>")).unwrap();

		let report = finish(&handle, r#"{"scripts":[]}"#).unwrap();
		assert!(report.contains("\"status\":\"built\""));
		assert_eq!(
			fs::read_to_string(format!("{root}/out/a.html")).unwrap(),
			"<p>a</p>\n"
		);
		assert_eq!(
			fs::read_to_string(format!("{root}/out/b.html")).unwrap(),
			"<p>b é</p>\n"
		);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn frames_that_are_cut_short_or_not_text_are_refused() {
		assert!(feed("x", &[]).unwrap_err().contains("not a handle"));
		assert!(
			feed("999999", &frame(0, "x"))
				.unwrap_err()
				.contains("no prepared build")
		);
		let mut cut = frame(0, "abc");
		cut.truncate(10);
		assert!(feed("999999", &cut).unwrap_err().contains("cut short"));
		assert!(
			feed("999999", &[1, 0, 0])
				.unwrap_err()
				.contains("cut short")
		);
		let mut bad = frame(0, "ab");
		let last = bad.len() - 1;
		bad[last] = 0xff;
		assert!(feed("999999", &bad).unwrap_err().contains("not UTF-8"));
	}

	#[test]
	fn bad_input_is_reported_not_trusted() {
		assert!(finish("x", "{}").unwrap_err().contains("not a handle"));
		assert!(
			finish("999999", "{}")
				.unwrap_err()
				.contains("no prepared build")
		);
		abort("not a handle");
	}
}
