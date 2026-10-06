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

pub mod assets;
pub mod banner;
mod data;
mod html;
mod jsx;
mod minifiers;
pub mod parallel;
mod plan_cache;
pub mod serve;
mod session;
mod sitemap;
pub mod sourcemap;
pub mod style;
pub mod style_import;

pub use session::{Prepared, RenderJob, ScriptOutput, build, prepare, write_report};

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
	// The resolved `site` is hashed with the text: `site.*` falls back to
	// package.json, so editing it there changes the output without the config
	// text changing. Other package.json fields (dependencies) do not reach the
	// output and must not rebuild everything.
	let mut hashed = text.into_bytes();
	hashed.extend_from_slice(format!("\0{:?}", config.site).as_bytes());
	Ok(Loaded {
		config,
		config_path,
		config_hash: kd_hash::to_hex(&kd_hash::sha256(&hashed)),
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
	/// The body was not read: the page came from the plan cache, and is read
	/// when the page has to be built (see `load_bodies`).
	pub body_pending: bool,
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
		PageKind::Tsx => {
			let is_ts = !input_path.ends_with(".jsx");
			let meta = match kd_js::extract_meta(&text, true, is_ts)
				.map_err(|e| format!("{input_path}:{e}"))?
			{
				Some(kd_js::Const::Object(members)) => members
					.into_iter()
					.map(|(k, v)| (k, const_to_value(v)))
					.collect(),
				Some(_) => {
					return Err(format!("{input_path}: `meta` must be an object"));
				}
				None => Vec::new(),
			};
			// The source is kept for the compiler, which would read the file a
			// second time (an open is the slowest thing a page costs on some
			// file systems); `prepare` hands it over and drops it.
			Ok((meta, Some(text), dep))
		}
	}
}

fn const_to_value(c: kd_js::Const) -> Value {
	match c {
		kd_js::Const::Null => Value::Null,
		kd_js::Const::Bool(b) => Value::Bool(b),
		kd_js::Const::Num(n) => Value::Number(n),
		kd_js::Const::Str(s) => Value::String(s),
		kd_js::Const::Array(items) => Value::Array(items.into_iter().map(const_to_value).collect()),
		kd_js::Const::Object(members) => Value::Object(
			members
				.into_iter()
				.map(|(k, v)| (k, const_to_value(v)))
				.collect(),
		),
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

/// What reading one page's files gave.
struct Read {
	kind: PageKind,
	in_file: Meta,
	body: Option<String>,
	input_dep: kd_build::Dep,
	side: Meta,
	sidecar: String,
	sidecar_dep: kd_build::Dep,
}

/// Reads the files of one page: the source and its sidecar. A page the cache
/// knows, whose files have the size and modification time it recorded, is not
/// read: what the cache holds stands for it, and its body is read later if it
/// is needed (`body_pending`).
fn read_files(
	input_path: &str,
	cached: Option<&plan_cache::CachedPage>,
) -> Result<(Read, bool), String> {
	let kind = page_kind(&kd_site::path::extname(input_path).to_ascii_lowercase())?;
	if let Some(c) = cached
		&& c.kind == kind
		&& c.sidecar == sidecar_path(input_path)
		&& same_stat(input_path, &c.input_dep)
		&& same_stat(&c.sidecar, &c.sidecar_dep)
	{
		return Ok((
			Read {
				kind,
				in_file: c.in_file.clone(),
				body: None,
				input_dep: c.input_dep.clone(),
				side: c.side.clone(),
				sidecar: c.sidecar.clone(),
				sidecar_dep: c.sidecar_dep.clone(),
			},
			true,
		));
	}
	let (in_file, body, input_dep) = read_page(input_path, kind)?;
	let sidecar = sidecar_path(input_path);
	let (side, sidecar_dep) = read_sidecar(&sidecar)?;
	Ok((
		Read {
			kind,
			in_file,
			body,
			input_dep,
			side,
			sidecar,
			sidecar_dep,
		},
		false,
	))
}

/// Whether `path` has the size and modification time that `dep` records (a
/// file that is missing matches the fingerprint of a missing file).
fn same_stat(path: &str, dep: &kd_build::Dep) -> bool {
	match kd_build::file_stat(path) {
		None => dep.hash == kd_build::MISSING_FILE_HASH,
		Some((size, sec, nsec)) => {
			dep.hash != kd_build::MISSING_FILE_HASH
				&& (size, sec, nsec) == (dep.size, dep.mtime_sec, dep.mtime_nsec)
		}
	}
}

/// Discovers pages, resolves their metadata and output locations, applies
/// conflicts and `pages.overrides`.
pub fn plan(config: &Config) -> Result<Plan, String> {
	plan_with(
		config,
		std::thread::available_parallelism().map_or(1, |n| n.get()),
	)
}

/// Like [`plan`], reading the page files on up to `threads` threads. Reading,
/// hashing and extracting the metadata of a file does not depend on any other
/// file, so it is the part of planning that scales with the page count.
pub fn plan_with(config: &Config, threads: usize) -> Result<Plan, String> {
	plan_cached(config, threads, None, None).map(|(plan, _)| plan)
}

/// What [`plan_cached`] learned about the page files, to be saved for the next
/// build, and whether it differs from what it was given.
pub(crate) struct Learned {
	pub cache: plan_cache::PlanCache,
	pub changed: bool,
}

/// Like [`plan_with`], taking the pages it can from `cache` instead of reading
/// them. Pages that came from the cache have `body_pending` set when their
/// body has not been read.
pub(crate) fn plan_cached(
	config: &Config,
	threads: usize,
	cache: Option<&plan_cache::PlanCache>,
	found: Option<Vec<String>>,
) -> Result<(Plan, Learned), String> {
	let dirs = Dirs {
		input_dir: &config.dir.input,
		output_dir: &config.dir.output,
		output_extension: &config.pages.output_extension,
	};
	let t_plan = std::time::Instant::now();
	let found = match found {
		Some(found) => found,
		None => {
			let files = compile_globs(&config.pages.files)?;
			let ignore = compile_globs(&config.pages.ignore)?;
			kd_site::discover(&config.dir.input, &files, &ignore)
				.map_err(|e| format!("cannot read input directory {}: {e}", config.dir.input))?
		}
	};
	if std::env::var_os("KD_TIMING").is_some() {
		eprintln!("    plan: discovered in {}ms", t_plan.elapsed().as_millis());
	}

	// An output directory inside the input directory (`input: "."`,
	// `output: "htdocs"`) is not a source: without this the next build would
	// discover its own output as pages and write it to `htdocs/htdocs/...`.
	let output_rel = kd_site::path::relative(&config.dir.input, &config.dir.output);
	let output_inside_input = !output_rel.is_empty() && !output_rel.starts_with("..");

	let input_paths: Vec<String> = found
		.into_iter()
		.filter(|rel| {
			!(output_inside_input
				&& (*rel == output_rel || rel.starts_with(&format!("{output_rel}/"))))
		})
		.map(|rel| format!("{}/{rel}", config.dir.input.trim_end_matches('/')))
		.collect();
	let reads = parallel::map(&input_paths, threads, |p| {
		read_files(p, cache.and_then(|c| c.pages.get(p)))
	});
	let mut learned = plan_cache::PlanCache::default();
	let all_hit = !reads.is_empty()
		&& cache.is_some_and(|c| c.pages.len() == reads.len())
		&& reads.iter().all(|r| matches!(r, Ok((_, true))));
	if std::env::var_os("KD_TIMING").is_some() {
		eprintln!(
			"    plan: read {} pages in {}ms",
			input_paths.len(),
			t_plan.elapsed().as_millis()
		);
	}
	let input_paths_len = input_paths.len();
	let mut misses = 0usize;

	let mut candidates = Vec::with_capacity(input_paths.len());
	// Keyed by input path: several inputs may claim one output path, and the
	// conflict policy decides which input survives.
	let mut pages_by_input: BTreeMap<String, Page> = BTreeMap::new();
	for (input_path, read) in input_paths.into_iter().zip(reads) {
		let (read, hit) = read?;
		if !hit {
			misses += 1;
		}
		// A page of the cache has its metadata but not its body.
		let body_pending = hit && read.kind == PageKind::Html;
		let Read {
			kind,
			in_file,
			body,
			input_dep,
			side,
			sidecar,
			sidecar_dep,
		} = read;
		// What is learned is only needed when it differs from the cache.
		if !all_hit {
			learned.pages.insert(
				input_path.clone(),
				plan_cache::CachedPage {
					kind,
					in_file: in_file.clone(),
					input_dep: input_dep.clone(),
					side: side.clone(),
					sidecar: sidecar.clone(),
					sidecar_dep: sidecar_dep.clone(),
				},
			);
		}
		let mut file = kd_site::page_file(&input_path, &dirs);
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
				body_pending,
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
	if std::env::var_os("KD_TIMING").is_some() {
		eprintln!(
			"    plan: assembled {} pages in {}ms",
			input_paths_len,
			t_plan.elapsed().as_millis()
		);
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
						body_pending: false,
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
	let changed =
		!all_hit && (misses > 0 || cache.is_none_or(|c| c.pages.len() != learned.pages.len()));
	Ok((
		Plan {
			pages,
			warnings: resolved.warnings,
		},
		Learned {
			cache: learned,
			changed,
		},
	))
}

/// Reads the bodies of the pages that came from the plan cache without one,
/// for the pages at `indices` (the ones that have to be built).
///
/// # Errors
///
/// A message for a file that cannot be read any more.
pub(crate) fn load_bodies(
	plan: &mut Plan,
	indices: &[usize],
	threads: usize,
) -> Result<(), String> {
	let wanted: Vec<usize> = indices
		.iter()
		.copied()
		.filter(|&i| plan.pages[i].body_pending)
		.collect();
	let read = parallel::map(&wanted, threads, |&i| {
		let page = &plan.pages[i];
		read_page(&page.file.input_path, page.kind)
	});
	for (i, read) in wanted.into_iter().zip(read) {
		let (_, body, dep) = read?;
		let page = &mut plan.pages[i];
		page.body = body;
		page.body_pending = false;
		page.deps.insert(page.file.input_path.clone(), dep);
	}
	Ok(())
}

/// The parsed `pages.overrides` file, if the config names one.
pub(crate) fn read_overrides(config: &Config) -> Result<Option<Overrides>, String> {
	let Some(path) = &config.pages.overrides else {
		return Ok(None);
	};
	let text =
		fs::read_to_string(path).map_err(|e| format!("cannot read pages.overrides {path}: {e}"))?;
	Overrides::parse(&text)
		.map(Some)
		.map_err(|e| format!("{path}: {e}"))
}

/// What one walk of the input directory found: the pages, the stylesheets and
/// the scripts, each as paths relative to the input directory.
pub(crate) struct Scan {
	pub pages: Vec<String>,
	pub styles: Vec<String>,
	pub scripts: Vec<String>,
}

/// Walks the input directory once for everything a build looks for.
///
/// # Errors
///
/// A message for an invalid glob or an input directory that cannot be read.
pub(crate) fn scan(config: &Config) -> Result<Scan, String> {
	let page_files = compile_globs(&config.pages.files)?;
	let page_ignore = compile_globs(&config.pages.ignore)?;
	let style_files = compile_globs(&config.styles.files)?;
	let style_ignore = compile_globs(&config.styles.ignore)?;
	let script_files = compile_globs(&config.scripts.files)?;
	let script_ignore = compile_globs(&config.scripts.ignore)?;
	let mut found = kd_site::discover_all(
		&config.dir.input,
		&[
			kd_site::Search {
				files: &page_files,
				ignore: &page_ignore,
			},
			kd_site::Search {
				files: &style_files,
				ignore: &style_ignore,
			},
			kd_site::Search {
				files: &script_files,
				ignore: &script_ignore,
			},
		],
	)
	.map_err(|e| format!("cannot read input directory {}: {e}", config.dir.input))?;
	let scripts = found.pop().unwrap_or_default();
	let styles = found.pop().unwrap_or_default();
	let pages = found.pop().unwrap_or_default();
	Ok(Scan {
		pages,
		styles,
		scripts,
	})
}

/// What a page's own files say now: its metadata (the file, its sidecar and
/// the override for its URL merged), its body, and the fingerprints of the
/// files that were read.
pub(crate) struct Reloaded {
	pub meta: Meta,
	pub body: Option<String>,
	pub deps: BTreeMap<String, kd_build::Dep>,
}

/// Reads a page again (the dev server does this when the page's files
/// changed). The output location is not recomputed: a change of the
/// `outputPathField` takes a restart.
///
/// # Errors
///
/// A message for an unreadable file, invalid front matter or sidecar, or a
/// `meta` that cannot be read without running the file.
pub(crate) fn reload_page(page: &Page, overrides: Option<&Overrides>) -> Result<Reloaded, String> {
	let input_path = &page.file.input_path;
	let (in_file, body, input_dep) = read_page(input_path, page.kind)?;
	let sidecar = sidecar_path(input_path);
	let (side, sidecar_dep) = read_sidecar(&sidecar)?;
	let mut meta = kd_site::meta::merge(&[&in_file, &side]);
	if let Some(o) = overrides.and_then(|o| o.by_url.get(&page.file.url)) {
		meta = kd_site::meta::merge(&[&meta, &o.meta]);
	}
	Ok(Reloaded {
		meta,
		body,
		deps: BTreeMap::from([(input_path.clone(), input_dep), (sidecar, sidecar_dep)]),
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
	/// The host's local time zone: local time minus UTC, in minutes. The
	/// banner's `{{date:...}}` is local time, and std has no time zones.
	pub tz_offset_minutes: i32,
	/// The version of the esbuild that builds the scripts; a different one
	/// rebuilds them, because its output may differ.
	pub esbuild_version: Option<String>,
	/// The esbuild executable that minifies inline scripts and event
	/// handlers; without one they are left as they are.
	pub esbuild_binary: Option<String>,
	/// A dev server is building: `onServer` source maps are written and the
	/// banner is the development warning.
	pub serving: bool,
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

/// A style or script that was built (or skipped).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AssetResult {
	pub kind: assets::AssetKind,
	pub input_path: String,
	pub output_path: String,
	pub status: Status,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Report {
	pub pages: Vec<PageResult>,
	pub assets: Vec<AssetResult>,
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
		let assets = self
			.assets
			.iter()
			.map(|a| {
				Value::Object(vec![
					(
						"kind".to_string(),
						Value::String(a.kind.as_str().to_string()),
					),
					("inputPath".to_string(), Value::String(a.input_path.clone())),
					(
						"outputPath".to_string(),
						Value::String(a.output_path.clone()),
					),
					(
						"status".to_string(),
						Value::String(a.status.as_str().to_string()),
					),
				])
			})
			.collect();
		Value::Object(vec![
			("version".to_string(), Value::Number(1.0)),
			("pages".to_string(), Value::Array(pages)),
			("assets".to_string(), Value::Array(assets)),
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

pub(crate) fn write_output(
	path: &str,
	bytes: &[u8],
	skip_unchanged: bool,
) -> Result<Status, String> {
	if skip_unchanged
		&& let Ok(meta) = fs::metadata(path)
		&& meta.len() == bytes.len() as u64
		&& fs::read(path)
			.map(|existing| existing == bytes)
			.unwrap_or(false)
	{
		return Ok(Status::Unchanged);
	}
	// Write first and make the directory only when it is missing: most files
	// go into a directory that the build made already, and `create_dir_all`
	// would stat every component of the path for each of them.
	if let Err(first) = fs::write(path, bytes) {
		if first.kind() != std::io::ErrorKind::NotFound {
			return Err(format!("cannot write {path}: {first}"));
		}
		if let Some(parent) = std::path::Path::new(path).parent() {
			fs::create_dir_all(parent)
				.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
		}
		fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"))?;
	}
	Ok(Status::Built)
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

		// The host comes from package.json, so it is part of the digest; the
		// fields that never reach the output are not.
		site.write(
			"package.json",
			r#"{ "name": "s", "production": { "host": "example.com" }, "dependencies": {} }"#,
		);
		assert_eq!(site.config("").config_hash, loaded.config_hash);
		site.write(
			"package.json",
			r#"{ "name": "s", "production": { "host": "other.test" } }"#,
		);
		assert_ne!(site.config("").config_hash, loaded.config_hash);
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
		assert_eq!(site.read("out/news/2026.html"), "<p>news</p>\n");
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
		assert_eq!(site.read("out/a.html"), "<p>A</p>\n");

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
		assert_eq!(site.read("htdocs/a.html"), "<p>a</p>\n");
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
		assert_eq!(site.read("out/a.html"), "<p>new!</p>\n");
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
		assert!(err.contains("JSX pages and layouts need a JavaScript renderer"));
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

	/// The whole HTML chain against v2 on random broken pages. Needs the
	/// corpus that `scripts/fuzz-html-chain.mjs` writes (see that script).
	#[test]
	#[ignore = "needs KD_CHAIN_DIR, a corpus written by scripts/fuzz-html-chain.mjs"]
	fn chain_matches_v2() {
		let dir =
			std::path::PathBuf::from(std::env::var("KD_CHAIN_DIR").expect("set KD_CHAIN_DIR"));
		let config = kd_config::parse(
			r#"{ "dir": { "input": "src", "output": "out" }, "html": { "onError": "error", "imageSizes": false } }"#,
			"/kd-chain-root",
			None,
		)
		.unwrap();
		let pipeline = html::Pipeline::compile(&config).unwrap();
		let mut names: Vec<String> = fs::read_dir(&dir)
			.unwrap()
			.map(|e| e.unwrap().file_name().into_string().unwrap())
			.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
			.collect();
		names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
		assert!(!names.is_empty(), "the corpus is empty");
		let (mut failures, mut shown) = (0, 0);
		for name in &names {
			let input = fs::read_to_string(dir.join(format!("{name}.in"))).unwrap();
			let expected = fs::read_to_string(dir.join(format!("{name}.out"))).unwrap();
			let actual = match pipeline.process(
				&html::PageInput {
					source: &input,
					url: "/x.html",
					input_path: "/kd-chain-root/x.html",
					phase: kd_html::inject::Phase::Build,
				},
				&kd_html::minify::NoMinification,
			) {
				Ok(out) => out.html,
				Err(_) => "__ERROR__".to_owned(),
			};
			if actual != expected {
				failures += 1;
				if shown < 5 {
					shown += 1;
					println!(
						"--- case {name}\n  input:\n{input}\n  expected:\n{expected}\n  actual:\n{actual}"
					);
				}
			}
		}
		assert_eq!(
			failures,
			0,
			"{failures} of {} cases differ from v2",
			names.len()
		);
	}

	fn prepare_incremental(loaded: &Loaded) -> Prepared {
		prepare(
			loaded,
			&BuildOptions {
				jobs: Some(1),
				incremental: true,
				..Default::default()
			},
			"file:///runtime.js",
		)
		.unwrap()
	}

	fn jsx_site(name: &str) -> (Site, Loaded) {
		let site = Site::new(name);
		site.write(
			"src/index.tsx",
			"import { Box } from './_lib/box';\nexport const meta = { title: 'Home', layout: 'main' } as const;\nexport default () => <Box />;\n",
		);
		site.write("src/_lib/box.tsx", "export const Box = () => <p>box</p>;\n");
		site.write(
			"src/about.html",
			"---\ntitle: About\nlayout: main\n---\n<p>about</p>\n",
		);
		site.write("src/plain.html", "<p>plain</p>\n");
		site.write(
			"layouts/main.tsx",
			"export default (p: any) => <html><body>{p.content}</body></html>;\n",
		);
		site.write("data/nav.json", "{ \"a\": 1 }");
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "ignore": ["_lib/**"], "layouts": { "dir": "layouts" } }, "data": { "dir": "data", "values": { "v": 2 } }, "build": { "cacheDir": ".cache", "incremental": true } }"#,
		);
		(site, loaded)
	}

	#[test]
	fn jsx_pages_and_pages_with_a_layout_become_render_jobs() {
		let (site, loaded) = jsx_site("jobs");
		let prepared = prepare_incremental(&loaded);
		let jobs: Vec<(&str, bool, bool)> = prepared
			.jobs()
			.iter()
			.map(|j| {
				(
					loaded_url(&prepared, j.page),
					j.main.is_some(),
					j.layout.is_some(),
				)
			})
			.collect();
		// `plain.html` has no layout and is not rendered by JavaScript.
		assert_eq!(jobs, [("/about.html", false, true), ("/", true, true)]);
		let compiled = format!("{}/node_modules/.cache/kamado-v3/jsx", site.root);
		assert!(fs::metadata(format!("{compiled}/src/index.tsx.mjs")).is_ok());
		assert!(fs::metadata(format!("{compiled}/src/_lib/box.tsx.mjs")).is_ok());
		assert!(fs::metadata(format!("{compiled}/layouts/main.tsx.mjs")).is_ok());

		let context = kd_jsonc::parse(prepared.context_json().unwrap()).unwrap();
		let pages = context.get("pages").and_then(|p| p.as_array()).unwrap();
		assert_eq!(pages.len(), 3);
		assert_eq!(
			context.get("data").unwrap().to_json(),
			r#"{"nav":{"a":1},"v":2}"#
		);
		let home = pages
			.iter()
			.find(|p| p.get("url").and_then(|u| u.as_str()) == Some("/"))
			.unwrap();
		assert_eq!(
			home.get("meta").unwrap().to_json(),
			r#"{"title":"Home","layout":"main"}"#
		);
	}

	fn loaded_url(prepared: &Prepared, page: usize) -> &str {
		prepared.page_url(page)
	}

	#[test]
	fn rendered_html_goes_through_the_html_stages_and_the_closure_is_recorded() {
		let (site, loaded) = jsx_site("finish");
		let prepared = prepare_incremental(&loaded);
		let rendered: Vec<(usize, String)> = prepared
			.jobs()
			.iter()
			.map(|j| (j.page, "<html><body><p>box</p></body></html>".to_owned()))
			.collect();
		let report = prepared.finish(rendered, Vec::new()).unwrap();
		assert_eq!(
			statuses(&report),
			[
				("/about.html", "built"),
				("/", "built"),
				("/plain.html", "built")
			]
		);
		assert!(
			site.read("out/index.html")
				.starts_with("<!DOCTYPE html>\n<html>")
		);
		assert_eq!(site.read("out/plain.html"), "<p>plain</p>\n");

		let cache = kd_build::cache_dir(&loaded.config.root_dir, Some(".cache"));
		let manifest = kd_build::Manifest::load(&kd_build::manifest_path(&cache)).unwrap();
		let entry = &manifest.entries[&format!("{}/out/index.html", site.root)];
		for file in ["src/index.tsx", "src/_lib/box.tsx", "layouts/main.tsx"] {
			assert!(
				entry.deps.contains_key(&format!("{}/{file}", site.root)),
				"{file} is a dependency"
			);
		}

		// Nothing changed: nothing to render.
		let again = prepare_incremental(&loaded);
		assert!(again.jobs().is_empty());
		let report = again.finish(Vec::new(), Vec::new()).unwrap();
		assert_eq!(
			statuses(&report),
			[
				("/about.html", "cached"),
				("/", "cached"),
				("/plain.html", "cached")
			]
		);
	}

	#[test]
	fn what_a_jsx_page_reads_rebuilds_it() {
		let (site, loaded) = jsx_site("invalidate");
		// Builds with a stand-in for the renderer; how many jobs there were.
		let rebuild = || {
			let prepared = prepare_incremental(&loaded);
			let count = prepared.jobs().len();
			let rendered = prepared
				.jobs()
				.iter()
				.map(|j| (j.page, "<p>x</p>".to_owned()))
				.collect();
			prepared.finish(rendered, Vec::new()).unwrap();
			count
		};
		let write = |rel: &str, text: &str| {
			site.write(rel, text);
			// Make sure the stat of the file differs even on a coarse clock.
			std::thread::sleep(std::time::Duration::from_millis(5));
		};
		// `index.tsx` and `about.html` (it names a layout).
		assert_eq!(rebuild(), 2);
		assert_eq!(rebuild(), 0);

		// An imported component: only the page that imports it.
		write(
			"src/_lib/box.tsx",
			"export const Box = () => <p>box 2</p>;\n",
		);
		assert_eq!(rebuild(), 1);
		assert_eq!(rebuild(), 0);

		// The layout: both pages that use it.
		write(
			"layouts/main.tsx",
			"export default (p: any) => <html><body><main>{p.content}</main></body></html>;\n",
		);
		assert_eq!(rebuild(), 2);

		// The data every page can read.
		write("data/nav.json", "{ \"a\": 2 }");
		assert_eq!(rebuild(), 2);

		// The metadata of any page (nav, breadcrumbs, titleList read it).
		write("src/plain.html", "---\ntitle: Plain\n---\n<p>plain</p>\n");
		assert_eq!(rebuild(), 2);

		// The body of a page that JavaScript does not render changes nothing else.
		write("src/plain.html", "---\ntitle: Plain\n---\n<p>plain 2</p>\n");
		assert_eq!(rebuild(), 0);
		assert_eq!(site.read("out/plain.html"), "<p>plain 2</p>\n");

		// An import resolved to `helper.ts`: a `helper.tsx` that appears later
		// takes precedence, so the page that imports it is built again.
		write("lib/helper.ts", "export const h: number = 1;\n");
		write(
			"src/index.tsx",
			"import { Box } from './_lib/box';\nimport { h } from '../lib/helper';\nexport const meta = { title: 'Home', layout: 'main' } as const;\nexport default () => <Box n={h} />;\n",
		);
		assert_eq!(rebuild(), 1);
		assert_eq!(rebuild(), 0);
		write("lib/helper.tsx", "export const h: number = 2;\n");
		assert_eq!(rebuild(), 1);
		assert_eq!(rebuild(), 0);
	}

	#[test]
	fn a_missing_layout_and_a_path_in_a_layout_name_are_errors() {
		let site = Site::new("layout-errors");
		site.write("src/a.html", "---\nlayout: nope\n---\n<p>a</p>\n");
		let loaded = site.config(r#", "pages": { "layouts": { "dir": "layouts" } }"#);
		let err = prepare_incremental_result(&loaded).unwrap_err();
		assert!(err.contains("layout \"nope\" not found"), "{err}");

		site.write("src/a.html", "---\nlayout: ../x\n---\n<p>a</p>\n");
		let err = prepare_incremental_result(&loaded).unwrap_err();
		assert!(err.contains("without a path"), "{err}");

		let site2 = Site::new("layout-none");
		site2.write("src/a.html", "---\nlayout: main\n---\n<p>a</p>\n");
		let loaded = site2.config("");
		let err = prepare_incremental_result(&loaded).unwrap_err();
		assert!(err.contains("pages.layouts.dir is not set"), "{err}");
	}

	fn script_site(name: &str) -> (Site, Loaded) {
		let site = Site::new(name);
		site.write("src/js/app.ts", "import './util';\n");
		site.write("src/js/util.ts", "export {};\n");
		site.write("src/index.html", "<p>x</p>");
		let loaded =
			site.config(r#", "scripts": { "banner": "rev. {{year}}", "ignore": ["**/util.ts"] }"#);
		(site, loaded)
	}

	fn prepare_scripts(loaded: &Loaded, esbuild: &str) -> Prepared {
		prepare(
			loaded,
			&BuildOptions {
				jobs: Some(1),
				incremental: true,
				esbuild_version: Some(esbuild.to_owned()),
				..Default::default()
			},
			"file:///runtime.js",
		)
		.unwrap()
	}

	fn bundled(site: &Site, code: &str) -> Vec<ScriptOutput> {
		vec![ScriptOutput {
			id: 0,
			code: code.to_owned(),
			inputs: vec![
				format!("{}/src/js/app.ts", site.root),
				format!("{}/src/js/util.ts", site.root),
			],
		}]
	}

	#[test]
	fn scripts_are_requested_from_esbuild_and_written_from_its_answer() {
		let (site, loaded) = script_site("scripts-flow");
		let prepared = prepare_scripts(&loaded, "0.1.0");
		let request = kd_jsonc::parse(prepared.script_request_json().unwrap()).unwrap();
		let entries = request.get("entries").and_then(|e| e.as_array()).unwrap();
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].get("id").and_then(|i| i.as_f64()), Some(0.0));
		assert!(
			entries[0]
				.get("input")
				.and_then(|i| i.as_str())
				.unwrap()
				.ends_with("/src/js/app.ts")
		);
		assert!(
			entries[0]
				.get("output")
				.and_then(|i| i.as_str())
				.unwrap()
				.ends_with("/out/js/app.js")
		);
		let options = request.get("options").unwrap();
		assert_eq!(
			options.get("target").and_then(|t| t.as_str()),
			Some("es2022")
		);
		assert_eq!(options.get("sourcemap"), Some(&Value::Bool(false)));
		let banner = options.get("banner").and_then(|b| b.as_str()).unwrap();
		assert!(
			banner.starts_with("/*\nrev. 20") && banner.ends_with("\n*/"),
			"{banner}"
		);

		let report = prepared
			.finish(Vec::new(), bundled(&site, "console.log(1);\n"))
			.unwrap();
		assert_eq!(report.assets.len(), 1);
		assert_eq!(report.assets[0].kind, assets::AssetKind::Script);
		assert_eq!(report.assets[0].status, Status::Built);
		assert_eq!(site.read("out/js/app.js"), "console.log(1);\n");
		assert!(report.to_json().contains(r#""kind":"script""#));
	}

	#[test]
	fn a_script_is_rebuilt_when_an_input_or_esbuild_or_the_config_changes() {
		let (site, loaded) = script_site("scripts-incremental");
		let first = prepare_scripts(&loaded, "0.1.0");
		first
			.finish(Vec::new(), bundled(&site, "console.log(1);\n"))
			.unwrap();

		// Nothing changed: no request, the entry is reused.
		let again = prepare_scripts(&loaded, "0.1.0");
		assert!(again.script_request_json().is_none());
		let report = again.finish(Vec::new(), Vec::new()).unwrap();
		assert_eq!(report.assets[0].status, Status::Cached);
		assert_eq!(site.read("out/js/app.js"), "console.log(1);\n");

		// A file the bundle read (not the entry) changed.
		site.write("src/js/util.ts", "export const changed = 1;\n");
		let edited = prepare_scripts(&loaded, "0.1.0");
		assert!(edited.script_request_json().is_some());
		edited
			.finish(Vec::new(), bundled(&site, "console.log(2);\n"))
			.unwrap();
		assert!(
			prepare_scripts(&loaded, "0.1.0")
				.script_request_json()
				.is_none()
		);

		// Another esbuild may print other bytes.
		assert!(
			prepare_scripts(&loaded, "0.2.0")
				.script_request_json()
				.is_some()
		);

		// Another config (here the banner) is another environment.
		let other =
			site.config(r#", "scripts": { "banner": "rev. changed", "ignore": ["**/util.ts"] }"#);
		assert!(
			prepare_scripts(&other, "0.1.0")
				.script_request_json()
				.is_some()
		);
	}

	#[test]
	fn an_input_edited_while_the_build_ran_is_not_recorded_as_current() {
		let (site, loaded) = script_site("scripts-race");
		let prepared = prepare_scripts(&loaded, "0.1.0");
		assert!(prepared.script_request_json().is_some());
		// esbuild read `util.ts`, then the author saved it again.
		site.write("src/js/util.ts", "export const late = 1;\n");
		prepared
			.finish(Vec::new(), bundled(&site, "console.log(1);\n"))
			.unwrap();
		assert!(
			prepare_scripts(&loaded, "0.1.0")
				.script_request_json()
				.is_some(),
			"the next build must build it again"
		);
	}

	#[test]
	fn a_missing_script_output_and_scripts_without_esbuild_are_errors() {
		let (_site, loaded) = script_site("scripts-errors");
		let prepared = prepare_scripts(&loaded, "0.1.0");
		let e = prepared.finish(Vec::new(), Vec::new()).unwrap_err();
		assert!(
			e.ends_with("src/js/app.ts: the script was not built"),
			"{e}"
		);

		let prepared = prepare_scripts(&loaded, "0.1.0");
		let unknown = vec![ScriptOutput {
			id: 9,
			code: String::new(),
			inputs: Vec::new(),
		}];
		let e = prepared.finish(Vec::new(), unknown).unwrap_err();
		assert_eq!(e, "a script output for 9, which does not exist");

		let e = build(&loaded, &BuildOptions::default()).unwrap_err();
		assert!(e.starts_with("scripts need esbuild"), "{e}");
	}

	#[test]
	fn a_script_may_not_be_written_over_a_page() {
		let site = Site::new("scripts-vs-page");
		site.write("src/a.html", "<p>a</p>");
		site.write("src/a.ts", "export {};\n");
		let loaded = site.config(r#", "pages": { "outputExtension": ".js" }"#);
		let e = prepare(&loaded, &BuildOptions::default(), "file:///runtime.js").unwrap_err();
		assert!(e.contains("is also the output of a page"), "{e}");
	}

	#[test]
	fn code_inside_pages_is_minified_by_esbuild_and_left_alone_without_it() {
		let site = Site::new("inline-code");
		site.write(
			"src/index.html",
			"<p onclick=\"go( 1 ); return false;\">x</p>\n<script>\n  // note\n  window.a  =  1;\n</script>\n",
		);
		let loaded = site.config(r#", "html": { "minify": { "js": true } }"#);
		let run = |version: &str, binary: Option<String>| {
			let prepared = prepare(
				&loaded,
				&BuildOptions {
					jobs: Some(1),
					esbuild_version: Some(version.to_owned()),
					esbuild_binary: binary,
					..Default::default()
				},
				"file:///runtime.js",
			)
			.unwrap();
			prepared.finish(Vec::new(), Vec::new()).unwrap();
			site.read("out/index.html")
		};
		let minified = run("1", Some(minifiers::esbuild_for_tests()));
		assert!(
			minified.contains("<script>window.a=1;</script>"),
			"{minified}"
		);
		assert!(
			minified.contains(r#"onclick="return go(1),!1""#),
			"{minified}"
		);

		// Without esbuild the same page is built, with its code as it was.
		let plain = run("2", None);
		assert!(plain.contains("window.a  =  1;"), "{plain}");
	}

	fn style_site(name: &str) -> (Site, Loaded) {
		let site = Site::new(name);
		site.write("src/index.html", "<p>x</p>");
		site.write("src/css/base.css", "a { color : white }\n");
		site.write(
			"src/css/main.css",
			"@import 'base.css';\nb { margin : 0px 0px }\n",
		);
		let loaded = site.config(r#", "styles": { "banner": "rev. {{year}}" }"#);
		(site, loaded)
	}

	#[test]
	fn stylesheets_are_bundled_minified_and_written_by_the_core() {
		let (site, loaded) = style_site("styles-build");
		let report = build(&loaded, &BuildOptions::default()).unwrap();

		let outputs: Vec<(&str, &str)> = report
			.assets
			.iter()
			.map(|a| (a.kind.as_str(), a.status.as_str()))
			.collect();
		assert_eq!(outputs, [("style", "built"), ("style", "built")]);
		let main = site.read("out/css/main.css");
		assert!(main.starts_with("/*!\nrev. 20"), "{main}");
		assert!(main.ends_with("*/a{color:#fff}b{margin:0}"), "{main}");
		assert_eq!(
			site.read("out/css/base.css").rsplit("*/").next().unwrap(),
			"a{color:#fff}"
		);
	}

	#[test]
	fn a_stylesheet_is_rebuilt_when_an_import_or_the_config_changes() {
		let (site, loaded) = style_site("styles-incremental");
		let run = |loaded: &Loaded| {
			let prepared = prepare_incremental(loaded);
			let report = prepared.finish(Vec::new(), Vec::new()).unwrap();
			report
				.assets
				.iter()
				.map(|a| {
					(
						a.input_path.rsplit('/').next().unwrap().to_owned(),
						a.status,
					)
				})
				.collect::<Vec<_>>()
		};
		let built = |name: &str| (name.to_owned(), Status::Built);
		let cached = |name: &str| (name.to_owned(), Status::Cached);
		assert_eq!(run(&loaded), [built("base.css"), built("main.css")]);
		assert_eq!(run(&loaded), [cached("base.css"), cached("main.css")]);

		// A file that main.css imports: both it and main.css are rebuilt.
		site.write("src/css/base.css", "a { color : black; margin : 0 }\n");
		assert_eq!(run(&loaded), [built("base.css"), built("main.css")]);
		assert!(
			site.read("out/css/main.css")
				.contains("a{color:#000;margin:0}")
		);

		// Another banner is another environment for every stylesheet.
		let other = site.config(r#", "styles": { "banner": "changed" }"#);
		assert_eq!(run(&other), [built("base.css"), built("main.css")]);
	}

	#[test]
	fn a_stylesheet_may_not_be_written_over_a_page() {
		let site = Site::new("styles-vs-page");
		site.write("src/a.html", "<p>a</p>");
		site.write("src/a.css", "a{}");
		let loaded = site.config(r#", "pages": { "outputExtension": ".css" }"#);
		let e = prepare(&loaded, &BuildOptions::default(), "file:///runtime.js").unwrap_err();
		assert!(e.contains("is also the output of a page"), "{e}");
	}

	#[test]
	fn a_stylesheet_gets_an_inline_source_map_only_when_asked_for() {
		let (site, loaded) = style_site("styles-sourcemap");
		build(&loaded, &BuildOptions::default()).unwrap();
		assert!(
			!site.read("out/css/main.css").contains("sourceMappingURL"),
			"onServer is the default: no map in a build"
		);

		let with_map = site.config(r#", "styles": { "banner": "", "sourcemap": true }"#);
		build(&with_map, &BuildOptions::default()).unwrap();
		let css = site.read("out/css/main.css");
		assert!(
			css.starts_with(
				"a{color:#fff}b{margin:0}\n/*# sourceMappingURL=data:application/json;base64,"
			),
			"{css}"
		);
		assert!(css.ends_with(" */"), "{css}");
	}

	fn sitemap_site(name: &str, extra: &str) -> (Site, Loaded) {
		let site = Site::new(name);
		site.write("src/index.html", "<p>home</p>");
		site.write("src/about/index.html", "<p>about</p>");
		site.write("src/news.html", "<p>news</p>");
		site.write("src/draft/index.html", "<p>draft</p>");
		site.write(
			"overrides.json",
			r#"{ "version": 1, "pages": [{ "url": "/about/", "lastmod": "2026-01-02T00:00:00+09:00" }, { "url": "/service/", "virtual": true, "lastmod": "2026-02-03" }] }"#,
		);
		let loaded = site.config(&format!(
			r#", "site": {{ "baseURL": "https://example.com/sub/" }}, "pages": {{ "overrides": "overrides.json" }}, "sitemap": {{ "exclude": ["draft/**"]{extra} }}"#
		));
		(site, loaded)
	}

	#[test]
	fn the_sitemap_lists_the_planned_pages_with_absolute_urls() {
		let (site, loaded) = sitemap_site("sitemap", "");
		build(&loaded, &BuildOptions::default()).unwrap();

		assert_eq!(
			site.read("out/sitemap.xml"),
			concat!(
				"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
				"<urlset xmlns=\"http://www.sitemaps.org/schemas/sitemap/0.9\">\n",
				"<url><loc>https://example.com/sub/</loc></url>\n",
				"<url><loc>https://example.com/sub/about/</loc></url>\n",
				"<url><loc>https://example.com/sub/news.html</loc></url>\n",
				"<url><loc>https://example.com/sub/service/</loc></url>\n",
				"</urlset>\n"
			)
		);
	}

	#[test]
	fn lastmod_changefreq_and_priority_are_written_when_configured() {
		let (site, loaded) = sitemap_site(
			"sitemap-lastmod",
			r#", "lastmod": "manifest", "changefreq": "weekly", "priority": 0.8"#,
		);
		build(&loaded, &BuildOptions::default()).unwrap();

		let xml = site.read("out/sitemap.xml");
		assert!(
			xml.contains("<url><loc>https://example.com/sub/about/</loc><lastmod>2026-01-02T00:00:00+09:00</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>"),
			"{xml}"
		);
		assert!(
			xml.contains(
				"<loc>https://example.com/sub/service/</loc><lastmod>2026-02-03</lastmod>"
			),
			"{xml}"
		);
		// A page without an override has no lastmod to give.
		assert!(
			xml.contains("<loc>https://example.com/sub/news.html</loc><changefreq>"),
			"{xml}"
		);
	}

	#[test]
	fn mtime_uses_the_modification_time_of_the_source() {
		let (site, loaded) = sitemap_site("sitemap-mtime", r#", "lastmod": "mtime""#);
		build(&loaded, &BuildOptions::default()).unwrap();

		let xml = site.read("out/sitemap.xml");
		let year = &xml[xml.find("<lastmod>").unwrap() + 9..][..2];
		assert_eq!(year, "20");
		assert!(xml.contains("Z</lastmod>"), "{xml}");
	}

	#[test]
	fn a_sitemap_needs_an_origin_and_stays_inside_the_output_directory() {
		let site = Site::new("sitemap-errors");
		site.write("src/index.html", "<p>x</p>");
		let loaded = site.config(r#", "sitemap": {}"#);
		let e = build(&loaded, &BuildOptions::default()).unwrap_err();
		assert!(e.starts_with("sitemap: addresses need an origin"), "{e}");

		let loaded = site.config(
			r#", "site": { "host": "example.com" }, "sitemap": { "output": "../sitemap.xml" }"#,
		);
		let e = build(&loaded, &BuildOptions::default()).unwrap_err();
		assert!(
			e.contains("must be a file inside the output directory"),
			"{e}"
		);

		// A host alone is enough: it is served over https.
		let loaded = site.config(r#", "site": { "host": "example.com" }, "sitemap": {}"#);
		build(&loaded, &BuildOptions::default()).unwrap();
		assert!(
			site.read("out/sitemap.xml")
				.contains("<loc>https://example.com/</loc>")
		);
	}

	fn build_incrementally(loaded: &Loaded) -> Report {
		prepare_incremental(loaded)
			.finish(Vec::new(), Vec::new())
			.unwrap()
	}

	#[test]
	fn the_plan_cache_serves_unchanged_pages_and_the_pages_that_change_are_read_again() {
		let site = Site::new("plan-cache");
		site.write("src/a.html", "---\ntitle: A\n---\n<p>a</p>");
		site.write("src/b.html", "<p>b</p>");
		site.write("src/c.html", "<p>c</p>");
		let loaded = site.config("");
		build_incrementally(&loaded);
		let cache = format!("{}/.cache/plan-cache.bin", site.root);
		assert!(
			fs::metadata(&cache).is_ok(),
			"the first build wrote the cache"
		);
		let first = fs::read(&cache).unwrap();

		// Nothing changed: the cache is used and not rewritten.
		let report = build_incrementally(&loaded);
		assert_eq!(
			statuses(&report),
			[
				("/a.html", "cached"),
				("/b.html", "cached"),
				("/c.html", "cached")
			]
		);
		assert_eq!(fs::read(&cache).unwrap(), first);

		// Another environment rebuilds every page from bodies the cache did not
		// keep: they are read when they are needed.
		let doctype = site.config(r#", "site": { "siteName": "Changed" }"#);
		let report = build_incrementally(&doctype);
		assert_eq!(
			statuses(&report),
			[
				("/a.html", "built"),
				("/b.html", "built"),
				("/c.html", "built")
			]
		);
		assert_eq!(site.read("out/a.html"), "<p>a</p>\n");
		assert_eq!(site.read("out/b.html"), "<p>b</p>\n");

		// One page changes (same length, so only the time tells): it is read
		// again, with its new metadata; the others stay cached.
		std::thread::sleep(std::time::Duration::from_millis(5));
		site.write("src/b.html", "<p>B</p>");
		let report = build_incrementally(&doctype);
		assert_eq!(
			statuses(&report),
			[
				("/a.html", "cached"),
				("/b.html", "built"),
				("/c.html", "cached")
			]
		);
		assert_eq!(site.read("out/b.html"), "<p>B</p>\n");
		assert_ne!(
			fs::read(&cache).unwrap(),
			first,
			"the cache follows the page"
		);

		// A sidecar that appears is a change of the page.
		site.write("src/c.json", "{ \"title\": \"C\" }");
		let report = build_incrementally(&doctype);
		assert_eq!(
			statuses(&report),
			[
				("/a.html", "cached"),
				("/b.html", "cached"),
				("/c.html", "built")
			]
		);
		let meta = &plan(&doctype.config).unwrap().pages[2].meta;
		assert_eq!(
			meta,
			&vec![("title".to_owned(), Value::String("C".to_owned()))]
		);
	}

	#[test]
	fn a_damaged_plan_cache_is_ignored() {
		let site = Site::new("plan-cache-damaged");
		site.write("src/a.html", "<p>a</p>");
		let loaded = site.config("");
		build_incrementally(&loaded);
		fs::write(format!("{}/.cache/plan-cache.bin", site.root), b"garbage").unwrap();

		let report = build_incrementally(&loaded);

		assert_eq!(statuses(&report), [("/a.html", "cached")]);
		assert!(
			fs::read(format!("{}/.cache/plan-cache.bin", site.root))
				.unwrap()
				.starts_with(b"KDP")
		);
	}

	fn prepare_incremental_result(loaded: &Loaded) -> Result<Prepared, String> {
		prepare(loaded, &BuildOptions::default(), "file:///runtime.js")
	}

	#[test]
	fn a_tsx_meta_that_needs_evaluation_stops_the_plan_with_its_position() {
		let site = Site::new("meta-error");
		site.write(
			"src/a.tsx",
			"const t = 'x';\nexport const meta = { title: t };\nexport default () => <p/>;\n",
		);
		let loaded = site.config("");
		let err = plan(&loaded.config).unwrap_err();
		assert!(
			err.contains("a.tsx:2:30: `meta` must be a literal"),
			"{err}"
		);
	}

	#[test]
	fn the_iso_date_is_correct() {
		use crate::session::iso_from_secs;
		assert_eq!(iso_from_secs(0), "1970-01-01T00:00:00.000Z");
		assert_eq!(iso_from_secs(951_782_400), "2000-02-29T00:00:00.000Z");
		assert_eq!(iso_from_secs(1_700_000_000), "2023-11-14T22:13:20.000Z");
		assert_eq!(iso_from_secs(4_102_444_799), "2099-12-31T23:59:59.000Z");
	}

	fn run_build(loaded: &Loaded) -> Result<Report, String> {
		build(
			loaded,
			&BuildOptions {
				jobs: Some(1),
				..Default::default()
			},
		)
	}

	const DOCUMENT: &str = "<html><head><title>t</title></head><body><input type=\"text\" disabled=\"disabled\"><p>x</p></body></html>";

	#[test]
	fn pages_go_through_doctype_format_and_minify_in_v2_order() {
		let site = Site::new("pipeline");
		site.write("src/a.html", DOCUMENT);
		let loaded = site.config("");
		run_build(&loaded).unwrap();
		assert_eq!(
			site.read("out/a.html"),
			"<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<title>t</title>\n\t</head>\n\t<body>\n\t\t<input disabled>\n\t\t<p>x</p>\n\t</body>\n</html>\n"
		);
	}

	#[test]
	fn line_break_crlf_applies_to_the_whole_page() {
		let site = Site::new("crlf");
		site.write("src/a.html", "<p>a</p><p>b</p>");
		let loaded = site.config(r#", "html": { "lineBreak": "crlf" }"#);
		run_build(&loaded).unwrap();
		assert_eq!(site.read("out/a.html"), "<p>a</p>\r\n<p>b</p>\r\n");
	}

	#[test]
	fn an_override_replaces_only_the_options_it_names_for_the_pages_it_matches() {
		let site = Site::new("overrides");
		site.write("src/a.html", DOCUMENT);
		site.write("src/legacy/b.html", DOCUMENT);
		let loaded = site.config(
			r#", "html": { "overrides": [ { "pages": ["/legacy/**"], "format": false, "minify": false, "doctype": false } ] }"#,
		);
		run_build(&loaded).unwrap();
		assert!(
			site.read("out/a.html")
				.starts_with("<!DOCTYPE html>\n<html>\n\t<head>")
		);
		assert_eq!(site.read("out/legacy/b.html"), DOCUMENT);
	}

	#[test]
	fn rules_inject_and_entities_run_before_the_formatter() {
		let site = Site::new("rules");
		site.write(
			"src/a.html",
			"<html><head></head><body><a href=\"https://other.test/\">x</a><p class=\"old\">\u{a9}</p></body></html>",
		);
		let loaded = site.config(
			r#", "html": {
				"entities": "all",
				"rules": [
					{ "selector": "a[href^='https://']", "action": "setAttr", "name": "rel", "value": "noopener" },
					{ "selector": "p", "action": "removeClass", "value": "old", "pages": ["/nope/**"] }
				],
				"inject": [ { "position": "head-end", "html": "<meta name=\"robots\" content=\"noindex\">" } ]
			}"#,
		);
		run_build(&loaded).unwrap();
		assert_eq!(
			site.read("out/a.html"),
			"<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<meta name=\"robots\" content=\"noindex\">\n\t</head>\n\t<body>\n\t\t<a href=\"https://other.test/\" rel=\"noopener\">x</a>\n\t\t<p class=\"old\">&copy;</p>\n\t</body>\n</html>\n"
		);
	}

	#[test]
	fn included_and_measured_files_are_dependencies_even_when_missing() {
		let site = Site::new("deps");
		let png = [
			0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D, b'I', b'H', b'D', b'R',
			0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0,
		];
		fs::create_dir_all(format!("{}/out", site.root)).unwrap();
		fs::write(format!("{}/out/p.png", site.root), png).unwrap();
		site.write("src/_parts/h.html", "<header>h</header>");
		site.write(
			"src/a.html",
			"<!-- @include(/_parts/h.html) -->\n<img src=\"/p.png\"><img src=\"/missing.png\">",
		);
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "ignore": ["_parts/**"] }, "build": { "cacheDir": ".cache", "incremental": true }, "html": { "includes": [ { "preset": "includeComment", "root": "src" } ] } }"#,
		);
		run_build(&loaded).unwrap();
		assert_eq!(
			site.read("out/a.html"),
			"<header>h</header>\n<img src=\"/p.png\" width=\"3\" height=\"2\"><img src=\"/missing.png\">\n"
		);
		let cache = kd_build::cache_dir(&loaded.config.root_dir, Some(".cache"));
		let manifest =
			kd_build::Manifest::load(&kd_build::manifest_path(&cache)).expect("manifest written");
		let entry = &manifest.entries[&format!("{}/out/a.html", site.root)];
		let missing = format!("{}/out/missing.png", site.root);
		assert_eq!(entry.deps[&missing].hash, kd_build::MISSING_FILE_HASH);
		assert!(
			entry
				.deps
				.contains_key(&format!("{}/src/_parts/h.html", site.root))
		);
		assert!(entry.deps.contains_key(&format!("{}/out/p.png", site.root)));

		// Editing an included file rebuilds the page that includes it.
		fs::write(
			format!("{}/src/_parts/h.html", site.root),
			"<header>H2</header>",
		)
		.unwrap();
		let again = build(
			&loaded,
			&BuildOptions {
				jobs: Some(1),
				incremental: true,
				..Default::default()
			},
		)
		.unwrap();
		assert_eq!(statuses(&again), [("/a.html", "built")]);
		assert!(site.read("out/a.html").starts_with("<header>H2</header>"));
	}

	#[test]
	fn a_host_placeholder_in_a_selector_uses_the_site_host() {
		let site = Site::new("host");
		site.write(
			"src/a.html",
			"<a href=\"https://example.com/x\">in</a><a href=\"https://other.test/\">out</a>",
		);
		let loaded = site.config(
			r#", "site": { "host": "example.com" }, "html": { "rules": [ { "selector": "a:not([href*='{{host}}'])", "action": "setAttr", "name": "rel", "value": "noopener" } ] }"#,
		);
		run_build(&loaded).unwrap();
		assert_eq!(
			site.read("out/a.html"),
			"<a href=\"https://example.com/x\">in</a><a href=\"https://other.test/\" rel=\"noopener\">out</a>\n"
		);
	}

	#[test]
	fn rule_pages_are_globs_on_the_output_url() {
		let site = Site::new("scope");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a/index.html", "<p>a</p>");
		site.write("src/b.html", "<p>b</p>");
		let loaded = site.config(
			r#", "html": { "rules": [ { "pages": ["/a/**"], "selector": "p", "action": "addClass", "value": "hit" }, { "pages": ["**"], "exclude": ["/b.html"], "selector": "p", "action": "setAttr", "name": "data-all", "value": "1" } ] }"#,
		);
		run_build(&loaded).unwrap();
		assert_eq!(site.read("out/index.html"), "<p data-all=\"1\">top</p>\n");
		assert_eq!(
			site.read("out/a/index.html"),
			"<p class=\"hit\" data-all=\"1\">a</p>\n"
		);
		assert_eq!(site.read("out/b.html"), "<p>b</p>\n");
	}

	#[test]
	fn an_override_can_replace_the_rules_and_the_error_policy() {
		let site = Site::new("override-rules");
		site.write("src/a.html", "<p>a</p>");
		site.write("src/legacy/b.html", "<p>b</p>");
		let loaded = site.config(
			r#", "html": {
				"rules": [ { "selector": "p", "action": "addClass", "value": "x" } ],
				"overrides": [
					{ "pages": ["/legacy/**"], "rules": [ { "selector": "p", "action": "addClass", "value": "old" } ] },
					{ "pages": ["/legacy/**"], "doctype": false }
				]
			}"#,
		);
		run_build(&loaded).unwrap();
		assert_eq!(site.read("out/a.html"), "<p class=\"x\">a</p>\n");
		assert_eq!(site.read("out/legacy/b.html"), "<p class=\"old\">b</p>\n");
	}

	#[test]
	fn creating_a_missing_image_or_include_rebuilds_the_page_that_asked_for_it() {
		let site = Site::new("appears");
		site.write(
			"src/a.html",
			"<!--#include virtual=\"/part.html\" --><img src=\"/p.svg\">",
		);
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "build": { "cacheDir": ".cache", "incremental": true }, "html": { "includes": [ { "preset": "ssi" } ], "onError": "silent" } }"#,
		);
		let incremental = || {
			build(
				&loaded,
				&BuildOptions {
					jobs: Some(1),
					incremental: true,
					..Default::default()
				},
			)
			.unwrap()
		};
		assert_eq!(statuses(&incremental()), [("/a.html", "built")]);
		assert_eq!(site.read("out/a.html"), "<img src=\"/p.svg\">\n");
		assert_eq!(statuses(&incremental()), [("/a.html", "cached")]);

		site.write("out/part.html", "<b>part</b>");
		assert_eq!(statuses(&incremental()), [("/a.html", "built")]);
		assert_eq!(site.read("out/a.html"), "<b>part</b><img src=\"/p.svg\">\n");

		site.write("out/p.svg", "<svg width=\"4\" height=\"3\"></svg>");
		assert_eq!(statuses(&incremental()), [("/a.html", "built")]);
		assert_eq!(
			site.read("out/a.html"),
			"<b>part</b><img src=\"/p.svg\" width=\"4\" height=\"3\">\n"
		);
	}

	/// What v2 refused is still refused, end to end: a page cannot make the
	/// build read a file outside the output directory (includes, image sizes),
	/// write outside it (`outputPathField`), or turn a dangerous address into one.
	#[test]
	fn a_page_cannot_make_the_build_read_or_write_outside_its_directories() {
		let site = Site::new("security");
		site.write("secret.txt", "SECRET-MARKER");
		site.write("secret.svg", "<svg width=\"9\" height=\"9\"></svg>");
		site.write(
			"src/a.html",
			"<!--#include virtual=\"../secret.txt\" --><!--#include virtual=\"/../secret.txt\" --><img src=\"../secret.svg\"><img src=\"/../secret.svg\"><img src=\"//example.com/x.svg\"><img src=\"data:image/svg+xml,<svg/>\">",
		);
		site.write(
			"src/b.html",
			"---\nout: ../../escaped.html\n---\n<p>b</p>\n",
		);
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "outputPathField": "out" }, "html": { "includes": [ { "preset": "ssi" } ], "onError": "silent" } }"#,
		);

		let err = build(&loaded, &BuildOptions::default()).unwrap_err();
		assert!(err.contains("out"), "{err}");
		assert!(!std::path::Path::new(&format!("{}/../escaped.html", site.root)).exists());
		assert!(!std::path::Path::new(&format!("{}/escaped.html", site.root)).exists());

		// Without the page that asks to be written outside, the rest builds,
		// and nothing of what it asked to read is in the output.
		fs::remove_file(format!("{}/src/b.html", site.root)).unwrap();
		build(&loaded, &BuildOptions::default()).unwrap();
		let html = site.read("out/a.html");
		assert!(!html.contains("SECRET-MARKER"), "{html}");
		assert!(!html.contains("width=\"9\""), "{html}");
	}

	#[test]
	fn many_pages_sharing_an_include_and_an_image_build_the_same_on_every_thread_count() {
		let site = Site::new("shared");
		site.write("src/_parts/h.html", "<header>h</header>");
		fs::create_dir_all(format!("{}/out", site.root)).unwrap();
		fs::write(
			format!("{}/out/s.svg", site.root),
			"<svg width=\"8\" height=\"6\"></svg>",
		)
		.unwrap();
		for i in 0..24 {
			site.write(
				&format!("src/p{i}.html"),
				"<!-- @include(/_parts/h.html) --><img src=\"/s.svg\">",
			);
		}
		let loaded = site.config_raw(
			r#"{ "dir": { "input": "src", "output": "out" }, "pages": { "ignore": ["_parts/**"] }, "build": { "cacheDir": ".cache" }, "html": { "includes": [ { "preset": "includeComment", "root": "src" } ] } }"#,
		);
		let report = build(
			&loaded,
			&BuildOptions {
				jobs: Some(6),
				..Default::default()
			},
		)
		.unwrap();
		assert_eq!(report.pages.len(), 24);
		for i in 0..24 {
			assert_eq!(
				site.read(&format!("out/p{i}.html")),
				"<header>h</header>\n<img src=\"/s.svg\" width=\"8\" height=\"6\">\n"
			);
		}
	}

	#[test]
	fn a_failed_build_does_not_leave_entries_for_the_outputs_it_rewrote() {
		let site = Site::new("failed-finish");
		let a = site.write("src/a.html", "<p>A1</p>");
		let b = site.write("src/b.html", "<p>b</p>");
		let loaded = site.config(r#", "html": { "onError": "error" }"#);
		let opts = BuildOptions {
			incremental: true,
			jobs: Some(2),
			..Default::default()
		};
		build(&loaded, &opts).unwrap();

		// a.html changes to text of the same size, and b.html cannot be built.
		std::thread::sleep(std::time::Duration::from_millis(20));
		fs::write(&a, "<p>A2</p>").unwrap();
		fs::write(&b, "<p title=\"&unknown;\">b</p>").unwrap();
		assert!(build(&loaded, &opts).is_err());
		assert_eq!(site.read("out/a.html"), "<p>A2</p>\n");

		// Back to the text the manifest remembers: the output still has A2, so
		// the page has to be built again rather than found up to date.
		std::thread::sleep(std::time::Duration::from_millis(20));
		fs::write(&a, "<p>A1</p>").unwrap();
		fs::write(&b, "<p>b</p>").unwrap();
		let report = build(&loaded, &opts).unwrap();
		// b.html never got an output of the failed text, so its entry is right.
		assert_eq!(
			statuses(&report),
			[("/a.html", "built"), ("/b.html", "cached")]
		);
		assert_eq!(site.read("out/a.html"), "<p>A1</p>\n");
	}

	#[test]
	fn on_error_decides_what_a_failing_stage_does() {
		let page = "<p title=\"&unknown;\">x</p>";
		let site = Site::new("on-error");
		site.write("src/a.html", page);

		// silent: the format stage is skipped and the serialized text flows on.
		let loaded = site.config("");
		let report = run_build(&loaded).unwrap();
		assert!(report.warnings.is_empty());
		assert_eq!(site.read("out/a.html"), page);

		let loaded = site.config(r#", "html": { "onError": "warning" }"#);
		let report = run_build(&loaded).unwrap();
		assert_eq!(report.warnings.len(), 1);
		assert!(report.warnings[0].starts_with("Transform 'format' failed on "));

		let loaded = site.config(r#", "html": { "onError": "error" }"#);
		let err = run_build(&loaded).unwrap_err();
		assert!(err.starts_with("Transform 'format' failed on "));
	}

	#[test]
	fn invalid_html_options_fail_before_any_page_is_built() {
		let site = Site::new("bad-options");
		site.write("src/a.html", "<p>a</p>");
		for (extra, expected) in [
			(
				r#"{ "rules": [ { "selector": "p", "action": "bogus" } ] }"#,
				"html.rules[0].action: unknown action",
			),
			(
				r#"{ "rules": [ { "selector": "p", "action": "remove", "name": "x" } ] }"#,
				"html.rules[0].name: unknown option",
			),
			(
				r#"{ "rules": [ { "selector": "p[", "action": "remove" } ] }"#,
				"html.rules[0]",
			),
			(
				r#"{ "includes": [ { "preset": "nope" } ] }"#,
				"html.includes[0].preset: unknown preset",
			),
			(
				r#"{ "inject": [ { "position": "middle", "html": "x" } ] }"#,
				"html.inject[0].position",
			),
			(
				r#"{ "entities": { "ab": "x" } }"#,
				"html.entities.ab: the key must be exactly one character",
			),
			(
				r#"{ "overrides": [ { "pages": ["**"], "overrides": [] } ] }"#,
				"overrides cannot be nested",
			),
			(
				r#"{ "inject": [ { "position": "head-end", "html": "x", "name": "a" } ] }"#,
				"html.inject[0].name: unknown option",
			),
			(
				r#"{ "rules": [ { "selector": "a:not([href*='{{host}}'])", "action": "remove" } ] }"#,
				"html.rules[0].selector: uses {{host}}, but site.host is not set",
			),
			(
				r#"{ "includes": [ { "selector": "p", "attr": "x", "root": "src", "pick": "i[data='{{host}}']" } ] }"#,
				"html.includes[0].pick: uses {{host}}",
			),
		] {
			let loaded = site.config(&format!(r#", "html": {extra}"#));
			let err = run_build(&loaded).unwrap_err();
			assert!(err.contains(expected), "{extra}: {err}");
		}
		assert!(!std::path::Path::new(&format!("{}/out/a.html", site.root)).exists());
	}
}
