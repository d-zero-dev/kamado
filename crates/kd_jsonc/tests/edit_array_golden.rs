//! Differential test of the edits of an array against `jsonc-parser` (the library VS Code edits
//! JSONC with): for every case of `tests/edit_array_golden.json` an item is added after the
//! last one or an item is removed with `kd_jsonc::edit`, and the result must read as the value
//! the oracle's result reads as. What is compared is the value, not the bytes, as in
//! `edit_golden.rs` (the unit tests of the module check the bytes). The corpus is made by
//! `scripts/generate-jsonc-edit-golden.mjs`.

use std::fs;
use std::path::PathBuf;

use kd_jsonc::edit::{Seg, delete_element, push_element};
use kd_jsonc::{Value, parse};

fn golden() -> Value {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("edit_array_golden.json");
	parse(&fs::read_to_string(path).unwrap()).unwrap()
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
	case.get(key)
		.and_then(Value::as_str)
		.unwrap_or_else(|| panic!("{key} in {case:?}"))
}

#[test]
fn every_edit_of_an_array_reads_as_the_oracle_says() {
	let Value::Array(cases) = golden() else {
		panic!("the corpus is an array");
	};
	// Each kind of edit has its own floor: the pushes alone are most of the corpus, and would
	// hide the deletes going missing.
	for (op, least) in [("push", 300), ("deleteElement", 20)] {
		let count = cases.iter().filter(|case| text(case, "op") == op).count();
		assert!(
			count >= least,
			"the corpus is missing: {count} cases of {op}"
		);
	}
	let mut failures = Vec::new();
	for case in &cases {
		let source = text(case, "text");
		let Some(Value::Array(path)) = case.get("path") else {
			panic!("path in {case:?}");
		};
		let steps: Vec<Seg<'_>> = path
			.iter()
			.map(|s| match s {
				Value::String(k) => Seg::Key(k),
				Value::Number(n) => Seg::Index(*n as usize),
				other => panic!("a path of {other:?}"),
			})
			.collect();
		let value = case.get("value").cloned().unwrap_or(Value::Null);
		let index = case.get("index").and_then(Value::as_f64);
		let result = match text(case, "op") {
			"push" => push_element(source, &steps, &value),
			"deleteElement" => delete_element(
				source,
				&steps,
				index.unwrap_or_else(|| panic!("index in {case:?}")) as usize,
			),
			other => panic!("an operation {other}"),
		};
		let actual = match result {
			Ok(edited) => match parse(&edited) {
				Ok(v) => v.to_json(),
				Err(e) => format!("unreadable result {e}: {edited:?}"),
			},
			Err(e) => format!("refused: {e}"),
		};
		// The oracle writes the JSON of JavaScript; both are compact, with the keys in order.
		let expected = parse(text(case, "expected")).unwrap().to_json();
		if actual != expected {
			failures.push(format!(
				"{source:?} {} {path:?} {index:?} {value:?}\n  expected {expected}\n  actual   {actual}",
				text(case, "op"),
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ:\n{}",
		failures.len(),
		cases.len(),
		failures
			.iter()
			.take(5)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}
