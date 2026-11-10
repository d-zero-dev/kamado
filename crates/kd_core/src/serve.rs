//! The dev server's engine: what a request for a URL turns into.
//!
//! Nothing is watched and nothing is written. The site is planned when the server opens; a
//! request checks the fingerprints of the files its answer was built from
//! (stat first, so an unchanged file costs one `stat`), and builds the answer
//! again only when one of them changed. The answers are kept in memory.
//!
//! Pages that JavaScript renders are a round trip: [`Serve::request`] returns
//! a [`Render`] describing the job, the caller renders it and hands the HTML
//! back to [`Serve::finish_render`]. The same goes for scripts, which esbuild
//! builds on the JavaScript side.
//!
//! The plan (the list of pages) is made again by a request, and only in these cases:
//! `pages.overrides` has another size or modification time when a page is asked for (the
//! files of the pages are read again by their stat, with no walk of the input directory); the
//! file of the page that is asked for is gone (a walk) or its `outputPathField` says another
//! path now (the stat of the files); and a URL that could be a page is not in the plan while a
//! directory that would hold its file has changed since the last walk, or the config has an
//! `outputPathField` (a walk: `Serve::plan_for_miss` says which URLs, and how often). A miss
//! that is no page (a `/favicon.ico`) is a 404 and nothing is looked at. A plan that is asked
//! for soon after another waits out `REPLAN_THROTTLE`. What the new plan does to what the
//! server kept is in `Serve::replan`. A request whose plan cannot be made is a 500 with the
//! reason, and the plan stays as it was.
//!
//! What a request does not notice, by design: a change to the config, to `html.*`, and a style
//! or script file that is new or removed (they take a restart), and a change to the metadata
//! of *another* page (a page notices it when its own files change or when it is asked for
//! after a page with new metadata was; the navigation in a page rendered before that stays as
//! it was until the page itself is rebuilt).
//!
//! Why modules are recompiled lazily: `Modules::refresh` forgets the modules of
//! the requested page whose source changed and the closure is compiled again.
//! Node cannot unload a module, so when any module changed the caller is told
//! to restart its renderer (`Render::restart`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use kd_jsonc::Value;
use kd_site::meta::Overrides;

use crate::assets::{self, Asset, AssetKind, ScriptSettings};
use crate::banner::{self, LocalTime};
use crate::html;
use crate::jsx::Modules;
use crate::minifiers::Minifiers;
use crate::plan_cache::PlanCache;
use crate::session::{
	RenderJob, ScriptOutput, layout_module, needs_js, now_iso, page_env, page_json, site_json,
};
use crate::style::{self, StyleSettings};
use crate::{BuildOptions, Loaded, Page, PageKind};

/// How to answer a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
	/// A response body that is ready. It is a `String`, so it is UTF-8: the
	/// caller sends it with `charset=utf-8`.
	Text {
		/// `text/html`, `text/css`, `text/javascript`. `text/html` is also a
		/// static `.html`/`.htm` of the output directory that `html.inject`
		/// wrote into.
		content_type: &'static str,
		body: String,
	},
	/// A file of the output directory, to be sent as it is (a static HTML that
	/// no `html.inject` writes into too). Its bytes are not read here, so the
	/// caller sends it with no `charset` and the file's own declaration decides.
	File {
		path: String,
	},
	/// A page JavaScript has to render first.
	Render(Render),
	/// A script esbuild has to build first.
	Script(ScriptWork),
	/// The path leads out of the output directory.
	Forbidden,
	NotFound,
}

/// A page to render.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Render {
	/// Hands the result back to [`Serve::finish_render`].
	pub token: u64,
	pub job: RenderJob,
	/// Modules changed: the renderer must be started again (Node cannot
	/// unload a module) and given the whole context.
	pub restart: bool,
	/// The whole context as JSON, when the renderer has none yet or was
	/// restarted.
	pub context: Option<String>,
	/// What changed since the last render, as JSON `{ pages: [[index,
	/// page], ...], data: ... | null }`, when the renderer has a context.
	pub update: Option<String>,
}

/// A script to build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptWork {
	/// Hands the result back to [`Serve::finish_script`].
	pub token: u64,
	/// The request, as `Prepared::script_request_json` makes it.
	pub request: String,
}

/// A built answer and what it was built from.
struct Cached {
	body: String,
	entry: kd_build::Entry,
}

/// A request waiting for JavaScript.
enum Pending {
	Page {
		index: usize,
		/// The fingerprints of the modules the render uses.
		deps: BTreeMap<String, kd_build::Dep>,
		/// The environment when the render was requested. Metadata or data
		/// may change while the worker renders; the result belongs to the
		/// environment it was rendered in, so a later request sees it stale.
		env: String,
	},
	Script {
		index: usize,
		started_at: (i64, u32),
	},
}

/// The least time between a plan and the next one a miss asks for: a build tool that writes
/// into the input directory all the time must not make every missed URL a walk of it. A
/// miss that comes sooner waits out the rest (this long at most) and then plans: answering
/// 404 instead would lose a page that was created a moment ago.
const REPLAN_THROTTLE: Duration = Duration::from_millis(200);

/// How long a URL that a plan made for it did not find is remembered, where the URLs are
/// those of a path field of the metadata (the directories do not tell a change there, so
/// every such miss walks the input directory): a broken link asked for again and again must
/// not stop a big site each time.
const FIELD_MISS_MEMORY: Duration = Duration::from_secs(2);

/// `(size, mtime_sec, mtime_nsec)` of a file, as `kd_build::file_stat` gives it.
type Stamp = (u64, i64, u32);

/// Directories with their modification times, `(seconds, nanoseconds)`.
type DirTimes = Vec<(String, (i64, u32))>;

/// What a miss that may be a page asks for (`Serve::plan_for_miss`).
struct MissPlan {
	scope: Scope,
	/// The directories the miss looked at, with the times it saw them with.
	looked: DirTimes,
	/// The output path to remember as not found, where the URLs are set by a path field.
	field_url: Option<String>,
}

/// The time since the epoch.
fn since_epoch() -> Duration {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
}

/// The directories whose time is not within the grain of the modification times before `now`:
/// another change to a directory within it would carry the time the directory has, so a time
/// that new is not remembered (the next look takes the directory as changed).
fn settled(looked: DirTimes, now: Duration) -> DirTimes {
	let floor = crate::racy_floor(now);
	looked
		.into_iter()
		.filter(|(_, mtime)| *mtime < floor)
		.collect()
}

/// Whether `dir` is `root` or below it (`/site/src2` is not below `/site/src`).
fn is_within(dir: &str, root: &str) -> bool {
	dir == root
		|| dir
			.strip_prefix(root.trim_end_matches('/'))
			.is_some_and(|rest| rest.starts_with('/'))
}

/// How much of the plan is made again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
	/// The pages found by the last walk are read again (the files that changed, by their
	/// stat) and put together with `pages.overrides`: the input directory is not walked.
	Assemble,
	/// The input directory is walked first.
	Walk,
}

/// What `Serve::page` makes of a request.
enum Outcome {
	Served(Served),
	/// The plan is not what the page's files say: it has to be made again, and the request
	/// looked at again.
	Replan(Scope),
}

/// What reading a page's files again found.
enum Reload {
	/// The page is up to date, or was read again.
	Done,
	/// The input file is gone: the plan has to be walked again.
	Gone,
	/// The `outputPathField` of the page says another output path than the plan has: the page
	/// is somewhere else, and two pages may now want the same path, so every page is put
	/// together again.
	Moved,
}

struct State {
	plan: crate::Plan,
	overrides: Option<Overrides>,
	/// `pages.overrides` as it was when the plan was made; the file is another plan when it
	/// differs.
	overrides_stamp: Option<Stamp>,
	/// The file was not written within the grain of the modification times before the plan
	/// began: a rewrite of the same size right after would carry the same time and go
	/// unseen, so a file that is not settled is another plan at the next request.
	overrides_settled: bool,
	/// The output paths a plan made for them did not find, and when (see
	/// `FIELD_MISS_MEMORY`).
	field_missed: HashMap<String, Instant>,
	/// What the last walk of the input directory found (page files, relative to it).
	found: Vec<String>,
	/// When the last walk began, as time since the epoch.
	walked_at: Duration,
	/// What the pages' files said when the plan was made: a plan made again reads only the
	/// files that are not as it recorded. It is kept in memory and never written (nothing
	/// is).
	plan_cache: PlanCache,
	/// The modification time of the directories a miss looked at, as they were when the plan
	/// held what they had (a walk, or a look that saw nothing changed).
	seen_dirs: HashMap<String, (i64, u32)>,
	/// When a plan was last made (or tried); `None` before any miss asked.
	last_replan: Option<Instant>,
	by_output: HashMap<String, usize>,
	assets: Vec<Asset>,
	asset_by_output: HashMap<String, usize>,
	/// `page.date` of every page: the start of the server.
	date: String,
	data: crate::data::Data,
	data_stamp: String,
	/// Counts the changes to the metadata of pages; part of the environment
	/// of pages JavaScript renders (they can read the whole page list).
	epoch: u64,
	cache: HashMap<usize, Cached>,
	asset_cache: HashMap<usize, Cached>,
	pending: HashMap<u64, Pending>,
	/// Counts recompiled modules; the renderer is restarted when it lags.
	code_epoch: u64,
	renderer_code_epoch: u64,
	/// The renderer needs the whole context (it has none, or was restarted).
	context_full: bool,
	dirty_pages: BTreeSet<usize>,
	data_dirty: bool,
}

/// The engine of the dev server.
pub struct Serve {
	loaded: Loaded,
	options: BuildOptions,
	runtime: String,
	pipeline: html::Pipeline,
	minifiers: Minifiers,
	modules: Modules,
	env: String,
	/// The threads a plan reads the page files with.
	jobs: usize,
	/// How many plans one request may make: `pages.overrides` and then a page that is gone or
	/// moved. A test lowers it to reach the error of a page that keeps changing, which cannot
	/// be made to happen by editing files.
	plans_per_request: usize,
	next_token: AtomicU64,
	/// How many plans were tried after the first, failed ones too (a test counts them; the
	/// field is there in every build so that the struct is the one that is tested).
	#[cfg_attr(not(test), allow(dead_code))]
	replans: AtomicU64,
	state: Mutex<State>,
}

/// The stat of the `pages.overrides` file, if the config names one and it exists.
fn overrides_stamp(config: &kd_config::Config) -> Option<Stamp> {
	config
		.pages
		.overrides
		.as_deref()
		.and_then(kd_build::file_stat)
}

/// Whether a file with this stamp was last written before the grain of the modification
/// times ran out at `taken_at` (time since the epoch): later, a rewrite of the same size
/// could carry the same time. A file that is not there (`None`) has nothing to be unsettled.
fn stamp_settled(stamp: Option<Stamp>, taken_at: Duration) -> bool {
	stamp.is_none_or(|(_, sec, nsec)| (sec, nsec) < crate::racy_floor(taken_at))
}

/// The index of every page that has an output file, by output path.
fn by_output_of(plan: &crate::Plan) -> HashMap<String, usize> {
	plan.pages
		.iter()
		.enumerate()
		.filter(|(_, p)| !p.is_virtual)
		.map(|(i, p)| (p.file.output_path.clone(), i))
		.collect()
}

/// What names a page that is rendered across plans, since the index in the list does not: its
/// input file. (A page without one has no output file and is never asked for.)
fn page_key(page: &Page) -> &str {
	&page.file.input_path
}

/// The value of `field` in a page's metadata as the path of an output file (what a plan reads
/// it as), or `None`.
fn output_path_value<'a>(meta: &'a kd_site::meta::Meta, field: &str) -> Option<&'a str> {
	meta.iter()
		.find(|(k, _)| k == field)
		.and_then(|(_, v)| v.as_str())
		.filter(|p| !p.is_empty())
}

/// The modification time of a directory, as `(seconds, nanoseconds)`.
fn dir_mtime(path: &str) -> Option<(i64, u32)> {
	let meta = fs::metadata(path).ok()?;
	if !meta.is_dir() {
		return None;
	}
	let d = meta.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
	Some((d.as_secs() as i64, d.subsec_nanos()))
}

/// The URL a static file has for `html.inject` and `html.overrides` (the
/// `pages` globs match it): its path from the output directory with a
/// leading `/`, and `/dir/` for the file named `index<output_extension>`.
fn static_url(rel: &str, output_extension: &str) -> String {
	let index = format!("index{output_extension}");
	match rel.rsplit_once('/') {
		Some((dir, name)) if name == index => format!("/{dir}/"),
		None if rel == index => "/".to_owned(),
		_ => format!("/{rel}"),
	}
}

/// A percent-decoded path, or `None` when it is not valid UTF-8 or holds a NUL.
fn percent_decode(path: &str) -> Option<String> {
	let bytes = path.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' {
			let hex = path.get(i + 1..i + 3)?;
			out.push(u8::from_str_radix(hex, 16).ok()?);
			i += 3;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	let decoded = String::from_utf8(out).ok()?;
	(!decoded.contains('\0')).then_some(decoded)
}

impl Serve {
	/// Plans the site and prepares everything a request needs.
	///
	/// # Errors
	///
	/// Any error of the plan, the HTML options, or the data directory.
	pub fn open(loaded: Loaded, options: BuildOptions, runtime: &str) -> Result<Serve, String> {
		let config = &loaded.config;
		let jobs = std::thread::available_parallelism().map_or(1, |n| n.get());
		let walked_at = since_epoch();
		let overrides_stamp = overrides_stamp(config);
		let overrides_settled = stamp_settled(overrides_stamp, walked_at);
		let overrides = crate::read_overrides(config)?;
		let found = crate::discover_pages(config)?;
		let (plan, learned) = crate::plan_with_overrides(
			config,
			jobs,
			None,
			Some(found.clone()),
			overrides.as_ref(),
		)?;
		let assets = {
			let mut assets = assets::discover(config, AssetKind::Style)?;
			assets.extend(assets::discover(config, AssetKind::Script)?);
			assets
		};
		let by_output = by_output_of(&plan);
		let asset_by_output = assets
			.iter()
			.enumerate()
			.map(|(i, a)| (a.output_path.clone(), i))
			.collect();
		let cache_dir = kd_build::cache_dir(
			&config.root_dir,
			options
				.cache_dir
				.as_deref()
				.or(config.build.cache_dir.as_deref()),
		);
		let env = page_env(&loaded, &options);
		Ok(Serve {
			pipeline: html::Pipeline::compile(config)?,
			minifiers: Minifiers::new(
				options.esbuild_binary.clone(),
				options.esbuild_version.as_deref().unwrap_or_default(),
				Some(cache_dir),
			),
			modules: Modules::new(
				&config.root_dir,
				runtime,
				&config.pages.alias,
				&config.pages.define,
			),
			env,
			jobs,
			plans_per_request: 2,
			next_token: AtomicU64::new(1),
			replans: AtomicU64::new(0),
			state: Mutex::new(State {
				plan,
				overrides,
				overrides_stamp,
				overrides_settled,
				field_missed: HashMap::new(),
				found,
				walked_at,
				plan_cache: learned.cache,
				seen_dirs: HashMap::new(),
				last_replan: None,
				by_output,
				assets,
				asset_by_output,
				date: now_iso(),
				data: crate::data::load(config)?,
				data_stamp: crate::data::stamp(config),
				epoch: 0,
				cache: HashMap::new(),
				asset_cache: HashMap::new(),
				pending: HashMap::new(),
				code_epoch: 0,
				renderer_code_epoch: 0,
				context_full: true,
				dirty_pages: BTreeSet::new(),
				data_dirty: false,
			}),
			runtime: runtime.to_owned(),
			options,
			loaded,
		})
	}

	/// The config the server was opened with.
	#[must_use]
	pub fn config(&self) -> &kd_config::Config {
		&self.loaded.config
	}

	/// How many plans were tried after the first.
	#[cfg(test)]
	fn replans(&self) -> u64 {
		self.replans.load(Ordering::Relaxed)
	}

	fn lock(&self) -> std::sync::MutexGuard<'_, State> {
		self.state.lock().unwrap_or_else(|e| e.into_inner())
	}

	fn token(&self) -> u64 {
		self.next_token.fetch_add(1, Ordering::Relaxed)
	}

	/// The environment digest of pages JavaScript renders.
	fn env_js(&self, st: &State) -> String {
		kd_hash::to_hex(&kd_hash::sha256(
			format!(
				"{}\0{}\0{}\0{}",
				self.env, st.data.hash, st.epoch, self.runtime
			)
			.as_bytes(),
		))
	}

	/// Answers a request for `url_path` (a path, percent-encoded as it came
	/// in; query and fragment are ignored). A page or asset the build makes
	/// is built; any other file of the output directory is sent as it is,
	/// except that a static `.html`/`.htm` gets the `html.inject` entries of
	/// `mode` `serve` and `both` that match it written in.
	///
	/// A request may make the plan of the site again first (see the module's documentation), which
	/// takes as long as a plan of the site takes, and holds the other requests meanwhile.
	///
	/// # Errors
	///
	/// The message to send with a 500: a page or style that cannot be built, a plan that cannot
	/// be made again (`pages.overrides` that cannot be read, a page file with invalid front
	/// matter), or a page that kept changing while the plan was made again.
	///
	/// # Example
	///
	/// ```no_run
	/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
	/// let serve = kd_core::serve::Serve::open(loaded, kd_core::BuildOptions::default(), "file:///rt.js").unwrap();
	/// match serve.request("/about/").unwrap() {
	///     kd_core::serve::Served::Text { body, .. } => println!("{} bytes", body.len()),
	///     other => println!("{other:?}"),
	/// }
	/// ```
	pub fn request(&self, url_path: &str) -> Result<Served, String> {
		self.request_as(url_path, true)
	}

	/// Like [`Serve::request`], telling whether the caller still has the
	/// renderer it was given the context for. A caller that lost it (the worker
	/// crashed) gets the whole context with the next render.
	///
	/// # Errors
	///
	/// As [`Serve::request`].
	pub fn request_as(&self, url_path: &str, renderer_started: bool) -> Result<Served, String> {
		// The query and the fragment end the path before it is decoded: a
		// `%3F` in a file name is a character of the name, not the start of a query.
		let raw = url_path
			.find(['?', '#'])
			.map_or(url_path, |i| &url_path[..i]);
		let Some(decoded) = percent_decode(raw) else {
			return Ok(Served::NotFound);
		};
		// A backslash separates directories on some systems (and `..%5C` would
		// climb out of the output directory there); no URL of ours has one.
		if decoded.contains('\\') {
			return Ok(Served::NotFound);
		}
		let config = &self.loaded.config;
		// `/` is the index of the extension the pages are written with.
		let local = kd_site::path_to_local_path(&decoded, &config.pages.output_extension);
		let output_dir = kd_site::path::normalize(&config.dir.output);
		let path = kd_site::path::join(&output_dir, &local);
		if path != output_dir
			&& !path.starts_with(&format!("{}/", output_dir.trim_end_matches('/')))
		{
			return Ok(Served::Forbidden);
		}
		let mut st = self.lock();
		if !renderer_started {
			st.context_full = true;
		}
		// What a plan made again changes is looked at again. Two are all a request can need
		// (`pages.overrides`, then a page that is gone or moved), so a site that changes under
		// the request as fast as it plans does not hold it for ever: it is an error to ask again.
		let mut plans = 0;
		loop {
			if let Some(&index) = st.by_output.get(&path) {
				// `pages.overrides` is the business of pages only: a half-written file must not turn
				// every image and stylesheet into a 500.
				if plans == 0 && self.overrides_changed(&st) {
					self.replan(&mut st, Scope::Assemble)?;
					plans += 1;
					continue;
				}
				// Data is read for pages that JavaScript renders; a data file that
				// does not parse must not turn every image and stylesheet into a 500.
				if needs_js(&st.plan.pages[index]) {
					self.refresh_data(&mut st)?;
				}
				match self.page(&mut st, index)? {
					Outcome::Served(served) => return Ok(served),
					Outcome::Replan(_) if plans >= self.plans_per_request => {
						return Err(format!(
							"{path}: the page kept changing while the plan was made again; ask again"
						));
					}
					Outcome::Replan(scope) => {
						self.replan(&mut st, scope)?;
						plans += 1;
						continue;
					}
				}
			}
			if let Some(&index) = st.asset_by_output.get(&path) {
				return self.asset(&mut st, index);
			}
			// Not after a plan made for this request: it read every page file again (and a walk
			// saw every directory), so a miss that is still a miss is a miss.
			if plans == 0
				&& let Some(miss) = self.plan_for_miss(&mut st, &local, &path)
			{
				// The rest of the throttle is waited out without the state (at most a fifth of a
				// second): what changes meanwhile is what the plan reads.
				let wait = st.last_replan.map_or(Duration::ZERO, |at| {
					REPLAN_THROTTLE.saturating_sub(at.elapsed())
				});
				if !wait.is_zero() {
					drop(st);
					std::thread::sleep(wait);
					st = self.lock();
				}
				self.replan(&mut st, miss.scope)?;
				// Only once the plan is made: a plan that failed must be tried again by the next
				// request, not remembered as one that found nothing.
				st.seen_dirs.extend(settled(miss.looked, since_epoch()));
				if let Some(url) = miss.field_url {
					st.field_missed.insert(url, Instant::now());
				}
				plans += 1;
				continue;
			}
			break;
		}
		drop(st);
		if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
			return Ok(Served::NotFound);
		}
		Ok(match self.inject_into_static(&path, &output_dir) {
			Some(body) => Served::Text {
				content_type: "text/html",
				body,
			},
			None => Served::File { path },
		})
	}

	/// The static HTML file at `path` (inside `output_dir`, both normalized by
	/// `kd_site::path`) with the `mode: serve` and `mode: both` injections
	/// written into it. `None` when it is sent as it is: it is not `.html` or
	/// `.htm`, no injection applies to its URL (it is not even read then), it
	/// cannot be read or is not UTF-8 (nothing is converted; the Node side
	/// reports a file that cannot be read when it opens it), or nothing was
	/// written (a fragment, or the markup is there already). `path` is inside
	/// `output_dir` by the check of `request_as`, so the prefix is always there.
	fn inject_into_static(&self, path: &str, output_dir: &str) -> Option<String> {
		let extension = std::path::Path::new(path).extension()?.to_str()?;
		if !extension.eq_ignore_ascii_case("html") && !extension.eq_ignore_ascii_case("htm") {
			return None;
		}
		let rel = path.strip_prefix(&format!("{}/", output_dir.trim_end_matches('/')))?;
		let url = static_url(rel, &self.loaded.config.pages.output_extension);
		let injects = self.pipeline.static_injects(&url);
		if injects.is_empty() {
			return None;
		}
		let source = String::from_utf8(fs::read(path).ok()?).ok()?;
		kd_html::inject::apply_to_text(&source, injects, kd_html::inject::Phase::Serve)
	}

	/// Reads the data again when its directory changed.
	fn refresh_data(&self, st: &mut State) -> Result<(), String> {
		let stamp = crate::data::stamp(&self.loaded.config);
		if stamp != st.data_stamp {
			st.data = crate::data::load(&self.loaded.config)?;
			st.data_stamp = stamp;
			st.data_dirty = true;
			st.cache.clear();
		}
		Ok(())
	}

	// ----- pages -----

	fn page(&self, st: &mut State, index: usize) -> Result<Outcome, String> {
		let js = needs_js(&st.plan.pages[index]);
		let env = if js {
			self.env_js(st)
		} else {
			self.env.clone()
		};
		let fingerprinter = kd_build::Fingerprinter::new();
		if let Some(cached) = st.cache.get(&index) {
			let page = &st.plan.pages[index];
			let verdict =
				kd_build::check_inputs(&cached.entry, &page.file.input_path, &env, &fingerprinter);
			if !matches!(verdict, kd_build::Verdict::Stale) {
				let cached = st.cache.get_mut(&index).expect("it was just read");
				if let kd_build::Verdict::UpToDate(refreshed) = verdict {
					cached.entry = refreshed;
				}
				return Ok(Outcome::Served(Served::Text {
					content_type: "text/html",
					body: cached.body.clone(),
				}));
			}
		}

		match self.reload(st, index)? {
			Reload::Done => {}
			Reload::Gone => return Ok(Outcome::Replan(Scope::Walk)),
			Reload::Moved => return Ok(Outcome::Replan(Scope::Assemble)),
		}
		// The reload may have changed the environment (the epoch) or whether
		// the page names a layout.
		let page = &st.plan.pages[index];
		if !needs_js(page) {
			let body = self.process(st, index, None, &BTreeMap::new(), None)?;
			return Ok(Outcome::Served(Served::Text {
				content_type: "text/html",
				body,
			}));
		}

		let config = &self.loaded.config;
		let mut deps = BTreeMap::new();
		// Why the epoch moves at once rather than after the compile: refresh
		// forgets a stale module, so a compile error that returns early would
		// otherwise lose the change and the renderer would keep the old module.
		let main = if page.kind == PageKind::Tsx {
			if self.modules.refresh(&page.file.input_path) {
				st.code_epoch += 1;
			}
			let compiled = self.modules.compile_closure(&page.file.input_path)?;
			if !compiled.has_default_export {
				return Err(format!(
					"{}: a page must `export default` a component",
					page.file.input_path
				));
			}
			deps.extend(self.modules.closure(&page.file.input_path));
			Some(compiled.out_path.clone())
		} else {
			None
		};
		let layout = if layout_name(page).is_some() {
			// A layout's modules may have changed too.
			if self.refresh_layout(config, page) {
				st.code_epoch += 1;
			}
			match layout_module(config, &self.modules, page, true)? {
				Some((out, closure)) => {
					deps.extend(closure);
					Some(out)
				}
				None => None,
			}
		} else {
			None
		};
		let restart = st.code_epoch != st.renderer_code_epoch;
		let job = RenderJob {
			page: index,
			content: if main.is_none() {
				page.body.clone()
			} else {
				None
			},
			main,
			entry: None,
			layout,
		};
		let (context, update) = self.context_for(st, restart);
		if restart {
			st.renderer_code_epoch = st.code_epoch;
		}
		let token = self.token();
		let env = self.env_js(st);
		st.pending.insert(token, Pending::Page { index, deps, env });
		Ok(Outcome::Served(Served::Render(Render {
			token,
			job,
			restart,
			context,
			update,
		})))
	}

	/// Forgets the changed modules of the layout a page names.
	fn refresh_layout(&self, config: &kd_config::Config, page: &Page) -> bool {
		let (Some(dir), Some(name)) = (&config.pages.layouts_dir, layout_name(page)) else {
			return false;
		};
		let mut changed = false;
		for ext in [".tsx", ".jsx"] {
			changed |= self
				.modules
				.refresh(&format!("{}/{name}{ext}", dir.trim_end_matches('/')));
		}
		changed
	}

	/// What the renderer needs to know before it renders: everything, or what
	/// changed.
	fn context_for(&self, st: &mut State, full: bool) -> (Option<String>, Option<String>) {
		if full || st.context_full {
			st.context_full = false;
			st.dirty_pages.clear();
			st.data_dirty = false;
			let pages: Vec<Value> = st
				.plan
				.pages
				.iter()
				.map(|p| page_json(p, &st.date))
				.collect();
			let context = Value::Object(vec![
				("site".to_owned(), site_json(&self.loaded.config)),
				("data".to_owned(), st.data.value.clone()),
				("pages".to_owned(), Value::Array(pages)),
			])
			.to_json();
			return (Some(context), None);
		}
		if st.dirty_pages.is_empty() && !st.data_dirty {
			return (None, None);
		}
		let pages: Vec<Value> = st
			.dirty_pages
			.iter()
			.map(|&i| {
				Value::Array(vec![
					Value::Number(i as f64),
					page_json(&st.plan.pages[i], &st.date),
				])
			})
			.collect();
		let data = if st.data_dirty {
			st.data.value.clone()
		} else {
			Value::Null
		};
		st.dirty_pages.clear();
		st.data_dirty = false;
		let update = Value::Object(vec![
			("pages".to_owned(), Value::Array(pages)),
			("data".to_owned(), data),
		])
		.to_json();
		(None, Some(update))
	}

	/// Reads the page's files again when they changed since it was last read
	/// (the fingerprints of `Page::deps` tell).
	///
	/// A page whose input file is gone, or whose `outputPathField` says another path than the
	/// plan has, is not reloaded: the plan is what has to change (see [`Reload`]).
	fn reload(&self, st: &mut State, index: usize) -> Result<Reload, String> {
		let fingerprinter = kd_build::Fingerprinter::new();
		let page = &st.plan.pages[index];
		if page
			.deps
			.iter()
			.all(|(path, dep)| fingerprinter.unchanged(path, dep))
		{
			// A page of a plan made from what was known has not read its body yet.
			if page.body_pending {
				crate::load_bodies(&mut st.plan, &[index], 1)?;
			}
			return Ok(Reload::Done);
		}
		if !page.is_virtual
			&& matches!(fs::metadata(&page.file.input_path), Err(e) if e.kind() == std::io::ErrorKind::NotFound)
		{
			return Ok(Reload::Gone);
		}
		let reloaded = crate::reload_page(page, st.overrides.as_ref())?;
		if let Some(field) = self.loaded.config.pages.output_path_field.as_deref()
			&& output_path_value(&page.meta, field) != output_path_value(&reloaded.meta, field)
		{
			return Ok(Reload::Moved);
		}
		let page = &mut st.plan.pages[index];
		let meta_changed = page.meta != reloaded.meta;
		page.meta = reloaded.meta;
		page.body = reloaded.body;
		page.body_pending = false;
		page.deps = reloaded.deps;
		if meta_changed {
			st.epoch += 1;
			st.dirty_pages.insert(index);
			// Pages that read the page list are stale: their environment
			// changed with the epoch.
		}
		Ok(Reload::Done)
	}

	// ----- the plan -----

	/// Whether `pages.overrides` is not the file the plan was made from (a stat).
	fn overrides_changed(&self, st: &State) -> bool {
		let config = &self.loaded.config;
		config.pages.overrides.is_some()
			&& (!st.overrides_settled || overrides_stamp(config) != st.overrides_stamp)
	}

	/// Whether a request for a URL that no page has is for a page that a plan made again may
	/// find, and what to do about it. A URL may be a page when its output path ends in the
	/// output extension (a `/dir/` and an extensionless `/about` do: they are the files
	/// `dir/index.html` and `about.html`) and no file of the output directory is at that path.
	/// Anything else (`/favicon.ico`) is not looked at.
	///
	/// A page file is created, renamed or removed in a directory, which changes that
	/// directory's modification time (not a change to the file's content; a directory renamed
	/// changes its parent's, not its own, which is why the directories above the page's file,
	/// up to the input directory, all count). A directory with a time it did not have when the
	/// last walk saw it, or when this last looked at it, may hold a page: that is a walk.
	///
	/// Where the config has a path field (`outputPathField`), the URL of a page is not where its
	/// file is, so the directories of the URL tell nothing: such a miss is a walk too, once for
	/// each URL in `FIELD_MISS_MEMORY`.
	///
	/// What this returns is for the caller to remember once the plan is made (not before: a
	/// plan that failed found nothing). `local` is the URL as a path of the output directory,
	/// `path` that path from the root.
	fn plan_for_miss(&self, st: &mut State, local: &str, path: &str) -> Option<MissPlan> {
		let config = &self.loaded.config;
		let extension = &config.pages.output_extension;
		let name = local.rsplit('/').next().unwrap_or(local);
		let page_like = if extension.is_empty() {
			!name.contains('.')
		} else {
			name.ends_with(extension.as_str())
		};
		if !page_like || fs::metadata(path).is_ok_and(|m| m.is_file()) {
			return None;
		}
		let field = config.pages.output_path_field.is_some();
		let field_url = field.then(|| path.to_owned());
		let root = kd_site::path::normalize(&config.dir.input);
		let mut dir = kd_site::path::dirname(&kd_site::path::join(&root, local));
		let floor = crate::racy_floor(st.walked_at);
		let mut changed = false;
		let mut looked = Vec::new();
		// A directory that is not there ends it: nothing is under it, and nothing above it
		// changed for a page that is not there.
		while is_within(&dir, &root) {
			let Some(mtime) = dir_mtime(&dir) else {
				break;
			};
			if st
				.seen_dirs
				.get(&dir)
				.map_or(mtime >= floor, |&known| known != mtime)
			{
				changed = true;
			}
			looked.push((dir.clone(), mtime));
			if dir == root {
				break;
			}
			dir = kd_site::path::dirname(&dir);
		}
		if changed {
			return Some(MissPlan {
				scope: Scope::Walk,
				looked,
				field_url,
			});
		}
		// What did not change is remembered now (what is known of a directory is that nothing
		// changed since the plan).
		st.seen_dirs.extend(
			settled(looked, since_epoch())
				.into_iter()
				.filter(|(dir, _)| !st.seen_dirs.contains_key(dir))
				.collect::<Vec<_>>(),
		);
		if !field {
			return None;
		}
		st.field_missed
			.retain(|_, at| at.elapsed() < FIELD_MISS_MEMORY);
		if st.field_missed.contains_key(path) {
			return None;
		}
		Some(MissPlan {
			scope: Scope::Walk,
			looked: Vec::new(),
			field_url,
		})
	}

	/// Makes the plan again, from the files as they are now, and swaps it for the old one;
	/// if that cannot be done, nothing changes and the request that asked gets the error.
	///
	/// What the new plan does to what was kept: the pages are numbered again, so every
	/// answer in `cache` is dropped (the numbers key it), the epoch moves (pages that read
	/// the page list are stale), and the renderer is given the whole context with the next
	/// render. The renders under way keep their token: each is moved to its page's new number
	/// by the page's input file (a page without one by its URL), and one whose page is gone
	/// is forgotten, so `finish_render` for it is an error. Styles, scripts, the data and the
	/// compiled modules are not part of the plan and stay as they were.
	///
	/// The files are read by their stat against `plan_cache`: the ones that changed are read,
	/// the others are taken from it. A page file that vanished makes an assembling plan
	/// fail (it was found by an earlier walk), so that one is made again as a walk.
	///
	/// A plan is synchronous and holds the state: the other requests wait for it.
	///
	/// # Errors
	///
	/// The message of what could not be read: `pages.overrides`, an unreadable or invalid page
	/// file, an invalid glob, a path that is no output path. The old plan stays.
	fn replan(&self, st: &mut State, scope: Scope) -> Result<(), String> {
		self.replans.fetch_add(1, Ordering::Relaxed);
		let made = self.make_plan(st, scope);
		// From the end, success or not: a plan of a big site takes longer than the throttle,
		// which would then never hold anything back.
		st.last_replan = Some(Instant::now());
		made
	}

	/// Whether a page file that a walk found is not a file any more: gone, or replaced by a
	/// directory (the first one ends the search).
	fn found_vanished(&self, found: &[String]) -> bool {
		let input = self.loaded.config.dir.input.trim_end_matches('/');
		found
			.iter()
			.any(|rel| match fs::metadata(format!("{input}/{rel}")) {
				Ok(meta) => !meta.is_file(),
				Err(e) => e.kind() == std::io::ErrorKind::NotFound,
			})
	}

	fn make_plan(&self, st: &mut State, scope: Scope) -> Result<(), String> {
		let started = Instant::now();
		let config = &self.loaded.config;
		// Before the read: a change between the two is another plan at the next request.
		let taken_at = since_epoch();
		let stamp = overrides_stamp(config);
		let settled = stamp_settled(stamp, taken_at);
		let overrides = crate::read_overrides(config)?;
		let known = (!st.plan_cache.pages.is_empty()).then_some(&st.plan_cache);
		let assembled = match scope {
			Scope::Assemble => {
				match crate::plan_with_overrides(
					config,
					self.jobs,
					known,
					Some(st.found.clone()),
					overrides.as_ref(),
				) {
					Ok(planned) => Some((planned, None)),
					// A page file that an earlier walk found and that is gone is what a walk
					// mends; any other failure is the same for a walk, which is not run for it.
					Err(_) if self.found_vanished(&st.found) => None,
					Err(e) => return Err(e),
				}
			}
			Scope::Walk => None,
		};
		let (planned, walk) = match assembled {
			Some(planned) => planned,
			None => {
				let walked_at = since_epoch();
				let found = crate::discover_pages(config)?;
				let planned = crate::plan_with_overrides(
					config,
					self.jobs,
					known,
					Some(found.clone()),
					overrides.as_ref(),
				)?;
				(planned, Some((found, walked_at)))
			}
		};
		let (plan, learned) = planned;
		if std::env::var_os("KD_TIMING").is_some() {
			eprintln!(
				"    replan ({}): {} pages in {}ms",
				if walk.is_some() { "walk" } else { "assemble" },
				plan.pages.len(),
				started.elapsed().as_millis()
			);
		}

		// What was waiting for a render, by the page's name, before the numbers change.
		let waiting: Vec<(u64, String)> = st
			.pending
			.iter()
			.filter_map(|(token, p)| match p {
				Pending::Page { index, .. } => {
					Some((*token, page_key(&st.plan.pages[*index]).to_owned()))
				}
				Pending::Script { .. } => None,
			})
			.collect();
		let by_key: HashMap<String, usize> = if waiting.is_empty() {
			HashMap::new()
		} else {
			plan.pages
				.iter()
				.enumerate()
				.map(|(i, p)| (page_key(p).to_owned(), i))
				.collect()
		};
		for (token, key) in waiting {
			match by_key.get(&key) {
				Some(&now) => {
					if let Some(Pending::Page { index, .. }) = st.pending.get_mut(&token) {
						*index = now;
					}
				}
				None => {
					st.pending.remove(&token);
				}
			}
		}

		// What the plan learned replaces what was kept, and it holds every page file that is
		// there (so the entries of pages that are gone go). It is empty in two cases: the plan
		// took every page from the cache it was given, which has nothing new to keep, or no
		// page file is left, which leaves nothing to keep either.
		let no_page_file_left = plan.pages.iter().all(|p| p.is_virtual);
		if !learned.cache.pages.is_empty() || no_page_file_left {
			st.plan_cache = learned.cache;
		}
		if let Some((found, walked_at)) = walk {
			st.found = found;
			st.walked_at = walked_at;
			// The walk saw every directory as it is: what was remembered of them is no use, and
			// a directory that was looked at once and never again is not kept for ever.
			st.seen_dirs.clear();
		}
		st.by_output = by_output_of(&plan);
		st.plan = plan;
		st.overrides = overrides;
		st.overrides_stamp = stamp;
		st.overrides_settled = settled;
		st.cache.clear();
		st.epoch += 1;
		st.context_full = true;
		st.dirty_pages.clear();
		Ok(())
	}

	/// Runs the HTML stages on a page and keeps the result.
	fn process(
		&self,
		st: &mut State,
		index: usize,
		rendered: Option<&str>,
		render_deps: &BTreeMap<String, kd_build::Dep>,
		requested_env: Option<String>,
	) -> Result<String, String> {
		let page = &st.plan.pages[index];
		let source = rendered.unwrap_or_else(|| page.body.as_deref().unwrap_or_default());
		let out = self.pipeline.process(
			&html::PageInput {
				source,
				url: &page.file.url,
				input_path: &page.file.input_path,
				phase: kd_html::inject::Phase::Serve,
			},
			&self.minifiers,
		)?;
		let mut deps = page.deps.clone();
		deps.extend(render_deps.clone());
		deps.extend(out.deps);
		let env = if let Some(env) = requested_env {
			env
		} else if needs_js(page) {
			self.env_js(st)
		} else {
			self.env.clone()
		};
		let entry = kd_build::Entry {
			input_path: page.file.input_path.clone(),
			env,
			output_size: out.html.len() as u64,
			deps,
		};
		st.cache.insert(
			index,
			Cached {
				body: out.html.clone(),
				entry,
			},
		);
		Ok(out.html)
	}

	/// Forgets a request whose JavaScript failed (a component threw, esbuild
	/// refused a script): nothing will be finished, and what the core kept for
	/// it would stay for ever. An unknown token is ignored.
	pub fn cancel(&self, token: u64) {
		self.lock().pending.remove(&token);
	}

	/// Takes the HTML JavaScript rendered for a [`Render`].
	///
	/// # Errors
	///
	/// An unknown token, or the message of a failing HTML stage.
	pub fn finish_render(&self, token: u64, html: &str) -> Result<Served, String> {
		let mut st = self.lock();
		let Some(Pending::Page { index, deps, env }) = st.pending.remove(&token) else {
			return Err(format!("no page is waiting for token {token}"));
		};
		let body = self.process(&mut st, index, Some(html), &deps, Some(env))?;
		Ok(Served::Text {
			content_type: "text/html",
			body,
		})
	}

	// ----- styles and scripts -----

	fn banner_time(&self) -> LocalTime {
		LocalTime {
			epoch_ms: std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |d| d.as_millis() as i64),
			offset_minutes: self.options.tz_offset_minutes,
		}
	}

	fn asset(&self, st: &mut State, index: usize) -> Result<Served, String> {
		let asset = st.assets[index].clone();
		let config = &self.loaded.config;
		let (template, content_type) = match asset.kind {
			AssetKind::Style => (&config.styles.banner, "text/css"),
			AssetKind::Script => (&config.scripts.banner, "text/javascript"),
		};
		let rendered_banner = template.as_ref().map(|_| {
			let version = config.site.package_version.as_deref();
			match asset.kind {
				AssetKind::Style => {
					banner::for_style(banner::DEV_BANNER, self.banner_time(), version)
				}
				AssetKind::Script => {
					banner::for_script(banner::DEV_BANNER, self.banner_time(), version)
				}
			}
		});
		let env = format!(
			"{}\0{:?}\0{}",
			self.loaded.config_hash,
			asset.kind,
			self.options.esbuild_version.as_deref().unwrap_or_default()
		);
		let fingerprinter = kd_build::Fingerprinter::new();
		if let Some(cached) = st.asset_cache.get(&index) {
			let verdict =
				kd_build::check_inputs(&cached.entry, &asset.input_path, &env, &fingerprinter);
			if !matches!(verdict, kd_build::Verdict::Stale) {
				let cached = st.asset_cache.get_mut(&index).expect("it was just read");
				if let kd_build::Verdict::UpToDate(refreshed) = verdict {
					cached.entry = refreshed;
				}
				return Ok(Served::Text {
					content_type,
					body: cached.body.clone(),
				});
			}
		}
		match asset.kind {
			AssetKind::Style => {
				let settings = StyleSettings::new(config, rendered_banner, true);
				let built = style::build(&asset.input_path, &asset.output_path, &settings)?;
				st.asset_cache.insert(
					index,
					Cached {
						body: built.css.clone(),
						entry: kd_build::Entry {
							input_path: asset.input_path.clone(),
							env,
							output_size: built.css.len() as u64,
							deps: built.deps,
						},
					},
				);
				Ok(Served::Text {
					content_type,
					body: built.css,
				})
			}
			AssetKind::Script => {
				let settings = ScriptSettings::new(config, true, rendered_banner);
				let request = Value::Object(vec![
					("root".to_owned(), Value::String(config.root_dir.clone())),
					("options".to_owned(), settings.to_json()),
					(
						"entries".to_owned(),
						Value::Array(vec![Value::Object(vec![
							("id".to_owned(), Value::Number(index as f64)),
							("input".to_owned(), Value::String(asset.input_path.clone())),
							(
								"output".to_owned(),
								Value::String(asset.output_path.clone()),
							),
						])]),
					),
				])
				.to_json();
				let started = std::time::SystemTime::now()
					.duration_since(std::time::UNIX_EPOCH)
					.unwrap_or_default();
				let token = self.token();
				st.pending.insert(
					token,
					Pending::Script {
						index,
						started_at: crate::racy_floor(started),
					},
				);
				Ok(Served::Script(ScriptWork { token, request }))
			}
		}
	}

	/// Takes what esbuild built for a [`ScriptWork`].
	///
	/// # Errors
	///
	/// An unknown token.
	pub fn finish_script(&self, token: u64, output: ScriptOutput) -> Result<Served, String> {
		let mut st = self.lock();
		let Some(Pending::Script { index, started_at }) = st.pending.remove(&token) else {
			return Err(format!("no script is waiting for token {token}"));
		};
		let asset = st.assets[index].clone();
		let fingerprinter = kd_build::Fingerprinter::new();
		let mut deps = BTreeMap::new();
		let mut settled = true;
		for input in output.inputs.iter().chain([&asset.input_path]) {
			let dep = fingerprinter.fingerprint(input);
			// Edited after the build began: not safe to call the answer current.
			if dep.hash != kd_build::MISSING_FILE_HASH
				&& (dep.mtime_sec, dep.mtime_nsec) >= started_at
			{
				settled = false;
			}
			deps.insert(input.clone(), dep);
		}
		if settled {
			let env = format!(
				"{}\0{:?}\0{}",
				self.loaded.config_hash,
				asset.kind,
				self.options.esbuild_version.as_deref().unwrap_or_default()
			);
			st.asset_cache.insert(
				index,
				Cached {
					body: output.code.clone(),
					entry: kd_build::Entry {
						input_path: asset.input_path.clone(),
						env,
						output_size: output.code.len() as u64,
						deps,
					},
				},
			);
		}
		Ok(Served::Text {
			content_type: "text/javascript",
			body: output.code,
		})
	}
}

/// The layout a page names (`meta.layout`), if any.
fn layout_name(page: &Page) -> Option<&str> {
	page.meta
		.iter()
		.find(|(k, _)| k == "layout")
		.and_then(|(_, v)| v.as_str())
		.filter(|n| !n.is_empty())
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Site {
		root: String,
	}

	impl Site {
		fn new(name: &str) -> Site {
			let root = format!(
				"{}/kd_serve_{name}_{}",
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
			// The fingerprints compare size and time: make sure a rewrite differs
			// even on a coarse clock.
			std::thread::sleep(std::time::Duration::from_millis(5));
		}

		fn write_bytes(&self, rel: &str, bytes: &[u8]) {
			let path = format!("{}/{rel}", self.root);
			fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
			fs::write(&path, bytes).unwrap();
		}

		fn serve(&self, extra: &str) -> Serve {
			self.write(
				"kamado.config.jsonc",
				&format!(
					r#"{{ "dir": {{ "input": "src", "output": "out" }}, "build": {{ "cacheDir": ".cache" }}{extra} }}"#
				),
			);
			let loaded = crate::load(&format!("{}/kamado.config.jsonc", self.root)).unwrap();
			Serve::open(
				loaded,
				BuildOptions {
					esbuild_version: Some("0.1.0".to_owned()),
					..Default::default()
				},
				"file:///runtime.js",
			)
			.unwrap()
		}
	}

	impl Drop for Site {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.root);
		}
	}

	fn text(served: Served) -> (String, String) {
		match served {
			Served::Text { content_type, body } => (content_type.to_owned(), body),
			other => panic!("expected a body, got {other:?}"),
		}
	}

	#[test]
	fn a_page_is_built_on_request_and_again_when_its_file_changes() {
		let site = Site::new("html");
		site.write("src/index.html", "<p>one</p>");
		site.write("src/a/index.html", "<p>a</p>");
		let serve = site.serve("");

		assert_eq!(
			text(serve.request("/").unwrap()),
			("text/html".to_owned(), "<p>one</p>\n".to_owned())
		);
		assert_eq!(text(serve.request("/a/").unwrap()).1, "<p>a</p>\n");
		// An extensionless path is `<path>.html`, not a directory index.
		assert_eq!(serve.request("/a").unwrap(), Served::NotFound);

		site.write("src/index.html", "<p>two</p>");
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>two</p>\n");
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>two</p>\n");
		// Nothing was written.
		assert!(fs::metadata(format!("{}/out", site.root)).is_err());
	}

	#[test]
	fn a_directory_url_is_the_index_of_the_configured_output_extension() {
		let site = Site::new("htm");
		site.write("src/index.html", "<p>one</p>");
		site.write("src/a/index.html", "<p>a</p>");
		let serve = site.serve(r#", "pages": { "outputExtension": ".htm" }"#);

		assert_eq!(text(serve.request("/").unwrap()).1, "<p>one</p>\n");
		assert_eq!(text(serve.request("/a/").unwrap()).1, "<p>a</p>\n");
		assert_eq!(text(serve.request("/index.htm").unwrap()).1, "<p>one</p>\n");
		// An extensionless path is `<path>.htm`: `a` has no page of that name.
		assert_eq!(serve.request("/a").unwrap(), Served::NotFound);
	}

	#[test]
	fn other_paths_are_files_not_found_or_forbidden() {
		let site = Site::new("paths");
		site.write("src/index.html", "<p>x</p>");
		site.write("out/img/logo.svg", "<svg/>");
		let serve = site.serve("");

		assert_eq!(
			serve.request("/img/logo.svg").unwrap(),
			Served::File {
				path: format!("{}/out/img/logo.svg", site.root)
			}
		);
		assert_eq!(serve.request("/img/none.svg").unwrap(), Served::NotFound);
		assert_eq!(
			serve.request("/%2e%2e/%2e%2e/etc/passwd").unwrap(),
			Served::Forbidden
		);
		assert_eq!(serve.request("/../secret.txt").unwrap(), Served::Forbidden);
		assert_eq!(serve.request("/bad%zz").unwrap(), Served::NotFound);
		// A directory is not a file.
		assert_eq!(serve.request("/img/").unwrap(), Served::NotFound);
		// A backslash is not a separator of ours.
		assert_eq!(
			// cspell:disable-next-line
			serve.request("/..%5C..%5Csecret.txt").unwrap(),
			Served::NotFound
		);
	}

	#[test]
	fn an_encoded_question_mark_belongs_to_the_name_and_a_real_one_ends_the_path() {
		let site = Site::new("question");
		site.write("src/index.html", "<p>x</p>");
		site.write("out/a?b.png", "png");
		let serve = site.serve("");

		assert_eq!(
			serve.request("/a%3Fb.png").unwrap(),
			Served::File {
				path: format!("{}/out/a?b.png", site.root)
			}
		);
		assert_eq!(serve.request("/a?b.png").unwrap(), Served::NotFound);
		assert_eq!(text(serve.request("/?x=1#top").unwrap()).1, "<p>x</p>\n");
	}

	#[test]
	fn data_that_does_not_parse_fails_only_the_pages_that_use_it() {
		let site = Site::new("bad-data");
		site.write("src/index.html", "<p>x</p>");
		site.write("out/logo.svg", "<svg/>");
		site.write("data/nav.json", "{ \"a\": 1 }");
		let serve = site.serve(r#", "data": { "dir": "data" }"#);
		std::thread::sleep(std::time::Duration::from_millis(20));
		site.write("data/nav.json", "{ not json");

		assert!(matches!(
			serve.request("/logo.svg").unwrap(),
			Served::File { .. }
		));
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>x</p>\n");
	}

	#[test]
	fn a_stylesheet_is_bundled_with_the_development_banner_and_follows_its_imports() {
		let site = Site::new("style");
		site.write("src/index.html", "<p>x</p>");
		site.write("src/css/base.css", "a { color : white }");
		site.write(
			"src/css/main.css",
			"@import 'base.css';\nb { margin : 0px }",
		);
		let serve = site.serve("");

		let (content_type, css) = text(serve.request("/css/main.css").unwrap());
		assert_eq!(content_type, "text/css");
		assert!(css.starts_with("/*!\n🚧"), "{css}");
		assert!(
			css.contains(
				"*/a{color:#fff}b{margin:0}\n/*# sourceMappingURL=data:application/json;base64,"
			),
			"{css}"
		);

		site.write("src/css/base.css", "a { color : black }");
		let (_, css) = text(serve.request("/css/main.css").unwrap());
		assert!(
			css.contains("*/a{color:#000}b{margin:0}\n/*# sourceMappingURL"),
			"{css}"
		);
	}

	#[test]
	fn a_script_is_a_round_trip_to_esbuild_and_is_kept_until_an_input_changes() {
		let site = Site::new("script");
		site.write("src/index.html", "<p>x</p>");
		site.write("src/js/app.ts", "export {};");
		let serve = site.serve("");
		// An input saved just before the build began is not taken as current (a coarse
		// mtime could hide an edit made during it): let this one age.
		std::thread::sleep(crate::MTIME_GRAIN * 2);

		let Served::Script(work) = serve.request("/js/app.js").unwrap() else {
			panic!("a script has to be built by esbuild");
		};
		let request = kd_jsonc::parse(&work.request).unwrap();
		assert_eq!(
			request.get("options").and_then(|o| o.get("sourcemap")),
			Some(&Value::Bool(true))
		);
		let output = ScriptOutput {
			id: 0,
			code: "console.log(1);\n".to_owned(),
			inputs: vec![format!("{}/src/js/app.ts", site.root)],
		};
		let served = serve.finish_script(work.token, output).unwrap();
		assert_eq!(text(served).1, "console.log(1);\n");

		// Kept: the next request does not go to esbuild.
		assert_eq!(
			text(serve.request("/js/app.js").unwrap()).1,
			"console.log(1);\n"
		);

		// An input changed: esbuild again.
		site.write("src/js/app.ts", "export const a = 1;");
		assert!(matches!(
			serve.request("/js/app.js").unwrap(),
			Served::Script(_)
		));
	}

	fn jsx_site(name: &str) -> (Site, Serve) {
		let site = Site::new(name);
		site.write(
			"src/index.tsx",
			"import { Box } from './_lib/box';\nexport const meta = { title: 'Home' };\nexport default () => <Box>home</Box>;\n",
		);
		site.write(
			"src/_lib/box.tsx",
			"export const Box = (p: any) => <div>{p.children}</div>;\n",
		);
		site.write("src/other.html", "---\ntitle: Other\n---\n<p>other</p>");
		let serve = site.serve(r#", "pages": { "ignore": ["_lib/**"] }"#);
		(site, serve)
	}

	fn render(served: Served) -> Render {
		match served {
			Served::Render(r) => r,
			other => panic!("expected a render, got {other:?}"),
		}
	}

	#[test]
	fn a_jsx_page_is_rendered_by_the_caller_and_kept() {
		let (_site, serve) = jsx_site("jsx");

		let first = render(serve.request("/").unwrap());
		assert_eq!(first.job.page, 0);
		assert!(
			first
				.job
				.main
				.as_deref()
				.unwrap()
				.ends_with("/src/index.tsx.mjs")
		);
		assert!(!first.restart);
		let context = kd_jsonc::parse(first.context.as_deref().unwrap()).unwrap();
		assert_eq!(
			context
				.get("pages")
				.and_then(|p| p.as_array())
				.unwrap()
				.len(),
			2
		);
		assert!(first.update.is_none());

		let served = serve.finish_render(first.token, "<div>home</div>").unwrap();
		assert_eq!(text(served).1, "<div>home</div>\n");

		// Unchanged: served from memory, the renderer is not asked again.
		assert_eq!(text(serve.request("/").unwrap()).1, "<div>home</div>\n");
	}

	#[test]
	fn a_changed_component_restarts_the_renderer_with_the_whole_context() {
		let (site, serve) = jsx_site("jsx-code");
		let first = render(serve.request("/").unwrap());
		serve.finish_render(first.token, "<div>home</div>").unwrap();

		site.write(
			"src/_lib/box.tsx",
			"export const Box = (p: any) => <section>{p.children}</section>;\n",
		);
		let second = render(serve.request("/").unwrap());

		assert!(second.restart, "Node cannot unload the old module");
		assert!(second.context.is_some());
		assert!(second.update.is_none());
		serve
			.finish_render(second.token, "<section>home</section>")
			.unwrap();

		// Not changed again: no restart, no new context.
		site.write("src/index.tsx", "export default () => <p>other</p>;\n");
		let third = render(serve.request("/").unwrap());
		assert!(third.restart, "the page itself is a module too");
		serve.finish_render(third.token, "<p>other</p>").unwrap();
	}

	#[test]
	fn changed_metadata_is_sent_to_the_renderer_as_an_update_and_rebuilds_pages() {
		let (site, serve) = jsx_site("jsx-meta");
		let first = render(serve.request("/").unwrap());
		serve.finish_render(first.token, "<div>home</div>").unwrap();

		// A page that JavaScript does not render changes its title: the
		// renderer is told, and pages that read the page list are stale.
		site.write("src/other.html", "---\ntitle: Changed\n---\n<p>other</p>");
		assert_eq!(
			text(serve.request("/other.html").unwrap()).1,
			"<p>other</p>\n"
		);
		let again = render(serve.request("/").unwrap());

		assert!(!again.restart);
		assert!(again.context.is_none());
		let update = kd_jsonc::parse(again.update.as_deref().unwrap()).unwrap();
		let pages = update.get("pages").and_then(|p| p.as_array()).unwrap();
		assert_eq!(pages.len(), 1);
		assert_eq!(
			pages[0].as_array().unwrap()[1]
				.get("meta")
				.and_then(|m| m.get("title"))
				.and_then(|t| t.as_str()),
			Some("Changed")
		);
		assert_eq!(update.get("data"), Some(&Value::Null));
	}

	#[test]
	fn changed_data_is_sent_to_the_renderer_and_rebuilds_pages() {
		let (site, serve) = {
			let site = Site::new("jsx-data");
			site.write(
				"src/index.tsx",
				"export default (p: any) => <p>{p.data.n}</p>;\n",
			);
			site.write("data/n.json", "1");
			let serve = site.serve(r#", "data": { "dir": "data" }"#);
			(site, serve)
		};
		let first = render(serve.request("/").unwrap());
		serve.finish_render(first.token, "<p>1</p>").unwrap();
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>1</p>\n");

		site.write("data/n.json", "22");
		let again = render(serve.request("/").unwrap());
		let update = kd_jsonc::parse(again.update.as_deref().unwrap()).unwrap();
		assert_eq!(
			update.get("data").map(Value::to_json),
			Some(r#"{"n":22}"#.to_owned())
		);
	}

	#[test]
	fn a_page_with_a_syntax_error_answers_with_its_message_and_recovers() {
		let (site, serve) = jsx_site("jsx-error");
		site.write("src/index.tsx", "export default () => <p>;\n");

		let e = serve.request("/").unwrap_err();
		assert!(e.contains("src/index.tsx:"), "{e}");

		site.write("src/index.tsx", "export default () => <p>fixed</p>;\n");
		let ok = render(serve.request("/").unwrap());
		serve.finish_render(ok.token, "<p>fixed</p>").unwrap();
	}

	#[test]
	fn a_component_fixed_after_a_syntax_error_still_restarts_the_renderer() {
		let (site, serve) = jsx_site("jsx-error-restart");
		let first = render(serve.request("/").unwrap());
		serve.finish_render(first.token, "<div>home</div>").unwrap();

		site.write("src/_lib/box.tsx", "export const Box = () => <p>;\n");
		assert!(serve.request("/").is_err());

		site.write(
			"src/_lib/box.tsx",
			"export const Box = (p: any) => <section>{p.children}</section>;\n",
		);
		let fixed = render(serve.request("/").unwrap());
		assert!(
			fixed.restart,
			"the renderer still holds the module from before the error"
		);
		serve
			.finish_render(fixed.token, "<section>home</section>")
			.unwrap();
	}

	#[test]
	fn a_cancelled_request_is_forgotten() {
		let (_site, serve) = jsx_site("jsx-cancel");
		let first = render(serve.request("/").unwrap());
		serve.cancel(first.token);
		assert_eq!(
			serve.finish_render(first.token, "<p/>").unwrap_err(),
			format!("no page is waiting for token {}", first.token)
		);
		// And the page can be asked for again.
		let again = render(serve.request("/").unwrap());
		serve.finish_render(again.token, "<p>x</p>").unwrap();
		serve.cancel(12345);
	}

	#[test]
	fn an_unknown_token_is_an_error() {
		let site = Site::new("token");
		site.write("src/index.html", "<p>x</p>");
		let serve = site.serve("");

		assert_eq!(
			serve.finish_render(99, "<p/>").unwrap_err(),
			"no page is waiting for token 99"
		);
	}

	const LINK: &str = r#"<link href="/css/dev.css" rel="stylesheet">"#;
	const STATIC_DOC: &str = "<!DOCTYPE html>\r\n<html>\r\n<head>\r\n<title>t</title>\r\n</head>\r\n<body>\r\n<p>x</p>\r\n</body>\r\n</html>\r\n";

	/// `STATIC_DOC` with the link written before `</head>`, as an injection
	/// at `head-end` does.
	fn with_link() -> String {
		STATIC_DOC.replace("</head>", &format!("{LINK}\n</head>"))
	}

	/// The `html` section of a config with one injection at `head-end`.
	fn inject_config(mode: &str, scope: &str) -> String {
		format!(
			r#", "html": {{ "inject": [ {{ "position": "head-end", "mode": "{mode}"{scope}, "html": "<link href=\"/css/dev.css\" rel=\"stylesheet\">" }} ] }}"#
		)
	}

	fn file_of(site: &Site, rel: &str) -> Served {
		Served::File {
			path: format!("{}/out/{rel}", site.root),
		}
	}

	#[test]
	fn a_static_html_file_gets_the_serve_injections_and_keeps_every_other_byte() {
		let site = Site::new("static-inject");
		site.write("out/legacy/index.html", STATIC_DOC);
		site.write("out/img/logo.svg", "<svg/>");
		let serve = site.serve(&inject_config("serve", ""));

		assert_eq!(
			text(serve.request("/legacy/").unwrap()),
			("text/html".to_owned(), with_link())
		);
		assert_eq!(
			text(serve.request("/legacy/index.html").unwrap()).1,
			with_link()
		);
		assert_eq!(
			text(serve.request("/legacy/?x=1#top").unwrap()).1,
			with_link()
		);
		// What is not HTML is sent as it is.
		assert_eq!(
			serve.request("/img/logo.svg").unwrap(),
			file_of(&site, "img/logo.svg")
		);
	}

	#[test]
	fn a_static_html_file_follows_the_mode_of_the_injection() {
		let site = Site::new("static-mode");
		site.write("out/a.html", STATIC_DOC);
		let both = site.serve(&inject_config("both", ""));
		assert_eq!(text(both.request("/a.html").unwrap()).1, with_link());

		let build = site.serve(&inject_config("build", ""));
		assert_eq!(build.request("/a.html").unwrap(), file_of(&site, "a.html"));
	}

	#[test]
	fn the_pages_and_exclude_of_an_injection_and_html_overrides_select_the_static_files() {
		let site = Site::new("static-scope");
		site.write("out/legacy/a.html", STATIC_DOC);
		site.write("out/other/a.html", STATIC_DOC);
		let pages = site.serve(&inject_config("serve", r#", "pages": ["/legacy/**"]"#));
		assert_eq!(
			text(pages.request("/legacy/a.html").unwrap()).1,
			with_link()
		);
		assert_eq!(
			pages.request("/other/a.html").unwrap(),
			file_of(&site, "other/a.html")
		);

		let exclude = site.serve(&inject_config("serve", r#", "exclude": ["/other/**"]"#));
		assert_eq!(
			text(exclude.request("/legacy/a.html").unwrap()).1,
			with_link()
		);
		assert_eq!(
			exclude.request("/other/a.html").unwrap(),
			file_of(&site, "other/a.html")
		);

		let overridden = site.serve(&format!(
			r#", "html": {{ "inject": [ {{ "position": "head-end", "mode": "serve", "html": "{}" }} ], "overrides": [ {{ "pages": ["/legacy/**"], "inject": [] }} ] }}"#,
			LINK.replace('"', "\\\"")
		));
		assert_eq!(
			overridden.request("/legacy/a.html").unwrap(),
			file_of(&site, "legacy/a.html")
		);
		assert_eq!(
			text(overridden.request("/other/a.html").unwrap()).1,
			with_link()
		);
	}

	#[test]
	fn the_extension_of_a_static_html_file_is_taken_in_any_case_and_htm_is_html() {
		let site = Site::new("static-ext");
		site.write("out/a.htm", STATIC_DOC);
		site.write("out/b.HTML", STATIC_DOC);
		let serve = site.serve(&inject_config("serve", ""));

		assert_eq!(text(serve.request("/a.htm").unwrap()).1, with_link());
		assert_eq!(text(serve.request("/b.HTML").unwrap()).1, with_link());
	}

	#[test]
	fn the_url_of_a_static_file_is_its_path_and_only_index_of_the_output_extension_is_a_directory()
	{
		let site = Site::new("static-url");
		site.write("out/legacy/index.htm", STATIC_DOC);
		let serve = site.serve(&inject_config(
			"serve",
			r#", "pages": ["/legacy/index.htm"]"#,
		));
		assert_eq!(
			text(serve.request("/legacy/index.htm").unwrap()).1,
			with_link()
		);
		let directory = site.serve(&inject_config("serve", r#", "pages": ["/legacy/"]"#));
		assert_eq!(
			directory.request("/legacy/index.htm").unwrap(),
			file_of(&site, "legacy/index.htm")
		);

		site.write("out/a/index.html", STATIC_DOC);
		let php = site.serve(&format!(
			r#"{}, "pages": {{ "outputExtension": ".php" }}"#,
			inject_config("serve", r#", "pages": ["/a/index.html"]"#)
		));
		assert_eq!(text(php.request("/a/index.html").unwrap()).1, with_link());
	}

	#[test]
	fn a_fragment_and_a_file_that_has_the_markup_already_are_sent_as_they_are() {
		let site = Site::new("static-noop");
		site.write("out/fragment.html", "<p>x</p>\r\n");
		site.write("out/done.html", &with_link());
		let serve = site.serve(&inject_config("serve", ""));

		assert_eq!(
			serve.request("/fragment.html").unwrap(),
			file_of(&site, "fragment.html")
		);
		assert_eq!(
			serve.request("/done.html").unwrap(),
			file_of(&site, "done.html")
		);
	}

	#[test]
	fn a_static_file_that_is_not_utf8_is_sent_as_it_is() {
		let site = Site::new("static-sjis");
		// `<html><head></head></html>` with a Shift_JIS character in the title.
		site.write_bytes(
			"out/a.html",
			b"<html><head><title>\x93\xfa</title></head></html>",
		);
		let serve = site.serve(&inject_config("serve", ""));

		assert_eq!(serve.request("/a.html").unwrap(), file_of(&site, "a.html"));
	}

	#[test]
	fn an_output_directory_written_with_a_dot_and_a_trailing_slash_gives_the_same_urls() {
		let site = Site::new("static-dot-dir");
		site.write("out/legacy/index.html", STATIC_DOC);
		site.write(
			"kamado.config.jsonc",
			&format!(
				r#"{{ "dir": {{ "input": "src", "output": "./out/" }}, "build": {{ "cacheDir": ".cache" }}{} }}"#,
				inject_config("serve", r#", "pages": ["/legacy/"]"#)
			),
		);
		let loaded = crate::load(&format!("{}/kamado.config.jsonc", site.root)).unwrap();
		let serve = Serve::open(
			loaded,
			BuildOptions {
				esbuild_version: Some("0.1.0".to_owned()),
				..Default::default()
			},
			"file:///runtime.js",
		)
		.unwrap();

		assert_eq!(text(serve.request("/legacy/").unwrap()).1, with_link());
	}

	#[test]
	fn a_page_wins_over_a_static_file_at_its_output_path_and_gets_the_injection_once() {
		let site = Site::new("static-page-wins");
		site.write("src/a.html", &STATIC_DOC.replace("<title>t", "<title>page"));
		site.write(
			"out/a.html",
			&STATIC_DOC.replace("<title>t", "<title>stale"),
		);
		let serve = site.serve(&inject_config("serve", ""));

		let (content_type, body) = text(serve.request("/a.html").unwrap());
		assert_eq!(content_type, "text/html");
		assert!(body.contains("<title>page"), "{body}");
		assert!(!body.contains("stale"), "{body}");
		assert_eq!(body.matches("/css/dev.css").count(), 1);
	}

	#[test]
	fn the_index_of_the_output_directory_has_the_url_of_the_root() {
		let site = Site::new("static-root");
		site.write("out/index.html", STATIC_DOC);
		let root = site.serve(&inject_config("serve", r#", "pages": ["/"]"#));
		assert_eq!(text(root.request("/").unwrap()).1, with_link());
		let file = site.serve(&inject_config("serve", r#", "pages": ["/index.html"]"#));
		assert_eq!(file.request("/").unwrap(), file_of(&site, "index.html"));
	}

	#[test]
	fn a_static_file_keeps_its_bom_non_ascii_text_quotes_and_missing_final_line_break() {
		let site = Site::new("static-bytes");
		let source = "\u{feff}<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>日本語</title></head><body><a href='x'>リンク</a>\t<p>\r</p></body></html>";
		site.write("out/a.html", source);
		let serve = site.serve(&inject_config("serve", ""));

		assert_eq!(
			text(serve.request("/a.html").unwrap()).1,
			"\u{feff}<!doctype html><html lang='ja'><head><meta charset='utf-8'><title>日本語</title><link href=\"/css/dev.css\" rel=\"stylesheet\">\n</head><body><a href='x'>リンク</a>\t<p>\r</p></body></html>"
		);
	}

	#[test]
	fn nothing_but_the_injection_runs_on_a_static_file() {
		let site = Site::new("static-only-inject");
		site.write("out/a.html", "<!DOCTYPE html>\r\n<html>\r\n<head>\r\n<title>©</title>\r\n</head>\r\n<body>\r\n<!-- @include(/part.html) -->\r\n<img src='/img/a.svg'>  <p class=\"a  b\" hidden=\"\">  x  </p>\r\n</body>\r\n</html>\r\n");
		site.write("out/part.html", "<p>part</p>");
		site.write("out/img/a.svg", "<svg width=\"4\" height=\"3\"></svg>");
		let serve = site.serve(&format!(
			r#", "html": {{ "inject": [ {{ "position": "head-end", "mode": "serve", "html": "{}" }} ], "entities": "all", "lineBreak": "lf", "doctype": true, "serializer": "spec", "format": {{}}, "minify": {{}}, "imageSizes": {{ "enabled": true }}, "includes": [ {{ "preset": "includeComment", "root": "out" }} ], "rules": [ {{ "selector": "p", "action": "remove" }} ] }}"#,
			LINK.replace('"', "\\\"")
		));

		assert_eq!(
			text(serve.request("/a.html").unwrap()).1,
			"<!DOCTYPE html>\r\n<html>\r\n<head>\r\n<title>©</title>\r\n<link href=\"/css/dev.css\" rel=\"stylesheet\">\n</head>\r\n<body>\r\n<!-- @include(/part.html) -->\r\n<img src='/img/a.svg'>  <p class=\"a  b\" hidden=\"\">  x  </p>\r\n</body>\r\n</html>\r\n"
		);
	}

	/// What the test wrote has to be older than the grain of the modification times: a directory
	/// changed within it is taken as changed after the plan was made.
	fn aged() {
		std::thread::sleep(crate::MTIME_GRAIN * 3);
	}

	fn move_dir(site: &Site, from: &str, to: &str) {
		fs::rename(
			format!("{}/{from}", site.root),
			format!("{}/{to}", site.root),
		)
		.unwrap();
	}

	#[test]
	fn a_page_that_moved_is_gone_at_its_old_url_and_found_at_the_new_one() {
		let site = Site::new("moved");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a/index.html", "<p>a</p>");
		aged();
		let serve = site.serve("");
		assert_eq!(text(serve.request("/a/").unwrap()).1, "<p>a</p>\n");

		move_dir(&site, "src/a", "src/b");

		assert_eq!(serve.request("/a/").unwrap(), Served::NotFound);
		assert_eq!(text(serve.request("/b/").unwrap()).1, "<p>a</p>\n");
		assert_eq!(serve.replans(), 1);
		// What is gone costs nothing more.
		assert_eq!(serve.request("/a/").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_page_asked_for_at_its_new_url_first_is_found_because_a_directory_above_it_changed() {
		let site = Site::new("moved-new-first");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a/index.html", "<p>a</p>");
		aged();
		let serve = site.serve("");
		assert_eq!(text(serve.request("/a/").unwrap()).1, "<p>a</p>\n");

		// The directory itself is not touched by its renaming; its parent is.
		move_dir(&site, "src/a", "src/b");

		assert_eq!(text(serve.request("/b/").unwrap()).1, "<p>a</p>\n");
		assert_eq!(serve.replans(), 1);
		assert_eq!(serve.request("/a/").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_page_whose_file_was_removed_is_not_found() {
		let site = Site::new("removed");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a/index.html", "<p>a</p>");
		aged();
		let serve = site.serve("");
		assert_eq!(text(serve.request("/a/").unwrap()).1, "<p>a</p>\n");

		fs::remove_file(format!("{}/src/a/index.html", site.root)).unwrap();

		assert_eq!(serve.request("/a/").unwrap(), Served::NotFound);
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>top</p>\n");
	}

	#[test]
	fn a_page_created_after_a_miss_is_found_when_asked_for_again() {
		let site = Site::new("created");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve("");

		assert_eq!(serve.request("/new.html").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 0, "nothing changed since the plan");

		site.write("src/new.html", "<p>new</p>");
		assert_eq!(text(serve.request("/new.html").unwrap()).1, "<p>new</p>\n");
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_miss_that_is_no_page_never_plans_again_however_the_input_changes() {
		let site = Site::new("favicon");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve("");
		site.write("src/other.html", "<p>other</p>");

		for path in [
			"/favicon.ico",
			"/img/logo.png",
			"/css/none.css",
			"/js/none.js",
			"/robots.txt",
		] {
			for _ in 0..20 {
				assert_eq!(serve.request(path).unwrap(), Served::NotFound, "{path}");
			}
		}
		assert_eq!(serve.replans(), 0);
	}

	#[test]
	fn a_page_like_miss_plans_again_once_for_a_change_and_not_for_each_request() {
		let site = Site::new("miss-once");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve("");
		site.write("src/other.html", "<p>other</p>");
		// (What changed a moment ago is not remembered, see `settled`: let it age.)
		aged();

		for _ in 0..20 {
			assert_eq!(serve.request("/missing.html").unwrap(), Served::NotFound);
		}
		assert_eq!(serve.replans(), 1);

		// Another change: the next miss looks again.
		site.write("src/third.html", "<p>third</p>");
		assert_eq!(
			text(serve.request("/third.html").unwrap()).1,
			"<p>third</p>\n"
		);
		assert_eq!(serve.replans(), 2);
	}

	#[test]
	fn a_miss_right_after_a_plan_waits_out_the_throttle_and_finds_the_page() {
		let site = Site::new("throttle");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve("");

		site.write("src/x1.html", "<p>1</p>");
		assert_eq!(text(serve.request("/x1.html").unwrap()).1, "<p>1</p>\n");
		assert_eq!(serve.replans(), 1);

		// Asked for a moment after the plan: not a 404, the plan is only held back.
		site.write("src/x2.html", "<p>2</p>");
		let asked = Instant::now();
		assert_eq!(text(serve.request("/x2.html").unwrap()).1, "<p>2</p>\n");
		assert_eq!(serve.replans(), 2);
		assert!(
			asked.elapsed() >= REPLAN_THROTTLE.mul_f32(0.5),
			"it waited: {:?}",
			asked.elapsed()
		);
	}

	#[test]
	fn a_url_the_path_field_plan_did_not_find_is_not_asked_for_again_for_a_while() {
		let site = Site::new("field-memory");
		site.write("src/x.html", "---\npath: /one.html\n---\n<p>x</p>");
		aged();
		let serve = site.serve(r#", "pages": { "outputPathField": "path" }"#);

		for _ in 0..20 {
			assert_eq!(
				serve.request("/broken-link.html").unwrap(),
				Served::NotFound
			);
		}
		assert_eq!(serve.replans(), 1);
		// Another URL is another question.
		assert_eq!(serve.request("/another.html").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 2);
	}

	#[test]
	fn a_pages_overrides_file_written_a_moment_before_the_plan_is_read_again_until_it_is_settled() {
		let site = Site::new("overrides-racy");
		site.write("src/index.html", "<p>top</p>");
		site.write(
			"pages.overrides.json",
			OVERRIDES_ONE.replace("/other.html", "/").as_str(),
		);
		// No ageing: the file was written within the grain of the modification times. Opening
		// a site takes longer than that grain on a loaded machine (a macOS runner), so the
		// modification time is put ahead of the plan, by more than opening takes, rather than
		// left to be "a moment ago": the plan sees a file that has not settled either way.
		let ahead = Duration::from_millis(600);
		fs::File::options()
			.write(true)
			.open(format!("{}/pages.overrides.json", site.root))
			.unwrap()
			.set_modified(std::time::SystemTime::now() + ahead)
			.unwrap();
		let serve = site.serve(r#", "pages": { "overrides": "pages.overrides.json" }"#);
		// Until the grain after that time has passed, so that the read the request makes finds
		// the file settled.
		std::thread::sleep(ahead + crate::MTIME_GRAIN * 3);

		assert_eq!(text(serve.request("/").unwrap()).1, "<p>top</p>\n");
		assert_eq!(
			serve.replans(),
			1,
			"a rewrite of the same size could have gone unseen"
		);
		assert_eq!(text(serve.request("/").unwrap()).1, "<p>top</p>\n");
		assert_eq!(serve.replans(), 1, "now it is settled");
	}

	#[test]
	fn a_plan_that_fails_for_a_page_that_is_there_answers_with_the_error_of_that_page() {
		let site = Site::new("assemble-fails");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a.html", "<p>a</p>");
		site.write(
			"pages.overrides.json",
			OVERRIDES_ONE.replace("/other.html", "/").as_str(),
		);
		aged();
		let serve = site.serve(r#", "pages": { "overrides": "pages.overrides.json" }"#);

		site.write("src/a.html", "---\n: broken: [\n---\n<p>a</p>");
		site.write(
			"pages.overrides.json",
			OVERRIDES_TWO.replace("/other.html", "/").as_str(),
		);
		let error = serve.request("/").unwrap_err();
		assert!(error.contains("a.html"), "{error}");
	}

	const OVERRIDES_ONE: &str =
		r#"{ "version": 1, "pages": [ { "url": "/other.html", "meta": { "title": "One" } } ] }"#;
	const OVERRIDES_TWO: &str = r#"{ "version": 1, "pages": [ { "url": "/other.html", "meta": { "title": "Two" } }, { "url": "/extra/", "virtual": true, "meta": { "title": "Extra" } } ] }"#;

	fn overrides_site(name: &str) -> (Site, Serve) {
		let site = Site::new(name);
		site.write(
			"src/index.tsx",
			"export const meta = { title: 'Home' };\nexport default () => <p>home</p>;\n",
		);
		site.write("src/other.html", "<p>other</p>");
		site.write("out/logo.svg", "<svg/>");
		site.write("pages.overrides.json", OVERRIDES_ONE);
		aged();
		let serve = site.serve(r#", "pages": { "overrides": "pages.overrides.json" }"#);
		(site, serve)
	}

	fn page_of<'a>(pages: &'a [Value], url: &str) -> &'a Value {
		pages
			.iter()
			.find(|p| p.get("url").and_then(|u| u.as_str()) == Some(url))
			.unwrap_or_else(|| panic!("no page {url}"))
	}

	#[test]
	fn a_change_of_pages_overrides_reaches_the_renderer_as_the_whole_context() {
		let (site, serve) = overrides_site("overrides");
		let first = render(serve.request("/").unwrap());
		assert_eq!(first.job.page, 1, "the pages of the file come first");
		serve.finish_render(first.token, "<p>home</p>").unwrap();

		site.write("pages.overrides.json", OVERRIDES_TWO);
		let again = render(serve.request("/").unwrap());

		assert!(!again.restart);
		assert_eq!(again.job.page, 2, "the page is where the new order puts it");
		let context =
			kd_jsonc::parse(again.context.as_deref().expect("the whole context")).unwrap();
		let pages = context.get("pages").and_then(|p| p.as_array()).unwrap();
		assert_eq!(pages.len(), 3);
		let title = |url| {
			page_of(pages, url)
				.get("meta")
				.and_then(|m| m.get("title"))
				.and_then(|t| t.as_str())
		};
		assert_eq!(title("/other.html"), Some("Two"));
		assert_eq!(title("/extra/"), Some("Extra"));
		assert_eq!(title("/"), Some("Home"));
		assert_eq!(serve.replans(), 1);
		serve.finish_render(again.token, "<p>home</p>").unwrap();
		// The file was written a moment before that plan: it is read once more when it is
		// settled, and then not again while it does not change.
		aged();
		for _ in 0..3 {
			assert!(matches!(
				serve.request("/other.html").unwrap(),
				Served::Text { .. }
			));
		}
		assert_eq!(serve.replans(), 2);
	}

	#[test]
	fn a_pages_overrides_file_that_cannot_be_read_fails_the_pages_and_keeps_the_plan() {
		let (site, serve) = overrides_site("overrides-broken");
		let first = render(serve.request("/").unwrap());
		serve.finish_render(first.token, "<p>home</p>").unwrap();

		site.write("pages.overrides.json", "{ not json");
		let error = serve.request("/other.html").unwrap_err();
		assert!(error.contains("pages.overrides"), "{error}");
		// A file that is no page is not the overrides' business.
		assert!(matches!(
			serve.request("/logo.svg").unwrap(),
			Served::File { .. }
		));

		// Mended: the plan is made from it.
		site.write("pages.overrides.json", OVERRIDES_TWO);
		let again = render(serve.request("/").unwrap());
		assert_eq!(again.job.page, 2);
	}

	#[test]
	fn pages_overrides_changed_while_a_page_file_vanished_unnoticed_plans_by_walking() {
		let site = Site::new("overrides-vanished");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a/index.html", "<p>a</p>");
		site.write(
			"pages.overrides.json",
			&OVERRIDES_ONE.replace("/other.html", "/"),
		);
		aged();
		let serve = site.serve(r#", "pages": { "overrides": "pages.overrides.json" }"#);
		fs::remove_file(format!("{}/src/a/index.html", site.root)).unwrap();
		aged();

		site.write(
			"pages.overrides.json",
			&OVERRIDES_TWO.replace("/other.html", "/"),
		);

		assert_eq!(text(serve.request("/").unwrap()).1, "<p>top</p>\n");
		assert_eq!(serve.request("/a/").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_page_file_replaced_by_a_directory_is_gone_for_the_plan_too() {
		let site = Site::new("replaced-by-directory");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/a.html", "<p>a</p>");
		site.write(
			"pages.overrides.json",
			&OVERRIDES_ONE.replace("/other.html", "/"),
		);
		aged();
		let serve = site.serve(r#", "pages": { "overrides": "pages.overrides.json" }"#);
		fs::remove_file(format!("{}/src/a.html", site.root)).unwrap();
		fs::create_dir(format!("{}/src/a.html", site.root)).unwrap();
		aged();

		site.write(
			"pages.overrides.json",
			&OVERRIDES_TWO.replace("/other.html", "/"),
		);

		assert_eq!(text(serve.request("/").unwrap()).1, "<p>top</p>\n");
		assert_eq!(serve.request("/a.html").unwrap(), Served::NotFound);
	}

	#[test]
	fn a_changed_output_path_field_moves_the_page_whichever_url_is_asked_for_first() {
		let source = |path: &str| format!("---\npath: {path}\n---\n<p>x</p>");
		let field = r#", "pages": { "outputPathField": "path" }"#;

		let site = Site::new("field-old-first");
		site.write("src/x.html", &source("/one.html"));
		aged();
		let serve = site.serve(field);
		assert_eq!(text(serve.request("/one.html").unwrap()).1, "<p>x</p>\n");
		site.write("src/x.html", &source("/two.html"));
		assert_eq!(serve.request("/one.html").unwrap(), Served::NotFound);
		assert_eq!(text(serve.request("/two.html").unwrap()).1, "<p>x</p>\n");

		let site = Site::new("field-new-first");
		site.write("src/x.html", &source("/one.html"));
		aged();
		let serve = site.serve(field);
		assert_eq!(text(serve.request("/one.html").unwrap()).1, "<p>x</p>\n");
		site.write("src/x.html", &source("/two.html"));
		assert_eq!(text(serve.request("/two.html").unwrap()).1, "<p>x</p>\n");
		assert_eq!(serve.request("/one.html").unwrap(), Served::NotFound);
	}

	#[test]
	fn a_render_under_way_finishes_for_its_page_where_the_plan_now_puts_it() {
		let (site, serve) = jsx_site("replan-inflight");
		let first = render(serve.request("/").unwrap());
		assert_eq!(first.job.page, 0);

		// A page that sorts before it: its index moves.
		site.write("src/aaa.html", "<p>aaa</p>");
		assert_eq!(text(serve.request("/aaa.html").unwrap()).1, "<p>aaa</p>\n");
		assert_eq!(serve.replans(), 1);

		let served = serve.finish_render(first.token, "<div>home</div>").unwrap();
		assert_eq!(text(served).1, "<div>home</div>\n");

		// It was rendered with the context from before: the page is rendered again, with the
		// whole new one.
		let again = render(serve.request("/").unwrap());
		assert_eq!(again.job.page, 1);
		assert!(again.context.is_some());
	}

	#[test]
	fn a_render_under_way_for_a_page_that_is_gone_is_forgotten() {
		let site = Site::new("replan-gone");
		site.write("src/a.tsx", "export default () => <p>a</p>;\n");
		site.write("src/b.tsx", "export default () => <p>b</p>;\n");
		aged();
		let serve = site.serve("");
		let waiting = render(serve.request("/a.html").unwrap());

		fs::remove_file(format!("{}/src/a.tsx", site.root)).unwrap();
		assert_eq!(serve.request("/a.html").unwrap(), Served::NotFound);

		assert!(serve.finish_render(waiting.token, "<p>a</p>").is_err());
		// The other page is rendered with the whole context the new plan makes.
		let b = render(serve.request("/b.html").unwrap());
		assert_eq!(b.job.page, 0);
		assert!(b.context.is_some());
	}

	const FIELD: &str = r#", "pages": { "outputPathField": "path" }"#;

	#[test]
	fn a_page_file_added_where_its_url_is_not_is_found_where_a_path_field_sends_it() {
		let site = Site::new("field-added");
		site.write("src/index.html", "<p>top</p>");
		site.write("src/blog/old.html", "---\npath: /old.html\n---\n<p>old</p>");
		aged();
		let serve = site.serve(FIELD);

		// The directory of the file is not the directory of the URL: only a walk finds it.
		site.write(
			"src/blog/foo.html",
			"---\npath: /news/foo.html\n---\n<p>foo</p>",
		);
		assert_eq!(
			text(serve.request("/news/foo.html").unwrap()).1,
			"<p>foo</p>\n"
		);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_plan_that_failed_for_a_missed_url_is_tried_again_by_the_next_request() {
		let site = Site::new("field-failed");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve(FIELD);

		site.write("src/bad.html", "---\n: broken: [\n---\n<p>bad</p>");
		let error = serve.request("/bad.html").unwrap_err();
		assert!(error.contains("bad.html"), "{error}");

		site.write("src/bad.html", "---\npath: /bad.html\n---\n<p>mended</p>");
		assert_eq!(
			text(serve.request("/bad.html").unwrap()).1,
			"<p>mended</p>\n"
		);
	}

	#[test]
	fn a_page_that_still_does_not_match_the_plan_after_the_plans_a_request_may_make_is_an_error() {
		let site = Site::new("kept-changing");
		site.write("src/x.html", "---\npath: /one.html\n---\n<p>x</p>");
		aged();
		let mut serve = site.serve(FIELD);
		serve.plans_per_request = 0;
		assert_eq!(text(serve.request("/one.html").unwrap()).1, "<p>x</p>\n");

		site.write("src/x.html", "---\npath: /two.html\n---\n<p>x</p>");
		let error = serve.request("/one.html").unwrap_err();
		assert!(error.contains("kept changing"), "{error}");
		assert!(error.contains("/one.html"), "{error}");
	}

	#[test]
	fn a_url_remembered_as_not_found_is_asked_for_again_when_the_memory_has_run_out() {
		let site = Site::new("field-memory-out");
		site.write("src/x.html", "---\npath: /one.html\n---\n<p>x</p>");
		aged();
		let serve = site.serve(FIELD);
		assert_eq!(serve.request("/later.html").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);

		// A page is given that URL by what its file says (the directory does not change), but the
		// miss is remembered: not asked for again yet.
		site.write("src/x.html", "---\npath: /later.html\n---\n<p>y</p>");
		assert_eq!(serve.request("/later.html").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);

		// The memory has run out.
		let url = serve.lock().field_missed.keys().next().cloned().unwrap();
		serve.lock().field_missed.insert(
			url,
			Instant::now() - FIELD_MISS_MEMORY - Duration::from_secs(1),
		);
		assert_eq!(text(serve.request("/later.html").unwrap()).1, "<p>y</p>\n");
		assert_eq!(serve.replans(), 2);
	}

	#[test]
	fn a_url_a_walk_did_not_find_is_not_walked_for_again_by_the_next_miss_of_a_path_field_site() {
		let site = Site::new("field-walked");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve(FIELD);

		// A change in the directory makes the first miss a walk; the second asks for the same URL.
		site.write("src/other.html", "<p>other</p>");
		aged();
		assert_eq!(serve.request("/nothing.html").unwrap(), Served::NotFound);
		assert_eq!(serve.request("/nothing.html").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_static_page_of_the_output_directory_plans_nothing_even_where_a_path_field_is_set() {
		let site = Site::new("field-static");
		site.write("src/index.html", "<p>top</p>");
		site.write("out/static.html", "<p>static</p>");
		aged();
		let serve = site.serve(FIELD);

		for _ in 0..3 {
			assert!(matches!(
				serve.request("/static.html").unwrap(),
				Served::File { .. }
			));
		}
		assert_eq!(serve.replans(), 0);
	}

	#[test]
	fn pages_written_without_an_extension_are_found_by_a_miss_too() {
		let site = Site::new("no-extension");
		site.write("src/index.html", "<p>top</p>");
		aged();
		let serve = site.serve(r#", "pages": { "outputExtension": "" }"#);

		assert_eq!(serve.request("/about").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 0);
		site.write("src/about.html", "<p>about</p>");
		assert_eq!(text(serve.request("/about").unwrap()).1, "<p>about</p>\n");
		assert_eq!(serve.replans(), 1);
		// A file with an extension is no page of such a site.
		assert_eq!(serve.request("/logo.png").unwrap(), Served::NotFound);
		assert_eq!(serve.replans(), 1);
	}

	#[test]
	fn a_directory_changed_a_moment_ago_is_not_remembered_and_a_sibling_directory_is_no_root() {
		let looked: DirTimes = vec![
			("/site/src/a".to_owned(), (100, 0)),
			("/site/src".to_owned(), (200, 0)),
		];
		// A time is settled when it is older than the grain before `now`: the first is far
		// older, the second is only half a grain old.
		let now = Duration::from_secs(200) + crate::MTIME_GRAIN / 2;
		assert_eq!(
			settled(looked, now),
			vec![("/site/src/a".to_owned(), (100, 0))]
		);

		assert!(is_within("/site/src", "/site/src"));
		assert!(is_within("/site/src/a", "/site/src"));
		assert!(!is_within("/site/src2", "/site/src"));
		assert!(!is_within("/site", "/site/src"));
	}
}
