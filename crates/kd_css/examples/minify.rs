//! Minifies many files in one process, for the differential scripts in
//! `scripts/`: reads one path per line from standard input and writes one JSON
//! object per line (`{"path": ..., "css": ...}` or `{"path": ..., "error":
//! ...}`). `KD_CSS_MODE` picks what the files hold: a style sheet (the
//! default), `declarations` (a `style` attribute) or `media` (a `media`
//! attribute).
//!
//! In the default mode, a file `<n>.in` that has the cssnano output `<n>.out`
//! next to it, and whose output is larger than the bound of the size check
//! (3 % and 8 bytes over cssnano's), also gets `"decisions"`: the reasons
//! `tests/common` records for the difference from cssnano's output. The list
//! is empty when the output is within the bound, or when the difference is
//! not made of the recorded decisions alone. `scripts/check-css.mjs` does not
//! hold a file with reasons to the size bound, like `tests/differential.rs`.

// The decisions are the ones the tests assert, so that the size check cannot
// disagree with them; the test module has helpers this example does not call.
#[allow(dead_code)]
#[path = "../tests/common/mod.rs"]
mod common;

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

/// The reasons, one per decision of `common::DECISIONS` that the file needed,
/// as a JSON array; `[]` unless the output is over the size bound and is the
/// cssnano output with only those decisions undone.
fn decisions_of(path: &str, src: &str, mine: &str) -> String {
	let Some(stem) = path.strip_suffix(".in") else {
		return "[]".to_owned();
	};
	let Ok(theirs) = std::fs::read_to_string(format!("{stem}.out")) else {
		return "[]".to_owned();
	};
	// The same bound as `scripts/check-css.mjs` and `tests/differential.rs`;
	// `check` minifies twice, so it runs only for the few files that need it.
	if mine.len() as f64 <= theirs.len() as f64 * 1.03 + 8.0 {
		return "[]".to_owned();
	}
	// An error is a difference beyond the decisions (or an output that is not
	// stable, which the idempotence check of the script reports): no reasons.
	let used = common::check(src, &theirs).unwrap_or_default();
	let reasons: Vec<String> = used
		.iter()
		.map(|&i| json_string(common::DECISIONS[i].why))
		.collect();
	format!("[{}]", reasons.join(","))
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
		let mut decisions = "[]".to_owned();
		let result = match std::fs::read_to_string(&path) {
			Err(e) => Err(format!("cannot read: {e}")),
			Ok(src) => {
				let minified = match mode.as_str() {
					"declarations" => kd_css::minify_declarations(&src).map_err(|e| e.to_string()),
					"media" => Ok(kd_css::minify_media_query(&src)),
					_ => kd_css::minify(&src).map_err(|e| e.to_string()),
				};
				if !matches!(mode.as_str(), "declarations" | "media")
					&& let Ok(css) = &minified
				{
					decisions = decisions_of(&path, &src, css);
				}
				minified
			}
		};
		let json = match result {
			Ok(css) => format!(
				"{{\"path\":{},\"css\":{},\"decisions\":{decisions}}}",
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

#[cfg(test)]
mod tests {
	use super::decisions_of;
	use std::path::PathBuf;

	/// A directory of its own under the system's, removed when dropped.
	struct Scratch(PathBuf);

	impl Scratch {
		fn new(name: &str) -> Self {
			let dir = std::env::temp_dir().join(format!(
				"kd_css-minify-example-{name}-{}",
				std::process::id()
			));
			std::fs::create_dir_all(&dir).unwrap();
			Self(dir)
		}

		fn write(&self, file: &str, text: &str) -> String {
			let path = self.0.join(file);
			std::fs::write(&path, text).unwrap();
			path.to_string_lossy().into_owned()
		}
	}

	impl Drop for Scratch {
		fn drop(&mut self) {
			let _ = std::fs::remove_dir_all(&self.0);
		}
	}

	const INPUT: &str = "a{--c: calc( 1px  +  2px )}";
	const KEPT: &str = "a{--c:calc( 1px  +  2px )}";

	#[test]
	fn the_reasons_are_listed_when_the_output_is_over_the_bound_by_decisions_only() {
		let dir = Scratch::new("decided");
		let path = dir.write("1.in", INPUT);
		dir.write("1.out", "a{--c:3px}");

		assert_eq!(
			decisions_of(&path, INPUT, KEPT),
			"[\"custom property values are kept as written\"]"
		);
	}

	#[test]
	fn there_are_none_without_a_cssnano_output_next_to_the_input() {
		let dir = Scratch::new("no-out");
		let path = dir.write("1.in", INPUT);

		assert_eq!(decisions_of(&path, INPUT, KEPT), "[]");
	}

	#[test]
	fn there_are_none_for_a_file_that_is_not_an_input_of_the_corpus() {
		let dir = Scratch::new("not-in");
		let path = dir.write("1.css", INPUT);
		dir.write("1.out", "a{--c:3px}");

		assert_eq!(decisions_of(&path, INPUT, KEPT), "[]");
	}

	#[test]
	fn there_are_none_within_the_size_bound() {
		let dir = Scratch::new("within");
		let path = dir.write("1.in", INPUT);
		dir.write("1.out", KEPT);

		assert_eq!(decisions_of(&path, INPUT, KEPT), "[]");
	}

	#[test]
	fn there_are_none_when_the_difference_is_more_than_the_decisions() {
		let dir = Scratch::new("beyond");
		let path = dir.write("1.in", INPUT);
		dir.write("1.out", "a{--c:3px;--d:0}");

		assert_eq!(decisions_of(&path, INPUT, KEPT), "[]");
	}
}
