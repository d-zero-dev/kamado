//! The golden cases: every hand-written style sheet of
//! `scripts/css-golden-cases.mjs` in `tests/golden/<n>.in`, with what cssnano
//! makes of it in `<n>.out` (`scripts/generate-css-golden.mjs`). `kd_css` must
//! give the same, unless the case is listed in `common::DELIBERATE`, where
//! both answers are asserted.

mod common;

use std::fs;
use std::path::PathBuf;

#[test]
fn every_case_gives_cssnanos_answer_or_a_listed_deliberate_one() {
	let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("golden");
	let mut names: Vec<String> = fs::read_dir(&dir)
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
	assert!(
		names.len() >= 400,
		"the corpus is missing: {} cases",
		names.len()
	);
	let cases: Vec<(String, String)> = names
		.iter()
		.map(|n| {
			(
				fs::read_to_string(dir.join(format!("{n}.in"))).unwrap(),
				fs::read_to_string(dir.join(format!("{n}.out"))).unwrap(),
			)
		})
		.collect();
	// A case cssnano rejected has `__ERROR__` as its answer, and only the idempotence of
	// ours is checked. If the generator broke (a missing dependency throws for every case),
	// all answers would be `__ERROR__` and this test would pass on nothing.
	let rejected = cases.iter().filter(|(_, out)| out == "__ERROR__").count();
	assert!(
		rejected <= 30,
		"{rejected} of {} cases were rejected by cssnano: regenerate the corpus and look at why",
		cases.len()
	);
	let refs: Vec<(&str, &str)> = cases
		.iter()
		.map(|(a, b)| (a.as_str(), b.as_str()))
		.collect();
	let used = common::check_all(&refs);
	let stale: Vec<&str> = common::DECISIONS
		.iter()
		.enumerate()
		.filter(|(i, _)| !used.contains(i))
		.map(|(_, d)| d.input)
		.collect();
	assert!(
		stale.is_empty(),
		"these deliberate differences are no longer needed by any case: {stale:?}"
	);
}
