//! Differential test of the minifier against html-minifier-terser. Ignored by
//! default: it needs the corpus that `scripts/fuzz-html-minify.mjs` writes
//! (see that script for the commands).

use std::fs;
use std::path::PathBuf;

use kd_html::minify::{NoMinification, Options, minify};

#[test]
#[ignore = "needs KD_MINIFY_DIR, a corpus written by scripts/fuzz-html-minify.mjs"]
fn random_pages_minify_like_html_minifier_terser() {
	let dir = PathBuf::from(std::env::var("KD_MINIFY_DIR").expect("set KD_MINIFY_DIR"));
	let mut names: Vec<String> = fs::read_dir(&dir)
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
	assert!(!names.is_empty(), "the corpus is empty");

	let options = Options {
		minify_css: false,
		minify_js: false,
		..Options::default()
	};
	let mut failures = 0;
	let mut shown = 0;
	for name in &names {
		let input = fs::read_to_string(dir.join(format!("{name}.in"))).unwrap();
		let expected = fs::read_to_string(dir.join(format!("{name}.out"))).unwrap();
		let actual = match minify(&input, &options, &NoMinification) {
			Ok(s) => s,
			Err(_) => "__ERROR__".to_owned(),
		};
		if actual != expected {
			failures += 1;
			if shown < 6 {
				shown += 1;
				println!(
					"--- case {name}\n  input:\n{input}\n  expected:\n{expected}\n  actual:\n{actual}"
				);
			}
		}
	}
	assert_eq!(
		failures,
		0,
		"{failures} of {} cases differ from html-minifier-terser",
		names.len()
	);
}
