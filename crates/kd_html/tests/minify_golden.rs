//! Differential test against html-minifier-terser: every
//! `tests/minify_golden/<case>.in` goes through `minify` and must come out as
//! the bytes the minifier produced for it in `<case>.out` (`__ERROR__` where
//! it throws). The corpus is made by `scripts/generate-minify-golden.mjs`.

use std::fs;
use std::path::PathBuf;

use kd_html::minify::{NoMinification, Options, minify};

fn golden_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("minify_golden")
}

#[test]
fn every_case_minifies_to_what_html_minifier_terser_produced() {
	let mut names: Vec<String> = fs::read_dir(golden_dir())
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort();
	assert!(
		names.len() >= 100,
		"the corpus is missing: {} cases",
		names.len()
	);

	let options = Options {
		minify_css: false,
		minify_js: false,
		..Options::default()
	};
	let mut failures = Vec::new();
	for name in &names {
		let input = fs::read_to_string(golden_dir().join(format!("{name}.in"))).unwrap();
		let expected = fs::read_to_string(golden_dir().join(format!("{name}.out"))).unwrap();
		let actual = match minify(&input, &options, &NoMinification) {
			Ok(s) => s,
			Err(_) => "__ERROR__".to_owned(),
		};
		if actual != expected {
			failures.push(format!(
				"{name}\n  input:    {input:?}\n  expected: {expected:?}\n  actual:   {actual:?}"
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ from html-minifier-terser:\n{}",
		failures.len(),
		names.len(),
		failures.join("\n")
	);
}
