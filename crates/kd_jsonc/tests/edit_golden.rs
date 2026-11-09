//! Differential test against `jsonc-parser` (the library VS Code edits JSONC with): for every
//! case of `tests/edit_golden.json` the edit is made with `kd_jsonc::edit`, and the result
//! must read as the value the oracle's result reads as. What is compared is the value, not
//! the bytes: the oracle formats what it inserts by its own rules, and `kd_jsonc::edit`
//! follows the layout of the file (the unit tests of the module check the bytes). The
//! corpus is made by `scripts/generate-jsonc-edit-golden.mjs`.

use std::fs;
use std::path::PathBuf;

use kd_jsonc::edit::{Seg, delete_member, set_member};
use kd_jsonc::{Value, parse};

fn golden() -> Value {
	let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("edit_golden.json");
	parse(&fs::read_to_string(path).unwrap()).unwrap()
}

fn text<'a>(case: &'a Value, key: &str) -> &'a str {
	case.get(key)
		.and_then(Value::as_str)
		.unwrap_or_else(|| panic!("{key} in {case:?}"))
}

#[test]
fn every_edit_reads_as_the_oracle_says() {
	let Value::Array(cases) = golden() else {
		panic!("the corpus is an array");
	};
	assert!(
		cases.len() >= 500,
		"the corpus is missing: {} cases",
		cases.len()
	);
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
		let result = match text(case, "op") {
			"set" => set_member(source, &steps, text(case, "key"), &value),
			"delete" => delete_member(source, &steps, text(case, "key")),
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
				"{source:?} {} {path:?} {:?} {value:?}\n  expected {expected}\n  actual   {actual}",
				text(case, "op"),
				case.get("key"),
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
