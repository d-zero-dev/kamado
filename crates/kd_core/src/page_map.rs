//! The pages of a site as one list (`kamado pages`, RFC §14.1): what the plan knows, written
//! before anything is rendered. The plan is what a build starts from (the files found, the
//! metadata of every source merged, `pages.overrides` applied), so the list costs what planning
//! costs and does not wait for the pages to be built.

use kd_jsonc::Value;

use crate::session::{Planned, plan_pages};
use crate::{BuildOptions, Loaded, Page, Plan};

/// Plans the pages of the site and lists them, as the JSON of RFC §14.1: for each page the
/// fields of its `page` (URL, input and output path, slug, stem and extension), how deep it is
/// and which directory it hangs from, whether it is virtual, and its merged `meta`, in the
/// order of the plan (the order of `pages` and `nav()`); then the warnings of the plan.
///
/// Nothing is rendered or written, except the plan cache of an incremental plan
/// (`options.incremental` or `build.incremental`). `options.targets` is not read: every page
/// of the plan is listed, as the sitemap does.
///
/// # Errors
///
/// A message for any problem with the plan: an invalid glob, an unreadable page or
/// `pages.overrides`, invalid front matter, a sidecar or `meta`.
///
/// # Example
///
/// ```no_run
/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
/// let json = kd_core::pages(&loaded, &kd_core::BuildOptions::default()).unwrap();
/// assert!(json.starts_with(r#"{"version":1,"pages":["#));
/// ```
pub fn pages(loaded: &Loaded, options: &BuildOptions) -> Result<String, String> {
	let Planned { plan, .. } = plan_pages(loaded, options, None)?;
	Ok(map_json(&plan))
}

fn map_json(plan: &Plan) -> String {
	Value::Object(vec![
		("version".to_owned(), Value::Number(1.0)),
		(
			"pages".to_owned(),
			Value::Array(plan.pages.iter().map(entry_json).collect()),
		),
		(
			"warnings".to_owned(),
			Value::Array(
				plan.warnings
					.iter()
					.map(|w| Value::String(w.clone()))
					.collect(),
			),
		),
	])
	.to_json()
}

/// One page of the list. A virtual page has no input file, so no input path and no extension:
/// the plan derives them from the URL, and a path that does not exist must not be taken for
/// one that does. Its output path stays, the place where the page would be written (and is not).
fn entry_json(page: &Page) -> Value {
	let f = &page.file;
	let (depth, parent) = kd_site::url_depth_and_parent(&f.url);
	let real = |text: &str| {
		if page.is_virtual {
			Value::Null
		} else {
			Value::String(text.to_owned())
		}
	};
	Value::Object(vec![
		("url".to_owned(), Value::String(f.url.clone())),
		("inputPath".to_owned(), real(&f.input_path)),
		(
			"outputPath".to_owned(),
			Value::String(f.output_path.clone()),
		),
		("fileSlug".to_owned(), Value::String(f.file_slug.clone())),
		(
			"filePathStem".to_owned(),
			Value::String(f.file_path_stem.clone()),
		),
		("extension".to_owned(), real(&f.extension)),
		("depth".to_owned(), Value::Number(depth as f64)),
		(
			"parent".to_owned(),
			parent.map_or(Value::Null, Value::String),
		),
		("virtual".to_owned(), Value::Bool(page.is_virtual)),
		("meta".to_owned(), Value::Object(page.meta.clone())),
	])
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	struct Site {
		root: String,
	}

	impl Site {
		fn new(name: &str) -> Site {
			let root = format!(
				"{}/kd_page_map_{name}_{}",
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

		fn config(&self, extra: &str) -> Loaded {
			self.config_text(&format!(
				r#"{{ "dir": {{ "input": "src", "output": "out" }}, "build": {{ "cacheDir": ".cache" }}{extra} }}"#
			))
		}

		fn config_text(&self, text: &str) -> Loaded {
			self.write("kamado.config.jsonc", text);
			crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap()
		}

		fn map(&self, extra: &str) -> Value {
			self.map_with(extra, &BuildOptions::default())
		}

		fn map_with(&self, extra: &str, options: &BuildOptions) -> Value {
			let json = pages(&self.config(extra), options).unwrap();
			kd_jsonc::parse(&json).unwrap()
		}
	}

	impl Drop for Site {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn entries(map: &Value) -> &[Value] {
		map.get("pages").unwrap().as_array().unwrap()
	}

	fn text<'a>(entry: &'a Value, key: &str) -> &'a str {
		entry.get(key).unwrap().as_str().unwrap()
	}

	fn urls(map: &Value) -> Vec<&str> {
		entries(map).iter().map(|e| text(e, "url")).collect()
	}

	fn entry<'a>(map: &'a Value, url: &str) -> &'a Value {
		entries(map)
			.iter()
			.find(|e| text(e, "url") == url)
			.unwrap_or_else(|| panic!("no page {url}"))
	}

	#[test]
	fn a_page_has_its_files_its_place_and_the_meta_of_every_source() {
		let site = Site::new("fields");
		site.write("src/index.html", "---\ntitle: Home\n---\n<p>home</p>");
		site.write("src/about/index.html", "<p>about</p>");
		site.write(
			"src/about/index.json",
			r#"{ "title": "About", "layout": "sub" }"#,
		);
		site.write(
			"src/about/history.tsx",
			"export const meta = { title: \"History\" };\nexport default () => null;\n",
		);
		let loaded = site.config("");
		let json = pages(&loaded, &BuildOptions::default()).unwrap();
		let root = &site.root;
		// The order of the plan (the order of `pages` and `nav()`), no date, one line.
		assert_eq!(
			json,
			format!(
				concat!(
					r#"{{"version":1,"pages":["#,
					r#"{{"url":"/about/history.html","inputPath":"{root}/src/about/history.tsx","outputPath":"{root}/out/about/history.html","fileSlug":"history","filePathStem":"/about/history","extension":".tsx","depth":2,"parent":"/about/","virtual":false,"meta":{{"title":"History"}}}},"#,
					r#"{{"url":"/about/","inputPath":"{root}/src/about/index.html","outputPath":"{root}/out/about/index.html","fileSlug":"about","filePathStem":"/about/index","extension":".html","depth":1,"parent":"/","virtual":false,"meta":{{"title":"About","layout":"sub"}}}},"#,
					r#"{{"url":"/","inputPath":"{root}/src/index.html","outputPath":"{root}/out/index.html","fileSlug":"src","filePathStem":"/index","extension":".html","depth":0,"parent":null,"virtual":false,"meta":{{"title":"Home"}}}}"#,
					r#"],"warnings":[]}}"#,
				),
				root = root
			)
		);
	}

	#[test]
	fn the_file_of_overrides_orders_the_pages_and_adds_the_virtual_ones() {
		let site = Site::new("overrides");
		site.write("src/index.html", "---\ntitle: Home\n---\n<p>home</p>");
		site.write("src/about/index.html", "---\ntitle: About\n---\n<p>a</p>");
		site.write(
			"pages.json",
			r#"{ "version": 1, "pages": [
				{ "url": "/about/", "meta": { "title": "About (sheet)" } },
				{ "url": "/service/", "virtual": true, "meta": { "title": "Service", "realHref": "https://example.com/" } }
			] }"#,
		);
		let map = site.map(r#", "pages": { "overrides": "pages.json" }"#);
		// The pages of the file first, in its order; the others after them.
		assert_eq!(urls(&map), ["/about/", "/service/", "/"]);
		assert_eq!(
			Value::Object(vec![(
				"meta".to_owned(),
				entry(&map, "/about/").get("meta").unwrap().clone()
			)])
			.to_json(),
			r#"{"meta":{"title":"About (sheet)"}}"#
		);

		// A page without an input file: no input, no extension, but the place where
		// the output would be, and a flag to tell it from the others.
		let service = entry(&map, "/service/");
		assert!(service.get("inputPath").unwrap().is_null());
		assert!(service.get("extension").unwrap().is_null());
		assert_eq!(
			text(service, "outputPath"),
			format!("{}/out/service/index.html", site.root)
		);
		assert_eq!(text(service, "fileSlug"), "service");
		assert_eq!(text(service, "filePathStem"), "/service/index");
		assert_eq!(service.get("virtual").unwrap().as_bool(), Some(true));
		assert_eq!(service.get("depth").unwrap().as_f64(), Some(1.0));
		assert_eq!(text(service, "parent"), "/");
		assert_eq!(
			service
				.get("meta")
				.unwrap()
				.get("realHref")
				.unwrap()
				.as_str(),
			Some("https://example.com/")
		);
		assert_eq!(
			entry(&map, "/about/").get("virtual").unwrap().as_bool(),
			Some(false)
		);
	}

	#[test]
	fn the_pages_listed_are_the_pages_a_build_makes() {
		// What a walk leaves out: `pages.ignore`, a directory that starts with a dot, files
		// that `pages.files` does not name (`.htm`, `.txt`), and the output directory inside
		// the input directory.
		let site = Site::new("same_as_build");
		site.write("index.html", "<p>home</p>");
		site.write("a/b.html", "<p>b</p>");
		site.write("a/c.htm", "<p>c</p>");
		site.write("_parts/x.html", "<p>x</p>");
		site.write(".hidden/y.html", "<p>y</p>");
		site.write("notes.txt", "notes");
		site.write("out/old.html", "<p>old</p>");
		let loaded = site.config_text(
			r#"{ "dir": { "input": ".", "output": "out" }, "pages": { "ignore": ["_parts/**"] }, "build": { "cacheDir": ".cache" } }"#,
		);
		let json = pages(&loaded, &BuildOptions::default()).unwrap();
		let map = kd_jsonc::parse(&json).unwrap();
		let report = crate::build(
			&loaded,
			&BuildOptions {
				jobs: Some(1),
				..Default::default()
			},
		)
		.unwrap();
		let built: Vec<&str> = report.pages.iter().map(|p| p.url.as_str()).collect();
		assert_eq!(urls(&map), built);
		assert_eq!(built, ["/a/b.html", "/"]);
	}

	#[test]
	fn a_page_that_moved_by_the_output_path_field_is_listed_where_it_went() {
		let site = Site::new("moved");
		site.write(
			"src/100.html",
			"---\npath: \"/legacy/a.html\"\n---\n<p>a</p>",
		);
		let map = site.map(r#", "pages": { "outputPathField": "path" }"#);
		let moved = entry(&map, "/legacy/a.html");
		assert_eq!(
			text(moved, "inputPath"),
			format!("{}/src/100.html", site.root)
		);
		assert_eq!(
			text(moved, "outputPath"),
			format!("{}/out/legacy/a.html", site.root)
		);
		assert_eq!(text(moved, "filePathStem"), "/legacy/a");
		assert_eq!(moved.get("depth").unwrap().as_f64(), Some(2.0));
		assert_eq!(text(moved, "parent"), "/legacy/");
	}

	#[test]
	fn the_warnings_of_the_plan_are_listed() {
		let site = Site::new("warnings");
		site.write(
			"src/100.html",
			"---\npath: \"/legacy/a.html\"\n---\n<p>a</p>",
		);
		site.write(
			"src/200.html",
			"---\npath: \"/legacy/a.html\"\n---\n<p>b</p>",
		);
		let map = site.map(r#", "pages": { "outputPathField": "path" }"#);
		assert_eq!(urls(&map), ["/legacy/a.html"]);
		let warnings = map.get("warnings").unwrap().as_array().unwrap();
		assert_eq!(warnings.len(), 1);
		assert!(warnings[0].as_str().unwrap().contains("/legacy/a.html"));
	}

	#[test]
	fn a_virtual_root_is_at_depth_zero_and_has_no_parent() {
		let site = Site::new("virtual_root");
		site.write("src/a.html", "<p>a</p>");
		site.write(
			"pages.json",
			r#"{ "version": 1, "pages": [ { "url": "/", "virtual": true, "meta": { "title": "Home" } } ] }"#,
		);
		let map = site.map(r#", "pages": { "overrides": "pages.json" }"#);
		let root = entry(&map, "/");
		assert_eq!(root.get("virtual").unwrap().as_bool(), Some(true));
		assert!(root.get("inputPath").unwrap().is_null());
		assert!(root.get("extension").unwrap().is_null());
		assert_eq!(
			text(root, "outputPath"),
			format!("{}/out/index.html", site.root)
		);
		assert_eq!(root.get("depth").unwrap().as_f64(), Some(0.0));
		assert!(root.get("parent").unwrap().is_null());
	}

	#[test]
	fn without_an_output_extension_a_page_is_its_path_and_an_index_is_its_directory() {
		let site = Site::new("no_extension");
		site.write("src/a/index.html", "<p>a</p>");
		site.write("src/a/b.html", "<p>b</p>");
		let map = site.map(r#", "pages": { "outputExtension": "" }"#);
		assert_eq!(urls(&map), ["/a/b", "/a/"]);
		let b = entry(&map, "/a/b");
		// The extension is the one of the source; the URL has none.
		assert_eq!(text(b, "extension"), ".html");
		assert_eq!(text(b, "outputPath"), format!("{}/out/a/b", site.root));
		assert_eq!(b.get("depth").unwrap().as_f64(), Some(2.0));
		assert_eq!(text(b, "parent"), "/a/");
		let dir = entry(&map, "/a/");
		assert_eq!(dir.get("depth").unwrap().as_f64(), Some(1.0));
		assert_eq!(text(dir, "parent"), "/");
	}

	#[test]
	fn an_index_written_with_a_capital_extension_is_counted_as_one_but_is_no_directory_page() {
		// `index.HTML` keeps its name in the URL (only a lower case extension drops it), so
		// no page has the URL `/x/` that its siblings hang from.
		let site = Site::new("capital_extension");
		site.write("src/x/index.html", "<p>x</p>");
		site.write("src/x/a.html", "<p>a</p>");
		let map = site.map(r#", "pages": { "outputExtension": ".HTML" }"#);
		assert_eq!(urls(&map), ["/x/a.HTML", "/x/index.HTML"]);
		let index = entry(&map, "/x/index.HTML");
		assert_eq!(index.get("depth").unwrap().as_f64(), Some(1.0));
		assert_eq!(text(index, "parent"), "/");
		let a = entry(&map, "/x/a.HTML");
		assert_eq!(a.get("depth").unwrap().as_f64(), Some(2.0));
		assert_eq!(text(a, "parent"), "/x/");
		assert!(!urls(&map).contains(&"/x/"));
	}

	#[test]
	fn a_plan_cache_that_cannot_be_written_is_a_warning_of_the_list() {
		let site = Site::new("cache_blocked");
		site.write("src/index.html", "<p>home</p>");
		// A file where the cache directory has to be made.
		site.write("blocked", "not a directory");
		let map = site.map_with(
			"",
			&BuildOptions {
				incremental: true,
				cache_dir: Some(format!("{}/blocked/cache", site.root)),
				..Default::default()
			},
		);
		assert_eq!(urls(&map), ["/"]);
		let warnings = map.get("warnings").unwrap().as_array().unwrap();
		assert_eq!(warnings.len(), 1);
		assert!(
			warnings[0].as_str().unwrap().starts_with("plan cache: "),
			"{warnings:?}"
		);
	}

	#[test]
	fn a_site_without_pages_has_an_empty_list() {
		let site = Site::new("empty");
		let json = pages(&site.config(""), &BuildOptions::default()).unwrap();
		assert_eq!(json, r#"{"version":1,"pages":[],"warnings":[]}"#);
	}

	#[test]
	fn an_incremental_map_keeps_the_plan_cache_and_sees_what_changed() {
		let site = Site::new("incremental");
		site.write("src/index.html", "---\ntitle: Home\n---\n<p>home</p>");
		let cache = format!("{}/cache", site.root);
		let options = BuildOptions {
			incremental: true,
			cache_dir: Some(cache.clone()),
			..Default::default()
		};
		let first = site.map_with("", &options);
		assert!(std::path::Path::new(&format!("{cache}/plan-cache.bin")).exists());
		assert_eq!(
			entry(&first, "/")
				.get("meta")
				.unwrap()
				.get("title")
				.unwrap()
				.as_str(),
			Some("Home")
		);
		// The file is read again when its size or time is not what the cache recorded.
		site.write(
			"src/index.html",
			"---\ntitle: Welcome home\n---\n<p>home</p>",
		);
		let second = site.map_with("", &options);
		assert_eq!(
			entry(&second, "/")
				.get("meta")
				.unwrap()
				.get("title")
				.unwrap()
				.as_str(),
			Some("Welcome home")
		);
	}

	#[test]
	fn a_map_that_is_not_incremental_leaves_no_plan_cache() {
		let site = Site::new("cold");
		site.write("src/index.html", "<p>home</p>");
		let cache = format!("{}/cache", site.root);
		let options = BuildOptions {
			cache_dir: Some(cache.clone()),
			..Default::default()
		};
		site.map_with("", &options);
		assert!(!std::path::Path::new(&format!("{cache}/plan-cache.bin")).exists());
	}

	#[test]
	fn the_incremental_switch_of_the_config_counts_too() {
		let site = Site::new("config_incremental");
		site.write("src/index.html", "<p>home</p>");
		let loaded = site.config_text(
			r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": "cache", "incremental": true } }"#,
		);
		pages(&loaded, &BuildOptions::default()).unwrap();
		assert!(std::path::Path::new(&format!("{}/cache/plan-cache.bin", site.root)).exists());
	}

	#[test]
	fn a_plan_that_cannot_be_made_is_an_error() {
		let site = Site::new("error");
		site.write("src/index.html", "<p>home</p>");
		let loaded = site.config(r#", "pages": { "overrides": "missing.json" }"#);
		let error = pages(&loaded, &BuildOptions::default()).unwrap_err();
		assert!(error.contains("cannot read pages.overrides"), "{error}");
	}
}
