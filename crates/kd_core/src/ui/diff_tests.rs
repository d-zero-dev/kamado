//! The difference from HEAD and putting a value back (RFC §14.2, "HEAD との差分"). What the Node
//! side finds out from `git` is made by hand here: the text HEAD holds of each file.

use super::*;

use kd_hash::{GitObjectFormat, git_blob_id};

struct Site {
	root: String,
}

impl Site {
	fn new(name: &str) -> Site {
		let root = format!(
			"{}/kd_ui_diff_{name}_{}",
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

const OVERRIDES: &str = r#", "pages": { "overrides": "pages.overrides.json" }"#;

fn json(text: &str) -> Value {
	kd_jsonc::parse(text).unwrap()
}

fn s(text: &str) -> Value {
	Value::String(text.to_string())
}

fn urls_json(urls: &[&str]) -> String {
	urls.iter()
		.map(|u| s(u).to_json())
		.collect::<Vec<_>>()
		.join(",")
}

/// What HEAD holds of a file.
enum H<'a> {
	Text(&'a str),
	Absent,
	Ignored,
	Skip,
}

fn blob(text: &str) -> String {
	git_blob_id(text.as_bytes(), GitObjectFormat::Sha1)
}

/// The `head` a caller makes from what `git` says of the files `diff_files` lists: a file that is
/// not named holds what it holds now (`same`; a file that is not there now is not in HEAD
/// either). With `with_text` the text of a file that differs goes with its id.
fn head_of(ui: &mut Ui, urls: &[&str], states: &[(&str, H)], with_text: bool) -> String {
	let files = json(
		&ui.diff_files(&format!(
			r#"{{"urls":[{}],"format":"sha1"}}"#,
			urls_json(urls)
		))
		.unwrap(),
	);
	let mut listed: Vec<Value> = Vec::new();
	if let Some(Value::Array(files)) = files.get("files") {
		listed.extend(files.iter().cloned());
	}
	if let Some(o @ Value::Object(_)) = files.get("overrides") {
		listed.push(o.clone());
	}
	let mut members: Vec<(String, Value)> = Vec::new();
	for file in listed {
		let path = file.get("path").and_then(Value::as_str).unwrap().to_owned();
		let now = file.get("blob").cloned().unwrap();
		let state = match states.iter().find(|(p, _)| *p == path) {
			None if now.is_null() => Value::Null,
			None => s("same"),
			Some((_, H::Absent)) => Value::Null,
			Some((_, H::Ignored)) => s("ignored"),
			Some((_, H::Skip)) => s("skip"),
			Some((_, H::Text(text))) if now == s(&blob(text)) => s("same"),
			Some((_, H::Text(text))) => {
				let mut o = vec![("oid".to_owned(), s(&blob(text)))];
				if with_text {
					o.push(("text".to_owned(), s(text)));
				}
				Value::Object(o)
			}
		};
		members.push((path, state));
	}
	Value::Object(members).to_json()
}

fn diff(ui: &mut Ui, urls: &[&str], head: &str) -> Value {
	json(
		&ui.diff(&format!(
			r#"{{"urls":[{}],"format":"sha1","head":{head}}}"#,
			urls_json(urls)
		))
		.unwrap(),
	)
}

/// The differences of one page, or `None` when it has none.
fn of(answer: &Value, url: &str) -> Option<Value> {
	answer.get("pages").and_then(|p| p.get(url)).cloned()
}

fn meta_diff(page: &Value, key: &str) -> Value {
	page.get("meta")
		.and_then(|m| m.get(key))
		.unwrap_or_else(|| panic!("no difference for {key}: {page:?}"))
		.clone()
}

fn kind(diff: &Value) -> &str {
	diff.get("kind").and_then(Value::as_str).unwrap()
}

fn revertible(diff: &Value) -> bool {
	diff.get("revertible") == Some(&Value::Bool(true))
}

fn expect_of(ui: &mut Ui, url: &str) -> String {
	let rows = json(&ui.pages(r#"{"offset":0,"limit":1000}"#).unwrap());
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	let row = pages
		.iter()
		.find(|p| p.get("url").and_then(Value::as_str) == Some(url))
		.unwrap_or_else(|| panic!("no page {url}"));
	let hashes = row.get("hashes").unwrap();
	let part = |v: Option<&Value>| v.map_or("null".to_string(), Value::to_json);
	format!(
		r#"{{"input":{},"sidecar":{},"overrides":{}}}"#,
		part(hashes.get("input")),
		part(hashes.get("sidecar")),
		part(rows.get("overridesHash")),
	)
}

fn revert(ui: &mut Ui, url: &str, key: Option<&str>, head: &str) -> Value {
	let expect = expect_of(ui, url);
	let key = key.map_or("null".to_string(), |k| s(k).to_json());
	json(
		&ui.edit(&format!(
			r#"{{"url":{},"expect":{expect},"change":{{"op":"revert","key":{key},"head":{head}}}}}"#,
			s(url).to_json()
		))
		.unwrap(),
	)
}

fn ok(answer: &Value) -> bool {
	answer.get("ok") == Some(&Value::Bool(true))
}

fn code(answer: &Value) -> &str {
	answer
		.get("code")
		.and_then(Value::as_str)
		.unwrap_or_else(|| panic!("no code in {answer:?}"))
}

fn value_of(ui: &mut Ui, url: &str, key: &str) -> Option<Value> {
	let rows = json(&ui.pages(r#"{"offset":0,"limit":1000}"#).unwrap());
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	pages
		.iter()
		.find(|p| p.get("url").and_then(Value::as_str) == Some(url))?
		.get("meta")?
		.get(key)?
		.get("value")
		.cloned()
}

const OLD: &str = "---\ntitle: Old\ndescription: Gone\n---\n<p>a</p>";

#[test]
fn the_blob_ids_of_the_files_are_the_ids_git_gives_them() {
	let site = Site::new("blobs");
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	site.write("src/a/index.json", r#"{ "x": 1 }"#);
	site.write("src/b.html", "b");
	site.write("pages.overrides.json", r#"{"version":1,"pages":[]}"#);
	let mut ui = site.open(OVERRIDES);
	let answer = json(
		&ui.diff_files(r#"{"urls":["/a/","/b.html"],"format":"sha1"}"#)
			.unwrap(),
	);
	let Some(Value::Array(files)) = answer.get("files") else {
		panic!("files")
	};
	let blob_of = |path: &str| {
		files
			.iter()
			.find(|f| f.get("path").and_then(Value::as_str) == Some(path))
			.unwrap_or_else(|| panic!("no {path}: {files:?}"))
			.get("blob")
			.cloned()
			.unwrap()
	};
	assert_eq!(
		blob_of("src/a/index.html"),
		s(&blob("---\ntitle: A\n---\n<p>a</p>"))
	);
	assert_eq!(blob_of("src/a/index.json"), s(&blob(r#"{ "x": 1 }"#)));
	// a sidecar that is not there has no id
	assert_eq!(blob_of("src/b.json"), Value::Null);
	let overrides = answer.get("overrides").unwrap();
	assert_eq!(overrides.get("path"), Some(&s("pages.overrides.json")));
	assert_eq!(
		overrides.get("blob"),
		Some(&s(&blob(r#"{"version":1,"pages":[]}"#)))
	);
	// the same file in the SHA-256 format of git
	let answer = json(
		&ui.diff_files(r#"{"urls":["/b.html"],"format":"sha256"}"#)
			.unwrap(),
	);
	let Some(Value::Array(files)) = answer.get("files") else {
		panic!("files")
	};
	assert_eq!(
		files[0].get("blob"),
		Some(&s(&git_blob_id(b"b", GitObjectFormat::Sha256)))
	);
	// a URL that no page has is skipped: the window that asked can be older than the plan
	let answer = json(
		&ui.diff_files(r#"{"urls":["/nope/"],"format":"sha1"}"#)
			.unwrap(),
	);
	assert_eq!(answer.get("files"), Some(&Value::Array(Vec::new())));
	let answer = diff(&mut ui, &["/nope/"], "{}");
	assert_eq!(answer.get("pages"), Some(&Value::Object(Vec::new())));
	assert!(
		ui.diff_files(r#"{"urls":["/b.html"],"format":"md5"}"#)
			.is_err()
	);
}

#[test]
fn a_site_without_pages_overrides_has_none_to_compare() {
	let site = Site::new("no_overrides");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let answer = json(
		&ui.diff_files(r#"{"urls":["/a.html"],"format":"sha1"}"#)
			.unwrap(),
	);
	assert_eq!(answer.get("overrides"), Some(&Value::Null));
}

#[test]
fn a_value_that_differs_from_head_is_modified_added_or_deleted() {
	let site = Site::new("kinds");
	site.write(
		"src/a/index.html",
		"---\ntitle: New\nextra: 1\n---\n<p>a</p>",
	);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.html", H::Text(OLD))],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").expect("the page differs");
	let title = meta_diff(&page, "title");
	assert_eq!(kind(&title), "modified");
	assert_eq!(title.get("head"), Some(&s("Old")));
	assert!(revertible(&title));
	let extra = meta_diff(&page, "extra");
	assert_eq!(kind(&extra), "added");
	assert_eq!(extra.get("head"), None);
	assert!(revertible(&extra));
	let description = meta_diff(&page, "description");
	assert_eq!(kind(&description), "deleted");
	assert_eq!(description.get("head"), Some(&s("Gone")));
	assert!(revertible(&description));
	// no page has `description` now, so the screen has no column for it
	assert_eq!(
		answer.get("columns"),
		Some(&Value::Array(vec![s("description")]))
	);
}

#[test]
fn files_that_hold_what_head_holds_make_no_difference() {
	let site = Site::new("same");
	site.write("src/a/index.html", OLD);
	site.write("src/a/index.json", r#"{"x":1}"#);
	let mut ui = site.open("");
	let head = head_of(&mut ui, &["/a/"], &[], true);
	let answer = diff(&mut ui, &["/a/"], &head);
	assert_eq!(answer.get("pages"), Some(&Value::Object(Vec::new())));
	assert_eq!(answer.get("columns"), Some(&Value::Array(Vec::new())));
}

#[test]
fn a_value_that_moved_to_another_file_is_not_a_difference() {
	let site = Site::new("moved_between_files");
	site.write("src/a/index.html", "<p>a</p>");
	site.write("src/a/index.json", r#"{"title":"T"}"#);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			("src/a/index.html", H::Text("---\ntitle: T\n---\n<p>a</p>")),
			("src/a/index.json", H::Absent),
		],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	assert_eq!(of(&answer, "/a/"), None);
}

#[test]
fn a_key_that_was_deleted_down_to_the_value_of_a_lower_file_is_modified() {
	let site = Site::new("deleted_to_lower");
	// the sidecar wins over the page file: it was `Side` and now the page file's value shows
	site.write("src/a/index.html", "---\ntitle: File\n---\n<p>a</p>");
	site.write("src/a/index.json", "{}");
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.json", H::Text(r#"{"title":"Side"}"#))],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").unwrap();
	let title = meta_diff(&page, "title");
	assert_eq!(kind(&title), "modified");
	assert_eq!(title.get("head"), Some(&s("Side")));
}

#[test]
fn a_page_that_is_not_in_head_is_added_and_cannot_be_put_back() {
	let site = Site::new("added_page");
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	let mut ui = site.open("");
	let head = head_of(&mut ui, &["/a/"], &[("src/a/index.html", H::Absent)], true);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").unwrap();
	let url = page.get("url").unwrap();
	assert_eq!(kind(url), "added");
	assert!(!revertible(url));
	let input = page.get("inputPath").unwrap();
	assert_eq!(kind(input), "added");
	assert!(!revertible(input));
	let title = meta_diff(&page, "title");
	assert_eq!(kind(&title), "added");
	assert!(!revertible(&title));
	let answer = revert(&mut ui, "/a/", Some("title"), &head);
	assert_eq!(code(&answer), "notEditable");
	assert_eq!(
		site.read("src/a/index.html"),
		"---\ntitle: A\n---\n<p>a</p>"
	);
}

#[test]
fn a_page_file_that_git_does_not_track_is_not_compared() {
	let site = Site::new("ignored_page");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	for state in [H::Ignored, H::Skip] {
		let head = head_of(&mut ui, &["/a/"], &[("src/a/index.html", state)], true);
		let answer = diff(&mut ui, &["/a/"], &head);
		assert_eq!(of(&answer, "/a/"), None);
	}
}

fn overrides_site(name: &str) -> (Site, Ui) {
	let site = Site::new(name);
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/a/","meta":{"nav":false}},{"url":"/ext/","virtual":true,"meta":{"title":"Ext"}}]}"#,
	);
	let ui = site.open(OVERRIDES);
	(site, ui)
}

#[test]
fn pages_overrides_that_git_ignores_makes_no_difference() {
	let (_site, mut ui) = overrides_site("overrides_ignored");
	let head = head_of(
		&mut ui,
		&["/a/", "/ext/"],
		&[("pages.overrides.json", H::Ignored)],
		true,
	);
	let answer = diff(&mut ui, &["/a/", "/ext/"], &head);
	assert_eq!(answer.get("pages"), Some(&Value::Object(Vec::new())));
}

#[test]
fn pages_overrides_that_head_does_not_have_makes_what_it_holds_added() {
	let (_site, mut ui) = overrides_site("overrides_absent");
	let head = head_of(
		&mut ui,
		&["/a/", "/ext/"],
		&[("pages.overrides.json", H::Absent)],
		true,
	);
	let answer = diff(&mut ui, &["/a/", "/ext/"], &head);
	let a = of(&answer, "/a/").unwrap();
	let nav = meta_diff(&a, "nav");
	assert_eq!(kind(&nav), "added");
	// the entry is there to take the key out of
	assert!(revertible(&nav));
	assert_eq!(a.get("url"), None);
	let ext = of(&answer, "/ext/").unwrap();
	// a virtual page is its entry: without one in HEAD the page is new
	assert_eq!(kind(ext.get("url").unwrap()), "added");
	assert_eq!(ext.get("inputPath"), None);
	assert!(!revertible(ext.get("url").unwrap()));
	assert_eq!(kind(&meta_diff(&ext, "title")), "added");
}

#[test]
fn a_virtual_page_has_the_value_of_its_entry_in_head_to_be_compared_with() {
	let (_site, mut ui) = overrides_site("virtual_modified");
	let head = head_of(
		&mut ui,
		&["/ext/"],
		&[(
			"pages.overrides.json",
			H::Text(
				r#"{"version":1,"pages":[{"url":"/ext/","virtual":true,"meta":{"title":"Old"}}]}"#,
			),
		)],
		true,
	);
	let answer = diff(&mut ui, &["/ext/"], &head);
	let ext = of(&answer, "/ext/").unwrap();
	assert_eq!(ext.get("url"), None);
	let title = meta_diff(&ext, "title");
	assert_eq!(kind(&title), "modified");
	assert_eq!(title.get("head"), Some(&s("Old")));
	assert!(revertible(&title));
}

#[test]
fn a_real_page_without_an_entry_cannot_get_one_by_a_revert() {
	let site = Site::new("no_entry");
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	site.write("pages.overrides.json", r#"{"version":1,"pages":[]}"#);
	let mut ui = site.open(OVERRIDES);
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[(
			"pages.overrides.json",
			H::Text(r#"{"version":1,"pages":[{"url":"/a/","meta":{"nav":true}}]}"#),
		)],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let nav = meta_diff(&of(&answer, "/a/").unwrap(), "nav");
	assert_eq!(kind(&nav), "deleted");
	assert!(!revertible(&nav));
	let answer = revert(&mut ui, "/a/", Some("nav"), &head);
	assert_eq!(code(&answer), "notEditable");
	assert_eq!(
		site.read("pages.overrides.json"),
		r#"{"version":1,"pages":[]}"#
	);
}

#[test]
fn the_text_of_a_file_is_asked_for_once_for_each_blob_id() {
	let site = Site::new("need");
	site.write("src/a/index.html", "---\ntitle: New\n---\n<p>a</p>");
	let mut ui = site.open("");
	let states = [("src/a/index.html", H::Text(OLD))];
	let without = head_of(&mut ui, &["/a/"], &states, false);
	let answer = diff(&mut ui, &["/a/"], &without);
	assert_eq!(
		answer.get("need"),
		Some(&Value::Array(vec![s("src/a/index.html")]))
	);
	assert_eq!(answer.get("pages"), None);
	let with = head_of(&mut ui, &["/a/"], &states, true);
	let answer = diff(&mut ui, &["/a/"], &with);
	assert_eq!(
		kind(&meta_diff(&of(&answer, "/a/").unwrap(), "title")),
		"modified"
	);
	// what was parsed is kept by the id: the text is not asked for again
	let answer = diff(&mut ui, &["/a/"], &without);
	assert_eq!(answer.get("need"), None);
	assert_eq!(
		kind(&meta_diff(&of(&answer, "/a/").unwrap(), "title")),
		"modified"
	);
}

#[test]
fn the_same_text_in_two_kinds_of_file_is_parsed_for_each() {
	let site = Site::new("kinds_of_file");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	site.write("src/a/index.json", r#"{"title":"S"}"#);
	let mut ui = site.open("");
	// one text, with one blob id, that is the page file of HEAD (which has no front matter, so no
	// metadata) and, as JSON, its sidecar (which has a title)
	let text = r#"{"title":"H"}"#;
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			("src/a/index.html", H::Text(text)),
			("src/a/index.json", H::Text(text)),
		],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let title = meta_diff(&of(&answer, "/a/").unwrap(), "title");
	assert_eq!(title.get("head"), Some(&s("H")));
}

#[test]
fn a_file_of_head_that_does_not_read_stops_the_keys_from_being_put_back() {
	let site = Site::new("unreadable");
	site.write("src/a/index.html", "---\ntitle: A\n---\n<p>a</p>");
	site.write("src/a/index.json", r#"{"x":2}"#);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			("src/a/index.html", H::Text("---\ntitle: [unclosed\n---\n")),
			("src/a/index.json", H::Text(r#"{"x":1}"#)),
		],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let x = meta_diff(&of(&answer, "/a/").unwrap(), "x");
	assert_eq!(kind(&x), "modified");
	assert!(!revertible(&x));
	let answer = revert(&mut ui, "/a/", Some("x"), &head);
	assert_eq!(code(&answer), "notEditable");
	assert_eq!(site.read("src/a/index.json"), r#"{"x":2}"#);
}

#[test]
fn a_key_that_cannot_be_edited_cannot_be_put_back() {
	let site = Site::new("not_editable");
	// a front matter with an anchor is not one a key can be written in
	site.write("src/a/index.html", "---\nbase: &b {x: 1}\ntitle: A\n---\n");
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[(
			"src/a/index.html",
			H::Text("---\nbase: &b {x: 1}\ntitle: Old\n---\n"),
		)],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let title = meta_diff(&of(&answer, "/a/").unwrap(), "title");
	assert_eq!(kind(&title), "modified");
	assert!(!revertible(&title));
}

#[test]
fn the_output_path_key_is_a_difference_of_the_url_and_is_put_back_as_the_url() {
	let site = Site::new("path_field");
	site.write(
		"src/170370.html",
		"---\npath: /en/new.html\ntitle: T\n---\n",
	);
	let mut ui = site.open(r#", "pages": { "outputPathField": "path" }"#);
	let head = head_of(
		&mut ui,
		&["/en/new.html"],
		&[(
			"src/170370.html",
			H::Text("---\npath: /en/old.html\ntitle: T\n---\n"),
		)],
		true,
	);
	let answer = diff(&mut ui, &["/en/new.html"], &head);
	let page = of(&answer, "/en/new.html").unwrap();
	let url = page.get("url").unwrap();
	assert_eq!(kind(url), "modified");
	assert_eq!(url.get("head"), Some(&s("/en/old.html")));
	assert!(revertible(url));
	assert_eq!(page.get("meta"), None);
	// as a key it is not put back: the URL is
	let answer = revert(&mut ui, "/en/new.html", Some("path"), &head);
	assert_eq!(code(&answer), "notEditable");
	let answer = revert(&mut ui, "/en/new.html", None, &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/170370.html"),
		"---\npath: /en/old.html\ntitle: T\n---\n"
	);
	assert_eq!(
		answer.get("page").and_then(|p| p.get("url")),
		Some(&s("/en/old.html"))
	);
	assert!(ui.by_url.contains_key("/en/old.html"));
	assert!(!ui.by_url.contains_key("/en/new.html"));
}

#[test]
fn a_page_whose_url_is_not_made_by_a_key_has_no_key_for_the_url_to_be_put_back() {
	let site = Site::new("no_url_key");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	let head = head_of(&mut ui, &["/a.html"], &[], true);
	let answer = revert(&mut ui, "/a.html", None, &head);
	assert_eq!(code(&answer), "invalid");
}

#[test]
fn putting_a_value_back_writes_what_head_has_and_nothing_else_changes() {
	let site = Site::new("revert_modified");
	site.write(
		"src/a/index.html",
		"---\ntitle: New\nextra: 1\n---\n<p>a</p>",
	);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.html", H::Text(OLD))],
		true,
	);
	let before = ui.version;
	let answer = revert(&mut ui, "/a/", Some("title"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/a/index.html"),
		"---\ntitle: Old\nextra: 1\n---\n<p>a</p>"
	);
	assert_eq!(value_of(&mut ui, "/a/", "title"), Some(s("Old")));
	assert_eq!(ui.version, before + 1);
	// the rest of the differences are still there
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.html", H::Text(OLD))],
		true,
	);
	let page = of(&diff(&mut ui, &["/a/"], &head), "/a/").unwrap();
	assert_eq!(page.get("meta").and_then(|m| m.get("title")), None);
	assert_eq!(kind(&meta_diff(&page, "extra")), "added");
}

#[test]
fn a_key_that_was_added_is_taken_out_and_one_that_was_deleted_is_written_again() {
	let site = Site::new("revert_added_deleted");
	site.write(
		"src/a/index.html",
		"---\ntitle: Old\nextra: 1\n---\n<p>a</p>",
	);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.html", H::Text(OLD))],
		true,
	);
	let answer = revert(&mut ui, "/a/", Some("extra"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(value_of(&mut ui, "/a/", "extra"), None);
	let answer = revert(&mut ui, "/a/", Some("description"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(value_of(&mut ui, "/a/", "description"), Some(s("Gone")));
	assert_eq!(site.read("src/a/index.html"), OLD);
}

#[test]
fn a_value_that_was_changed_in_two_files_is_put_back_in_both_or_in_none() {
	let site = Site::new("revert_two_files");
	site.write("src/a/index.html", "---\ntitle: New\n---\n<p>a</p>");
	site.write("src/a/index.json", r#"{"title":"Side","x":1}"#);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			(
				"src/a/index.html",
				H::Text("---\ntitle: Old\n---\n<p>a</p>"),
			),
			("src/a/index.json", H::Absent),
		],
		true,
	);
	let answer = revert(&mut ui, "/a/", Some("title"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(
		site.read("src/a/index.html"),
		"---\ntitle: Old\n---\n<p>a</p>"
	);
	assert_eq!(site.read("src/a/index.json"), r#"{"x":1}"#);
	assert_eq!(value_of(&mut ui, "/a/", "title"), Some(s("Old")));
	assert_eq!(value_of(&mut ui, "/a/", "x"), Some(Value::Number(1.0)));
}

#[test]
fn a_revert_that_cannot_write_one_of_its_files_writes_none() {
	let site = Site::new("revert_atomic");
	site.write("src/a/index.html", "---\ntitle: New\n---\n<p>a</p>");
	site.write("src/a/index.json", r#"{"title":"Side"}"#);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			(
				"src/a/index.html",
				H::Text("---\ntitle: Old\n---\n<p>a</p>"),
			),
			("src/a/index.json", H::Absent),
		],
		true,
	);
	// the sidecar was changed after the screen read it
	let expect = expect_of(&mut ui, "/a/");
	site.write("src/a/index.json", r#"{"title":"Other"}"#);
	let answer = json(
		&ui.edit(&format!(
			r#"{{"url":"/a/","expect":{expect},"change":{{"op":"revert","key":"title","head":{head}}}}}"#
		))
		.unwrap(),
	);
	assert_eq!(code(&answer), "conflict");
	assert_eq!(
		site.read("src/a/index.html"),
		"---\ntitle: New\n---\n<p>a</p>"
	);
	assert_eq!(site.read("src/a/index.json"), r#"{"title":"Other"}"#);
}

#[test]
fn a_value_of_pages_overrides_is_put_back_in_its_entry() {
	let (site, mut ui) = overrides_site("revert_overrides");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[(
			"pages.overrides.json",
			H::Text(
				r#"{"version":1,"pages":[{"url":"/a/","meta":{"nav":true}},{"url":"/ext/","virtual":true,"meta":{"title":"Ext"}}]}"#,
			),
		)],
		true,
	);
	let answer = revert(&mut ui, "/a/", Some("nav"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(value_of(&mut ui, "/a/", "nav"), Some(Value::Bool(true)));
	assert!(site.read("pages.overrides.json").contains(r#""nav":true"#));
}

#[test]
fn a_revert_asks_for_the_text_of_head_before_it_writes() {
	let site = Site::new("revert_need");
	site.write("src/a/index.html", "---\ntitle: New\n---\n<p>a</p>");
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[("src/a/index.html", H::Text(OLD))],
		false,
	);
	let version = ui.version;
	let answer = revert(&mut ui, "/a/", Some("title"), &head);
	assert_eq!(code(&answer), "need");
	assert_eq!(
		answer.get("need"),
		Some(&Value::Array(vec![s("src/a/index.html")]))
	);
	assert_eq!(
		site.read("src/a/index.html"),
		"---\ntitle: New\n---\n<p>a</p>"
	);
	assert_eq!(ui.version, version);
}

#[test]
fn a_request_that_is_not_a_revert_is_an_error() {
	let site = Site::new("revert_request");
	site.write("src/a.html", "a");
	let mut ui = site.open("");
	for change in [
		r#"{"op":"revert","key":5,"head":{}}"#,
		r#"{"op":"revert","key":"t","head":[]}"#,
		r#"{"op":"revert","key":"t","head":{"a":5}}"#,
		r#"{"op":"revert","key":"t","head":{"a":{"oid":1}}}"#,
	] {
		let request = format!(r#"{{"url":"/a.html","expect":{{}},"change":{change}}}"#);
		assert!(ui.edit(&request).is_err(), "{change}");
	}
	assert!(
		ui.diff(r#"{"urls":["/a.html"],"format":"sha1","head":{"a":5}}"#)
			.is_err()
	);
	assert!(ui.diff(r#"{"format":"sha1"}"#).is_err());
}

#[test]
fn what_was_parsed_is_not_dropped_in_the_middle_of_a_request_that_fills_the_cache() {
	// More files that differ than the cache holds: the page that comes last was told by its id
	// alone, because it was parsed by an earlier request, and its entry must still be there.
	const PAGES: usize = 4200;
	let site = Site::new("cache_full");
	for i in 0..PAGES {
		site.write(&format!("src/p{i}.html"), &format!("---\nt: new{i}\n---\n"));
	}
	let mut ui = site.open("");
	let paths: Vec<String> = (0..PAGES).map(|i| format!("src/p{i}.html")).collect();
	let texts: Vec<String> = (0..PAGES)
		.map(|i| format!("---\nt: old{i}\n---\n"))
		.collect();
	let states: Vec<(&str, H)> = paths
		.iter()
		.zip(&texts)
		.map(|(p, t)| (p.as_str(), H::Text(t.as_str())))
		.collect();
	let urls: Vec<String> = (0..PAGES).map(|i| format!("/p{i}.html")).collect();

	// The first page is asked about alone, with its text: what it parsed to is kept by its id.
	let alone = head_of(&mut ui, &["/p0.html"], &states, true);
	diff(&mut ui, &["/p0.html"], &alone);

	// Then every page is asked about, the first one last and without its text.
	let mut order: Vec<&str> = urls[1..].iter().map(String::as_str).collect();
	order.push("/p0.html");
	let full = head_of(&mut ui, &order, &states, true);
	let Value::Object(mut members) = json(&full) else {
		panic!("head")
	};
	for (path, state) in &mut members {
		if path == "src/p0.html" {
			*state = Value::Object(vec![("oid".to_owned(), s(&blob(&texts[0])))]);
		}
	}
	let head = Value::Object(members).to_json();
	let answer = diff(&mut ui, &order, &head);
	assert_eq!(answer.get("need"), None);
	let page = of(&answer, "/p0.html").expect("the page that was parsed before still differs");
	let t = meta_diff(&page, "t");
	assert_eq!(kind(&t), "modified");
	assert_eq!(t.get("head"), Some(&s("old0")));
	assert!(revertible(&t));
}

#[test]
fn files_outside_the_directory_of_the_config_are_named_by_a_path_that_climbs_out_of_it() {
	let site = Site::new("outside");
	site.write(
		"site/kamado.config.jsonc",
		r#"{ "dir": { "input": "../content", "output": "out" }, "build": { "cacheDir": ".cache" } }"#,
	);
	site.write("content/a/index.html", "---\ntitle: New\n---\n");
	site.write("content/a/index.json", r#"{"x":1}"#);
	let loaded = crate::load(&format!("{}/site/kamado.config.jsonc", site.root)).unwrap();
	let mut ui = Ui::open(loaded, &BuildOptions::default()).unwrap();

	let files = json(
		&ui.diff_files(r#"{"urls":["/a/"],"format":"sha1"}"#)
			.unwrap(),
	);
	let Some(Value::Array(listed)) = files.get("files") else {
		panic!("files")
	};
	let paths: Vec<&str> = listed
		.iter()
		.filter_map(|f| f.get("path").and_then(Value::as_str))
		.collect();
	assert_eq!(
		paths,
		["../content/a/index.html", "../content/a/index.json"]
	);

	// what HEAD held of the page file is compared as it is for any other
	let head = format!(
		r#"{{"../content/a/index.html":{{"oid":{},"text":{}}},"../content/a/index.json":"same"}}"#,
		s(&blob(OLD)).to_json(),
		s(OLD).to_json()
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").expect("the page differs");
	assert_eq!(kind(&meta_diff(&page, "title")), "modified");
}

#[test]
fn an_object_whose_keys_are_in_another_order_is_the_same_value() {
	let site = Site::new("key_order");
	site.write(
		"src/a/index.html",
		"---\nseo: {\"b\": 2, \"a\": {\"y\": 1, \"x\": [1, 2]}}\nlist: [1, 2]\n---\n",
	);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[(
			"src/a/index.html",
			H::Text("---\nseo: {\"a\": {\"x\": [1, 2], \"y\": 1}, \"b\": 2}\nlist: [2, 1]\n---\n"),
		)],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").expect("the list differs");
	// the order of the keys of an object says nothing; the order of a list does
	assert_eq!(page.get("meta").and_then(|m| m.get("seo")), None);
	assert_eq!(kind(&meta_diff(&page, "list")), "modified");
}

#[test]
fn a_difference_says_which_files_a_revert_writes() {
	let site = Site::new("writes");
	site.write("src/a/index.html", "---\ntitle: New\nplain: x\n---\n");
	site.write("src/a/index.json", r#"{"title":"Side"}"#);
	let mut ui = site.open("");
	let head = head_of(
		&mut ui,
		&["/a/"],
		&[
			(
				"src/a/index.html",
				H::Text("---\ntitle: Old\nplain: y\n---\n"),
			),
			("src/a/index.json", H::Absent),
		],
		true,
	);
	let answer = diff(&mut ui, &["/a/"], &head);
	let page = of(&answer, "/a/").unwrap();
	let writes = |key: &str| meta_diff(&page, key).get("writes").cloned();
	// the title was changed in the page file and the sidecar has one that HEAD has not
	assert_eq!(
		writes("title"),
		Some(Value::Array(vec![s("inFile"), s("sidecar")]))
	);
	assert_eq!(writes("plain"), Some(Value::Array(vec![s("inFile")])));
	// what cannot be put back writes nothing
	let added = {
		let head = head_of(&mut ui, &["/a/"], &[("src/a/index.html", H::Absent)], true);
		let page = of(&diff(&mut ui, &["/a/"], &head), "/a/").unwrap();
		meta_diff(&page, "plain").get("writes").cloned()
	};
	assert_eq!(added, None);
}

#[test]
fn the_ids_of_the_files_follow_what_the_plan_read_and_a_change_made_through_the_editor() {
	let site = Site::new("blob_cache");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let ids = |ui: &mut Ui| {
		let files = json(
			&ui.diff_files(r#"{"urls":["/a/"],"format":"sha1"}"#)
				.unwrap(),
		);
		let Some(Value::Array(files)) = files.get("files") else {
			panic!("files")
		};
		files[0].get("blob").cloned().unwrap()
	};
	assert_eq!(ids(&mut ui), s(&blob("---\ntitle: A\n---\n")));
	// asked again: the same id, without the file being read again
	assert_eq!(ids(&mut ui), s(&blob("---\ntitle: A\n---\n")));
	// a change made through the editor
	let expect = expect_of(&mut ui, "/a/");
	let answer = json(
		&ui.edit(&format!(
			r#"{{"url":"/a/","expect":{expect},"change":{{"op":"set","key":"title","value":"B"}}}}"#
		))
		.unwrap(),
	);
	assert!(ok(&answer));
	assert_eq!(ids(&mut ui), s(&blob("---\ntitle: B\n---\n")));
	// a change made elsewhere, once the plan has read it
	site.write("src/a/index.html", "---\ntitle: C\n---\n");
	ui.refresh().unwrap();
	assert_eq!(ids(&mut ui), s(&blob("---\ntitle: C\n---\n")));
}

#[test]
fn an_order_put_back_in_two_files_leaves_the_plan_in_the_order_head_gives() {
	let site = Site::new("revert_order");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/b.html", "---\ntitle: B\norder: 5\n---\n");
	site.write("src/c.html", "---\ntitle: C\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{"version":1,"pages":[{"url":"/b.html","meta":{"order":4}}]}"#,
	);
	let mut ui = site.open(OVERRIDES);
	let head = head_of(
		&mut ui,
		&["/b.html"],
		&[
			("src/b.html", H::Text("---\ntitle: B\norder: -3\n---\n")),
			(
				"pages.overrides.json",
				H::Text(r#"{"version":1,"pages":[{"url":"/b.html","meta":{"order":-2}}]}"#),
			),
		],
		true,
	);
	let answer = revert(&mut ui, "/b.html", Some("order"), &head);
	assert!(ok(&answer), "{answer:?}");
	assert_eq!(site.read("src/b.html"), "---\ntitle: B\norder: -3\n---\n");
	assert!(site.read("pages.overrides.json").contains("-2"));
	// the entry wins over the file, so the page is at -2: before the pages that have none
	assert_eq!(
		value_of(&mut ui, "/b.html", "order"),
		Some(Value::Number(-2.0))
	);
	let rows = json(&ui.pages(r#"{"offset":0,"limit":100}"#).unwrap());
	let Some(Value::Array(pages)) = rows.get("pages") else {
		panic!("pages")
	};
	let urls: Vec<&str> = pages
		.iter()
		.map(|p| p.get("url").and_then(Value::as_str).unwrap())
		.collect();
	assert_eq!(urls, ["/b.html", "/a.html", "/c.html"]);
}
