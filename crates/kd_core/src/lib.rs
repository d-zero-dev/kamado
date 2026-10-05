//! Build orchestration: config → discovery → metadata → plan → outputs.
//!
//! Everything before rendering runs here without any user code: the config
//! is data, metadata is read statically, and the incremental decision is
//! taken from the manifest. A build that finds nothing to do never starts a
//! worker.
//!
//! Page kinds are decided by the source extension. `.html` pages are HTML
//! with optional front matter; `.tsx` pages are JSX components rendered by
//! the JavaScript side, so this crate only extracts their metadata and hands
//! the rendering out.

use std::collections::BTreeMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use kd_config::Config;
use kd_jsonc::Value;
use kd_site::meta::{Meta, Overrides};
use kd_site::{Candidate, Dirs, PageFile};

/// Version string recorded in environment digests, so that upgrading kamado
/// rebuilds everything.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Config plus what the build needs to know about where it came from.
#[derive(Debug, Clone, PartialEq)]
pub struct Loaded {
	pub config: Config,
	pub config_path: String,
	/// SHA-256 of the config text; part of every environment digest.
	pub config_hash: String,
}

/// Reads and validates `kamado.config.jsonc` and the sibling `package.json`.
///
/// # Example
///
/// ```no_run
/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
/// assert_eq!(loaded.config.root_dir, "/site");
/// ```
pub fn load(config_path: &str) -> Result<Loaded, String> {
	let config_path = kd_site::path::normalize(config_path);
	let text = fs::read_to_string(&config_path)
		.map_err(|e| format!("cannot read config {config_path}: {e}"))?;
	let root_dir = kd_site::path::dirname(&config_path);
	let package_json = fs::read_to_string(format!("{root_dir}/package.json")).ok();
	let config = kd_config::parse(&text, &root_dir, package_json.as_deref())
		.map_err(|e| format!("{config_path}: {e}"))?;
	Ok(Loaded {
		config,
		config_path,
		config_hash: kd_hash::to_hex(&kd_hash::sha256(text.as_bytes())),
	})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PageKind {
	Html,
	Tsx,
}

/// A page after metadata resolution.
#[derive(Debug, Clone, PartialEq)]
pub struct Page {
	pub file: PageFile,
	pub kind: PageKind,
	pub meta: Meta,
	/// HTML body (front matter removed) for `Html` pages.
	pub body: Option<String>,
	/// What the page was built from: the input file and its sidecar `.json`
	/// (a missing sidecar is recorded too, so creating it later invalidates
	/// the output). Fingerprinted when the bytes were read, not afterwards.
	pub deps: BTreeMap<String, kd_build::Dep>,
	/// Declared in `pages.overrides` without an input file.
	pub is_virtual: bool,
	/// `lastmod` from `pages.overrides`.
	pub lastmod: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Plan {
	pub pages: Vec<Page>,
	pub warnings: Vec<String>,
}

fn page_kind(extension: &str) -> Result<PageKind, String> {
	match extension {
		".html" | ".htm" => Ok(PageKind::Html),
		".tsx" | ".jsx" => Ok(PageKind::Tsx),
		other => Err(format!(
			"unsupported page extension {other:?} (use .html or .tsx)"
		)),
	}
}

fn sidecar_path(input_path: &str) -> String {
	let ext = kd_site::path::extname(input_path);
	format!("{}.json", &input_path[..input_path.len() - ext.len()])
}

fn utf8(path: &str, bytes: Vec<u8>) -> Result<String, String> {
	String::from_utf8(bytes).map_err(|_| format!("{path}: file is not valid UTF-8"))
}

/// Reads the in-file metadata and body of a page, with the fingerprint of
/// the bytes that were read.
fn read_page(
	input_path: &str,
	kind: PageKind,
) -> Result<(Meta, Option<String>, kd_build::Dep), String> {
	let (bytes, dep) = kd_build::read_with_fingerprint(input_path)
		.map_err(|e| format!("cannot read {input_path}: {e}"))?;
	let text = utf8(input_path, bytes)?;
	match kind {
		PageKind::Html => {
			let (meta, body) =
				kd_yaml::split_front_matter(&text).map_err(|e| format!("{input_path}:{e}"))?;
			let meta = match meta {
				Some(v) => kd_site::meta::as_meta(&v, input_path)?,
				None => Vec::new(),
			};
			Ok((meta, Some(body.to_string()), dep))
		}
		PageKind::Tsx => Ok((Vec::new(), None, dep)),
	}
}

/// Reads a sidecar `.json`. A missing one is empty metadata and a "missing"
/// dependency.
fn read_sidecar(path: &str) -> Result<(Meta, kd_build::Dep), String> {
	match kd_build::read_with_fingerprint(path) {
		Ok((bytes, dep)) => {
			let text = utf8(path, bytes)?;
			let value = kd_jsonc::parse(&text)
				.map_err(|e| format!("{path}:{}:{}: {}", e.line, e.column, e.message))?;
			Ok((kd_site::meta::as_meta(&value, path)?, dep))
		}
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
			Ok((Vec::new(), kd_build::Dep::missing()))
		}
		Err(e) => Err(format!("cannot read {path}: {e}")),
	}
}

fn compile_globs(globs: &[String]) -> Result<Vec<kd_glob::Pattern>, String> {
	globs
		.iter()
		.map(|g| {
			let pattern =
				kd_glob::Pattern::new(g).map_err(|e| format!("invalid glob {g:?}: {e}"))?;
			// Config globs are rejected at load time; this covers CLI targets.
			if pattern.is_negated() {
				return Err(format!("negated glob {g:?} is not supported"));
			}
			Ok(pattern)
		})
		.collect()
}

/// Discovers pages, resolves their metadata and output locations, applies
/// conflicts and `pages.overrides`.
pub fn plan(config: &Config) -> Result<Plan, String> {
	let dirs = Dirs {
		input_dir: &config.dir.input,
		output_dir: &config.dir.output,
		output_extension: &config.pages.output_extension,
	};
	let files = compile_globs(&config.pages.files)?;
	let ignore = compile_globs(&config.pages.ignore)?;
	let found = kd_site::discover(&config.dir.input, &files, &ignore)
		.map_err(|e| format!("cannot read input directory {}: {e}", config.dir.input))?;

	// An output directory inside the input directory (`input: "."`,
	// `output: "htdocs"`) is not a source: without this the next build would
	// discover its own output as pages and write it to `htdocs/htdocs/...`.
	let output_rel = kd_site::path::relative(&config.dir.input, &config.dir.output);
	let output_inside_input = !output_rel.is_empty() && !output_rel.starts_with("..");

	let mut candidates = Vec::with_capacity(found.len());
	// Keyed by input path: several inputs may claim one output path, and the
	// conflict policy decides which input survives.
	let mut pages_by_input: BTreeMap<String, Page> = BTreeMap::new();
	for rel in found {
		if output_inside_input && (rel == output_rel || rel.starts_with(&format!("{output_rel}/")))
		{
			continue;
		}
		let input_path = format!("{}/{rel}", config.dir.input.trim_end_matches('/'));
		let mut file = kd_site::page_file(&input_path, &dirs);
		let kind = page_kind(&file.extension)?;
		let (in_file, body, input_dep) = read_page(&input_path, kind)?;
		let sidecar = sidecar_path(&input_path);
		let (side, sidecar_dep) = read_sidecar(&sidecar)?;
		let deps = BTreeMap::from([(input_path.clone(), input_dep), (sidecar, sidecar_dep)]);
		let meta = kd_site::meta::merge(&[&in_file, &side]);
		let mut from_override = false;
		if let Some(field) = &config.pages.output_path_field
			&& let Some(Value::String(p)) = meta.iter().find(|(k, _)| k == field).map(|(_, v)| v)
			&& !p.is_empty()
		{
			file = kd_site::apply_meta_path_override(&file, p, &dirs)
				.map_err(|e| format!("{input_path}: invalid {field:?}: {e}"))?;
			from_override = true;
		}
		pages_by_input.insert(
			file.input_path.clone(),
			Page {
				file: file.clone(),
				kind,
				meta,
				body,
				deps,
				is_virtual: false,
				lastmod: None,
			},
		);
		candidates.push(Candidate {
			file,
			from_override,
		});
	}
	let resolved = kd_site::resolve_conflicts(candidates, config.pages.output_path_conflict)
		.map_err(|e| e.message)?;
	let mut pages: Vec<Page> = resolved
		.files
		.iter()
		.filter_map(|f| pages_by_input.remove(&f.input_path))
		.collect();

	// A page whose output path is the path of any source file would be built
	// over that source. The config check covers equal directories; this covers
	// per-page overrides (`path: "/other-page.html"` onto a real input).
	let inputs: std::collections::HashSet<&str> =
		pages.iter().map(|p| p.file.input_path.as_str()).collect();
	if let Some(page) = pages
		.iter()
		.find(|p| inputs.contains(p.file.output_path.as_str()))
	{
		return Err(format!(
			"{}: its output path {} is also a source file; the build would overwrite it",
			page.file.input_path, page.file.output_path
		));
	}

	if let Some(path) = &config.pages.overrides {
		let text = fs::read_to_string(path)
			.map_err(|e| format!("cannot read pages.overrides {path}: {e}"))?;
		let overrides = Overrides::parse(&text).map_err(|e| format!("{path}: {e}"))?;
		for url in &overrides.order {
			let o = &overrides.by_url[url];
			match pages.iter_mut().find(|p| p.file.url == *url) {
				Some(page) => {
					page.meta = kd_site::meta::merge(&[&page.meta, &o.meta]);
					page.lastmod = o.lastmod.clone();
				}
				None if o.is_virtual => {
					let rel = kd_site::url_to_local_path(url, &config.pages.output_extension);
					let file = kd_site::page_file(
						&format!("{}/{rel}", config.dir.input.trim_end_matches('/')),
						&dirs,
					);
					pages.push(Page {
						file,
						kind: PageKind::Html,
						meta: o.meta.clone(),
						body: None,
						deps: BTreeMap::new(),
						is_virtual: true,
						lastmod: o.lastmod.clone(),
					});
				}
				None => {
					return Err(format!(
						"{path}: {url:?} does not match any page; add \"virtual\": true to declare a page without an input file"
					));
				}
			}
		}
	}
	Ok(Plan {
		pages,
		warnings: resolved.warnings,
	})
}

/// Build-time switches (CLI flags). `None` / `false` means "use the config".
#[derive(Debug, Clone, Default, PartialEq)]
pub struct BuildOptions {
	pub incremental: bool,
	/// Ignore the manifest's cached entries (new ones are still recorded).
	pub force: bool,
	pub skip_unchanged: bool,
	/// Only build pages whose input path (relative to the input dir) matches.
	pub targets: Vec<String>,
	/// Thread count override.
	pub jobs: Option<usize>,
	/// Cache directory override.
	pub cache_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
	Built,
	/// Skipped by the incremental manifest.
	Cached,
	/// Compiled, but the output already had these bytes (`skipUnchanged`).
	Unchanged,
	/// Excluded by `targets`.
	Skipped,
	/// Virtual page: nothing to write.
	Virtual,
}

impl Status {
	#[must_use]
	pub fn as_str(self) -> &'static str {
		match self {
			Status::Built => "built",
			Status::Cached => "cached",
			Status::Unchanged => "unchanged",
			Status::Skipped => "skipped",
			Status::Virtual => "virtual",
		}
	}
}

#[derive(Debug, Clone, PartialEq)]
pub struct PageResult {
	pub url: String,
	pub input_path: String,
	pub output_path: String,
	pub status: Status,
	pub meta: Meta,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
	pub pages: Vec<PageResult>,
	pub warnings: Vec<String>,
	pub elapsed_ms: u128,
}

impl Report {
	/// JSON for `build.report` and for the CLI.
	#[must_use]
	pub fn to_json(&self) -> String {
		let pages = self
			.pages
			.iter()
			.map(|p| {
				Value::Object(vec![
					("url".to_string(), Value::String(p.url.clone())),
					("inputPath".to_string(), Value::String(p.input_path.clone())),
					(
						"outputPath".to_string(),
						Value::String(p.output_path.clone()),
					),
					(
						"status".to_string(),
						Value::String(p.status.as_str().to_string()),
					),
					("meta".to_string(), Value::Object(p.meta.clone())),
				])
			})
			.collect();
		Value::Object(vec![
			("version".to_string(), Value::Number(1.0)),
			("pages".to_string(), Value::Array(pages)),
			(
				"warnings".to_string(),
				Value::Array(
					self.warnings
						.iter()
						.map(|w| Value::String(w.clone()))
						.collect(),
				),
			),
			(
				"elapsedMs".to_string(),
				Value::Number(self.elapsed_ms as f64),
			),
		])
		.to_json()
	}
}

/// Produces the bytes for one page. `.html` pages are their body as is.
/// `.tsx` pages are components that only a JavaScript renderer can run, and
/// this crate has none, so such a page is an error rather than being written
/// out as unrendered source.
fn produce(page: &Page) -> Result<Vec<u8>, String> {
	match page.kind {
		PageKind::Html => Ok(page.body.clone().unwrap_or_default().into_bytes()),
		PageKind::Tsx => Err(format!(
			"{}: JSX pages need a JavaScript renderer, which this build does not have",
			page.file.input_path
		)),
	}
}

fn write_output(path: &str, bytes: &[u8], skip_unchanged: bool) -> Result<Status, String> {
	if skip_unchanged
		&& let Ok(meta) = fs::metadata(path)
		&& meta.len() == bytes.len() as u64
		&& fs::read(path)
			.map(|existing| existing == bytes)
			.unwrap_or(false)
	{
		return Ok(Status::Unchanged);
	}
	if let Some(parent) = std::path::Path::new(path).parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
	}
	fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"))?;
	Ok(Status::Built)
}

type Outcome = Result<(PageResult, Option<kd_build::Entry>), String>;

/// State shared by the pool jobs of one build.
struct Shared {
	plan: Plan,
	previous: kd_build::Manifest,
	fingerprinter: kd_build::Fingerprinter,
	env: String,
	targets: Vec<kd_glob::Pattern>,
	input_dir: String,
	skip_unchanged: bool,
	results: Mutex<Vec<Option<Outcome>>>,
}

fn build_one(shared: &Shared, i: usize) -> Outcome {
	let page = &shared.plan.pages[i];
	let result = |status| PageResult {
		url: page.file.url.clone(),
		input_path: page.file.input_path.clone(),
		output_path: page.file.output_path.clone(),
		status,
		meta: page.meta.clone(),
	};
	if page.is_virtual {
		return Ok((result(Status::Virtual), None));
	}
	let rel = kd_site::path::relative(&shared.input_dir, &page.file.input_path);
	if !shared.targets.is_empty() && !shared.targets.iter().any(|t| t.matches(&rel)) {
		return Ok((result(Status::Skipped), None));
	}
	if let Some(entry) = shared.previous.entries.get(&page.file.output_path)
		&& let kd_build::Verdict::UpToDate(refreshed) = kd_build::check(
			entry,
			&page.file.output_path,
			&page.file.input_path,
			&shared.env,
			&shared.fingerprinter,
		) {
		return Ok((result(Status::Cached), Some(refreshed)));
	}
	let bytes = produce(page)?;
	let status = write_output(&page.file.output_path, &bytes, shared.skip_unchanged)?;
	// The fingerprints were taken when the bytes were read, so an edit made
	// after that is detected by the next build instead of being recorded as if
	// the output had been built from it.
	let entry = kd_build::Entry {
		input_path: page.file.input_path.clone(),
		env: shared.env.clone(),
		output_size: bytes.len() as u64,
		deps: page.deps.clone(),
	};
	Ok((result(status), Some(entry)))
}

/// Runs a build and returns the report. Any page error aborts the build.
///
/// # Example
///
/// ```no_run
/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
/// let report = kd_core::build(&loaded, &kd_core::BuildOptions::default()).unwrap();
/// println!("{} pages", report.pages.len());
/// ```
pub fn build(loaded: &Loaded, options: &BuildOptions) -> Result<Report, String> {
	let started = Instant::now();
	let config = &loaded.config;
	let plan = plan(config)?;
	let targets = compile_globs(&options.targets)?;
	let env = kd_hash::to_hex(&kd_hash::sha256(
		format!("{VERSION}\0{}\0html-passthrough", loaded.config_hash).as_bytes(),
	));

	let cache_dir = kd_build::cache_dir(
		&config.root_dir,
		options
			.cache_dir
			.as_deref()
			.or(config.build.cache_dir.as_deref()),
	);
	let manifest_path = kd_build::manifest_path(&cache_dir);
	let incremental = options.incremental || config.build.incremental;
	// The on-disk manifest is read whenever the build is incremental, even with
	// `force`: a forced partial build must still carry over the entries of the
	// pages it did not touch. `force` only stops them from being *used* to skip.
	let on_disk = if incremental {
		kd_build::Manifest::load(&manifest_path).unwrap_or_default()
	} else {
		kd_build::Manifest::default()
	};
	let previous = if options.force {
		kd_build::Manifest::default()
	} else {
		on_disk.clone()
	};

	let jobs = options.jobs.unwrap_or(match config.build.jobs {
		kd_config::Jobs::Auto => std::thread::available_parallelism()
			.map(|n| n.get())
			.unwrap_or(1),
		kd_config::Jobs::Count(n) => n,
	});

	// Largest first (LPT): the slow tail of the build stays short.
	let mut order: Vec<usize> = (0..plan.pages.len()).collect();
	order.sort_by_key(|&i| std::cmp::Reverse(plan.pages[i].body.as_ref().map_or(0, String::len)));
	let page_count = plan.pages.len();

	let shared = Arc::new(Shared {
		plan,
		previous,
		fingerprinter: kd_build::Fingerprinter::new(),
		env,
		targets,
		input_dir: config.dir.input.clone(),
		skip_unchanged: options.skip_unchanged || config.build.skip_unchanged,
		results: Mutex::new((0..page_count).map(|_| None).collect()),
	});
	let pool = kd_pool::Pool::new(jobs);
	pool.scope(|s| {
		for i in order {
			let shared = Arc::clone(&shared);
			s.spawn(move || {
				let outcome = build_one(&shared, i);
				shared.results.lock().unwrap_or_else(|e| e.into_inner())[i] = Some(outcome);
			});
		}
	});
	drop(pool);
	let shared = Arc::try_unwrap(shared)
		.ok()
		.expect("all jobs finished with the pool");
	let results = shared
		.results
		.into_inner()
		.unwrap_or_else(|e| e.into_inner());

	let mut report = Report {
		pages: Vec::with_capacity(page_count),
		warnings: shared.plan.warnings.clone(),
		elapsed_ms: 0,
	};
	// A partial build (targets) keeps the entries it did not touch.
	let mut next = if shared.targets.is_empty() {
		kd_build::Manifest::default()
	} else {
		on_disk
	};
	for outcome in results.into_iter().flatten() {
		let (result, entry) = outcome?;
		if let Some(entry) = entry {
			next.entries.insert(result.output_path.clone(), entry);
		}
		report.pages.push(result);
	}
	if incremental {
		next.save(&manifest_path)
			.map_err(|e| format!("cannot write {manifest_path}: {e}"))?;
	}
	report.elapsed_ms = started.elapsed().as_millis();
	if let Some(path) = &config.build.report {
		if let Some(parent) = std::path::Path::new(path).parent() {
			fs::create_dir_all(parent)
				.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
		}
		fs::write(path, report.to_json()).map_err(|e| format!("cannot write {path}: {e}"))?;
	}
	Ok(report)
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Site {
		root: String,
	}

	impl Site {
		fn new(name: &str) -> Site {
			let dir = std::env::temp_dir().join(format!("kd_core_{name}_{}", std::process::id()));
			let _ = fs::remove_dir_all(&dir);
			fs::create_dir_all(dir.join("src")).unwrap();
			Site {
				root: dir.to_string_lossy().to_string(),
			}
		}

		fn write(&self, rel: &str, content: &str) -> String {
			let p = format!("{}/{rel}", self.root);
			fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
			fs::write(&p, content).unwrap();
			p
		}

		fn config(&self, extra: &str) -> Loaded {
			let text = format!(
				r#"{{ "dir": {{ "input": "src", "output": "out" }}, "build": {{ "cacheDir": ".cache" }}{extra} }}"#
			);
			self.config_raw(&text)
		}

		fn config_raw(&self, text: &str) -> Loaded {
			let path = self.write("kamado.config.jsonc", text);
			load(&path).unwrap()
		}

		fn read(&self, rel: &str) -> String {
			fs::read_to_string(format!("{}/{rel}", self.root)).unwrap()
		}
	}

	impl Drop for Site {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn statuses(report: &Report) -> Vec<(&str, &str)> {
		report
			.pages
			.iter()
			.map(|p| (p.url.as_str(), p.status.as_str()))
			.collect()
	}

	#[test]
	fn load_reads_config_and_package_json() {
		let site = Site::new("load");
		site.write(
			"package.json",
			r#"{ "name": "s", "production": { "host": "example.com" } }"#,
		);
		let loaded = site.config("");
		assert_eq!(loaded.config.root_dir, site.root);
		assert_eq!(loaded.config.dir.input, format!("{}/src", site.root));
		assert_eq!(loaded.config.site.host.as_deref(), Some("example.com"));
		assert_eq!(loaded.config_hash.len(), 64);
		assert!(
			load(&format!("{}/missing.jsonc", site.root))
				.unwrap_err()
				.starts_with("cannot read config")
		);
		site.write("bad.jsonc", r#"{ "nope": 1 }"#);
		assert!(
			load(&format!("{}/bad.jsonc", site.root))
				.unwrap_err()
				.contains("nope: unknown option")
		);
	}

	#[test]
	fn plan_merges_front_matter_sidecar_and_overrides() {
		let site = Site::new("plan");
		site.write(
			"src/index.html",
			"---\ntitle: Home\nlayout: top\n---\n<h1>Home</h1>\n",
		);
		site.write("src/about/index.html", "<p>about</p>");
		site.write(
			"src/about/index.json",
			r#"{ "title": "About", "layout": "sub" }"#,
		);
		site.write(
			"pages.json",
			r#"{ "version": 1, "pages": [
				{ "url": "/about/", "meta": { "title": "About (override)" }, "lastmod": "2026-01-02" },
				{ "url": "/service/", "virtual": true, "meta": { "title": "Service" } }
			] }"#,
		);
		let loaded = site.config(r#", "pages": { "overrides": "pages.json" }"#);
		let plan = plan(&loaded.config).unwrap();
		let urls: Vec<&str> = plan.pages.iter().map(|p| p.file.url.as_str()).collect();
		assert_eq!(urls, ["/about/", "/", "/service/"]);

		let home = plan.pages.iter().find(|p| p.file.url == "/").unwrap();
		assert_eq!(
			Value::Object(home.meta.clone()).to_json(),
			r#"{"title":"Home","layout":"top"}"#
		);
		assert_eq!(home.body.as_deref(), Some("<h1>Home</h1>\n"));
		assert_eq!(home.kind, PageKind::Html);

		let about = plan.pages.iter().find(|p| p.file.url == "/about/").unwrap();
		assert_eq!(
			Value::Object(about.meta.clone()).to_json(),
			r#"{"title":"About (override)","layout":"sub"}"#
		);
		assert_eq!(about.lastmod.as_deref(), Some("2026-01-02"));
		// Both the page and its (existing) sidecar are dependencies.
		let dep_paths: Vec<&str> = about.deps.keys().map(String::as_str).collect();
		assert_eq!(
			dep_paths,
			[
				format!("{}/src/about/index.html", site.root),
				format!("{}/src/about/index.json", site.root)
			]
		);
		assert!(about.deps.values().all(|d| d.hash.len() == 64));

		let service = plan
			.pages
			.iter()
			.find(|p| p.file.url == "/service/")
			.unwrap();
		assert!(service.is_virtual);
		assert_eq!(
			service.file.output_path,
			format!("{}/out/service/index.html", site.root)
		);
		assert!(plan.warnings.is_empty());
	}

	#[test]
	fn plan_applies_output_path_field_and_reports_conflicts() {
		let site = Site::new("override");
		site.write(
			"src/100.html",
			"---\npath: \"/legacy/a.html\"\n---\n<p>a</p>",
		);
		site.write(
			"src/200.html",
			"---\npath: \"/legacy/a.html\"\n---\n<p>b</p>",
		);
		site.write("src/300.html", "---\npath: \"/x/\"\n---\n<p>c</p>");
		let loaded = site.config(r#", "pages": { "outputPathField": "path" }"#);
		let plan = plan(&loaded.config).unwrap();
		let outputs: Vec<&str> = plan.pages.iter().map(|p| p.file.url.as_str()).collect();
		assert_eq!(outputs, ["/legacy/a.html", "/x/"]);
		// Both inputs override to the same path: the first one seen wins and its
		// body (not the loser's) is what gets built.
		assert_eq!(
			plan.pages[0].file.input_path,
			format!("{}/src/100.html", site.root)
		);
		assert_eq!(plan.pages[0].body.as_deref(), Some("<p>a</p>"));
		assert_eq!(plan.warnings.len(), 1);
		assert!(plan.warnings[0].starts_with("Output path collision"));

		let loaded = site
			.config(r#", "pages": { "outputPathField": "path", "outputPathConflict": "error" }"#);
		assert!(
			super::plan(&loaded.config)
				.unwrap_err()
				.starts_with("Output path collision")
		);
	}

	#[test]
	fn plan_errors_are_specific() {
		let site = Site::new("errors");
		site.write("src/a.html", "---\ntitle: [unclosed\n---\n");
		let loaded = site.config("");
		assert!(super::plan(&loaded.config).unwrap_err().contains("a.html:"));

		let site = Site::new("errors2");
		site.write("src/a.html", "<p/>");
		site.write("src/a.json", "{ broken");
		let loaded = site.config("");
		assert!(
			super::plan(&loaded.config)
				.unwrap_err()
				.contains("a.json:1:")
		);

		let site = Site::new("errors3");
		site.write("src/a.html", "<p/>");
		site.write(
			"pages.json",
			r#"{ "version": 1, "pages": [ { "url": "/nope/" } ] }"#,
		);
		let loaded = site.config(r#", "pages": { "overrides": "pages.json" }"#);
		assert!(
			super::plan(&loaded.config)
				.unwrap_err()
				.contains("does not match any page")
		);
	}

	#[test]
	fn build_writes_html_bodies_and_reports() {
		let site = Site::new("build");
		site.write("src/index.html", "---\ntitle: Home\n---\n<h1>Home</h1>\n");
		site.write("src/news/2026.html", "<p>news</p>");
		site.write("src/_includes/h.html", "<header/>");
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "ignore": ["_includes/**"] }, "build": { "cacheDir": ".cache", "report": "report.json" } }"#,
		);
		let report = build(
			&loaded,
			&BuildOptions {
				jobs: Some(2),
				..Default::default()
			},
		)
		.unwrap();
		assert_eq!(
			statuses(&report),
			[("/", "built"), ("/news/2026.html", "built")]
		);
		assert_eq!(site.read("out/index.html"), "<h1>Home</h1>\n");
		assert_eq!(site.read("out/news/2026.html"), "<p>news</p>");
		assert!(!std::path::Path::new(&format!("{}/out/_includes/h.html", site.root)).exists());
		let written = site.read("report.json");
		assert!(written.contains(r#""status":"built""#));
		assert!(written.contains(r#""meta":{"title":"Home"}"#));
	}

	#[test]
	fn incremental_build_caches_unchanged_pages_and_rebuilds_changed_ones() {
		let site = Site::new("incremental");
		let a = site.write("src/a.html", "<p>a</p>");
		site.write("src/b.html", "<p>b</p>");
		let loaded = site.config("");
		let opts = BuildOptions {
			incremental: true,
			jobs: Some(2),
			..Default::default()
		};
		let first = build(&loaded, &opts).unwrap();
		assert_eq!(
			statuses(&first),
			[("/a.html", "built"), ("/b.html", "built")]
		);

		let second = build(&loaded, &opts).unwrap();
		assert_eq!(
			statuses(&second),
			[("/a.html", "cached"), ("/b.html", "cached")]
		);

		std::thread::sleep(std::time::Duration::from_millis(20));
		fs::write(&a, "<p>A</p>").unwrap();
		let third = build(&loaded, &opts).unwrap();
		assert_eq!(
			statuses(&third),
			[("/a.html", "built"), ("/b.html", "cached")]
		);
		assert_eq!(site.read("out/a.html"), "<p>A</p>");

		// A sidecar appearing later invalidates the page (it was a missing dependency).
		site.write("src/b.json", r#"{ "title": "B" }"#);
		let fourth = build(&loaded, &opts).unwrap();
		assert_eq!(
			statuses(&fourth),
			[("/a.html", "cached"), ("/b.html", "built")]
		);

		// Force ignores the cache.
		let forced = build(
			&loaded,
			&BuildOptions {
				force: true,
				..opts.clone()
			},
		)
		.unwrap();
		assert_eq!(
			statuses(&forced),
			[("/a.html", "built"), ("/b.html", "built")]
		);

		// A changed config changes the environment digest.
		let loaded2 = site.config(r#", "html": { "doctype": false }"#);
		let fifth = build(&loaded2, &opts).unwrap();
		assert_eq!(
			statuses(&fifth),
			[("/a.html", "built"), ("/b.html", "built")]
		);
	}

	#[test]
	fn an_output_directory_inside_the_input_directory_is_not_a_source() {
		let site = Site::new("nested_out");
		site.write("a.html", "<p>a</p>");
		site.write("sub/b.html", "<p>b</p>");
		let loaded = site.config_raw(
			r#"{ "dir": { "input": ".", "output": "htdocs" }, "build": { "cacheDir": ".cache" } }"#,
		);
		let opts = BuildOptions {
			jobs: Some(1),
			..Default::default()
		};
		assert_eq!(
			statuses(&build(&loaded, &opts).unwrap()),
			[("/a.html", "built"), ("/sub/b.html", "built")]
		);
		// The second build must not treat htdocs/*.html as pages.
		assert_eq!(
			statuses(&build(&loaded, &opts).unwrap()),
			[("/a.html", "built"), ("/sub/b.html", "built")]
		);
		assert!(!std::path::Path::new(&format!("{}/htdocs/htdocs", site.root)).exists());
		assert_eq!(site.read("htdocs/a.html"), "<p>a</p>");
	}

	#[test]
	fn an_override_that_points_at_a_source_file_is_refused() {
		let site = Site::new("clobber");
		site.write("src/a.html", "---\npath: \"/src/b.html\"\n---\n<p>a</p>");
		site.write("src/b.html", "<p>b</p>");
		// Output dir `.` makes `/src/b.html` the real source file of page b.
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "outputPathField": "path" } }"#,
		);
		// Inside the normal layout the override resolves under out/, so it is fine...
		assert!(plan(&loaded.config).is_ok());
		// ...but when the output directory is the parent of the sources it is not.
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "." }, "pages": { "outputPathField": "path" } }"#,
		);
		let err = plan(&loaded.config).unwrap_err();
		assert!(
			err.contains("is also a source file; the build would overwrite it"),
			"{err}"
		);
	}

	#[test]
	fn a_source_edited_after_it_was_read_is_rebuilt_not_recorded_as_current() {
		let site = Site::new("race");
		let a = site.write("src/a.html", "<p>old</p>");
		let loaded = site.config("");
		let planned = plan(&loaded.config).unwrap();
		// The edit lands after planning (the read) and before the page is built.
		std::thread::sleep(std::time::Duration::from_millis(20));
		fs::write(&a, "<p>new!</p>").unwrap();

		let page = &planned.pages[0];
		let current = kd_build::Fingerprinter::new().fingerprint(&a);
		assert_ne!(
			page.deps[&a].hash, current.hash,
			"plan fingerprinted the old bytes"
		);
		assert_eq!(page.body.as_deref(), Some("<p>old</p>"));

		// A real build after the edit sees the new bytes; the recorded entry
		// describes what was actually read.
		let opts = BuildOptions {
			incremental: true,
			jobs: Some(1),
			..Default::default()
		};
		build(&loaded, &opts).unwrap();
		assert_eq!(site.read("out/a.html"), "<p>new!</p>");
		assert_eq!(
			statuses(&build(&loaded, &opts).unwrap()),
			[("/a.html", "cached")]
		);
	}

	#[test]
	fn forced_partial_builds_keep_the_manifest_entries_of_untouched_pages() {
		let site = Site::new("force_targets");
		site.write("src/a.html", "<p>a</p>");
		site.write("src/sub/b.html", "<p>b</p>");
		let loaded = site.config("");
		let all = BuildOptions {
			incremental: true,
			jobs: Some(1),
			..Default::default()
		};
		build(&loaded, &all).unwrap();
		let forced_sub = BuildOptions {
			force: true,
			targets: vec!["sub/**".to_string()],
			..all.clone()
		};
		assert_eq!(
			statuses(&build(&loaded, &forced_sub).unwrap()),
			[("/a.html", "skipped"), ("/sub/b.html", "built")]
		);
		// `a` was not touched, so a later normal build still finds it cached.
		assert_eq!(
			statuses(&build(&loaded, &all).unwrap()),
			[("/a.html", "cached"), ("/sub/b.html", "cached")]
		);
	}

	#[test]
	fn negated_cli_targets_are_refused() {
		let site = Site::new("neg_targets");
		site.write("src/a.html", "<p>a</p>");
		let loaded = site.config("");
		let err = build(
			&loaded,
			&BuildOptions {
				targets: vec!["!a.html".to_string()],
				..Default::default()
			},
		)
		.unwrap_err();
		assert_eq!(err, "negated glob \"!a.html\" is not supported");
	}

	#[test]
	fn targets_limit_the_build_and_keep_other_manifest_entries() {
		let site = Site::new("targets");
		site.write("src/a.html", "<p>a</p>");
		site.write("src/sub/b.html", "<p>b</p>");
		let loaded = site.config("");
		let all = BuildOptions {
			incremental: true,
			jobs: Some(1),
			..Default::default()
		};
		build(&loaded, &all).unwrap();
		let only_sub = BuildOptions {
			targets: vec!["sub/**".to_string()],
			..all.clone()
		};
		let report = build(&loaded, &only_sub).unwrap();
		assert_eq!(
			statuses(&report),
			[("/a.html", "skipped"), ("/sub/b.html", "cached")]
		);
		// The full manifest survived the partial build.
		let after = build(&loaded, &all).unwrap();
		assert_eq!(
			statuses(&after),
			[("/a.html", "cached"), ("/sub/b.html", "cached")]
		);
	}

	#[test]
	fn skip_unchanged_leaves_identical_outputs_alone() {
		let site = Site::new("skip");
		site.write("src/a.html", "<p>a</p>");
		let loaded = site.config("");
		let opts = BuildOptions {
			skip_unchanged: true,
			jobs: Some(1),
			..Default::default()
		};
		assert_eq!(
			statuses(&build(&loaded, &opts).unwrap()),
			[("/a.html", "built")]
		);
		let before = fs::metadata(format!("{}/out/a.html", site.root))
			.unwrap()
			.modified()
			.unwrap();
		std::thread::sleep(std::time::Duration::from_millis(20));
		assert_eq!(
			statuses(&build(&loaded, &opts).unwrap()),
			[("/a.html", "unchanged")]
		);
		let after = fs::metadata(format!("{}/out/a.html", site.root))
			.unwrap()
			.modified()
			.unwrap();
		assert_eq!(before, after, "the file was not rewritten");
	}

	#[test]
	fn tsx_pages_are_an_error_because_this_crate_has_no_renderer() {
		let site = Site::new("tsx");
		site.write("src/page.tsx", "export default () => <p/>;");
		let loaded = site.config("");
		let err = build(
			&loaded,
			&BuildOptions {
				jobs: Some(1),
				..Default::default()
			},
		)
		.unwrap_err();
		assert!(err.contains("JSX pages need a JavaScript renderer"));
	}

	#[test]
	fn virtual_pages_are_reported_but_not_written() {
		let site = Site::new("virtual");
		site.write("src/a.html", "<p>a</p>");
		site.write(
			"pages.json",
			r#"{ "version": 1, "pages": [ { "url": "/v/", "virtual": true } ] }"#,
		);
		let loaded = site.config(r#", "pages": { "overrides": "pages.json" }"#);
		let report = build(
			&loaded,
			&BuildOptions {
				jobs: Some(1),
				..Default::default()
			},
		)
		.unwrap();
		assert_eq!(
			statuses(&report),
			[("/a.html", "built"), ("/v/", "virtual")]
		);
		assert!(!std::path::Path::new(&format!("{}/out/v/index.html", site.root)).exists());
	}
}
