//! Compiles many files in one process, for the differential scripts in
//! `scripts/`: reads one path per line from standard input and writes one JSON
//! object per line (`{"path": ..., "code": ...}` or `{"path": ..., "error":
//! ...}`). The kind of file comes from its extension; `KD_JS_KEEP_IMPORTS=1`
//! keeps unused imports (what Node's type stripping does).

use std::io::{BufRead, Write};

fn json_string(text: &str) -> String {
	let mut out = String::with_capacity(text.len() + 2);
	out.push('"');
	for c in text.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

fn main() {
	let keep_imports = std::env::var("KD_JS_KEEP_IMPORTS").is_ok();
	let runtime =
		std::env::var("KD_JS_RUNTIME").unwrap_or_else(|_| "file:///runtime.js".to_owned());
	let stdin = std::io::stdin();
	let mut stdout = std::io::stdout().lock();
	for line in stdin.lock().lines() {
		let path = line.expect("a line of standard input");
		if path.is_empty() {
			continue;
		}
		let (jsx, ts) = if path.ends_with(".tsx") {
			(true, true)
		} else if path.ends_with(".ts") || path.ends_with(".mts") || path.ends_with(".cts") {
			(false, true)
		} else if path.ends_with(".jsx") {
			(true, false)
		} else {
			(false, false)
		};
		let result = match std::fs::read_to_string(&path) {
			Err(e) => Err(format!("cannot read: {e}")),
			Ok(src) => kd_js::compile(
				&src,
				&kd_js::Options {
					runtime: &runtime,
					jsx,
					ts,
					elide_imports: !keep_imports,
					rewrite: &|_| None,
					define: &[],
				},
			)
			.map(|o| o.code)
			.map_err(|e| e.to_string()),
		};
		let json = match result {
			Ok(code) => format!(
				"{{\"path\":{},\"code\":{}}}",
				json_string(&path),
				json_string(&code)
			),
			Err(error) => format!(
				"{{\"path\":{},\"error\":{}}}",
				json_string(&path),
				json_string(&error)
			),
		};
		writeln!(stdout, "{json}").expect("write to standard output");
	}
}
