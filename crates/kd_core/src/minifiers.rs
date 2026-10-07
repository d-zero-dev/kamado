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
	///
	/// `compute` also says whether its answer is final. The code that esbuild
	/// rejects is final: it stays as written for ever. A failure to run esbuild
	/// (no process to spawn, a crash) is not, and is only remembered by this
	/// process: stored, it would keep a snippet unminified in every later build.
	fn cached(
		&self,
		kind: &str,
		text: &str,
		compute: impl FnOnce(&str) -> (String, bool),
	) -> String {
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
				let (result, final_answer) = compute(text);
				if let (Some(file), true) = (&file, final_answer) {
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

/// What running esbuild on a piece of code came to.
enum Run {
	Minified(String),
	/// esbuild ran and refused the code.
	Rejected,
	/// esbuild did not run to the end (spawn failure, a broken pipe).
	Failed,
}

/// Minifies a script with `esbuild`.
fn run_esbuild(binary: &str, code: &str) -> Run {
	run_esbuild_inner(binary, code).unwrap_or(Run::Failed)
}

fn run_esbuild_inner(binary: &str, code: &str) -> Option<Run> {
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
		return Some(Run::Rejected);
	}
	String::from_utf8(output.stdout).ok().map(Run::Minified)
}

impl Minifiers {
	fn minify_block(&self, binary: &str, text: &str) -> (String, bool) {
		match run_esbuild(binary, text) {
			Run::Minified(out) => (out.trim_end_matches('\n').to_owned(), true),
			Run::Rejected => (text.to_owned(), true),
			Run::Failed => (text.to_owned(), false),
		}
	}

	fn minify_handler(&self, binary: &str, text: &str) -> (String, bool) {
		// A handler is the body of a function: `return false;` is legal there.
		let wrapped = format!("{HANDLER_OPEN}{text}\n}}");
		let out = match run_esbuild(binary, &wrapped) {
			Run::Minified(out) => out,
			Run::Rejected => return (text.to_owned(), true),
			Run::Failed => return (text.to_owned(), false),
		};
		let out = out.trim_end_matches('\n');
		match out
			.strip_prefix(HANDLER_OPEN)
			.and_then(|rest| rest.strip_suffix('}'))
		{
			Some(body) => (without_last_semicolon(body), true),
			None => (text.to_owned(), true),
		}
	}
}

/// Drops the `;` that ends the last statement (an attribute value does not
/// need it), unless it is the statement: the body of `for(;next(););`,
/// `if(x);` or `else;` is an empty statement, and without it the code does not
/// parse. When in doubt the `;` stays; it only costs a byte.
fn without_last_semicolon(body: &str) -> String {
	let Some(stripped) = body.strip_suffix(';') else {
		return body.to_owned();
	};
	if ends_with_empty_statement_header(stripped) {
		return body.to_owned();
	}
	stripped.to_owned()
}

/// Whether `code` ends with a header that needs a statement after it.
fn ends_with_empty_statement_header(code: &str) -> bool {
	if code.ends_with(':') || code.ends_with("else") || code.ends_with("do") {
		return true;
	}
	if !code.ends_with(')') {
		return false;
	}
	// The `(` that matches the final `)`, found going forward so that quotes can
	// be skipped: a parenthesis in a string does not count.
	let mut open: Vec<usize> = Vec::new();
	let mut quote: Option<char> = None;
	let mut escaped = false;
	for (at, c) in code.char_indices() {
		if let Some(q) = quote {
			if escaped {
				escaped = false;
			} else if c == '\\' {
				escaped = true;
			} else if c == q {
				quote = None;
			}
			continue;
		}
		match c {
			'"' | '\'' | '`' => quote = Some(c),
			'(' => open.push(at),
			')' => {
				let Some(start) = open.pop() else {
					return true;
				};
				if at + 1 == code.len() && open.is_empty() {
					let before = code[..start].trim_end();
					let word_start = before
						.rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '$'))
						.map_or(0, |i| i + 1);
					return matches!(&before[word_start..], "for" | "if" | "while" | "with");
				}
			}
			_ => {}
		}
	}
	// Not balanced: not worth a guess.
	true
}

impl Hooks for Minifiers {
	fn css(&self, text: &str, kind: CssKind) -> String {
		// CSS that cannot be minified is left as it was.
		match kind {
			CssKind::Block => kd_css::minify(text),
			CssKind::Inline => kd_css::minify_declarations(text),
			CssKind::Media => {
				// `all` is no condition in an `@media` rule, but an attribute value of
				// nothing at all reads as a mistake and v2 keeps it.
				let minified = kd_css::minify_media_query(text);
				return if minified.is_empty() && !text.trim().is_empty() {
					"all".to_owned()
				} else {
					minified
				};
			}
		}
		.unwrap_or_else(|_| text.to_owned())
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
	// The package of this machine: several can be installed side by side.
	let os = match std::env::consts::OS {
		"macos" => "darwin",
		other => other,
	};
	let arch = match std::env::consts::ARCH {
		"aarch64" => "arm64",
		"x86_64" => "x64",
		other => other,
	};
	let platform = format!("{dir}/{os}-{arch}");
	assert!(
		fs::metadata(&platform).is_ok(),
		"{platform} is missing; run `yarn install`"
	);
	format!("{platform}/bin/esbuild")
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
	fn the_semicolon_of_an_empty_statement_stays_in_a_handler() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(m.js("while(next());", true), "for(;next(););");
		assert_eq!(m.js("if (a) ; else b()", true), "a||b()");
		assert_eq!(without_last_semicolon("a();b();"), "a();b()");
		assert_eq!(without_last_semicolon("for(;n(););"), "for(;n(););");
		assert_eq!(without_last_semicolon("if(a);"), "if(a);");
		assert_eq!(without_last_semicolon("x(\")\");"), "x(\")\")");
	}

	#[test]
	fn code_that_esbuild_could_not_be_asked_about_is_not_remembered() {
		let dir = temp("failed");
		let missing = Minifiers::new(
			Some("/nonexistent/esbuild".to_owned()),
			"1",
			Some(dir.clone()),
		);
		assert_eq!(missing.js("a  =  1;", false), "a  =  1;");
		assert!(
			fs::read_dir(format!("{dir}/minify"))
				.is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
				|| fs::read_dir(format!("{dir}/minify"))
					.unwrap()
					.next()
					.is_none(),
			"a failure to run esbuild is not stored"
		);

		// What esbuild refuses is final.
		let real = Minifiers::new(Some(esbuild()), "1", Some(dir.clone()));
		assert_eq!(real.js("var = ;", false), "var = ;");
		assert_eq!(fs::read_dir(format!("{dir}/minify")).unwrap().count(), 1);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn without_a_binary_the_scripts_are_left_alone() {
		let m = Minifiers::new(None, "t", None);
		assert_eq!(m.js("a  =  1;", false), "a  =  1;");
	}

	#[test]
	fn styles_are_minified_by_kd_css_in_all_three_places() {
		let m = Minifiers::new(None, "t", None);
		assert_eq!(
			m.css("a  { color : white }", CssKind::Block),
			"a{color:#fff}"
		);
		assert_eq!(
			m.css("color : white ;  margin : 0px", CssKind::Inline),
			"color:#fff;margin:0"
		);
		assert_eq!(m.css("all", CssKind::Media), "all");
		assert_eq!(
			m.css("screen  and (min-width : 100px)", CssKind::Media),
			"screen and (min-width:100px)"
		);
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
