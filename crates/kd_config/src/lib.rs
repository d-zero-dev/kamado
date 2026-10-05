//! `kamado.config.jsonc`: schema, defaults and validation.
//!
//! The config is data, not code, so every option is checked here with a
//! path in the message (`pages.files: expected a string or an array of
//! strings`). Unknown keys are errors rather than being ignored: a typo in a
//! declarative option would otherwise silently disable a feature.
//!
//! Relative paths are resolved against the directory that holds the config
//! file. `site.*` falls back to `package.json` (`production.host`,
//! `production.baseURL`, `production.siteName`, `production.siteNameEn`) in
//! that directory, as v2 did.
//!
//! Options that another crate interprets (HTML rules, includes, injections,
//! proxy rules) are validated for shape here and kept as `Value` so that the
//! interpreting crate owns their meaning.

use std::collections::BTreeMap;
use std::fmt;

use kd_jsonc::Value;
pub use kd_site::ConflictPolicy;

/// A configuration error with the dotted path of the offending option.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	pub path: String,
	pub message: String,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		if self.path.is_empty() {
			f.write_str(&self.message)
		} else {
			write!(f, "{}: {}", self.path, self.message)
		}
	}
}

impl std::error::Error for Error {}

type R<T> = Result<T, Error>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dir {
	pub input: String,
	pub output: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Site {
	pub host: Option<String>,
	pub base_url: Option<String>,
	pub site_name: Option<String>,
	pub site_name_en: Option<String>,
	/// `name` from package.json.
	pub package_name: Option<String>,
	/// `version` from package.json.
	pub package_version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Pages {
	pub files: Vec<String>,
	pub ignore: Vec<String>,
	pub output_extension: String,
	pub output_path_field: Option<String>,
	pub output_path_conflict: ConflictPolicy,
	pub layouts_dir: Option<String>,
	pub alias: BTreeMap<String, String>,
	pub define: BTreeMap<String, String>,
	/// Absolute path of the `pages.overrides` JSON file.
	pub overrides: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Data {
	pub dir: Option<String>,
	pub values: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Format {
	pub use_tabs: bool,
	pub tab_width: u32,
	pub print_width: u32,
	pub bracket_same_line: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Minify {
	pub boolean_attributes: bool,
	pub redundant_attributes: bool,
	pub script_type_attributes: bool,
	pub style_link_type_attributes: bool,
	pub css: bool,
	pub js: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Entities {
	None,
	All,
	Map(BTreeMap<String, String>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSizes {
	pub enabled: bool,
	pub exclude: Vec<String>,
	pub keep_authored: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnError {
	Silent,
	Warning,
	Error,
}

/// HTML post-processing options. `Option<Format>` / `Option<Minify>` are
/// `None` when turned off with `false`.
#[derive(Debug, Clone, PartialEq)]
pub struct Html {
	pub doctype: bool,
	pub format: Option<Format>,
	pub minify: Option<Minify>,
	pub line_break: String,
	pub entities: Entities,
	pub image_sizes: ImageSizes,
	pub rules: Vec<Value>,
	pub includes: Vec<Value>,
	pub inject: Vec<Value>,
	pub overrides: Vec<HtmlOverride>,
	pub on_error: OnError,
}

/// Per-page override: `pages` globs plus the raw `html` options to apply.
#[derive(Debug, Clone, PartialEq)]
pub struct HtmlOverride {
	pub pages: Vec<String>,
	pub options: Value,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sitemap {
	pub output: String,
	pub include: Vec<String>,
	pub exclude: Vec<String>,
	pub lastmod: Lastmod,
	pub changefreq: Option<String>,
	pub priority: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lastmod {
	Manifest,
	Mtime,
	None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sourcemap {
	On,
	Off,
	OnServer,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Styles {
	pub files: Vec<String>,
	pub ignore: Vec<String>,
	pub alias: BTreeMap<String, String>,
	/// `None` when disabled with `false` or `""`.
	pub banner: Option<String>,
	pub sourcemap: Sourcemap,
	pub minify: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Scripts {
	pub files: Vec<String>,
	pub ignore: Vec<String>,
	pub alias: BTreeMap<String, String>,
	pub define: BTreeMap<String, String>,
	pub banner: Option<String>,
	pub sourcemap: Sourcemap,
	pub minify: bool,
	pub target: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DevServer {
	pub port: u16,
	pub host: String,
	pub open: bool,
	pub start_path: String,
	/// Prefix → rule object, validated for shape, interpreted by the server.
	pub proxy: Vec<(String, Value)>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Jobs {
	Auto,
	Count(usize),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Build {
	pub jobs: Jobs,
	pub incremental: bool,
	pub cache_dir: Option<String>,
	pub skip_unchanged: bool,
	pub report: Option<String>,
}

/// The whole configuration with defaults applied and paths made absolute.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
	/// Directory of the config file.
	pub root_dir: String,
	pub dir: Dir,
	pub site: Site,
	pub pages: Pages,
	pub data: Data,
	pub html: Html,
	pub sitemap: Option<Sitemap>,
	pub styles: Styles,
	pub scripts: Scripts,
	pub dev_server: DevServer,
	pub build: Build,
}

/// Default banner, the same text v2 produced.
pub const DEFAULT_BANNER: &str = "rev. {{date:YYYY-MM-DD}}\ncopyright © {{year}}";

/// Parses a config document. `root_dir` is the absolute directory of the
/// config file; `package_json` is its `package.json` text when present.
///
/// # Example
///
/// ```
/// let cfg = kd_config::parse(
///     r#"{ "dir": { "input": "src", "output": "htdocs" }, "devServer": { "port": 8000 } }"#,
///     "/site",
///     Some(r#"{ "name": "site", "production": { "host": "example.com" } }"#),
/// ).unwrap();
/// assert_eq!(cfg.dir.input, "/site/src");
/// assert_eq!(cfg.dev_server.port, 8000);
/// assert_eq!(cfg.site.host.as_deref(), Some("example.com"));
/// ```
pub fn parse(config_text: &str, root_dir: &str, package_json: Option<&str>) -> R<Config> {
	let value = kd_jsonc::parse(config_text).map_err(|e| Error {
		path: String::new(),
		message: format!("invalid JSONC at {}:{}: {}", e.line, e.column, e.message),
	})?;
	let root = Obj::new(&value, "")?;
	root.allow(&[
		"$schema",
		"dir",
		"site",
		"pages",
		"data",
		"html",
		"sitemap",
		"styles",
		"scripts",
		"devServer",
		"build",
	])?;
	let resolve = |p: &str| kd_site::path::join(root_dir, p);

	let dir = {
		let o = root.obj("dir")?;
		o.allow(&["input", "output"])?;
		let dir = Dir {
			input: resolve(o.str_or("input", ".")?.as_str()),
			output: resolve(o.str_or("output", ".")?.as_str()),
		};
		// Why an error: with the same directory an output file has the path of
		// its source, so a build would overwrite the author's files (and strip
		// their front matter). The default for both is the config directory,
		// so this also catches a config that sets neither.
		if dir.input == dir.output {
			return Err(Error {
				path: "dir.output".to_string(),
				message: format!(
					"must differ from dir.input ({}); the build would overwrite its own sources. Set \"dir\": {{ \"input\": ..., \"output\": ... }}",
					dir.input
				),
			});
		}
		dir
	};

	let site = {
		let o = root.obj("site")?;
		o.allow(&["host", "baseURL", "siteName", "siteNameEn"])?;
		let pkg = package_json
			.map(parse_package_json)
			.transpose()?
			.unwrap_or_default();
		Site {
			host: o.opt_str("host")?.or(pkg.host),
			base_url: o.opt_str("baseURL")?.or(pkg.base_url),
			site_name: o.opt_str("siteName")?.or(pkg.site_name),
			site_name_en: o.opt_str("siteNameEn")?.or(pkg.site_name_en),
			package_name: pkg.package_name,
			package_version: pkg.package_version,
		}
	};

	let pages = {
		let o = root.obj("pages")?;
		o.allow(&[
			"files",
			"ignore",
			"outputExtension",
			"outputPathField",
			"outputPathConflict",
			"layouts",
			"alias",
			"define",
			"overrides",
		])?;
		let layouts = o.obj("layouts")?;
		layouts.allow(&["dir"])?;
		Pages {
			files: o.globs_or("files", &["**/*.{html,tsx}"])?,
			ignore: o.globs_or("ignore", &[])?,
			output_extension: o.extension_or("outputExtension", ".html")?,
			output_path_field: o.opt_str("outputPathField")?,
			output_path_conflict: match o.str_or("outputPathConflict", "warning")?.as_str() {
				"error" => ConflictPolicy::Error,
				"warning" => ConflictPolicy::Warning,
				"silent" => ConflictPolicy::Silent,
				other => {
					return Err(o.err(
						"outputPathConflict",
						format!("expected \"error\", \"warning\" or \"silent\", got {other:?}"),
					));
				}
			},
			layouts_dir: layouts.opt_str("dir")?.map(|p| resolve(&p)),
			alias: o.string_map("alias")?,
			define: o.string_map("define")?,
			overrides: o.opt_str("overrides")?.map(|p| resolve(&p)),
		}
	};

	let data = {
		let o = root.obj("data")?;
		o.allow(&["dir", "values"])?;
		Data {
			dir: o.opt_str("dir")?.map(|p| resolve(&p)),
			values: match o.get("values") {
				None => Value::Object(vec![]),
				Some(v @ Value::Object(_)) => v.clone(),
				Some(_) => return Err(o.err("values", "expected an object")),
			},
		}
	};

	let html = parse_html(&root.obj("html")?)?;

	let sitemap = match root.get("sitemap") {
		None | Some(Value::Bool(false)) => None,
		Some(_) => {
			let o = root.obj("sitemap")?;
			o.allow(&[
				"output",
				"include",
				"exclude",
				"lastmod",
				"changefreq",
				"priority",
			])?;
			Some(Sitemap {
				output: o.str_or("output", "sitemap.xml")?,
				include: o.globs_or("include", &["**/*.html"])?,
				exclude: o.globs_or("exclude", &[])?,
				lastmod: match o.str_or("lastmod", "none")?.as_str() {
					"manifest" => Lastmod::Manifest,
					"mtime" => Lastmod::Mtime,
					"none" => Lastmod::None,
					other => {
						return Err(o.err(
							"lastmod",
							format!("expected \"manifest\", \"mtime\" or \"none\", got {other:?}"),
						));
					}
				},
				changefreq: o.opt_str("changefreq")?,
				priority: o.opt_string_or_number("priority")?,
			})
		}
	};

	let styles = {
		let o = root.obj("styles")?;
		o.allow(&["files", "ignore", "alias", "banner", "sourcemap", "minify"])?;
		Styles {
			files: o.globs_or("files", &["**/*.css"])?,
			ignore: o.globs_or("ignore", &[])?,
			alias: o.string_map("alias")?,
			banner: o.banner("banner")?,
			sourcemap: o.sourcemap("sourcemap")?,
			minify: o.bool_or("minify", true)?,
		}
	};

	let scripts = {
		let o = root.obj("scripts")?;
		o.allow(&[
			"files",
			"ignore",
			"alias",
			"define",
			"banner",
			"sourcemap",
			"minify",
			"target",
		])?;
		Scripts {
			files: o.globs_or("files", &["**/*.{js,ts,jsx,tsx,mjs,cjs}"])?,
			ignore: o.globs_or("ignore", &[])?,
			alias: o.string_map("alias")?,
			define: o.string_map("define")?,
			banner: o.banner("banner")?,
			sourcemap: o.sourcemap("sourcemap")?,
			minify: o.bool_or("minify", true)?,
			target: o.str_or("target", "es2022")?,
		}
	};

	let dev_server = {
		let o = root.obj("devServer")?;
		o.allow(&["port", "host", "open", "startPath", "proxy"])?;
		let port = o.number_or("port", 3000.0)?;
		if port.fract() != 0.0 || !(1.0..=65535.0).contains(&port) {
			return Err(o.err("port", "expected an integer between 1 and 65535"));
		}
		let proxy = match o.get("proxy") {
			None => vec![],
			Some(Value::Object(pairs)) => {
				let mut rules = Vec::new();
				for (prefix, rule) in pairs {
					let path = format!("devServer.proxy.{prefix}");
					if !prefix.starts_with('/') {
						return Err(Error {
							path,
							message: "proxy prefixes must start with '/'".to_string(),
						});
					}
					match rule {
						Value::String(_) | Value::Object(_) => {
							rules.push((prefix.clone(), rule.clone()))
						}
						_ => {
							return Err(Error {
								path,
								message: "expected a target URL string or a rule object"
									.to_string(),
							});
						}
					}
				}
				rules
			}
			Some(_) => return Err(o.err("proxy", "expected an object keyed by path prefix")),
		};
		DevServer {
			port: port as u16,
			host: o.str_or("host", "localhost")?,
			open: o.bool_or("open", false)?,
			start_path: o.str_or("startPath", "/")?,
			proxy,
		}
	};

	let build = {
		let o = root.obj("build")?;
		o.allow(&["jobs", "incremental", "cacheDir", "skipUnchanged", "report"])?;
		let jobs = match o.get("jobs") {
			None => Jobs::Auto,
			Some(Value::String(s)) if s == "auto" => Jobs::Auto,
			Some(Value::Number(n)) if n.fract() == 0.0 && *n >= 1.0 => Jobs::Count(*n as usize),
			Some(_) => return Err(o.err("jobs", "expected \"auto\" or a positive integer")),
		};
		Build {
			jobs,
			incremental: o.bool_or("incremental", false)?,
			cache_dir: o.opt_str("cacheDir")?.map(|p| resolve(&p)),
			skip_unchanged: o.bool_or("skipUnchanged", false)?,
			report: o.opt_str("report")?.map(|p| resolve(&p)),
		}
	};

	Ok(Config {
		root_dir: root_dir.to_string(),
		dir,
		site,
		pages,
		data,
		html,
		sitemap,
		styles,
		scripts,
		dev_server,
		build,
	})
}

fn parse_html(o: &Obj<'_>) -> R<Html> {
	o.allow(&[
		"doctype",
		"format",
		"minify",
		"lineBreak",
		"entities",
		"imageSizes",
		"rules",
		"includes",
		"inject",
		"overrides",
		"onError",
	])?;
	let format = match o.get("format") {
		Some(Value::Bool(false)) => None,
		None | Some(Value::Bool(true)) => Some(Format {
			use_tabs: true,
			tab_width: 2,
			print_width: 100_000,
			bracket_same_line: true,
		}),
		Some(Value::Object(_)) => {
			let f = o.obj("format")?;
			f.allow(&["useTabs", "tabWidth", "printWidth", "bracketSameLine"])?;
			Some(Format {
				use_tabs: f.bool_or("useTabs", true)?,
				tab_width: f.uint_or("tabWidth", 2)?,
				print_width: f.uint_or("printWidth", 100_000)?,
				bracket_same_line: f.bool_or("bracketSameLine", true)?,
			})
		}
		Some(_) => return Err(o.err("format", "expected false or an object")),
	};
	let minify = match o.get("minify") {
		Some(Value::Bool(false)) => None,
		None | Some(Value::Bool(true)) => Some(Minify {
			boolean_attributes: true,
			redundant_attributes: true,
			script_type_attributes: true,
			style_link_type_attributes: true,
			css: true,
			js: true,
		}),
		Some(Value::Object(_)) => {
			let m = o.obj("minify")?;
			m.allow(&[
				"booleanAttributes",
				"redundantAttributes",
				"scriptTypeAttributes",
				"styleLinkTypeAttributes",
				"css",
				"js",
			])?;
			Some(Minify {
				boolean_attributes: m.bool_or("booleanAttributes", true)?,
				redundant_attributes: m.bool_or("redundantAttributes", true)?,
				script_type_attributes: m.bool_or("scriptTypeAttributes", true)?,
				style_link_type_attributes: m.bool_or("styleLinkTypeAttributes", true)?,
				css: m.bool_or("css", true)?,
				js: m.bool_or("js", true)?,
			})
		}
		Some(_) => return Err(o.err("minify", "expected false or an object")),
	};
	let line_break = match o.str_or("lineBreak", "\n")?.as_str() {
		"\n" | "lf" => "\n".to_string(),
		"\r\n" | "crlf" => "\r\n".to_string(),
		other => {
			return Err(o.err(
				"lineBreak",
				format!("expected \"\\n\" (\"lf\") or \"\\r\\n\" (\"crlf\"), got {other:?}"),
			));
		}
	};
	let entities = match o.get("entities") {
		None => Entities::None,
		Some(Value::String(s)) if s == "none" => Entities::None,
		Some(Value::String(s)) if s == "all" => Entities::All,
		Some(Value::Object(_)) => Entities::Map(o.string_map("entities")?),
		Some(_) => return Err(o.err("entities", "expected \"none\", \"all\" or an object")),
	};
	let image_sizes = match o.get("imageSizes") {
		None | Some(Value::Bool(true)) => ImageSizes {
			enabled: true,
			exclude: vec![],
			keep_authored: false,
		},
		Some(Value::Bool(false)) => ImageSizes {
			enabled: false,
			exclude: vec![],
			keep_authored: false,
		},
		Some(Value::Object(_)) => {
			let i = o.obj("imageSizes")?;
			i.allow(&["enabled", "exclude", "keepAuthored"])?;
			ImageSizes {
				enabled: i.bool_or("enabled", true)?,
				exclude: i.globs_or("exclude", &[])?,
				keep_authored: i.bool_or("keepAuthored", false)?,
			}
		}
		Some(_) => return Err(o.err("imageSizes", "expected a boolean or an object")),
	};
	let overrides = match o.get("overrides") {
		None => vec![],
		Some(Value::Array(items)) => {
			let mut out = Vec::new();
			for (i, item) in items.iter().enumerate() {
				let path = format!("{}overrides[{i}]", o.prefix());
				let Value::Object(pairs) = item else {
					return Err(Error {
						path,
						message: "expected an object".to_string(),
					});
				};
				let pages_value = pairs.iter().find(|(k, _)| k == "pages").map(|(_, v)| v);
				let pages = match pages_value {
					Some(v) => globs_from(v, &format!("{path}.pages"))?,
					None => {
						return Err(Error {
							path,
							message: "an override needs a \"pages\" glob list".to_string(),
						});
					}
				};
				let options = Value::Object(
					pairs
						.iter()
						.filter(|(k, _)| k != "pages")
						.cloned()
						.collect(),
				);
				// The remaining options are validated by parsing them as an `html` object.
				let nested = Obj::new(&options, &format!("{path}."))?;
				parse_html(&nested)?;
				out.push(HtmlOverride { pages, options });
			}
			out
		}
		Some(_) => return Err(o.err("overrides", "expected an array")),
	};
	let on_error = match o.str_or("onError", "silent")?.as_str() {
		"silent" => OnError::Silent,
		"warning" => OnError::Warning,
		"error" => OnError::Error,
		other => {
			return Err(o.err(
				"onError",
				format!("expected \"silent\", \"warning\" or \"error\", got {other:?}"),
			));
		}
	};
	Ok(Html {
		doctype: o.bool_or("doctype", true)?,
		format,
		minify,
		line_break,
		entities,
		image_sizes,
		rules: o.object_array("rules")?,
		includes: o.object_array("includes")?,
		inject: o.object_array("inject")?,
		overrides,
		on_error,
	})
}

#[derive(Default)]
struct PackageJson {
	host: Option<String>,
	base_url: Option<String>,
	site_name: Option<String>,
	site_name_en: Option<String>,
	package_name: Option<String>,
	package_version: Option<String>,
}

fn parse_package_json(text: &str) -> R<PackageJson> {
	let value = kd_jsonc::parse(text).map_err(|e| Error {
		path: "package.json".to_string(),
		message: format!("invalid JSON at {}:{}: {}", e.line, e.column, e.message),
	})?;
	let s = |v: Option<&Value>| v.and_then(|v| v.as_str()).map(str::to_string);
	let production = value.get("production");
	Ok(PackageJson {
		host: s(production.and_then(|p| p.get("host"))),
		base_url: s(production.and_then(|p| p.get("baseURL"))),
		site_name: s(production.and_then(|p| p.get("siteName"))),
		site_name_en: s(production.and_then(|p| p.get("siteNameEn"))),
		package_name: s(value.get("name")),
		package_version: s(value.get("version")),
	})
}

fn globs_from(v: &Value, path: &str) -> R<Vec<String>> {
	let items: Vec<String> = match v {
		Value::String(s) => vec![s.clone()],
		Value::Array(items) => items
			.iter()
			.map(|i| {
				i.as_str().map(str::to_string).ok_or_else(|| Error {
					path: path.to_string(),
					message: "expected a string or an array of strings".to_string(),
				})
			})
			.collect::<R<_>>()?,
		_ => {
			return Err(Error {
				path: path.to_string(),
				message: "expected a string or an array of strings".to_string(),
			});
		}
	};
	for g in &items {
		let pattern = kd_glob::Pattern::new(g).map_err(|e| Error {
			path: path.to_string(),
			message: format!("invalid glob {g:?}: {e}"),
		})?;
		// Why an error: a negated pattern compiles but nothing applies the
		// negation, so `["**/*.html", "!drafts/**"]` would silently include
		// drafts. Exclusion has its own option (`ignore` / `exclude`).
		if pattern.is_negated() {
			return Err(Error {
				path: path.to_string(),
				message: format!(
					"negated glob {g:?} is not supported; list what to leave out in the matching \"ignore\" / \"exclude\" option"
				),
			});
		}
	}
	Ok(items)
}

/// Typed access to one JSON object with path-carrying errors.
struct Obj<'a> {
	pairs: &'a [(String, Value)],
	/// Dotted prefix including the trailing dot, or empty at the root.
	prefix: String,
}

impl<'a> Obj<'a> {
	fn new(value: &'a Value, prefix: &str) -> R<Obj<'a>> {
		match value {
			Value::Object(pairs) => Ok(Obj {
				pairs,
				prefix: prefix.to_string(),
			}),
			_ => Err(Error {
				path: prefix.trim_end_matches('.').to_string(),
				message: "expected an object".to_string(),
			}),
		}
	}

	fn empty(prefix: &str) -> Obj<'static> {
		Obj {
			pairs: &[],
			prefix: prefix.to_string(),
		}
	}

	fn prefix(&self) -> &str {
		&self.prefix
	}

	fn err(&self, key: &str, message: impl Into<String>) -> Error {
		Error {
			path: format!("{}{key}", self.prefix),
			message: message.into(),
		}
	}

	fn get(&self, key: &str) -> Option<&'a Value> {
		self.pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v)
	}

	fn allow(&self, keys: &[&str]) -> R<()> {
		for (k, _) in self.pairs {
			if !keys.contains(&k.as_str()) {
				return Err(self.err(k, format!("unknown option (allowed: {})", keys.join(", "))));
			}
		}
		Ok(())
	}

	/// Child object; a missing key is an empty object.
	fn obj(&self, key: &str) -> R<Obj<'a>> {
		match self.get(key) {
			None => Ok(Obj::empty(&format!("{}{key}.", self.prefix))),
			Some(v) => Obj::new(v, &format!("{}{key}.", self.prefix)),
		}
	}

	fn opt_str(&self, key: &str) -> R<Option<String>> {
		match self.get(key) {
			None | Some(Value::Null) => Ok(None),
			Some(Value::String(s)) => Ok(Some(s.clone())),
			Some(_) => Err(self.err(key, "expected a string")),
		}
	}

	fn str_or(&self, key: &str, default: &str) -> R<String> {
		Ok(self.opt_str(key)?.unwrap_or_else(|| default.to_string()))
	}

	fn opt_string_or_number(&self, key: &str) -> R<Option<String>> {
		match self.get(key) {
			None | Some(Value::Null) => Ok(None),
			Some(Value::String(s)) => Ok(Some(s.clone())),
			Some(Value::Number(n)) => Ok(Some(Value::Number(*n).to_json())),
			Some(_) => Err(self.err(key, "expected a string or a number")),
		}
	}

	fn bool_or(&self, key: &str, default: bool) -> R<bool> {
		match self.get(key) {
			None => Ok(default),
			Some(Value::Bool(b)) => Ok(*b),
			Some(_) => Err(self.err(key, "expected true or false")),
		}
	}

	fn number_or(&self, key: &str, default: f64) -> R<f64> {
		match self.get(key) {
			None => Ok(default),
			Some(Value::Number(n)) => Ok(*n),
			Some(_) => Err(self.err(key, "expected a number")),
		}
	}

	fn uint_or(&self, key: &str, default: u32) -> R<u32> {
		let n = self.number_or(key, f64::from(default))?;
		if n.fract() != 0.0 || n < 0.0 || n > f64::from(u32::MAX) {
			return Err(self.err(key, "expected a non-negative integer"));
		}
		Ok(n as u32)
	}

	fn extension_or(&self, key: &str, default: &str) -> R<String> {
		let ext = self.str_or(key, default)?;
		if !ext.is_empty() && !ext.starts_with('.') {
			return Err(self.err(
				key,
				format!("expected an extension starting with '.', got {ext:?}"),
			));
		}
		Ok(ext)
	}

	fn globs_or(&self, key: &str, default: &[&str]) -> R<Vec<String>> {
		match self.get(key) {
			None => Ok(default.iter().map(|s| s.to_string()).collect()),
			Some(v) => globs_from(v, &format!("{}{key}", self.prefix)),
		}
	}

	fn string_map(&self, key: &str) -> R<BTreeMap<String, String>> {
		match self.get(key) {
			None => Ok(BTreeMap::new()),
			Some(Value::Object(pairs)) => pairs
				.iter()
				.map(|(k, v)| {
					v.as_str()
						.map(|s| (k.clone(), s.to_string()))
						.ok_or_else(|| self.err(&format!("{key}.{k}"), "expected a string"))
				})
				.collect(),
			Some(_) => Err(self.err(key, "expected an object of strings")),
		}
	}

	fn object_array(&self, key: &str) -> R<Vec<Value>> {
		match self.get(key) {
			None => Ok(vec![]),
			Some(Value::Array(items)) => {
				for (i, item) in items.iter().enumerate() {
					if !matches!(item, Value::Object(_)) {
						return Err(self.err(&format!("{key}[{i}]"), "expected an object"));
					}
				}
				Ok(items.clone())
			}
			Some(_) => Err(self.err(key, "expected an array of objects")),
		}
	}

	/// `banner`: a string (empty means off), `false` (off) or absent (default).
	fn banner(&self, key: &str) -> R<Option<String>> {
		match self.get(key) {
			None => Ok(Some(DEFAULT_BANNER.to_string())),
			Some(Value::Bool(false)) => Ok(None),
			Some(Value::String(s)) if s.is_empty() => Ok(None),
			Some(Value::String(s)) => Ok(Some(s.clone())),
			Some(_) => Err(self.err(key, "expected a string or false")),
		}
	}

	fn sourcemap(&self, key: &str) -> R<Sourcemap> {
		match self.get(key) {
			None => Ok(Sourcemap::OnServer),
			Some(Value::Bool(true)) => Ok(Sourcemap::On),
			Some(Value::Bool(false)) => Ok(Sourcemap::Off),
			Some(Value::String(s)) if s == "onServer" => Ok(Sourcemap::OnServer),
			Some(_) => Err(self.err(key, "expected true, false or \"onServer\"")),
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Most tests are about other options, so they get a valid `dir` unless
	/// they spell their own (the input and output directories must differ).
	fn with_dir(text: &str) -> String {
		if text.contains("\"dir\"") {
			text.to_string()
		} else {
			text.replacen('{', r#"{ "dir": { "input": "src", "output": "out" },"#, 1)
		}
	}

	fn ok(text: &str) -> Config {
		parse(&with_dir(text), "/site", None).unwrap()
	}

	fn fail(text: &str) -> Error {
		parse(&with_dir(text), "/site", None).unwrap_err()
	}

	#[test]
	fn input_and_output_directories_must_differ() {
		for text in [
			"{}",
			r#"{ "dir": { "input": "src", "output": "src" } }"#,
			r#"{ "dir": { "input": "a/../src", "output": "src/" } }"#,
		] {
			let e = parse(text, "/site", None).unwrap_err();
			assert_eq!(e.path, "dir.output", "{text}");
			assert!(
				e.message.starts_with("must differ from dir.input"),
				"{text}"
			);
		}
		assert!(parse(r#"{ "dir": { "output": "htdocs" } }"#, "/site", None).is_ok());
	}

	#[test]
	fn negated_globs_are_rejected_with_a_hint() {
		let e = fail(r#"{ "pages": { "files": ["**/*.html", "!drafts/**"] } }"#);
		assert_eq!(e.path, "pages.files");
		assert!(
			e.message
				.contains("negated glob \"!drafts/**\" is not supported")
		);
		assert_eq!(
			fail(r#"{ "styles": { "ignore": "!keep/**" } }"#).path,
			"styles.ignore"
		);
		assert_eq!(
			fail(r#"{ "html": { "imageSizes": { "exclude": ["!a"] } } }"#).path,
			"html.imageSizes.exclude"
		);
	}

	#[test]
	fn empty_config_gets_every_default() {
		let c = ok("{}");
		assert_eq!(c.root_dir, "/site");
		assert_eq!(
			c.dir,
			Dir {
				input: "/site/src".into(),
				output: "/site/out".into()
			}
		);
		assert_eq!(c.pages.files, ["**/*.{html,tsx}"]);
		assert_eq!(c.pages.output_extension, ".html");
		assert_eq!(c.pages.output_path_conflict, ConflictPolicy::Warning);
		assert_eq!(c.pages.layouts_dir, None);
		assert!(c.html.doctype);
		assert_eq!(
			c.html.format,
			Some(Format {
				use_tabs: true,
				tab_width: 2,
				print_width: 100_000,
				bracket_same_line: true
			})
		);
		assert!(c.html.minify.as_ref().unwrap().js);
		assert_eq!(c.html.line_break, "\n");
		assert_eq!(c.html.entities, Entities::None);
		assert!(c.html.image_sizes.enabled);
		assert_eq!(c.html.on_error, OnError::Silent);
		assert_eq!(c.sitemap, None);
		assert_eq!(c.styles.files, ["**/*.css"]);
		assert_eq!(c.styles.banner.as_deref(), Some(DEFAULT_BANNER));
		assert_eq!(c.styles.sourcemap, Sourcemap::OnServer);
		assert_eq!(c.scripts.files, ["**/*.{js,ts,jsx,tsx,mjs,cjs}"]);
		assert_eq!(c.scripts.target, "es2022");
		assert_eq!(c.dev_server.port, 3000);
		assert_eq!(c.dev_server.host, "localhost");
		assert_eq!(c.dev_server.start_path, "/");
		assert_eq!(c.build.jobs, Jobs::Auto);
		assert!(!c.build.incremental);
	}

	#[test]
	fn relative_paths_resolve_against_the_config_directory() {
		let c = ok(r#"{
			"dir": { "input": "__assets/htdocs", "output": "htdocs" },
			"pages": { "layouts": { "dir": "__assets/_libs/layouts" }, "overrides": "pages.json" },
			"data": { "dir": "/abs/data" },
			"build": { "cacheDir": ".kamado/cache", "report": "report.json" }
		}"#);
		assert_eq!(c.dir.input, "/site/__assets/htdocs");
		assert_eq!(c.dir.output, "/site/htdocs");
		assert_eq!(
			c.pages.layouts_dir.as_deref(),
			Some("/site/__assets/_libs/layouts")
		);
		assert_eq!(c.pages.overrides.as_deref(), Some("/site/pages.json"));
		assert_eq!(c.data.dir.as_deref(), Some("/abs/data"));
		assert_eq!(c.build.cache_dir.as_deref(), Some("/site/.kamado/cache"));
		assert_eq!(c.build.report.as_deref(), Some("/site/report.json"));
	}

	#[test]
	fn site_falls_back_to_package_json_production() {
		let pkg = r#"{ "name": "my-site", "version": "1.2.3", "production": { "host": "example.com", "baseURL": "https://example.com/", "siteName": "Example", "siteNameEn": "Example EN" } }"#;
		let c = parse(
			&with_dir(r#"{ "site": { "siteName": "Override" } }"#),
			"/site",
			Some(pkg),
		)
		.unwrap();
		assert_eq!(c.site.host.as_deref(), Some("example.com"));
		assert_eq!(c.site.base_url.as_deref(), Some("https://example.com/"));
		assert_eq!(c.site.site_name.as_deref(), Some("Override"));
		assert_eq!(c.site.site_name_en.as_deref(), Some("Example EN"));
		assert_eq!(c.site.package_name.as_deref(), Some("my-site"));
		assert_eq!(c.site.package_version.as_deref(), Some("1.2.3"));
		let c = parse(&with_dir("{}"), "/site", Some(r#"{ "name": "x" }"#)).unwrap();
		assert_eq!(c.site.host, None);
	}

	#[test]
	fn comments_and_schema_key_are_accepted() {
		let c = ok(
			"{\n  \"$schema\": \"./node_modules/kamado/schema.json\",\n  // dev server\n  \"devServer\": { \"port\": 8000, \"open\": true, },\n}",
		);
		assert_eq!(c.dev_server.port, 8000);
		assert!(c.dev_server.open);
	}

	#[test]
	fn unknown_keys_are_errors_with_their_path() {
		let e = fail(r#"{ "pages": { "file": "**/*.html" } }"#);
		assert_eq!(e.path, "pages.file");
		assert!(
			e.message
				.starts_with("unknown option (allowed: files, ignore")
		);
		assert_eq!(fail(r#"{ "compilers": [] }"#).path, "compilers");
		assert_eq!(
			fail(r#"{ "html": { "format": { "width": 80 } } }"#).path,
			"html.format.width"
		);
	}

	#[test]
	fn type_errors_name_the_option() {
		assert_eq!(
			fail(r#"{ "devServer": { "port": "8000" } }"#).to_string(),
			"devServer.port: expected a number"
		);
		assert_eq!(
			fail(r#"{ "devServer": { "port": 70000 } }"#).path,
			"devServer.port"
		);
		assert_eq!(
			fail(r#"{ "pages": { "files": 1 } }"#).to_string(),
			"pages.files: expected a string or an array of strings"
		);
		assert_eq!(
			fail(r#"{ "pages": { "files": ["a", 2] } }"#).path,
			"pages.files"
		);
		assert_eq!(
			fail(r#"{ "pages": { "outputExtension": "html" } }"#).path,
			"pages.outputExtension"
		);
		assert_eq!(
			fail(r#"{ "pages": { "outputPathConflict": "ignore" } }"#).path,
			"pages.outputPathConflict"
		);
		assert_eq!(
			fail(r#"{ "pages": { "alias": { "@": 1 } } }"#).path,
			"pages.alias.@"
		);
		assert_eq!(
			fail(r#"{ "html": { "lineBreak": "\r" } }"#).path,
			"html.lineBreak"
		);
		assert_eq!(
			fail(r#"{ "html": { "onError": "throw" } }"#).path,
			"html.onError"
		);
		assert_eq!(
			fail(r#"{ "html": { "rules": [1] } }"#).path,
			"html.rules[0]"
		);
		assert_eq!(
			fail(r#"{ "html": { "entities": true } }"#).path,
			"html.entities"
		);
		assert_eq!(
			fail(r#"{ "styles": { "sourcemap": "always" } }"#).path,
			"styles.sourcemap"
		);
		assert_eq!(fail(r#"{ "build": { "jobs": 0 } }"#).path, "build.jobs");
		assert_eq!(fail(r#"{ "data": { "values": [] } }"#).path, "data.values");
		assert_eq!(fail(r#"{ "dir": "src" }"#).path, "dir");
	}

	#[test]
	fn invalid_globs_are_rejected_at_load_time() {
		let e = fail(r#"{ "pages": { "ignore": ["@(a|b)/**"] } }"#);
		assert_eq!(e.path, "pages.ignore");
		assert!(e.message.contains("invalid glob"));
	}

	#[test]
	fn invalid_jsonc_reports_position() {
		// Parsed without the test helper's `dir`, so the position is the file's own.
		let e = parse("{ \"a\": }", "/site", None).unwrap_err();
		assert_eq!(e.path, "");
		assert!(e.message.starts_with("invalid JSONC at 1:8"));
	}

	#[test]
	fn html_options_can_be_turned_off_or_tuned() {
		let c = ok(
			r#"{ "html": { "format": false, "minify": { "js": false }, "doctype": false, "lineBreak": "crlf", "entities": { "©": "&copy;" }, "imageSizes": { "exclude": ["/lp/**"], "keepAuthored": true } } }"#,
		);
		assert_eq!(c.html.format, None);
		let m = c.html.minify.unwrap();
		assert!(!m.js);
		assert!(m.css);
		assert!(!c.html.doctype);
		assert_eq!(c.html.line_break, "\r\n");
		assert_eq!(
			c.html.entities,
			Entities::Map(BTreeMap::from([("©".to_string(), "&copy;".to_string())]))
		);
		assert_eq!(c.html.image_sizes.exclude, ["/lp/**"]);
		assert!(c.html.image_sizes.keep_authored);
		let c = ok(
			r#"{ "html": { "format": { "printWidth": 90, "useTabs": false }, "minify": false, "imageSizes": false, "entities": "all" } }"#,
		);
		assert_eq!(
			c.html.format,
			Some(Format {
				use_tabs: false,
				tab_width: 2,
				print_width: 90,
				bracket_same_line: true
			})
		);
		assert_eq!(c.html.minify, None);
		assert!(!c.html.image_sizes.enabled);
		assert_eq!(c.html.entities, Entities::All);
	}

	#[test]
	fn html_overrides_need_pages_and_are_validated_like_html() {
		let c = ok(
			r#"{ "html": { "overrides": [ { "pages": ["/legacy/**"], "format": false, "minify": false } ] } }"#,
		);
		assert_eq!(c.html.overrides.len(), 1);
		assert_eq!(c.html.overrides[0].pages, ["/legacy/**"]);
		assert_eq!(
			c.html.overrides[0].options.get("format"),
			Some(&Value::Bool(false))
		);
		assert!(c.html.overrides[0].options.get("pages").is_none());
		assert_eq!(
			fail(r#"{ "html": { "overrides": [ { "format": false } ] } }"#).path,
			"html.overrides[0]"
		);
		assert_eq!(
			fail(r#"{ "html": { "overrides": [ { "pages": "**", "bogus": 1 } ] } }"#).path,
			"html.overrides[0].bogus"
		);
	}

	#[test]
	fn rules_includes_inject_and_proxy_keep_their_shape() {
		let c = ok(r#"{
			"html": {
				"rules": [ { "selector": "a[href^='http']", "action": "setAttr", "name": "rel", "value": "noopener" } ],
				"includes": [ { "preset": "ssi" } ],
				"inject": [ { "pages": ["**"], "position": "head-end", "html": "<meta name=x>" } ]
			},
			"devServer": { "proxy": { "/api": { "target": "https://api.example.com", "changeOrigin": true }, "/img": "https://cdn.example.com" } }
		}"#);
		assert_eq!(c.html.rules.len(), 1);
		assert_eq!(
			c.html.rules[0].get("action").and_then(|v| v.as_str()),
			Some("setAttr")
		);
		assert_eq!(
			c.html.includes[0].get("preset").and_then(|v| v.as_str()),
			Some("ssi")
		);
		assert_eq!(c.html.inject.len(), 1);
		assert_eq!(c.dev_server.proxy.len(), 2);
		assert_eq!(c.dev_server.proxy[0].0, "/api");
		assert_eq!(
			fail(r#"{ "devServer": { "proxy": { "api": "x" } } }"#).path,
			"devServer.proxy.api"
		);
		assert_eq!(
			fail(r#"{ "devServer": { "proxy": { "/api": 1 } } }"#).path,
			"devServer.proxy./api"
		);
	}

	#[test]
	fn banner_sourcemap_and_sitemap_variants() {
		let c = ok(
			r#"{ "styles": { "banner": "", "sourcemap": true }, "scripts": { "banner": false, "sourcemap": false, "minify": false } }"#,
		);
		assert_eq!(c.styles.banner, None);
		assert_eq!(c.styles.sourcemap, Sourcemap::On);
		assert_eq!(c.scripts.banner, None);
		assert_eq!(c.scripts.sourcemap, Sourcemap::Off);
		assert!(!c.scripts.minify);
		let c = ok(r#"{ "styles": { "banner": "/*! {{version}} */" } }"#);
		assert_eq!(c.styles.banner.as_deref(), Some("/*! {{version}} */"));

		let c = ok(
			r#"{ "sitemap": { "lastmod": "mtime", "exclude": ["/draft/**"], "priority": 0.8 } }"#,
		);
		let s = c.sitemap.unwrap();
		assert_eq!(s.output, "sitemap.xml");
		assert_eq!(s.include, ["**/*.html"]);
		assert_eq!(s.lastmod, Lastmod::Mtime);
		assert_eq!(s.priority.as_deref(), Some("0.8"));
		assert_eq!(ok(r#"{ "sitemap": false }"#).sitemap, None);
		assert_eq!(
			fail(r#"{ "sitemap": { "lastmod": "git" } }"#).path,
			"sitemap.lastmod"
		);
	}

	#[test]
	fn build_jobs_accepts_auto_or_a_count() {
		assert_eq!(
			ok(r#"{ "build": { "jobs": "auto" } }"#).build.jobs,
			Jobs::Auto
		);
		assert_eq!(
			ok(r#"{ "build": { "jobs": 4 } }"#).build.jobs,
			Jobs::Count(4)
		);
		assert_eq!(
			fail(r#"{ "build": { "jobs": "many" } }"#).path,
			"build.jobs"
		);
	}
}
