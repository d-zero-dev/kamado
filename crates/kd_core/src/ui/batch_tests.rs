//! A batch of edits made as one (RFC §14.2, "一括編集"): all or none, in an order that finds
//! the places free, with the hashes checked once before anything is written.

use super::batch::{Item, overlaps};
use super::*;

const OVERRIDES: &str = r#", "pages": { "overrides": "pages.overrides.json" }"#;

struct Site {
	root: String,
}

impl Site {
	fn new(name: &str) -> Site {
		let root = format!(
			"{}/kd_ui_batch_{name}_{}",
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

	/// Every file under the site (without the cache and the output), with its text: what a
	/// batch that is refused has to leave exactly as it was.
	fn snapshot(&self) -> std::collections::BTreeMap<String, String> {
		fn walk(
			dir: &std::path::Path,
			root: &std::path::Path,
			out: &mut std::collections::BTreeMap<String, String>,
		) {
			for entry in fs::read_dir(dir).unwrap() {
				let path = entry.unwrap().path();
				let rel = path.strip_prefix(root).unwrap().display().to_string();
				if rel.starts_with(".cache") || rel.starts_with("out") {
					continue;
				}
				if path.is_dir() {
					out.insert(format!("{rel}/"), String::new());
					walk(&path, root, out);
				} else {
					out.insert(rel, fs::read_to_string(&path).unwrap());
				}
			}
		}
		let mut out = std::collections::BTreeMap::new();
		let root = std::path::Path::new(&self.root);
		walk(root, root, &mut out);
		out
	}
}

fn json(text: &str) -> Value {
	kd_jsonc::parse(text).unwrap()
}

fn rows(ui: &mut Ui) -> Value {
	json(&ui.pages(r#"{"offset":0,"limit":1000}"#).unwrap())
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
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.any(|p| p.get("url").and_then(Value::as_str) == Some(url))
}

fn s(text: &str) -> String {
	Value::String(text.to_string()).to_json()
}

/// An `expect` made of the hashes a row shows.
fn expect(rows: &Value, url: &str) -> String {
	let row = page(rows, url);
	let hashes = row.get("hashes").unwrap();
	let part = |v: Option<&Value>| v.map_or("null".to_string(), Value::to_json);
	format!(
		r#"{{"input":{},"sidecar":{},"overrides":{}}}"#,
		part(hashes.get("input")),
		part(hashes.get("sidecar")),
		part(rows.get("overridesHash")),
	)
}

fn overrides_only(rows: &Value) -> String {
	format!(
		r#"{{"overrides":{}}}"#,
		rows.get("overridesHash")
			.map_or("null".to_string(), Value::to_json)
	)
}

/// A batch request from `(url, expect, change)` triples.
fn request(edits: &[(&str, String, String)]) -> String {
	let list: Vec<String> = edits
		.iter()
		.map(|(url, expect, change)| {
			format!(
				r#"{{"url":{},"expect":{expect},"change":{change}}}"#,
				s(url)
			)
		})
		.collect();
	format!(r#"{{"edits":[{}]}}"#, list.join(","))
}

fn batch(ui: &mut Ui, edits: &[(&str, String, String)]) -> Value {
	json(&ui.edit_batch(&request(edits)).unwrap())
}

fn set(key: &str, value: &str) -> String {
	format!(r#"{{"op":"set","key":{},"value":{}}}"#, s(key), s(value))
}

fn move_to(url: &str) -> String {
	format!(r#"{{"op":"moveUrl","url":{}}}"#, s(url))
}

fn move_path(path: &str) -> String {
	format!(r#"{{"op":"movePath","path":{}}}"#, s(path))
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

fn errors(answer: &Value) -> Vec<(usize, String)> {
	let Some(Value::Array(list)) = answer.get("errors") else {
		panic!("no errors in {answer:?}")
	};
	list.iter()
		.map(|e| {
			(
				e.get("index").and_then(Value::as_f64).unwrap() as usize,
				e.get("code").and_then(Value::as_str).unwrap().to_string(),
			)
		})
		.collect()
}

fn html(title: &str, body: &str) -> String {
	format!("---\ntitle: {title}\n---\n<p>{body}</p>")
}

/// Three pages, `/a/`, `/b/` and `/c/`, each with a title and a body of its own.
fn three(name: &str) -> (Site, Ui) {
	let site = Site::new(name);
	for (dir, upper) in [("a", "A"), ("b", "B"), ("c", "C")] {
		site.write(
			&format!("src/{dir}/index.html"),
			&html(upper, &upper.to_lowercase()),
		);
	}
	let ui = site.open("");
	(site, ui)
}

#[test]
fn an_empty_batch_changes_nothing() {
	let (site, mut ui) = three("empty");
	let before = site.snapshot();
	let version = ui.version;
	let answer = json(&ui.edit_batch(r#"{"edits":[]}"#).unwrap());
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(answer.get("count").and_then(Value::as_f64), Some(0.0));
	assert_eq!(ui.version, version);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_request_that_is_not_a_batch_is_an_error() {
	let (_site, mut ui) = three("shape");
	assert!(ui.edit_batch("{").is_err());
	assert!(ui.edit_batch(r#"{"edits":{}}"#).is_err());
	assert!(ui.edit_batch(r#"{"edits":[1]}"#).is_err());
	let bad = ui.edit_batch(r#"{"edits":[{"url":"/a/","change":{"op":"nope"}}]}"#);
	assert!(bad.unwrap_err().contains("edits[0]"));
}

#[test]
fn edits_of_several_pages_are_made_together_and_count_as_one_version() {
	let (site, mut ui) = three("keys");
	let r = rows(&mut ui);
	let version = ui.version;
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			("/b/", expect(&r, "/b/"), set("title", "B2")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(answer.get("count").and_then(Value::as_f64), Some(2.0));
	assert_eq!(ui.version, version + 1);
	assert!(site.read("src/a/index.html").contains("title: A2"));
	assert!(site.read("src/b/index.html").contains("title: B2"));
	assert!(site.read("src/c/index.html").contains("title: C"));
}

#[test]
fn a_changed_file_stops_the_batch_before_anything_is_written() {
	let (site, mut ui) = three("conflict");
	let r = rows(&mut ui);
	site.write("src/b/index.html", &html("B changed", "b"));
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			("/b/", expect(&r, "/b/"), set("title", "B2")),
		],
	);
	assert!(!ok(&answer));
	assert_eq!(code(&answer), "conflict");
	assert_eq!(errors(&answer), vec![(1, "conflict".to_string())]);
	assert_eq!(
		site.snapshot(),
		before,
		"the first edit was not written either"
	);
}

#[test]
fn every_page_that_is_not_there_is_told() {
	let (site, mut ui) = three("notfound");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/x/", "{}".to_string(), set("title", "X")),
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			("/y/", "{}".to_string(), set("title", "Y")),
		],
	);
	assert_eq!(code(&answer), "notFound");
	assert_eq!(
		errors(&answer),
		vec![(0, "notFound".to_string()), (2, "notFound".to_string())]
	);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn revert_is_not_taken() {
	let (site, mut ui) = three("revert");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[(
			"/a/",
			expect(&r, "/a/"),
			r#"{"op":"revert","key":"title","head":{}}"#.to_string(),
		)],
	);
	assert_eq!(errors(&answer), vec![(0, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_chain_of_moves_is_made_whatever_order_it_is_written_in() {
	let (site, mut ui) = three("chain");
	let r = rows(&mut ui);
	// /a/ -> /b/ goes where /b/ -> /c/ goes from, and /c/ goes away.
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			("/b/", expect(&r, "/b/"), move_to("/c/")),
			(
				"/c/",
				expect(&r, "/c/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/b/index.html").contains("title: A"));
	assert!(site.read("src/c/index.html").contains("title: B"));
	assert!(!site.exists("src/a"));
	let now = rows(&mut ui);
	assert!(!has_page(&now, "/a/"));
	assert!(has_page(&now, "/b/") && has_page(&now, "/c/"));
}

#[test]
fn two_pages_exchange_their_urls() {
	let (site, mut ui) = three("swap");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			("/b/", expect(&r, "/b/"), move_to("/a/")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/a/index.html").contains("title: B"));
	assert!(site.read("src/b/index.html").contains("title: A"));
	assert!(site.read("src/c/index.html").contains("title: C"));
	let files: Vec<String> = site.snapshot().into_keys().collect();
	assert!(
		files
			.iter()
			.all(|f| !f.contains("kamado-tmp") && !f.contains("kamado-removed")),
		"nothing of the parking is left: {files:?}"
	);
}

#[test]
fn three_pages_in_a_ring_of_urls_are_made() {
	let (site, mut ui) = three("ring");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			("/b/", expect(&r, "/b/"), move_to("/c/")),
			("/c/", expect(&r, "/c/"), move_to("/a/")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/b/index.html").contains("title: A"));
	assert!(site.read("src/c/index.html").contains("title: B"));
	assert!(site.read("src/a/index.html").contains("title: C"));
}

#[test]
fn two_files_exchange_their_paths() {
	let site = Site::new("swap_path");
	site.write("src/x.html", &html("X", "x"));
	site.write("src/y.html", &html("Y", "y"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/x.html", expect(&r, "/x.html"), move_path("y.html")),
			("/y.html", expect(&r, "/y.html"), move_path("x.html")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/x.html").contains("title: Y"));
	assert!(site.read("src/y.html").contains("title: X"));
	let files: Vec<String> = site.snapshot().into_keys().collect();
	assert!(files.iter().all(|f| !f.contains("kamado-tmp")), "{files:?}");
}

#[test]
fn a_page_that_is_deleted_gives_its_place_to_a_move_into_it() {
	let (site, mut ui) = three("delete_then_move");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			(
				"/b/",
				expect(&r, "/b/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/b/index.html").contains("title: A"));
	assert!(!site.exists("src/a"));
}

#[test]
fn a_page_can_be_made_where_a_move_leaves() {
	let site = Site::new("create_after_move");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
			("/a/", expect(&r, "/a/"), move_to("/z/")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	let now = rows(&mut ui);
	assert!(has_page(&now, "/z/") && has_page(&now, "/a/"));
	assert!(site.read("src/z/index.html").contains("title: A"));
	assert_eq!(
		page(&now, "/a/").get("virtual"),
		Some(&Value::Bool(true)),
		"the page at /a/ is the one the batch made"
	);
}

#[test]
fn keys_are_written_to_a_page_as_the_batch_leaves_it() {
	let site = Site::new("key_after_materialize");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": { "title": "V" } } ] }"#,
	);
	site.write("src/a/index.html", &html("A", "a"));
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/v/", overrides_only(&r), set("lead", "L")),
			(
				"/v/",
				overrides_only(&r),
				r#"{"op":"materialize","path":"v/index.html"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/v/index.html"));
	assert!(
		site.read("src/v/index.html").contains("lead: L"),
		"the key went into the file the page has when the batch ends"
	);
}

#[test]
fn edits_that_exclude_each_other_are_all_told() {
	let (site, mut ui) = three("overlap");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/x/")),
			("/b/", expect(&r, "/b/"), move_to("/x/")),
			(
				"/c/",
				expect(&r, "/c/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
			("/c/", expect(&r, "/c/"), set("title", "C2")),
		],
	);
	assert_eq!(code(&answer), "collision");
	assert_eq!(
		errors(&answer),
		vec![
			(0, "collision".to_string()),
			(1, "collision".to_string()),
			(2, "collision".to_string()),
			(3, "collision".to_string()),
		]
	);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_failure_in_the_middle_puts_back_what_was_made() {
	let site = Site::new("rollback");
	for (dir, upper) in [("a", "A"), ("b", "B"), ("c", "C"), ("d", "D")] {
		site.write(
			&format!("src/{dir}/index.html"),
			&html(upper, &upper.to_lowercase()),
		);
	}
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let version = ui.version;
	// The page at /d/ goes (made first), the file of /b/ is moved (next), and the move of /a/
	// to /c/ is refused: /c/ is a page the batch leaves where it is.
	let answer = batch(
		&mut ui,
		&[
			(
				"/d/",
				expect(&r, "/d/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
			("/b/", expect(&r, "/b/"), move_to("/e/")),
			("/a/", expect(&r, "/a/"), move_to("/c/")),
		],
	);
	assert!(!ok(&answer), "{answer:?}");
	assert_eq!(code(&answer), "collision");
	assert_eq!(errors(&answer), vec![(2, "collision".to_string())]);
	assert_eq!(
		site.snapshot(),
		before,
		"every file is as it was, and the deleted one is back"
	);
	let now = rows(&mut ui);
	assert!(has_page(&now, "/d/") && has_page(&now, "/b/") && !has_page(&now, "/e/"));
	assert_eq!(
		ui.version, version,
		"a refused batch leaves the version as it was"
	);
}

#[test]
fn a_page_that_is_made_and_one_that_is_set_in_one_batch_are_both_written() {
	let site = Site::new("create_and_set");
	site.write("src/a/index.html", &html("A", "a"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			(
				"/n/",
				"{}".to_string(),
				r#"{"op":"create","path":"n/index.html"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/n/index.html"));
	assert!(site.read("src/a/index.html").contains("title: A2"));
}

fn site_of_keys(name: &str) -> (Site, Ui) {
	let site = Site::new(name);
	site.write("src/a/index.html", "---\ntitle: A\nlead: la\n---\n<p>a</p>");
	site.write("src/b/index.html", "---\ntitle: B\n---\n<p>b</p>");
	site.write(
		"src/b/index.json",
		"{\n\t\"layout\": \"x\",\n\t\"nav\": 1\n}\n",
	);
	site.write(
		"pages.overrides.json",
		concat!(
			"{\n\t\"version\": 1,\n\t\"pages\": [\n",
			"\t\t{ \"url\": \"/v1/\", \"virtual\": true, \"meta\": { \"title\": \"V1\" } },\n",
			"\t\t{ \"url\": \"/a/\", \"meta\": { \"badge\": \"new\" } },\n",
			"\t\t{ \"url\": \"/v2/\", \"virtual\": true },\n",
			"\t\t{ \"url\": \"/v3/\", \"virtual\": true, \"meta\": null, \"lastmod\": \"2024-02-02\" }\n",
			"\t]\n}\n"
		),
	);
	let ui = site.open(OVERRIDES);
	(site, ui)
}

/// The edits the two tests below make: in a page file, in a sidecar, in the entry of a page
/// that has a file, in the entries of virtual pages (one that has no `meta` yet), two on one key.
fn key_edits() -> Vec<(&'static str, String)> {
	vec![
		("/a/", set("title", "A2")),
		("/a/", set("added", "x")),
		("/a/", set("badge", "old")),
		("/b/", r#"{"op":"delete","key":"nav"}"#.to_string()),
		("/b/", set("layout", "y")),
		("/v1/", set("title", "V1b")),
		("/v1/", set("fresh", "f")),
		("/v1/", r#"{"op":"delete","key":"fresh"}"#.to_string()),
		("/v2/", set("title", "V2")),
		("/v2/", set("title", "V2b")),
		// an entry whose `meta` is `null` and that has a `lastmod`
		("/v3/", set("title", "V3")),
	]
}

#[test]
fn the_keys_of_a_batch_give_the_files_the_same_edits_made_one_by_one_give() {
	let (batched, mut ui) = site_of_keys("keys_batched");
	let rows_at_start = rows(&mut ui);
	let edits: Vec<(&str, String, String)> = key_edits()
		.into_iter()
		.map(|(url, change)| {
			let ex = if url.starts_with("/v") {
				overrides_only(&rows_at_start)
			} else {
				expect(&rows_at_start, url)
			};
			(url, ex, change)
		})
		.collect();
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{answer:?}");

	let (single, mut one) = site_of_keys("keys_single");
	for (url, change) in key_edits() {
		let r = rows(&mut one);
		let ex = if url.starts_with("/v") {
			overrides_only(&r)
		} else {
			expect(&r, url)
		};
		let request = format!(r#"{{"url":{},"expect":{ex},"change":{change}}}"#, s(url));
		let answer = json(&one.edit(&request).unwrap());
		assert!(ok(&answer), "{url} {change}: {answer:?}");
	}
	let of = |site: &Site| -> std::collections::BTreeMap<String, String> {
		site.snapshot()
			.into_iter()
			.filter(|(path, _)| !path.starts_with("kamado.config"))
			.collect()
	};
	assert_eq!(of(&batched), of(&single));
	// and what the handle shows is what the files say
	let shown = rows(&mut ui);
	let read = rows(&mut one);
	for url in ["/a/", "/b/", "/v1/", "/v2/", "/v3/"] {
		assert_eq!(
			page(&shown, url).get("meta"),
			page(&read, url).get("meta"),
			"{url}"
		);
	}
	assert_eq!(shown.get("overridesHash"), read.get("overridesHash"));
}

#[test]
fn a_key_that_a_batch_cannot_write_puts_back_the_keys_it_wrote() {
	let (site, mut ui) = site_of_keys("keys_rollback");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			("/v1/", overrides_only(&r), set("title", "V1b")),
			// the page has no such key
			(
				"/b/",
				expect(&r, "/b/"),
				r#"{"op":"delete","key":"nope"}"#.to_string(),
			),
		],
	);
	assert!(!ok(&answer), "{answer:?}");
	assert_eq!(errors(&answer), vec![(2, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
	let now = rows(&mut ui);
	assert_eq!(
		page(&now, "/a/")
			.get("meta")
			.and_then(|m| m.get("title"))
			.and_then(|c| c.get("value")),
		Some(&Value::String("A".to_string())),
		"what the handle shows is what the files say"
	);
}

#[test]
fn many_keys_of_a_big_pages_overrides_plan_the_site_once() {
	let site = Site::new("many_keys");
	let n = 20_000;
	let mut o = String::from("{ \"version\": 1, \"pages\": [\n");
	for i in 0..n {
		o.push_str(&format!(
			"{{ \"url\": \"/p{i}/\", \"virtual\": true, \"meta\": {{ \"title\": \"T{i}\" }} }},\n"
		));
	}
	o.truncate(o.len() - 2);
	o.push_str("\n] }");
	site.write("pages.overrides.json", &o);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let ex = overrides_only(&r);
	let edits: Vec<(String, String, String)> = (0..n)
		.map(|i| {
			(
				format!("/p{i}/"),
				ex.clone(),
				set("title", &format!("N{i}")),
			)
		})
		.collect();
	let edits: Vec<(&str, String, String)> = edits
		.iter()
		.map(|(u, e, c)| (u.as_str(), e.clone(), c.clone()))
		.collect();
	let planned = ui.plans;
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{:?}", answer.get("message"));
	// Each of these edits made one by one plans the site again; a batch plans it once, at the
	// end, from the files.
	assert_eq!(ui.plans - planned, 1);
	let text = site.read("pages.overrides.json");
	assert!(text.contains(r#""title": "N19999""#) && !text.contains(r#""T19999""#));
}

#[test]
fn the_page_files_a_batch_follows_are_the_ones_its_commits_leave() {
	let (site, ui) = three("follow");
	site.write("src/a/index.json", "{}");
	let root = &site.root;
	let mut found = super::batch::FoundFiles::walk(&ui.loaded.config).unwrap();
	assert_eq!(
		found.list(),
		vec!["a/index.html", "b/index.html", "c/index.html"]
	);
	let src = |rel: &str| format!("{root}/src/{rel}");
	let events = vec![
		// a page moves, with its sidecar (not a page file)
		Event::Rename(src("a/index.html"), src("z/index.html")),
		Event::Rename(src("a/index.json"), src("z/index.json")),
		// a page is set aside to be removed: no page has that name
		Event::Rename(src("b/index.html"), src("b/.index.html.kamado-removed")),
		// a page file is made, and one is rewritten
		Event::Write(src("n/index.html"), None),
		Event::Write(src("c/index.html"), Some(b"old".to_vec())),
		// a file that is not a page, and a path outside the input directory
		Event::Write(src("n/notes.txt"), None),
		Event::Write(format!("{root}/pages.overrides.json"), None),
		Event::MadeDirs(vec![src("n")]),
	];
	found.follow(&events);
	assert_eq!(
		found.list(),
		vec!["c/index.html", "n/index.html", "z/index.html"]
	);
	// what was followed is not followed again, and what comes after is
	let mut more = events;
	more.push(Event::Rename(src("z/index.html"), src("y/index.html")));
	found.follow(&more);
	assert_eq!(
		found.list(),
		vec!["c/index.html", "n/index.html", "y/index.html"]
	);
}

#[test]
fn a_site_with_many_moves_agrees_with_its_directory_when_the_batch_ends() {
	// moves that exchange, chain and park, with a page made and one removed in the same batch
	let site = Site::new("many_moves");
	for i in 0..8 {
		site.write(
			&format!("src/p{i}/index.html"),
			&html(&format!("P{i}"), "x"),
		);
	}
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let mut edits: Vec<(String, String, String)> = Vec::new();
	for i in 0..6 {
		let next = (i + 1) % 6;
		edits.push((
			format!("/p{i}/"),
			expect(&r, &format!("/p{i}/")),
			move_to(&format!("/p{next}/")),
		));
	}
	edits.push((
		"/p6/".to_string(),
		expect(&r, "/p6/"),
		r#"{"op":"deletePage"}"#.to_string(),
	));
	edits.push((
		"/new/".to_string(),
		"{}".to_string(),
		r#"{"op":"create","path":"new/index.html"}"#.to_string(),
	));
	let edits: Vec<(&str, String, String)> = edits
		.iter()
		.map(|(u, e, c)| (u.as_str(), e.clone(), c.clone()))
		.collect();
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{answer:?}");
	// P0 is at /p1/, P1 at /p2/ ... P5 at /p0/
	assert!(site.read("src/p1/index.html").contains("title: P0"));
	assert!(site.read("src/p0/index.html").contains("title: P5"));
	assert!(!site.exists("src/p6"));
	assert!(site.exists("src/new/index.html"));
	let now = rows(&mut ui);
	let mut again = site.open("");
	let reread = rows(&mut again);
	let of = |rows: &Value| -> Vec<(String, Value)> {
		let Some(Value::Array(pages)) = rows.get("pages") else {
			panic!("pages")
		};
		let mut list: Vec<(String, Value)> = pages
			.iter()
			.map(|p| {
				(
					p.get("url").and_then(Value::as_str).unwrap().to_string(),
					p.get("meta").cloned().unwrap_or(Value::Null),
				)
			})
			.collect();
		list.sort_by(|a, b| a.0.cmp(&b.0));
		list
	};
	assert_eq!(
		of(&now),
		of(&reread),
		"what the handle shows is what a new plan of the directory shows"
	);
}

#[test]
fn hundreds_of_moves_plan_the_site_once() {
	let site = Site::new("hundreds_of_moves");
	let n = 2000;
	let moves = 300;
	for i in 0..n {
		site.write(
			&format!("src/p{i}/index.html"),
			&html(&format!("P{i}"), "x"),
		);
	}
	let mut ui = site.open("");
	let r = json(&ui.pages(&format!(r#"{{"offset":0,"limit":{n}}}"#)).unwrap());
	let edits: Vec<(String, String, String)> = (0..moves)
		.map(|i| {
			let url = format!("/p{i}/");
			(url.clone(), expect(&r, &url), move_to(&format!("/q{i}/")))
		})
		.collect();
	let edits: Vec<(&str, String, String)> = edits
		.iter()
		.map(|(u, e, c)| (u.as_str(), e.clone(), c.clone()))
		.collect();
	let planned = ui.plans;
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{:?}", answer.get("message"));
	// The plan is kept up to date from the files that changed (`patch_plan`), so the whole site
	// is planned once, at the end, and not for each move.
	assert_eq!(ui.plans - planned, 1);
	assert!(site.exists("src/q299/index.html") && !site.exists("src/p299/index.html"));
	assert!(site.exists("src/p300/index.html"));
}

fn site_of_entries(name: &str) -> (Site, Ui) {
	let site = Site::new(name);
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	site.write("src/b/index.html", "---\ntitle: B\nlead: lb\n---\n<p>b</p>");
	site.write("src/c/index.html", "---\ntitle: C\n---\n<p>c</p>");
	site.write(
		"pages.overrides.json",
		concat!(
			"{\n\t\"version\": 1,\n\t\"pages\": [\n",
			"\t\t{ \"url\": \"/a/\", \"meta\": { \"badge\": \"new\" } },\n",
			"\t\t{ \"url\": \"/v1/\", \"virtual\": true, \"meta\": { \"title\": \"V1\" } },\n",
			"\t\t{ \"url\": \"/v2/\", \"virtual\": true },\n",
			"\t\t{ \"url\": \"/v3/\", \"virtual\": true, \"meta\": { \"title\": \"V3\" } },\n",
			"\t\t{ \"url\": \"/v4/\", \"virtual\": true, \"meta\": { \"title\": \"V4\" }, \"lastmod\": \"2024-01-01\" }\n",
			"\t]\n}\n"
		),
	);
	let ui = site.open(OVERRIDES);
	(site, ui)
}

/// Edits that change the entries of `pages.overrides`, in the order a batch makes them: what
/// frees places, the moves, then what takes places.
fn entry_edits() -> Vec<(&'static str, String)> {
	vec![
		("/v2/", r#"{"op":"deletePage"}"#.to_string()),
		("/b/", r#"{"op":"virtualize"}"#.to_string()),
		("/a/", move_to("/a2/")),
		("/v3/", move_to("/v3x/")),
		(
			"/v1/",
			r#"{"op":"materialize","path":"v1/index.html"}"#.to_string(),
		),
		(
			"/v4/",
			r#"{"op":"materialize","path":"v4/index.html"}"#.to_string(),
		),
		("/n1/", r#"{"op":"create","path":null}"#.to_string()),
		("/n2/", r#"{"op":"create","path":null}"#.to_string()),
	]
}

fn ex_for(rows: &Value, url: &str) -> String {
	if has_page(rows, url) {
		expect(rows, url)
	} else {
		overrides_only(rows)
	}
}

#[test]
fn the_entries_of_a_batch_give_the_files_the_same_edits_made_one_by_one_give() {
	let (batched, mut ui) = site_of_entries("entries_batched");
	let r = rows(&mut ui);
	let edits: Vec<(&str, String, String)> = entry_edits()
		.into_iter()
		.map(|(url, change)| (url, ex_for(&r, url), change))
		.collect();
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{answer:?}");

	let (single, mut one) = site_of_entries("entries_single");
	for (url, change) in entry_edits() {
		let r = rows(&mut one);
		let request = format!(
			r#"{{"url":{},"expect":{},"change":{change}}}"#,
			s(url),
			ex_for(&r, url)
		);
		let answer = json(&one.edit(&request).unwrap());
		assert!(ok(&answer), "{url} {change}: {answer:?}");
	}
	let of = |site: &Site| -> std::collections::BTreeMap<String, String> {
		site.snapshot()
			.into_iter()
			.filter(|(path, _)| !path.starts_with("kamado.config"))
			.collect()
	};
	assert_eq!(of(&batched), of(&single));
	let shown = rows(&mut ui);
	let read = rows(&mut one);
	assert_eq!(shown.get("total"), read.get("total"));
	for url in ["/a2/", "/b/", "/v1/", "/v3x/", "/v4/", "/n1/", "/n2/"] {
		assert_eq!(
			page(&shown, url).get("meta"),
			page(&read, url).get("meta"),
			"{url}"
		);
	}
	assert!(!has_page(&shown, "/v2/") && !has_page(&shown, "/a/"));
	assert_eq!(shown.get("overridesHash"), read.get("overridesHash"));
}

#[test]
fn a_failure_after_entries_were_changed_leaves_pages_overrides_as_it_was() {
	let (site, mut ui) = site_of_entries("entries_rollback");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let mut edits: Vec<(&str, String, String)> = entry_edits()
		.into_iter()
		.map(|(url, change)| (url, ex_for(&r, url), change))
		.collect();
	// the last one is refused when it is made: /c/ is a page the batch leaves where it is
	edits.push(("/b/", expect(&r, "/b/"), move_to("/c/")));
	let answer = batch(&mut ui, &edits);
	assert!(!ok(&answer), "{answer:?}");
	assert_eq!(site.snapshot(), before, "no file is as the batch left it");
	let now = rows(&mut ui);
	assert!(has_page(&now, "/v2/") && has_page(&now, "/a/") && !has_page(&now, "/n1/"));
}

#[test]
fn hundreds_of_virtual_pages_plan_the_site_once() {
	let site = Site::new("many_virtual");
	let n = 20_000;
	let mut o = String::from("{ \"version\": 1, \"pages\": [\n");
	for i in 0..n {
		o.push_str(&format!(
			"{{ \"url\": \"/p{i}/\", \"virtual\": true, \"meta\": {{ \"title\": \"T{i}\" }} }},\n"
		));
	}
	o.truncate(o.len() - 2);
	o.push_str("\n] }");
	site.write("pages.overrides.json", &o);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let ex = overrides_only(&r);
	let edits: Vec<(String, String, String)> = (0..100)
		.map(|i| {
			(
				format!("/new{i}/"),
				ex.clone(),
				r#"{"op":"create","path":null}"#.to_string(),
			)
		})
		.chain((0..100).map(|i| {
			(
				format!("/p{i}/"),
				ex.clone(),
				move_to(&format!("/moved{i}/")),
			)
		}))
		.collect();
	let edits: Vec<(&str, String, String)> = edits
		.iter()
		.map(|(u, e, c)| (u.as_str(), e.clone(), c.clone()))
		.collect();
	let planned = ui.plans;
	let answer = batch(&mut ui, &edits);
	assert!(ok(&answer), "{:?}", answer.get("message"));
	// The entries are changed in the handle, and the file is written and read once, at the end.
	assert_eq!(ui.plans - planned, 1);
	let text = site.read("pages.overrides.json");
	assert!(text.contains("/new99/") && text.contains("/moved99/") && !text.contains("\"/p99/\""));
}

#[test]
fn a_batch_counts_one_version_however_many_edits_it_has() {
	let (_site, mut ui) = three("one_version");
	let r = rows(&mut ui);
	let version = ui.version;
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			("/b/", expect(&r, "/b/"), move_to("/c/")),
			("/c/", expect(&r, "/c/"), move_to("/a/")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(ui.version, version + 1);
	assert_eq!(
		answer.get("version").and_then(Value::as_f64),
		Some((version + 1) as f64)
	);
}

#[test]
fn a_move_to_the_place_a_page_is_in_is_refused_as_one_edit_refuses_it() {
	let (site, mut ui) = three("same_place");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(&mut ui, &[("/a/", expect(&r, "/a/"), move_to("/a/"))]);
	assert_eq!(errors(&answer), vec![(0, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
	// a path written another way than the page's own is the same place
	let site = Site::new("same_path");
	site.write("src/x.html", &html("X", "x"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[("/x.html", expect(&r, "/x.html"), move_path("./x.html"))],
	);
	assert_eq!(errors(&answer), vec![(0, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn what_is_set_after_a_page_is_made_where_another_goes_names_the_page_that_is_made() {
	let (site, mut ui) = three("recreate");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			(
				"/a/",
				expect(&r, "/a/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
			(
				"/a/",
				"{}".to_string(),
				r#"{"op":"create","path":"a/index.html"}"#.to_string(),
			),
			("/a/", "{}".to_string(), set("title", "Again")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/a/index.html").contains("title: Again"));
	assert!(!site.read("src/a/index.html").contains("<p>a</p>"));
}

// ---- names of places

#[test]
fn a_place_gets_a_temporary_name_in_the_same_directory() {
	use super::batch::temporary_name;
	assert_eq!(temporary_name("/", 1), "/kamado-tmp-1/");
	assert_eq!(temporary_name("/a/", 2), "/a-kamado-tmp-2/");
	assert_eq!(temporary_name("/a/b/", 1), "/a/b-kamado-tmp-1/");
	assert_eq!(temporary_name("/x.html", 1), "/x-kamado-tmp-1.html");
	assert_eq!(temporary_name("/d/x.tar.gz", 3), "/d/x.tar-kamado-tmp-3.gz");
	assert_eq!(temporary_name("a/b.html", 1), "a/b-kamado-tmp-1.html");
	assert_eq!(temporary_name("/.hidden", 1), "/.hidden-kamado-tmp-1");
	assert_eq!(temporary_name("plain", 1), "plain-kamado-tmp-1");
}

#[test]
fn a_temporary_name_is_not_one_that_is_taken_or_on_the_disk() {
	use super::batch::free_name;
	let name = free_name("/a/", |name| {
		name == "/a-kamado-tmp-1/" || name == "/a-kamado-tmp-2/"
	});
	assert_eq!(name, "/a-kamado-tmp-3/");
}

#[test]
fn a_path_is_said_the_same_way_to_put_two_moves_in_an_order() {
	use super::batch::plain_path;
	assert_eq!(plain_path("a.html"), "a.html");
	assert_eq!(plain_path("./a.html"), "a.html");
	assert_eq!(plain_path("/a.html"), "a.html");
	assert_eq!(plain_path("././/a/b.html"), "a/b.html");
	assert_eq!(plain_path("a/./b.html"), "a/./b.html");
}

#[test]
fn the_root_can_exchange_its_place_with_another_page() {
	let site = Site::new("root_swap");
	site.write("src/index.html", &html("Root", "r"));
	site.write("src/x/index.html", &html("X", "x"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/", expect(&r, "/"), move_to("/x/")),
			("/x/", expect(&r, "/x/"), move_to("/")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/index.html").contains("title: X"));
	assert!(site.read("src/x/index.html").contains("title: Root"));
}

// ---- what is told before anything is written

fn told(answer: &Value) -> Vec<(usize, String, String)> {
	let Some(Value::Array(list)) = answer.get("errors") else {
		panic!("no errors in {answer:?}")
	};
	list.iter()
		.map(|e| {
			(
				e.get("index").and_then(Value::as_f64).unwrap() as usize,
				e.get("code").and_then(Value::as_str).unwrap().to_string(),
				e.get("message")
					.and_then(Value::as_str)
					.unwrap()
					.to_string(),
			)
		})
		.collect()
}

#[test]
fn every_way_two_edits_exclude_each_other_is_told_once_for_each_edit() {
	let site = Site::new("overlaps");
	for dir in ["a", "b", "c", "d", "e"] {
		site.write(&format!("src/{dir}/index.html"), &html(dir, "x"));
	}
	site.write("src/m.html", &html("M", "m"));
	site.write("src/n.html", &html("N", "n"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let before = site.snapshot();
	let o = overrides_only(&r);
	let answer = batch(
		&mut ui,
		&[
			// 0, 1: the same page moved twice
			("/a/", expect(&r, "/a/"), move_to("/a1/")),
			("/a/", expect(&r, "/a/"), move_to("/a2/")),
			// 2, 3: a page deleted and made virtual
			(
				"/b/",
				expect(&r, "/b/"),
				r#"{"op":"deletePage"}"#.to_string(),
			),
			(
				"/b/",
				expect(&r, "/b/"),
				r#"{"op":"virtualize"}"#.to_string(),
			),
			// 4, 5: a page made virtual and moved by its file
			(
				"/m.html",
				expect(&r, "/m.html"),
				r#"{"op":"virtualize"}"#.to_string(),
			),
			("/m.html", expect(&r, "/m.html"), move_path("m2.html")),
			// 6, 7: two creates that take one file
			(
				"/p/",
				o.clone(),
				r#"{"op":"create","path":"same.html"}"#.to_string(),
			),
			(
				"/q/",
				o.clone(),
				r#"{"op":"create","path":"./same.html"}"#.to_string(),
			),
			// 8, 9: two moves of files to one path
			("/n.html", expect(&r, "/n.html"), move_path("t.html")),
			("/c/", expect(&r, "/c/"), move_path("t.html")),
			// 10: a move to where the page is
			("/d/", expect(&r, "/d/"), move_to("/d/")),
			// 11: a page that is not there
			("/zz/", "{}".to_string(), move_to("/yy/")),
		],
	);
	assert_eq!(code(&answer), "collision");
	let got = told(&answer);
	let indexes: Vec<usize> = got.iter().map(|(i, _, _)| *i).collect();
	assert_eq!(
		indexes,
		vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
		"{got:?}"
	);
	let of = |i: usize| got[i].clone();
	assert!(of(0).2.contains("exclude each other") && of(1).2.contains("exclude each other"));
	assert!(of(2).2.contains("exclude each other") && of(3).2.contains("exclude each other"));
	assert!(of(4).2.contains("exclude each other") && of(5).2.contains("exclude each other"));
	assert!(of(6).2.contains("same.html") && of(7).2.contains("same.html"));
	assert!(of(8).2.contains("t.html") && of(9).2.contains("t.html"));
	assert_eq!(
		(of(10).1.as_str(), of(11).1.as_str()),
		("invalid", "notFound")
	);
	assert!(of(10).2.contains("same as it was"));
	assert_eq!(site.snapshot(), before, "nothing was written");
}

#[test]
fn a_move_to_the_path_a_page_has_is_told_before_anything_is_written() {
	let site = Site::new("same_path_first");
	site.write("src/x.html", &html("X", "x"));
	site.write("src/y.html", &html("Y", "y"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/y.html", expect(&r, "/y.html"), set("title", "Y2")),
			("/x.html", expect(&r, "/x.html"), move_path("x.html")),
		],
	);
	assert_eq!(told(&answer).len(), 1, "{answer:?}");
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_move_to_the_url_a_page_has_on_a_page_that_is_not_there_says_it_is_not_there() {
	let (_site, mut ui) = three("missing_same");
	let answer = batch(&mut ui, &[("/zz/", "{}".to_string(), move_to("/zz/"))]);
	assert_eq!(errors(&answer), vec![(0, "notFound".to_string())]);
}

#[test]
fn a_page_that_is_made_cannot_be_moved_or_deleted_by_the_batch_that_makes_it() {
	let site = Site::new("made_then_moved");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			(
				"/n/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
			("/n/", overrides_only(&r), move_to("/m/")),
		],
	);
	let got = told(&answer);
	assert_eq!(got.len(), 1);
	assert_eq!((got[0].0, got[0].1.as_str()), (1, "notFound"));
	assert!(got[0].2.contains("is made by this batch"), "{got:?}");
	assert_eq!(site.snapshot(), before);
}

#[test]
fn an_empty_batch_does_not_tell_what_an_earlier_edit_left() {
	let (_site, mut ui) = three("stale_warning");
	ui.left_behind = vec!["x.kamado-removed (busy)".to_string()];
	let answer = json(&ui.edit_batch(r#"{"edits":[]}"#).unwrap());
	assert!(ok(&answer) && answer.get("warning").is_none(), "{answer:?}");
}

// ---- what is checked against the files before the batch

#[test]
fn a_changed_sidecar_or_overrides_file_is_a_conflict() {
	// a sidecar
	let (site, mut ui) = site_of_keys("conflict_sidecar");
	let r = rows(&mut ui);
	let ex = expect(&r, "/b/");
	site.write("src/b/index.json", "{ \"layout\": \"z\" }\n");
	let answer = batch(
		&mut ui,
		&[("/b/", ex, r#"{"op":"delete","key":"nav"}"#.to_string())],
	);
	assert_eq!(errors(&answer), vec![(0, "conflict".to_string())]);

	// pages.overrides, named by an edit of a virtual page
	let (site, mut ui) = site_of_keys("conflict_overrides");
	let r = rows(&mut ui);
	let ex = overrides_only(&r);
	let text = site.read("pages.overrides.json").replace("V1", "V1!");
	site.write("pages.overrides.json", &text);
	let before = site.snapshot();
	let answer = batch(&mut ui, &[("/v1/", ex, set("title", "T"))]);
	assert_eq!(errors(&answer), vec![(0, "conflict".to_string())]);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_hash_of_a_file_that_changed_is_a_conflict_whatever_the_edit() {
	for (name, change) in [
		("move", move_to("/moved/")),
		("delete", r#"{"op":"deletePage"}"#.to_string()),
		("virtualize", r#"{"op":"virtualize"}"#.to_string()),
		("path", move_path("moved.html")),
	] {
		let site = Site::new(&format!("stale_{name}"));
		site.write("src/a/index.html", &html("A", "a"));
		site.write("src/b.html", &html("B", "b"));
		site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
		let mut ui = site.open(OVERRIDES);
		let r = rows(&mut ui);
		let url = if name == "path" { "/b.html" } else { "/a/" };
		let ex = expect(&r, url);
		let file = if name == "path" {
			"src/b.html"
		} else {
			"src/a/index.html"
		};
		site.write(file, &html("changed", "c"));
		let before = site.snapshot();
		let answer = batch(&mut ui, &[(url, ex, change)]);
		assert_eq!(errors(&answer), vec![(0, "conflict".to_string())], "{name}");
		assert_eq!(site.snapshot(), before, "{name}");
	}
}

#[test]
fn an_expect_that_is_not_an_object_has_nothing_to_check_and_is_refused_when_the_edit_needs_it() {
	let (site, mut ui) = three("expect_null");
	let before = site.snapshot();
	let request = r#"{"edits":[{"url":"/a/","expect":null,"change":{"op":"set","key":"title","value":"x"}}]}"#;
	assert!(
		ui.edit_batch(request).is_err(),
		"`expect` has to be an object"
	);
	let answer = batch(&mut ui, &[("/a/", "{}".to_string(), set("title", "x"))]);
	assert_eq!(errors(&answer), vec![(0, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
}

// ---- rollback from each stage

#[test]
fn a_failure_after_pages_were_made_puts_the_pages_back() {
	let (site, mut ui) = three("after_create");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let version = ui.version;
	let answer = batch(
		&mut ui,
		&[
			(
				"/n/",
				"{}".to_string(),
				r#"{"op":"create","path":"n/index.html"}"#.to_string(),
			),
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			// refused when the keys are made, after the page above was written
			(
				"/b/",
				expect(&r, "/b/"),
				r#"{"op":"delete","key":"nope"}"#.to_string(),
			),
		],
	);
	assert_eq!(errors(&answer), vec![(2, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before, "the made page is gone too");
	assert_eq!(ui.version, version);
	assert!(!has_page(&rows(&mut ui), "/n/"));
}

#[test]
fn a_failure_after_a_ring_was_made_puts_the_ring_back() {
	let site = Site::new("after_ring");
	for (dir, upper) in [("a", "A"), ("b", "B"), ("c", "C")] {
		site.write(&format!("src/{dir}/index.html"), &html(upper, "x"));
	}
	site.write("src/x.html", &html("X", "x"));
	site.write("src/blocker", "a file where a directory should be");
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			("/b/", expect(&r, "/b/"), move_to("/c/")),
			("/c/", expect(&r, "/c/"), move_to("/a/")),
			// made after the ring, and refused: a directory cannot be made over a file
			(
				"/x.html",
				expect(&r, "/x.html"),
				move_path("blocker/x.html"),
			),
		],
	);
	assert!(!ok(&answer), "{answer:?}");
	assert_eq!(errors(&answer)[0].0, 3);
	assert_eq!(
		site.snapshot(),
		before,
		"the three files are where they were"
	);
	let files: Vec<String> = site.snapshot().into_keys().collect();
	assert!(files.iter().all(|f| !f.contains("kamado-tmp")), "{files:?}");
}

#[test]
fn pages_overrides_that_cannot_be_written_puts_back_what_was_moved_and_blames_no_edit() {
	let site = Site::new("flush_fails");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let path = format!("{}/pages.overrides.json", site.root);
	let mut permissions = fs::metadata(&path).unwrap().permissions();
	permissions.set_readonly(true);
	fs::set_permissions(&path, permissions).unwrap();
	let respected = fs::OpenOptions::new().append(true).open(&path).is_err();
	let before = site.snapshot();
	let version = ui.version;
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/z/")),
			(
				"/v/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
		],
	);
	let mut permissions = fs::metadata(&path).unwrap().permissions();
	#[allow(clippy::permissions_set_readonly_false)]
	permissions.set_readonly(false);
	fs::set_permissions(&path, permissions).unwrap();
	if !respected {
		return; // a file system that lets a read-only file be written (a super user)
	}
	assert!(!ok(&answer), "{answer:?}");
	let list = answer.get("errors").and_then(|e| match e {
		Value::Array(list) => Some(list),
		_ => None,
	});
	let first = list.and_then(|l| l.first()).unwrap();
	assert_eq!(
		first.get("index"),
		Some(&Value::Null),
		"no edit is behind it: {answer:?}"
	);
	assert_eq!(code(&answer), "io");
	assert_eq!(site.snapshot(), before, "the moved page is back");
	assert_eq!(ui.version, version);
}

// ---- the order of moves of two kinds

#[test]
fn a_url_that_only_the_move_of_a_file_frees_is_taken_by_a_move_that_comes_too_early() {
	let site = Site::new("kinds_order");
	site.write("src/x.html", &html("X", "x"));
	site.write("src/y/index.html", &html("Y", "y"));
	let mut ui = site.open("");
	let r = rows(&mut ui);
	let before = site.snapshot();
	// the moves of URLs are made before the moves of files, so /x.html is not free yet
	let answer = batch(
		&mut ui,
		&[
			("/y/", expect(&r, "/y/"), move_to("/x.html")),
			("/x.html", expect(&r, "/x.html"), move_path("z.html")),
		],
	);
	assert_eq!(code(&answer), "collision", "{answer:?}");
	assert_eq!(site.snapshot(), before);
}

// ---- keys of a page the batch makes

#[test]
fn a_key_of_a_virtual_page_made_in_the_batch_needs_the_hash_of_pages_overrides() {
	let site = Site::new("virtual_then_key");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let before = site.snapshot();
	let create = r#"{"op":"create","path":null}"#.to_string();
	let answer = batch(
		&mut ui,
		&[
			("/nv/", overrides_only(&r), create.clone()),
			("/nv/", "{}".to_string(), set("title", "NV")),
		],
	);
	assert_eq!(errors(&answer), vec![(1, "invalid".to_string())]);
	assert_eq!(site.snapshot(), before);
	let answer = batch(
		&mut ui,
		&[
			("/nv/", overrides_only(&r), create),
			("/nv/", overrides_only(&r), set("title", "NV")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("pages.overrides.json").contains("\"NV\""));
}

// ---- the list of page files

#[test]
fn the_page_files_follow_the_patterns_of_the_site_and_the_directory_is_compared_with_them() {
	let site = Site::new("found_config");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("src/drafts/d.html", &html("D", "d"));
	site.write("src/a/notes.txt", "x");
	let ui = site.open(r#", "pages": { "files": ["**/*.html"], "ignore": ["drafts/**"] }"#);
	let mut found = super::batch::FoundFiles::walk(&ui.loaded.config).unwrap();
	assert_eq!(found.list(), vec!["a/index.html"]);
	let root = &site.root;
	let events = vec![
		Event::Write(format!("{root}/src/drafts/e.html"), None),
		Event::Write(format!("{root}/src/a/other.txt"), None),
		Event::Rename(
			format!("{root}/src/a/index.html"),
			format!("{root}/src/drafts/index.html"),
		),
		Event::Write(format!("{root}/src/b.html"), None),
	];
	let changed = found.follow(&events);
	assert_eq!(found.list(), vec!["b.html"]);
	assert_eq!(
		changed.into_iter().collect::<Vec<_>>(),
		vec![
			format!("{root}/src/a/index.html"),
			format!("{root}/src/b.html")
		]
	);
	// the directory has not got what the list says
	assert!(!found.agrees_with(&ui.loaded.config).unwrap());
	let fresh = super::batch::FoundFiles::walk(&ui.loaded.config).unwrap();
	assert!(fresh.agrees_with(&ui.loaded.config).unwrap());
	site.write("src/late.html", &html("L", "l"));
	assert!(!fresh.agrees_with(&ui.loaded.config).unwrap());
}

// ---- a refused batch leaves the handle ready for the next one

#[test]
fn a_batch_refused_for_a_changed_file_reads_the_site_again_so_the_next_one_can_be_made() {
	let (site, mut ui) = three("conflict_reread");
	let r = rows(&mut ui);
	site.write("src/a/index.html", &html("A changed outside", "a"));
	let answer = batch(&mut ui, &[("/a/", expect(&r, "/a/"), set("title", "A2"))]);
	assert_eq!(code(&answer), "conflict", "{answer:?}");
	// the hashes the screen reads now are those of the files, so the same edit is made
	let fresh = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[("/a/", expect(&fresh, "/a/"), set("title", "A2"))],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.read("src/a/index.html").contains("title: A2"));
}

#[test]
fn pages_overrides_changed_outside_is_read_before_the_edits_are_checked() {
	let (site, mut ui) = site_of_entries("stale_overrides_first");
	// a virtual page that the handle does not know is added by hand
	let text = site.read("pages.overrides.json").replace(
		"\t]\n}\n",
		"\t\t, { \"url\": \"/outside/\", \"virtual\": true }\n\t]\n}\n",
	);
	site.write("pages.overrides.json", &text);
	let r = json(&ui.pages(r#"{"offset":0,"limit":1000}"#).unwrap());
	assert!(!has_page(&r, "/outside/"), "the handle has not read it");
	let current = overrides_only(&json(&format!(
		r#"{{"overridesHash":{}}}"#,
		s(&kd_hash_of(&text))
	)));
	let answer = batch(
		&mut ui,
		&[("/outside/", current, r#"{"op":"deletePage"}"#.to_string())],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(!site.read("pages.overrides.json").contains("/outside/"));
}

fn kd_hash_of(text: &str) -> String {
	hash_hex(text.as_bytes())
}

// ---- the order of what makes pages

#[test]
fn a_page_is_given_a_file_after_it_is_made_whatever_the_order_of_the_request() {
	let site = Site::new("create_after_materialize");
	site.write("src/a/index.html", &html("A", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let o = overrides_only(&r);
	let answer = batch(
		&mut ui,
		&[
			(
				"/n/",
				o.clone(),
				r#"{"op":"materialize","path":"n/index.html"}"#.to_string(),
			),
			("/n/", o, r#"{"op":"create","path":null}"#.to_string()),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert!(site.exists("src/n/index.html"));
	assert!(!site.read("pages.overrides.json").contains("\"/n/\""));
}

#[test]
fn a_page_made_where_a_page_is_that_the_batch_leaves_is_refused_before_anything_is_written() {
	let (site, mut ui) = three("create_over");
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), set("title", "A2")),
			(
				"/b/",
				"{}".to_string(),
				r#"{"op":"create","path":"elsewhere/index.html"}"#.to_string(),
			),
		],
	);
	let got = told(&answer);
	assert_eq!(got.len(), 1, "{answer:?}");
	assert_eq!((got[0].0, got[0].1.as_str()), (1, "collision"));
	assert_eq!(site.snapshot(), before);
	// but not when the batch moves the page that is there away
	let answer = batch(
		&mut ui,
		&[
			("/b/", expect(&r, "/b/"), move_to("/b-old/")),
			(
				"/b/",
				"{}".to_string(),
				r#"{"op":"create","path":"b/index.html"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
}

#[test]
fn a_key_set_at_a_url_the_batch_made_names_the_page_that_was_made_not_the_one_moved_off_it() {
	let site = Site::new("key_on_made_url");
	site.write("src/a/index.html", &html("OLD", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
			("/a/", overrides_only(&r), set("title", "NEW")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	// the page that was moved keeps its title; the page that was made has the new one
	assert!(site.read("src/b/index.html").contains("title: OLD"));
	let now = rows(&mut ui);
	let made = page(&now, "/a/");
	assert_eq!(made.get("virtual"), Some(&Value::Bool(true)));
	assert_eq!(
		made.get("meta")
			.and_then(|m| m.get("title"))
			.and_then(|t| t.get("value")),
		Some(&Value::String("NEW".to_string()))
	);
	let moved = page(&now, "/b/");
	assert_eq!(
		moved
			.get("meta")
			.and_then(|m| m.get("title"))
			.and_then(|t| t.get("value")),
		Some(&Value::String("OLD".to_string()))
	);
}

#[test]
fn a_page_given_a_file_at_a_url_the_batch_made_is_the_page_that_was_made() {
	let site = Site::new("materialize_on_made_url");
	site.write("src/a/index.html", &html("OLD", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/b/")),
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"materialize","path":null}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	// the made page has its file at /a/; the moved page is still at /b/
	assert!(site.exists("src/a/index.html"));
	assert!(site.read("src/b/index.html").contains("title: OLD"));
	let now = rows(&mut ui);
	assert_eq!(page(&now, "/a/").get("virtual"), Some(&Value::Bool(false)));
}

#[test]
fn a_page_made_at_the_url_a_keyed_page_keeps_when_its_file_moves_is_refused_before_anything_is_written()
 {
	let site = Site::new("create_over_keyed_move");
	site.write("src/k.html", "---\ntitle: K\npath: /a/\n---\n<p>k</p>");
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site
		.open(r#", "pages": { "overrides": "pages.overrides.json", "outputPathField": "path" }"#);
	let r = rows(&mut ui);
	let before = site.snapshot();
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_path("k2.html")),
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
			// an edit that is wrong by itself: it is told with the others only when the checks that
			// come before anything is written find the create wrong too
			(
				"/nope/",
				"{}".to_string(),
				r#"{"op":"deletePage"}"#.to_string(),
			),
		],
	);
	assert!(!ok(&answer), "{answer:?}");
	let mut told = errors(&answer);
	told.sort();
	assert_eq!(
		told,
		vec![(1, "collision".to_string()), (2, "notFound".to_string())],
		"{answer:?}"
	);
	assert_eq!(site.snapshot(), before);
}

#[test]
fn a_page_made_at_the_url_a_file_that_moves_gives_up_is_still_allowed() {
	let site = Site::new("create_over_plain_move");
	site.write("src/a/index.html", &html("OLD", "a"));
	site.write("pages.overrides.json", r#"{ "version": 1, "pages": [] }"#);
	let mut ui = site.open(OVERRIDES);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_path("z/index.html")),
			(
				"/a/",
				overrides_only(&r),
				r#"{"op":"create","path":null}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	let now = rows(&mut ui);
	assert!(has_page(&now, "/z/"));
	assert_eq!(page(&now, "/a/").get("virtual"), Some(&Value::Bool(true)));
}

#[test]
fn the_check_of_edits_that_exclude_each_other_is_not_the_product_of_the_pages_that_go_and_the_edits()
 {
	// A batch that deletes a tenth of a hundred thousand pages has ten thousand pages that go and
	// a hundred thousand edits. Looking at every edit for each page that goes is a thousand
	// million comparisons; found once by URL, it is a hundred thousand.
	let n = 60_000;
	let items: Vec<Item> = (0..n)
		.map(|i| Item {
			index: i,
			edit: Edit {
				url: format!("/p{i}/"),
				expect: Value::Object(Vec::new()),
				change: Change::DeletePage,
			},
		})
		.collect();
	let mut errors = Vec::new();
	let started = std::time::Instant::now();
	overlaps(&items, &mut errors);
	let took = started.elapsed();
	assert!(errors.is_empty());
	assert!(
		took < std::time::Duration::from_secs(2),
		"{n} deletes took {took:?} to check"
	);
}

fn urls_in_order(rows: &Value) -> Vec<String> {
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.map(|p| p.get("url").and_then(Value::as_str).unwrap().to_owned())
		.collect()
}

#[test]
fn a_batch_that_sets_order_leaves_the_pages_in_the_order_it_makes() {
	let (_site, mut ui) = three("batch_order");
	assert_eq!(urls_in_order(&rows(&mut ui)), ["/a/", "/b/", "/c/"]);
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/c/", expect(&r, "/c/"), set("order", "-1")),
			("/a/", expect(&r, "/a/"), set("order", "3")),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	// the answer, and what the next read tells, are in the new order
	assert_eq!(urls_in_order(&rows(&mut ui)), ["/c/", "/b/", "/a/"]);
}

#[test]
fn a_batch_that_moves_and_makes_pages_leaves_the_pages_in_the_tree_order() {
	let (_site, mut ui) = three("batch_tree_order");
	let r = rows(&mut ui);
	let answer = batch(
		&mut ui,
		&[
			("/a/", expect(&r, "/a/"), move_to("/z/")),
			(
				"/aa/",
				"{}".to_string(),
				r#"{"op":"create","path":"aa/index.html"}"#.to_string(),
			),
		],
	);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(urls_in_order(&rows(&mut ui)), ["/aa/", "/b/", "/c/", "/z/"]);
}
