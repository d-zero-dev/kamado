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

/// The character encoding a page is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HtmlEncoding {
	#[default]
	Utf8,
	/// Windows Shift_JIS (CP932).
	ShiftJis,
}

/// How the markup is written after the page was read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum HtmlSerializer {
	/// As linkedom wrote it, which v2 did.
	#[default]
	Linkedom,
	/// As the HTML standard says (browsers, jsdom).
	Spec,
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
	pub encoding: HtmlEncoding,
	pub serializer: HtmlSerializer,
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
	/// Host names served besides `localhost`, IP literals and `host`;
	/// `.example.test` matches `example.test` and every subdomain of it. An IP
	/// address here admits the pages on that address as origins. Checked by
	/// the server.
	pub allowed_hosts: Vec<String>,
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

/// A text the screen of `kamado ui` shows: one text for every language, or a text per
/// language (the keys are the languages of the screen, `en`, `ja` and so on).
///
/// The text is kept as it is written. The language names are not checked (a name the screen
/// never asks for is never shown), and an empty text stays empty here: what counts as no text
/// is decided where a text is chosen, on the screen, because an empty one would leave a header
/// blank (RFC section 14.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Label {
	/// The same text in every language.
	Text(String),
	/// Language name → text, in the order written.
	Translations(Vec<(String, String)>),
}

/// How the screen of `kamado ui` presents one metadata key: its name and what it is for.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UiKey {
	/// The name of the column, shown in its header.
	pub label: Option<Label>,
	/// What the key is for, shown on hover and in the menu of the column.
	pub description: Option<Label>,
}

/// One operation of the sync button of `kamado ui` (and of `kamado sync <name>`): a script of
/// the project that exports `{ select?, read?, write? }`. With `write` it writes the site out to
/// the outside data (an export); without it, it brings the outside data into the site (an
/// import) (RFC section 14.2).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyncFunction {
	/// What `kamado sync <name>` and the screen call the operation by. Not empty, and not
	/// the name of another operation; any other character is allowed, because the command
	/// looks at the names before it takes its argument for a path.
	pub name: String,
	/// The name of the operation on the screen.
	pub label: Label,
	/// Absolute path of the script (relative to the directory of the config file when written).
	pub script: String,
}

/// The `ui` section: what `kamado ui` shows, shared with the team through the repository. The
/// build and the dev server do not read it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UiConfig {
	/// Metadata key → how the screen presents it, in the order written.
	pub keys: Vec<(String, UiKey)>,
	/// The operations of the sync button, in the order written.
	pub sync_functions: Vec<SyncFunction>,
	/// `ui.defaultKeyOrder`: the identifiers of the columns in the order the grid shows them
	/// until a person has set an order of their own. `None` when not written (and `[]` is
	/// written but names no column, which the screen treats as not written).
	pub default_key_order: Option<Vec<String>>,
	/// `ui.defaultFixedKeys`: the identifiers of the columns pinned to the left edge until a
	/// person has pinned or unpinned one. `None` when not written; `Some([])` pins none.
	pub default_fixed_keys: Option<Vec<String>>,
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
	pub ui: UiConfig,
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
		"ui",
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
		// A base URL that is neither a full URL nor a path (`example.com/sub`, a typo)
		// would be taken for the root and shift every link without a word.
		let base_url = o.opt_str("baseURL")?;
		if let Some(base) = &base_url
			&& !(base.starts_with('/')
				|| base.starts_with("http://")
				|| base.starts_with("https://"))
		{
			return Err(o.err(
				"baseURL",
				"expected a full URL (https://example.com/sub/) or a path (/sub/)",
			));
		}
		Site {
			host: o.opt_str("host")?.or(pkg.host),
			base_url: base_url.or(pkg.base_url),
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
		o.allow(&["port", "host", "allowedHosts", "open", "startPath", "proxy"])?;
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
		let allowed_hosts = match o.get("allowedHosts") {
			None => vec![],
			Some(Value::Array(items)) => {
				let mut hosts = Vec::new();
				for item in items {
					let Some(host) = item.as_str() else {
						return Err(o.err("allowedHosts", "expected an array of host names"));
					};
					// What would never match the host name of a request (a
					// scheme, a port, a path, a `*`, a character outside a host
					// name, a name that is not ASCII: the browser sends punycode)
					// is an error, so that the entry does not silently allow
					// nothing. A bracketed entry must be an IPv6 address.
					// The server drops the trailing dot of a fully qualified name.
					let name = host.strip_prefix('.').unwrap_or(host);
					let name = name.strip_suffix('.').unwrap_or(name);
					let valid = if let Some(v6) = host.strip_prefix('[') {
						v6.strip_suffix(']')
							.is_some_and(|v6| v6.parse::<std::net::Ipv6Addr>().is_ok())
					} else {
						!name.is_empty()
							&& name.split('.').all(|label| {
								!label.is_empty()
									&& label.bytes().all(|b| {
										b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
									})
							})
					};
					if !valid {
						let hint = if host.starts_with('*') {
							" (write \".example.test\" to match a domain and its subdomains)"
						} else {
							" (ASCII letters, digits, \".\", \"-\" and \"_\"; punycode for an internationalized name; an IPv6 address in brackets)"
						};
						return Err(o.err(
							"allowedHosts",
							format!(
								"expected a host name without a scheme, a port or a path{hint}, got {host:?}"
							),
						));
					}
					hosts.push(host.to_string());
				}
				hosts
			}
			Some(_) => return Err(o.err("allowedHosts", "expected an array of host names")),
		};
		DevServer {
			port: port as u16,
			host: o.str_or("host", "localhost")?,
			allowed_hosts,
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

	let ui = {
		let o = root.obj("ui")?;
		o.allow(&[
			"keys",
			"syncFunctions",
			"defaultKeyOrder",
			"defaultFixedKeys",
		])?;
		UiConfig {
			keys: parse_ui_keys(&o)?,
			sync_functions: parse_sync_functions(&o, &resolve)?,
			default_key_order: parse_column_list(&o, "defaultKeyOrder")?,
			default_fixed_keys: parse_column_list(&o, "defaultFixedKeys")?,
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
		ui,
	})
}

/// `ui.keys`: an object from metadata key to `{ label?, description? }`.
///
/// A key written twice is an error of the JSONC layer (`duplicate key`), so it is not checked
/// here. An empty name is refused because no metadata key has one: an entry for it could never
/// be shown. The names are not looked up among the keys of the pages: a key that no page has
/// gets no column (the columns are the keys the pages hold), so a team can name a key before
/// the first page has it.
fn parse_ui_keys(ui: &Obj<'_>) -> R<Vec<(String, UiKey)>> {
	let pairs = match ui.get("keys") {
		None => return Ok(Vec::new()),
		Some(Value::Object(pairs)) => pairs,
		Some(_) => return Err(ui.err("keys", "expected an object")),
	};
	let mut keys = Vec::with_capacity(pairs.len());
	for (name, value) in pairs {
		if name.is_empty() {
			return Err(ui.err("keys", "a key name must not be empty"));
		}
		let o = Obj::new(value, &format!("{}keys.{name}.", ui.prefix()))?;
		o.allow(&["label", "description"])?;
		keys.push((
			name.clone(),
			UiKey {
				label: parse_label(&o, "label")?,
				description: parse_label(&o, "description")?,
			},
		));
	}
	Ok(keys)
}

/// The columns every row of the grid of `kamado ui` has, by their identifiers (RFC section 14.2).
/// A key of the metadata is `meta:<key>`, so a key called `url` is another column. These are the
/// identifiers `ui.defaultKeyOrder` and `ui.defaultFixedKeys` take besides `meta:<key>`; public
/// so that the tests that hold the schema, and the list of the screen, to the same set can read it.
///
/// # Example
///
/// ```
/// assert!(kd_config::UI_BUILTIN_COLUMNS.contains(&"inputPath"));
/// assert!(!kd_config::UI_BUILTIN_COLUMNS.contains(&"title"));
/// ```
pub const UI_BUILTIN_COLUMNS: [&str; 6] = [
	"url",
	"virtual",
	"inputPath",
	"outputPath",
	"parent",
	"depth",
];

/// The longest identifier of a column, in UTF-16 code units (what `String.length` counts, as
/// the server of `kamado ui` does for the identifiers it takes).
const MAX_COLUMN_ID: usize = 256;

/// The most columns a list names, as many as the settings of the screen hold.
const MAX_COLUMN_IDS: usize = 500;

/// `ui.defaultKeyOrder` and `ui.defaultFixedKeys`: an array of column identifiers (`url`,
/// `virtual`, `inputPath`, `outputPath`, `parent`, `depth` or `meta:<key>`), the same as
/// `columns.order` and `columns.pinned` of the settings of the screen. The key that places a page
/// is `meta:order` like any other key of the metadata (RFC section 6).
///
/// A list names a column once, holds at most 500 of them, and each identifier is at most 256 UTF-16
/// code units. The names are not looked up among the keys of the pages: a key that no page has
/// gets no column, so a team can name a key before the first page has it.
fn parse_column_list(ui: &Obj<'_>, key: &str) -> R<Option<Vec<String>>> {
	let items = match ui.get(key) {
		None => return Ok(None),
		Some(Value::Array(items)) => items,
		Some(_) => return Err(ui.err(key, "expected an array of column identifiers")),
	};
	if items.len() > MAX_COLUMN_IDS {
		return Err(ui.err(
			key,
			format!("at most {MAX_COLUMN_IDS} columns, got {}", items.len()),
		));
	}
	let mut ids: Vec<String> = Vec::with_capacity(items.len());
	for (i, item) in items.iter().enumerate() {
		let at = format!("{key}[{i}]");
		let Value::String(id) = item else {
			return Err(ui.err(&at, "expected a string"));
		};
		let named = match id.strip_prefix("meta:") {
			Some(name) => !name.is_empty(),
			None => UI_BUILTIN_COLUMNS.contains(&id.as_str()),
		};
		if !named {
			return Err(ui.err(
				&at,
				format!(
					"expected a column: {} or meta:<key>, got {id:?}",
					UI_BUILTIN_COLUMNS.join(", ")
				),
			));
		}
		if id.encode_utf16().count() > MAX_COLUMN_ID {
			return Err(ui.err(
				&at,
				format!("a column identifier is at most {MAX_COLUMN_ID} characters"),
			));
		}
		if let Some(first) = ids.iter().position(|seen| seen == id) {
			return Err(ui.err(&at, format!("{id:?} is already in {key}[{first}]")));
		}
		ids.push(id.clone());
	}
	Ok(Some(ids))
}

/// `ui.syncFunctions`: a list of `{ name, label, script }`.
///
/// Every field is required. The label has no fallback here (the screen falls back to the
/// name when a label has no text for its language, see `Label`), but it must be written, so
/// that the person who adds an operation names it. Names are compared as written: the names
/// are looked up before a path, so no character is excluded.
fn parse_sync_functions(ui: &Obj<'_>, resolve: &dyn Fn(&str) -> String) -> R<Vec<SyncFunction>> {
	let items = match ui.get("syncFunctions") {
		None => return Ok(Vec::new()),
		Some(Value::Array(items)) => items,
		Some(_) => return Err(ui.err("syncFunctions", "expected an array")),
	};
	let mut functions: Vec<SyncFunction> = Vec::with_capacity(items.len());
	for (i, item) in items.iter().enumerate() {
		let o = Obj::new(item, &format!("{}syncFunctions[{i}].", ui.prefix()))?;
		o.allow(&["name", "label", "script"])?;
		let text = |key: &str| -> R<String> {
			match o.opt_str(key)? {
				None => Err(o.err(key, "required")),
				Some(s) if s.is_empty() => Err(o.err(key, "must not be empty")),
				Some(s) => Ok(s),
			}
		};
		let name = text("name")?;
		if let Some(first) = functions.iter().position(|f| f.name == name) {
			return Err(o.err(
				"name",
				format!("\"{name}\" is already the name of ui.syncFunctions[{first}]"),
			));
		}
		let label = parse_label(&o, "label")?.ok_or_else(|| o.err("label", "required"))?;
		let script = resolve(&text("script")?);
		functions.push(SyncFunction {
			name,
			label,
			script,
		});
	}
	Ok(functions)
}

/// A text, or an object from language to text; `null` and a missing key are no label, as for
/// the other optional texts. An empty text is kept as written: whether it counts as a text is
/// decided where a text is chosen (the screen), see `Label`.
fn parse_label(o: &Obj<'_>, key: &str) -> R<Option<Label>> {
	match o.get(key) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::String(s)) => Ok(Some(Label::Text(s.clone()))),
		Some(Value::Object(pairs)) => {
			let mut translations = Vec::with_capacity(pairs.len());
			for (language, text) in pairs {
				match text {
					Value::String(s) => translations.push((language.clone(), s.clone())),
					_ => return Err(o.err(&format!("{key}.{language}"), "expected a string")),
				}
			}
			Ok(Some(Label::Translations(translations)))
		}
		Some(_) => Err(o.err(key, "expected a string or an object of strings")),
	}
}

/// Parses the options of an `html.overrides` entry (what remains once its
/// `pages` is taken out) as an `html` object, with every option that the entry
/// leaves out at its default. The caller applies only the options the entry
/// names.
///
/// # Errors
///
/// The error of the first invalid option, with its dotted path.
///
/// # Example
///
/// ```
/// let options = kd_jsonc::parse(r#"{ "format": false }"#).unwrap();
/// let html = kd_config::parse_html_options(&options, "html.overrides[0].").unwrap();
/// assert!(html.format.is_none());
/// assert!(html.minify.is_some());
/// ```
pub fn parse_html_options(options: &Value, path_prefix: &str) -> R<Html> {
	parse_html(&Obj::new(options, path_prefix)?)
}

fn parse_html(o: &Obj<'_>) -> R<Html> {
	o.allow(&[
		"doctype",
		"format",
		"minify",
		"lineBreak",
		"encoding",
		"serializer",
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
			bracket_same_line: true,
		}),
		Some(Value::Object(_)) => {
			let f = o.obj("format")?;
			if f.get("printWidth").is_some() {
				return Err(f.err(
					"printWidth",
					"removed: HTML is formatted without a print width, so lines never wrap; delete it",
				));
			}
			f.allow(&["useTabs", "tabWidth", "bracketSameLine"])?;
			Some(Format {
				use_tabs: f.bool_or("useTabs", true)?,
				tab_width: f.uint_or("tabWidth", 2)?,
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
	let encoding = match o.str_or("encoding", "utf8")?.to_ascii_lowercase().as_str() {
		"utf8" | "utf-8" => HtmlEncoding::Utf8,
		"shift_jis" | "shift-jis" | "sjis" | "cp932" | "windows-31j" => HtmlEncoding::ShiftJis,
		other => {
			return Err(o.err(
				"encoding",
				format!("expected \"utf8\" or \"shift_jis\" (\"cp932\"), got {other:?}"),
			));
		}
	};
	let serializer = match o.str_or("serializer", "linkedom")?.as_str() {
		"linkedom" => HtmlSerializer::Linkedom,
		"spec" => HtmlSerializer::Spec,
		other => {
			return Err(o.err(
				"serializer",
				format!("expected \"linkedom\" or \"spec\", got {other:?}"),
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
		encoding,
		serializer,
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
	fn a_base_url_is_a_full_url_or_a_path() {
		for ok in ["https://example.com/sub/", "http://example.test/", "/sub/"] {
			let text =
				format!(r#"{{ "dir": {{ "output": "out" }}, "site": {{ "baseURL": "{ok}" }} }}"#);
			assert_eq!(
				parse(&text, "/p", None).unwrap().site.base_url.as_deref(),
				Some(ok)
			);
		}
		let e = fail(r#"{ "site": { "baseURL": "example.com/sub" } }"#);
		assert_eq!(e.path, "site.baseURL");
		assert!(
			e.message.starts_with("expected a full URL"),
			"{}",
			e.message
		);
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
	fn the_removed_print_width_is_an_error_that_says_so() {
		for text in [
			r#"{ "html": { "format": { "printWidth": 90 } } }"#,
			r#"{ "html": { "overrides": [{ "pages": ["/a/"], "format": { "printWidth": 100000 } }] } }"#,
		] {
			let e = fail(text);
			assert!(e.path.ends_with("format.printWidth"), "{}", e.path);
			assert!(
				e.message
					.starts_with("removed: HTML is formatted without a print width"),
				"{}",
				e.message
			);
		}
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
	fn a_glob_whose_braces_expand_past_the_limit_is_rejected_with_its_key() {
		let e = fail(&format!(
			r#"{{ "pages": {{ "files": [{:?}] }} }}"#,
			"{a,b}".repeat(10)
		));
		assert_eq!(e.path, "pages.files");
		assert!(
			e.message
				.ends_with("the braces expand to more than 1000 patterns"),
			"{}",
			e.message
		);
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
			r#"{ "html": { "format": { "tabWidth": 4, "useTabs": false }, "minify": false, "imageSizes": false, "entities": "all" } }"#,
		);
		assert_eq!(
			c.html.format,
			Some(Format {
				use_tabs: false,
				tab_width: 4,
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
	fn allowed_hosts_are_host_names() {
		let c = ok("{}");
		assert!(c.dev_server.allowed_hosts.is_empty());
		let c = ok(
			r#"{ "devServer": { "allowedHosts": ["laptop.local", ".example.test", "[::1]", "dev_box.local", "laptop.local."] } }"#,
		);
		assert_eq!(
			c.dev_server.allowed_hosts,
			[
				"laptop.local",
				".example.test",
				"[::1]",
				"dev_box.local",
				"laptop.local."
			]
		);
		assert_eq!(
			fail(r#"{ "devServer": { "allowedHosts": "laptop.local" } }"#).to_string(),
			"devServer.allowedHosts: expected an array of host names"
		);
		assert_eq!(
			fail(r#"{ "devServer": { "allowedHosts": [1] } }"#).to_string(),
			"devServer.allowedHosts: expected an array of host names"
		);
		assert!(
			fail(r#"{ "devServer": { "allowedHosts": ["*.example.test"] } }"#)
				.message
				.contains("write \".example.test\""),
		);
		for bad in [
			"",
			".",
			"..",
			"*.example.test",
			"http://laptop.local",
			"laptop.local:3000",
			"laptop.local/",
			"a#b",
			"a?b",
			"user@host",
			"[::1]:3000",
			"[not-an-ip]",
			" laptop.local",
			"ラップトップ.local",
		] {
			let e = fail(&format!(
				r#"{{ "devServer": {{ "allowedHosts": [{bad:?}] }} }}"#
			));
			assert_eq!(e.path, "devServer.allowedHosts", "{bad:?}");
			assert!(
				e.message.starts_with("expected a host name without"),
				"{bad:?}: {}",
				e.message
			);
		}
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

	#[test]
	fn ui_keys_default_to_none() {
		assert!(ok("{}").ui.keys.is_empty());
		assert!(ok(r#"{ "ui": {} }"#).ui.keys.is_empty());
		assert!(ok(r#"{ "ui": { "keys": {} } }"#).ui.keys.is_empty());
	}

	#[test]
	fn ui_keys_read_a_label_and_a_description_as_text_or_translations() {
		let cfg = ok(r#"{ "ui": { "keys": {
			"title": {
				"label": { "ja": "タイトル", "en": "Title" },
				"description": "Used for <title> and the breadcrumbs"
			},
			"navHidden": { "label": "Hidden" },
			"layout": {}
		} } }"#);
		assert_eq!(
			cfg.ui.keys,
			vec![
				(
					"title".to_string(),
					UiKey {
						label: Some(Label::Translations(vec![
							("ja".to_string(), "タイトル".to_string()),
							("en".to_string(), "Title".to_string()),
						])),
						description: Some(Label::Text(
							"Used for <title> and the breadcrumbs".to_string()
						)),
					}
				),
				(
					"navHidden".to_string(),
					UiKey {
						label: Some(Label::Text("Hidden".to_string())),
						description: None,
					}
				),
				("layout".to_string(), UiKey::default()),
			]
		);
	}

	#[test]
	fn a_null_label_or_description_is_not_written() {
		let cfg =
			ok(r#"{ "ui": { "keys": { "title": { "label": null, "description": null } } } }"#);
		assert_eq!(cfg.ui.keys, vec![("title".to_string(), UiKey::default())]);
	}

	#[test]
	fn ui_and_keys_are_objects_and_null_is_not_one() {
		assert_eq!(fail(r#"{ "ui": null }"#).path, "ui");
		let e = fail(r#"{ "ui": { "keys": null } }"#);
		assert_eq!(e.path, "ui.keys");
		assert_eq!(e.message, "expected an object");
	}

	#[test]
	fn an_empty_or_open_label_is_kept_as_it_is_written() {
		let key = |text: &str| ok(text).ui.keys.into_iter().next().unwrap().1.label;
		assert_eq!(
			key(r#"{ "ui": { "keys": { "title": { "label": "" } } } }"#),
			Some(Label::Text(String::new()))
		);
		assert_eq!(
			key(r#"{ "ui": { "keys": { "title": { "label": {} } } } }"#),
			Some(Label::Translations(Vec::new()))
		);
		// the language names are not checked: the screen asks for the ones it knows
		assert_eq!(
			key(r#"{ "ui": { "keys": { "title": { "label": { "fr": "Titre", "": "x" } } } } }"#),
			Some(Label::Translations(vec![
				("fr".to_string(), "Titre".to_string()),
				(String::new(), "x".to_string()),
			]))
		);
	}

	#[test]
	fn a_key_named_twice_in_ui_keys_is_an_error_of_the_document() {
		let e = fail(r#"{ "ui": { "keys": { "title": {}, "title": {} } } }"#);
		assert!(
			e.message.contains(r#"duplicate key "title""#),
			"{}",
			e.message
		);
	}

	#[test]
	fn sync_functions_default_to_none() {
		assert!(ok("{}").ui.sync_functions.is_empty());
		assert!(ok(r#"{ "ui": {} }"#).ui.sync_functions.is_empty());
		assert!(
			ok(r#"{ "ui": { "syncFunctions": [] } }"#)
				.ui
				.sync_functions
				.is_empty()
		);
	}

	#[test]
	fn sync_functions_read_a_name_a_label_and_the_path_of_a_script() {
		let cfg = ok(r#"{ "ui": { "syncFunctions": [
			{ "name": "import-sheet", "label": { "ja": "取り込む", "en": "Import" }, "script": "./scripts/import.mjs" },
			{ "name": "export", "label": "Export", "script": "/abs/export.mjs" }
		] } }"#);
		assert_eq!(
			cfg.ui.sync_functions,
			vec![
				SyncFunction {
					name: "import-sheet".to_string(),
					label: Label::Translations(vec![
						("ja".to_string(), "取り込む".to_string()),
						("en".to_string(), "Import".to_string()),
					]),
					// relative to the directory of the config file, as every path of the config
					script: "/site/scripts/import.mjs".to_string(),
				},
				SyncFunction {
					name: "export".to_string(),
					label: Label::Text("Export".to_string()),
					script: "/abs/export.mjs".to_string(),
				},
			]
		);
	}

	#[test]
	fn a_name_may_hold_any_character_but_must_not_be_empty_or_repeated() {
		// `kamado sync <name|path>` looks at the names first, so a name is not limited to a
		// shape a path cannot have
		let cfg = ok(r#"{ "ui": { "syncFunctions": [
			{ "name": "./a b/ü.mjs", "label": "x", "script": "a.mjs" }
		] } }"#);
		assert_eq!(cfg.ui.sync_functions[0].name, "./a b/ü.mjs");
		let e = fail(
			r#"{ "ui": { "syncFunctions": [{ "name": "", "label": "x", "script": "a.mjs" }] } }"#,
		);
		assert_eq!(e.path, "ui.syncFunctions[0].name");
		assert_eq!(e.message, "must not be empty");
		let e = fail(
			r#"{ "ui": { "syncFunctions": [
				{ "name": "a", "label": "x", "script": "a.mjs" },
				{ "name": "a", "label": "y", "script": "b.mjs" }
			] } }"#,
		);
		assert_eq!(e.path, "ui.syncFunctions[1].name");
		assert_eq!(
			e.message,
			"\"a\" is already the name of ui.syncFunctions[0]"
		);
	}

	#[test]
	fn a_sync_function_needs_a_name_a_label_and_a_script() {
		for (text, path, message) in [
			(r#"{ "label": "x", "script": "a.mjs" }"#, "name", "required"),
			(r#"{ "name": "a", "script": "a.mjs" }"#, "label", "required"),
			(
				r#"{ "name": "a", "label": null, "script": "a.mjs" }"#,
				"label",
				"required",
			),
			(r#"{ "name": "a", "label": "x" }"#, "script", "required"),
			(
				r#"{ "name": "a", "label": "x", "script": "" }"#,
				"script",
				"must not be empty",
			),
			(
				r#"{ "name": "a", "label": "x", "script": 1 }"#,
				"script",
				"expected a string",
			),
			(
				r#"{ "name": 1, "label": "x", "script": "a.mjs" }"#,
				"name",
				"expected a string",
			),
			(
				r#"{ "name": "a", "label": 1, "script": "a.mjs" }"#,
				"label",
				"expected a string or an object of strings",
			),
		] {
			let e = fail(&format!(r#"{{ "ui": {{ "syncFunctions": [{text}] }} }}"#));
			assert_eq!(e.path, format!("ui.syncFunctions[0].{path}"), "{text}");
			assert_eq!(e.message, message, "{text}");
		}
	}

	#[test]
	fn sync_functions_are_a_list_of_objects_and_null_is_not_one() {
		let e = fail(r#"{ "ui": { "syncFunctions": null } }"#);
		assert_eq!(e.path, "ui.syncFunctions");
		assert_eq!(e.message, "expected an array");
		assert_eq!(
			fail(r#"{ "ui": { "syncFunctions": {} } }"#).path,
			"ui.syncFunctions"
		);
		let e = fail(r#"{ "ui": { "syncFunctions": ["a.mjs"] } }"#);
		assert_eq!(e.path, "ui.syncFunctions[0]");
		assert_eq!(e.message, "expected an object");
		let e = fail(
			r#"{ "ui": { "syncFunctions": [{ "name": "a", "label": "x", "script": "a.mjs", "fn": 1 }] } }"#,
		);
		assert_eq!(e.path, "ui.syncFunctions[0].fn");
		assert!(
			e.message
				.starts_with("unknown option (allowed: name, label, script")
		);
	}

	#[test]
	fn ui_keys_errors_carry_their_path() {
		let e = fail(r#"{ "ui": { "sync": [] } }"#);
		assert_eq!(e.path, "ui.sync");
		assert!(e.message.starts_with("unknown option (allowed: keys"));
		assert_eq!(fail(r#"{ "ui": { "keys": [] } }"#).path, "ui.keys");
		assert_eq!(
			fail(r#"{ "ui": { "keys": { "title": "T" } } }"#).path,
			"ui.keys.title"
		);
		let e = fail(r#"{ "ui": { "keys": { "title": { "color": "T" } } } }"#);
		assert_eq!(e.path, "ui.keys.title.color");
		assert!(
			e.message
				.starts_with("unknown option (allowed: label, description")
		);
		let e = fail(r#"{ "ui": { "keys": { "title": { "label": 1 } } } }"#);
		assert_eq!(e.path, "ui.keys.title.label");
		assert_eq!(e.message, "expected a string or an object of strings");
		let e = fail(r#"{ "ui": { "keys": { "title": { "label": { "ja": 1 } } } } }"#);
		assert_eq!(e.path, "ui.keys.title.label.ja");
		assert_eq!(e.message, "expected a string");
		assert_eq!(
			fail(r#"{ "ui": { "keys": { "": { "label": "x" } } } }"#).path,
			"ui.keys"
		);
	}

	#[test]
	fn ui_default_columns_default_to_none() {
		let c = ok("{}");
		assert_eq!(c.ui.default_key_order, None);
		assert_eq!(c.ui.default_fixed_keys, None);
		let c = ok(r#"{ "ui": {} }"#);
		assert_eq!(c.ui.default_key_order, None);
		assert_eq!(c.ui.default_fixed_keys, None);
	}

	#[test]
	fn ui_default_columns_read_the_identifiers_in_the_order_written() {
		let c = ok(r#"{ "ui": {
			"defaultKeyOrder": ["url", "meta:title", "meta:layout", "inputPath", "meta:url"],
			"defaultFixedKeys": ["meta:title", "url"]
		} }"#);
		assert_eq!(
			c.ui.default_key_order.as_deref(),
			Some(
				&[
					"url".to_string(),
					"meta:title".to_string(),
					"meta:layout".to_string(),
					"inputPath".to_string(),
					"meta:url".to_string(),
				][..]
			)
		);
		assert_eq!(
			c.ui.default_fixed_keys.as_deref(),
			Some(&["meta:title".to_string(), "url".to_string()][..])
		);
	}

	#[test]
	fn ui_default_columns_take_every_fixed_column_and_an_empty_list() {
		let c = ok(r#"{ "ui": {
			"defaultKeyOrder": ["url", "virtual", "inputPath", "outputPath", "parent", "depth", "meta:order"],
			"defaultFixedKeys": []
		} }"#);
		assert_eq!(c.ui.default_key_order.map(|l| l.len()), Some(7));
		// `[]` is "pin none", not "not written".
		assert_eq!(c.ui.default_fixed_keys, Some(Vec::new()));
		assert_eq!(
			ok(r#"{ "ui": { "defaultKeyOrder": [] } }"#)
				.ui
				.default_key_order,
			Some(Vec::new())
		);
	}

	#[test]
	fn ui_default_columns_refuse_what_is_not_a_list_of_columns() {
		for key in ["defaultKeyOrder", "defaultFixedKeys"] {
			let e = fail(&format!(r#"{{ "ui": {{ "{key}": "url" }} }}"#));
			assert_eq!(e.path, format!("ui.{key}"));
			assert_eq!(e.message, "expected an array of column identifiers");
			assert_eq!(
				fail(&format!(r#"{{ "ui": {{ "{key}": null }} }}"#)).path,
				format!("ui.{key}")
			);
			let e = fail(&format!(r#"{{ "ui": {{ "{key}": ["url", 1] }} }}"#));
			assert_eq!(e.path, format!("ui.{key}[1]"));
			assert_eq!(e.message, "expected a string");
			// `order` is the key that places a page, and a column of the metadata like the others:
			// `meta:order`.
			for bad in ["title", "meta:", "URL", "", "metaTitle", "meta", "order"] {
				let e = fail(&format!(r#"{{ "ui": {{ "{key}": [{bad:?}] }} }}"#));
				assert_eq!(e.path, format!("ui.{key}[0]"), "{bad:?}");
				assert!(
					e.message.starts_with("expected a column: url, virtual"),
					"{bad:?}: {}",
					e.message
				);
			}
			let e = fail(&format!(
				r#"{{ "ui": {{ "{key}": ["url", "meta:a", "url"] }} }}"#
			));
			assert_eq!(e.path, format!("ui.{key}[2]"));
			assert_eq!(e.message, format!("\"url\" is already in {key}[0]"));
		}
	}

	#[test]
	fn ui_default_columns_limit_the_identifier_and_the_count() {
		// 256 UTF-16 code units, `meta:` included, is the longest the server of `kamado ui` takes.
		let longest = format!("meta:{}", "a".repeat(256 - "meta:".len()));
		assert!(
			ok(&format!(
				r#"{{ "ui": {{ "defaultKeyOrder": ["{longest}"] }} }}"#
			))
			.ui
			.default_key_order
			.is_some()
		);
		let e = fail(&format!(
			r#"{{ "ui": {{ "defaultKeyOrder": ["{longest}a"] }} }}"#
		));
		assert_eq!(e.path, "ui.defaultKeyOrder[0]");
		assert_eq!(e.message, "a column identifier is at most 256 characters");
		// A character outside the BMP is two code units, as it is for `String.length`.
		let astral = format!("meta:{}", "\u{1F600}".repeat((256 - "meta:".len()) / 2 + 1));
		let e = fail(&format!(
			r#"{{ "ui": {{ "defaultFixedKeys": ["{astral}"] }} }}"#
		));
		assert_eq!(e.path, "ui.defaultFixedKeys[0]");
		let fits = format!("meta:{}", "\u{1F600}".repeat((256 - "meta:".len()) / 2));
		assert!(
			ok(&format!(
				r#"{{ "ui": {{ "defaultFixedKeys": ["{fits}"] }} }}"#
			))
			.ui
			.default_fixed_keys
			.is_some()
		);

		let many = |n: usize| {
			(0..n)
				.map(|i| format!("\"meta:k{i}\""))
				.collect::<Vec<_>>()
				.join(",")
		};
		assert_eq!(
			ok(&format!(
				r#"{{ "ui": {{ "defaultKeyOrder": [{}] }} }}"#,
				many(500)
			))
			.ui
			.default_key_order
			.map(|l| l.len()),
			Some(500)
		);
		let e = fail(&format!(
			r#"{{ "ui": {{ "defaultKeyOrder": [{}] }} }}"#,
			many(501)
		));
		assert_eq!(e.path, "ui.defaultKeyOrder");
		assert_eq!(e.message, "at most 500 columns, got 501");
	}
}
