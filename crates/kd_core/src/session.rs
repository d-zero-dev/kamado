//! One build in two steps, so that JavaScript can render in between:
//!
//! 1. [`prepare`] plans the pages, decides which are up to date, compiles the
//!    modules of the JSX pages and layouts that must be rendered and returns
//!    the list of render jobs. Nothing is written.
//! 2. The caller renders the jobs (in Node: it imports the compiled modules)
//!    and hands the HTML back to [`Prepared::finish`], which runs the HTML
//!    stages, writes the outputs and the manifest.
//!
//! A site without JSX pages and layouts has no jobs, and [`build`] does both
//! steps at once.

use std::collections::BTreeMap;
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use kd_jsonc::Value;

use crate::html;
use crate::jsx::Modules;
use crate::{
	BuildOptions, Loaded, Page, PageKind, PageResult, Plan, Report, Status, compile_globs, plan,
	write_output,
};

/// Something for JavaScript to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderJob {
	/// The index of the page in the page list.
	pub page: usize,
	/// The compiled module of the page (`None` for an `.html` page: its body
	/// is the content).
	pub main: Option<String>,
	/// The compiled module of the layout the page names, if any.
	pub layout: Option<String>,
	/// The body of an `.html` page: the content its layout wraps.
	pub content: Option<String>,
}

/// What [`prepare`] decided about a page.
enum Decision {
	Virtual,
	Skipped,
	Cached(kd_build::Entry),
	/// To be built; `render` is what JavaScript has to do for it.
	Build {
		render: Option<RenderPlan>,
	},
}

struct RenderPlan {
	/// The fingerprints of every module file that was compiled for the page.
	deps: BTreeMap<String, kd_build::Dep>,
}

/// The state between [`prepare`] and [`Prepared::finish`].
pub struct Prepared {
	shared: Arc<Shared>,
	decisions: Vec<Decision>,
	on_disk: kd_build::Manifest,
	manifest_path: String,
	incremental: bool,
	jobs: usize,
	started: Instant,
	render_jobs: Vec<RenderJob>,
	context: Option<String>,
}

/// Read-only state shared by the pool jobs of the second step.
struct Shared {
	plan: Plan,
	env: String,
	env_js: String,
	pipeline: html::Pipeline,
	targets: Vec<kd_glob::Pattern>,
	skip_unchanged: bool,
	results: Mutex<Vec<Option<Outcome>>>,
}

/// A page result, its manifest entry and the warnings it raised.
type Outcome = Result<(PageResult, Option<kd_build::Entry>, Vec<String>), String>;

/// The compiled layout (its module) and the fingerprints of its import closure.
type LayoutModule = (String, BTreeMap<String, kd_build::Dep>);

fn layout_module(
	config: &kd_config::Config,
	modules: &Modules,
	page: &Page,
) -> Result<Option<LayoutModule>, String> {
	let Some(name) = page
		.meta
		.iter()
		.find(|(k, _)| k == "layout")
		.and_then(|(_, v)| v.as_str())
		.filter(|n| !n.is_empty())
	else {
		return Ok(None);
	};
	let input = &page.file.input_path;
	let Some(dir) = &config.pages.layouts_dir else {
		return Err(format!(
			"{input}: meta.layout is {name:?}, but pages.layouts.dir is not set"
		));
	};
	if name.contains(['/', '\\', '\0']) || name == "." || name == ".." {
		return Err(format!(
			"{input}: meta.layout {name:?} must be a file name in {dir}, without a path"
		));
	}
	for ext in [".tsx", ".jsx"] {
		let path = format!("{}/{name}{ext}", dir.trim_end_matches('/'));
		if fs::metadata(&path).is_ok_and(|m| m.is_file()) {
			let compiled = modules.compile(&path)?;
			if !compiled.has_default_export {
				return Err(format!(
					"{path}: a layout must `export default` a component"
				));
			}
			return Ok(Some((compiled.out_path.clone(), modules.closure(&path))));
		}
	}
	Err(format!(
		"{input}: layout {name:?} not found (looked for {dir}/{name}.tsx and .jsx)"
	))
}

/// The environment digest of pages that JavaScript renders: they read the
/// whole page list (`nav()`, `breadcrumbs`) and the data, so a change to
/// either rebuilds them.
fn pages_digest(plan: &Plan) -> String {
	let mut hasher_input = String::new();
	let mut order: Vec<&Page> = plan.pages.iter().collect();
	order.sort_by(|a, b| a.file.url.cmp(&b.file.url));
	for p in order {
		hasher_input.push_str(&p.file.url);
		hasher_input.push('\0');
		hasher_input.push_str(&Value::Object(p.meta.clone()).to_json());
		hasher_input.push('\0');
	}
	kd_hash::to_hex(&kd_hash::sha256(hasher_input.as_bytes()))
}

fn page_json(page: &Page, date: &str) -> Value {
	let f = &page.file;
	Value::Object(vec![
		("url".to_owned(), Value::String(f.url.clone())),
		("inputPath".to_owned(), Value::String(f.input_path.clone())),
		(
			"outputPath".to_owned(),
			Value::String(f.output_path.clone()),
		),
		("fileSlug".to_owned(), Value::String(f.file_slug.clone())),
		(
			"filePathStem".to_owned(),
			Value::String(f.file_path_stem.clone()),
		),
		("extension".to_owned(), Value::String(f.extension.clone())),
		("date".to_owned(), Value::String(date.to_owned())),
		("meta".to_owned(), Value::Object(page.meta.clone())),
	])
}

fn site_json(config: &kd_config::Config) -> Value {
	let s = &config.site;
	let opt = |v: &Option<String>| v.as_ref().map_or(Value::Null, |s| Value::String(s.clone()));
	Value::Object(vec![
		("host".to_owned(), opt(&s.host)),
		("baseURL".to_owned(), opt(&s.base_url)),
		("siteName".to_owned(), opt(&s.site_name)),
		("siteNameEn".to_owned(), opt(&s.site_name_en)),
		("name".to_owned(), opt(&s.package_name)),
		("version".to_owned(), opt(&s.package_version)),
	])
}

/// Plans the build and prepares what JavaScript has to render.
///
/// `runtime` is the file URL of the JSX runtime that compiled modules import
/// (it is part of what Node loads; the host knows where it lives).
///
/// # Errors
///
/// A message for any problem with the plan, the config's HTML options, a
/// syntax error or unresolvable import in a JSX page or layout, or a layout
/// that does not exist.
pub fn prepare(loaded: &Loaded, options: &BuildOptions, runtime: &str) -> Result<Prepared, String> {
	let started = Instant::now();
	let config = &loaded.config;
	let plan = plan(config)?;
	let targets = compile_globs(&options.targets)?;
	let env = kd_hash::to_hex(&kd_hash::sha256(
		format!("{}\0{}\0html-pipeline", crate::VERSION, loaded.config_hash).as_bytes(),
	));
	let pipeline = html::Pipeline::compile(config)?;
	let data = crate::data::load(config)?;

	let needs_js = |page: &Page| {
		!page.is_virtual
			&& (page.kind == PageKind::Tsx
				|| page
					.meta
					.iter()
					.any(|(k, v)| k == "layout" && v.as_str().is_some_and(|s| !s.is_empty())))
	};
	let any_js = plan.pages.iter().any(needs_js);
	let env_js = if any_js {
		kd_hash::to_hex(&kd_hash::sha256(
			format!("{env}\0{}\0{}\0{runtime}", data.hash, pages_digest(&plan)).as_bytes(),
		))
	} else {
		env.clone()
	};

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

	// Decide every page.
	let fingerprinter = kd_build::Fingerprinter::new();
	let modules = Modules::new(&config.root_dir, runtime, &config.pages.alias);
	let mut decisions = Vec::with_capacity(plan.pages.len());
	let mut render_jobs = Vec::new();
	for (i, page) in plan.pages.iter().enumerate() {
		if page.is_virtual {
			decisions.push(Decision::Virtual);
			continue;
		}
		let rel = kd_site::path::relative(&config.dir.input, &page.file.input_path);
		if !targets.is_empty() && !targets.iter().any(|t| t.matches(&rel)) {
			decisions.push(Decision::Skipped);
			continue;
		}
		let page_env = if needs_js(page) { &env_js } else { &env };
		if let Some(entry) = previous.entries.get(&page.file.output_path)
			&& let kd_build::Verdict::UpToDate(refreshed) = kd_build::check(
				entry,
				&page.file.output_path,
				&page.file.input_path,
				page_env,
				&fingerprinter,
			) {
			decisions.push(Decision::Cached(refreshed));
			continue;
		}
		if !needs_js(page) {
			decisions.push(Decision::Build { render: None });
			continue;
		}
		let mut deps = BTreeMap::new();
		let main = if page.kind == PageKind::Tsx {
			let compiled = modules.compile(&page.file.input_path)?;
			if !compiled.has_default_export {
				return Err(format!(
					"{}: a page must `export default` a component",
					page.file.input_path
				));
			}
			deps.extend(modules.closure(&page.file.input_path));
			Some(compiled.out_path.clone())
		} else {
			None
		};
		let layout = match layout_module(config, &modules, page)? {
			Some((out, closure)) => {
				deps.extend(closure);
				Some(out)
			}
			None => None,
		};
		render_jobs.push(RenderJob {
			page: i,
			content: if main.is_none() {
				page.body.clone()
			} else {
				None
			},
			main,
			layout,
		});
		decisions.push(Decision::Build {
			render: Some(RenderPlan { deps }),
		});
	}

	let context = if render_jobs.is_empty() {
		None
	} else {
		let date = now_iso();
		let pages: Vec<Value> = plan.pages.iter().map(|p| page_json(p, &date)).collect();
		Some(
			Value::Object(vec![
				("site".to_owned(), site_json(config)),
				("data".to_owned(), data.value),
				("pages".to_owned(), Value::Array(pages)),
			])
			.to_json(),
		)
	};

	let page_count = plan.pages.len();
	Ok(Prepared {
		shared: Arc::new(Shared {
			plan,
			env,
			env_js,
			pipeline,
			targets,
			skip_unchanged: options.skip_unchanged || config.build.skip_unchanged,
			results: Mutex::new((0..page_count).map(|_| None).collect()),
		}),
		decisions,
		on_disk,
		manifest_path,
		incremental,
		jobs,
		started,
		render_jobs,
		context,
	})
}

/// The current time as an ISO 8601 string (UTC), for `page.date`.
fn now_iso() -> String {
	let secs = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |d| d.as_secs() as i64);
	iso_from_secs(secs)
}

/// `secs` since the epoch as `YYYY-MM-DDTHH:MM:SS.000Z`.
pub(crate) fn iso_from_secs(secs: i64) -> String {
	let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
	// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	let y = if m <= 2 { y + 1 } else { y };
	format!(
		"{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
		rem / 3600,
		rem % 3600 / 60,
		rem % 60
	)
}

impl std::fmt::Debug for Prepared {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Prepared")
			.field("pages", &self.shared.plan.pages.len())
			.field("jobs", &self.render_jobs.len())
			.finish_non_exhaustive()
	}
}

impl Prepared {
	/// The URL of a page of the plan.
	#[must_use]
	pub fn page_url(&self, page: usize) -> &str {
		&self.shared.plan.pages[page].file.url
	}

	/// What JavaScript has to render (empty for a site without JSX pages and
	/// layouts).
	#[must_use]
	pub fn jobs(&self) -> &[RenderJob] {
		&self.render_jobs
	}

	/// The values the templates are built from, as JSON: `{ site, data,
	/// pages }`. `None` when there is nothing to render.
	#[must_use]
	pub fn context_json(&self) -> Option<&str> {
		self.context.as_deref()
	}

	/// Runs the HTML stages for every page that has to be built, writes the
	/// outputs and the manifest and returns the report. `rendered` holds the
	/// HTML JavaScript produced for each job (by page index).
	///
	/// # Errors
	///
	/// A message for a missing rendering, any page error (the build stops at
	/// the first one), or a file that cannot be written.
	pub fn finish(self, rendered: Vec<(usize, String)>) -> Result<Report, String> {
		let Prepared {
			shared,
			decisions,
			on_disk,
			manifest_path,
			incremental,
			jobs,
			started,
			render_jobs,
			context: _,
		} = self;
		let mut html_by_page: Vec<Option<String>> = vec![None; shared.plan.pages.len()];
		for (page, html) in rendered {
			if page >= html_by_page.len() {
				return Err(format!("a rendering for page {page}, which does not exist"));
			}
			html_by_page[page] = Some(html);
		}
		for job in &render_jobs {
			if html_by_page[job.page].is_none() {
				return Err(format!(
					"{}: the page was not rendered",
					shared.plan.pages[job.page].file.input_path
				));
			}
		}
		let decisions = Arc::new(decisions);
		let html_by_page = Arc::new(html_by_page);
		let page_count = shared.plan.pages.len();

		// Largest first (LPT): the slow tail of the build stays short.
		let mut order: Vec<usize> = (0..page_count).collect();
		order.sort_by_key(|&i| {
			std::cmp::Reverse(html_by_page[i].as_ref().map_or_else(
				|| shared.plan.pages[i].body.as_ref().map_or(0, String::len),
				String::len,
			))
		});

		let pool = kd_pool::Pool::new(jobs);
		pool.scope(|s| {
			for i in order {
				let shared = Arc::clone(&shared);
				let decisions = Arc::clone(&decisions);
				let html_by_page = Arc::clone(&html_by_page);
				s.spawn(move || {
					let outcome = finish_one(&shared, &decisions[i], i, html_by_page[i].as_deref());
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
			let (result, entry, warnings) = outcome?;
			report.warnings.extend(warnings);
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
		Ok(report)
	}
}

fn finish_one(shared: &Shared, decision: &Decision, i: usize, rendered: Option<&str>) -> Outcome {
	let page = &shared.plan.pages[i];
	let result = |status| PageResult {
		url: page.file.url.clone(),
		input_path: page.file.input_path.clone(),
		output_path: page.file.output_path.clone(),
		status,
		meta: page.meta.clone(),
	};
	let render = match decision {
		Decision::Virtual => return Ok((result(Status::Virtual), None, Vec::new())),
		Decision::Skipped => return Ok((result(Status::Skipped), None, Vec::new())),
		Decision::Cached(entry) => {
			return Ok((result(Status::Cached), Some(entry.clone()), Vec::new()));
		}
		Decision::Build { render } => render,
	};
	let source = match rendered {
		Some(html) => html,
		None => page.body.as_deref().unwrap_or_default(),
	};
	let out = shared.pipeline.process(&html::PageInput {
		source,
		url: &page.file.url,
		input_path: &page.file.input_path,
		phase: kd_html::inject::Phase::Build,
	})?;
	let bytes = out.html.into_bytes();
	let status = write_output(&page.file.output_path, &bytes, shared.skip_unchanged)?;
	// The fingerprints were taken when the bytes were read, so an edit made
	// after that is detected by the next build instead of being recorded as if
	// the output had been built from it.
	let mut deps = page.deps.clone();
	if let Some(plan) = render {
		deps.extend(plan.deps.clone());
	}
	deps.extend(out.deps);
	let entry = kd_build::Entry {
		input_path: page.file.input_path.clone(),
		env: if render.is_some() {
			shared.env_js.clone()
		} else {
			shared.env.clone()
		},
		output_size: bytes.len() as u64,
		deps,
	};
	Ok((result(status), Some(entry), out.warnings))
}

/// Runs a build that needs no JavaScript and returns the report. A site with
/// JSX pages or layouts needs a renderer: use [`prepare`] and
/// [`Prepared::finish`].
///
/// # Errors
///
/// Any page error aborts the build; a page that needs rendering is an error.
///
/// # Example
///
/// ```no_run
/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
/// let report = kd_core::build(&loaded, &kd_core::BuildOptions::default()).unwrap();
/// println!("{} pages", report.pages.len());
/// ```
pub fn build(loaded: &Loaded, options: &BuildOptions) -> Result<Report, String> {
	let prepared = prepare(loaded, options, "file:///unused-runtime.js")?;
	if let Some(job) = prepared.jobs().first() {
		return Err(format!(
			"{}: JSX pages and layouts need a JavaScript renderer, which this build does not have",
			prepared.shared.plan.pages[job.page].file.input_path
		));
	}
	let config = &loaded.config;
	let report = prepared.finish(Vec::new())?;
	write_report(config, &report)?;
	Ok(report)
}

/// Writes `build.report` when it is configured.
///
/// # Errors
///
/// A message when the file cannot be written.
pub fn write_report(config: &kd_config::Config, report: &Report) -> Result<(), String> {
	if let Some(path) = &config.build.report {
		if let Some(parent) = std::path::Path::new(path).parent() {
			fs::create_dir_all(parent)
				.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
		}
		fs::write(path, report.to_json()).map_err(|e| format!("cannot write {path}: {e}"))?;
	}
	Ok(())
}
