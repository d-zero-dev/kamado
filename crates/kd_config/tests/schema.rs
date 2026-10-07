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
