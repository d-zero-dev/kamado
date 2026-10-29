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
//! html-minifier-terser does when terser fails, and the hook says why
//! (`html.onError` decides what the page does with it). The refusal is cached
//! as a refusal, so that the next build reports it too.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::Mutex;

use kd_html::minify::{CssKind, Hooks};

/// What wraps an event handler so that `return` is legal in it.
const HANDLER_OPEN: &str = "function f(){";

/// The form of the cache files, in the key: a cache written when a refusal
/// was stored as the text itself is not read as a success.
const CACHE_FORMAT: &str = "2";

/// What a minification came to: the minified text, or why there is none.
type Answer = Result<String, String>;

/// The minifiers; share one between the pool threads.
pub struct Minifiers {
	esbuild: Option<String>,
	version: String,
	cache_dir: Option<String>,
	memo: Mutex<HashMap<String, Answer>>,
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
		let mut input = format!("{CACHE_FORMAT}\0{}\0{kind}\0", self.version).into_bytes();
		input.extend_from_slice(text.as_bytes());
		kd_hash::to_hex(&kd_hash::sha256(&input))
	}

	/// The minified form of `text`, or why there is none, from the memo, the
	/// disk cache or esbuild.
	///
	/// `compute` also says whether its answer is final. The code that esbuild
	/// rejects is final: it stays as written for ever, and is stored as a
	/// refusal (`<key>.rejected`, holding the reason). A failure to run esbuild
	/// (no process to spawn, a crash) is not, and is not remembered at all:
	/// stored, it would keep a snippet unminified (and reported) in every later
	/// build, or for the rest of a dev server's life, after esbuild runs again.
	fn cached(
		&self,
		kind: &str,
		text: &str,
		compute: impl FnOnce(&str) -> (Answer, bool),
	) -> Answer {
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
		let stored = file.as_ref().and_then(|f| {
			fs::read_to_string(f)
				.map(Ok)
				.ok()
				.or_else(|| fs::read_to_string(format!("{f}.rejected")).map(Err).ok())
		});
		let result = match stored {
			Some(stored) => stored,
			None => {
				let (result, final_answer) = compute(text);
				if !final_answer {
					return result;
				}
				if let Some(file) = &file {
					match &result {
						Ok(minified) => store(file, minified),
						Err(why) => store(&format!("{file}.rejected"), why),
					}
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
	/// esbuild ran and refused the code, with the first line of its error.
	Rejected(String),
	/// esbuild did not run to the end (spawn failure, a broken pipe).
	Failed(String),
}

/// Minifies a script with `esbuild`.
fn run_esbuild(binary: &str, code: &str) -> Run {
	let mut child = match Command::new(binary)
		.args([
			"--minify",
			"--charset=utf8",
			"--loader=js",
			"--log-level=error",
			"--color=false",
		])
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.stderr(Stdio::piped())
		.spawn()
	{
		Ok(child) => child,
		Err(e) => return Run::Failed(format!("cannot start {binary}: {e}")),
	};
	let Some(mut stdin) = child.stdin.take() else {
		return Run::Failed("no input pipe to esbuild".to_owned());
	};
	// Writing on its own thread: a script bigger than the pipe would block
	// both sides otherwise.
	let input = code.to_owned();
	let writer = std::thread::spawn(move || {
		let _ = stdin.write_all(input.as_bytes());
	});
	let output = match child.wait_with_output() {
		Ok(output) => output,
		Err(e) => return Run::Failed(format!("esbuild did not finish: {e}")),
	};
	let _ = writer.join();
	if !output.status.success() {
		// A refusal is an exit with an `[ERROR]` line (`✘ [ERROR] …`, or `X [ERROR] …`
		// on a Windows console); anything else (a signal, a crash with no message)
		// is esbuild failing, not the code.
		let stderr = String::from_utf8_lossy(&output.stderr);
		let error = stderr.lines().find_map(|line| {
			line.split_once("[ERROR] ")
				.map(|(_, message)| message.trim())
		});
		return match (output.status.code(), error) {
			(Some(_), Some(message)) => Run::Rejected(format!("esbuild cannot read it: {message}")),
			_ => Run::Failed(format!("esbuild stopped ({})", output.status)),
		};
	}
	match String::from_utf8(output.stdout) {
		Ok(out) => Run::Minified(out),
		Err(_) => Run::Failed("esbuild wrote what is not UTF-8".to_owned()),
	}
}

impl Minifiers {
	fn minify_block(&self, binary: &str, text: &str) -> (Answer, bool) {
		match run_esbuild(binary, text) {
			Run::Minified(out) => (Ok(out.trim_end_matches('\n').to_owned()), true),
			Run::Rejected(why) => (Err(why), true),
			Run::Failed(why) => (Err(why), false),
		}
	}

	fn minify_handler(&self, binary: &str, text: &str) -> (Answer, bool) {
		// A handler is the body of a function: `return false;` is legal there.
		let wrapped = format!("{HANDLER_OPEN}{text}\n}}");
		let out = match run_esbuild(binary, &wrapped) {
			Run::Minified(out) => out,
			Run::Rejected(why) => return (Err(why), true),
			Run::Failed(why) => return (Err(why), false),
		};
		let out = out.trim_end_matches('\n');
		match out
			.strip_prefix(HANDLER_OPEN)
			.and_then(|rest| rest.strip_suffix('}'))
		{
			Some(body) => (Ok(without_last_semicolon(body)), true),
			// esbuild changed the wrapper it was given: the handler is kept, and
			// this is not the page's fault.
			None => (Ok(text.to_owned()), true),
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
	fn css(&self, text: &str, kind: CssKind) -> Answer {
		match kind {
			CssKind::Block => kd_css::minify(text),
			CssKind::Inline => kd_css::minify_declarations(text),
			CssKind::Media => {
				// `all` is no condition in an `@media` rule, but an attribute value of
				// nothing at all reads as a mistake and v2 keeps it.
				let minified = kd_css::minify_media_query(text);
				return Ok(if minified.is_empty() && !text.trim().is_empty() {
					"all".to_owned()
				} else {
					minified
				});
			}
		}
		.map_err(|e| e.to_string())
	}

	fn js(&self, text: &str, inline: bool) -> Answer {
		// Without a binary nothing is minified; the build says so once (not
		// for every snippet).
		let Some(binary) = &self.esbuild else {
			return Ok(text.to_owned());
		};
		if text.trim().is_empty() {
			return Ok(text.to_owned());
		}
		if inline {
			self.cached("handler", text, |t| self.minify_handler(binary, t))
		} else {
			self.cached("block", text, |t| self.minify_block(binary, t))
		}
	}
}

/// The esbuild binary of this checkout's `node_modules`, for tests: the one
/// the `esbuild` package depends on, found by Node from that package the way
/// `findEsbuildBinary` of the runtime does. Another esbuild (the oracle
/// `esbuild-v2`) can own the platform package at the top of `node_modules`, so
/// the place of the right one is up to the install, not to this code.
#[cfg(test)]
pub(crate) fn esbuild_for_tests() -> String {
	let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
	let found = Command::new("node")
		.current_dir(&root)
		.args([
			"--eval",
			"const { createRequire } = require('node:module'); \
			 const fromEsbuild = createRequire(require.resolve('esbuild')); \
			 console.log(fromEsbuild.resolve(\
			 `@esbuild/${process.platform}-${process.arch}/bin/esbuild`));",
		])
		.output()
		.expect("node starts; the tests that run esbuild need it");
	assert!(
		found.status.success(),
		"esbuild is not installed for this machine; run `yarn install`: {}",
		String::from_utf8_lossy(&found.stderr)
	);
	String::from_utf8(found.stdout)
		.expect("a path is UTF-8")
		.trim()
		.to_owned()
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

	const REFUSED: &str = "esbuild cannot read it: Expected identifier but found \"=\"";

	/// The oracle of the JSX tables is another esbuild (`esbuild-v2`), which
	/// the install may hoist to the top of `node_modules`; the binary of the
	/// tests has to be the one of the `esbuild` package, as the runtime's is.
	#[test]
	fn the_esbuild_of_the_tests_is_the_version_of_the_esbuild_package() {
		let ran = Command::new(esbuild())
			.arg("--version")
			.output()
			.expect("the esbuild binary starts");
		let ran = String::from_utf8(ran.stdout).expect("a version is UTF-8");
		let manifest = fs::read_to_string(format!(
			"{}/../../node_modules/esbuild/package.json",
			env!("CARGO_MANIFEST_DIR")
		))
		.expect("node_modules/esbuild is installed; run `yarn install`");
		let key = "\"version\": \"";
		let start = manifest.find(key).expect("package.json has a version") + key.len();
		let end = manifest[start..].find('"').expect("the version is closed");
		let declared = &manifest[start..start + end];
		assert_eq!(
			ran.trim(),
			declared,
			"the binary is not the esbuild package's"
		);
	}

	fn ok(text: &str) -> Answer {
		Ok(text.to_owned())
	}

	#[test]
	fn a_script_is_minified_and_a_syntax_error_says_why() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(
			m.js(
				"// c\nwindow.a = window.a || [];\nfunction g() { a.push(arguments); }\ng('x');\n",
				false
			),
			ok("window.a=window.a||[];function g(){a.push(arguments)}g(\"x\");")
		);
		assert_eq!(m.js("var = ;", false), Err(REFUSED.to_owned()));
		assert_eq!(m.js("  \n ", false), ok("  \n "));
	}

	#[test]
	fn an_event_handler_may_return() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(
			m.js("if (confirm('ok')) { go(); } return false;", true),
			ok("return confirm(\"ok\")&&go(),!1")
		);
		assert_eq!(m.js("go( 1 );", true), ok("go(1)"));
		assert!(
			m.js("go(", true)
				.unwrap_err()
				.starts_with("esbuild cannot read it: ")
		);
	}

	#[test]
	fn the_semicolon_of_an_empty_statement_stays_in_a_handler() {
		let m = Minifiers::new(Some(esbuild()), "t", None);
		assert_eq!(m.js("while(next());", true), ok("for(;next(););"));
		assert_eq!(m.js("if (a) ; else b()", true), ok("a||b()"));
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
		// The rest of the message is the system's.
		assert!(
			missing
				.js("a  =  1;", false)
				.unwrap_err()
				.starts_with("cannot start /nonexistent/esbuild: ")
		);
		assert!(
			fs::read_dir(format!("{dir}/minify"))
				.is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
				|| fs::read_dir(format!("{dir}/minify"))
					.unwrap()
					.next()
					.is_none(),
			"a failure to run esbuild is not stored"
		);

		// What esbuild refuses is final, and stored as a refusal with its reason.
		let real = Minifiers::new(Some(esbuild()), "1", Some(dir.clone()));
		assert_eq!(real.js("var = ;", false), Err(REFUSED.to_owned()));
		let stored: Vec<String> = fs::read_dir(format!("{dir}/minify"))
			.unwrap()
			.map(|e| e.unwrap().file_name().into_string().unwrap())
			.collect();
		assert_eq!(stored.len(), 1);
		assert!(stored[0].ends_with(".rejected"), "{stored:?}");
		// The next build reports it too, without asking esbuild.
		let next = Minifiers::new(
			Some("/nonexistent/esbuild".to_owned()),
			"1",
			Some(dir.clone()),
		);
		assert_eq!(next.js("var = ;", false), Err(REFUSED.to_owned()));
		let _ = fs::remove_dir_all(&dir);
	}

	/// A stand-in for esbuild: a shell script with `body`, in `dir`.
	#[cfg(unix)]
	fn fake_esbuild(dir: &str, body: &str) -> String {
		use std::os::unix::fs::PermissionsExt;
		fs::create_dir_all(dir).unwrap();
		let path = format!("{dir}/esbuild");
		// Written aside and renamed: a running copy is never rewritten in place.
		let temp = format!("{path}.tmp");
		fs::write(&temp, format!("#!/bin/sh\ncat > /dev/null\n{body}\n")).unwrap();
		fs::set_permissions(&temp, fs::Permissions::from_mode(0o755)).unwrap();
		fs::rename(&temp, &path).unwrap();
		path
	}

	#[cfg(unix)]
	#[test]
	fn an_exit_without_an_error_line_is_a_failure_of_esbuild_and_is_not_remembered() {
		let dir = temp("stopped");
		let binary = fake_esbuild(&format!("{dir}/bin"), "exit 3");
		let m = Minifiers::new(Some(binary.clone()), "1", Some(format!("{dir}/cache")));
		assert_eq!(
			m.js("a  =  1;", false),
			Err("esbuild stopped (exit status: 3)".to_owned())
		);
		assert!(
			fs::read_dir(format!("{dir}/cache/minify")).is_err(),
			"nothing is stored"
		);
		// Neither in the memo: once esbuild works, the same instance minifies.
		fake_esbuild(&format!("{dir}/bin"), "printf 'a=1;\\n'");
		assert_eq!(m.js("a  =  1;", false), ok("a=1;"));
		let _ = fs::remove_dir_all(&dir);
	}

	#[cfg(unix)]
	#[test]
	fn the_error_line_of_a_windows_console_is_read_too() {
		let dir = temp("windows");
		let binary = fake_esbuild(&dir, "echo 'X [ERROR] Unexpected end of file' >&2\nexit 1");
		let m = Minifiers::new(Some(binary), "1", None);
		assert_eq!(
			m.js("go(", false),
			Err("esbuild cannot read it: Unexpected end of file".to_owned())
		);
		let _ = fs::remove_dir_all(&dir);
	}

	#[test]
	fn without_a_binary_the_scripts_are_left_alone() {
		let m = Minifiers::new(None, "t", None);
		assert_eq!(m.js("a  =  1;", false), ok("a  =  1;"));
	}

	#[test]
	fn styles_are_minified_by_kd_css_in_all_three_places() {
		let m = Minifiers::new(None, "t", None);
		assert_eq!(
			m.css("a  { color : white }", CssKind::Block),
			ok("a{color:#fff}")
		);
		assert_eq!(
			m.css("color : white ;  margin : 0px", CssKind::Inline),
			ok("color:#fff;margin:0")
		);
		assert_eq!(m.css("all", CssKind::Media), ok("all"));
		assert_eq!(
			m.css("screen  and (min-width : 100px)", CssKind::Media),
			ok("screen and (min-width:100px)")
		);
	}

	#[test]
	fn css_that_kd_css_gives_up_on_says_why() {
		let m = Minifiers::new(None, "t", None);
		let deep = format!("{}a{{b:c}}", "@media a{".repeat(1000));
		assert!(m.css(&deep, CssKind::Block).is_err());
	}

	#[test]
	fn results_are_kept_between_builds_and_by_version() {
		let dir = temp("cache");
		let first = Minifiers::new(Some(esbuild()), "1", Some(dir.clone()));
		assert_eq!(first.js("a  =  1;", false), ok("a=1;"));
		let stored: Vec<_> = fs::read_dir(format!("{dir}/minify")).unwrap().collect();
		assert_eq!(stored.len(), 1);

		// A second instance with no binary can only answer from the cache.
		let second = Minifiers::new(None, "1", Some(dir.clone()));
		assert_eq!(
			second.js("a  =  1;", false),
			ok("a  =  1;"),
			"no binary: not minified"
		);
		let with_cache = Minifiers {
			esbuild: Some("/nonexistent/esbuild".to_owned()),
			..Minifiers::new(None, "1", Some(dir.clone()))
		};
		assert_eq!(
			with_cache.js("a  =  1;", false),
			ok("a=1;"),
			"served from the cache"
		);
		// Another version does not reuse it.
		let other = Minifiers {
			esbuild: Some("/nonexistent/esbuild".to_owned()),
			..Minifiers::new(None, "2", Some(dir.clone()))
		};
		assert!(other.js("a  =  1;", false).is_err());
		let _ = fs::remove_dir_all(&dir);
	}
}
