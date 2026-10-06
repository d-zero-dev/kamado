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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use kd_jsonc::Value;

use crate::assets::{self, Asset, AssetKind, ScriptSettings};
use crate::banner::{self, LocalTime};
use crate::html;
use crate::jsx::Modules;
use crate::minifiers::Minifiers;
use crate::parallel;
use crate::sitemap;
use crate::style::{self, StyleSettings};
use crate::{
	AssetResult, BuildOptions, Loaded, Page, PageKind, PageResult, Plan, Report, Status,
	compile_globs, write_output,
};

/// What esbuild produced for one script: the bundle and every file it read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptOutput {
	/// The index of the script in the request `prepare` made.
	pub id: usize,
	pub code: String,
	/// Absolute paths of the bundled inputs (the dependencies of the output).
	pub inputs: Vec<String>,
}

/// Something for JavaScript to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderJob {
	/// The index of the page in the page list.
	pub page: usize,
	/// The compiled module of the page (`None` for an `.html` page: its body
	/// is the content). With `entry` it is a chunk, which holds several pages.
	pub main: Option<String>,
	/// The position of the page in the chunk `main` names (`pages[entry]` is a
	/// function that gives the page's exports).
	pub entry: Option<usize>,
	/// The compiled module of the layout the page names, if any.
	pub layout: Option<String>,
	/// The body of an `.html` page: the content its layout wraps.
	pub content: Option<String>,
}

/// What [`prepare`] decided about a page.
enum Decision {
	Virtual,
	Skipped,
	/// Up to date. The entry is the manifest's own, to be kept as it is
	/// (`None`), or with refreshed fingerprints.
	Cached(Option<kd_build::Entry>),
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
	/// What esbuild has to build, as JSON (`None` when no script is stale).
	script_request: Option<String>,
}

/// Read-only state shared by the pool jobs of the second step.
struct Shared {
	plan: Plan,
	env: String,
	env_js: String,
	/// The environment digest of the scripts.
	env_scripts: String,
	/// The environment digest of the stylesheets.
	env_styles: String,
	style_settings: StyleSettings,
	pipeline: html::Pipeline,
	/// Minifies the code inside pages (inline scripts and handlers).
	minifiers: Minifiers,
	targets: Vec<kd_glob::Pattern>,
	skip_unchanged: bool,
	assets: Vec<Asset>,
	sitemap: Option<sitemap::Settings>,
	asset_decisions: Vec<Decision>,
	/// Fingerprints the inputs esbuild read; created empty so that nothing is
	/// remembered from before esbuild ran.
	fingerprinter: kd_build::Fingerprinter,
	/// The start of the build: an input modified after it may have been read
	/// before the edit, so its fingerprint cannot vouch for the output.
	started_at: (i64, u32),
	results: Mutex<Vec<Option<Outcome>>>,
	asset_results: Mutex<Vec<Option<AssetOutcome>>>,
}

/// A page result, its manifest entry and the warnings it raised.
type Outcome = Result<(PageResult, Option<kd_build::Entry>, Vec<String>), String>;

/// An asset result and its manifest entry.
type AssetOutcome = Result<(AssetResult, Option<kd_build::Entry>), String>;

/// The compiled layout (its module) and the fingerprints of its import closure.
pub(crate) type LayoutModule = (String, BTreeMap<String, kd_build::Dep>);

/// Whether JavaScript renders the page: a JSX page, or a page that names a
/// layout (a layout is a component).
pub(crate) fn needs_js(page: &Page) -> bool {
	!page.is_virtual
		&& (page.kind == PageKind::Tsx
			|| page
				.meta
				.iter()
				.any(|(k, v)| k == "layout" && v.as_str().is_some_and(|s| !s.is_empty())))
}

/// The environment digest of pages that JavaScript does not render: what
/// decides their output apart from their own files. esbuild minifies the code
/// inside pages, so its version is part of it.
pub(crate) fn page_env(loaded: &Loaded, options: &BuildOptions) -> String {
	kd_hash::to_hex(&kd_hash::sha256(
		format!(
			"{}\0{}\0html-pipeline\0{}",
			crate::VERSION,
			loaded.config_hash,
			options.esbuild_version.as_deref().unwrap_or_default()
		)
		.as_bytes(),
	))
}

/// The compiled layout a page names. `walk` follows the imports of modules
/// that were compiled before (see `Modules::compile_closure`).
pub(crate) fn layout_module(
	config: &kd_config::Config,
	modules: &Modules,
	page: &Page,
	walk: bool,
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
	let mut tried = Vec::new();
	for ext in [".tsx", ".jsx"] {
		let path = format!("{}/{name}{ext}", dir.trim_end_matches('/'));
		if fs::metadata(&path).is_ok_and(|m| m.is_file()) {
			let compiled = if walk {
				modules.compile_closure(&path)?
			} else {
				modules.compile(&path)?
			};
			if !compiled.has_default_export {
				return Err(format!(
					"{path}: a layout must `export default` a component"
				));
			}
			let mut closure = modules.closure(&path);
			// `.tsx` wins over `.jsx`: creating the one that lost changes the layout.
			for earlier in tried {
				closure
					.entry(earlier)
					.or_insert_with(kd_build::Dep::missing);
			}
			return Ok(Some((compiled.out_path.clone(), closure)));
		}
		tried.push(path);
	}
	Err(format!(
		"{input}: layout {name:?} not found (looked for {dir}/{name}.tsx and .jsx)"
	))
}

/// The modules of a page that JavaScript renders: its own, its layout, and the
/// fingerprints of everything either imports.
struct Compiled {
	main: Option<String>,
	/// The position of the page in the chunk `main` names, if it is one.
	entry: Option<usize>,
	layout: Option<String>,
	deps: BTreeMap<String, kd_build::Dep>,
}

fn compile_page(
	config: &kd_config::Config,
	modules: &Modules,
	page: &Page,
) -> Result<Compiled, String> {
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
	let layout = match layout_module(config, modules, page, false)? {
		Some((out, closure)) => {
			deps.extend(closure);
			Some(out)
		}
		None => None,
	};
	Ok(Compiled {
		main,
		entry: None,
		layout,
		deps,
	})
}

/// How many pages one chunk file holds. A chunk is imported by one worker, so
/// it is also the number of jobs the render workers take at a time (see
/// `RENDER_BATCH` in `render.ts`); more per file means fewer files to create
/// and load, fewer per file spreads the pages over the workers better.
pub(crate) const CHUNK_PAGES: usize = 64;

/// The code of a page that is to be a function of a chunk, and the modules it
/// takes.
struct PageFunction {
	code: String,
	modules: Vec<kd_js::ModuleRef>,
}

/// Compiles the pages of `group` and puts the ones that can be functions into
/// one chunk file. Returns the results in the order of the group, and the
/// name of the chunk written (if any).
fn compile_group(
	config: &kd_config::Config,
	modules: &Modules,
	plan: &Plan,
	group: &[usize],
) -> (Vec<Result<Compiled, String>>, Option<String>) {
	let mut results: Vec<Result<Compiled, String>> = Vec::with_capacity(group.len());
	let mut functions: Vec<PageFunction> = Vec::new();
	// The result each function belongs to, to give it its place in the chunk.
	let mut owners: Vec<usize> = Vec::new();
	for &i in group {
		let page = &plan.pages[i];
		let result = (|| {
			let mut deps = BTreeMap::new();
			let mut main = None;
			let mut function = None;
			if page.kind == PageKind::Tsx {
				let path = &page.file.input_path;
				match modules.compile_page_code(path)? {
					crate::jsx::PageCode::Function {
						code,
						modules: refs,
						compiled,
					} => {
						if !compiled.has_default_export {
							return Err(format!(
								"{path}: a page must `export default` a component"
							));
						}
						function = Some(PageFunction {
							code,
							modules: refs,
						});
					}
					crate::jsx::PageCode::Module(compiled) => {
						if !compiled.has_default_export {
							return Err(format!(
								"{path}: a page must `export default` a component"
							));
						}
						main = Some(compiled.out_path.clone());
					}
				}
				deps.extend(modules.closure(path));
			}
			let layout = match layout_module(config, modules, page, false)? {
				Some((out, closure)) => {
					deps.extend(closure);
					Some(out)
				}
				None => None,
			};
			Ok((
				Compiled {
					main,
					entry: None,
					layout,
					deps,
				},
				function,
			))
		})();
		match result {
			Ok((compiled, function)) => {
				if let Some(function) = function {
					owners.push(results.len());
					functions.push(function);
				}
				results.push(Ok(compiled));
			}
			Err(e) => results.push(Err(e)),
		}
	}
	if functions.is_empty() {
		return (results, None);
	}
	let text = chunk_text(modules.runtime(), &functions);
	let name = kd_hash::to_hex(&kd_hash::sha256(text.as_bytes()))[..24].to_owned();
	let path = format!("{}/{name}.mjs", modules.chunk_dir());
	if let Err(e) = crate::jsx::write_if_changed(&path, text.as_bytes()) {
		// Every page that depends on the chunk fails with the reason.
		for &owner in &owners {
			results[owner] = Err(e.clone());
		}
		return (results, None);
	}
	for (entry, &owner) in owners.iter().enumerate() {
		if let Ok(compiled) = &mut results[owner] {
			compiled.main = Some(path.clone());
			compiled.entry = Some(entry);
		}
	}
	(results, Some(name))
}

/// Removes the chunk files of earlier builds that this one does not use: a
/// chunk holds the pages that were compiled together, so a build that compiles
/// other pages writes other chunks and the old ones are of no use.
fn prune_chunks(dir: &str, used: &HashSet<String>) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	for entry in entries.flatten() {
		let name = entry.file_name();
		let Some(stem) = name.to_str().and_then(|n| n.strip_suffix(".mjs")) else {
			continue;
		};
		if !used.contains(stem) {
			let _ = fs::remove_file(entry.path());
		}
	}
}

/// The module of a chunk: the runtime and the modules the pages import are
/// imported once, and `pages[i]` runs the i-th page.
fn chunk_text(runtime: &str, functions: &[PageFunction]) -> String {
	let mut unique: Vec<&kd_js::ModuleRef> = Vec::new();
	let mut index: HashMap<(&str, bool), usize> = HashMap::new();
	for f in functions {
		for m in &f.modules {
			index
				.entry((m.specifier.as_str(), m.json))
				.or_insert_with(|| {
					unique.push(m);
					unique.len() - 1
				});
		}
	}
	let mut text =
		String::with_capacity(functions.iter().map(|f| f.code.len() + 64).sum::<usize>() + 1024);
	text.push_str(&format!(
		"import {{ {} }} from {};\n",
		kd_js::RUNTIME_NAMES,
		kd_js::strings::quote(runtime)
	));
	for (i, m) in unique.iter().enumerate() {
		let attributes = if m.json {
			" with { type: \"json\" }"
		} else {
			""
		};
		text.push_str(&format!(
			"import * as __kd_n{i} from {}{attributes};\n",
			kd_js::strings::quote(&m.specifier)
		));
	}
	text.push_str("export const pages = [\n");
	for f in functions {
		let args: Vec<String> = f
			.modules
			.iter()
			.map(|m| format!("__kd_n{}", index[&(m.specifier.as_str(), m.json)]))
			.collect();
		text.push_str(&format!("() => ({})([{}]),\n", f.code, args.join(", ")));
	}
	text.push_str("];\n");
	text
}

/// The environment digest of pages that JavaScript renders: they read the
/// whole page list (`nav()`, `breadcrumbs`) and the data, so a change to
/// either rebuilds them.
fn pages_digest(plan: &Plan, jobs: usize) -> String {
	// One hash per page, on several threads, then the hashes in order: the
	// digest does not depend on the order of the pages.
	let mut hashes: Vec<[u8; 32]> = parallel::map(&plan.pages, jobs, |p| {
		let mut input = String::with_capacity(p.file.url.len() + 64);
		input.push_str(&p.file.url);
		input.push('\0');
		input.push_str(&Value::Object(p.meta.clone()).to_json());
		kd_hash::sha256(input.as_bytes())
	});
	hashes.sort_unstable();
	let joined: Vec<u8> = hashes.iter().flatten().copied().collect();
	kd_hash::to_hex(&kd_hash::sha256(&joined))
}

pub(crate) fn page_json(page: &Page, date: &str) -> Value {
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

pub(crate) fn site_json(config: &kd_config::Config) -> Value {
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
	let jobs = options.jobs.unwrap_or(match config.build.jobs {
		kd_config::Jobs::Auto => std::thread::available_parallelism()
			.map(|n| n.get())
			.unwrap_or(1),
		kd_config::Jobs::Count(n) => n,
	});

	let cache_dir = kd_build::cache_dir(
		&config.root_dir,
		options
			.cache_dir
			.as_deref()
			.or(config.build.cache_dir.as_deref()),
	);
	let manifest_path = kd_build::manifest_path(&cache_dir);
	let incremental = options.incremental || config.build.incremental;
	let mut lap_at = Instant::now();
	// What the last build learned about the page files: a page whose files
	// are as it recorded is not read again. A forced build reads everything.
	let cached_plan = if incremental && !options.force {
		crate::plan_cache::load(&cache_dir)
	} else {
		None
	};
	// One walk of the input directory finds the pages, the styles and the
	// scripts.
	let scan = crate::scan(config)?;
	let (mut plan, learned) =
		crate::plan_cached(config, jobs, cached_plan.as_ref(), Some(scan.pages))?;
	if incremental
		&& learned.changed
		&& let Err(e) = crate::plan_cache::save(&cache_dir, &learned.cache)
	{
		plan.warnings.push(format!("plan cache: {e}"));
	}
	lap(&mut lap_at, "plan");
	let targets = compile_globs(&options.targets)?;
	let env = page_env(loaded, options);
	let pipeline = html::Pipeline::compile(config)?;
	let sitemap = crate::sitemap::settings(config)?;
	let data = crate::data::load(config)?;
	lap(&mut lap_at, "html pipeline and data");

	let any_js = plan.pages.iter().any(needs_js);
	let env_js = if any_js {
		kd_hash::to_hex(&kd_hash::sha256(
			format!(
				"{env}\0{}\0{}\0{runtime}",
				data.hash,
				pages_digest(&plan, jobs)
			)
			.as_bytes(),
		))
	} else {
		env.clone()
	};

	// The on-disk manifest is read whenever the build is incremental, even with
	// `force`: a forced partial build must still carry over the entries of the
	// pages it did not touch. `force` only stops them from being *used* to skip.
	let on_disk = if incremental {
		kd_build::Manifest::load(&manifest_path).unwrap_or_default()
	} else {
		kd_build::Manifest::default()
	};
	lap(&mut lap_at, "manifest load");
	// Borrowed, not cloned: the manifest of a big site is tens of megabytes.
	let nothing = kd_build::Manifest::default();
	let previous = if options.force { &nothing } else { &on_disk };

	// Decide every page.
	let fingerprinter = kd_build::Fingerprinter::new();
	let modules = Modules::new(
		&config.root_dir,
		runtime,
		&config.pages.alias,
		&config.pages.define,
	);
	// First the cheap decisions, in order: a page that is virtual, not asked
	// for or up to date needs nothing. The pages that JavaScript renders and
	// that are stale need their modules compiled, which is the expensive part
	// and is done on several threads.
	enum First {
		Done(Decision),
		Build,
		Compile,
	}
	let first: Vec<First> = parallel::map(&plan.pages, jobs, |page| {
		if page.is_virtual {
			return First::Done(Decision::Virtual);
		}
		let rel = kd_site::path::relative(&config.dir.input, &page.file.input_path);
		if !targets.is_empty() && !targets.iter().any(|t| t.matches(&rel)) {
			return First::Done(Decision::Skipped);
		}
		let page_env = if needs_js(page) { &env_js } else { &env };
		if let Some(entry) = previous.entries.get(&page.file.output_path) {
			match kd_build::check(
				entry,
				&page.file.output_path,
				&page.file.input_path,
				page_env,
				&fingerprinter,
			) {
				kd_build::Verdict::Unchanged => return First::Done(Decision::Cached(None)),
				kd_build::Verdict::UpToDate(refreshed) => {
					return First::Done(Decision::Cached(Some(refreshed)));
				}
				kd_build::Verdict::Stale => {}
			}
		}
		if needs_js(page) {
			First::Compile
		} else {
			First::Build
		}
	});
	// The pages that have to be built need their bodies, which the plan cache
	// does not keep.
	let needing_body: Vec<usize> = first
		.iter()
		.enumerate()
		.filter(|(_, f)| matches!(f, First::Build | First::Compile))
		.map(|(i, _)| i)
		.collect();
	crate::load_bodies(&mut plan, &needing_body, jobs)?;
	let to_compile: Vec<usize> = first
		.iter()
		.enumerate()
		.filter(|(_, f)| matches!(f, First::Compile))
		.map(|(i, _)| i)
		.collect();
	// The planner read the source of the pages it did not take from its cache;
	// the compiler gets that text instead of reading the files again. What is
	// not compiled (up to date) is dropped: the plan keeps no source of a page.
	for (page, first) in plan.pages.iter_mut().zip(&first) {
		if page.kind != PageKind::Tsx {
			continue;
		}
		let text = page.body.take();
		if matches!(first, First::Compile)
			&& let Some(text) = text
			&& let Some(dep) = page.deps.get(&page.file.input_path)
		{
			modules.prefetch(&page.file.input_path, text, dep.clone());
		}
	}
	// A build puts its pages into chunk files (see `Modules::compile_page_code`);
	// the dev server renders one page at a time from the files of its modules.
	// `KD_PAGE_CHUNKS=0` turns chunks off, to compare the two.
	let chunked = !options.serving && std::env::var_os("KD_PAGE_CHUNKS").is_none_or(|v| v != "0");
	let compiled: Vec<Result<Compiled, String>> = if chunked {
		let groups: Vec<&[usize]> = to_compile.chunks(CHUNK_PAGES).collect();
		let done = parallel::map(&groups, jobs, |group| {
			compile_group(config, &modules, &plan, group)
		});
		if !done.is_empty() {
			let used: HashSet<String> = done.iter().filter_map(|(_, name)| name.clone()).collect();
			prune_chunks(&modules.chunk_dir(), &used);
		}
		done.into_iter().flat_map(|(results, _)| results).collect()
	} else {
		parallel::map(&to_compile, jobs, |&i| {
			compile_page(config, &modules, &plan.pages[i])
		})
	};
	let mut compiled = compiled.into_iter();
	let mut decisions = Vec::with_capacity(plan.pages.len());
	let mut render_jobs = Vec::new();
	for (i, (page, first)) in plan.pages.iter().zip(first).enumerate() {
		match first {
			First::Done(decision) => decisions.push(decision),
			First::Build => decisions.push(Decision::Build { render: None }),
			First::Compile => {
				// The errors come in page order, as they did when pages were
				// compiled one after the other.
				let Compiled {
					main,
					entry,
					layout,
					deps,
				} = compiled.next().expect("one result per page to compile")?;
				render_jobs.push(RenderJob {
					page: i,
					content: if main.is_none() {
						page.body.clone()
					} else {
						None
					},
					main,
					entry,
					layout,
				});
				decisions.push(Decision::Build {
					render: Some(RenderPlan { deps }),
				});
			}
		}
	}

	lap(&mut lap_at, "decide pages (modules compiled)");
	// Scripts: esbuild (JavaScript's side) builds the ones that are stale.
	let started_at = std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.unwrap_or_default();
	let time = LocalTime {
		epoch_ms: started_at.as_millis() as i64,
		offset_minutes: options.tz_offset_minutes,
	};
	let version = config.site.package_version.as_deref();
	let script_banner = config.scripts.banner.as_ref().map(|template| {
		let template = if options.serving {
			banner::DEV_BANNER
		} else {
			template
		};
		banner::for_script(template, time, version)
	});
	let script_settings = ScriptSettings::new(config, options.serving, script_banner);
	let script_settings_json = script_settings.to_json().to_json();
	let env_scripts = kd_hash::to_hex(&kd_hash::sha256(
		format!(
			"{}\0{}\0scripts\0{}\0{script_settings_json}",
			crate::VERSION,
			loaded.config_hash,
			options.esbuild_version.as_deref().unwrap_or_default()
		)
		.as_bytes(),
	));
	let style_banner = config.styles.banner.as_ref().map(|template| {
		let template = if options.serving {
			banner::DEV_BANNER
		} else {
			template
		};
		banner::for_style(template, time, version)
	});
	let style_settings = StyleSettings::new(config, style_banner, options.serving);
	let env_styles = kd_hash::to_hex(&kd_hash::sha256(
		format!(
			"{}\0{}\0styles\0{:?}",
			crate::VERSION,
			loaded.config_hash,
			style_settings
		)
		.as_bytes(),
	));
	let mut assets = assets::from_found(config, AssetKind::Style, scan.styles)?;
	assets.extend(assets::from_found(config, AssetKind::Script, scan.scripts)?);
	{
		let page_outputs: std::collections::HashSet<&str> = plan
			.pages
			.iter()
			.map(|p| p.file.output_path.as_str())
			.collect();
		if let Some(a) = assets
			.iter()
			.find(|a| page_outputs.contains(a.output_path.as_str()))
		{
			return Err(format!(
				"{}: its output {} is also the output of a page",
				a.input_path, a.output_path
			));
		}
	}
	let mut asset_decisions = Vec::with_capacity(assets.len());
	let mut script_entries = Vec::new();
	for (i, asset) in assets.iter().enumerate() {
		if !targets.is_empty() && !targets.iter().any(|t| t.matches(&asset.rel)) {
			asset_decisions.push(Decision::Skipped);
			continue;
		}
		if let Some(entry) = previous.entries.get(&asset.output_path) {
			let env = match asset.kind {
				AssetKind::Style => &env_styles,
				AssetKind::Script => &env_scripts,
			};
			match kd_build::check(
				entry,
				&asset.output_path,
				&asset.input_path,
				env,
				&fingerprinter,
			) {
				kd_build::Verdict::Unchanged => {
					asset_decisions.push(Decision::Cached(None));
					continue;
				}
				kd_build::Verdict::UpToDate(refreshed) => {
					asset_decisions.push(Decision::Cached(Some(refreshed)));
					continue;
				}
				kd_build::Verdict::Stale => {}
			}
		}
		if asset.kind == AssetKind::Style {
			asset_decisions.push(Decision::Build { render: None });
			continue;
		}
		script_entries.push(Value::Object(vec![
			("id".to_owned(), Value::Number(i as f64)),
			("input".to_owned(), Value::String(asset.input_path.clone())),
			(
				"output".to_owned(),
				Value::String(asset.output_path.clone()),
			),
		]));
		asset_decisions.push(Decision::Build { render: None });
	}
	let script_request = (!script_entries.is_empty()).then(|| {
		Value::Object(vec![
			("root".to_owned(), Value::String(config.root_dir.clone())),
			("options".to_owned(), script_settings.to_json()),
			("entries".to_owned(), Value::Array(script_entries)),
		])
		.to_json()
	});

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

	lap(&mut lap_at, "assets and context");
	let page_count = plan.pages.len();
	let asset_count = assets.len();
	Ok(Prepared {
		shared: Arc::new(Shared {
			plan,
			env,
			env_js,
			env_scripts,
			env_styles,
			style_settings,
			pipeline,
			minifiers: Minifiers::new(
				options.esbuild_binary.clone(),
				options.esbuild_version.as_deref().unwrap_or_default(),
				Some(cache_dir.clone()),
			),
			targets,
			skip_unchanged: options.skip_unchanged || config.build.skip_unchanged,
			assets,
			sitemap,
			asset_decisions,
			fingerprinter: kd_build::Fingerprinter::new(),
			started_at: (started_at.as_secs() as i64, started_at.subsec_nanos()),
			results: Mutex::new((0..page_count).map(|_| None).collect()),
			asset_results: Mutex::new((0..asset_count).map(|_| None).collect()),
		}),
		decisions,
		on_disk,
		manifest_path,
		incremental,
		jobs,
		started,
		render_jobs,
		context,
		script_request,
	})
}

/// Prints how long a phase took when `KD_TIMING` is set (a development aid for
/// finding where a build spends its time), and starts the next one.
fn lap(last: &mut Instant, what: &str) {
	if std::env::var_os("KD_TIMING").is_some() {
		eprintln!("  core {what}: {}ms", last.elapsed().as_millis());
	}
	*last = Instant::now();
}

/// The current time as an ISO 8601 string (UTC), for `page.date`.
pub(crate) fn now_iso() -> String {
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

	/// What esbuild has to build, as JSON: `{ root, options, entries: [{ id,
	/// input, output }] }`. `None` when no script is stale.
	#[must_use]
	pub fn script_request_json(&self) -> Option<&str> {
		self.script_request.as_deref()
	}

	/// Runs the HTML stages for every page that has to be built, writes the
	/// outputs and the manifest and returns the report. `rendered` holds the
	/// HTML JavaScript produced for each job (by page index); `scripts` what
	/// esbuild produced for the request of [`Prepared::script_request_json`].
	///
	/// # Errors
	///
	/// A message for a missing rendering or script, any page error (the build
	/// stops at the first one), or a file that cannot be written.
	pub fn finish(
		self,
		rendered: Vec<(usize, String)>,
		scripts: Vec<ScriptOutput>,
	) -> Result<Report, String> {
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
			script_request: _,
		} = self;
		let mut script_by_asset: Vec<Option<ScriptOutput>> = vec![None; shared.assets.len()];
		for output in scripts {
			let id = output.id;
			match script_by_asset.get_mut(id) {
				Some(slot) => *slot = Some(output),
				None => return Err(format!("a script output for {id}, which does not exist")),
			}
		}
		for (i, decision) in shared.asset_decisions.iter().enumerate() {
			if matches!(decision, Decision::Build { .. })
				&& shared.assets[i].kind == AssetKind::Script
				&& script_by_asset[i].is_none()
			{
				return Err(format!(
					"{}: the script was not built",
					shared.assets[i].input_path
				));
			}
		}
		let script_by_asset = Arc::new(script_by_asset);
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
		let mut lap_at = Instant::now();
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
			for i in 0..shared.assets.len() {
				let shared = Arc::clone(&shared);
				let script_by_asset = Arc::clone(&script_by_asset);
				s.spawn(move || {
					let outcome = finish_asset(&shared, i, script_by_asset[i].as_ref());
					shared
						.asset_results
						.lock()
						.unwrap_or_else(|e| e.into_inner())[i] = Some(outcome);
				});
			}
		});
		lap(&mut lap_at, "finish: pages and assets");
		drop(pool);
		lap(&mut lap_at, "finish: pool stopped");
		let shared = Arc::try_unwrap(shared)
			.ok()
			.expect("all jobs finished with the pool");
		let results = shared
			.results
			.into_inner()
			.unwrap_or_else(|e| e.into_inner());

		let asset_results = shared
			.asset_results
			.into_inner()
			.unwrap_or_else(|e| e.into_inner());
		// A failure stops the build, but the pages that did finish have written
		// their outputs. Their old manifest entries would claim the bytes that
		// are no longer there: put the source back as it was and the entry
		// matches again while the output still has the newer bytes. They are
		// dropped from the manifest, so the next build writes them again.
		let failed = results.iter().flatten().any(Result::is_err)
			|| asset_results.iter().flatten().any(Result::is_err);
		if failed {
			if incremental {
				let mut stale = on_disk;
				for (result, _, _) in results.iter().flatten().flatten() {
					if matches!(result.status, Status::Built | Status::Unchanged) {
						stale.entries.remove(&result.output_path);
					}
				}
				for (result, _) in asset_results.iter().flatten().flatten() {
					if matches!(result.status, Status::Built | Status::Unchanged) {
						stale.entries.remove(&result.output_path);
					}
				}
				// Best effort: the build's own error is what the caller needs.
				let _ = stale.save(&manifest_path);
			}
			let error = results
				.into_iter()
				.flatten()
				.find_map(Result::err)
				.or_else(|| asset_results.into_iter().flatten().find_map(Result::err));
			return Err(error.expect("a failure was found above"));
		}
		let mut report = Report {
			pages: Vec::with_capacity(page_count),
			assets: Vec::with_capacity(asset_results.len()),
			warnings: shared.plan.warnings.clone(),
			elapsed_ms: 0,
		};
		// A partial build (targets) keeps the entries it did not touch. Any
		// other build starts a manifest of its own, and the entries that are
		// up to date are moved over from the old one: with a hundred thousand
		// pages, copying them is the cost of an up-to-date build.
		let (mut next, mut carried) = if shared.targets.is_empty() {
			(kd_build::Manifest::default(), on_disk.entries)
		} else {
			(on_disk, std::collections::BTreeMap::new())
		};
		// Whether the manifest differs from the one on disk: an up-to-date build
		// leaves it alone instead of writing the same tens of megabytes again.
		let mut dirty = false;
		for outcome in results.into_iter().flatten() {
			let (result, entry, warnings) = outcome?;
			report.warnings.extend(warnings);
			match entry {
				Some(entry) => {
					dirty = true;
					next.entries.insert(result.output_path.clone(), entry);
				}
				None if result.status == Status::Cached => {
					if let Some(kept) = carried.remove(&result.output_path) {
						next.entries.insert(result.output_path.clone(), kept);
					}
				}
				None => {
					dirty |= !matches!(result.status, Status::Virtual | Status::Skipped);
				}
			}
			report.pages.push(result);
		}
		for outcome in asset_results.into_iter().flatten() {
			let (result, entry) = outcome?;
			match entry {
				Some(entry) => {
					dirty = true;
					next.entries.insert(result.output_path.clone(), entry);
				}
				None if result.status == Status::Cached => {
					if let Some(kept) = carried.remove(&result.output_path) {
						next.entries.insert(result.output_path.clone(), kept);
					}
				}
				None => {
					dirty |= !matches!(result.status, Status::Virtual | Status::Skipped);
				}
			}
			report.assets.push(result);
		}
		lap(&mut lap_at, "finish: report assembled");
		if let Some(settings) = &shared.sitemap {
			let xml = sitemap::render(settings, &shared.plan.pages);
			write_output(&settings.output_path, xml.as_bytes(), shared.skip_unchanged)?;
		}
		// Entries nobody claimed belong to pages that are gone.
		if incremental && (dirty || !carried.is_empty()) {
			next.save(&manifest_path)
				.map_err(|e| format!("cannot write {manifest_path}: {e}"))?;
		}
		lap(&mut lap_at, "finish: sitemap and manifest");
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
			return Ok((result(Status::Cached), entry.clone(), Vec::new()));
		}
		Decision::Build { render } => render,
	};
	let source = match rendered {
		Some(html) => html,
		None => page.body.as_deref().unwrap_or_default(),
	};
	let out = shared.pipeline.process(
		&html::PageInput {
			source,
			url: &page.file.url,
			input_path: &page.file.input_path,
			phase: kd_html::inject::Phase::Build,
		},
		&shared.minifiers,
	)?;
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

/// What was built for an asset: its text, what it was read from, and whether
/// the fingerprints can vouch for the text.
struct AssetBuild {
	text: String,
	deps: BTreeMap<String, kd_build::Dep>,
	settled: bool,
}

/// The bundle esbuild made for a script. esbuild reads its inputs on its own,
/// so their fingerprints are taken afterwards. An input modified since the
/// build began may have been read before the edit; recording it would let the
/// next build call the output current, so such an output is not `settled` and
/// gets no entry: it is rebuilt next time.
fn script_build(shared: &Shared, asset: &Asset, output: &ScriptOutput) -> AssetBuild {
	let mut deps = BTreeMap::new();
	let mut settled = true;
	for input in output.inputs.iter().chain([&asset.input_path]) {
		let dep = shared.fingerprinter.fingerprint(input);
		if dep.hash != kd_build::MISSING_FILE_HASH
			&& (dep.mtime_sec, dep.mtime_nsec) >= shared.started_at
		{
			settled = false;
		}
		deps.insert(input.clone(), dep);
	}
	AssetBuild {
		text: output.code.clone(),
		deps,
		settled,
	}
}

/// Writes a script or a stylesheet and records what it was built from.
fn finish_asset(shared: &Shared, i: usize, script: Option<&ScriptOutput>) -> AssetOutcome {
	let asset = &shared.assets[i];
	let result = |status| AssetResult {
		kind: asset.kind,
		input_path: asset.input_path.clone(),
		output_path: asset.output_path.clone(),
		status,
	};
	match &shared.asset_decisions[i] {
		Decision::Virtual | Decision::Skipped => return Ok((result(Status::Skipped), None)),
		Decision::Cached(entry) => return Ok((result(Status::Cached), entry.clone())),
		Decision::Build { .. } => {}
	}
	let (built, env) = match asset.kind {
		AssetKind::Script => {
			let output =
				script.ok_or_else(|| format!("{}: the script was not built", asset.input_path))?;
			(script_build(shared, asset, output), &shared.env_scripts)
		}
		AssetKind::Style => {
			let style = style::build(
				&asset.input_path,
				&asset.output_path,
				&shared.style_settings,
			)?;
			// The files were fingerprinted as they were read.
			(
				AssetBuild {
					text: style.css,
					deps: style.deps,
					settled: true,
				},
				&shared.env_styles,
			)
		}
	};
	let bytes = built.text.as_bytes();
	let status = write_output(&asset.output_path, bytes, shared.skip_unchanged)?;
	let entry = built.settled.then(|| kd_build::Entry {
		input_path: asset.input_path.clone(),
		env: env.clone(),
		output_size: bytes.len() as u64,
		deps: built.deps,
	});
	Ok((result(status), entry))
}

/// Runs a build that needs no JavaScript and returns the report. A site with
/// JSX pages, layouts or scripts needs a renderer: use [`prepare`] and
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
	if prepared.script_request_json().is_some() {
		return Err(
			"scripts need esbuild, which this build does not have; run the build from the JavaScript package"
				.to_owned(),
		);
	}
	let config = &loaded.config;
	let report = prepared.finish(Vec::new(), Vec::new())?;
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
