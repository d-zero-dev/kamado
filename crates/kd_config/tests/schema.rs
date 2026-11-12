//! `packages/kamado/schema.json` lists the options `kd_config` accepts.
//!
//! The parser is the authority: an unknown key is an error whose message lists
//! the allowed keys, so the test provokes that error in each section and
//! compares the list with the schema's properties in both directions. An
//! option added to one side only fails here.

use kd_jsonc::Value;

fn schema() -> Value {
	let path = concat!(
		env!("CARGO_MANIFEST_DIR"),
		"/../../packages/kamado/schema.json"
	);
	let text = std::fs::read_to_string(path).expect("schema.json is readable");
	kd_jsonc::parse(&text).expect("schema.json is valid JSON")
}

/// The property names of the schema object at `pointer` (keys of `properties`),
/// following `$ref` and `oneOf` to the object that has them.
fn properties(root: &Value, node: &Value) -> Vec<String> {
	if let Some(Value::String(r)) = node.get("$ref") {
		let name = r.trim_start_matches("#/definitions/");
		return properties(root, root.get("definitions").unwrap().get(name).unwrap());
	}
	if let Some(Value::Array(options)) = node.get("oneOf") {
		for option in options {
			let found = properties(root, option);
			if !found.is_empty() {
				return found;
			}
		}
		return vec![];
	}
	match node.get("properties") {
		Some(Value::Object(pairs)) => pairs.iter().map(|(k, _)| k.clone()).collect(),
		_ => vec![],
	}
}

/// The keys the parser reports as allowed for the section whose config text is
/// `config` (which holds one unknown key).
fn allowed_by_parser(config: &str) -> Vec<String> {
	let error = kd_config::parse(config, "/p", None).expect_err("the unknown key is rejected");
	let message = error.message;
	let list = message
		.split("(allowed: ")
		.nth(1)
		.unwrap_or_else(|| panic!("no allowed list in {message:?}"))
		.trim_end_matches(')');
	list.split(", ").map(str::to_string).collect()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
	v.sort();
	v
}

fn check(root: &Value, section: &str, node: &Value, config: &str) {
	assert_eq!(
		sorted(properties(root, node)),
		sorted(allowed_by_parser(config)),
		"schema and parser disagree about {section}"
	);
}

#[test]
fn schema_properties_match_the_options_the_parser_accepts() {
	let root = schema();
	let props = root.get("properties").unwrap();
	let section = |name: &str| props.get(name).unwrap();
	let dir = r#""dir": { "input": "src", "output": "out" }"#;

	check(&root, "the top level", &root, r#"{ "nope": 1 }"#);
	check(&root, "dir", section("dir"), r#"{ "dir": { "nope": 1 } }"#);
	check(
		&root,
		"site",
		section("site"),
		&format!(r#"{{ {dir}, "site": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"pages",
		section("pages"),
		&format!(r#"{{ {dir}, "pages": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"pages.layouts",
		section("pages")
			.get("properties")
			.unwrap()
			.get("layouts")
			.unwrap(),
		&format!(r#"{{ {dir}, "pages": {{ "layouts": {{ "nope": 1 }} }} }}"#),
	);
	check(
		&root,
		"data",
		section("data"),
		&format!(r#"{{ {dir}, "data": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"html",
		section("html"),
		&format!(r#"{{ {dir}, "html": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"sitemap",
		section("sitemap"),
		&format!(r#"{{ {dir}, "sitemap": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"styles",
		section("styles"),
		&format!(r#"{{ {dir}, "styles": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"scripts",
		section("scripts"),
		&format!(r#"{{ {dir}, "scripts": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"devServer",
		section("devServer"),
		&format!(r#"{{ {dir}, "devServer": {{ "nope": 1 }} }}"#),
	);
	check(
		&root,
		"build",
		section("build"),
		&format!(r#"{{ {dir}, "build": {{ "nope": 1 }} }}"#),
	);
}

#[test]
fn schema_nested_html_options_match_the_parser() {
	let root = schema();
	let html = root.get("definitions").unwrap().get("htmlOptions").unwrap();
	let props = html.get("properties").unwrap();
	let dir = r#""dir": { "input": "src", "output": "out" }"#;
	for (key, config) in [
		("format", r#"{ "useTabs": true, "nope": 1 }"#),
		("minify", r#"{ "css": true, "nope": 1 }"#),
		("imageSizes", r#"{ "enabled": true, "nope": 1 }"#),
	] {
		let node = props.get(key).unwrap();
		check(
			&root,
			&format!("html.{key}"),
			node,
			&format!(r#"{{ {dir}, "html": {{ "{key}": {config} }} }}"#),
		);
	}
}

#[test]
fn schema_ui_options_match_the_parser() {
	let root = schema();
	let dir = r#""dir": { "input": "src", "output": "out" }"#;
	let ui = root.get("properties").unwrap().get("ui").unwrap();
	check(
		&root,
		"ui",
		ui,
		&format!(r#"{{ {dir}, "ui": {{ "nope": 1 }} }}"#),
	);
	let key = ui
		.get("properties")
		.unwrap()
		.get("keys")
		.unwrap()
		.get("additionalProperties")
		.unwrap();
	check(
		&root,
		"ui.keys.<key>",
		key,
		&format!(r#"{{ {dir}, "ui": {{ "keys": {{ "title": {{ "nope": 1 }} }} }} }}"#),
	);
}

/// A `dir` that is valid (the input and the output must differ).
const DIR: &str = r#""dir": { "input": "src", "output": "out" }"#;

/// The columns the parser takes in `ui.defaultKeyOrder` besides `meta:<key>`.
fn columns_by_parser() -> Vec<String> {
	kd_config::UI_BUILTIN_COLUMNS
		.iter()
		.map(|name| (*name).to_string())
		.collect()
}

#[test]
fn schema_column_lists_match_the_parser() {
	let root = schema();
	let ui = root.get("properties").unwrap().get("ui").unwrap();
	let list = root.get("definitions").unwrap().get("columnList").unwrap();
	for key in ["defaultKeyOrder", "defaultFixedKeys"] {
		let node = ui.get("properties").unwrap().get(key).unwrap();
		// The property points at the shared definition (inside `allOf`, to keep its own description).
		let Some(Value::Array(all_of)) = node.get("allOf") else {
			panic!("ui.{key} is not an allOf of columnList");
		};
		assert_eq!(
			all_of[0].get("$ref").and_then(Value::as_str),
			Some("#/definitions/columnList")
		);
	}

	// The identifiers: the pattern names the same fixed columns as the parser, and `meta:<key>`.
	let Some(Value::String(pattern)) = list.get("items").unwrap().get("pattern") else {
		panic!("columnList.items has no pattern");
	};
	let names = pattern
		.strip_prefix("^(")
		.and_then(|rest| rest.strip_suffix(r"|meta:[\s\S]+)$"))
		.unwrap_or_else(|| panic!("unexpected pattern {pattern:?}"));
	let mut in_schema: Vec<String> = names.split('|').map(str::to_string).collect();
	let mut in_parser = columns_by_parser();
	in_schema.sort();
	in_parser.sort();
	assert_eq!(
		in_schema, in_parser,
		"schema and parser disagree about the fixed columns"
	);
	for name in &in_parser {
		let config = format!(r#"{{ {DIR}, "ui": {{ "defaultKeyOrder": ["{name}"] }} }}"#);
		assert!(kd_config::parse(&config, "/p", None).is_ok(), "{name}");
	}

	// The limits: the schema says what the parser enforces.
	let number = |node: &Value, key: &str| match node.get(key) {
		Some(Value::Number(n)) => *n as usize,
		_ => panic!("no {key}"),
	};
	assert_eq!(number(list, "maxItems"), 500);
	assert_eq!(number(list.get("items").unwrap(), "maxLength"), 256);
	let at = |n: usize| {
		let many = (0..n)
			.map(|i| format!(r#""meta:k{i}""#))
			.collect::<Vec<_>>()
			.join(",");
		kd_config::parse(
			&format!(r#"{{ {DIR}, "ui": {{ "defaultKeyOrder": [{many}] }} }}"#),
			"/p",
			None,
		)
	};
	assert!(at(500).is_ok());
	assert!(at(501).is_err());
	assert_eq!(list.get("uniqueItems"), Some(&Value::Bool(true)));
}
