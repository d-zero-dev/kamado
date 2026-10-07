//! Differential test against Node's type stripping: every
//! `tests/ts_golden/<n>.in` is compiled as TypeScript (unused imports kept)
//! and must equal `<n>.out`, Node's output, up to white space. The corpus is
//! made by `scripts/generate-kd-js-golden.mjs`.

use std::fs;
use std::path::PathBuf;

fn golden_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("ts_golden")
}

fn squeeze(text: &str) -> String {
	text.chars().filter(|c| !c.is_whitespace()).collect()
}

#[test]
fn every_snippet_is_erased_like_node_does() {
	let mut names: Vec<String> = fs::read_dir(golden_dir())
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
	assert!(
		names.len() >= 100,
		"the corpus is missing: {} cases",
		names.len()
	);

	let mut failures = Vec::new();
	for name in &names {
		let input = fs::read_to_string(golden_dir().join(format!("{name}.in"))).unwrap();
		let expected = fs::read_to_string(golden_dir().join(format!("{name}.out"))).unwrap();
		let actual = match kd_js::compile(
			&input,
			&kd_js::Options {
				runtime: "file:///rt.js",
				jsx: false,
				ts: true,
				elide_imports: false,
				rewrite: &|_| None,
				define: &[],
			},
		) {
			Ok(out) => squeeze(&out.code),
			Err(e) => format!("__ERROR__ {e}"),
		};
		if actual != expected {
			failures.push(format!(
				"{name}\n  input:    {input:?}\n  expected: {expected}\n  actual:   {actual}"
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} snippets differ from Node:\n{}",
		failures.len(),
		names.len(),
		failures.join("\n")
	);
}
