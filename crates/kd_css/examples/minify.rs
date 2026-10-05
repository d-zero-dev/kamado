//! Minifies many files in one process, for the differential scripts in
//! `scripts/`: reads one path per line from standard input and writes one JSON
//! object per line (`{"path": ..., "css": ...}` or `{"path": ..., "error":
//! ...}`). `KD_CSS_MODE` picks what the files hold: a style sheet (the
//! default), `declarations` (a `style` attribute) or `media` (a `media`
//! attribute).

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
	let mode = std::env::var("KD_CSS_MODE").unwrap_or_default();
	let stdin = std::io::stdin();
	let mut stdout = std::io::stdout().lock();
	for line in stdin.lock().lines() {
		let path = line.expect("a line of standard input");
		if path.is_empty() {
			continue;
		}
		let result = match std::fs::read_to_string(&path) {
			Err(e) => Err(format!("cannot read: {e}")),
			Ok(src) => match mode.as_str() {
				"declarations" => kd_css::minify_declarations(&src).map_err(|e| e.to_string()),
				"media" => Ok(kd_css::minify_media_query(&src)),
				_ => kd_css::minify(&src).map_err(|e| e.to_string()),
			},
		};
		let json = match result {
			Ok(css) => format!(
				"{{\"path\":{},\"css\":{}}}",
				json_string(&path),
				json_string(&css)
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
