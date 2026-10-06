//! The dev server's engine: what a request for a URL turns into.
//!
//! Nothing is watched and nothing is written. The site is planned once; a
//! request checks the fingerprints of the files its answer was built from
//! (stat first, so an unchanged file costs one `stat`), and builds the answer
//! again only when one of them changed. The answers are kept in memory.
//!
//! Pages that JavaScript renders are a round trip: [`Serve::request`] returns
//! a [`Render`] describing the job, the caller renders it and hands the HTML
//! back to [`Serve::finish_render`]. The same goes for scripts, which esbuild
//! builds on the JavaScript side.
//!
//! What a request does not notice, by design: a new or removed page file, a
//! change to the `outputPathField` of a page, to `pages.overrides` and to the
//! config (they take a restart), and a change to the metadata of *another*
//! page (a page notices it when its own files change or when it is asked for
//! after a page with new metadata was; the navigation in a page rendered
//! before that stays as it was until the page itself is rebuilt).
//!
//! Why modules are recompiled lazily: `Modules::refresh` forgets the modules of
//! the requested page whose source changed and the closure is compiled again.
//! Node cannot unload a module, so when any module changed the caller is told
//! to restart its renderer (`Render::restart`).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use kd_jsonc::Value;
use kd_site::meta::Overrides;

use crate::assets::{self, Asset, AssetKind, ScriptSettings};
use crate::banner::{self, LocalTime};
use crate::html;
use crate::jsx::Modules;
use crate::minifiers::Minifiers;
use crate::session::{
	RenderJob, ScriptOutput, layout_module, needs_js, now_iso, page_env, page_json, site_json,
};
use crate::style::{self, StyleSettings};
use crate::{BuildOptions, Loaded, Page, PageKind};

/// How to answer a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Served {
	/// A response body that is ready.
	Text {
		/// `text/html`, `text/css`, `text/javascript`.
		content_type: &'static str,
		body: String,
	},
	/// A file of the output directory, to be sent as it is.
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

struct State {
	plan: crate::Plan,
	overrides: Option<Overrides>,
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
	next_token: AtomicU64,
	state: Mutex<State>,
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
		let plan = crate::plan(config)?;
		let overrides = crate::read_overrides(config)?;
		let assets = {
			let mut assets = assets::discover(config, AssetKind::Style)?;
			assets.extend(assets::discover(config, AssetKind::Script)?);
			assets
		};
		let by_output = plan
			.pages
			.iter()
			.enumerate()
			.filter(|(_, p)| !p.is_virtual)
			.map(|(i, p)| (p.file.output_path.clone(), i))
			.collect();
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
			next_token: AtomicU64::new(1),
			state: Mutex::new(State {
				plan,
				overrides,
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
	/// in; query and fragment are ignored).
	///
	/// # Errors
	///
	/// The message to send with a 500: a page or style that cannot be built.
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
		let Some(decoded) = percent_decode(url_path) else {
			return Ok(Served::NotFound);
		};
		let local = kd_site::url_to_local_path(&decoded, ".html");
		let config = &self.loaded.config;
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
		self.refresh_data(&mut st)?;
		if let Some(&index) = st.by_output.get(&path) {
			return self.page(&mut st, index);
		}
		if let Some(&index) = st.asset_by_output.get(&path) {
			return self.asset(&mut st, index);
		}
		drop(st);
		Ok(if fs::metadata(&path).is_ok_and(|m| m.is_file()) {
			Served::File { path }
		} else {
			Served::NotFound
		})
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

	fn page(&self, st: &mut State, index: usize) -> Result<Served, String> {
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
				return Ok(Served::Text {
					content_type: "text/html",
					body: cached.body.clone(),
				});
			}
		}

		self.reload(st, index)?;
		// The reload may have changed the environment (the epoch) or whether
		// the page names a layout.
		let page = &st.plan.pages[index];
		if !needs_js(page) {
			let body = self.process(st, index, None, &BTreeMap::new(), None)?;
			return Ok(Served::Text {
				content_type: "text/html",
				body,
			});
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
			layout,
		};
		let (context, update) = self.context_for(st, restart);
		if restart {
			st.renderer_code_epoch = st.code_epoch;
		}
		let token = self.token();
		let env = self.env_js(st);
		st.pending.insert(token, Pending::Page { index, deps, env });
		Ok(Served::Render(Render {
			token,
			job,
			restart,
			context,
			update,
		}))
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
	fn reload(&self, st: &mut State, index: usize) -> Result<(), String> {
		let fingerprinter = kd_build::Fingerprinter::new();
		let page = &st.plan.pages[index];
		if page
			.deps
			.iter()
			.all(|(path, dep)| fingerprinter.unchanged(path, dep))
		{
			return Ok(());
		}
		let reloaded = crate::reload_page(page, st.overrides.as_ref())?;
		let page = &mut st.plan.pages[index];
		let meta_changed = page.meta != reloaded.meta;
		page.meta = reloaded.meta;
		page.body = reloaded.body;
		page.deps = reloaded.deps;
		if meta_changed {
			st.epoch += 1;
			st.dirty_pages.insert(index);
			// Pages that read the page list are stale: their environment
			// changed with the epoch.
		}
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
						started_at: (started.as_secs() as i64, started.subsec_nanos()),
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
	fn an_unknown_token_is_an_error() {
		let site = Site::new("token");
		site.write("src/index.html", "<p>x</p>");
		let serve = site.serve("");

		assert_eq!(
			serve.finish_render(99, "<p/>").unwrap_err(),
			"no page is waiting for token 99"
		);
	}
}
