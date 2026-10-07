//! The HTML stages of a build, in the order v2 ran them: the DOM stage
//! (includes, rules, inject, image sizes, serialization), `doctype`, format,
//! minify, line breaks.
//!
//! Each stage takes the text the previous one produced. That is what makes
//! the output match v2 byte for byte (formatting re-parses the serialized text
//! on purpose, see `kd_html::print`), and it is what makes `html.onError`
//! meaningful: as in v2, a stage that fails under `silent` or `warning` is
//! skipped and the text flows on to the next stage; under `error` the page
//! fails.
//!
//! `html.overrides` replace whole options (`format`, `minify`, `rules`, ...)
//! for the pages their globs match, in order, and only the options an entry
//! names; the rest stays as configured.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use kd_config::{Config, Entities, Html, OnError};
use kd_glob::Pattern;
use kd_html::image_sizes::{self, ImageSizeError, ImageSource};
use kd_html::includes::{self, Include, OnMissing, Reader, Replace};
use kd_html::inject::{self, Inject, InjectMode, InjectPosition, Phase};
use kd_html::minify;
use kd_html::page::Page;
use kd_html::print;
use kd_html::rules::{self, Position, Rule, UrlTarget};
use kd_html::selector::Selector;
use kd_jsonc::Value;

/// An item that applies to some pages only (`pages` / `exclude` globs on the
/// output URL).
struct Scoped<T> {
	pages: Vec<Pattern>,
	exclude: Vec<Pattern>,
	item: T,
}

impl<T> Scoped<T> {
	fn applies(&self, url: &str) -> bool {
		(self.pages.is_empty() || self.pages.iter().any(|p| p.matches(url)))
			&& !self.exclude.iter().any(|p| p.matches(url))
	}
}

struct ImageSettings {
	enabled: bool,
	exclude: Vec<Pattern>,
	keep_authored: bool,
}

/// One complete set of `html` options, compiled.
struct Layer {
	doctype: bool,
	format: Option<print::Options>,
	minify: Option<minify::Options>,
	line_break: &'static str,
	encoding: kd_html::encode::Encoding,
	/// Write the markup as the HTML standard says (`html.serializer: "spec"`).
	spec: bool,
	entities: kd_html::entities::Entities,
	image_sizes: ImageSettings,
	rules: Vec<Scoped<Rule>>,
	includes: Vec<Include>,
	inject: Vec<Scoped<Inject>>,
	on_error: OnError,
}

struct Override {
	pages: Vec<Pattern>,
	/// The options the entry names; only these replace the base.
	keys: Vec<String>,
	layer: Layer,
}

/// The compiled `html` section of a config.
pub(crate) struct Pipeline {
	base: Layer,
	overrides: Vec<Override>,
	input_dir: String,
	output_dir: String,
	base_url: String,
	host: String,
	memo: FileMemo,
}

/// What the page being processed is.
pub(crate) struct PageInput<'a> {
	/// The page body (front matter removed).
	pub source: &'a str,
	/// The output URL.
	pub url: &'a str,
	/// The input file (for messages and relative includes).
	pub input_path: &'a str,
	/// `serve` makes `mode: serve` injections apply.
	pub phase: Phase,
}

/// What a processed page yields.
pub(crate) struct PageOutput {
	pub html: String,
	/// The encoding the bytes of the page are written in (a build; the dev
	/// server answers in UTF-8).
	pub encoding: kd_html::encode::Encoding,
	pub warnings: Vec<String>,
	/// Files the page read besides its own source (includes, images), with
	/// their fingerprints, missing ones included.
	pub deps: BTreeMap<String, kd_build::Dep>,
}

// ----- reading the config values -----

/// The keys of a config object, with typed accessors that name the option in
/// their errors.
struct Fields<'a> {
	path: String,
	pairs: &'a [(String, Value)],
}

impl<'a> Fields<'a> {
	fn new(value: &'a Value, path: String) -> Result<Fields<'a>, String> {
		match value.as_object() {
			Some(pairs) => Ok(Fields { path, pairs }),
			None => Err(format!("{path}: expected an object")),
		}
	}

	fn get(&self, key: &str) -> Option<&'a Value> {
		self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
	}

	fn deny_unknown(&self, allowed: &[&str]) -> Result<(), String> {
		match self
			.pairs
			.iter()
			.find(|(k, _)| !allowed.contains(&k.as_str()))
		{
			Some((k, _)) => Err(format!(
				"{}.{k}: unknown option (allowed here: {})",
				self.path,
				allowed.join(", ")
			)),
			None => Ok(()),
		}
	}

	fn string(&self, key: &str) -> Result<Option<&'a str>, String> {
		match self.get(key) {
			None => Ok(None),
			Some(Value::String(s)) => Ok(Some(s)),
			Some(_) => Err(format!("{}.{key}: expected a string", self.path)),
		}
	}

	fn required(&self, key: &str) -> Result<&'a str, String> {
		self.string(key)?
			.ok_or_else(|| format!("{}.{key}: required", self.path))
	}

	fn strings(&self, key: &str) -> Result<Vec<&'a str>, String> {
		match self.get(key) {
			None => Ok(Vec::new()),
			Some(Value::String(s)) => Ok(vec![s]),
			Some(Value::Array(items)) => items
				.iter()
				.map(|v| {
					v.as_str().ok_or_else(|| {
						format!(
							"{}.{key}: expected a string or a list of strings",
							self.path
						)
					})
				})
				.collect(),
			Some(_) => Err(format!(
				"{}.{key}: expected a string or a list of strings",
				self.path
			)),
		}
	}

	fn globs(&self, key: &str) -> Result<Vec<Pattern>, String> {
		self.strings(key)?
			.into_iter()
			.map(|g| {
				Pattern::new(g).map_err(|e| format!("{}.{key}: invalid glob {g:?}: {e}", self.path))
			})
			.collect()
	}

	/// The text of a selector option. `{{host}}` needs `site.host`: with an
	/// empty host `:not([href*='{{host}}'])` would never match and the option
	/// would silently do nothing.
	fn selector_source(&self, source: &'a str, key: &str, host: &str) -> Result<&'a str, String> {
		if source.contains("{{host}}") && host.is_empty() {
			return Err(format!(
				"{}.{key}: uses {{{{host}}}}, but site.host is not set",
				self.path
			));
		}
		Ok(source)
	}

	fn selector(&self, key: &str, host: &str) -> Result<Selector, String> {
		let source = self.selector_source(self.required(key)?, key, host)?;
		Selector::parse(&source.replace("{{host}}", host))
			.map_err(|e| format!("{}.{key}: {e}", self.path))
	}
}

fn at(path: &str, error: impl std::fmt::Display) -> String {
	format!("{path}: {error}")
}

fn compile_rule(value: &Value, host: &str, path: String) -> Result<Scoped<Rule>, String> {
	let f = Fields::new(value, path.clone())?;
	let action = f.required("action")?;
	let extra: &[&str] = match action {
		"remove" | "unwrap" => &[],
		"wrap" => &["html"],
		"setAttr" => &["name", "value"],
		"removeAttr" => &["name"],
		"addClass" | "removeClass" => &["value"],
		"insert" => &["position", "html"],
		"rewriteUrl" => &["to", "origin", "attrs"],
		other => {
			return Err(format!(
				"{path}.action: unknown action {other:?} (remove, unwrap, wrap, setAttr, removeAttr, addClass, removeClass, insert, rewriteUrl)"
			));
		}
	};
	let mut allowed = vec!["pages", "exclude", "selector", "action"];
	allowed.extend_from_slice(extra);
	f.deny_unknown(&allowed)?;
	let sel = f.selector_source(f.required("selector")?, "selector", host)?;
	let rule = match action {
		"remove" => Rule::remove(sel, host),
		"unwrap" => Rule::unwrap(sel, host),
		"wrap" => Rule::wrap(sel, host, f.required("html")?),
		"setAttr" => Rule::set_attr(sel, host, f.required("name")?, f.required("value")?),
		"removeAttr" => Rule::remove_attr(sel, host, f.required("name")?),
		"addClass" => Rule::add_class(sel, host, f.required("value")?),
		"removeClass" => Rule::remove_class(sel, host, f.required("value")?),
		"insert" => {
			let position = match f.required("position")? {
				"before" => Position::Before,
				"after" => Position::After,
				"prepend" => Position::Prepend,
				"append" => Position::Append,
				other => {
					return Err(format!(
						"{path}.position: expected before, after, prepend or append, got {other:?}"
					));
				}
			};
			Rule::insert(sel, host, position, f.required("html")?)
		}
		_ => {
			let to = match f.required("to")? {
				"absolute" => UrlTarget::Absolute,
				"rootRelative" => UrlTarget::RootRelative,
				other => {
					return Err(format!(
						"{path}.to: expected absolute or rootRelative, got {other:?}"
					));
				}
			};
			let attrs = f.strings("attrs")?;
			Rule::rewrite_url(sel, host, to, f.required("origin")?, &attrs)
		}
	}
	.map_err(|e| at(&path, e))?;
	Ok(Scoped {
		pages: f.globs("pages")?,
		exclude: f.globs("exclude")?,
		item: rule,
	})
}

/// `root` of an include: relative paths are relative to the config directory
/// like every other path option.
fn include_root(f: &Fields<'_>, root_dir: &str) -> Result<String, String> {
	let root = f.required("root")?;
	Ok(if root.starts_with('/') {
		kd_site::path::normalize(root)
	} else {
		kd_site::path::join(root_dir, root)
	})
}

fn compile_include(
	value: &Value,
	host: &str,
	root_dir: &str,
	path: String,
) -> Result<Include, String> {
	let f = Fields::new(value, path.clone())?;
	if let Some(preset) = f.string("preset")? {
		return match preset {
			"ssi" => {
				f.deny_unknown(&["preset", "dir"])?;
				Ok(Include::Ssi {
					dir: f.string("dir")?.map(str::to_owned),
				})
			}
			"includeComment" => {
				f.deny_unknown(&["preset", "root"])?;
				Ok(Include::IncludeComment {
					root: include_root(&f, root_dir)?,
				})
			}
			"burgerEditorImport" => {
				f.deny_unknown(&["preset", "root"])?;
				Ok(Include::BurgerEditorImport {
					root: include_root(&f, root_dir)?,
				})
			}
			other => Err(format!(
				"{path}.preset: unknown preset {other:?} (ssi, includeComment, burgerEditorImport)"
			)),
		};
	}
	f.deny_unknown(&["selector", "attr", "root", "pick", "replace"])?;
	let replace = match f.string("replace")?.unwrap_or("element") {
		"element" => Replace::Element,
		"children" => Replace::Children,
		other => {
			return Err(format!(
				"{path}.replace: expected element or children, got {other:?}"
			));
		}
	};
	let pick = match f.string("pick")? {
		Some(source) => Some(
			Selector::parse(
				&f.selector_source(source, "pick", host)?
					.replace("{{host}}", host),
			)
			.map_err(|e| format!("{path}.pick: {e}"))?,
		),
		None => None,
	};
	Ok(Include::Selector {
		selector: f.selector("selector", host)?,
		attr: f.required("attr")?.to_owned(),
		root: include_root(&f, root_dir)?,
		pick,
		replace,
	})
}

fn compile_inject(value: &Value, path: String) -> Result<Scoped<Inject>, String> {
	let f = Fields::new(value, path.clone())?;
	f.deny_unknown(&["pages", "exclude", "position", "mode", "html"])?;
	let position = match f.required("position")? {
		"head-start" => InjectPosition::HeadStart,
		"head-end" => InjectPosition::HeadEnd,
		"body-start" => InjectPosition::BodyStart,
		"body-end" => InjectPosition::BodyEnd,
		other => {
			return Err(format!(
				"{path}.position: expected head-start, head-end, body-start or body-end, got {other:?}"
			));
		}
	};
	let mode = match f.string("mode")?.unwrap_or("build") {
		"build" => InjectMode::Build,
		"serve" => InjectMode::Serve,
		"both" => InjectMode::Both,
		other => {
			return Err(format!(
				"{path}.mode: expected build, serve or both, got {other:?}"
			));
		}
	};
	Ok(Scoped {
		pages: f.globs("pages")?,
		exclude: f.globs("exclude")?,
		item: Inject::new(position, mode, f.required("html")?),
	})
}

fn compile_entities(
	entities: &Entities,
	path: &str,
) -> Result<kd_html::entities::Entities, String> {
	Ok(match entities {
		Entities::None => kd_html::entities::Entities::None,
		Entities::All => kd_html::entities::Entities::All,
		Entities::Map(map) => {
			let mut custom = Vec::with_capacity(map.len());
			for (key, replacement) in map {
				let mut chars = key.chars();
				match (chars.next(), chars.next()) {
					(Some(c), None) => custom.push((c, replacement.clone())),
					_ => {
						return Err(format!(
							"{path}entities.{key}: the key must be exactly one character"
						));
					}
				}
			}
			kd_html::entities::Entities::Custom(custom)
		}
	})
}

fn compile_layer(html: &Html, host: &str, root_dir: &str, path: &str) -> Result<Layer, String> {
	let rules = html
		.rules
		.iter()
		.enumerate()
		.map(|(i, v)| compile_rule(v, host, format!("{path}rules[{i}]")))
		.collect::<Result<Vec<_>, _>>()?;
	let includes = html
		.includes
		.iter()
		.enumerate()
		.map(|(i, v)| compile_include(v, host, root_dir, format!("{path}includes[{i}]")))
		.collect::<Result<Vec<_>, _>>()?;
	let inject = html
		.inject
		.iter()
		.enumerate()
		.map(|(i, v)| compile_inject(v, format!("{path}inject[{i}]")))
		.collect::<Result<Vec<_>, _>>()?;
	let image_exclude = html
		.image_sizes
		.exclude
		.iter()
		.map(|g| {
			Pattern::new(g)
				.map_err(|e| format!("{path}imageSizes.exclude: invalid glob {g:?}: {e}"))
		})
		.collect::<Result<Vec<_>, _>>()?;
	Ok(Layer {
		doctype: html.doctype,
		format: html.format.as_ref().map(|f| print::Options {
			print_width: f.print_width as usize,
			tab_width: f.tab_width as usize,
			use_tabs: f.use_tabs,
			bracket_same_line: f.bracket_same_line,
			..print::Options::default()
		}),
		minify: html.minify.as_ref().map(|m| minify::Options {
			collapse_boolean_attributes: m.boolean_attributes,
			remove_redundant_attributes: m.redundant_attributes,
			remove_script_type_attributes: m.script_type_attributes,
			remove_style_link_type_attributes: m.style_link_type_attributes,
			minify_css: m.css,
			minify_js: m.js,
		}),
		line_break: if html.line_break == "\r\n" {
			"\r\n"
		} else {
			"\n"
		},
		spec: html.serializer == kd_config::HtmlSerializer::Spec,
		encoding: match html.encoding {
			kd_config::HtmlEncoding::Utf8 => kd_html::encode::Encoding::Utf8,
			kd_config::HtmlEncoding::ShiftJis => kd_html::encode::Encoding::ShiftJis,
		},
		entities: compile_entities(&html.entities, path)?,
		image_sizes: ImageSettings {
			enabled: html.image_sizes.enabled,
			exclude: image_exclude,
			keep_authored: html.image_sizes.keep_authored,
		},
		rules,
		includes,
		inject,
		on_error: html.on_error,
	})
}

impl Pipeline {
	/// Compiles the `html` section of `config`; every selector, glob and
	/// template is checked here, so a bad option fails the build before any
	/// page is touched.
	///
	/// # Errors
	///
	/// A message naming the option (`html.rules[2].selector: ...`).
	pub(crate) fn compile(config: &Config) -> Result<Pipeline, String> {
		let host = config.site.host.clone().unwrap_or_default();
		let root_dir = config.root_dir.as_str();
		let base = compile_layer(&config.html, &host, root_dir, "html.")?;
		let mut overrides = Vec::new();
		for (i, o) in config.html.overrides.iter().enumerate() {
			let path = format!("html.overrides[{i}].");
			let parsed =
				kd_config::parse_html_options(&o.options, &path).map_err(|e| e.to_string())?;
			let keys: Vec<String> = o
				.options
				.as_object()
				.unwrap_or(&[])
				.iter()
				.map(|(k, _)| k.clone())
				.collect();
			if keys.iter().any(|k| k == "overrides") {
				return Err(format!("{path}overrides: overrides cannot be nested"));
			}
			overrides.push(Override {
				pages: o
					.pages
					.iter()
					.map(|g| {
						Pattern::new(g).map_err(|e| format!("{path}pages: invalid glob {g:?}: {e}"))
					})
					.collect::<Result<_, _>>()?,
				keys,
				layer: compile_layer(&parsed, &host, root_dir, &path)?,
			});
		}
		Ok(Pipeline {
			base,
			overrides,
			input_dir: config.dir.input.clone(),
			output_dir: config.dir.output.clone(),
			base_url: config.site.base_url.clone().unwrap_or_default(),
			host,
			memo: FileMemo::default(),
		})
	}
}

/// The options in force for one page: references into the base layer or into
/// the override that last named each option.
struct Effective<'a> {
	doctype: &'a bool,
	format: &'a Option<print::Options>,
	minify: &'a Option<minify::Options>,
	line_break: &'a &'static str,
	encoding: &'a kd_html::encode::Encoding,
	spec: &'a bool,
	entities: &'a kd_html::entities::Entities,
	image_sizes: &'a ImageSettings,
	rules: &'a [Scoped<Rule>],
	includes: &'a [Include],
	inject: &'a [Scoped<Inject>],
	on_error: &'a OnError,
}

impl Pipeline {
	fn effective(&self, url: &str) -> Effective<'_> {
		let b = &self.base;
		let mut e = Effective {
			doctype: &b.doctype,
			format: &b.format,
			minify: &b.minify,
			line_break: &b.line_break,
			encoding: &b.encoding,
			spec: &b.spec,
			entities: &b.entities,
			image_sizes: &b.image_sizes,
			rules: &b.rules,
			includes: &b.includes,
			inject: &b.inject,
			on_error: &b.on_error,
		};
		for o in &self.overrides {
			if !o.pages.iter().any(|p| p.matches(url)) {
				continue;
			}
			let l = &o.layer;
			for key in &o.keys {
				match key.as_str() {
					"doctype" => e.doctype = &l.doctype,
					"format" => e.format = &l.format,
					"minify" => e.minify = &l.minify,
					"lineBreak" => e.line_break = &l.line_break,
					"encoding" => e.encoding = &l.encoding,
					"serializer" => e.spec = &l.spec,
					"entities" => e.entities = &l.entities,
					"imageSizes" => e.image_sizes = &l.image_sizes,
					"rules" => e.rules = &l.rules,
					"includes" => e.includes = &l.includes,
					"inject" => e.inject = &l.inject,
					"onError" => e.on_error = &l.on_error,
					_ => {}
				}
			}
		}
		e
	}
}

// ----- reading files, recording what was read -----

/// Reads for the includes and the image sizes and remembers every file asked
/// for, with the fingerprint of the bytes returned (a missing file is
/// remembered as missing, so creating it later invalidates the page).
struct Recorder<'a> {
	deps: RefCell<BTreeMap<String, kd_build::Dep>>,
	memo: &'a FileMemo,
}

/// The bytes of a file and the fingerprint they were read with.
type Memoed = (kd_build::Dep, Arc<[u8]>);

/// The files that pages read (includes, images), kept for the pipeline so that a logo
/// used by every page is read and hashed once, not once per page. An entry is used only
/// while the file still has the size and mtime it was read with (one `stat`), so a dev
/// server that outlives an edit reads the new bytes.
#[derive(Default)]
pub(crate) struct FileMemo {
	entries: Mutex<HashMap<String, Memoed>>,
	held: AtomicUsize,
}

impl FileMemo {
	/// What the entries may hold in all. Why: a site of large images read by few pages
	/// each should not grow without bound; what does not fit is read every time.
	const BUDGET: usize = 256 * 1024 * 1024;

	fn get(&self, path: &str) -> Option<Memoed> {
		let hit = self
			.entries
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.get(path)
			.cloned()?;
		kd_build::stat_matches(path, &hit.0).then_some(hit)
	}

	fn put(&self, path: &str, dep: &kd_build::Dep, bytes: &Arc<[u8]>) {
		let mut entries = self.entries.lock().unwrap_or_else(|e| e.into_inner());
		let old = entries.get(path).map_or(0, |(_, b)| b.len());
		if self.held.load(Ordering::Relaxed) - old + bytes.len() > Self::BUDGET {
			return;
		}
		self.held.fetch_sub(old, Ordering::Relaxed);
		self.held.fetch_add(bytes.len(), Ordering::Relaxed);
		entries.insert(path.to_owned(), (dep.clone(), Arc::clone(bytes)));
	}
}

impl Recorder<'_> {
	fn read_bytes(&self, path: &str) -> Result<Option<Arc<[u8]>>, String> {
		if let Some((dep, bytes)) = self.memo.get(path) {
			self.deps.borrow_mut().insert(path.to_owned(), dep);
			return Ok(Some(bytes));
		}
		match kd_build::read_with_fingerprint(path) {
			Ok((bytes, dep)) => {
				let bytes: Arc<[u8]> = Arc::from(bytes);
				self.memo.put(path, &dep, &bytes);
				self.deps.borrow_mut().insert(path.to_owned(), dep);
				Ok(Some(bytes))
			}
			Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
				self.deps
					.borrow_mut()
					.insert(path.to_owned(), kd_build::Dep::missing());
				Ok(None)
			}
			Err(e) => Err(format!("cannot read {path}: {e}")),
		}
	}
}

impl Reader for Recorder<'_> {
	fn read(&self, path: &str) -> Result<String, String> {
		match self.read_bytes(path)? {
			Some(bytes) => String::from_utf8(bytes.to_vec())
				.map_err(|_| format!("{path}: file is not valid UTF-8")),
			None => Err(format!("{path}: No such file")),
		}
	}
}

impl ImageSource for Recorder<'_> {
	fn read(&self, path: &str) -> Result<Option<Arc<[u8]>>, String> {
		self.read_bytes(path)
	}
}

// ----- the stages -----

fn line_breaks(text: &str, line_break: &str) -> String {
	if !text.contains('\n') {
		return text.to_owned();
	}
	let lf = text.replace("\r\n", "\n");
	if line_break == "\n" {
		lf
	} else {
		lf.replace('\n', line_break)
	}
}

impl Pipeline {
	/// The DOM stage: parse once, includes, rules, inject, image sizes,
	/// serialize.
	fn dom_stage(
		&self,
		e: &Effective<'_>,
		input: &PageInput<'_>,
		recorder: &Recorder<'_>,
		warnings: &mut Vec<String>,
	) -> Result<String, String> {
		let mut page = Page::parse(input.source);
		if !e.includes.is_empty() {
			let env = includes::Env {
				input_dir: &self.input_dir,
				output_dir: &self.output_dir,
				page_file: input.input_path,
				reader: recorder,
				on_missing: match e.on_error {
					OnError::Error => OnMissing::Error,
					OnError::Warning => OnMissing::Warn,
					OnError::Silent => OnMissing::Silent,
				},
			};
			let report =
				includes::apply(&mut page.doc, e.includes, &env).map_err(|x| x.to_string())?;
			warnings.extend(report.warnings);
		}
		let ctx = rules::Context {
			url: input.url,
			base_url: &self.base_url,
			host: &self.host,
		};
		rules::apply(
			&mut page,
			e.rules
				.iter()
				.filter(|r| r.applies(input.url))
				.map(|r| &r.item),
			&ctx,
		)
		.map_err(|x| x.to_string())?;
		inject::apply(
			&mut page,
			e.inject
				.iter()
				.filter(|i| i.applies(input.url))
				.map(|i| &i.item),
			input.phase,
		);
		let images = e.image_sizes;
		if images.enabled && !images.exclude.iter().any(|p| p.matches(input.url)) {
			let options = image_sizes::Options {
				root_dir: &self.output_dir,
				keep_authored: images.keep_authored,
				extensions: &image_sizes::DEFAULT_EXTENSIONS,
			};
			image_sizes::apply(&mut page, &options, recorder).map_err(|ImageSizeError(m)| m)?;
		}
		Ok(page.serialize_with(&kd_html::serialize::Options {
			entities: e.entities.clone(),
			spec: *e.spec,
		}))
	}

	/// Runs every stage for one page.
	///
	/// # Errors
	///
	/// A message when a stage fails and `html.onError` is `error` (or when
	/// the options themselves cannot be applied).
	pub(crate) fn process(
		&self,
		input: &PageInput<'_>,
		hooks: &dyn minify::Hooks,
	) -> Result<PageOutput, String> {
		let e = self.effective(input.url);
		let recorder = Recorder {
			deps: RefCell::new(BTreeMap::new()),
			memo: &self.memo,
		};
		let mut warnings = Vec::new();
		let mut result = input.source.to_owned();

		// A failing stage under `silent` / `warning` leaves `result` as it was.
		let failed =
			|stage: &str, message: String, warnings: &mut Vec<String>| -> Result<(), String> {
				let full = format!(
					"Transform '{stage}' failed on {}: {message}",
					input.input_path
				);
				match e.on_error {
					OnError::Error => Err(full),
					OnError::Warning => {
						warnings.push(full);
						Ok(())
					}
					OnError::Silent => Ok(()),
				}
			};

		match self.dom_stage(&e, input, &recorder, &mut warnings) {
			Ok(html) => result = html,
			Err(message) => failed("dom", message, &mut warnings)?,
		}
		if *e.doctype {
			result = print::add_doctype(&result);
		}
		if let Some(options) = e.format {
			match print::format(&result, options) {
				Ok(html) => result = html,
				Err(error) => failed("format", error.to_string(), &mut warnings)?,
			}
		}
		if let Some(options) = e.minify {
			match minify::minify(&result, options, hooks) {
				Ok(html) => result = html,
				Err(error) => failed("minify", error.to_string(), &mut warnings)?,
			}
		}
		let html = line_breaks(&result, e.line_break);
		Ok(PageOutput {
			html,
			encoding: *e.encoding,
			warnings,
			deps: recorder.deps.into_inner(),
		})
	}
}
