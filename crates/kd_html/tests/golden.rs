//! Differential test against v2: every `tests/golden/<case>.in` goes
//! through `Page` and must come out as the bytes linkedom produced for it in
//! `<case>.out`. The corpus is made by `scripts/generate-html-golden.mjs`.

use std::fs;
use std::path::PathBuf;

use kd_html::page::Page;

fn golden_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("golden")
}

#[test]
fn every_case_serializes_to_what_linkedom_produced() {
	let mut names: Vec<String> = fs::read_dir(golden_dir())
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort();
	assert!(
		names.len() >= 40,
		"the corpus is missing: {} cases",
		names.len()
	);

	let mut failures = Vec::new();
	for name in &names {
		let input = fs::read_to_string(golden_dir().join(format!("{name}.in"))).unwrap();
		let expected = fs::read_to_string(golden_dir().join(format!("{name}.out"))).unwrap();
		let actual = Page::parse(&input).serialize();
		if actual != expected {
			failures.push(format!(
				"{name}\n  input:    {input:?}\n  expected: {expected:?}\n  actual:   {actual:?}"
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ from linkedom:\n{}",
		failures.len(),
		names.len(),
		failures.join("\n")
	);
}
