//! The dev server's engine as strings in and out (see `kd_core::serve`).
//! The server of a project lives in a process-wide table, keyed by a handle,
//! so that the JavaScript side can keep it across requests.
//!
//! Every answer is a JSON object with a `kind`:
//! `text` (`contentType`, `body`), `file` (`path`), `render` (`token`, `job`,
//! `restart`, `context`, `update`), `script` (`token`, `request`),
//! `forbidden` and `notFound`. A failure to build the answer is an error.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use kd_core::serve::{Serve, Served};
use kd_jsonc::Value;

static NEXT: AtomicU64 = AtomicU64::new(1);

static SERVERS: Mutex<Option<HashMap<u64, Arc<Serve>>>> = Mutex::new(None);

fn servers() -> std::sync::MutexGuard<'static, Option<HashMap<u64, Arc<Serve>>>> {
	SERVERS.lock().unwrap_or_else(|e| e.into_inner())
}

fn get(handle: &str) -> Result<Arc<Serve>, String> {
	let id: u64 = handle
		.parse()
		.map_err(|_| format!("{handle:?} is not a handle"))?;
	servers()
		.as_ref()
		.and_then(|s| s.get(&id).cloned())
		.ok_or_else(|| format!("no dev server for handle {handle}"))
}

fn opt(s: &Option<String>) -> Value {
	s.as_ref().map_or(Value::Null, |s| Value::String(s.clone()))
}

/// Opens the dev server of a project. The answer describes what the HTTP side
/// needs: `{ handle, devServer: { port, host, open, startPath, proxy },
/// inputDir, outputDir }`.
pub(crate) fn open(config_path: &str, options_json: &str, runtime: &str) -> Result<String, String> {
	let options = crate::build_options_from_json(options_json)?;
	let loaded = kd_core::load(config_path)?;
	let serve = Serve::open(loaded, options, runtime)?;
	let config = serve.config();
	let dev = &config.dev_server;
	let description = Value::Object(vec![
		("port".to_owned(), Value::Number(f64::from(dev.port))),
		("host".to_owned(), Value::String(dev.host.clone())),
		("open".to_owned(), Value::Bool(dev.open)),
		(
			"startPath".to_owned(),
			Value::String(dev.start_path.clone()),
		),
		("proxy".to_owned(), Value::Object(dev.proxy.clone())),
	]);
	let inputs = Value::Object(vec![
		("devServer".to_owned(), description),
		(
			"inputDir".to_owned(),
			Value::String(config.dir.input.clone()),
		),
		(
			"outputDir".to_owned(),
			Value::String(config.dir.output.clone()),
		),
		("siteName".to_owned(), opt(&config.site.site_name)),
	]);
	let handle = NEXT.fetch_add(1, Ordering::SeqCst);
	servers()
		.get_or_insert_with(HashMap::new)
		.insert(handle, Arc::new(serve));
	let Value::Object(mut members) = inputs else {
		unreachable!("an object was built above");
	};
	members.insert(0, ("handle".to_owned(), Value::String(handle.to_string())));
	Ok(Value::Object(members).to_json())
}

/// JSON of what a request turns into.
fn answer(served: Served) -> String {
	let s = |text: &str| Value::String(text.to_owned());
	let kind = |name: &str, mut rest: Vec<(String, Value)>| {
		rest.insert(0, ("kind".to_owned(), Value::String(name.to_owned())));
		Value::Object(rest).to_json()
	};
	match served {
		Served::Text { content_type, body } => kind(
			"text",
			vec![
				("contentType".to_owned(), s(content_type)),
				("body".to_owned(), Value::String(body)),
			],
		),
		Served::File { path } => kind("file", vec![("path".to_owned(), Value::String(path))]),
		Served::Forbidden => kind("forbidden", Vec::new()),
		Served::NotFound => kind("notFound", Vec::new()),
		Served::Render(r) => {
			// The context and the update are JSON already; they are embedded as
			// they are (no parse and print of a big document).
			let raw = |json: &Option<String>| json.as_deref().unwrap_or("null").to_owned();
			let job = Value::Object(vec![
				("page".to_owned(), Value::Number(r.job.page as f64)),
				("main".to_owned(), opt(&r.job.main)),
				("layout".to_owned(), opt(&r.job.layout)),
				("content".to_owned(), opt(&r.job.content)),
			])
			.to_json();
			format!(
				"{{\"kind\":\"render\",\"token\":\"{}\",\"job\":{job},\"restart\":{},\"context\":{},\"update\":{}}}",
				r.token,
				r.restart,
				raw(&r.context),
				raw(&r.update)
			)
		}
		Served::Script(w) => format!(
			"{{\"kind\":\"script\",\"token\":\"{}\",\"request\":{}}}",
			w.token, w.request
		),
	}
}

fn token(text: &str) -> Result<u64, String> {
	text.parse().map_err(|_| format!("{text:?} is not a token"))
}

/// Answers a request for a path; `renderer_started` is `"1"` while the caller
/// still has the renderer the last context was sent to.
pub(crate) fn request(
	handle: &str,
	url_path: &str,
	renderer_started: &str,
) -> Result<String, String> {
	get(handle)?
		.request_as(url_path, renderer_started == "1")
		.map(answer)
}

/// Takes the HTML JavaScript rendered for a `render` answer.
pub(crate) fn finish_render(handle: &str, tok: &str, html: &str) -> Result<String, String> {
	get(handle)?.finish_render(token(tok)?, html).map(answer)
}

/// Takes what esbuild built for a `script` answer:
/// `{ "code": "...", "inputs": ["..."] }`.
pub(crate) fn finish_script(handle: &str, tok: &str, output_json: &str) -> Result<String, String> {
	let value = kd_jsonc::parse(output_json).map_err(|e| format!("script output: {e}"))?;
	let output = (|| {
		let inputs = value
			.get("inputs")?
			.as_array()?
			.iter()
			.map(|v| v.as_str().map(str::to_owned))
			.collect::<Option<Vec<_>>>()?;
		Some(kd_core::ScriptOutput {
			id: 0,
			code: value.get("code")?.as_str()?.to_owned(),
			inputs,
		})
	})()
	.ok_or("script output: expected { code, inputs: [path, …] }")?;
	get(handle)?.finish_script(token(tok)?, output).map(answer)
}

/// Forgets the request behind a `render` or `script` answer that failed.
pub(crate) fn cancel(handle: &str, tok: &str) -> Result<(), String> {
	get(handle)?.cancel(token(tok)?);
	Ok(())
}

/// Forgets a dev server.
pub(crate) fn close(handle: &str) {
	if let Ok(id) = handle.parse::<u64>()
		&& let Some(s) = servers().as_mut()
	{
		s.remove(&id);
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	fn site(name: &str) -> String {
		let root = format!(
			"{}/kd_napi_serve_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		)
		.replace("//", "/");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(format!("{root}/src")).unwrap();
		fs::write(format!("{root}/src/index.html"), "<p>x</p>").unwrap();
		fs::write(
			format!("{root}/src/page.tsx"),
			"export default () => <p>t</p>;\n",
		)
		.unwrap();
		fs::write(
			format!("{root}/kamado.config.jsonc"),
			r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache" }, "devServer": { "port": 4000, "proxy": { "/api": { "target": "https://example.com" } } } }"#,
		)
		.unwrap();
		root
	}

	#[test]
	fn a_server_is_opened_asked_and_closed() {
		let root = site("flow");
		let opened = open(
			&format!("{root}/kamado.config.jsonc"),
			"{}",
			"file:///rt.js",
		)
		.unwrap();
		let value = kd_jsonc::parse(&opened).unwrap();
		let handle = value
			.get("handle")
			.and_then(|h| h.as_str())
			.unwrap()
			.to_owned();
		let dev = value.get("devServer").unwrap();
		assert_eq!(dev.get("port").and_then(Value::as_f64), Some(4000.0));
		assert_eq!(dev.get("host").and_then(|h| h.as_str()), Some("localhost"));
		assert!(dev.get("proxy").and_then(|p| p.get("/api")).is_some());

		let page = kd_jsonc::parse(&request(&handle, "/", "1").unwrap()).unwrap();
		assert_eq!(page.get("kind").and_then(|k| k.as_str()), Some("text"));
		assert_eq!(
			page.get("contentType").and_then(|k| k.as_str()),
			Some("text/html")
		);
		assert_eq!(
			page.get("body").and_then(|k| k.as_str()),
			Some("<p>x</p>\n")
		);

		let render = kd_jsonc::parse(&request(&handle, "/page.html", "1").unwrap()).unwrap();
		assert_eq!(render.get("kind").and_then(|k| k.as_str()), Some("render"));
		assert_eq!(render.get("restart"), Some(&Value::Bool(false)));
		assert!(render.get("context").and_then(|c| c.get("pages")).is_some());
		assert_eq!(render.get("update"), Some(&Value::Null));
		let token = render
			.get("token")
			.and_then(|t| t.as_str())
			.unwrap()
			.to_owned();
		let done = kd_jsonc::parse(&finish_render(&handle, &token, "<p>t</p>").unwrap()).unwrap();
		assert_eq!(
			done.get("body").and_then(|b| b.as_str()),
			Some("<p>t</p>\n")
		);

		let missing = kd_jsonc::parse(&request(&handle, "/none.png", "1").unwrap()).unwrap();
		assert_eq!(
			missing.get("kind").and_then(|k| k.as_str()),
			Some("notFound")
		);
		let forbidden = kd_jsonc::parse(&request(&handle, "/../x", "1").unwrap()).unwrap();
		assert_eq!(
			forbidden.get("kind").and_then(|k| k.as_str()),
			Some("forbidden")
		);

		close(&handle);
		assert!(
			request(&handle, "/", "1")
				.unwrap_err()
				.contains("no dev server")
		);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn bad_handles_tokens_and_outputs_are_reported() {
		assert!(request("x", "/", "1").unwrap_err().contains("not a handle"));
		assert!(
			request("999999", "/", "1")
				.unwrap_err()
				.contains("no dev server")
		);
		assert!(token("x").unwrap_err().contains("not a token"));
		close("not a handle");
		let root = site("bad");
		let opened = open(
			&format!("{root}/kamado.config.jsonc"),
			"{}",
			"file:///rt.js",
		)
		.unwrap();
		let handle = kd_jsonc::parse(&opened)
			.unwrap()
			.get("handle")
			.and_then(|h| h.as_str())
			.unwrap()
			.to_owned();
		assert!(
			finish_script(&handle, "1", "{}")
				.unwrap_err()
				.contains("expected { code")
		);
		assert!(
			finish_render(&handle, "7", "<p/>")
				.unwrap_err()
				.contains("no page is waiting")
		);
		let _ = fs::remove_dir_all(&root);
	}
}
