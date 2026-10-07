//! Differential fuzzing against v2. Ignored by default: it needs the corpus
//! that `scripts/fuzz-html-differential.mjs` writes.
//!
//! ```sh
//! node scripts/fuzz-html-differential.mjs /tmp/kd-fuzz 20000 1
//! KD_FUZZ_DIR=/tmp/kd-fuzz cargo test -p kd_html --test differential -- --ignored
//! ```

use std::fs;
use std::path::PathBuf;

use kd_html::page::Page;

#[test]
#[ignore = "needs KD_FUZZ_DIR, a corpus written by scripts/fuzz-html-differential.mjs"]
fn random_inputs_serialize_like_linkedom() {
	let dir = PathBuf::from(std::env::var("KD_FUZZ_DIR").expect("set KD_FUZZ_DIR"));
	let mut names: Vec<String> = fs::read_dir(&dir)
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
	assert!(!names.is_empty(), "the corpus is empty");

	let mut failures = 0;
	let mut shown = 0;
	for name in &names {
		let input = fs::read_to_string(dir.join(format!("{name}.in"))).unwrap();
		let expected = fs::read_to_string(dir.join(format!("{name}.out"))).unwrap();
		if expected == "__LINKEDOM_THREW__" {
			continue;
		}
		let actual = Page::parse(&input).serialize();
		if actual != expected {
			failures += 1;
			if shown < 15 {
				shown += 1;
				println!(
					"--- case {name}\n  input:    {input:?}\n  expected: {expected:?}\n  actual:   {actual:?}"
				);
			}
		}
	}
	assert_eq!(
		failures,
		0,
		"{failures} of {} cases differ from linkedom",
		names.len()
	);
}
