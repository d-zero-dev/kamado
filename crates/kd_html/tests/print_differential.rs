//! Differential test of the HTML printer against prettier. Ignored by
//! default: it needs the corpus that `scripts/fuzz-html-print.mjs` writes
//! (see that script for the commands). `options.json` in the corpus holds the
//! prettier options (`printWidth`, `tabWidth`, `useTabs`, `bracketSameLine`).

use std::fs;
use std::path::PathBuf;

use kd_html::page::Page;
use kd_html::print::{Options, add_doctype, format};

fn options_from(dir: &std::path::Path) -> Options {
	let json = fs::read_to_string(dir.join("options.json")).unwrap_or_else(|_| "{}".to_owned());
	let value = kd_jsonc_free_parse(&json);
	let mut options = Options::default();
	if let Some(v) = value.get("printWidth") {
		options.print_width = *v;
	}
	if let Some(v) = value.get("tabWidth") {
		options.tab_width = *v;
	}
	if let Some(v) = value.get("useTabs") {
		options.use_tabs = *v != 0;
	}
	if let Some(v) = value.get("bracketSameLine") {
		options.bracket_same_line = *v != 0;
	}
	options
}

/// A tiny reader for the flat `{"key": number|bool}` objects written by the
/// script (the crate has no JSON dependency, and this is a test).
fn kd_jsonc_free_parse(json: &str) -> std::collections::HashMap<String, usize> {
	let mut map = std::collections::HashMap::new();
	let body = json.trim().trim_start_matches('{').trim_end_matches('}');
	for pair in body.split(',') {
		let Some((k, v)) = pair.split_once(':') else {
			continue;
		};
		let key = k.trim().trim_matches('"').to_owned();
		let value = match v.trim() {
			"true" => 1,
			"false" => 0,
			n => n.parse().unwrap_or(0),
		};
		map.insert(key, value);
	}
	map
}

#[test]
#[ignore = "needs KD_PRINT_DIR, a corpus written by scripts/fuzz-html-print.mjs"]
fn random_pages_print_like_prettier() {
	let dir = PathBuf::from(std::env::var("KD_PRINT_DIR").expect("set KD_PRINT_DIR"));
	let options = options_from(&dir);
	// With KD_PRINT_PIPELINE the input is broken HTML that goes through the
	// parser and serializer first, as in a build.
	let pipeline = std::env::var("KD_PRINT_PIPELINE").is_ok();
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
		let prepared = if pipeline {
			add_doctype(&Page::parse(&input).serialize())
		} else {
			input.clone()
		};
		let actual = match format(&prepared, &options) {
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
		"{failures} of {} cases differ from prettier",
		names.len()
	);
}
