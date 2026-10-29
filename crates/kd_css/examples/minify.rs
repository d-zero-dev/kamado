//! Minifies many files in one process, for the differential scripts in
//! `scripts/`: reads one path per line from standard input and writes one JSON
//! object per line (`{"path": ..., "css": ...}`, with the keys below in the
//! default mode, or `{"path": ..., "error": ...}`). `KD_CSS_MODE` picks what the files hold: a style sheet (the
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
//! `"undone"` is the output with the recorded decisions that apply to the
//! input undone (`{"css": ..., "decisions": [...]}`, or `null` when none
//! applies, there is no `<n>.out` or the output is cssnano's), whatever the
//! size: a decision
//! can be one where cssnano changes what the CSS means (an invalid declaration
//! made valid), so that cssnano does not bring the two outputs to one, and the
//! equivalence check of the script compares cssnano's minification of this
//! one instead.

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
/// cssnano output with only those decisions undone. (`main` reads `<n>.out`
/// once for this and [`undone`], and calls [`decisions_for`].)
#[cfg(test)]
fn decisions_of(path: &str, src: &str, mine: &str) -> String {
	match cssnano_output_of(path) {
		Some(theirs) => decisions_for(src, mine, &theirs),
		None => "[]".to_owned(),
	}
}

/// The cssnano output `<n>.out` next to the corpus input `<n>.in`.
fn cssnano_output_of(path: &str) -> Option<String> {
	let stem = path.strip_suffix(".in")?;
	std::fs::read_to_string(format!("{stem}.out")).ok()
}

/// [`decisions_of`] with the cssnano output read.
fn decisions_for(src: &str, mine: &str, theirs: &str) -> String {
	// The same bound as `scripts/check-css.mjs` and `tests/differential.rs`;
	// `check` minifies twice, so it runs only for the few files that need it.
	if mine.len() as f64 <= theirs.len() as f64 * 1.03 + 8.0 {
		return "[]".to_owned();
	}
	// An error is a difference beyond the decisions (or an output that is not
	// stable, which the idempotence check of the script reports): no reasons.
	let used = common::check(src, theirs).unwrap_or_default();
	reasons_json(&used)
}

/// The reasons of decisions of `common::DECISIONS`, as a JSON array.
fn reasons_json(used: &[usize]) -> String {
	let reasons: Vec<String> = used
		.iter()
		.map(|&i| json_string(common::DECISIONS[i].why))
		.collect();
	format!("[{}]", reasons.join(","))
}

/// The output with the decisions of `common::DECISIONS` that apply to `src`
/// undone, and their reasons, as a JSON object `{"css", "decisions"}`;
/// `null` when none applies. `main` asks only for a corpus input with the
/// cssnano output next to it, the only files the script compares.
fn undone(src: &str, mine: &str) -> String {
	let (css, used) = common::undo_decisions(src, mine);
	if used.is_empty() {
		return "null".to_owned();
	}
	format!(
		"{{\"css\":{},\"decisions\":{}}}",
		json_string(&css),
		reasons_json(&used)
	)
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
		let mut undone_json = "null".to_owned();
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
					&& let Some(theirs) = cssnano_output_of(&path)
				{
					decisions = decisions_for(&src, css, &theirs);
					// The script compares it only when the output is not cssnano's.
					if *css != theirs {
						undone_json = undone(&src, css);
					}
				}
				minified
			}
		};
		let json = match result {
			Ok(css) => format!(
				"{{\"path\":{},\"css\":{},\"decisions\":{decisions},\"undone\":{undone_json}}}",
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
	use super::{cssnano_output_of, decisions_of, undone};
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

	#[test]
	fn the_decisions_are_undone_wherever_they_are_in_the_output() {
		let input = "a{border-width:0px;color:red;border-width:0px 0% 0em;color:blue}";
		let mine = "a{border-width:0;color:red;border-width:0 0%;color:blue}";

		assert_eq!(
			undone(input, mine),
			"{\"css\":\"a{border-width:0;color:red;border-width:0;color:blue}\",\"decisions\":[\"a 0% the property does not take is kept, so the declaration stays invalid\"]}"
		);
	}

	#[test]
	fn nothing_is_undone_without_the_input_of_a_decision() {
		assert_eq!(undone("a{b:c}", "a{b:c}"), "null");
	}

	#[test]
	fn only_a_corpus_input_has_a_cssnano_output() {
		let dir = Scratch::new("cssnano-output");
		let with_out = dir.write("1.in", "a{b:c}");
		dir.write("1.out", "a{b:c}");
		let without_out = dir.write("2.in", "a{b:c}");
		let not_an_input = dir.write("1.css", "a{b:c}");

		assert_eq!(cssnano_output_of(&with_out).as_deref(), Some("a{b:c}"));
		assert_eq!(cssnano_output_of(&without_out), None);
		assert_eq!(cssnano_output_of(&not_an_input), None);
	}
}
