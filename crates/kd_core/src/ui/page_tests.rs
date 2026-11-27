//! Pages that are made, made virtual, given a file and removed (RFC §14.2), and the columns a
//! row always has (`order`, `outputPath`, `parent`, `depth`).

use super::*;

struct Site {
	root: String,
}

const OVERRIDES: &str = r#", "pages": { "overrides": "pages.overrides.json" }"#;

impl Site {
	fn new(name: &str) -> Site {
		let root = format!(
			"{}/kd_ui_page_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		)
		.replace("//", "/");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(format!("{root}/src")).unwrap();
		Site { root }
	}

	fn write(&self, rel: &str, text: &str) {
		let path = format!("{}/{rel}", self.root);
		fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
		fs::write(&path, text).unwrap();
	}

	fn read(&self, rel: &str) -> String {
		fs::read_to_string(format!("{}/{rel}", self.root)).unwrap()
	}

	fn exists(&self, rel: &str) -> bool {
		fs::symlink_metadata(format!("{}/{rel}", self.root)).is_ok()
	}

	fn open(&self, config_extra: &str) -> Ui {
		self.write(
			"kamado.config.jsonc",
			&format!(
				r#"{{ "dir": {{ "input": "src", "output": "out" }}, "build": {{ "cacheDir": ".cache" }}{config_extra} }}"#
			),
		);
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap();
		Ui::open(loaded, &BuildOptions::default()).unwrap()
	}

	fn open_config(&self, config: &str) -> Ui {
		self.write("kamado.config.jsonc", config);
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap();
		Ui::open(loaded, &BuildOptions::default()).unwrap()
	}

	/// The site as a build plans it, read from the files as they are now.
	fn plan(&self) -> Plan {
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap();
		crate::plan(&loaded.config).unwrap()
	}
}

fn json(text: &str) -> Value {
	kd_jsonc::parse(text).unwrap()
}

fn all(ui: &mut Ui) -> Value {
	json(&ui.pages(r#"{"offset":0,"limit":1000}"#).unwrap())
}

fn sorted_urls(ui: &mut Ui, key: &str, desc: bool) -> Vec<String> {
	let rows = json(
		&ui.pages(&format!(
			r#"{{"offset":0,"limit":1000,"sort":{{"key":"{key}","desc":{desc}}}}}"#
		))
		.unwrap(),
	);
	urls(&rows)
}

fn urls(rows: &Value) -> Vec<String> {
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.map(|p| p.get("url").and_then(Value::as_str).unwrap().to_string())
		.collect()
}

fn page(rows: &Value, url: &str) -> Value {
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.find(|p| p.get("url").and_then(Value::as_str) == Some(url))
		.unwrap_or_else(|| panic!("no page {url}: {pages:?}"))
		.clone()
}

fn has_page(rows: &Value, url: &str) -> bool {
	urls(rows).iter().any(|u| u == url)
}

fn cell(row: &Value, key: &str) -> Value {
	row.get("meta")
		.and_then(|m| m.get(key))
		.unwrap_or_else(|| panic!("no key {key} in {row:?}"))
		.clone()
}

fn s(text: &str) -> Value {
	Value::String(text.to_string())
}

fn quoted(text: Option<&str>) -> String {
	text.map_or("null".to_string(), |t| s(t).to_json())
}

/// The hash of `pages.overrides` as the rows show it, as the `expect` of an edit that touches
/// nothing else.
fn expect_overrides(ui: &mut Ui) -> String {
	let rows = all(ui);
	format!(
		r#"{{"overrides":{}}}"#,
		rows.get("overridesHash").unwrap().to_json()
	)
}

/// An `expect` made of the hashes a row shows.
fn expect_of(ui: &mut Ui, url: &str) -> String {
	let rows = all(ui);
	let row = page(&rows, url);
	let hashes = row.get("hashes").unwrap();
	format!(
		r#"{{"input":{},"sidecar":{},"overrides":{}}}"#,
		hashes.get("input").unwrap().to_json(),
		hashes.get("sidecar").unwrap().to_json(),
		rows.get("overridesHash").unwrap().to_json(),
	)
}

fn create(ui: &mut Ui, url: Option<&str>, path: Option<&str>, expect: &str) -> Value {
	let request = format!(
		r#"{{"url":{},"expect":{expect},"change":{{"op":"create","path":{}}}}}"#,
		quoted(url),
		quoted(path)
	);
	json(&ui.edit(&request).unwrap())
}

fn change(ui: &mut Ui, url: &str, expect: &str, change: &str) -> Value {
	let request = format!(
		r#"{{"url":{},"expect":{expect},"change":{change}}}"#,
		s(url).to_json()
	);
	json(&ui.edit(&request).unwrap())
}

fn materialize(path: Option<&str>) -> String {
	format!(r#"{{"op":"materialize","path":{}}}"#, quoted(path))
}

const VIRTUALIZE: &str = r#"{"op":"virtualize"}"#;
const DELETE_PAGE: &str = r#"{"op":"deletePage"}"#;

fn ok(answer: &Value) -> bool {
	answer.get("ok") == Some(&Value::Bool(true))
}

fn code(answer: &Value) -> String {
	answer
		.get("code")
		.and_then(Value::as_str)
		.unwrap_or_else(|| panic!("no code in {answer:?}"))
		.to_string()
}

fn number(row: &Value, key: &str) -> f64 {
	row.get(key).and_then(Value::as_f64).unwrap()
}

// ---- the columns a row always has

#[test]
fn a_row_says_its_place_in_the_plan() {
	let site = Site::new("order");
	site.write("src/a.html", "a");
	site.write("src/b.html", "b");
	site.write("src/c.html", "c");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/c.html" }, { "url": "/v/", "virtual": true } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let rows = all(&mut ui);
	// the entries of the file do not place the pages
	// Behavior change: the entries of `pages.overrides` no longer place a page (RFC section 6): the order of `pages` is the one `order` and the URLs make, a page before what hangs from it, the children in the natural order of their URLs
	assert_eq!(urls(&rows), ["/a.html", "/b.html", "/c.html", "/v/"]);
	// assert_eq!(urls(&rows), ["/c.html", "/v/", "/a.html", "/b.html"]); // previous
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(page(&rows, "/c.html").get("order").is_none());
	// assert_eq!(number(&page(&rows, "/c.html"), "order"), 1.0); // previous
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(page(&rows, "/v/").get("order").is_none());
	// assert_eq!(number(&page(&rows, "/v/"), "order"), 2.0); // previous
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(page(&rows, "/a.html").get("order").is_none());
	// assert_eq!(number(&page(&rows, "/a.html"), "order"), 3.0); // previous
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(page(&rows, "/b.html").get("order").is_none());
	// assert_eq!(number(&page(&rows, "/b.html"), "order"), 4.0); // previous
	// the place is the place in the plan whatever the rows are sorted or cut by
	let window = json(
		&ui.pages(r#"{"offset":1,"limit":1,"sort":{"key":"url"}}"#)
			.unwrap(),
	);
	assert_eq!(urls(&window), ["/b.html"]);
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(page(&window, "/b.html").get("order").is_none());
	// assert_eq!(number(&page(&window, "/b.html"), "order"), 4.0); // previous
}

#[test]
fn rows_are_sorted_by_the_columns_a_row_always_has() {
	let site = Site::new("sort_builtin");
	site.write("src/index.html", "");
	site.write("src/b/index.html", "");
	site.write("src/b/deep/x.html", "");
	site.write("src/a.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/b/deep/x.html" } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	// Behavior change: the entries of `pages.overrides` no longer place a page (RFC section 6): the order of `pages` is the one `order` and the URLs make, a page before what hangs from it, the children in the natural order of their URLs
	assert_eq!(
		urls(&all(&mut ui)),
		["/", "/a.html", "/b/", "/b/deep/x.html"]
	);
	// assert_eq!(
	// 	urls(&all(&mut ui)),
	// 	["/b/deep/x.html", "/a.html", "/b/", "/"]
	// ); // previous
	// Behavior change: `order` is no column of a row (RFC section 14.2), so it is no sort key either
	assert!(
		ui.pages(r#"{"offset":0,"limit":100,"sort":{"key":"order"}}"#)
			.is_err()
	);
	// assert_eq!(
	// 	sorted_urls(&mut ui, "order", false),
	// 	["/b/deep/x.html", "/a.html", "/b/", "/"]
	// ); // previous
	// Behavior change: `order` is no column of a row (RFC section 14.2), so it is no sort key either
	assert!(
		ui.pages(r#"{"offset":0,"limit":100,"sort":{"key":"order","desc":true}}"#)
			.is_err()
	);
	// assert_eq!(
	// 	sorted_urls(&mut ui, "order", true),
	// 	["/", "/b/", "/a.html", "/b/deep/x.html"]
	// ); // previous
	// depth: `/` is 0, `/a.html` and `/b/` are 1, `/b/deep/x.html` is 3; equal ones keep the plan
	assert_eq!(
		sorted_urls(&mut ui, "depth", false),
		["/", "/a.html", "/b/", "/b/deep/x.html"]
	);
	assert_eq!(
		sorted_urls(&mut ui, "depth", true),
		["/b/deep/x.html", "/a.html", "/b/", "/"]
	);
	// parent: `/` has none and goes last either way
	assert_eq!(
		sorted_urls(&mut ui, "parent", false),
		["/a.html", "/b/", "/b/deep/x.html", "/"]
	);
	assert_eq!(
		sorted_urls(&mut ui, "parent", true),
		["/b/deep/x.html", "/a.html", "/b/", "/"]
	);
	// outputPath: the files below the output directory, directories before the files beside them
	assert_eq!(
		sorted_urls(&mut ui, "outputPath", false),
		["/", "/a.html", "/b/", "/b/deep/x.html"]
	);
	assert_eq!(
		sorted_urls(&mut ui, "outputPath", true),
		["/b/deep/x.html", "/b/", "/a.html", "/"]
	);
	assert!(
		ui.pages(r#"{"offset":0,"limit":1,"sort":{"key":"hashes"}}"#)
			.unwrap_err()
			// Behavior change: the sort keys do not include `order` any more (RFC section 14.2)
			.contains("`virtual`, `outputPath`, `parent`, `depth`") // .contains("`order`, `outputPath`, `parent`, `depth`") // previous
	);
}

// ---- a page that is made

#[test]
fn a_page_file_is_made_at_the_path_and_the_place_gives_the_url() {
	let site = Site::new("create_html");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	let before = number(&all(&mut ui), "version");
	let answer = create(&mut ui, None, Some("about/team/index.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/about/team/index.html"), "");
	let row = answer.get("page").unwrap();
	assert_eq!(row.get("url"), Some(&s("/about/team/")));
	assert_eq!(row.get("virtual"), Some(&Value::Bool(false)));
	assert!(
		row.get("hashes")
			.and_then(|h| h.get("input"))
			.is_some_and(|h| h.as_str().is_some())
	);
	assert!(has_page(&all(&mut ui), "/about/team/"));
	// one edit is one version, however the site was read again
	assert_eq!(number(&answer, "version"), before + 1.0);
	// the site builds its plan of what was written
	assert!(
		site.plan()
			.pages
			.iter()
			.any(|p| p.file.url == "/about/team/")
	);
}

#[test]
fn a_typed_path_is_folded_and_the_url_can_be_said_too() {
	let site = Site::new("create_typed");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	let answer = create(&mut ui, Some("/a/b.html"), Some("/a\\./x/../b.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/a/b.html"));
	assert_eq!(
		answer.get("page").unwrap().get("inputPath"),
		Some(&s(&format!("{}/src/a/b.html", site.root)))
	);
}

#[test]
fn a_module_that_is_made_is_a_page_that_renders_nothing() {
	let site = Site::new("create_tsx");
	site.write("src/index.html", "");
	let mut ui = site.open(r#", "pages": { "files": ["**/*.{html,tsx,jsx}"] }"#);
	for (path, url) in [("news/index.tsx", "/news/"), ("legacy.jsx", "/legacy.html")] {
		let answer = create(&mut ui, None, Some(path), "{}");
		assert!(ok(&answer), "{answer:?}");
		assert_eq!(
			site.read(&format!("src/{path}")),
			"export default function Page() {\n\treturn null;\n}\n"
		);
		assert_eq!(answer.get("page").unwrap().get("url"), Some(&s(url)));
	}
	// a key that is set next goes into the module as into any other
	let ex = expect_of(&mut ui, "/news/");
	let answer = change(
		&mut ui,
		"/news/",
		&ex,
		r#"{"op":"set","key":"title","value":"News"}"#,
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(
		site.read("src/news/index.tsx")
			.contains("export const meta = {")
	);
	assert!(site.plan().pages.iter().any(|p| p.file.url == "/news/"));
}

#[test]
fn a_url_that_is_not_the_one_of_the_place_is_refused_without_the_key_that_makes_urls() {
	let site = Site::new("create_mismatch");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	let answer = create(&mut ui, Some("/other/"), Some("about/index.html"), "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(!site.exists("src/about"));
}

#[test]
fn a_url_that_is_not_the_one_of_the_place_is_written_in_the_key_that_makes_urls() {
	let site = Site::new("create_field");
	site.write("src/index.html", "");
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let answer = create(&mut ui, Some("/company/"), Some("about/index.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/about/index.html"),
		"---\npath: /company/\n---\n"
	);
	assert_eq!(
		answer.get("page").unwrap().get("url"),
		Some(&s("/company/"))
	);
	let answer = create(&mut ui, Some("/staff/"), Some("team.tsx"), "{}");
	assert!(ok(&answer), "{answer:?}");
	let module = site.read("src/team.tsx");
	assert!(module.contains("path: \"/staff/\""), "{module}");
	assert!(module.contains("export default function Page()"));
	assert_eq!(answer.get("page").unwrap().get("url"), Some(&s("/staff/")));
	// the URL of the place needs no key
	let answer = create(&mut ui, Some("/plain.html"), Some("plain.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/plain.html"), "");
}

#[test]
fn a_page_is_not_made_where_it_would_not_be_a_page_or_something_is_in_the_way() {
	let site = Site::new("create_refused");
	site.write("src/index.html", "");
	site.write("src/taken.html", "x");
	site.write("src/side.json", "{}");
	site.write("src/skip/keep.txt", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v.html", "virtual": true } ] }"#,
	);
	let mut ui =
		site.open(r#", "pages": { "overrides": "pages.overrides.json", "ignore": ["skip/**"] }"#);
	for (path, url, expected) in [
		// no extension, a directory, an extension that is not a page's
		("about", None, "invalid"),
		("about/", None, "invalid"),
		("about.md", None, "invalid"),
		("", None, "invalid"),
		// outside the input directory, inside the output directory, ignored
		("../x.html", None, "invalid"),
		("../out/x.html", None, "invalid"),
		("skip/x.html", None, "invalid"),
		// a file is there; a `.json` is there, which the page would read as its sidecar
		("taken.html", None, "collision"),
		("side.html", None, "collision"),
		// the URL of a page that is there (a virtual one too)
		("v.html", None, "collision"),
		("x.html", Some("/a?b"), "invalid"),
		("x.html", Some("x.html"), "invalid"),
	] {
		let answer = create(&mut ui, url, Some(path), "{}");
		assert_eq!(code(&answer), expected, "{path} {url:?}: {answer:?}");
	}
	assert!(!site.exists("src/about"));
	assert!(!site.exists("src/about.md"));
	assert!(!site.exists("src/v.html"));
	assert!(!site.exists("src/x.html"));
	assert!(!site.exists("src/skip/x.html"));
	assert_eq!(site.read("src/taken.html"), "x");
}

#[test]
fn a_request_to_make_a_page_says_a_url_or_a_path() {
	let site = Site::new("create_request");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	assert!(
		ui.edit(r#"{"url":null,"change":{"op":"create","path":null}}"#)
			.unwrap_err()
			.contains("is required for \"create\"")
	);
	assert!(
		ui.edit(r#"{"change":{"op":"create","path":1}}"#)
			.unwrap_err()
			.contains("`change.path` must be a string or null")
	);
	// the other edits are of a page that is there, and name it
	assert!(
		ui.edit(r#"{"url":null,"change":{"op":"virtualize"}}"#)
			.unwrap_err()
			.contains("`url` (a string) is required")
	);
}

#[test]
fn a_virtual_page_is_made_as_an_entry_after_the_last_one() {
	let site = Site::new("create_virtual");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/\", \"meta\": { \"title\": \"Top\" } }\n\t]\n}\n",
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_overrides(&mut ui);
	let answer = create(&mut ui, Some("/service/"), None, &ex);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/\", \"meta\": { \"title\": \"Top\" } },\n\t\t{\"url\":\"/service/\",\"virtual\":true}\n\t]\n}\n"
	);
	let row = answer.get("page").unwrap();
	assert_eq!(row.get("virtual"), Some(&Value::Bool(true)));
	assert_eq!(row.get("inputPath"), Some(&Value::Null));
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(row.get("order").is_none());
	// assert_eq!(number(row, "order"), 2.0); // previous
	// the hash the answer has is the one the next edit of the file is checked against
	let ex = format!(
		r#"{{"overrides":{}}}"#,
		answer.get("overridesHash").unwrap().to_json()
	);
	let answer = create(&mut ui, Some("/service/price.html"), None, &ex);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		urls(&all(&mut ui)),
		["/", "/service/", "/service/price.html"]
	);
	assert!(
		site.plan()
			.pages
			.iter()
			.any(|p| p.file.url == "/service/" && p.is_virtual)
	);
}

#[test]
fn a_virtual_page_is_not_made_without_the_file_or_over_a_page_or_on_a_changed_file() {
	let site = Site::new("create_virtual_refused");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	let answer = create(&mut ui, Some("/v/"), None, "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(
		answer
			.get("message")
			.and_then(Value::as_str)
			.unwrap()
			.contains("pages.overrides")
	);

	let overrides = r#"{ "version": 1, "pages": [] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_overrides(&mut ui);
	for (url, expected) in [
		("/", "collision"),
		("/a/index.html", "invalid"),
		("/a//b/", "invalid"),
		("a/", "invalid"),
	] {
		let answer = create(&mut ui, Some(url), None, &ex);
		assert_eq!(code(&answer), expected, "{url}: {answer:?}");
	}
	// the hash is required, and it is the hash of the file as it is
	let answer = create(&mut ui, Some("/v/"), None, "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [ ] }"#);
	let answer = create(&mut ui, Some("/v/"), None, &ex);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ ] }"#
	);
}

// ---- a page that is made virtual

#[test]
fn a_page_made_virtual_keeps_its_url_and_its_metadata_in_pages_overrides() {
	let site = Site::new("virtualize");
	site.write("src/index.html", "");
	site.write(
		"src/service/web/index.html",
		"---\ntitle: Web\nnav: true\n---\n<p>body</p>\n",
	);
	site.write(
		"src/service/web/index.json",
		r#"{ "nav": false, "order": 3 }"#,
	);
	site.write(
		"pages.overrides.json",
		"{ \"version\": 1, \"pages\": [] }\n",
	);
	let mut ui = site.open(OVERRIDES);
	let before = number(&all(&mut ui), "version");
	let ex = expect_of(&mut ui, "/service/web/");
	let answer = change(&mut ui, "/service/web/", &ex, VIRTUALIZE);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(number(&answer, "version"), before + 1.0);
	assert!(!site.exists("src/service/web/index.html"));
	assert!(!site.exists("src/service/web/index.json"));
	// the directories the files leave empty go, up to the input directory
	assert!(!site.exists("src/service"));
	assert!(site.exists("src/index.html"));
	assert_eq!(
		site.read("pages.overrides.json"),
		"{ \"version\": 1, \"pages\": [{\"url\":\"/service/web/\",\"virtual\":true,\"meta\":{\"title\":\"Web\",\"nav\":false,\"order\":3}}] }\n"
	);
	let row = answer.get("page").unwrap();
	assert_eq!(row.get("url"), Some(&s("/service/web/")));
	assert_eq!(row.get("virtual"), Some(&Value::Bool(true)));
	assert_eq!(row.get("inputPath"), Some(&Value::Null));
	assert_eq!(cell(row, "title").get("value"), Some(&s("Web")));
	assert_eq!(cell(row, "title").get("origin"), Some(&s("overrides")));
	assert_eq!(cell(row, "nav").get("value"), Some(&Value::Bool(false)));
	assert_eq!(cell(row, "order").get("value"), Some(&Value::Number(3.0)));
	// nothing is left of the set-aside files
	assert!(!site.exists("src/service/web/.index.html.kamado-removed"));
	let plan = site.plan();
	let planned = plan
		.pages
		.iter()
		.find(|p| p.file.url == "/service/web/")
		.unwrap();
	assert!(planned.is_virtual);
}

#[test]
fn the_entry_a_page_has_already_is_the_one_made_virtual() {
	let site = Site::new("virtualize_entry");
	site.write("src/a.html", "---\ntitle: In file\nlayout: sub\n---\n");
	site.write("src/b.html", "");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/b.html\" },\n\t\t// a\n\t\t{ \"url\": \"/a.html\", \"meta\": { \"title\": \"Override\" }, \"lastmod\": \"2026-01-02\" }\n\t]\n}\n",
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/a.html"));
	// the keys of the entry keep their bytes; the keys of the file are added; the entry stays
	// where it is
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/b.html\" },\n\t\t// a\n\t\t{ \"url\": \"/a.html\", \"meta\": { \"title\": \"Override\", \"layout\": \"sub\" }, \"lastmod\": \"2026-01-02\", \"virtual\": true }\n\t]\n}\n"
	);
	let row = answer.get("page").unwrap();
	assert_eq!(cell(row, "title").get("value"), Some(&s("Override")));
	assert_eq!(cell(row, "layout").get("value"), Some(&s("sub")));
	// Behavior change: a row no longer carries a number for its place in the plan (RFC section 14.2): `order` is the meta key that places a page, shown as a column of the metadata
	assert!(row.get("order").is_none());
	// assert_eq!(number(row, "order"), 2.0); // previous
}

#[test]
fn the_key_that_makes_the_url_does_not_go_with_a_page_made_virtual() {
	let site = Site::new("virtualize_field");
	site.write("src/x.html", "---\npath: /moved/\ntitle: X\n---\n");
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	let ex = expect_of(&mut ui, "/moved/");
	let answer = change(&mut ui, "/moved/", &ex, VIRTUALIZE);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [{"url":"/moved/","virtual":true,"meta":{"title":"X"}}] }"#
	);
	assert_eq!(answer.get("page").unwrap().get("url"), Some(&s("/moved/")));
}

#[test]
fn a_page_is_not_made_virtual_when_it_cannot_be_or_a_file_has_changed() {
	let site = Site::new("virtualize_refused");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/a.html"));

	let overrides = r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true } ] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	// a virtual page is virtual already
	let ex = expect_of(&mut ui, "/v/");
	let answer = change(&mut ui, "/v/", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	// the hashes of the three files are required
	let answer = change(&mut ui, "/a.html", r#"{"input":null}"#, VIRTUALIZE);
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	// a page file that changed, a sidecar that appeared, a `pages.overrides` that changed
	let ex = expect_of(&mut ui, "/a.html");
	site.write("src/a.html", "---\ntitle: B\n---\n");
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	let ex = expect_of(&mut ui, "/a.html");
	site.write("src/a.json", "{}");
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	let ex = expect_of(&mut ui, "/a.html");
	site.write("pages.overrides.json", &format!("{overrides}\n"));
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "---\ntitle: B\n---\n");
	assert!(site.exists("src/a.json"));
	assert_eq!(site.read("pages.overrides.json"), format!("{overrides}\n"));
}

#[test]
fn a_url_that_a_virtual_page_cannot_have_is_not_made_virtual() {
	let site = Site::new("virtualize_url");
	// the key gives the page a URL that no place of a file gives
	site.write("src/x.html", "---\npath: /feed.xml\n---\n");
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	assert_eq!(urls(&all(&mut ui)), ["/feed.xml"]);
	let ex = expect_of(&mut ui, "/feed.xml");
	let answer = change(&mut ui, "/feed.xml", &ex, VIRTUALIZE);
	// an entry of that URL would be read as another page, and the plan would refuse the file
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/x.html"));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [] }"#
	);
}

// ---- a virtual page that is given a file

#[test]
fn a_virtual_page_given_a_path_becomes_a_page_file_with_its_metadata() {
	let site = Site::new("materialize");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/service/\", \"virtual\": true, \"meta\": { \"title\": \"Service\", \"nav\": false } },\n\t\t{ \"url\": \"/\" }\n\t]\n}\n",
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/service/");
	let answer = change(
		&mut ui,
		"/service/",
		&ex,
		&materialize(Some("service/index.html")),
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/service/index.html"),
		"---\ntitle: Service\nnav: false\n---\n"
	);
	// the entry goes: the page is its file now
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/\" }\n\t]\n}\n"
	);
	let row = answer.get("page").unwrap();
	assert_eq!(row.get("virtual"), Some(&Value::Bool(false)));
	assert_eq!(cell(row, "title").get("value"), Some(&s("Service")));
	assert_eq!(cell(row, "title").get("origin"), Some(&s("inFile")));
	assert_eq!(cell(row, "nav").get("value"), Some(&Value::Bool(false)));
	let planned = site.plan();
	assert!(
		planned
			.pages
			.iter()
			.any(|p| p.file.url == "/service/" && !p.is_virtual)
	);
}

#[test]
fn a_virtual_page_given_no_path_gets_the_file_its_url_names() {
	let site = Site::new("materialize_url");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/a/", "virtual": true }, { "url": "/b/c.html", "virtual": true, "meta": { "title": "C" } } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a/");
	let answer = change(&mut ui, "/a/", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/a/index.html"), "");
	let ex = expect_of(&mut ui, "/b/c.html");
	let answer = change(&mut ui, "/b/c.html", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/b/c.html"), "---\ntitle: C\n---\n");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [] }"#
	);
}

#[test]
fn the_file_of_a_url_is_the_first_kind_of_page_the_site_takes() {
	let site = Site::new("materialize_tsx");
	site.write("src/index.tsx", "export default () => null;\n");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/news/", "virtual": true, "meta": { "title": "News", "tags": ["a", "b"] } } ] }"#,
	);
	let mut ui =
		site.open(r#", "pages": { "overrides": "pages.overrides.json", "files": ["**/*.tsx"] }"#);
	let ex = expect_of(&mut ui, "/news/");
	let answer = change(&mut ui, "/news/", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	let module = site.read("src/news/index.tsx");
	assert!(module.contains("export const meta = {"), "{module}");
	assert!(
		module.contains("export default function Page()"),
		"{module}"
	);
	let row = answer.get("page").unwrap();
	assert_eq!(cell(row, "title").get("value"), Some(&s("News")));
	assert_eq!(
		cell(row, "tags").get("value"),
		Some(&Value::Array(vec![s("a"), s("b")]))
	);
}

#[test]
fn an_entry_that_says_more_than_the_page_stays_without_what_moved() {
	let site = Site::new("materialize_lastmod");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "virtual": true, "meta": { "title": "A" }, "lastmod": "2026-01-02" } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, &materialize(Some("a.html")));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/a.html"), "---\ntitle: A\n---\n");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "lastmod": "2026-01-02" } ] }"#
	);
	let row = answer.get("page").unwrap();
	assert_eq!(cell(row, "title").get("origin"), Some(&s("inFile")));
}

#[test]
fn a_virtual_page_is_not_given_a_file_that_makes_another_page_or_is_in_the_way() {
	let site = Site::new("materialize_refused");
	site.write("src/index.html", "");
	site.write("src/taken.html", "");
	let overrides = r#"{ "version": 1, "pages": [ { "url": "/a/", "virtual": true, "meta": { "__proto__": 1 } }, { "url": "/taken2.html", "virtual": true } ] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a/");
	// a page that has a file is not given one
	let real = expect_of(&mut ui, "/");
	let answer = change(&mut ui, "/", &real, &materialize(None));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	// the place gives another URL; a file is there; the name has no extension
	for (path, expected) in [
		("b/index.html", "invalid"),
		("taken.html", "collision"),
		("a/index", "invalid"),
		("../a/index.html", "invalid"),
	] {
		let answer = change(&mut ui, "/a/", &ex, &materialize(Some(path)));
		assert_eq!(code(&answer), expected, "{path}: {answer:?}");
	}
	// a key that a module cannot hold as a key stops the move, and nothing is written
	let answer = change(&mut ui, "/a/", &ex, &materialize(Some("a/index.tsx")));
	assert_eq!(code(&answer), "notEditable", "{answer:?}");
	assert!(
		answer
			.get("message")
			.and_then(Value::as_str)
			.unwrap()
			.contains("__proto__"),
		"{answer:?}"
	);
	assert!(!site.exists("src/a"));
	assert!(!site.exists("src/b"));
	assert_eq!(site.read("pages.overrides.json"), overrides);
	// the hash of `pages.overrides` is required
	let answer = change(&mut ui, "/taken2.html", "{}", &materialize(None));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
}

// ---- a page that is removed

#[test]
fn a_page_that_is_removed_leaves_no_file_and_no_entry() {
	let site = Site::new("delete");
	site.write("src/index.html", "");
	site.write("src/a/b/index.html", "---\ntitle: B\n---\n");
	site.write("src/a/b/index.json", "{}");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a/b/\", \"meta\": { \"nav\": true } },\n\t\t{ \"url\": \"/\" }\n\t]\n}\n",
	);
	let mut ui = site.open(OVERRIDES);
	let before = number(&all(&mut ui), "version");
	let ex = expect_of(&mut ui, "/a/b/");
	let answer = change(&mut ui, "/a/b/", &ex, DELETE_PAGE);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(answer.get("page"), Some(&Value::Null));
	assert_eq!(number(&answer, "version"), before + 1.0);
	assert!(answer.get("overridesHash").unwrap().as_str().is_some());
	assert!(!site.exists("src/a"));
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/\" }\n\t]\n}\n"
	);
	assert_eq!(urls(&all(&mut ui)), ["/"]);
	assert_eq!(site.plan().pages.len(), 1);
	// the page is gone for the next edit
	let answer = change(&mut ui, "/a/b/", &ex, DELETE_PAGE);
	assert_eq!(code(&answer), "notFound", "{answer:?}");
}

#[test]
fn a_page_without_an_entry_is_removed_without_the_hash_of_pages_overrides() {
	let site = Site::new("delete_plain");
	site.write("src/index.html", "");
	site.write("src/a.html", "");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let hash = page(&rows, "/a.html")
		.get("hashes")
		.and_then(|h| h.get("input"))
		.unwrap()
		.to_json();
	let answer = change(
		&mut ui,
		"/a.html",
		&format!(r#"{{"input":{hash},"sidecar":null}}"#),
		DELETE_PAGE,
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(answer.get("overridesHash"), Some(&Value::Null));
	assert!(!site.exists("src/a.html"));
	assert!(site.exists("src/index.html"));
}

#[test]
fn a_virtual_page_that_is_removed_is_an_entry_that_is_removed() {
	let site = Site::new("delete_virtual");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true }, { "url": "/w/", "virtual": true } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/v/");
	let answer = change(&mut ui, "/v/", &ex, DELETE_PAGE);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/w/", "virtual": true } ] }"#
	);
	// Behavior change: the entries of `pages.overrides` no longer place a page (RFC section 6): the order of `pages` is the one `order` and the URLs make, a page before what hangs from it, the children in the natural order of their URLs
	assert_eq!(urls(&all(&mut ui)), ["/", "/w/"]);
	// assert_eq!(urls(&all(&mut ui)), ["/w/", "/"]); // previous
}

#[test]
fn a_page_is_not_removed_when_a_file_has_changed() {
	let site = Site::new("delete_conflict");
	site.write("src/a.html", "a");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/a.html" } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	site.write("src/a.html", "b");
	let answer = change(&mut ui, "/a.html", &ex, DELETE_PAGE);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "b");
	// `current` has the hashes of the files as they are, so the next request passes
	let current = answer.get("current").unwrap();
	let input = current
		.get("hashes")
		.and_then(|h| h.get("input"))
		.unwrap()
		.to_json();
	let ex = format!(
		r#"{{"input":{input},"sidecar":null,"overrides":{}}}"#,
		all(&mut ui).get("overridesHash").unwrap().to_json()
	);
	// the entry of the page goes with it, so the hash of `pages.overrides` is required
	let answer = change(
		&mut ui,
		"/a.html",
		&format!(r#"{{"input":{input},"sidecar":null}}"#),
		DELETE_PAGE,
	);
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/a.html"));
	let answer = change(&mut ui, "/a.html", &ex, DELETE_PAGE);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/a.html"));
}

// ---- all or nothing

#[test]
fn files_that_are_removed_come_back_as_they_were_when_a_later_change_fails() {
	let site = Site::new("txn_remove");
	site.write("page.html", "page");
	site.write("page.json", "{}");
	site.write("dir/keep.txt", "");
	let root = &site.root;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(
			format!("{root}/page.html"),
			fs::Permissions::from_mode(0o640),
		)
		.unwrap();
	}
	let txn = Txn {
		removes: vec![format!("{root}/page.html"), format!("{root}/page.json")],
		writes: vec![
			(format!("{root}/new/deep/made.txt"), "made".to_string()),
			// a directory cannot be written as a file
			(format!("{root}/dir"), "x".to_string()),
		],
		..Txn::default()
	};
	let failed = txn.commit().unwrap_err();
	assert_eq!(failed.code, "io");
	assert_eq!(site.read("page.html"), "page");
	assert_eq!(site.read("page.json"), "{}");
	assert!(!site.exists(".page.html.kamado-removed"));
	assert!(!site.exists(".page.json.kamado-removed"));
	// the directories made for a new file go with it
	assert!(!site.exists("new"));
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mode = fs::metadata(format!("{root}/page.html"))
			.unwrap()
			.permissions()
			.mode();
		assert_eq!(mode & 0o777, 0o640);
	}
}

#[cfg(unix)]
#[test]
fn a_page_below_a_directory_that_is_a_link_is_not_removed() {
	let site = Site::new("remove_linked_dir");
	site.write("src/index.html", "");
	site.write("elsewhere/x.html", "---\ntitle: X\n---\nbody\n");
	std::os::unix::fs::symlink(
		format!("{}/elsewhere", site.root),
		format!("{}/src/shared", site.root),
	)
	.unwrap();
	let overrides = r#"{ "version": 1, "pages": [] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	assert!(has_page(&all(&mut ui), "/shared/x.html"));
	for op in [VIRTUALIZE, DELETE_PAGE] {
		let ex = expect_of(&mut ui, "/shared/x.html");
		let answer = change(&mut ui, "/shared/x.html", &ex, op);
		assert_eq!(code(&answer), "invalid", "{op}: {answer:?}");
	}
	assert_eq!(site.read("elsewhere/x.html"), "---\ntitle: X\n---\nbody\n");
	assert_eq!(site.read("pages.overrides.json"), overrides);
}

#[cfg(unix)]
#[test]
fn a_page_file_that_is_a_link_is_removed_as_the_link() {
	let site = Site::new("remove_linked_file");
	site.write("src/index.html", "");
	site.write("elsewhere/x.html", "---\ntitle: X\n---\n");
	std::os::unix::fs::symlink(
		format!("{}/elsewhere/x.html", site.root),
		format!("{}/src/x.html", site.root),
	)
	.unwrap();
	let mut ui = site.open("");
	let ex = expect_of(&mut ui, "/x.html");
	let answer = change(&mut ui, "/x.html", &ex, DELETE_PAGE);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/x.html"));
	assert_eq!(site.read("elsewhere/x.html"), "---\ntitle: X\n---\n");
}

#[cfg(unix)]
#[test]
fn a_link_that_is_removed_comes_back_as_a_link() {
	let site = Site::new("txn_remove_link");
	site.write("target.html", "target");
	let root = &site.root;
	std::os::unix::fs::symlink(format!("{root}/target.html"), format!("{root}/link.html")).unwrap();
	let txn = Txn {
		removes: vec![format!("{root}/link.html")],
		writes: vec![(format!("{root}/target.html/x"), "x".to_string())],
		..Txn::default()
	};
	assert_eq!(txn.commit().unwrap_err().code, "io");
	assert!(
		fs::symlink_metadata(format!("{root}/link.html"))
			.unwrap()
			.file_type()
			.is_symlink()
	);
	// removing the link removes the link and not what it leads to
	let txn = Txn {
		removes: vec![format!("{root}/link.html")],
		..Txn::default()
	};
	txn.commit().unwrap();
	assert!(!site.exists("link.html"));
	assert_eq!(site.read("target.html"), "target");
}

#[test]
fn a_set_aside_file_that_was_left_behind_is_not_in_the_way_and_is_not_touched() {
	let site = Site::new("txn_remove_taken");
	site.write("page.html", "page");
	site.write(
		".page.html.kamado-removed",
		"left by an editor that was stopped",
	);
	site.write(".page.html.kamado-removed.1", "and another");
	let root = &site.root;
	assert_eq!(
		set_aside_name(&format!("{root}/page.html")),
		format!("{root}/.page.html.kamado-removed.2")
	);
	let txn = Txn {
		removes: vec![format!("{root}/page.html")],
		..Txn::default()
	};
	txn.commit().unwrap();
	assert!(!site.exists("page.html"));
	assert!(!site.exists(".page.html.kamado-removed.2"));
	assert_eq!(
		site.read(".page.html.kamado-removed"),
		"left by an editor that was stopped"
	);
	assert_eq!(site.read(".page.html.kamado-removed.1"), "and another");
	// and a change that fails puts the file back under its own name
	site.write("page.html", "again");
	site.write("dir/keep.txt", "");
	let txn = Txn {
		removes: vec![format!("{root}/page.html")],
		writes: vec![(format!("{root}/dir"), "x".to_string())],
		..Txn::default()
	};
	assert_eq!(txn.commit().unwrap_err().code, "io");
	assert_eq!(site.read("page.html"), "again");
	assert!(!site.exists(".page.html.kamado-removed.2"));
}

#[test]
fn an_entry_written_since_the_pages_were_read_is_not_left_without_its_page() {
	let site = Site::new("delete_stale_entry");
	site.write("src/a.html", "a");
	site.write("src/b.html", "b");
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	// someone gives the page an entry after the editor read the site
	let with_entry =
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "meta": { "title": "A" } } ] }"#;
	site.write("pages.overrides.json", with_entry);
	let answer = change(&mut ui, "/a.html", &ex, DELETE_PAGE);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "a");
	assert_eq!(site.read("pages.overrides.json"), with_entry);
	// with the file as it is now, the page goes and its entry with it
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, DELETE_PAGE);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/a.html"));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [] }"#
	);
	assert_eq!(site.plan().pages.len(), 1);
}

#[test]
fn a_key_is_set_in_an_entry_whose_meta_is_null() {
	let site = Site::new("set_null_meta");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": null } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/v/");
	let answer = change(
		&mut ui,
		"/v/",
		&ex,
		r#"{"op":"set","key":"title","value":"V"}"#,
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": {"title":"V"} } ] }"#
	);
	assert_eq!(
		cell(answer.get("page").unwrap(), "title").get("value"),
		Some(&s("V"))
	);
	// and the next key goes into the `meta` that was made
	let ex = expect_of(&mut ui, "/v/");
	let answer = change(
		&mut ui,
		"/v/",
		&ex,
		r#"{"op":"set","key":"nav","value":true}"#,
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": {"title":"V","nav":true} } ] }"#
	);
}

#[test]
fn an_entry_whose_meta_is_null_takes_the_keys_of_the_page_made_virtual() {
	let site = Site::new("virtualize_null_meta");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "meta": null } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "meta": {"title":"A"}, "virtual": true } ] }"#
	);
	assert_eq!(
		cell(answer.get("page").unwrap(), "title").get("value"),
		Some(&s("A"))
	);
}

#[test]
fn the_file_of_a_url_is_not_one_whose_place_is_taken() {
	let site = Site::new("materialize_taken");
	// the file at the place of `/about/` is the page `/company/`, by the key that makes URLs
	site.write("src/about/index.html", "---\npath: /company/\n---\n");
	// and a `.json` is where a module of `/news/` would look for its sidecar
	site.write("src/news/index.json", "{}");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/about/", "virtual": true }, { "url": "/news/", "virtual": true } ] }"#,
	);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	let ex = expect_of(&mut ui, "/about/");
	let answer = change(&mut ui, "/about/", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	// the next kind of page the site takes, where nothing is
	assert!(site.exists("src/about/index.tsx"));
	assert_eq!(
		site.read("src/about/index.html"),
		"---\npath: /company/\n---\n"
	);
	// every place of `/news/` has the `.json` beside it: the path has to be said
	let ex = expect_of(&mut ui, "/news/");
	let answer = change(&mut ui, "/news/", &ex, &materialize(None));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(!site.exists("src/news/index.html"));
	assert!(!site.exists("src/news/index.tsx"));
}

#[test]
fn a_page_made_virtual_is_as_it_was_when_pages_overrides_cannot_be_written() {
	let site = Site::new("virtualize_undo");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/a.json", "{}");
	let overrides = r#"{ "version": 1, "pages": [] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	let path = format!("{}/pages.overrides.json", site.root);
	let mut permissions = fs::metadata(&path).unwrap().permissions();
	permissions.set_readonly(true);
	fs::set_permissions(&path, permissions).unwrap();
	// A user that can write a file marked read-only (root) cannot make the write fail this way.
	if fs::OpenOptions::new().append(true).open(&path).is_ok() {
		return;
	}
	let answer = change(&mut ui, "/a.html", &ex, VIRTUALIZE);
	assert_eq!(code(&answer), "io", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "---\ntitle: A\n---\n");
	assert_eq!(site.read("src/a.json"), "{}");
	assert_eq!(site.read("pages.overrides.json"), overrides);
	assert!(!site.exists("src/.a.html.kamado-removed"));
}

#[test]
fn a_page_made_virtual_is_as_it_was_when_its_sidecar_cannot_be_set_aside() {
	// The name a file is set aside under is 16 bytes longer than its own. A page `x.htm` whose
	// set-aside name is as long as a name can be (255 bytes) has a sidecar `x.json` whose
	// set-aside name is one byte too long: the page file is set aside, the sidecar is not, and
	// the page file comes back. (No permission is involved, so this fails for any user.)
	let stem = "p".repeat(235);
	let site = Site::new("virtualize_undo_long");
	site.write(&format!("src/{stem}.htm"), "---\ntitle: Long\n---\n");
	site.write(&format!("src/{stem}.json"), "{}");
	let overrides = r#"{ "version": 1, "pages": [] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(
		r#", "pages": { "overrides": "pages.overrides.json", "files": ["**/*.{html,htm}"] }"#,
	);
	let url = format!("/{stem}.html");
	let ex = expect_of(&mut ui, &url);
	for op in [VIRTUALIZE, DELETE_PAGE] {
		let answer = change(&mut ui, &url, &ex, op);
		assert_eq!(code(&answer), "io", "{op}: {answer:?}");
		assert_eq!(
			site.read(&format!("src/{stem}.htm")),
			"---\ntitle: Long\n---\n"
		);
		assert_eq!(site.read(&format!("src/{stem}.json")), "{}");
		assert!(!site.exists(&format!("src/.{stem}.htm.kamado-removed")));
		assert_eq!(site.read("pages.overrides.json"), overrides);
	}
	// the page is still a page with its file
	assert_eq!(
		page(&all(&mut ui), &url).get("virtual"),
		Some(&Value::Bool(false))
	);
}

#[test]
fn a_set_aside_file_that_cannot_be_removed_is_left_and_told_not_undone() {
	let site = Site::new("txn_remove_left");
	site.write("new.txt", "old");
	// A directory is set aside by a rename like a file, and is not removed by the removal of a
	// file: the one step that fails, for any user.
	site.write("keep/inside.txt", "inside");
	let root = &site.root;
	let txn = Txn {
		removes: vec![format!("{root}/keep")],
		writes: vec![(format!("{root}/new.txt"), "written".to_string())],
		..Txn::default()
	};
	let left = txn.commit().unwrap();
	// the edit is made: what was written stays, and the directory has the other name
	assert_eq!(site.read("new.txt"), "written");
	assert!(!site.exists("keep"));
	assert_eq!(site.read(".keep.kamado-removed/inside.txt"), "inside");
	assert_eq!(left.len(), 1, "{left:?}");
	assert!(
		left[0].starts_with(&format!("{root}/.keep.kamado-removed (")),
		"{left:?}"
	);
}

#[test]
fn the_answer_to_an_edit_that_left_a_file_behind_says_so_once() {
	let site = Site::new("answer_warning");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	ui.left_behind = vec!["/x/.a.html.kamado-removed (Is a directory)".to_string()];
	let answer = json(&ui.ok_json(None));
	let warning = answer.get("warning").and_then(Value::as_str).unwrap();
	assert!(
		warning.contains("/x/.a.html.kamado-removed (Is a directory)"),
		"{warning}"
	);
	assert!(warning.contains("the edit was made"), "{warning}");
	// the next edit begins with nothing left behind
	let ex = {
		let rows = all(&mut ui);
		let row = page(&rows, "/a.html");
		format!(
			r#"{{"input":{},"sidecar":null}}"#,
			row.get("hashes").unwrap().get("input").unwrap().to_json()
		)
	};
	let answer = change(
		&mut ui,
		"/a.html",
		&ex,
		r#"{"op":"set","key":"title","value":"B"}"#,
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(answer.get("warning"), None);
	// and an answer without anything left behind has no warning
	assert_eq!(json(&ui.ok_json(None)).get("warning"), None);
}

#[test]
fn every_extension_a_page_is_made_with_is_a_kind_of_page() {
	for ext in PAGE_EXTENSIONS {
		assert!(crate::page_kind(ext).is_ok(), "{ext}");
		assert_eq!(
			typed_new_path(&format!("a/b{ext}")).unwrap(),
			format!("a/b{ext}")
		);
	}
	let refused = typed_new_path("a/b.md").unwrap_err();
	assert_eq!(refused.code, "invalid");
	assert!(
		refused.message.contains("(.html, .tsx, .jsx, .htm)"),
		"{}",
		refused.message
	);
}

#[test]
fn a_page_is_made_with_htm_and_with_an_extension_in_capitals() {
	let site = Site::new("create_htm");
	site.write("src/index.html", "");
	let mut ui = site.open(r#", "pages": { "files": ["**/*.{html,htm,HTML}"] }"#);
	let answer = create(&mut ui, None, Some("old.htm"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/old.htm"), "");
	assert_eq!(
		answer.get("page").unwrap().get("url"),
		Some(&s("/old.html"))
	);
	let answer = create(&mut ui, None, Some("LOUD.HTML"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/LOUD.HTML"), "");
}

#[test]
fn a_module_made_virtual_leaves_the_keys_of_its_meta_in_pages_overrides() {
	let site = Site::new("virtualize_tsx");
	site.write("src/index.html", "");
	site.write(
		"src/news/index.tsx",
		"export const meta = { title: 'News', tags: ['a', 'b'] };\nexport default () => null;\n",
	);
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/news/");
	let answer = change(&mut ui, "/news/", &ex, VIRTUALIZE);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/news"));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [{"url":"/news/","virtual":true,"meta":{"title":"News","tags":["a","b"]}}] }"#
	);
}

#[test]
fn a_virtual_page_given_a_file_counts_one_version_and_minds_a_changed_pages_overrides() {
	let site = Site::new("materialize_conflict");
	site.write("src/index.html", "");
	let overrides = r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true } ] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/v/");
	site.write("pages.overrides.json", &format!("{overrides}\n"));
	for op in [materialize(None), DELETE_PAGE.to_string()] {
		let answer = change(&mut ui, "/v/", &ex, &op);
		assert_eq!(code(&answer), "conflict", "{op}: {answer:?}");
		assert!(!site.exists("src/v"));
		assert_eq!(site.read("pages.overrides.json"), format!("{overrides}\n"));
	}
	let before = number(&all(&mut ui), "version");
	let ex = expect_of(&mut ui, "/v/");
	let answer = change(&mut ui, "/v/", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(number(&answer, "version"), before + 1.0);
}

#[test]
fn an_entry_with_only_a_lastmod_stays_when_its_page_is_given_a_file() {
	let site = Site::new("materialize_lastmod_only");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "virtual": true, "lastmod": "2026-01-02" } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/a.html");
	let answer = change(&mut ui, "/a.html", &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/a.html"), "");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/a.html", "lastmod": "2026-01-02" } ] }"#
	);
}

#[test]
fn the_key_that_makes_urls_is_written_for_a_file_that_is_somewhere_else_and_is_not_moved_from_the_entry()
 {
	let site = Site::new("materialize_field");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/company/", "virtual": true, "meta": { "path": "/ignored/", "title": "Company" } } ] }"#,
	);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	let ex = expect_of(&mut ui, "/company/");
	// the file is not where the URL says: the key says the URL
	let answer = change(
		&mut ui,
		"/company/",
		&ex,
		&materialize(Some("about/index.html")),
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/about/index.html"),
		"---\npath: /company/\ntitle: Company\n---\n"
	);
	// the key of the entry would make the URL if it were in the file: it stays in the entry,
	// which stays without `virtual` and without the key that moved
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{ "version": 1, "pages": [ { "url": "/company/", "meta": { "path": "/ignored/" } } ] }"#
	);
	let row = answer.get("page").unwrap();
	assert_eq!(row.get("url"), Some(&s("/company/")));
	assert_eq!(row.get("virtual"), Some(&Value::Bool(false)));
	assert!(
		site.plan()
			.pages
			.iter()
			.any(|p| p.file.url == "/company/" && !p.is_virtual)
	);
}

#[test]
fn a_url_the_key_that_makes_urls_cannot_say_is_refused() {
	let site = Site::new("create_field_refused");
	site.write("src/index.html", "");
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	// read as the value of the key, `/x` is the page `/x.html`: not the URL that was asked for
	let answer = create(&mut ui, Some("/x"), Some("a.html"), "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(
		answer
			.get("message")
			.and_then(Value::as_str)
			.unwrap()
			.contains("\"path\""),
		"{answer:?}"
	);
	assert!(!site.exists("src/a.html"));
}

#[test]
fn a_page_is_not_made_where_its_output_would_be_a_source_file() {
	// the sources are inside the output directory, so an output path can be a source file
	let site = Site::new("create_over_source");
	site.write("out/src/a.html", "a");
	site.write(
		"out/pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/src/later.html", "virtual": true } ] }"#,
	);
	let mut ui = site.open_config(
		r#"{ "dir": { "input": "out/src", "output": "out" }, "build": { "cacheDir": ".cache" }, "pages": { "overrides": "out/pages.overrides.json" } }"#,
	);
	// a page file whose output is the source of `/a.html`
	let answer = create(&mut ui, None, Some("src/a.html"), "{}");
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert!(!site.exists("out/src/src"));
	// a virtual page whose output would be that source
	let ex = expect_overrides(&mut ui);
	let answer = create(&mut ui, Some("/src/a.html"), None, &ex);
	assert_eq!(code(&answer), "collision", "{answer:?}");
	// a virtual page whose output became a source after it was written: no file is given to it
	site.write("out/src/later.html", "later");
	ui.refresh().unwrap();
	let ex = expect_of(&mut ui, "/src/later.html");
	let answer = change(
		&mut ui,
		"/src/later.html",
		&ex,
		&materialize(Some("src/later.html")),
	);
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert!(!site.exists("out/src/src"));
}

#[test]
fn a_request_for_a_page_says_its_path_and_its_url_as_text() {
	let site = Site::new("page_request");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	assert!(
		ui.edit(r#"{"url":"/","change":{"op":"materialize","path":1}}"#)
			.unwrap_err()
			.contains("`change.path` must be a string or null for \"materialize\"")
	);
	assert!(
		ui.edit(r#"{"url":1,"change":{"op":"create","path":"a.html"}}"#)
			.unwrap_err()
			.contains("`url` (a string) is required")
	);
}

// ---- the characters a name written by a person must not have

/// What a name must not have in a URL, and how the message shows it.
const UNFIT: [(&str, &str); 9] = [
	("\\", "\\\\"),
	("\n", "\\n"),
	("\t", "\\t"),
	("\u{7f}", "\\u{7f}"),
	("\u{85}", "\\u{85}"),
	("\u{202e}", "\\u{202e}"),
	("\u{200b}", "\\u{200b}"),
	("\u{feff}", "\\u{feff}"),
	("\0", "\\u{0}"),
];

/// The ones of [`UNFIT`] that a typed path can have: `\` in a path is a `/` (folded), and a NUL
/// is refused as the NUL of a path, as it is for every typed path.
fn unfit_in_a_path() -> impl Iterator<Item = (&'static str, &'static str)> {
	UNFIT.into_iter().filter(|(c, _)| *c != "\\" && *c != "\0")
}

fn message(answer: &Value) -> String {
	answer
		.get("message")
		.and_then(Value::as_str)
		.unwrap_or_else(|| panic!("no message in {answer:?}"))
		.to_string()
}

/// Whether the refusal names the character as the RFC says, as `has the character \u{202e},`.
/// (The name is in the message too, written with `{:?}`, so the character alone would be found
/// there whether or not the refusal names it.)
fn has_character(answer: &Value, shown: &str) -> bool {
	message(answer).contains(&format!("has the character {shown},"))
}

/// The characters a name must not have, as ranges (the RFC lists them).
const REFUSED: [(u32, u32); 19] = [
	(0x00, 0x1f),
	(0x5c, 0x5c),
	(0x7f, 0x9f),
	(0xad, 0xad),
	(0x61c, 0x61c),
	(0x115f, 0x1160),
	(0x17b4, 0x17b5),
	(0x180e, 0x180e),
	(0x200b, 0x200b),
	(0x200e, 0x200f),
	(0x2028, 0x2029),
	(0x202a, 0x202e),
	(0x2060, 0x206f),
	(0x3164, 0x3164),
	(0xfeff, 0xfeff),
	(0xffa0, 0xffa0),
	(0xfff0, 0xfffb),
	(0x1bca0, 0x1bca3),
	(0x1d173, 0x1d17a),
];

#[test]
fn the_characters_a_name_must_not_have_are_the_ones_of_the_rfc() {
	let in_a_range = |u: u32| REFUSED.iter().any(|(a, b)| (*a..=*b).contains(&u));
	for (first, last) in REFUSED {
		for u in first..=last {
			let c = char::from_u32(u).unwrap();
			let why = check_name("the name", &format!("a{c}b")).unwrap_err();
			assert_eq!(why.code, "invalid", "{u:x}");
			assert!(
				why.message
					.contains(&format!("has the character {},", c.escape_default())),
				"{u:x}: {}",
				why.message
			);
		}
		// the character next to each end of a range is a name, unless another range is there
		for u in [first.checked_sub(1), Some(last + 1)].into_iter().flatten() {
			let c = char::from_u32(u).unwrap();
			assert_eq!(
				check_name("the name", &format!("a{c}b")).is_err(),
				in_a_range(u),
				"{u:x}"
			);
		}
	}
	// what looks like a space and is shown, the joiners and marks that letters need, a variation
	// selector, the tag characters, and the characters next to the ranges above
	for u in (0x2000..=0x200a).chain([
		0xa0, 0x1680, 0x202f, 0x205f, 0x2800, 0x3000, 0x200c, 0x200d, 0x34f, 0xfe0f, 0x180b,
		0x180c, 0x180d, 0x180f, 0xe0100, 0xe0001, 0xe0020, 0xe007f, 0xfffc, 0x115e, 0x1161, 0x3163,
		0x3165, 0xffa1, 0x2027, 0x2070, 0x1bc9f, 0x1bca4, 0x1d172, 0x1d17b, 0x17b3, 0x17b6, 0x2c,
		0x2d, 0x2e, 0x61, 0x65e5,
	]) {
		let c = char::from_u32(u).unwrap();
		assert!(check_name("the name", &format!("a{c}b")).is_ok(), "{u:x}");
	}
	for ok in [
		"flag-\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}",
		"日本語 の ページ",
		"emoji-\u{1f468}\u{200d}\u{1f469}",
		"a b.html",
	] {
		assert!(check_name("the name", ok).is_ok(), "{ok:?}");
	}
}

#[test]
fn a_virtual_page_is_not_made_at_a_url_with_a_character_a_name_must_not_have() {
	let site = Site::new("create_url_chars");
	site.write("src/index.html", "");
	let overrides = r#"{ "version": 1, "pages": [] }"#;
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	for (c, shown) in UNFIT {
		let url = format!("/x{c}y.html");
		let ex = expect_overrides(&mut ui);
		let answer = create(&mut ui, Some(&url), None, &ex);
		assert_eq!(code(&answer), "invalid", "{shown}: {answer:?}");
		assert!(has_character(&answer, shown), "{shown}: {answer:?}");
		assert!(!message(&answer).contains("already exists"), "{answer:?}");
	}
	assert_eq!(site.read("pages.overrides.json"), overrides);
}

#[test]
fn a_page_file_is_not_made_at_a_path_with_a_character_a_name_must_not_have() {
	let site = Site::new("create_path_chars");
	site.write("src/index.html", "");
	let mut ui = site.open("");
	for (c, shown) in unfit_in_a_path() {
		let answer = create(&mut ui, None, Some(&format!("dir/x{c}y.html")), "{}");
		assert_eq!(code(&answer), "invalid", "{shown}: {answer:?}");
		assert!(has_character(&answer, shown), "{shown}: {answer:?}");
	}
	// a NUL is the NUL of a path, as it is for every typed path
	let answer = create(&mut ui, None, Some("dir/x\0y.html"), "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(message(&answer).contains("NUL"), "{answer:?}");
	assert!(!site.exists("src/dir"));
	// a backslash in a path is a slash: the file is made in the directory
	let answer = create(&mut ui, None, Some("dir\\x.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/dir/x.html"), "");
	// a segment that `..` folds away is no name of the file
	let answer = create(&mut ui, None, Some("gone\u{200b}/../kept.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/kept.html"), "");
}

#[test]
fn the_url_said_for_a_page_file_is_a_name_too_with_or_without_the_key_that_makes_urls() {
	// With the key, a URL that is not the one of the place would be written in it, so the
	// refusal must come from the URL, not from the URL and the place being two.
	for (n, config) in ["", r#", "pages": { "outputPathField": "slug" }"#]
		.into_iter()
		.enumerate()
	{
		let site = Site::new(&format!("create_url_and_path_chars_{n}"));
		site.write("src/index.html", "");
		let mut ui = site.open(config);
		for (c, shown) in UNFIT {
			let answer = create(
				&mut ui,
				Some(&format!("/x{c}y.html")),
				Some("ok.html"),
				"{}",
			);
			assert_eq!(code(&answer), "invalid", "{n} {shown}: {answer:?}");
			assert!(has_character(&answer, shown), "{n} {shown}: {answer:?}");
		}
		assert!(!site.exists("src/ok.html"), "{n}");
	}
}

#[test]
fn a_name_with_the_ideographic_space_or_a_joiner_is_made_moved_to_and_given() {
	let site = Site::new("allowed_chars");
	site.write("src/index.html", "");
	site.write("src/m.html", "m");
	site.write("src/n.html", "n");
	site.write(
		"pages.overrides.json",
		"{ \"version\": 1, \"pages\": [ { \"url\": \"/h\u{3000}i.html\", \"virtual\": true } ] }",
	);
	let mut ui = site.open(OVERRIDES);
	// made
	let answer = create(&mut ui, None, Some("全角\u{3000}名前.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/全角\u{3000}名前.html"), "");
	let answer = create(&mut ui, None, Some("a\u{200d}b.html"), "{}");
	assert!(ok(&answer), "{answer:?}");
	let ex = expect_overrides(&mut ui);
	let answer = create(&mut ui, Some("/v\u{3000}w.html"), None, &ex);
	assert!(ok(&answer), "{answer:?}");
	assert!(
		site.read("pages.overrides.json")
			.contains("/v\u{3000}w.html")
	);
	// moved to
	let ex = expect_of(&mut ui, "/m.html");
	let answer = change(
		&mut ui,
		"/m.html",
		&ex,
		&format!(
			r#"{{"op":"moveUrl","url":{}}}"#,
			s("/m\u{3000}2.html").to_json()
		),
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/m\u{3000}2.html"), "m");
	let ex = expect_of(&mut ui, "/n.html");
	let answer = change(
		&mut ui,
		"/n.html",
		&ex,
		&format!(
			r#"{{"op":"movePath","path":{}}}"#,
			s("n\u{200d}2.html").to_json()
		),
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/n\u{200d}2.html"), "n");
	// given: the place the URL of a virtual page names
	let url = "/h\u{3000}i.html";
	let ex = expect_of(&mut ui, url);
	let answer = change(&mut ui, url, &ex, &materialize(None));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/h\u{3000}i.html"), "");
}

#[test]
fn a_page_is_not_moved_to_a_url_or_a_path_with_a_character_a_name_must_not_have() {
	let site = Site::new("move_chars");
	site.write("src/index.html", "");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	for (c, shown) in UNFIT {
		let ex = expect_of(&mut ui, "/a.html");
		let answer = change(
			&mut ui,
			"/a.html",
			&ex,
			&format!(
				r#"{{"op":"moveUrl","url":{}}}"#,
				s(&format!("/m{c}n.html")).to_json()
			),
		);
		assert_eq!(code(&answer), "invalid", "moveUrl {shown}: {answer:?}");
		assert!(has_character(&answer, shown), "moveUrl {shown}: {answer:?}");
	}
	for (c, shown) in unfit_in_a_path() {
		let ex = expect_of(&mut ui, "/a.html");
		let answer = change(
			&mut ui,
			"/a.html",
			&ex,
			&format!(
				r#"{{"op":"movePath","path":{}}}"#,
				s(&format!("m{c}n.html")).to_json()
			),
		);
		assert_eq!(code(&answer), "invalid", "movePath {shown}: {answer:?}");
		assert!(
			has_character(&answer, shown),
			"movePath {shown}: {answer:?}"
		);
	}
	assert_eq!(site.read("src/a.html"), "a");
	assert_eq!(
		fs::read_dir(format!("{}/src", site.root)).unwrap().count(),
		2
	);
}

#[test]
fn a_virtual_page_is_not_given_a_file_with_a_character_a_name_must_not_have() {
	let site = Site::new("materialize_chars");
	site.write("src/index.html", "");
	// the entry is read as it is (a name is only refused when a file is made of it)
	let overrides =
		"{ \"version\": 1, \"pages\": [ { \"url\": \"/b\u{202e}c.html\", \"virtual\": true } ] }";
	site.write("pages.overrides.json", overrides);
	let mut ui = site.open(OVERRIDES);
	let url = "/b\u{202e}c.html";
	assert!(has_page(&all(&mut ui), url));
	// the place the URL names
	let ex = expect_of(&mut ui, url);
	let answer = change(&mut ui, url, &ex, &materialize(None));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(has_character(&answer, "\\u{202e}"), "{answer:?}");
	// the refusal says what to do: a typed path would not make the URL of the page either
	assert!(
		message(&answer).contains("change the URL of the page first"),
		"{answer:?}"
	);
	// a place that is typed
	let answer = change(&mut ui, url, &ex, &materialize(Some("b\u{202e}c.html")));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(has_character(&answer, "\\u{202e}"), "{answer:?}");
	assert!(!site.exists("src/b\u{202e}c.html"));
	assert_eq!(site.read("pages.overrides.json"), overrides);
}

#[test]
fn a_page_with_such_a_character_in_its_name_is_read_edited_and_moved_to_a_name_without_it() {
	// A name is refused when a person writes it for a file; the one a page already has is read
	// as it is, and the page is edited and moved like any other.
	let site = Site::new("read_chars");
	site.write("src/index.html", "");
	site.write("src/b\u{200b}c.html", "---\ntitle: B\n---\nb");
	let mut ui = site.open("");
	let url = "/b\u{200b}c.html";
	assert!(has_page(&all(&mut ui), url));
	let ex = expect_of(&mut ui, url);
	let answer = change(
		&mut ui,
		url,
		&ex,
		r#"{"op":"set","key":"title","value":"New"}"#,
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/b\u{200b}c.html"), "---\ntitle: New\n---\nb");
	let ex = expect_of(&mut ui, url);
	let answer = change(&mut ui, url, &ex, r#"{"op":"movePath","path":"bc.html"}"#);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/bc.html"), "---\ntitle: New\n---\nb");
	assert!(!site.exists("src/b\u{200b}c.html"));
}

#[test]
fn a_page_whose_url_has_such_a_character_is_told_that_the_url_is_the_same() {
	let site = Site::new("same_url_chars");
	site.write("src/index.html", "");
	site.write("src/b\u{200b}c.html", "b");
	let mut ui = site.open("");
	let url = "/b\u{200b}c.html";
	let ex = expect_of(&mut ui, url);
	let answer = change(
		&mut ui,
		url,
		&ex,
		&format!(r#"{{"op":"moveUrl","url":{}}}"#, s(url).to_json()),
	);
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(message(&answer).contains("the same"), "{answer:?}");
	assert!(
		!message(&answer).contains("has the character"),
		"{answer:?}"
	);
}

#[test]
fn the_url_of_a_virtual_page_is_written_as_it_is_in_the_key_that_makes_urls() {
	// The page has the URL already, so it is not a name that a person writes; it goes into the
	// file as the value of the key, and the file is at the place that was typed.
	let site = Site::new("materialize_key_chars");
	site.write("src/index.html", "");
	site.write(
		"pages.overrides.json",
		"{ \"version\": 1, \"pages\": [ { \"url\": \"/b\u{202e}c.html\", \"virtual\": true } ] }",
	);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "slug" }"#);
	let url = "/b\u{202e}c.html";
	let ex = expect_of(&mut ui, url);
	let answer = change(&mut ui, url, &ex, &materialize(Some("clean.html")));
	assert!(ok(&answer), "{answer:?}");
	// (how the front matter writes the value is the business of its writer, not of this rule)
	let text = site.read("src/clean.html");
	assert!(text.starts_with("---\nslug: "), "{text:?}");
	assert!(text.contains(url), "{text:?}");
	assert!(!site.exists("src/b\u{202e}c.html"));
}

#[test]
fn a_page_is_not_moved_to_a_place_that_cannot_be_looked_at_and_the_refusal_says_so() {
	let site = Site::new("move_unlookable");
	site.write("src/index.html", "");
	site.write("src/a.html", "a");
	// a file where the directory of the new place would be
	site.write("src/file.txt", "x");
	// a directory is something that is there, and no page
	site.write("src/dir.html/keep.txt", "t");
	let mut ui = site.open("");
	let ex = expect_of(&mut ui, "/a.html");
	for (change_json, what) in [
		(r#"{"op":"movePath","path":"file.txt/x.html"}"#, "movePath"),
		(r#"{"op":"moveUrl","url":"/file.txt/x.html"}"#, "moveUrl"),
	] {
		let answer = change(&mut ui, "/a.html", &ex, change_json);
		assert_eq!(code(&answer), "invalid", "{what}: {answer:?}");
		assert!(
			message(&answer).contains("cannot be looked at"),
			"{what}: {answer:?}"
		);
		assert!(
			!message(&answer).contains("already exists"),
			"{what}: {answer:?}"
		);
	}
	// a file that is there is still a collision
	let answer = change(
		&mut ui,
		"/a.html",
		&ex,
		r#"{"op":"movePath","path":"dir.html"}"#,
	);
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert!(message(&answer).contains("already exists"), "{answer:?}");
	assert_eq!(site.read("src/a.html"), "a");
	assert_eq!(site.read("src/dir.html/keep.txt"), "t");
}

#[test]
fn a_virtual_page_whose_directory_is_a_file_is_refused_for_that_and_not_for_a_file_that_is_there() {
	let site = Site::new("materialize_unlookable");
	site.write("src/index.html", "");
	// a file where the directory of every place of `/about/` would be: nothing can be below it
	site.write("src/about", "x");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/about/", "virtual": true } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let ex = expect_of(&mut ui, "/about/");
	let answer = change(&mut ui, "/about/", &ex, &materialize(None));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(
		message(&answer).contains("cannot be looked at"),
		"{answer:?}"
	);
	assert!(!message(&answer).contains("already exists"), "{answer:?}");
	assert_eq!(site.read("src/about"), "x");
	assert!(!site.exists("src/about.html"));
}

#[cfg(unix)]
#[test]
fn a_place_the_disk_does_not_answer_for_is_an_io_error_and_not_an_invalid_name() {
	use std::os::unix::fs::PermissionsExt;
	let site = Site::new("taken_io");
	site.write("src/index.html", "");
	let locked = format!("{}/src/locked", site.root);
	fs::create_dir_all(&locked).unwrap();
	fs::set_permissions(&locked, fs::Permissions::from_mode(0o000)).unwrap();
	let place = format!("{locked}/x.html");
	// a process that may look anyway (root) has nothing to show here
	let answered =
		fs::symlink_metadata(&place).is_err_and(|e| e.kind() != std::io::ErrorKind::NotFound);
	let why = taken(&place);
	let waiting = in_the_way(&place);
	fs::set_permissions(&locked, fs::Permissions::from_mode(0o755)).unwrap();
	if answered {
		assert_eq!(why.unwrap_err().code, "io");
		assert!(waiting);
	}
}

#[test]
fn a_place_that_cannot_be_looked_at_is_not_a_place_that_is_taken() {
	assert!(!taken("/this/does/not/exist/x.html").unwrap());
	let site = Site::new("taken");
	site.write("src/index.html", "");
	site.write("src/file.txt", "x");
	assert!(taken(&format!("{}/src/file.txt", site.root)).unwrap());
	assert!(taken(&format!("{}/src", site.root)).unwrap());
	// a file is not a directory: nothing can be below it, and that is not the same as something
	// being there
	let why = taken(&format!("{}/src/file.txt/x.html", site.root)).unwrap_err();
	assert_eq!(why.code, "invalid");
	assert!(why.message.contains("file.txt/x.html"), "{}", why.message);
	assert!(taken("a\0b").is_err());
	// the callers that only choose a name to set a file aside take what cannot be looked at as in
	// the way, and what is not there as free
	assert!(in_the_way(&format!("{}/src/file.txt/x.html", site.root)));
	assert!(in_the_way("a\0b"));
	assert!(in_the_way(&format!("{}/src/file.txt", site.root)));
	assert!(!in_the_way(&format!("{}/src/free.html", site.root)));
	// so a page is refused for what is the matter, and not for "already exists"
	let mut ui = site.open("");
	let answer = create(&mut ui, None, Some("file.txt/x.html"), "{}");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(!message(&answer).contains("already exists"), "{answer:?}");
}
