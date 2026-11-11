use super::*;

struct Site {
	root: String,
}

impl Site {
	fn new(name: &str) -> Site {
		let root = format!(
			"{}/kd_ui_{name}_{}",
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
}

fn json(text: &str) -> Value {
	kd_jsonc::parse(text).unwrap()
}

fn rows(ui: &mut Ui, query: &str) -> Value {
	json(&ui.pages(query).unwrap())
}

fn all(ui: &mut Ui) -> Value {
	rows(ui, r#"{"offset":0,"limit":1000}"#)
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

fn cell(row: &Value, key: &str) -> Value {
	row.get("meta").and_then(|m| m.get(key)).unwrap().clone()
}

fn s(text: &str) -> Value {
	Value::String(text.to_string())
}

/// An `expect` made of the hashes a row shows.
fn expect(rows: &Value, row: &Value) -> String {
	let hashes = row.get("hashes").unwrap();
	let part = |v: Option<&Value>| v.map_or("null".to_string(), Value::to_json);
	format!(
		r#"{{"input":{},"sidecar":{},"overrides":{}}}"#,
		part(hashes.get("input")),
		part(hashes.get("sidecar")),
		part(rows.get("overridesHash")),
	)
}

fn edit(ui: &mut Ui, url: &str, expect: &str, change: &str) -> Value {
	let request = format!(
		r#"{{"url":{},"expect":{expect},"change":{change}}}"#,
		s(url).to_json()
	);
	json(&ui.edit(&request).unwrap())
}

fn set(key: &str, value: &str) -> String {
	format!(
		r#"{{"op":"set","key":{},"value":{value}}}"#,
		s(key).to_json()
	)
}

fn delete(key: &str) -> String {
	format!(r#"{{"op":"delete","key":{}}}"#, s(key).to_json())
}

fn move_to(url: &str) -> String {
	format!(r#"{{"op":"moveUrl","url":{}}}"#, s(url).to_json())
}

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

#[test]
fn rows_say_where_each_value_comes_from_and_whether_it_can_be_edited() {
	let site = Site::new("origins");
	site.write(
		"src/a/index.html",
		"---\ntitle: A\nlayout: x\n---\n<p>a</p>",
	);
	site.write("src/a/index.json", r#"{ "layout": "side", "nav": true }"#);
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a/","meta":{"nav":false}},{"url":"/ext/","virtual":true,"meta":{"title":"Ext"}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	assert_eq!(rows.get("total"), Some(&Value::Number(2.0)));
	let a = page(&rows, "/a/");
	assert_eq!(cell(&a, "title").get("origin"), Some(&s("inFile")));
	assert_eq!(cell(&a, "layout").get("origin"), Some(&s("sidecar")));
	assert_eq!(cell(&a, "layout").get("value"), Some(&s("side")));
	assert_eq!(cell(&a, "nav").get("origin"), Some(&s("overrides")));
	assert_eq!(cell(&a, "nav").get("value"), Some(&Value::Bool(false)));
	assert_eq!(cell(&a, "title").get("editable"), Some(&Value::Bool(true)));
	assert_eq!(a.get("virtual"), Some(&Value::Bool(false)));
	let ext = page(&rows, "/ext/");
	assert_eq!(ext.get("virtual"), Some(&Value::Bool(true)));
	assert_eq!(ext.get("inputPath"), Some(&Value::Null));
	assert_eq!(cell(&ext, "title").get("origin"), Some(&s("overrides")));
	assert_eq!(
		rows.get("columns"),
		Some(&Value::Array(vec![s("layout"), s("nav"), s("title")]))
	);
	assert_eq!(rows.get("overridesHash").map(Value::is_null), Some(false));
}

#[test]
fn the_hashes_of_a_row_are_the_hashes_of_its_files() {
	let site = Site::new("hashes");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/a.json", "{}");
	site.write("src/b.html", "plain");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let a = page(&rows, "/a.html");
	let hashes = a.get("hashes").unwrap();
	assert_eq!(
		hashes.get("input"),
		Some(&s(&hash_hex(b"---\ntitle: A\n---\n")))
	);
	assert_eq!(hashes.get("sidecar"), Some(&s(&hash_hex(b"{}"))));
	let b = page(&rows, "/b.html");
	assert_eq!(b.get("hashes").unwrap().get("sidecar"), Some(&Value::Null));
	assert_eq!(rows.get("overridesHash"), Some(&Value::Null));
}

#[test]
fn rows_are_cut_by_offset_and_limit_and_filtered_by_a_query() {
	let site = Site::new("paging");
	for n in 0..7 {
		site.write(
			&format!("src/p{n}.html"),
			&format!("---\ntitle: Page {n}\n---\n"),
		);
	}
	site.write("src/other.html", "---\ntitle: Else\n---\n");
	let mut ui = site.open("");
	let first = rows(&mut ui, r#"{"offset":0,"limit":3}"#);
	assert_eq!(first.get("total"), Some(&Value::Number(8.0)));
	let Some(Value::Array(p)) = first.get("pages") else {
		panic!("pages")
	};
	assert_eq!(p.len(), 3);
	let last = rows(&mut ui, r#"{"offset":6,"limit":10}"#);
	let Some(Value::Array(p)) = last.get("pages") else {
		panic!("pages")
	};
	assert_eq!(p.len(), 2);
	let past = rows(&mut ui, r#"{"offset":99,"limit":10}"#);
	assert_eq!(past.get("total"), Some(&Value::Number(8.0)));
	let found = rows(&mut ui, r#"{"offset":0,"limit":10,"q":"PAGE 3"}"#);
	assert_eq!(found.get("total"), Some(&Value::Number(1.0)));
	page(&found, "/p3.html");
	let by_url = rows(&mut ui, r#"{"offset":0,"limit":10,"q":"other"}"#);
	assert_eq!(by_url.get("total"), Some(&Value::Number(1.0)));
	assert!(ui.pages(r#"{"offset":-1,"limit":1}"#).is_err());
	assert!(ui.pages(r#"{"limit":1}"#).is_err());
	assert!(ui.pages("{").is_err());
}

/// The URLs of the rows of a query, in the order the rows come.
fn urls_of(ui: &mut Ui, query: &str) -> Vec<String> {
	let rows = rows(ui, query);
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.map(|p| p.get("url").and_then(Value::as_str).unwrap().to_owned())
		.collect()
}

#[test]
fn rows_are_sorted_by_the_natural_order_over_every_page_and_not_only_the_window() {
	let site = Site::new("sort_url");
	for name in ["page10", "page2", "page1", "Page3", "a/index", "a/b"] {
		site.write(&format!("src/{name}.html"), "---\ntitle: T\n---\n");
	}
	let mut ui = site.open("");
	let asc = r#"{"offset":0,"limit":100,"sort":{"key":"url"}}"#;
	assert_eq!(
		urls_of(&mut ui, asc),
		[
			"/a/",
			"/a/b.html",
			"/page1.html",
			"/page2.html",
			"/Page3.html",
			"/page10.html"
		]
	);
	let desc = r#"{"offset":0,"limit":100,"sort":{"key":"url","desc":true}}"#;
	let mut reversed = urls_of(&mut ui, asc);
	reversed.reverse();
	assert_eq!(urls_of(&mut ui, desc), reversed);
	// A window is cut from the sorted pages, not sorted after it is cut.
	let window = r#"{"offset":2,"limit":2,"sort":{"key":"url"}}"#;
	assert_eq!(urls_of(&mut ui, window), ["/page1.html", "/page2.html"]);
	// The same order over the pages a query keeps.
	let found = r#"{"offset":0,"limit":100,"q":"page","sort":{"key":"url","desc":true}}"#;
	assert_eq!(
		urls_of(&mut ui, found),
		["/page10.html", "/Page3.html", "/page2.html", "/page1.html"]
	);
	let by_input = r#"{"offset":0,"limit":100,"sort":{"key":"inputPath"}}"#;
	assert_eq!(urls_of(&mut ui, by_input).len(), 6);
}

#[test]
fn a_page_without_a_value_goes_last_whichever_way_the_column_runs() {
	let site = Site::new("sort_meta");
	site.write("src/a.html", "---\norder: 10\n---\n");
	site.write("src/b.html", "---\norder: 2\n---\n");
	site.write("src/c.html", "---\ntitle: none\n---\n");
	site.write("src/d.html", "---\norder: ~\n---\n");
	site.write("src/e.html", "---\norder: 2\n---\n");
	let mut ui = site.open("");
	let asc = r#"{"offset":0,"limit":100,"sort":{"key":"meta:order"}}"#;
	// `b` and `e` are equal: the plan's order (by URL) is kept.
	assert_eq!(
		urls_of(&mut ui, asc),
		["/b.html", "/e.html", "/a.html", "/c.html", "/d.html"]
	);
	let desc = r#"{"offset":0,"limit":100,"sort":{"key":"meta:order","desc":true}}"#;
	assert_eq!(
		urls_of(&mut ui, desc),
		["/a.html", "/b.html", "/e.html", "/c.html", "/d.html"]
	);
}

#[test]
fn the_order_kept_for_a_sort_follows_an_edit_and_a_new_plan() {
	let site = Site::new("sort_cache");
	site.write("src/a.html", "---\norder: 1\n---\n");
	site.write("src/b.html", "---\norder: 2\n---\n");
	site.write("src/c.html", "---\norder: 3\n---\n");
	let mut ui = site.open("");
	let query = r#"{"offset":0,"limit":100,"sort":{"key":"meta:order"}}"#;
	assert_eq!(urls_of(&mut ui, query), ["/a.html", "/b.html", "/c.html"]);
	// The same sort again is answered from what was kept: the same rows.
	assert_eq!(urls_of(&mut ui, query), ["/a.html", "/b.html", "/c.html"]);
	// An edit changes the version: the order is made again.
	let all = all(&mut ui);
	let row = page(&all, "/a.html");
	let answer = edit(&mut ui, "/a.html", &expect(&all, &row), &set("order", "9"));
	assert!(ok(&answer));
	assert_eq!(urls_of(&mut ui, query), ["/b.html", "/c.html", "/a.html"]);
	// A file changed outside is read in by a refresh, which is a new plan.
	site.write("src/b.html", "---\norder: 20\n---\n");
	ui.refresh().unwrap();
	assert_eq!(urls_of(&mut ui, query), ["/c.html", "/a.html", "/b.html"]);
	// A query keeps the order of the sort for the pages it keeps.
	let found = r#"{"offset":0,"limit":100,"q":".html","sort":{"key":"meta:order","desc":true}}"#;
	assert_eq!(urls_of(&mut ui, found), ["/b.html", "/a.html", "/c.html"]);
	// And a window is cut from that order.
	let window = r#"{"offset":1,"limit":1,"q":".html","sort":{"key":"meta:order","desc":true}}"#;
	assert_eq!(urls_of(&mut ui, window), ["/a.html"]);
}

#[test]
fn a_query_that_keeps_few_pages_is_sorted_the_same_with_or_without_the_order_of_every_page() {
	let site = Site::new("sort_small");
	for n in [10, 2, 1, 30, 3, 20, 4, 5, 6, 7] {
		let tag = if n % 10 == 0 { "wanted" } else { "other" };
		site.write(
			&format!("src/p{n}.html"),
			&format!("---\ntitle: {tag}\n---\n"),
		);
	}
	let mut ui = site.open("");
	// Three of ten pages are kept, which is more than one in eight: the order of every page is
	// made and the kept pages are taken from it. The answer is the same from the cache.
	let few = r#"{"offset":0,"limit":100,"q":"wanted","sort":{"key":"url"}}"#;
	let all = r#"{"offset":0,"limit":100,"sort":{"key":"url"}}"#;
	let wanted = ["/p10.html", "/p20.html", "/p30.html"];
	assert_eq!(urls_of(&mut ui, few), wanted);
	let _ = urls_of(&mut ui, all);
	assert_eq!(urls_of(&mut ui, few), wanted);
	// A query that keeps three pages of a hundred and ten is sorted by itself (nothing is cached
	// for the new version) and gives the same rows, in the other direction.
	for n in 100..200 {
		site.write(&format!("src/q{n}.html"), "---\ntitle: filler\n---\n");
	}
	ui.refresh().unwrap();
	let one = r#"{"offset":0,"limit":100,"q":"wanted","sort":{"key":"url","desc":true}}"#;
	assert_eq!(
		urls_of(&mut ui, one),
		["/p30.html", "/p20.html", "/p10.html"]
	);
}

#[test]
fn the_path_columns_and_virtual_are_sorted_with_the_pages_that_have_no_value_last() {
	let site = Site::new("sort_columns");
	site.write("src/b.html", "---\ntitle: B\n---\n");
	site.write("src/z/a.html", "---\ntitle: Z\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/ext/", "virtual": true, "meta": { "title": "Ext" } } ] }"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let sort = |key: &str, desc: bool| {
		format!(r#"{{"offset":0,"limit":100,"sort":{{"key":"{key}","desc":{desc}}}}}"#)
	};
	// `inputPath` is read from `dir.input` (`/b.html`, `/z/a.html`). The virtual page has no
	// input path and is last, whichever way the column runs.
	assert_eq!(
		urls_of(&mut ui, &sort("inputPath", false)),
		["/b.html", "/z/a.html", "/ext/"]
	);
	assert_eq!(
		urls_of(&mut ui, &sort("inputPath", true)),
		["/z/a.html", "/b.html", "/ext/"]
	);
	// `virtual`: false before true, and the other way round when descending.
	let up = urls_of(&mut ui, &sort("virtual", false));
	assert_eq!(up.last().map(String::as_str), Some("/ext/"));
	let down = urls_of(&mut ui, &sort("virtual", true));
	assert_eq!(down.first().map(String::as_str), Some("/ext/"));
}

#[test]
fn values_that_are_not_text_are_sorted_by_how_they_are_written() {
	let site = Site::new("sort_kinds");
	site.write("src/a.html", "---\nflag: true\n---\n");
	site.write("src/b.html", "---\nflag: false\n---\n");
	site.write("src/c.html", "---\nitems: [1, 10]\n---\n");
	site.write("src/d.html", "---\nitems: [1, 2]\n---\n");
	let mut ui = site.open("");
	let flags = r#"{"offset":0,"limit":100,"sort":{"key":"meta:flag"}}"#;
	assert_eq!(&urls_of(&mut ui, flags)[..2], ["/b.html", "/a.html"]);
	// The common prefix `[1,` goes first: `2]` before `10]`.
	let items = r#"{"offset":0,"limit":100,"sort":{"key":"meta:items"}}"#;
	assert_eq!(&urls_of(&mut ui, items)[..2], ["/d.html", "/c.html"]);
}

#[test]
fn a_sort_that_is_not_one_is_an_error() {
	let site = Site::new("sort_bad");
	site.write("src/a.html", "---\ntitle: T\n---\n");
	let mut ui = site.open("");
	for sort in [
		r#""url""#,
		r#"{}"#,
		r#"{"key":"outputPath"}"#,
		r#"{"key":"meta:"}"#,
		r#"{"key":"title"}"#,
		r#"{"key":"url","desc":"yes"}"#,
	] {
		let query = format!(r#"{{"offset":0,"limit":1,"sort":{sort}}}"#);
		assert!(ui.pages(&query).is_err(), "{sort}");
	}
	// `null` is no sort, as no `sort` is.
	assert!(ui.pages(r#"{"offset":0,"limit":1,"sort":null}"#).is_ok());
	// A column that no page has is a sort that leaves the plan's order.
	let none = r#"{"offset":0,"limit":10,"sort":{"key":"meta:nothing"}}"#;
	assert_eq!(urls_of(&mut ui, none), ["/a.html"]);
}

fn values_of(ui: &mut Ui, query: &str) -> Value {
	json(&ui.values(query).unwrap())
}

/// The `(value, count)` of the answer of `values`, as JSON text and a number.
fn counted(answer: &Value) -> Vec<(String, usize)> {
	let Some(Value::Array(values)) = answer.get("values") else {
		panic!("values in {answer:?}")
	};
	values
		.iter()
		.map(|v| {
			let count = match v.get("count") {
				Some(Value::Number(n)) => *n as usize,
				other => panic!("count in {other:?}"),
			};
			(v.get("value").unwrap().to_json(), count)
		})
		.collect()
}

#[test]
fn the_values_of_a_key_are_counted_over_every_page_and_an_array_gives_its_items() {
	let site = Site::new("values");
	site.write(
		"src/a.html",
		"---\nlayout: wide\ntags: [x, y]\nn: 1\nflag: true\n---\n",
	);
	site.write(
		"src/b.html",
		"---\nlayout: wide\ntags: [y]\nn: \"1\"\n---\n",
	);
	site.write(
		"src/c.html",
		"---\nlayout: narrow\ntags: []\nn: 1\nflag: false\n---\n",
	);
	site.write("src/d.html", "---\nlayout: null\ntags: {a: 1}\n---\n");
	let mut ui = site.open("");
	let layout = values_of(&mut ui, r#"{"key":"meta:layout","limit":10}"#);
	// Most often first; `null` is no value.
	assert_eq!(
		counted(&layout),
		[(r#""wide""#.to_string(), 2), (r#""narrow""#.to_string(), 1)]
	);
	assert_eq!(layout.get("total"), Some(&Value::Number(2.0)));
	assert_eq!(layout.get("key"), Some(&s("meta:layout")));
	assert_eq!(
		layout.get("version"),
		Some(&Value::Number(ui.version as f64))
	);
	// The items of an array, and not the array; an object is not counted; `y` is in two arrays.
	let tags = values_of(&mut ui, r#"{"key":"meta:tags","limit":10}"#);
	assert_eq!(
		counted(&tags),
		[(r#""y""#.to_string(), 2), (r#""x""#.to_string(), 1)]
	);
	// The number 1 and the text "1" are two values; they came in the order of the plan.
	let n = values_of(&mut ui, r#"{"key":"meta:n","limit":10}"#);
	assert_eq!(
		counted(&n),
		[("1".to_string(), 2), (r#""1""#.to_string(), 1)]
	);
	let flag = values_of(&mut ui, r#"{"key":"meta:flag","limit":10}"#);
	assert_eq!(
		counted(&flag),
		[("true".to_string(), 1), ("false".to_string(), 1)]
	);
	// No page has the key: nothing, not an error.
	let none = values_of(&mut ui, r#"{"key":"meta:nothing","limit":10}"#);
	assert!(counted(&none).is_empty());
	assert_eq!(none.get("total"), Some(&Value::Number(0.0)));
}

#[test]
fn what_is_not_a_value_inside_an_array_is_not_counted() {
	let site = Site::new("values_items");
	site.write("src/a.html", "---\ntags: [[1], {a: 1}, null, 2, x]\n---\n");
	site.write("src/b.html", "---\ntitle: T\n---\n");
	site.write("src/b.json", "{\"tags\": [\"x\"]}\n");
	let mut ui = site.open("");
	let tags = values_of(&mut ui, r#"{"key":"meta:tags","limit":10}"#);
	// Only the number 2 and the text x of the array; `x` is held by the sidecar of the other page
	// too, which makes it the most often held.
	assert_eq!(
		counted(&tags),
		[(r#""x""#.to_string(), 2), ("2".to_string(), 1)]
	);
	assert_eq!(tags.get("total"), Some(&Value::Number(2.0)));
}

#[test]
fn a_limit_cuts_the_values_and_total_still_counts_all_of_them() {
	let site = Site::new("values_limit");
	for (name, layout) in [("a", "one"), ("b", "two"), ("c", "two"), ("d", "three")] {
		site.write(
			&format!("src/{name}.html"),
			&format!("---\nlayout: {layout}\n---\n"),
		);
	}
	let mut ui = site.open("");
	let cut = values_of(&mut ui, r#"{"key":"meta:layout","limit":2}"#);
	assert_eq!(
		counted(&cut),
		[(r#""two""#.to_string(), 2), (r#""one""#.to_string(), 1)]
	);
	assert_eq!(cut.get("total"), Some(&Value::Number(3.0)));
	let zero = values_of(&mut ui, r#"{"key":"meta:layout","limit":0}"#);
	assert!(counted(&zero).is_empty());
	assert_eq!(zero.get("total"), Some(&Value::Number(3.0)));
}

#[test]
fn the_values_follow_an_edit() {
	let site = Site::new("values_edit");
	site.write("src/a.html", "---\nlayout: one\n---\n");
	site.write("src/b.html", "---\nlayout: one\n---\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let row = page(&rows, "/a.html");
	let done = edit(
		&mut ui,
		"/a.html",
		&expect(&rows, &row),
		&set("layout", r#""two""#),
	);
	assert!(ok(&done), "{done:?}");
	let layout = values_of(&mut ui, r#"{"key":"meta:layout","limit":10}"#);
	// Held once each: the one met first in the order of the plan (`/a.html`) is first.
	assert_eq!(
		counted(&layout),
		[(r#""two""#.to_string(), 1), (r#""one""#.to_string(), 1)]
	);
}

#[test]
fn a_values_request_that_is_not_one_is_an_error() {
	let site = Site::new("values_bad");
	site.write("src/a.html", "---\ntitle: T\n---\n");
	let ui = site.open("");
	for query in [
		"{",
		r#"{"limit":1}"#,
		r#"{"key":"title","limit":1}"#,
		r#"{"key":"meta:","limit":1}"#,
		r#"{"key":"url","limit":1}"#,
		r#"{"key":1,"limit":1}"#,
		r#"{"key":"meta:title"}"#,
		r#"{"key":"meta:title","limit":-1}"#,
		r#"{"key":"meta:title","limit":1.5}"#,
		r#"{"key":"meta:title","limit":"1"}"#,
	] {
		assert!(ui.values(query).is_err(), "{query}");
	}
}

#[test]
fn keys_that_cannot_be_edited_say_why() {
	let site = Site::new("not_editable");
	site.write(
		"src/anchors.html",
		"---\nbase: &b {x: 1}\nuse: *b\ntitle: T\n---\n",
	);
	site.write(
		"src/twice.tsx",
		"export const meta = { a: 1, b: 2, a: 3 };\nexport default () => null;\n",
	);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let anchors = page(&rows, "/anchors.html");
	for key in ["base", "use", "title"] {
		let c = cell(&anchors, key);
		assert_eq!(c.get("editable"), Some(&Value::Bool(false)), "{key}");
		assert!(c.get("reason").and_then(Value::as_str).is_some());
	}
	let twice = page(&rows, "/twice.html");
	assert_eq!(cell(&twice, "a").get("editable"), Some(&Value::Bool(false)));
	assert_eq!(cell(&twice, "b").get("editable"), Some(&Value::Bool(true)));
	let answer = edit(
		&mut ui,
		"/anchors.html",
		&expect(&rows, &anchors),
		&set("title", r#""U""#),
	);
	assert_eq!(code(&answer), "notEditable");
	assert!(site.read("src/anchors.html").contains("title: T"));
}

#[test]
fn a_value_is_written_to_the_file_it_comes_from_and_nothing_else_changes() {
	let site = Site::new("set");
	site.write(
		"src/a.html",
		"---\n# the page\ntitle: A # note\nlayout: x\n---\n<p>a</p>\n",
	);
	site.write(
		"src/a.json",
		"{\n\t// the side\n\t\"layout\": \"side\"\n}\n",
	);
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a.html\", \"meta\": { \"nav\": true } }\n\t]\n}\n",
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let a = page(&rows, "/a.html");
	let ex = expect(&rows, &a);

	let answer = edit(&mut ui, "/a.html", &ex, &set("title", r#""New""#));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/a.html"),
		"---\n# the page\ntitle: New\nlayout: x\n---\n<p>a</p>\n"
	);
	assert_eq!(
		cell(answer.get("page").unwrap(), "title").get("value"),
		Some(&s("New"))
	);

	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &set("layout", r#""other""#));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/a.json"),
		"{\n\t// the side\n\t\"layout\": \"other\"\n}\n"
	);
	assert_eq!(site.read("src/a.html").matches("layout: x").count(), 1);

	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &set("nav", "false"));
	assert!(ok(&answer), "{answer:?}");
	assert!(
		site.read("pages.overrides.json")
			.contains(r#""nav": false"#)
	);
	assert!(site.read("pages.overrides.json").contains("\"version\": 1"));
	let after = all(&mut ui);
	let a = page(&after, "/a.html");
	assert_eq!(cell(&a, "nav").get("value"), Some(&Value::Bool(false)));
	assert_eq!(cell(&a, "title").get("value"), Some(&s("New")));
	assert_eq!(cell(&a, "layout").get("value"), Some(&s("other")));
}

#[test]
fn a_new_key_goes_into_the_page_file_and_a_virtual_page_has_no_other_place() {
	let site = Site::new("new_key");
	site.write("src/a.html", "<p>no front matter</p>\n");
	site.write("src/b.tsx", "export default () => null;\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/ext/","virtual":true}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &set("title", r#""T""#))));
	assert_eq!(
		site.read("src/a.html"),
		"---\ntitle: T\n---\n<p>no front matter</p>\n"
	);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/b.html"));
	assert!(ok(&edit(&mut ui, "/b.html", &ex, &set("title", r#""B""#))));
	assert_eq!(
		site.read("src/b.tsx"),
		"export const meta = { title: \"B\" };\n\nexport default () => null;\n"
	);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/ext/"));
	assert!(ok(&edit(&mut ui, "/ext/", &ex, &set("title", r#""E""#))));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{"version":1,"pages":[{"url":"/ext/","virtual":true,"meta":{"title":"E"}}]}"#
	);
	let rows = all(&mut ui);
	assert_eq!(
		cell(&page(&rows, "/ext/"), "title").get("value"),
		Some(&s("E"))
	);
}

#[test]
fn deleting_removes_the_value_from_its_file_and_the_one_below_shows() {
	let site = Site::new("delete");
	site.write("src/a.html", "---\ntitle: File\nother: 1\n---\n");
	site.write("src/a.json", r#"{ "title": "Side" }"#);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &delete("title"))));
	assert_eq!(site.read("src/a.json"), "{}");
	assert!(site.read("src/a.html").contains("title: File"));
	let rows = all(&mut ui);
	let c = cell(&page(&rows, "/a.html"), "title");
	assert_eq!(c.get("value"), Some(&s("File")));
	assert_eq!(c.get("origin"), Some(&s("inFile")));
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &delete("title"))));
	assert_eq!(site.read("src/a.html"), "---\nother: 1\n---\n");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &delete("title"));
	assert_eq!(code(&answer), "invalid");
}

#[test]
fn a_file_changed_since_it_was_read_is_not_overwritten() {
	let site = Site::new("conflict");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// the same length, so that only the content tells
	site.write("src/a.html", "---\ntitle: B\n---\n");
	let answer = edit(&mut ui, "/a.html", &ex, &set("title", r#""C""#));
	assert_eq!(code(&answer), "conflict");
	assert_eq!(site.read("src/a.html"), "---\ntitle: B\n---\n");
	let current = answer.get("current").unwrap();
	assert_eq!(
		current.get("hashes").unwrap().get("input"),
		Some(&s(&hash_hex(b"---\ntitle: B\n---\n")))
	);
	let answer = edit(&mut ui, "/a.html", "{}", &set("title", r#""C""#));
	assert_eq!(code(&answer), "invalid");
	let answer = edit(&mut ui, "/zzz/", "{}", &set("title", r#""C""#));
	assert_eq!(code(&answer), "notFound");
}

#[test]
fn editing_overrides_changes_the_hash_every_row_has_to_send() {
	let site = Site::new("overrides_hash");
	site.write("src/a.html", "");
	site.write("src/b.html", "");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":1}},{"url":"/b.html","meta":{"n":2}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &set("n", "10"));
	assert!(ok(&answer), "{answer:?}");
	assert_ne!(answer.get("overridesHash"), rows.get("overridesHash"));
	// the old hash is stale for any row
	let ex = expect(&rows, &page(&rows, "/b.html"));
	let answer = edit(&mut ui, "/b.html", &ex, &set("n", "20"));
	assert_eq!(code(&answer), "conflict");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/b.html"));
	assert!(ok(&edit(&mut ui, "/b.html", &ex, &set("n", "20"))));
}

#[test]
fn the_output_path_key_is_changed_by_moving_the_url_and_not_as_a_key() {
	let site = Site::new("path_field");
	site.write(
		"src/170370.html",
		"---\npath: /en/news.html\ntitle: T\n---\n",
	);
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let rows = all(&mut ui);
	let row = page(&rows, "/en/news.html");
	assert_eq!(
		cell(&row, "path").get("editable"),
		Some(&Value::Bool(false))
	);
	assert_eq!(rows.get("columns"), Some(&Value::Array(vec![s("title")])));
	let ex = expect(&rows, &row);
	let answer = edit(&mut ui, "/en/news.html", &ex, &set("path", r#""/x.html""#));
	assert_eq!(code(&answer), "notEditable");
	let answer = edit(&mut ui, "/en/news.html", &ex, &move_to("/en/press/"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/170370.html"),
		"---\npath: /en/press/\ntitle: T\n---\n"
	);
	let rows = all(&mut ui);
	page(&rows, "/en/press/");
	assert!(!ui.by_url.contains_key("/en/news.html"));
}

#[test]
fn moving_a_url_moves_the_file_and_its_sidecar() {
	let site = Site::new("move_file");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	site.write("src/a/index.json", r#"{"x":1}"#);
	site.write("src/a/child.html", "child");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a/"));
	let answer = edit(&mut ui, "/a/", &ex, &move_to("/b/"));
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/a/index.html"));
	assert!(!site.exists("src/a/index.json"));
	assert_eq!(site.read("src/b/index.html"), "---\ntitle: A\n---\n");
	assert_eq!(site.read("src/b/index.json"), r#"{"x":1}"#);
	let rows = all(&mut ui);
	// the child keeps its URL; its parent is now a directory without a page
	let child = page(&rows, "/a/child.html");
	assert_eq!(child.get("parent"), Some(&s("/a/")));
	assert_eq!(
		page(&rows, "/b/").get("inputPath"),
		Some(&s(&format!("{}/src/b/index.html", site.root)))
	);
}

#[test]
fn moving_to_a_file_url_keeps_the_extension_of_the_source() {
	let site = Site::new("move_ext");
	site.write("src/a.tsx", "export default () => null;\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/dir/b.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/dir/b.tsx"));
	assert!(!site.exists("src/a.tsx"));
}

#[test]
fn moving_a_url_is_refused_when_it_cannot_be_made_or_would_collide() {
	let site = Site::new("move_refused");
	site.write("src/a.html", "a");
	site.write("src/b.html", "b");
	site.write("src/c/index.html", "c");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/ext/","virtual":true}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	for (to, expected) in [
		("/b.html", "collision"),
		("/ext/", "collision"),
		("/c/", "collision"),
		("/a.html", "invalid"),
		("a.html", "invalid"),
		("/x?y", "invalid"),
		("/x//y.html", "invalid"),
		("/x/index.html", "invalid"),
		("/x.htm", "invalid"),
	] {
		let answer = edit(&mut ui, "/a.html", &ex, &move_to(to));
		assert_eq!(code(&answer), expected, "{to}: {answer:?}");
	}
	assert!(site.exists("src/a.html"));
	assert!(!site.exists("src/x.htm"));
	// a virtual page cannot take the URL of a real one
	let ex = expect(&rows, &page(&rows, "/ext/"));
	let answer = edit(&mut ui, "/ext/", &ex, &move_to("/b.html"));
	assert_eq!(code(&answer), "collision");
	// a destination that exists but is not in the plan
	site.write("src/new.html", "taken by a file the plan does not list");
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/new.html"));
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert_eq!(
		site.read("src/new.html"),
		"taken by a file the plan does not list"
	);
}

#[test]
fn a_page_cannot_move_out_of_pages_files() {
	let site = Site::new("move_globs");
	site.write("src/a.html", "a");
	let mut ui = site.open(r#", "pages": { "ignore": ["private/**"] }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/private/a.html"));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/a.html"));
}

#[test]
fn moving_a_virtual_page_changes_the_url_in_pages_overrides() {
	let site = Site::new("move_virtual");
	site.write("src/a.html", "a");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/ext/\", \"virtual\": true, \"meta\": { \"title\": \"E\" } },\n\t\t{ \"url\": \"/a.html\" }\n\t]\n}\n",
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/ext/"));
	let answer = edit(&mut ui, "/ext/", &ex, &move_to("/outside/"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/outside/\", \"virtual\": true, \"meta\": { \"title\": \"E\" } },\n\t\t{ \"url\": \"/a.html\" }\n\t]\n}\n"
	);
	let rows = all(&mut ui);
	// the order of the file is kept
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	assert_eq!(pages[0].get("url"), Some(&s("/outside/")));
}

#[test]
fn moving_a_real_page_follows_its_entry_in_pages_overrides() {
	let site = Site::new("move_entry");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"nav":true}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/z.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/z.html"));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{"version":1,"pages":[{"url":"/z.html","meta":{"nav":true}}]}"#
	);
	let rows = all(&mut ui);
	assert_eq!(
		cell(&page(&rows, "/z.html"), "nav").get("value"),
		Some(&Value::Bool(true))
	);
}

#[test]
fn a_move_that_cannot_finish_leaves_the_files_as_they_were() {
	let site = Site::new("move_rollback");
	site.write("src/a.html", "a");
	site.write("src/a.json", "{}");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html"}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// the overrides file can be read but not written: the files are moved first and the
	// write fails, so the moves have to be undone
	let overrides = format!("{}/pages.overrides.json", site.root);
	if !read_only_is_respected(&overrides) {
		return;
	}
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/b.html"));
	let mut permissions = fs::metadata(&overrides).unwrap().permissions();
	#[allow(clippy::permissions_set_readonly_false)]
	permissions.set_readonly(false);
	fs::set_permissions(&overrides, permissions).unwrap();
	assert_eq!(code(&answer), "io", "{answer:?}");
	assert!(site.exists("src/a.html"));
	assert!(site.exists("src/a.json"));
	assert!(!site.exists("src/b.html"));
	assert!(!site.exists("src/b.json"));
}

#[test]
fn refreshing_reads_what_changed_outside() {
	let site = Site::new("refresh");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let v = ui.refresh().unwrap();
	site.write("src/a.html", "---\ntitle: Changed outside\n---\n");
	site.write("src/new.html", "");
	assert!(ui.refresh().unwrap() > v);
	let rows = all(&mut ui);
	assert_eq!(rows.get("total"), Some(&Value::Number(2.0)));
	assert_eq!(
		cell(&page(&rows, "/a.html"), "title").get("value"),
		Some(&s("Changed outside"))
	);
}

#[test]
fn a_request_that_is_not_one_is_an_error_and_not_an_answer() {
	let site = Site::new("bad_request");
	site.write("src/a.html", "");
	let mut ui = site.open("");
	for request in [
		"{",
		r#"{"change":{"op":"set","key":"a","value":1}}"#,
		r#"{"url":"/a.html"}"#,
		r#"{"url":"/a.html","change":{"op":"explode"}}"#,
		r#"{"url":"/a.html","change":{"op":"set","key":"","value":1}}"#,
		r#"{"url":"/a.html","change":{"op":"set","key":"a"}}"#,
		r#"{"url":"/a.html","change":{"op":"moveUrl"}}"#,
		r#"{"url":"/a.html","expect":1,"change":{"op":"delete","key":"a"}}"#,
	] {
		assert!(ui.edit(request).is_err(), "{request}");
	}
}

#[test]
fn an_incremental_handle_saves_the_plan_cache_when_it_is_closed() {
	let site = Site::new("cache");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"kamado.config.jsonc",
		r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache", "incremental": true } }"#,
	);
	let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
	let mut ui = Ui::open(loaded, &BuildOptions::default()).unwrap();
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &set("title", r#""B""#))));
	assert!(ui.close().is_none());
	let cached = crate::plan_cache::load(&format!("{}/.cache", site.root)).unwrap();
	let entry = cached
		.pages
		.values()
		.next()
		.expect("the page is in the cache");
	assert_eq!(entry.in_file, vec![("title".to_string(), s("B"))]);
}

#[test]
fn a_write_that_fails_undoes_the_ones_before_it_and_removes_the_files_it_made() {
	let site = Site::new("txn");
	site.write("old.txt", "old");
	site.write("dir/keep.txt", "");
	let root = &site.root;
	let txn = Txn {
		renames: Vec::new(),
		writes: vec![
			(format!("{root}/old.txt"), "new".to_string()),
			(format!("{root}/made.txt"), "made".to_string()),
			// a directory cannot be written as a file
			(format!("{root}/dir"), "x".to_string()),
		],
		..Txn::default()
	};
	let failed = txn.commit().unwrap_err();
	assert_eq!(failed.code, "io");
	assert_eq!(site.read("old.txt"), "old");
	assert!(!site.exists("made.txt"));
	assert!(site.exists("dir/keep.txt"));
}

#[test]
fn an_edit_counts_one_version_whatever_it_does() {
	let site = Site::new("version");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let version_of = |ui: &mut Ui| {
		let rows = all(ui);
		match rows.get("version") {
			Some(Value::Number(n)) => *n as u64,
			other => panic!("version {other:?}"),
		}
	};
	let before = version_of(&mut ui);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &set("title", r#""B""#))));
	assert_eq!(version_of(&mut ui), before + 1);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &move_to("/b.html"))));
	assert_eq!(version_of(&mut ui), before + 2);
	let refused = edit(&mut ui, "/b.html", "{}", &set("title", r#""C""#));
	assert!(!ok(&refused));
	assert_eq!(version_of(&mut ui), before + 2);
}

#[test]
fn a_site_whose_page_files_are_gone_forgets_what_it_knew_of_them() {
	let site = Site::new("gone");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/a.json", r#"{"layout":"x"}"#);
	let mut ui = site.open("");
	assert!(!ui.cache.pages.is_empty());
	fs::remove_file(format!("{}/src/a.html", site.root)).unwrap();
	fs::remove_file(format!("{}/src/a.json", site.root)).unwrap();
	ui.refresh().unwrap();
	assert!(ui.cache.pages.is_empty());
	site.write("src/a.html", "---\ntitle: Again\n---\n");
	ui.refresh().unwrap();
	let rows = all(&mut ui);
	let a = page(&rows, "/a.html");
	assert_eq!(cell(&a, "title").get("origin"), Some(&s("inFile")));
}

#[test]
fn a_refused_edit_answers_with_the_page_as_the_files_hold_it_now() {
	let site = Site::new("fresh_current");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let stale = expect(&rows, &page(&rows, "/a.html"));
	site.write("src/a.html", "---\ntitle: B\n---\n");
	let answer = edit(&mut ui, "/a.html", &stale, &set("title", r#""C""#));
	assert_eq!(code(&answer), "conflict");
	let current = answer.get("current").unwrap();
	assert_eq!(cell(current, "title").get("value"), Some(&s("B")));
	// the hashes of `current` are good for the next try
	let retry = format!(
		r#"{{"input":{},"sidecar":null,"overrides":null}}"#,
		current
			.get("hashes")
			.unwrap()
			.get("input")
			.unwrap()
			.to_json()
	);
	assert!(ok(&edit(
		&mut ui,
		"/a.html",
		&retry,
		&set("title", r#""C""#)
	)));
	assert_eq!(site.read("src/a.html"), "---\ntitle: C\n---\n");
}

#[test]
fn a_sidecar_nobody_has_yet_is_taken_at_the_destination_too() {
	let site = Site::new("stray_sidecar");
	site.write("src/a.html", "a");
	site.write(
		"src/b.json",
		r#"{"title":"not for the page that is moved here"}"#,
	);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/b.html"));
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert!(site.exists("src/a.html"));
	assert!(!site.exists("src/b.html"));
}

#[test]
fn a_name_that_differs_by_case_only_is_the_same_file_where_cases_are_not_told_apart() {
	let site = Site::new("case_only");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// where cases are told apart nothing is at the new name; where they are not, the new name
	// is the file itself: the page is moved either way
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/A.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/A.html"));
	let rows = all(&mut ui);
	page(&rows, "/A.html");
}

#[test]
fn a_key_that_only_pages_overrides_has_does_not_make_the_url() {
	let site = Site::new("override_path");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"path":"/elsewhere.html"}}]}"#,
	);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	let rows = all(&mut ui);
	// the plan does not read the key from the overrides: the URL is where the file is
	let row = page(&rows, "/a.html");
	let ex = expect(&rows, &row);
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/z.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/z.html"));
	assert!(
		site.read("pages.overrides.json")
			.contains(r#""url":"/z.html""#)
	);
	assert!(
		site.read("pages.overrides.json")
			.contains("/elsewhere.html")
	);
}

#[test]
fn a_column_goes_when_the_last_page_that_had_the_key_loses_it() {
	let site = Site::new("columns");
	site.write("src/a.html", "---\ntitle: A\nonly: 1\n---\n");
	site.write("src/b.html", "---\ntitle: B\n---\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	assert_eq!(
		rows.get("columns"),
		Some(&Value::Array(vec![s("only"), s("title")]))
	);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &delete("only"))));
	let rows = all(&mut ui);
	assert_eq!(rows.get("columns"), Some(&Value::Array(vec![s("title")])));
}

#[test]
fn a_site_that_cannot_be_read_any_more_leaves_the_handle_as_it_was() {
	let site = Site::new("unreadable");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":1}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	site.write("pages.overrides.json", "{");
	assert!(ui.refresh().is_err());
	let rows = all(&mut ui);
	assert_eq!(rows.get("total"), Some(&Value::Number(1.0)));
	assert_eq!(
		cell(&page(&rows, "/a.html"), "n").get("value"),
		Some(&Value::Number(1.0))
	);
}

impl Site {
	/// Opens the editor with the text of the config file as it is given.
	fn open_config(&self, config: &str) -> Ui {
		self.write("kamado.config.jsonc", config);
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap();
		Ui::open(loaded, &BuildOptions::default()).unwrap()
	}
}

/// A user that can write a file marked read-only (root) cannot make the writes of these tests
/// fail that way.
fn read_only_is_respected(path: &str) -> bool {
	let mut permissions = fs::metadata(path).unwrap().permissions();
	permissions.set_readonly(true);
	fs::set_permissions(path, permissions).unwrap();
	let respected = fs::OpenOptions::new().append(true).open(path).is_err();
	if !respected {
		let mut permissions = fs::metadata(path).unwrap().permissions();
		#[allow(clippy::permissions_set_readonly_false)]
		permissions.set_readonly(false);
		fs::set_permissions(path, permissions).unwrap();
	}
	respected
}

#[test]
fn a_page_whose_url_a_key_makes_can_take_any_url_the_plan_allows() {
	let site = Site::new("path_any_url");
	site.write("src/1.html", "---\npath: /en/data.json\n---\n");
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/en/data.json"));
	let answer = edit(&mut ui, "/en/data.json", &ex, &move_to("/en/other.json"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/1.html"), "---\npath: /en/other.json\n---\n");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/en/other.json"));
	let answer = edit(&mut ui, "/en/other.json", &ex, &move_to("/en/x.htm"));
	assert!(ok(&answer), "{answer:?}");
	// the shape rules of §6 still apply
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/en/x.htm"));
	let answer = edit(&mut ui, "/en/x.htm", &ex, &move_to("/en//x.htm"));
	assert_eq!(code(&answer), "invalid");
}

#[test]
fn a_page_whose_key_is_in_its_sidecar_changes_the_sidecar() {
	let site = Site::new("path_in_sidecar");
	site.write("src/1.html", "---\ntitle: T\n---\n");
	site.write("src/1.json", r#"{ "path": "/en/news.html" }"#);
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/en/news.html"));
	let answer = edit(&mut ui, "/en/news.html", &ex, &move_to("/en/press.html"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/1.json"), r#"{ "path": "/en/press.html" }"#);
	assert_eq!(site.read("src/1.html"), "---\ntitle: T\n---\n");
}

#[test]
fn the_imports_of_a_page_follow_it_when_it_moves() {
	let site = Site::new("move_imports");
	site.write(
		"src/p/page.tsx",
		"import { Head } from '../shared/head';\nimport type { T } from './types';\nimport \"./side-effect\";\nexport { x } from './x?raw';\nimport pkg from 'a-package';\nconst lazy = () => import('./lazy');\nexport const meta = { title: 'T' };\nexport default () => <Head />;\n",
	);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/p/page.html"));
	let answer = edit(&mut ui, "/p/page.html", &ex, &move_to("/a/b/page.html"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/a/b/page.tsx"),
		"import { Head } from '../../shared/head';\nimport type { T } from '../../p/types';\nimport \"../../p/side-effect\";\nexport { x } from '../../p/x?raw';\nimport pkg from 'a-package';\nconst lazy = () => import('../../p/lazy');\nexport const meta = { title: 'T' };\nexport default () => <Head />;\n"
	);
	// and to a place that is closer to what it imports
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a/b/page.html"));
	let answer = edit(&mut ui, "/a/b/page.html", &ex, &move_to("/p/page.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(
		site.read("src/p/page.tsx")
			.contains("from '../shared/head'")
	);
	assert!(site.read("src/p/page.tsx").contains("from './types'"));
	assert!(site.read("src/p/page.tsx").contains("import('./lazy')"));
}

#[test]
fn a_name_that_starts_with_two_dots_is_a_name_and_not_a_way_out() {
	let site = Site::new("dots");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/..odd/page.html"));
	// refused because pages.files does not match a hidden directory, not because the name is
	// taken for a way out of the input directory
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	let message = answer.get("message").and_then(Value::as_str).unwrap();
	assert!(message.contains("pages.files"), "{message}");
	assert!(!message.contains("outside"), "{message}");
}

#[test]
fn a_move_that_fails_removes_the_directories_it_made() {
	let site = Site::new("move_dirs");
	site.write("src/a.html", "a");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html"}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let overrides = format!("{}/pages.overrides.json", site.root);
	if !read_only_is_respected(&overrides) {
		return;
	}
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/new/deep/b.html"));
	assert_eq!(code(&answer), "io", "{answer:?}");
	assert!(site.exists("src/a.html"));
	assert!(!site.exists("src/new"));
}

#[test]
fn what_could_not_be_put_back_is_said_and_the_rest_is_put_back() {
	let site = Site::new("stuck");
	site.write("kept.txt", "new");
	site.write("a.txt", "a");
	site.write("dir/inside.txt", "");
	site.write("made/empty/.keep", "");
	fs::remove_file(format!("{}/made/empty/.keep", site.root)).unwrap();
	let root = &site.root;
	// "gone.txt" was made from "a.txt" and does not exist; "dir" cannot be written as a file
	let stuck = put_back(
		&[(format!("{root}/a.txt"), format!("{root}/gone.txt"))],
		&[
			(format!("{root}/kept.txt"), Some(b"old".to_vec())),
			(format!("{root}/dir"), Some(b"x".to_vec())),
		],
		&[format!("{root}/made/empty"), format!("{root}/made")],
	);
	assert_eq!(stuck.len(), 2, "{stuck:?}");
	assert!(stuck[0].starts_with(&format!("{root}/dir: ")), "{stuck:?}");
	assert!(
		stuck[1].starts_with(&format!("{root}/gone.txt: ")),
		"{stuck:?}"
	);
	assert_eq!(site.read("kept.txt"), "old");
	assert!(!site.exists("made"));
	assert_eq!(put_back(&[], &[], &[]), Vec::<String>::new());
}

#[test]
fn directories_cannot_be_made_over_a_file() {
	let site = Site::new("blocked");
	site.write("a.txt", "a");
	site.write("file", "not a directory");
	let root = &site.root;
	let txn = Txn {
		renames: vec![(format!("{root}/a.txt"), format!("{root}/file/inside/a.txt"))],
		..Txn::default()
	};
	let failed = txn.commit().unwrap_err();
	assert_eq!(failed.code, "io");
	assert_eq!(site.read("a.txt"), "a");
	let txn = Txn {
		renames: vec![(format!("{root}/missing.txt"), format!("{root}/dir/x.txt"))],
		..Txn::default()
	};
	let failed = txn.commit().unwrap_err();
	assert_eq!(failed.code, "io");
	assert!(!site.exists("dir"));
}

#[test]
fn a_conflict_that_cannot_be_looked_into_says_so() {
	let site = Site::new("conflict_unreadable");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":1}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	let stale = expect(&rows, &page(&rows, "/a.html"));
	site.write("src/a.html", "---\ntitle: B\n---\n");
	site.write("pages.overrides.json", "{");
	let answer = edit(&mut ui, "/a.html", &stale, &set("title", r#""C""#));
	assert_eq!(code(&answer), "conflict");
	let message = answer.get("message").and_then(Value::as_str).unwrap();
	assert!(message.contains("could not be read again"), "{message}");
}

#[test]
fn the_files_were_written_but_the_site_cannot_be_read_now() {
	let site = Site::new("written_unreadable");
	site.write("src/a.html", "a");
	site.write("src/b.html", "b");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// another page is broken by someone else after the editor read the site
	site.write("src/b.html", "---\ntitle: [\n---\n");
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/c.html"));
	assert_eq!(code(&answer), "io", "{answer:?}");
	assert!(site.exists("src/c.html"));
	assert!(!site.exists("src/a.html"));
}

#[test]
fn a_new_key_is_refused_where_the_page_cannot_be_edited() {
	let site = Site::new("new_key_refused");
	site.write("src/anchors.html", "---\nbase: &b {x: 1}\nuse: *b\n---\n");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/anchors.html"));
	let answer = edit(&mut ui, "/anchors.html", &ex, &set("fresh", "1"));
	assert_eq!(code(&answer), "notEditable", "{answer:?}");
	assert!(site.read("src/anchors.html").contains("use: *b"));
}

#[test]
fn modules_are_edited_in_the_file_they_are_in() {
	let site = Site::new("modules");
	site.write(
		"src/a.tsx",
		"export const meta = { title: 'A', n: 1 };\nexport default () => null;\n",
	);
	site.write(
		"src/b.jsx",
		"export const meta = { title: 'B' };\nexport default () => null;\n",
	);
	site.write("src/c.htm", "---\ntitle: C\n---\n");
	let mut ui = site.open(r#", "pages": { "files": ["**/*.{html,htm,tsx,jsx}"] }"#);
	for (url, file, before, after) in [
		(
			"/a.html",
			"src/a.tsx",
			"export const meta = { title: 'A', n: 1 };",
			"export const meta = { title: 'Z', n: 1 };",
		),
		(
			"/b.html",
			"src/b.jsx",
			"export const meta = { title: 'B' };",
			"export const meta = { title: 'Z' };",
		),
		("/c.html", "src/c.htm", "title: C", "title: Z"),
	] {
		let rows = all(&mut ui);
		let ex = expect(&rows, &page(&rows, url));
		assert!(site.read(file).contains(before));
		let answer = edit(&mut ui, url, &ex, &set("title", r#""Z""#));
		assert!(ok(&answer), "{url}: {answer:?}");
		assert!(
			site.read(file).contains(after),
			"{url}: {}",
			site.read(file)
		);
	}
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &delete("n"))));
	assert_eq!(
		site.read("src/a.tsx"),
		"export const meta = { title: 'Z' };\nexport default () => null;\n"
	);
}

#[test]
fn a_key_of_pages_overrides_is_deleted_from_it() {
	let site = Site::new("overrides_delete");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a.html\", \"meta\": { \"nav\": true, \"title\": \"Over\" } }\n\t]\n}\n",
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let rows = all(&mut ui);
	assert_eq!(
		cell(&page(&rows, "/a.html"), "title").get("origin"),
		Some(&s("overrides"))
	);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &delete("title"))));
	assert_eq!(
		site.read("pages.overrides.json"),
		"{\n\t\"version\": 1,\n\t\"pages\": [\n\t\t{ \"url\": \"/a.html\", \"meta\": { \"nav\": true } }\n\t]\n}\n"
	);
	let rows = all(&mut ui);
	let c = cell(&page(&rows, "/a.html"), "title");
	assert_eq!(c.get("value"), Some(&s("A")));
	assert_eq!(c.get("origin"), Some(&s("inFile")));
	// a key the entry does not have
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert_eq!(
		code(&edit(&mut ui, "/a.html", &ex, &delete("absent"))),
		"invalid"
	);
}

#[test]
fn a_file_that_was_not_there_and_is_now_is_a_conflict() {
	let site = Site::new("appeared");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// the editor read no sidecar; one has appeared since
	site.write("src/a.json", "{}");
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/b.html"));
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	assert!(site.exists("src/a.html"));
	assert!(!site.exists("src/b.html"));
}

#[test]
fn a_page_cannot_move_into_the_output_directory() {
	let site = Site::new("into_output");
	site.write("a.html", "a");
	let mut ui = site.open_config(
		r#"{ "dir": { "input": ".", "output": "out" }, "build": { "cacheDir": ".cache" }, "pages": { "ignore": [".cache/**", "node_modules/**"] } }"#,
	);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/out/a.html"));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("a.html"));
	assert!(!site.exists("out"));
}

#[cfg(unix)]
#[test]
fn a_page_cannot_move_out_of_the_input_directory_through_a_link() {
	let site = Site::new("link_out");
	site.write("src/a.html", "a");
	site.write("outside/keep.txt", "");
	std::os::unix::fs::symlink(
		format!("{}/outside", site.root),
		format!("{}/src/link", site.root),
	)
	.unwrap();
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// the link is a directory of the input tree by its name, and a way out by where it leads
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/link/a.html"));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	let message = answer.get("message").and_then(Value::as_str).unwrap();
	assert!(message.contains("outside the input directory"), "{message}");
	assert!(site.exists("src/a.html"));
	assert!(!site.exists("outside/a.html"));
	// a directory that is not there yet is made inside the tree
	let answer = edit(&mut ui, "/a.html", &ex, &move_to("/new/a.html"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/new/a.html"));
}

#[test]
fn a_page_cannot_move_to_where_the_output_would_overwrite_a_source() {
	// the sources are inside the output directory, so an output path can be a source file
	let site = Site::new("over_source");
	site.write("out/src/a.html", "a");
	site.write("out/src/b.html", "b");
	let mut ui = site.open_config(
		r#"{ "dir": { "input": "out/src", "output": "out" }, "build": { "cacheDir": ".cache" } }"#,
	);
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/b.html"));
	let answer = edit(&mut ui, "/b.html", &ex, &move_to("/src/a.html"));
	assert_eq!(code(&answer), "collision", "{answer:?}");
	let message = answer.get("message").and_then(Value::as_str).unwrap();
	assert!(message.contains("source file"), "{message}");
	assert_eq!(site.read("out/src/a.html"), "a");
	assert!(site.exists("out/src/b.html"));
}

#[test]
fn the_files_were_written_but_the_page_cannot_be_read_again() {
	let site = Site::new("written_page_unreadable");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/a.json", r#"{"layout":"x"}"#);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a.html"));
	// the sidecar is broken by someone else; the edit does not touch it
	site.write("src/a.json", "{");
	let answer = edit(&mut ui, "/a.html", &ex, &set("title", r#""B""#));
	assert_eq!(code(&answer), "io", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "---\ntitle: B\n---\n");
}

#[test]
fn a_site_with_a_broken_page_cannot_be_opened() {
	let site = Site::new("broken_open");
	site.write("src/a.html", "---\ntitle: [\n---\n");
	site.write(
		"kamado.config.jsonc",
		r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache" } }"#,
	);
	let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
	assert!(Ui::open(loaded, &BuildOptions::default()).is_err());
}

#[test]
fn a_plan_cache_that_cannot_be_written_is_a_warning_of_close() {
	let site = Site::new("cache_blocked");
	site.write("src/a.html", "a");
	// the cache directory is a file
	site.write(".cache", "in the way");
	site.write(
		"kamado.config.jsonc",
		r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache", "incremental": true } }"#,
	);
	let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
	let mut ui = Ui::open(loaded, &BuildOptions::default()).unwrap();
	let warning = ui.close().expect("the cache cannot be written");
	assert!(warning.contains("plan cache"), "{warning}");
}

#[test]
fn a_handle_reads_the_plan_cache_the_last_one_wrote() {
	let site = Site::new("cache_round");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/b.html", "---\ntitle: B\n---\n");
	site.write(
		"kamado.config.jsonc",
		r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache", "incremental": true } }"#,
	);
	let open = || {
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
		Ui::open(loaded, &BuildOptions::default()).unwrap()
	};
	let mut first = open();
	assert!(first.close().is_none());
	// every page is in the cache now: the second plan reads none of them
	let mut second = open();
	assert_eq!(second.cache.pages.len(), 2);
	assert!(!second.cache_dirty);
	let rows = all(&mut second);
	assert_eq!(rows.get("total"), Some(&Value::Number(2.0)));
	assert_eq!(
		cell(&page(&rows, "/a.html"), "title").get("value"),
		Some(&s("A"))
	);
	// one of them is edited outside: it is read again, the other is not
	site.write("src/a.html", "---\ntitle: Changed\n---\n");
	second.refresh().unwrap();
	let rows = all(&mut second);
	assert_eq!(
		cell(&page(&rows, "/a.html"), "title").get("value"),
		Some(&s("Changed"))
	);
	assert!(second.cache_dirty);
}

#[test]
fn a_query_is_checked() {
	let site = Site::new("query");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	assert!(ui.pages(r#"{"offset":0,"limit":1,"q":5}"#).is_err());
	assert!(ui.pages(r#"{"offset":0.5,"limit":1}"#).is_err());
	assert!(ui.pages(r#"{"offset":0,"limit":"1"}"#).is_err());
	let none = rows(&mut ui, r#"{"offset":0,"limit":0}"#);
	assert_eq!(none.get("total"), Some(&Value::Number(1.0)));
	assert_eq!(none.get("pages"), Some(&Value::Array(Vec::new())));
	let nothing = rows(&mut ui, r#"{"offset":0,"limit":5,"q":"no such text"}"#);
	assert_eq!(nothing.get("total"), Some(&Value::Number(0.0)));
	let empty_q = rows(&mut ui, r#"{"offset":0,"limit":5,"q":""}"#);
	assert_eq!(empty_q.get("total"), Some(&Value::Number(1.0)));
}

#[test]
fn an_edit_of_a_file_that_is_not_the_copy_the_handle_holds_reads_the_file() {
	let site = Site::new("stale_copy");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":1}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	// someone else adds a key, and the editor is told the hash of the file as it is now
	let outside = r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":1,"m":2}}]}"#;
	site.write("pages.overrides.json", outside);
	let ex = format!(
		r#"{{"input":null,"sidecar":null,"overrides":"{}"}}"#,
		hash_hex(outside.as_bytes())
	);
	let answer = edit(&mut ui, "/a.html", &ex, &set("n", "9"));
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"n":9,"m":2}}]}"#
	);
	let rows = all(&mut ui);
	let a = page(&rows, "/a.html");
	assert_eq!(cell(&a, "n").get("value"), Some(&Value::Number(9.0)));
	assert_eq!(cell(&a, "m").get("value"), Some(&Value::Number(2.0)));
}

#[test]
fn the_current_of_a_conflict_is_the_file_even_if_it_looks_as_it_did() {
	let site = Site::new("same_stat");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let path = format!("{}/src/a.html", site.root);
	let modified = fs::metadata(&path).unwrap().modified().unwrap();
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let stale = expect(&rows, &page(&rows, "/a.html"));
	// the same number of bytes, and the modification time of the file as it was: what the
	// plan cache takes for a file that is as it was
	site.write("src/a.html", "---\ntitle: B\n---\n");
	fs::File::options()
		.write(true)
		.open(&path)
		.unwrap()
		.set_modified(modified)
		.unwrap();
	let answer = edit(&mut ui, "/a.html", &stale, &set("title", r#""C""#));
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	let current = answer.get("current").unwrap();
	assert_eq!(
		current.get("hashes").unwrap().get("input"),
		Some(&s(&hash_hex(b"---\ntitle: B\n---\n")))
	);
	assert_eq!(cell(current, "title").get("value"), Some(&s("B")));
}

#[test]
fn a_move_needs_to_know_whether_the_page_has_a_sidecar() {
	let site = Site::new("sidecar_field");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	// no `sidecar` in `expect`: the editor did not say whether there is one
	let answer = edit(&mut ui, "/a.html", r#"{"input":"x"}"#, &move_to("/b.html"));
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	let hash = hash_hex(b"a");
	let without = format!(r#"{{"input":"{hash}"}}"#);
	let answer = edit(&mut ui, "/a.html", &without, &move_to("/b.html"));
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/a.html"));
	let ex = expect(&rows, &page(&rows, "/a.html"));
	assert!(ok(&edit(&mut ui, "/a.html", &ex, &move_to("/b.html"))));
}

#[test]
fn an_entry_of_pages_overrides_that_has_the_new_url_is_a_collision() {
	let text =
		r#"{"version":1,"pages":[{"url":"/a/","meta":{"n":1}},{"url":"/b/","virtual":true}]}"#;
	let before = Overrides::parse(text).unwrap();
	let refused =
		edit_overrides_text("overrides.json", text, &before, "/a/", None, Some("/b/")).unwrap_err();
	assert_eq!(refused.code, "collision");
	let moved =
		edit_overrides_text("overrides.json", text, &before, "/a/", None, Some("/c/")).unwrap();
	assert_eq!(
		moved,
		r#"{"version":1,"pages":[{"url":"/c/","meta":{"n":1}},{"url":"/b/","virtual":true}]}"#
	);
}

#[test]
fn a_template_literal_import_is_left_as_it_is() {
	let site = Site::new("template_import");
	site.write(
		"src/p/page.tsx",
		"import a from '../shared/a';\nconst lazy = () => import(`./lazy`);\nexport const meta = { title: 'T' };\nexport default () => a;\n",
	);
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/p/page.html"));
	let answer = edit(&mut ui, "/p/page.html", &ex, &move_to("/q/page.html"));
	assert!(ok(&answer), "{answer:?}");
	let moved = site.read("src/q/page.tsx");
	assert!(moved.contains("import a from '../shared/a';"), "{moved}");
	assert!(moved.contains("import(`./lazy`)"), "{moved}");
}

#[test]
fn the_warnings_of_the_plan_are_in_the_rows() {
	let site = Site::new("warnings");
	site.write("src/a.html", "---\npath: /same.html\n---\n");
	site.write("src/b.html", "---\npath: /same.html\n---\n");
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let rows = all(&mut ui);
	let Some(Value::Array(warnings)) = rows.get("warnings") else {
		panic!("warnings")
	};
	assert!(!warnings.is_empty(), "{rows:?}");
	assert!(warnings[0].as_str().unwrap().contains("same.html"));
}

#[test]
fn the_server_settings_are_the_devserver_and_the_directories_of_the_config() {
	let site = Site::new("server_settings");
	let ui = site.open(r#", "devServer": { "port": 4321, "open": true }"#);
	let settings = ui.server();
	assert_eq!(settings.port, 4321);
	assert!(settings.open);
	assert_eq!(settings.input_dir, format!("{}/src", site.root));
	assert_eq!(settings.output_dir, format!("{}/out", site.root));
}

#[test]
fn the_server_settings_have_the_defaults_of_the_config() {
	let site = Site::new("server_defaults");
	let ui = site.open("");
	let settings = ui.server();
	assert_eq!(settings.port, 3000);
	assert!(!settings.open);
}

fn move_path(path: &str) -> String {
	format!(r#"{{"op":"movePath","path":{}}}"#, s(path).to_json())
}

fn layouts_of(ui: &mut Ui) -> Value {
	rows(ui, r#"{"offset":0,"limit":10}"#)
		.get("layouts")
		.unwrap_or_else(|| panic!("no layouts"))
		.clone()
}

fn names(list: &[&str]) -> Value {
	Value::Array(list.iter().map(|n| s(n)).collect())
}

const LAYOUTS: &str = r#", "pages": { "layouts": { "dir": "layouts" } }"#;

#[test]
fn layouts_are_the_names_of_the_tsx_and_jsx_files_directly_in_the_layouts_dir() {
	let site = Site::new("layouts_names");
	site.write("src/a.html", "a");
	site.write("layouts/sub.tsx", "export default () => null;");
	site.write("layouts/sub-with-side.tsx", "export default () => null;");
	site.write("layouts/only-jsx.jsx", "export default () => null;");
	// the same name in both extensions is one name
	site.write("layouts/both.tsx", "export default () => null;");
	site.write("layouts/both.jsx", "export default () => null;");
	// not layouts: another extension, a file in a directory, a directory with a layout's name
	site.write("layouts/readme.md", "x");
	site.write("layouts/nested/inner.tsx", "export default () => null;");
	site.write("layouts/dir.tsx/keep", "x");
	let mut ui = site.open(LAYOUTS);
	// the order is the order of the bytes of the names
	assert_eq!(
		layouts_of(&mut ui),
		names(&["both", "only-jsx", "sub", "sub-with-side"])
	);
}

#[test]
fn layouts_are_null_without_pages_layouts_dir_and_empty_for_a_missing_directory() {
	let site = Site::new("layouts_null");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	assert_eq!(layouts_of(&mut ui), Value::Null);
	let mut ui = site.open(LAYOUTS);
	assert_eq!(layouts_of(&mut ui), names(&[]));
}

#[test]
fn a_layouts_dir_that_is_not_a_directory_cannot_be_opened() {
	let site = Site::new("layouts_file");
	site.write("src/a.html", "a");
	site.write("layouts", "not a directory");
	site.write(
		"kamado.config.jsonc",
		&format!(
			r#"{{ "dir": {{ "input": "src", "output": "out" }}, "build": {{ "cacheDir": ".cache" }}{LAYOUTS} }}"#
		),
	);
	let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
	assert!(Ui::open(loaded, &BuildOptions::default()).is_err());
}

#[test]
fn refreshing_reads_the_layouts_dir_again() {
	let site = Site::new("layouts_refresh");
	site.write("src/a.html", "a");
	site.write("layouts/one.tsx", "export default () => null;");
	let mut ui = site.open(LAYOUTS);
	assert_eq!(layouts_of(&mut ui), names(&["one"]));
	site.write("layouts/two.tsx", "export default () => null;");
	// the list is read when the handle is opened and refreshed, not for each page of rows
	assert_eq!(layouts_of(&mut ui), names(&["one"]));
	ui.refresh().unwrap();
	assert_eq!(layouts_of(&mut ui), names(&["one", "two"]));
	fs::remove_file(format!("{}/layouts/one.tsx", site.root)).unwrap();
	ui.refresh().unwrap();
	assert_eq!(layouts_of(&mut ui), names(&["two"]));
}

/// Moves `from` (the URL of the page) to `path`, with the hashes the rows show.
fn path_move(ui: &mut Ui, from: &str, path: &str) -> Value {
	let rows = all(ui);
	let ex = expect(&rows, &page(&rows, from));
	edit(ui, from, &ex, &move_path(path))
}

#[test]
fn a_page_moves_to_the_path_that_is_typed_and_its_url_follows() {
	let site = Site::new("path_move");
	site.write("src/customer/send/index.html", "---\ntitle: A\n---\n");
	site.write("src/customer/send/index.json", r#"{"x":1}"#);
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/customer/send/", "customer/sending/");
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/customer/send/index.html"));
	assert_eq!(
		site.read("src/customer/sending/index.html"),
		"---\ntitle: A\n---\n"
	);
	assert_eq!(site.read("src/customer/sending/index.json"), r#"{"x":1}"#);
	let rows = all(&mut ui);
	page(&rows, "/customer/sending/");
	assert!(!ui.by_url.contains_key("/customer/send/"));
}

#[test]
fn a_path_is_read_from_the_input_directory_and_written_in_any_of_the_ways_a_path_is() {
	// each spelling and the file it names
	let cases = [
		("/b/c.html", "src/b/c.html"),
		("b\\c.html", "src/b/c.html"),
		("./b/c.html", "src/b/c.html"),
		("b/./c.html", "src/b/c.html"),
		("b//c.html", "src/b/c.html"),
		("x/../b/c.html", "src/b/c.html"),
		("b/c", "src/b/c.html"),
		("b/c/", "src/b/c/index.html"),
		("/", "src/index.html"),
	];
	for (n, (typed, file)) in cases.iter().enumerate() {
		let site = Site::new(&format!("path_spelling_{n}"));
		site.write("src/a/page.html", "a");
		let mut ui = site.open("");
		let answer = path_move(&mut ui, "/a/page.html", typed);
		assert!(ok(&answer), "{typed:?}: {answer:?}");
		assert_eq!(site.read(file), "a", "{typed:?}");
		assert!(!site.exists("src/a/page.html"), "{typed:?}");
	}
}

#[test]
fn a_path_that_leaves_the_input_directory_or_is_not_a_path_is_refused() {
	let site = Site::new("path_outside");
	site.write("src/a/page.html", "a");
	let mut ui = site.open("");
	for typed in [
		"../x.html",
		"b/../../x.html",
		"/../x.html",
		"",
		"b/\0c.html",
	] {
		let answer = path_move(&mut ui, "/a/page.html", typed);
		assert_eq!(code(&answer), "invalid", "{typed:?}: {answer:?}");
		assert_eq!(site.read("src/a/page.html"), "a");
	}
	assert!(!site.exists("x.html"));
}

#[test]
fn a_path_cannot_change_the_extension_of_the_file() {
	let site = Site::new("path_extension");
	site.write("src/a.html", "a");
	site.write("src/p.tsx", "export default () => null;\n");
	let mut ui = site.open("");
	// .htm and .html, .jsx and .tsx are other extensions; so is what reads as one: `v1.2`
	for typed in ["a.htm", "a.md", "v1.2", "a.tsx"] {
		let answer = path_move(&mut ui, "/a.html", typed);
		assert_eq!(code(&answer), "invalid", "{typed:?}: {answer:?}");
	}
	let answer = path_move(&mut ui, "/p.html", "p.jsx");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("src/a.html") && site.exists("src/p.tsx"));
	// the extension of the source is the one that is added
	let answer = path_move(&mut ui, "/p.html", "q/");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/q/index.tsx"));
}

#[test]
fn the_same_path_writes_nothing() {
	let site = Site::new("path_same");
	site.write("src/a/index.html", "a");
	let mut ui = site.open("");
	for typed in ["a/", "/a/index.html", "./a/index", "a\\index.html"] {
		let answer = path_move(&mut ui, "/a/", typed);
		assert_eq!(code(&answer), "invalid", "{typed:?}: {answer:?}");
	}
	assert_eq!(site.read("src/a/index.html"), "a");
}

#[test]
fn a_path_is_refused_where_a_url_move_would_be() {
	let site = Site::new("path_refused");
	site.write("src/a.html", "a");
	site.write("src/taken.html", "t");
	site.write("src/sidecar-here.json", "{}");
	let mut ui = site.open(r#", "pages": { "ignore": ["**/ignored.html"] }"#);
	// a file is there
	assert_eq!(
		code(&path_move(&mut ui, "/a.html", "taken.html")),
		"collision"
	);
	// a sidecar is there
	assert_eq!(
		code(&path_move(&mut ui, "/a.html", "sidecar-here.html")),
		"collision"
	);
	// pages.ignore
	assert_eq!(
		code(&path_move(&mut ui, "/a.html", "ignored.html")),
		"invalid"
	);
	assert_eq!(site.read("src/a.html"), "a");
}

#[test]
fn a_path_cannot_be_in_the_output_directory() {
	let site = Site::new("path_into_output");
	site.write("a.html", "a");
	let mut ui = site.open_config(
		r#"{ "dir": { "input": ".", "output": "out" }, "build": { "cacheDir": ".cache" }, "pages": { "ignore": [".cache/**", "node_modules/**"] } }"#,
	);
	let answer = path_move(&mut ui, "/a.html", "out/a.html");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
	assert!(site.exists("a.html"));
	assert!(!site.exists("out"));
}

#[test]
fn a_virtual_page_has_no_path_to_move() {
	let site = Site::new("path_virtual");
	site.write("src/a.html", "a");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/v/","virtual":true,"meta":{"title":"V"}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let answer = path_move(&mut ui, "/v/", "v/index.html");
	assert_eq!(code(&answer), "invalid", "{answer:?}");
}

#[test]
fn moving_the_path_of_a_page_whose_url_a_key_makes_keeps_its_url() {
	let site = Site::new("path_field_keeps_url");
	site.write("src/1.html", "---\npath: /en/news.html\ntitle: T\n---\n");
	site.write("src/1.json", r#"{"x":1}"#);
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let answer = path_move(&mut ui, "/en/news.html", "moved/one.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/1.html") && !site.exists("src/1.json"));
	assert_eq!(
		site.read("src/moved/one.html"),
		"---\npath: /en/news.html\ntitle: T\n---\n"
	);
	assert_eq!(site.read("src/moved/one.json"), r#"{"x":1}"#);
	let rows = all(&mut ui);
	let row = page(&rows, "/en/news.html");
	assert_eq!(
		row.get("inputPath"),
		Some(&s(&format!("{}/src/moved/one.html", site.root)))
	);
}

#[test]
fn moving_the_path_of_a_page_takes_its_entry_in_pages_overrides_along() {
	let site = Site::new("path_entry");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a.html","meta":{"nav":true}}]}"#,
	);
	let mut ui = site.open(r#", "pages": { "overrides": "pages.overrides.json" }"#);
	let answer = path_move(&mut ui, "/a.html", "z.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/z.html"));
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{"version":1,"pages":[{"url":"/z.html","meta":{"nav":true}}]}"#
	);
}

#[test]
fn moving_the_path_of_a_module_moves_its_imports() {
	let site = Site::new("path_imports");
	site.write(
		"src/p/page.tsx",
		"import { Head } from '../shared/head';\nexport const meta = { title: 'T' };\nexport default () => <Head />;\n",
	);
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/p/page.html", "a/b/page.tsx");
	assert!(ok(&answer), "{answer:?}");
	assert!(
		site.read("src/a/b/page.tsx")
			.contains("from '../../shared/head'")
	);
}

#[test]
fn a_path_that_makes_the_url_of_another_page_is_a_collision() {
	let site = Site::new("path_url_collision");
	site.write("src/a.html", "a");
	site.write("src/b/index.html", "b");
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/a.html", "b/");
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert_eq!(site.read("src/a.html"), "a");
}

#[test]
fn the_directories_a_move_empties_are_removed_up_to_the_input_directory() {
	let site = Site::new("prune_path");
	site.write("src/one/two/three/page.html", "p");
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/one/two/three/page.html", "page.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/page.html"));
	assert!(!site.exists("src/one"));
	// the input directory is not removed
	assert!(site.exists("src"));
}

#[test]
fn a_directory_that_holds_something_is_kept_when_a_move_empties_what_is_below_it() {
	let site = Site::new("prune_keeps");
	site.write("src/one/two/page.html", "p");
	site.write("src/one/keep.txt", "k");
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/one/two/page.html", "page.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.exists("src/one/two"));
	assert!(site.exists("src/one/keep.txt"));
}

#[test]
fn moving_a_url_removes_the_directory_it_empties_too() {
	let site = Site::new("prune_url");
	site.write("src/a/b/index.html", "p");
	let mut ui = site.open("");
	let rows = all(&mut ui);
	let ex = expect(&rows, &page(&rows, "/a/b/"));
	let answer = edit(&mut ui, "/a/b/", &ex, &move_to("/c/"));
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/c/index.html"));
	assert!(!site.exists("src/a"));
}

#[test]
fn a_move_that_stays_in_the_same_directory_does_not_remove_it() {
	let site = Site::new("prune_same_dir");
	site.write("src/a/one.html", "p");
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/a/one.html", "a/two.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/a/two.html"));
}

#[test]
fn a_move_request_without_a_path_is_an_error() {
	let site = Site::new("path_request");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	assert!(
		ui.edit(r#"{"url":"/a.html","change":{"op":"movePath"}}"#)
			.is_err()
	);
	assert!(
		ui.edit(r#"{"url":"/a.html","change":{"op":"movePath","path":1}}"#)
			.is_err()
	);
}

#[test]
fn a_refresh_that_cannot_read_the_layouts_dir_leaves_the_handle_as_it_was() {
	let site = Site::new("layouts_refresh_fails");
	site.write("src/a.html", "a");
	site.write("layouts/one.tsx", "export default () => null;");
	let mut ui = site.open(LAYOUTS);
	let version = ui.version;
	// the directory is now a file: it is there, and it cannot be read as a directory
	fs::remove_dir_all(format!("{}/layouts", site.root)).unwrap();
	site.write("layouts", "not a directory");
	site.write("src/b.html", "b");
	assert!(ui.refresh().is_err());
	assert_eq!(ui.version, version);
	assert_eq!(layouts_of(&mut ui), names(&["one"]));
	// and the page that was added is not in the plan the handle kept
	assert!(!ui.by_url.contains_key("/b.html"));
}

#[test]
fn a_layout_name_is_what_comes_before_tsx_or_jsx_and_is_a_name_the_build_finds() {
	let site = Site::new("layouts_edge_names");
	site.write("src/a.html", "a");
	// a dot inside a name is a name (`a.b.tsx` is looked for as `a.b`); `.tsx` alone has no name
	site.write("layouts/a.b.tsx", "export default () => null;");
	site.write("layouts/.tsx", "export default () => null;");
	site.write("layouts/plain.txt", "x");
	let mut ui = site.open(LAYOUTS);
	assert_eq!(layouts_of(&mut ui), names(&["a.b"]));
}

#[cfg(unix)]
#[test]
fn a_layout_that_is_a_link_to_a_file_is_a_layout_and_a_link_to_a_directory_is_not() {
	let site = Site::new("layouts_links");
	site.write("src/a.html", "a");
	site.write("shared/real.tsx", "export default () => null;");
	site.write("shared/dir/keep", "x");
	fs::create_dir_all(format!("{}/layouts", site.root)).unwrap();
	std::os::unix::fs::symlink(
		format!("{}/shared/real.tsx", site.root),
		format!("{}/layouts/linked.tsx", site.root),
	)
	.unwrap();
	std::os::unix::fs::symlink(
		format!("{}/shared/dir", site.root),
		format!("{}/layouts/folder.tsx", site.root),
	)
	.unwrap();
	let mut ui = site.open(LAYOUTS);
	assert_eq!(layouts_of(&mut ui), names(&["linked"]));
}

#[test]
fn a_path_that_ends_in_a_dot_names_a_directory() {
	for (n, typed) in ["b/c/..", "b/."].iter().enumerate() {
		let site = Site::new(&format!("path_dot_end_{n}"));
		site.write("src/a/page.html", "a");
		let mut ui = site.open("");
		let answer = path_move(&mut ui, "/a/page.html", typed);
		assert!(ok(&answer), "{typed:?}: {answer:?}");
		assert_eq!(site.read("src/b/index.html"), "a", "{typed:?}");
	}
}

#[test]
fn a_path_that_would_make_a_url_that_is_not_a_page_url_is_refused() {
	let site = Site::new("path_bad_url");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	for typed in ["q?x.html", "q#x.html"] {
		let answer = path_move(&mut ui, "/a.html", typed);
		assert_eq!(code(&answer), "invalid", "{typed:?}: {answer:?}");
		assert_eq!(site.read("src/a.html"), "a");
	}
}

#[test]
fn a_page_whose_url_a_key_makes_keeps_its_entry_in_pages_overrides_when_the_file_moves() {
	let site = Site::new("path_field_entry");
	site.write("src/1.html", "---\npath: /en/news.html\n---\n");
	let entry = r#"{"version":1,"pages":[{"url":"/en/news.html","meta":{"nav":true}}]}"#;
	site.write("pages.overrides.json", entry);
	let mut ui = site
		.open(r#", "pages": { "outputPathField": "path", "overrides": "pages.overrides.json" }"#);
	let answer = path_move(&mut ui, "/en/news.html", "moved/one.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/moved/one.html"));
	// the URL did not change, so the entry that is keyed by it did not either
	assert_eq!(site.read("pages.overrides.json"), entry);
	let rows = all(&mut ui);
	assert_eq!(
		cell(&page(&rows, "/en/news.html"), "nav").get("value"),
		Some(&Value::Bool(true))
	);
}

#[test]
fn a_move_into_a_directory_below_keeps_the_directory_it_left_from() {
	let site = Site::new("prune_child");
	site.write("src/a/b/x.html", "x");
	let mut ui = site.open("");
	let answer = path_move(&mut ui, "/a/b/x.html", "a/b/c/x.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/a/b/c/x.html"));
	assert!(site.exists("src/a/b"));
}

#[test]
fn the_input_directory_is_kept_when_it_is_the_root_of_the_project() {
	let site = Site::new("prune_dot_input");
	site.write("a/x.html", "x");
	let mut ui = site.open_config(
		r#"{ "dir": { "input": ".", "output": "out" }, "build": { "cacheDir": ".cache" }, "pages": { "ignore": [".cache/**", "node_modules/**"] } }"#,
	);
	let answer = path_move(&mut ui, "/a/x.html", "x.html");
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("x.html"));
	assert!(!site.exists("a"));
	assert!(site.exists("kamado.config.jsonc"));
}

#[test]
fn only_empty_directories_below_the_root_are_removed() {
	let site = Site::new("prune_function");
	let root = format!("{}/src", site.root);
	fs::create_dir_all(format!("{root}/one/two/three")).unwrap();
	fs::create_dir_all(format!("{root}/one/other")).unwrap();
	prune_empty_dirs(&format!("{root}/one/two/three/page.html"), &root);
	// `three` and `two` were empty; `one` still holds `other`; the root is never touched
	assert!(!site.exists("src/one/two"));
	assert!(site.exists("src/one/other"));
	fs::remove_dir_all(format!("{root}/one")).unwrap();
	prune_empty_dirs(&format!("{root}/gone/page.html"), &root);
	assert!(site.exists("src"));
	// a path outside the root is not walked at all
	fs::create_dir_all(format!("{}/outside/deep", site.root)).unwrap();
	prune_empty_dirs(&format!("{}/outside/deep/page.html", site.root), &root);
	assert!(site.exists("outside/deep"));
}

#[cfg(unix)]
#[test]
fn a_directory_that_is_a_link_is_not_removed() {
	let site = Site::new("prune_link");
	let root = format!("{}/src", site.root);
	fs::create_dir_all(format!("{}/elsewhere", site.root)).unwrap();
	std::os::unix::fs::symlink(format!("{}/elsewhere", site.root), format!("{root}/link")).unwrap();
	prune_empty_dirs(&format!("{root}/link/page.html"), &root);
	assert!(site.exists("src/link"));
	assert!(site.exists("elsewhere"));
}
