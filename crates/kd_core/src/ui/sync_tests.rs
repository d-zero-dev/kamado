//! What a sync starts from (RFC §14.2, "同期"): every page of the plan in the shape of the list
//! of `kamado pages`, with the hashes of the files it reads now and the keys that cannot be
//! edited; and the operations of `ui.syncFunctions` that the command serving the editor needs.

use super::*;

struct Site {
	root: String,
}

impl Site {
	fn new(name: &str) -> Site {
		let root = format!(
			"{}/kd_ui_sync_{name}_{}",
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

impl Drop for Site {
	fn drop(&mut self) {
		let _ = fs::remove_dir_all(&self.root);
	}
}

fn parse(json: &str) -> Value {
	kd_jsonc::parse(json).unwrap()
}

fn string<'a>(value: &'a Value, key: &str) -> &'a str {
	match value.get(key) {
		Some(Value::String(s)) => s,
		other => panic!("{key} is not a string: {other:?}"),
	}
}

fn page<'a>(answer: &'a Value, url: &str) -> &'a Value {
	let Some(Value::Array(pages)) = answer.get("pages") else {
		panic!("no pages in {answer:?}");
	};
	pages
		.iter()
		.find(|p| string(p, "url") == url)
		.unwrap_or_else(|| panic!("no page {url}"))
}

const OVERRIDES: &str = r#", "pages": { "overrides": "pages.overrides.json" }"#;

#[test]
fn every_page_is_listed_as_kamado_pages_lists_it() {
	let site = Site::new("shape");
	site.write("src/index.html", "---\ntitle: Home\n---\n<p>Home</p>\n");
	site.write("src/about/history.html", "---\ntitle: History\n---\n");
	let mut ui = site.open("");
	let answer = parse(&ui.sync_pages());

	let Some(Value::Array(pages)) = answer.get("pages") else {
		panic!("no pages");
	};
	assert_eq!(pages.len(), 2);

	let listed = parse(&crate::page_map::map_json(&ui.plan));
	let Some(Value::Array(expected)) = listed.get("pages") else {
		panic!("no pages in the list");
	};
	// every field of the list of `kamado pages` is there, with the same value
	for want in expected {
		let got = page(&answer, string(want, "url"));
		let Value::Object(fields) = want else {
			panic!("an entry is an object")
		};
		for (key, value) in fields {
			assert_eq!(
				got.get(key),
				Some(value),
				"{key} of {}",
				string(want, "url")
			);
		}
	}
	assert_eq!(string(&answer, "inputDir"), format!("{}/src", site.root));
	assert_eq!(answer.get("outputPathField"), Some(&Value::Null));
	// no pages.overrides: no file of it
	assert_eq!(answer.get("overridesFile"), Some(&Value::Null));
}

#[test]
fn the_hashes_are_those_of_the_files_the_plan_read() {
	let site = Site::new("hashes");
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	site.write("src/index.json", r#"{ "layout": "x" }"#);
	site.write("src/plain.html", "---\ntitle: Plain\n---\n");
	let mut ui = site.open("");
	let answer = parse(&ui.sync_pages());

	let with_sidecar = page(&answer, "/").get("hashes").unwrap();
	assert!(matches!(with_sidecar.get("input"), Some(Value::String(_))));
	assert!(matches!(
		with_sidecar.get("sidecar"),
		Some(Value::String(_))
	));
	let without = page(&answer, "/plain.html").get("hashes").unwrap();
	assert!(matches!(without.get("input"), Some(Value::String(_))));
	assert_eq!(without.get("sidecar"), Some(&Value::Null));

	// the hashes are the ones a page edit would ask for
	let rows = parse(&ui.pages(r#"{"offset":0,"limit":10}"#).unwrap());
	let Some(Value::Array(rows)) = rows.get("pages") else {
		panic!("no rows");
	};
	for row in rows {
		assert_eq!(
			page(&answer, string(row, "url")).get("hashes"),
			row.get("hashes"),
			"{}",
			string(row, "url")
		);
	}
}

#[test]
fn a_virtual_page_has_no_hashes_and_the_hash_of_pages_overrides_is_given() {
	let site = Site::new("virtual");
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": { "title": "V" } } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let answer = parse(&ui.sync_pages());

	let v = page(&answer, "/v/");
	assert_eq!(v.get("virtual"), Some(&Value::Bool(true)));
	assert_eq!(v.get("inputPath"), Some(&Value::Null));
	assert_eq!(
		v.get("hashes").unwrap().get("input"),
		Some(&Value::Null),
		"no file, no hash"
	);
	assert!(matches!(
		answer.get("overridesHash"),
		Some(Value::String(_))
	));
	assert_eq!(
		string(&answer, "overridesFile"),
		format!("{}/pages.overrides.json", site.root)
	);
}

/// What `sync_locked` says of the pages at `urls`.
fn locked(ui: &mut Ui, urls: &[&str]) -> Value {
	let query = Value::Object(vec![(
		"urls".to_owned(),
		Value::Array(
			urls.iter()
				.map(|u| Value::String((*u).to_owned()))
				.collect(),
		),
	)]);
	parse(&ui.sync_locked(&query.to_json()).unwrap())
		.get("locked")
		.unwrap()
		.clone()
}

#[test]
fn the_list_does_not_say_which_keys_are_locked() {
	// telling it reads and parses every page file: the list does not, and a sync asks for the
	// pages whose keys it would change
	let site = Site::new("nolock");
	site.write("src/a.html", "---\n{ title: Flow }\n---\n");
	let mut ui = site.open("");
	let answer = parse(&ui.sync_pages());
	assert_eq!(page(&answer, "/a.html").get("locked"), None);
}

#[test]
fn the_keys_that_cannot_be_edited_are_listed_with_why() {
	let site = Site::new("locked");
	// the keys of a front matter written as a flow mapping cannot be edited
	site.write("src/flow.html", "---\n{ title: Flow }\n---\n");
	site.write("src/block.html", "---\ntitle: Block\n---\n");
	let mut ui = site.open("");
	let told = locked(&mut ui, &["/flow.html", "/block.html"]);

	let flow = told.get("/flow.html").unwrap();
	assert!(
		matches!(flow.get("title"), Some(Value::String(why)) if !why.is_empty()),
		"{flow:?}"
	);
	assert_eq!(told.get("/block.html"), Some(&Value::Object(Vec::new())));
}

#[test]
fn only_the_pages_asked_for_are_told_and_a_url_no_page_has_is_left_out() {
	let site = Site::new("asked");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	site.write("src/b.html", "---\ntitle: B\n---\n");
	let mut ui = site.open("");
	let told = locked(&mut ui, &["/a.html", "/nope/"]);
	assert!(told.get("/a.html").is_some());
	assert!(told.get("/b.html").is_none());
	assert!(told.get("/nope/").is_none());
	assert_eq!(locked(&mut ui, &[]), Value::Object(Vec::new()));
}

#[test]
fn a_request_for_the_locked_keys_that_is_not_one_is_refused() {
	let site = Site::new("badquery");
	site.write("src/a.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	for query in ["not json", "{}", r#"{"urls":"/a/"}"#, r#"{"urls":[1]}"#] {
		assert!(ui.sync_locked(query).is_err(), "{query}");
	}
}

#[test]
fn the_key_that_decides_the_url_is_named_and_is_locked() {
	let site = Site::new("field");
	site.write("src/a.html", "---\ntitle: A\nslug: /x/\n---\n");
	let mut ui = site.open(r#", "pages": { "outputPathField": "slug" }"#);
	let answer = parse(&ui.sync_pages());
	assert_eq!(string(&answer, "outputPathField"), "slug");
	let told = locked(&mut ui, &["/x/"]);
	let a = told.get("/x/").unwrap();
	assert!(matches!(a.get("slug"), Some(Value::String(_))), "{a:?}");
	assert_eq!(a.get("title"), None);
}

#[test]
fn the_version_is_the_one_of_the_pages_answer() {
	let site = Site::new("version");
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	let mut ui = site.open("");
	let sync = parse(&ui.sync_pages());
	let pages = parse(&ui.pages(r#"{"offset":0,"limit":1}"#).unwrap());
	assert_eq!(sync.get("version"), pages.get("version"));
}

#[test]
fn the_operations_of_the_config_reach_the_command_with_the_script_made_absolute() {
	let site = Site::new("functions");
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	let ui = site.open(
		r#", "ui": { "syncFunctions": [
			{ "name": "import", "label": { "ja": "取り込む" }, "script": "./scripts/import.mjs" },
			{ "name": "export", "label": "Export", "script": "export.mjs" }
		] }"#,
	);
	let json = ui.server().sync_functions_json();
	let Value::Array(list) = json else {
		panic!("not an array");
	};
	assert_eq!(list.len(), 2);
	assert_eq!(string(&list[0], "name"), "import");
	assert_eq!(
		string(&list[0], "script"),
		format!("{}/scripts/import.mjs", site.root)
	);
	assert_eq!(
		list[0].get("label").unwrap().get("ja"),
		Some(&Value::String("取り込む".to_string()))
	);
	assert_eq!(
		list[1].get("label"),
		Some(&Value::String("Export".to_string()))
	);
}

#[test]
fn no_operation_is_an_empty_list() {
	let site = Site::new("none");
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	let ui = site.open("");
	assert_eq!(ui.server().sync_functions_json().to_json(), "[]");
}

#[test]
fn an_entry_has_the_values_of_its_page() {
	let site = Site::new("values");
	site.write(
		"src/about/history.html",
		"---\ntitle: History\n---\n<p>h</p>\n",
	);
	site.write("src/index.html", "---\ntitle: Home\n---\n");
	let mut ui = site.open("");
	let answer = parse(&ui.sync_pages());
	let history = page(&answer, "/about/history.html");
	assert_eq!(
		string(history, "inputPath"),
		format!("{}/src/about/history.html", site.root)
	);
	assert_eq!(
		string(history, "outputPath"),
		format!("{}/out/about/history.html", site.root)
	);
	assert_eq!(string(history, "fileSlug"), "history");
	assert_eq!(string(history, "filePathStem"), "/about/history");
	assert_eq!(string(history, "extension"), ".html");
	assert_eq!(history.get("depth"), Some(&Value::Number(2.0)));
	assert_eq!(
		history.get("parent"),
		Some(&Value::String("/about/".to_string()))
	);
	assert_eq!(history.get("virtual"), Some(&Value::Bool(false)));
	assert_eq!(
		history.get("meta").and_then(|m| m.get("title")),
		Some(&Value::String("History".to_string()))
	);
	let root = page(&answer, "/");
	assert_eq!(root.get("depth"), Some(&Value::Number(0.0)));
	assert_eq!(root.get("parent"), Some(&Value::Null));
	// a site without pages.overrides has no hash of it
	assert_eq!(answer.get("overridesHash"), Some(&Value::Null));
	// the hashes are the SHA-256 of the files, in hex
	for p in [history, root] {
		let hash = string(p.get("hashes").unwrap(), "input");
		assert_eq!(hash.len(), 64, "{hash}");
		assert!(hash.chars().all(|c| c.is_ascii_hexdigit()), "{hash}");
	}
}

#[test]
fn the_version_moves_with_an_edit_and_the_locked_keys_say_so() {
	let site = Site::new("version_moves");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let before = parse(&ui.sync_pages());
	let hash = string(page(&before, "/a/").get("hashes").unwrap(), "input").to_string();
	ui.edit_batch(&format!(
		r#"{{"edits":[{{"url":"/a/","expect":{{"input":"{hash}","sidecar":null,"overrides":null}},"change":{{"op":"set","key":"title","value":"B"}}}}]}}"#
	))
	.unwrap();
	let after = parse(&ui.sync_pages());
	assert_ne!(before.get("version"), after.get("version"));
	let query = r#"{"urls":["/a/"]}"#;
	let told = parse(&ui.sync_locked(query).unwrap());
	assert_eq!(told.get("version"), after.get("version"));
}

#[test]
fn a_url_asked_for_twice_is_told_once() {
	let site = Site::new("twice");
	site.write("src/a/index.html", "---\ntitle: A\n---\n");
	let mut ui = site.open("");
	let told = parse(&ui.sync_locked(r#"{"urls":["/a/","/a/"]}"#).unwrap());
	let Some(Value::Object(locked)) = told.get("locked") else {
		panic!("no locked in {told:?}");
	};
	assert_eq!(locked.len(), 1, "{locked:?}");
}

#[test]
fn the_keys_of_a_module_and_a_sidecar_and_an_entry_of_pages_overrides_are_told_as_they_are() {
	let site = Site::new("sources");
	site.write(
		"src/m.tsx",
		"export const meta = { title: 'M' };\nexport default () => null;\n",
	);
	site.write("src/s.html", "---\ntitle: S\n---\n");
	site.write("src/s.json", r#"{ "layout": "x" }"#);
	site.write(
		"pages.overrides.json",
		r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true, "meta": { "title": "V" } } ] }"#,
	);
	let mut ui = site.open(OVERRIDES);
	let told = locked(&mut ui, &["/m.html", "/s.html", "/v/"]);
	// every key of these can be edited: nothing is locked
	assert_eq!(told.get("/m.html"), Some(&Value::Object(Vec::new())));
	assert_eq!(told.get("/s.html"), Some(&Value::Object(Vec::new())));
	assert_eq!(told.get("/v/"), Some(&Value::Object(Vec::new())));
}
