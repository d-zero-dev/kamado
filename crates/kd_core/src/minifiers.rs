//! The code minifiers of the HTML stage: the contents of `<script>`
//! elements and event handler attributes go to esbuild, which runs as a child
//! process of its own binary (never through JavaScript: the pages are
//! processed on pool threads and must not wait for a JS thread).
//!
//! Why a cache: a snippet that sits in every page (an analytics tag) is
//! minified once. The memo serves the build in progress; the files under the
//! cache directory serve the next one. The key holds the esbuild version, so
//! a different esbuild never reuses the output of another.
//!
//! A snippet esbuild cannot parse is left as it was, which is what
//! html-minifier-terser does when terser fails.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use kd_html::minify::{CssKind, Hooks};

/// What wraps an event handler so that `return` is legal in it.
const HANDLER_OPEN: &str = "function f(){";

/// The minifiers; share one between the pool threads.
pub struct Minifiers {
	esbuild: Option<String>,
	version: String,
	cache_dir: Option<String>,
	memo: Mutex<HashMap<String, String>>,
}

impl Minifiers {
	/// `esbuild` is the path of the esbuild binary; without one the code is
	/// left alone. `cache_dir` is where results are kept between builds.
	#[must_use]
	pub fn new(esbuild: Option<String>, version: &str, cache_dir: Option<String>) -> Minifiers {
		Minifiers {
			esbuild,
			version: version.to_owned(),
			cache_dir,
			memo: Mutex::new(HashMap::new()),
		}
	}

	fn key(&self, kind: &str, text: &str) -> String {
		let mut input = format!("{}\0{kind}\0", self.version).into_bytes();
		input.extend_from_slice(text.as_bytes());
		kd_hash::to_hex(&kd_hash::sha256(&input))
	}

	/// The minified form of `text`, from the memo, the disk cache or esbuild.
	fn cached(&self, kind: &str, text: &str, compute: impl FnOnce(&str) -> String) -> String {
		let key = self.key(kind, text);
		if let Some(hit) = self
			.memo
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.get(&key)
		{
			return hit.clone();
		}
		let file = self
			.cache_dir
			.as_ref()
			.map(|dir| format!("{dir}/minify/{key}"));
		let result = match file.as_ref().and_then(|f| fs::read_to_string(f).ok()) {
			Some(stored) => stored,
			None => {
				let result = compute(text);
				if let Some(file) = &file {
					store(file, &result);
				}
				result
			}
		};
		self.memo
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.insert(key, result.clone());
		result
	}
}

/// Writes through a temporary file so that a reader never sees half of it.
/// A cache that cannot be written is not an error: the next build computes
/// the result again.
fn store(file: &str, content: &str) {
	let Some(parent) = std::path::Path::new(file).parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_err() {
		return;
	}
	let temp = format!(
		"{file}.{}.{:?}.tmp",
		std::process::id(),
		std::thread::current().id()
	);
	if fs::write(&temp, content).is_ok() && fs::rename(&temp, file).is_err() {
		let _ = fs::remove_file(&temp);
	}
}

/// Minifies a script with `esbuild`. `None` when it cannot be run or rejects
/// the code.
fn run_esbuild(binary: &str, code: &str) -> Option<String> {
	let mut child = Command::new(binary)
		.args([
			"--minify",
			"--charset=utf8",
			"--loader=js",
			"--log-level=error",
		])
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.ok()?;
	let mut stdin = child.stdin.take()?;
	// Writing on its own thread: a script bigger than the pipe would block
	// both sides otherwise.
	let input = code.to_owned();
	let writer = std::thread::spawn(move || {
		let _ = stdin.write_all(input.as_bytes());
	});
	let output = child.wait_with_output().ok()?;
	let _ = writer.join();
	if !output.status.success() {
		return None;
	}
	String::from_utf8(output.stdout).ok()
}

impl Minifiers {
	fn minify_block(&self, binary: &str, text: &str) -> String {
		match run_esbuild(binary, text) {
			Some(out) => out.trim_end_matches('\n').to_owned(),
			None => text.to_owned(),
		}
	}

	fn minify_handler(&self, binary: &str, text: &str) -> String {
		// A handler is the body of a function: `return false;` is legal there.
		let wrapped = format!("{HANDLER_OPEN}{text}\n}}");
		let Some(out) = run_esbuild(binary, &wrapped) else {
			return text.to_owned();
		};
		let out = out.trim_end_matches('\n');
		match out
			.strip_prefix(HANDLER_OPEN)
			.and_then(|rest| rest.strip_suffix('}'))
		{
			Some(body) => body.trim_end_matches(';').to_owned(),
			None => text.to_owned(),
		}
	}
}

impl Hooks for Minifiers {
	fn css(&self, text: &str, _kind: CssKind) -> String {
		text.to_owned()
	}

	fn js(&self, text: &str, inline: bool) -> String {
		let Some(binary) = &self.esbuild else {
			return text.to_owned();
		};
		if text.trim().is_empty() {
			return text.to_owned();
		}
		if inline {
			self.cached("handler", text, |t| self.minify_handler(binary, t))
		} else {
			self.cached("block", text, |t| self.minify_block(binary, t))
		}
	}
}

/// The esbuild binary of this checkout's `node_modules`, for tests.
#[cfg(test)]
pub(crate) fn esbuild_for_tests() -> String {
	let dir = format!("{}/../../node_modules/@esbuild", env!("CARGO_MANIFEST_DIR"));
	let platform = fs::read_dir(&dir)
		.unwrap_or_else(|e| panic!("{dir}: {e}; run `yarn install`"))
		.next()
		.expect("a platform package of esbuild")
		.unwrap()
		.path();
	format!("{}/bin/esbuild", platform.display())
}

#[cfg(test)]
mod tests {
	use super::esbuild_for_tests as esbuild;
	use super::*;

	fn temp(name: &str) -> String {
		let dir = format!(
			"{}/kd_minifiers_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		)
		.replace("//", "/");
		let _ = fs::remove_dir_all(&dir);
		dir
	}

	#[test]
	fn a_script_is_minified_and_a_syntax_error_leaves_it_alone() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(
			m.js(
				"// c\nwindow.a = window.a || [];\nfunction g() { a.push(arguments); }\ng('x');\n",
				false
			),
			"window.a=window.a||[];function g(){a.push(arguments)}g(\"x\");"
		);
		assert_eq!(m.js("var = ;", false), "var = ;");
		assert_eq!(m.js("  \n ", false), "  \n ");
	}

	#[test]
	fn an_event_handler_may_return() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(
			m.js("if (confirm('ok')) { go(); } return false;", true),
			"return confirm(\"ok\")&&go(),!1"
		);
		assert_eq!(m.js("go( 1 );", true), "go(1)");
		assert_eq!(m.js("go(", true), "go(");
	}

	#[test]
	fn without_a_binary_the_code_is_left_alone() {
		let m = Minifiers::new(None, "t", None);
		assert_eq!(m.js("a  =  1;", false), "a  =  1;");
		assert_eq!(m.css("a  { }", CssKind::Block), "a  { }");
	}

	#[test]
	fn results_are_kept_between_builds_and_by_version() {
		let dir = temp("cache");
		let first = Minifiers::new(Some(esbuild()), "1", Some(dir.clone()));
		assert_eq!(first.js("a  =  1;", false), "a=1;");
		let stored: Vec<_> = fs::read_dir(format!("{dir}/minify")).unwrap().collect();
		assert_eq!(stored.len(), 1);

		// A second instance with no binary can only answer from the cache.
		let second = Minifiers::new(None, "1", Some(dir.clone()));
		assert_eq!(
			second.js("a  =  1;", false),
			"a  =  1;",
			"no binary: not minified"
		);
		let with_cache = Minifiers {
			esbuild: Some("/nonexistent/esbuild".to_owned()),
			..Minifiers::new(None, "1", Some(dir.clone()))
		};
		assert_eq!(
			with_cache.js("a  =  1;", false),
			"a=1;",
			"served from the cache"
		);
		// Another version does not reuse it.
		let other = Minifiers {
			esbuild: Some("/nonexistent/esbuild".to_owned()),
			..Minifiers::new(None, "2", Some(dir.clone()))
		};
		assert_eq!(other.js("a  =  1;", false), "a  =  1;");
		let _ = fs::remove_dir_all(&dir);
	}
}
