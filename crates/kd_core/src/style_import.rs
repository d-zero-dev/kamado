//! `@import` bundling for stylesheets, with the semantics of postcss-import
//! as v2 used it.
//!
//! Only imports in the preamble of a file (before the first rule, after
//! `@charset` and empty `@layer` statements) are inlined. The bundle is a flat
//! list of statements, like postcss-import's: first the one `@charset`, then
//! the *header* (every `@layer` statement and every remote `@import` of every
//! file, in document order, the remote ones with the conditions of the imports
//! they were reached through), then the *body* (the rest of every file, in the
//! place its import had, each run inside the `@media` / `@supports` / `@layer`
//! its import names). Remote imports (`http:`, `https:`, `//`, `data:`) stay
//! imports: a browser ignores an `@import` after a rule, so one inside an
//! inlined file would stop working, and wrapping it in a block would be
//! invalid.
//!
//! The sections cited are those of CSS Cascading and Inheritance Level 5
//! (<https://www.w3.org/TR/css-cascade-5/>).
//!
//! Where it differs from postcss-import, on purpose:
//!
//! - A remote import reached through two or more conditional imports is
//!   written as an import of a `data:` stylesheet that holds the import of
//!   another condition, the way postcss-import writes it. When two of the
//!   conditions have a `layer()`, the outer condition is on the outer import:
//!   postcss-import nests them the other way round, which puts the sheet into
//!   the layer `b.a` for `layer(a)` inside `layer(b)`, where the specification
//!   (§ 6.4.2) has `a.b`, and declares `b` before `a` (§ 6.4.3). With at most
//!   one `layer()` the order changes nothing a browser does, and the order of
//!   postcss-import is kept.
//! - The layers an import declares are declared in the order they appear in
//!   the source. postcss-import moves the `@layer` statements and the remote
//!   imports in front of the body, which would declare a layer of the body
//!   only after them; where that changes the order, `@layer name;` is written
//!   at the place of the import.
//!
//! An `@import` after an `@layer` statement that follows another `@import` is
//! invalid in CSS (§ 2: imports must be consecutive), and postcss-import drops
//! it; so does this, with a warning. So are an `@import` after a rule, an
//! `@import` that names no file, and a `@charset` that is not first.
//!
//! Resolution order: an alias (`@/x.css` with `alias: { "@": "./styles" }`),
//! then relative to the importing file, then `node_modules` up the tree
//! (`style` field of the package, else a `.css` `main`, else `index.css`).
//! Every candidate that was probed and missing is recorded as a dependency:
//! creating a nearer file later must rebuild the stylesheet.
//!
//! A file imported twice under the same conditions is inlined once (the
//! first one wins), and a file that imports itself, directly or not, is
//! skipped on the way back in.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;

use kd_build::Dep;

/// A run of the bundled text that was copied from a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Segment {
	/// Byte offset in the bundled text.
	pub out: usize,
	pub len: usize,
	/// Index into [`Bundle::files`].
	pub file: usize,
	/// Byte offset in that file's text.
	pub src: usize,
}

/// A file that went into the bundle.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundledFile {
	pub path: String,
	pub text: String,
}

/// The bundled stylesheet and the files it was read from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Bundle {
	pub css: String,
	/// Fingerprints of every file read, and of every candidate that was probed
	/// and does not exist.
	pub deps: BTreeMap<String, Dep>,
	/// The files that went into `css`, the entry first.
	pub files: Vec<BundledFile>,
	/// Which run of `css` came from where, in order; text the bundler added
	/// (the at-rules that wrap a conditional import) is in no segment.
	pub segments: Vec<Segment>,
	/// Byte offset in `css` where a banner goes: after the leading `@charset`
	/// and the header.
	pub banner_at: usize,
	/// The statements that were left out (an `@import` that cannot stand where
	/// it is, a `@charset` that is not first), each as a message that names
	/// the file and the statement, for the build report.
	pub warnings: Vec<String>,
}

/// An `@import` statement in the preamble of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Import {
	/// Byte range of the whole statement, `@import ...;`.
	start: usize,
	end: usize,
	uri: String,
	/// The `url(...)` or string as it was written.
	full_uri: String,
	layer: Option<String>,
	supports: Option<String>,
	media: Option<String>,
}

/// What an import says about when its sheet applies: the `layer()` it goes
/// into, a `supports()` condition and a media query list. Empty `layer` is the
/// anonymous layer.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Condition {
	layer: Option<String>,
	supports: Option<String>,
	media: Option<String>,
}

/// The conditions in force, outermost import first.
type Chain = Vec<Condition>;

impl Condition {
	fn of(import: &Import) -> Option<Condition> {
		(import.layer.is_some() || import.supports.is_some() || import.media.is_some()).then(|| {
			Condition {
				layer: import.layer.clone(),
				supports: import.supports.clone(),
				media: import.media.clone(),
			}
		})
	}

	/// What follows the URL in an `@import`: `layer(a) supports(b) screen`.
	fn prelude(&self) -> String {
		let mut parts = Vec::new();
		match self.layer.as_deref() {
			Some("") => parts.push("layer".to_owned()),
			Some(layer) => parts.push(format!("layer({layer})")),
			None => {}
		}
		if let Some(supports) = &self.supports {
			parts.push(format!("supports({supports})"));
		}
		if let Some(media) = &self.media {
			parts.push(media.clone());
		}
		parts.join(" ")
	}
}

/// A layer a statement declares: the media and supports conditions it is under
/// and the names of the layer and of its parents.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Decl {
	wrappers: String,
	path: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
	/// A remote `@import`.
	Import,
	/// An `@layer` statement of a file.
	Layer,
	/// `@layer name;` written for the layer of a local import, so that the
	/// layer is declared where the source declares it.
	Declare,
}

/// A statement that goes in front of the body.
#[derive(Debug, Clone)]
struct Header {
	kind: Kind,
	/// The statement as written (for `Declare`, as it will be written).
	text: String,
	/// `Import`: the `url(...)` or string as written.
	uri: String,
	/// Where `text` was written (not meaningful for `Declare`).
	file: usize,
	src: usize,
	chain: Chain,
	declares: Vec<Decl>,
	/// `Declare`: the file the import names has nothing for the body to declare
	/// the layer with, so the statement is the only place that does.
	pinned: bool,
}

/// A run of text of a file that goes in the body, with the conditions it is
/// under.
#[derive(Debug, Clone)]
struct Chunk {
	file: usize,
	from: usize,
	to: usize,
	chain: Chain,
	/// The end of an imported file: its trailing white space is dropped.
	last_of_file: bool,
}

/// The header and the body of one file, with its imports inlined.
#[derive(Default)]
struct Flat {
	header: Vec<Header>,
	body: Vec<Chunk>,
}

/// A statement that was written in a file.
struct Statement {
	text: String,
	file: usize,
	src: usize,
}

/// Where the aliases point and how to read files.
struct Context<'a> {
	/// `(prefix, absolute directory or package name)`; a prefix matches when
	/// the import starts with `prefix/`.
	alias: &'a [(String, String)],
	deps: BTreeMap<String, Dep>,
	files: Vec<BundledFile>,
	/// Files being inlined right now (cycle guard).
	stack: Vec<String>,
	/// `(file, conditions)` pairs that were inlined already.
	done: BTreeSet<(String, String)>,
	/// The `@charset` statements of the files, in the order met.
	charsets: Vec<Statement>,
	warnings: Vec<String>,
	/// The number of anonymous layers met (each is a layer of its own).
	anonymous: usize,
}

/// The text being written, and where its runs came from.
#[derive(Default)]
struct Out {
	text: String,
	segments: Vec<Segment>,
}

impl Out {
	fn add(&mut self, text: &str) {
		self.text.push_str(text);
	}

	/// Writes `text`, which is at `src` in the file `file`.
	fn copy(&mut self, file: usize, src: usize, text: &str) {
		if text.is_empty() {
			return;
		}
		self.segments.push(Segment {
			out: self.text.len(),
			len: text.len(),
			file,
			src,
		});
		self.text.push_str(text);
	}
}

/// Inlines the imports of `entry`.
///
/// # Errors
///
/// A message naming the file when a file cannot be read or an import cannot
/// be resolved. A statement that has to be left out (see the documentation of
/// the module) is no error: the bundle is returned, and the statement is in
/// [`Bundle::warnings`].
///
/// # Example
///
/// ```no_run
/// let bundle = kd_core::style_import::bundle("/site/src/css/main.css", &[]).unwrap();
/// println!("{} bytes from {} files", bundle.css.len(), bundle.deps.len());
/// for warning in &bundle.warnings {
///     eprintln!("{warning}");
/// }
/// ```
pub fn bundle(entry: &str, alias: &[(String, String)]) -> Result<Bundle, String> {
	let mut ctx = Context {
		alias,
		deps: BTreeMap::new(),
		files: Vec::new(),
		stack: Vec::new(),
		done: BTreeSet::new(),
		charsets: Vec::new(),
		warnings: Vec::new(),
		anonymous: 0,
	};
	let flat = parse_file(&mut ctx, entry, &Vec::new(), true)?;
	let mut out = Out::default();
	if let Some(charset) = pick_charset(&ctx.charsets)? {
		// The entry's own is a run of the entry; one taken from an imported file
		// is put on top by the bundler and maps to nothing.
		if charset.file == 0 {
			out.copy(charset.file, charset.src, &charset.text);
		} else {
			out.add(&charset.text);
		}
		out.add("\n");
	}
	write_header(&mut out, flat.header);
	let banner_at = out.text.len();
	write_body(&mut out, &ctx.files, &flat.body);
	Ok(Bundle {
		css: out.text,
		deps: ctx.deps,
		files: ctx.files,
		segments: out.segments,
		banner_at,
		warnings: ctx.warnings,
	})
}

/// Reads a file, records its fingerprint and keeps its text; the index of the
/// file in `ctx.files` and the text.
fn read(ctx: &mut Context<'_>, path: &str) -> Result<(usize, String), String> {
	let (bytes, dep) =
		kd_build::read_with_fingerprint(path).map_err(|e| format!("cannot read {path}: {e}"))?;
	ctx.deps.insert(path.to_owned(), dep);
	let text = String::from_utf8(bytes).map_err(|_| format!("{path}: file is not valid UTF-8"))?;
	// A byte order mark is not part of the stylesheet; inlined, it would end up
	// in front of the first selector of the file and stop it from matching.
	let text = match text.strip_prefix('\u{feff}') {
		Some(rest) => rest.to_owned(),
		None => text,
	};
	ctx.files.push(BundledFile {
		path: path.to_owned(),
		text: text.clone(),
	});
	Ok((ctx.files.len() - 1, text))
}

/// The one `@charset` of the bundle: the entry's, else the first of the
/// imported files. Like postcss-import, differing ones are an error.
fn pick_charset(charsets: &[Statement]) -> Result<Option<&Statement>, String> {
	let Some(first) = charsets.first() else {
		return Ok(None);
	};
	let value = |s: &str| {
		s.to_ascii_lowercase()
			.split_whitespace()
			.collect::<String>()
	};
	let expected = value(&first.text);
	if charsets.iter().any(|other| value(&other.text) != expected) {
		return Err("Incompatible @charset statements in the imported stylesheets".to_owned());
	}
	Ok(Some(first))
}

fn parse_file(
	ctx: &mut Context<'_>,
	path: &str,
	chain: &Chain,
	is_entry: bool,
) -> Result<Flat, String> {
	let (index, text) = read(ctx, path)?;
	ctx.stack.push(path.to_owned());
	let result = parse_text(ctx, path, index, &text, chain, is_entry);
	ctx.stack.pop();
	result
}

/// Cuts a file at its preamble statements: the `@layer` statements and the
/// remote imports go to the header, a local import is replaced by the header
/// and the body of the file it names, and what is left is the body.
fn parse_text(
	ctx: &mut Context<'_>,
	path: &str,
	index: usize,
	text: &str,
	chain: &Chain,
	is_entry: bool,
) -> Result<Flat, String> {
	let mut flat = Flat::default();
	let mut last = 0;
	if let Some((from, to)) = charset_range(text) {
		ctx.charsets.push(Statement {
			text: text[from..to].trim().to_owned(),
			file: index,
			src: from,
		});
		last = to;
	}
	let (imports, layers) = scan_preamble(text);
	let first_import = imports.first().map(|i| i.start);
	let known: Vec<usize> = imports.iter().map(|i| i.start).collect();
	let leading_charset = charset_range(text).map(|(from, _)| from);
	let mut events: Vec<(usize, usize, Event<'_>)> = imports
		.iter()
		.map(|i| (i.start, i.end, Event::Import(i)))
		// A statement under an anonymous layer stays where it is, in the block of
		// the file: moved to the header, it would be in a layer of its own, and
		// the names it declares would be in another layer than the rules of the
		// file.
		.chain(
			layers
				.iter()
				.filter(|_| !chain.iter().any(|c| c.layer.as_deref() == Some("")))
				.map(|&(s, e)| (s, e, Event::Layer)),
		)
		.chain(
			misplaced_statements(text, &known, leading_charset)
				.into_iter()
				.map(|(s, e, name)| (s, e, Event::Dropped(name))),
		)
		.collect();
	events.sort_by_key(|e| e.0);
	let push_run = |flat: &mut Flat, from: usize, to: usize, tail: bool| {
		if to > from {
			flat.body.push(Chunk {
				file: index,
				from,
				to,
				chain: chain.clone(),
				last_of_file: tail && !is_entry,
			});
		}
	};
	for (start, end, event) in events {
		push_run(&mut flat, last, start, false);
		// The line break after a statement that moves to the header goes with
		// it.
		let after = &text[end..];
		let line_breaks = after.len() - after.trim_start_matches(['\n', '\r']).len();
		let import = match event {
			Event::Import(import) => import,
			Event::Dropped(name) => {
				let statement = text[start..end].trim();
				warn(ctx, dropped_warning(path, name, statement));
				last = end + line_breaks;
				continue;
			}
			Event::Layer => {
				let text = text[start..end].to_owned();
				let declares = layer_statement_declares(ctx, chain, &text);
				flat.header.push(Header {
					kind: Kind::Layer,
					text,
					uri: String::new(),
					file: index,
					src: start,
					chain: chain.clone(),
					declares,
					pinned: false,
				});
				last = end + line_breaks;
				continue;
			}
		};
		let statement = &text[import.start..import.end];
		if first_import.is_some_and(|f| layers.iter().any(|&(s, _)| s > f && s < import.start)) {
			warn(ctx, dropped_warning(path, "import", statement.trim()));
			last = end + line_breaks;
			continue;
		}
		let mut inner = chain.clone();
		inner.extend(Condition::of(import));
		if is_remote(&import.uri) {
			let lead = statement.len() - statement.trim_start().len();
			let declares = remote_import_declares(ctx, &inner);
			flat.header.push(Header {
				kind: Kind::Import,
				text: statement.trim().to_owned(),
				uri: import.full_uri.clone(),
				file: index,
				src: import.start + lead,
				chain: inner,
				declares,
				pinned: false,
			});
			last = end + line_breaks;
			continue;
		}
		last = end;
		let target = resolve(ctx, path, &import.uri)?;
		if ctx.stack.contains(&target) {
			continue;
		}
		let key = (
			target.clone(),
			inner
				.iter()
				.map(Condition::prelude)
				.collect::<Vec<_>>()
				.join(":"),
		);
		if !ctx.done.insert(key) {
			continue;
		}
		let declare = import
			.layer
			.as_deref()
			.is_some_and(|l| !l.is_empty())
			.then(|| declare_layer(&inner))
			.flatten();
		let declared_at = declare.is_some().then_some(flat.header.len());
		flat.header.extend(declare);
		let child = parse_file(ctx, &target, &inner, false)?;
		if let Some(at) = declared_at {
			flat.header[at].pinned = child
				.body
				.iter()
				.all(|c| ctx.files[c.file].text[c.from..c.to].trim().is_empty());
		}
		flat.header.extend(child.header);
		flat.body.extend(child.body);
	}
	push_run(&mut flat, last, text.len(), true);
	// A file that ends with a statement that moved or was left out ends with
	// the run before it.
	if !is_entry
		&& last >= text.len()
		&& let Some(run) = flat.body.last_mut()
		&& run.file == index
	{
		run.last_of_file = true;
	}
	Ok(flat)
}

/// What the bundler found in the preamble of a file.
enum Event<'a> {
	/// A local or remote `@import`.
	Import(&'a Import),
	/// An `@layer` statement.
	Layer,
	/// A statement that is left out; `import` or `charset`.
	Dropped(&'static str),
}

/// Reports a warning once: a file imported under several conditions is read
/// for each of them.
fn warn(ctx: &mut Context<'_>, message: String) {
	if !ctx.warnings.contains(&message) {
		ctx.warnings.push(message);
	}
}

/// The warning for an `@import` or `@charset` that is left out (postcss-import
/// words them like this).
fn dropped_warning(path: &str, name: &str, statement: &str) -> String {
	if name == "charset" {
		return format!("{path}: @charset must precede all other statements: {statement}");
	}
	let params = statement
		.strip_prefix("@import")
		.unwrap_or(statement)
		.trim_end_matches(';');
	if parse_import(0, 0, params).is_none() {
		return format!("{path}: Unable to find uri in '{statement}'");
	}
	format!(
		"{path}: @import statements must precede all other statements (besides @charset or empty @layer) and be consecutive: {statement}"
	)
}

/// The `@import` and `@charset` statements of the top level of a file that the
/// bundler does not read as part of its preamble: after a rule or an at-rule
/// that is not `@layer`, with nothing to import, or a `@charset` that is not
/// the first thing in the file. postcss-import drops them; `known` are the
/// offsets of the imports that were read and `charset_at` is where the leading
/// `@charset` starts. The ranges are those of the statements with their `;`.
fn misplaced_statements(
	text: &str,
	known: &[usize],
	charset_at: Option<usize>,
) -> Vec<(usize, usize, &'static str)> {
	let bytes = text.as_bytes();
	let mut found = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b' ' | b'\t' | b'\n' | b'\r' | 0x0C => i += 1,
			// A `}` that closes nothing.
			b'}' => i += 1,
			b'/' if bytes.get(i + 1) == Some(&b'*') => {
				i = text[i + 2..]
					.find("*/")
					.map_or(bytes.len(), |p| i + 2 + p + 2);
			}
			b'<' if text[i..].starts_with("<!--") => i += 4,
			b'-' if text[i..].starts_with("-->") => i += 3,
			b'@' => {
				let name_end = text[i + 1..]
					.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
					.map_or(bytes.len(), |p| i + 1 + p);
				let name = text[i + 1..name_end].to_ascii_lowercase();
				let Some((end, terminator)) = find_statement_end(text, name_end) else {
					break;
				};
				if terminator == b';' {
					if name == "import" && known.binary_search(&i).is_err() {
						found.push((i, end + 1, "import"));
					} else if name == "charset" && charset_at != Some(i) {
						found.push((i, end + 1, "charset"));
					}
					i = end + 1;
				} else {
					i = skip_block(text, end);
				}
			}
			_ => {
				let Some((end, terminator)) = find_statement_end(text, i) else {
					break;
				};
				i = if terminator == b';' {
					end + 1
				} else {
					skip_block(text, end)
				};
			}
		}
	}
	found
}

/// The offset after the block that opens at `open` (a `{`), or the end of the
/// text when it does not close.
fn skip_block(text: &str, open: usize) -> usize {
	let bytes = text.as_bytes();
	let mut depth = 0usize;
	let mut i = open;
	while i < bytes.len() {
		match bytes[i] {
			b'"' | b'\'' => {
				let quote = bytes[i];
				i += 1;
				while i < bytes.len() && bytes[i] != quote {
					i += if bytes[i] == b'\\' { 2 } else { 1 };
				}
				i += 1;
			}
			b'/' if bytes.get(i + 1) == Some(&b'*') => {
				i = text[i + 2..]
					.find("*/")
					.map_or(bytes.len(), |p| i + 2 + p + 2);
			}
			b'{' => {
				depth += 1;
				i += 1;
			}
			b'}' => {
				depth = depth.saturating_sub(1);
				i += 1;
				if depth == 0 {
					return i;
				}
			}
			_ => i += 1,
		}
	}
	bytes.len()
}

/// The segments of a layer path: the names in the chain, outermost first (a
/// name with dots is a short form of nested layers). Every anonymous layer is
/// a segment of its own that no other path has.
fn layer_path(ctx: &mut Context<'_>, chain: &Chain) -> Vec<String> {
	let mut path = Vec::new();
	for condition in chain {
		match condition.layer.as_deref() {
			Some("") => {
				ctx.anonymous += 1;
				path.push(format!("\0{}", ctx.anonymous));
			}
			Some(layer) => path.extend(layer.split('.').map(|s| s.trim().to_owned())),
			None => {}
		}
	}
	path
}

/// The conditions that are not layers, which is what decides whether two
/// declarations of a layer are the same.
fn wrappers_key(chain: &Chain) -> String {
	chain
		.iter()
		.filter(|c| c.media.is_some() || c.supports.is_some())
		.map(|c| format!("{:?}|{:?}", c.media, c.supports))
		.collect::<Vec<_>>()
		.join(";")
}

/// The layers `@layer a, b.c;` declares under `chain`.
fn layer_statement_declares(ctx: &mut Context<'_>, chain: &Chain, statement: &str) -> Vec<Decl> {
	let names = without_comments(statement.get(6..).unwrap_or_default());
	let names = names.trim().trim_end_matches(';');
	let wrappers = wrappers_key(chain);
	let parent = layer_path(ctx, chain);
	names
		.split(',')
		.map(|name| {
			let mut path = parent.clone();
			path.extend(name.split('.').map(|s| s.trim().to_owned()));
			Decl {
				wrappers: wrappers.clone(),
				path,
			}
		})
		.collect()
}

/// `text` without its `/* ... */` comments.
fn without_comments(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(at) = rest.find("/*") {
		out.push_str(&rest[..at]);
		rest = rest[at + 2..]
			.find("*/")
			.map_or("", |end| &rest[at + 2 + end + 2..]);
	}
	out.push_str(rest);
	out
}

/// The layer a remote import puts its sheet in, if it names one.
fn remote_import_declares(ctx: &mut Context<'_>, chain: &Chain) -> Vec<Decl> {
	let path = layer_path(ctx, chain);
	if path.is_empty() {
		return Vec::new();
	}
	vec![Decl {
		wrappers: wrappers_key(chain),
		path,
	}]
}

/// `@layer a.b;` for the layer a local import puts its sheet in, under the
/// media and supports conditions of the import. `None` when a layer of the
/// chain is anonymous: it has no name to write.
fn declare_layer(chain: &Chain) -> Option<Header> {
	if chain.iter().any(|c| c.layer.as_deref() == Some("")) {
		return None;
	}
	let path: Vec<String> = chain
		.iter()
		.filter_map(|c| c.layer.as_deref())
		.flat_map(|l| l.split('.').map(|s| s.trim().to_owned()))
		.collect();
	let conditions: Chain = chain
		.iter()
		.filter(|c| c.media.is_some() || c.supports.is_some())
		.map(|c| Condition {
			layer: None,
			..c.clone()
		})
		.collect();
	Some(Header {
		kind: Kind::Declare,
		text: format!("@layer {};", path.join(".")),
		uri: String::new(),
		file: 0,
		src: 0,
		declares: vec![Decl {
			wrappers: wrappers_key(&conditions),
			path,
		}],
		chain: conditions,
		pinned: false,
	})
}

/// Drops the `@layer name;` that would not change the order in which the
/// layers are declared: one whose layer is declared before it already, or
/// that has no statement after it that declares a layer (the body declares it
/// then, and nothing can come in between), or whose layer is the first that
/// the next statement declares, under the same conditions (so that it is
/// declared first anyway), or the first that every statement after it
/// declares (a statement under a condition that does not hold declares
/// nothing, and then no other layer comes first either).
fn keep_declarations(items: Vec<Header>) -> Vec<Header> {
	let mut declared: BTreeSet<Decl> = BTreeSet::new();
	let mut keep = Vec::with_capacity(items.len());
	for (i, item) in items.iter().enumerate() {
		if item.kind == Kind::Declare {
			let key = &item.declares[0];
			let later: Vec<&Header> = items[i + 1..]
				.iter()
				.filter(|n| n.kind != Kind::Declare && !n.declares.is_empty())
				.collect();
			let next_first = later.first().is_some_and(|n| {
				n.declares[0].wrappers == key.wrappers && n.declares[0].path.starts_with(&key.path)
			});
			let all_first = later
				.iter()
				.all(|n| n.declares[0].path.starts_with(&key.path));
			// With nothing later, the body declares the layer, unless the file has
			// no body to do it with.
			let skip = if later.is_empty() {
				!item.pinned
			} else {
				next_first || all_first
			};
			if skip || declared.contains(key) {
				keep.push(false);
				continue;
			}
		}
		for d in &item.declares {
			for n in 1..=d.path.len() {
				declared.insert(Decl {
					wrappers: d.wrappers.clone(),
					path: d.path[..n].to_vec(),
				});
			}
		}
		keep.push(true);
	}
	items
		.into_iter()
		.zip(keep)
		.filter_map(|(item, keep)| keep.then_some(item))
		.collect()
}

/// Writes the header, one statement per line.
fn write_header(out: &mut Out, header: Vec<Header>) {
	let items = keep_declarations(header);
	let first = items.iter().position(|h| h.kind == Kind::Import);
	let last = items.iter().rposition(|h| h.kind == Kind::Import);
	// The remote imports written so far: cssnano drops an import that is the
	// same as an earlier one, and a browser loads the sheet once anyway.
	let mut written: BTreeSet<String> = BTreeSet::new();
	for (i, item) in items.iter().enumerate() {
		if item.kind == Kind::Import {
			let statement = if item.chain.is_empty() {
				item.text.clone()
			} else {
				format!("@import {};", import_params(&item.uri, &item.chain))
			};
			if !written.insert(statement.clone()) {
				continue;
			}
			if item.chain.is_empty() {
				out.copy(item.file, item.src, &item.text);
			} else {
				out.add(&statement);
			}
			out.add("\n");
			continue;
		}
		// A statement between imports would end the imports of the browser, so
		// it is written as an import of a `data:` stylesheet, and so is one
		// with conditions in front of the last import (the conditions go on
		// the import).
		let between = matches!((first, last), (Some(f), Some(l)) if i > f && i < l);
		let before_last = last.is_some_and(|l| i < l) && !item.chain.is_empty();
		if between || before_last {
			let sheet = item.text.trim_end_matches(';');
			let data = format!("'data:text/css;base64,{}'", base64(sheet.as_bytes()));
			out.add(&format!("@import {};\n", import_params(&data, &item.chain)));
		} else if item.chain.is_empty() {
			if item.kind == Kind::Layer {
				out.copy(item.file, item.src, &item.text);
			} else {
				out.add(&item.text);
			}
			out.add("\n");
		} else {
			let (prefix, closers) = wrappers(&item.chain);
			out.add(&prefix);
			if item.kind == Kind::Layer {
				out.copy(item.file, item.src, &item.text);
			} else {
				out.add(&item.text);
			}
			out.add("\n");
			out.add(&closers);
		}
	}
}

/// What follows `@import` for a sheet under `chain`. One condition is written
/// after the URL. For more, an import is the content of a `data:` stylesheet
/// that the next one imports, and so on.
///
/// The order only matters for the layers: the sheet is in the layer `a.b` when
/// the import with `layer(b)` is the content of the sheet that the import with
/// `layer(a)` loads. postcss-import writes it the other way round, which is
/// `b.a`, and the layers are declared in that order. With a layer in only one
/// condition (or none) the order does not change what a browser does, and the
/// order of postcss-import is kept, to write what v2 wrote.
fn import_params(uri: &str, chain: &Chain) -> String {
	let Some((first, rest)) = chain.split_first() else {
		return uri.to_owned();
	};
	let layers = chain.iter().filter(|c| c.layer.is_some()).count();
	let mut params;
	if layers < 2 {
		params = format!("{uri} {}", first.prelude());
		for condition in rest {
			params = nested(&params, condition);
		}
	} else {
		let (innermost, outer) = chain.split_last().expect("the chain is not empty");
		params = format!("{uri} {}", innermost.prelude());
		for condition in outer.iter().rev() {
			params = nested(&params, condition);
		}
	}
	params
}

/// The import `params` as the content of a `data:` stylesheet that is imported
/// under `condition`.
fn nested(params: &str, condition: &Condition) -> String {
	format!(
		"'data:text/css;base64,{}' {}",
		base64(format!("@import {params}").as_bytes()),
		condition.prelude()
	)
}

/// The at-rules that open for `chain`, outermost first (per import: `@media`,
/// `@supports`, `@layer`, the nesting postcss-import writes: a media condition
/// that is false must also hide the layer), and the `}` lines that close them.
fn wrappers(chain: &Chain) -> (String, String) {
	let mut prefix = String::new();
	let mut count = 0;
	for condition in chain {
		if let Some(media) = &condition.media {
			prefix.push_str(&format!("@media {media} {{\n"));
			count += 1;
		}
		if let Some(supports) = &condition.supports {
			// `supports(display: grid)` names a condition; the at-rule needs it in
			// parentheses (`supports(not (x))` becomes `(not (x))`).
			prefix.push_str(&format!("@supports ({supports}) {{\n"));
			count += 1;
		}
		match condition.layer.as_deref() {
			Some("") => {
				prefix.push_str("@layer {\n");
				count += 1;
			}
			Some(layer) => {
				prefix.push_str(&format!("@layer {layer} {{\n"));
				count += 1;
			}
			None => {}
		}
	}
	(prefix, "}\n".repeat(count))
}

/// Writes the body. The runs of one file that follow each other (what was
/// between them has moved to the header or been left out) stay in one block
/// under their conditions: split in two, an anonymous layer would become two
/// layers.
fn write_body(out: &mut Out, files: &[BundledFile], body: &[Chunk]) {
	let mut i = 0;
	while i < body.len() {
		let mut j = i + 1;
		if !body[i].chain.is_empty() {
			while j < body.len() && body[j].file == body[i].file && body[j].chain == body[i].chain {
				j += 1;
			}
		}
		if j - i == 1 {
			write_chunk(out, files, &body[i]);
		} else {
			write_joined_runs(out, files, &body[i..j]);
		}
		i = j;
	}
}

/// Writes runs of one file under the same conditions inside one set of
/// at-rules; the last run loses its trailing white space.
fn write_joined_runs(out: &mut Out, files: &[BundledFile], runs: &[Chunk]) {
	let text_of = |c: &Chunk| &files[c.file].text[c.from..c.to];
	if runs.iter().all(|c| text_of(c).trim().is_empty()) {
		return;
	}
	let (prefix, closers) = wrappers(&runs[0].chain);
	out.add(&prefix);
	for (n, run) in runs.iter().enumerate() {
		let text = text_of(run);
		let text = if n + 1 == runs.len() {
			text.trim_end()
		} else {
			text
		};
		out.copy(run.file, run.from, text);
	}
	out.add("\n");
	out.add(&closers);
}

/// Writes a run of a file: as it is when it is not under a condition, else
/// inside the at-rules of the conditions. An imported file loses its trailing
/// white space and ends with a line break.
fn write_chunk(out: &mut Out, files: &[BundledFile], chunk: &Chunk) {
	let text = &files[chunk.file].text[chunk.from..chunk.to];
	let plain = chunk.chain.is_empty() && !chunk.last_of_file;
	if text.trim().is_empty() {
		if plain {
			out.copy(chunk.file, chunk.from, text);
		}
		return;
	}
	if plain {
		out.copy(chunk.file, chunk.from, text);
		return;
	}
	let (prefix, closers) = wrappers(&chunk.chain);
	out.add(&prefix);
	out.copy(chunk.file, chunk.from, text.trim_end());
	out.add("\n");
	out.add(&closers);
}

/// Standard base64, padded.
fn base64(bytes: &[u8]) -> String {
	const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for group in bytes.chunks(3) {
		let n = (u32::from(group[0]) << 16)
			| (u32::from(group.get(1).copied().unwrap_or(0)) << 8)
			| u32::from(group.get(2).copied().unwrap_or(0));
		out.push(char::from(TABLE[(n >> 18) as usize & 63]));
		out.push(char::from(TABLE[(n >> 12) as usize & 63]));
		out.push(if group.len() > 1 {
			char::from(TABLE[(n >> 6) as usize & 63])
		} else {
			'='
		});
		out.push(if group.len() > 2 {
			char::from(TABLE[n as usize & 63])
		} else {
			'='
		});
	}
	out
}

/// The range of a leading `@charset` rule with the white space after it.
fn charset_range(text: &str) -> Option<(usize, usize)> {
	let head = text.trim_start();
	// Bytes, not a string slice: the eighth byte may be inside a character.
	if !head
		.as_bytes()
		.get(..8)
		.is_some_and(|b| b.eq_ignore_ascii_case(b"@charset"))
	{
		return None;
	}
	let end = head.find(';')?;
	let from = text.len() - head.len();
	let after = &head[end + 1..];
	Some((from, text.len() - after.trim_start().len()))
}

fn is_remote(uri: &str) -> bool {
	let lower = uri.trim_start().to_ascii_lowercase();
	lower.starts_with("http://")
		|| lower.starts_with("https://")
		|| lower.starts_with("//")
		|| lower.starts_with("data:")
}

fn resolve(ctx: &mut Context<'_>, importer: &str, uri: &str) -> Result<String, String> {
	for (prefix, target) in ctx.alias {
		if let Some(rest) = uri
			.strip_prefix(prefix.as_str())
			.and_then(|r| r.strip_prefix('/'))
		{
			let candidate = kd_site::path::join(target, rest);
			return probe_file(ctx, &candidate).ok_or_else(|| {
				format!(
					"{importer}: cannot resolve @import \"{uri}\" (alias {prefix:?} -> {candidate})"
				)
			});
		}
	}
	let base = kd_site::path::dirname(importer);
	let relative = kd_site::path::join(&base, uri);
	if let Some(found) = probe_file(ctx, &relative) {
		return Ok(found);
	}
	// Packages: `node_modules` of this directory and of every parent.
	let mut dir = base;
	loop {
		let candidate =
			kd_site::path::join(&format!("{}/node_modules", dir.trim_end_matches('/')), uri);
		if let Some(found) = probe_package(ctx, &candidate) {
			return Ok(found);
		}
		let parent = kd_site::path::dirname(&dir);
		if parent == dir || parent.is_empty() {
			break;
		}
		dir = parent;
	}
	Err(format!("{importer}: cannot resolve @import \"{uri}\""))
}

fn is_file(path: &str) -> bool {
	fs::metadata(path).is_ok_and(|m| m.is_file())
}

fn is_dir(path: &str) -> bool {
	fs::metadata(path).is_ok_and(|m| m.is_dir())
}

/// A file as written or with `.css` appended. A probe that fails is recorded
/// as a missing dependency.
fn probe_file(ctx: &mut Context<'_>, path: &str) -> Option<String> {
	for candidate in [path.to_owned(), format!("{path}.css")] {
		if is_file(&candidate) {
			return Some(candidate);
		}
		ctx.deps.insert(candidate, Dep::missing());
	}
	None
}

/// A file, or a package directory: `style`, a `.css` `main`, else
/// `index.css`.
fn probe_package(ctx: &mut Context<'_>, path: &str) -> Option<String> {
	if let Some(found) = probe_file(ctx, path) {
		return Some(found);
	}
	if !is_dir(path) {
		return None;
	}
	let manifest = format!("{path}/package.json");
	let mut entry = None;
	if let Ok((bytes, dep)) = kd_build::read_with_fingerprint(&manifest) {
		ctx.deps.insert(manifest.clone(), dep);
		if let Ok(value) = kd_jsonc::parse(&String::from_utf8_lossy(&bytes)) {
			let field = |name: &str| value.get(name).and_then(|v| v.as_str()).map(str::to_owned);
			entry = field("style").or_else(|| field("main").filter(|m| m.ends_with(".css")));
		}
	} else {
		ctx.deps.insert(manifest, Dep::missing());
	}
	let main = kd_site::path::join(path, entry.as_deref().unwrap_or("index.css"));
	probe_file(ctx, &main)
}

/// The imports of the preamble of a stylesheet and the byte ranges of its `@layer` statements.
fn scan_preamble(text: &str) -> (Vec<Import>, Vec<(usize, usize)>) {
	let bytes = text.as_bytes();
	let mut imports = Vec::new();
	let mut layers = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b' ' | b'\t' | b'\n' | b'\r' | 0x0C => i += 1,
			b'/' if bytes.get(i + 1) == Some(&b'*') => {
				i = text[i + 2..]
					.find("*/")
					.map_or(bytes.len(), |p| i + 2 + p + 2);
			}
			b'<' if text[i..].starts_with("<!--") => i += 4,
			b'-' if text[i..].starts_with("-->") => i += 3,
			b'@' => {
				let name_end = text[i + 1..]
					.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
					.map_or(bytes.len(), |p| i + 1 + p);
				let name = text[i + 1..name_end].to_ascii_lowercase();
				let Some((prelude_end, terminator)) = find_statement_end(text, name_end) else {
					break;
				};
				match (name.as_str(), terminator) {
					("charset", b';') => i = prelude_end + 1,
					("layer", b';') => {
						layers.push((i, prelude_end + 1));
						i = prelude_end + 1;
					}
					("import", b';') => {
						if let Some(import) =
							parse_import(i, prelude_end + 1, &text[name_end..prelude_end])
						{
							imports.push(import);
						}
						i = prelude_end + 1;
					}
					_ => break,
				}
			}
			_ => break,
		}
	}
	(imports, layers)
}

/// The `;` or `{` that ends the prelude starting at `from`, outside strings,
/// comments and brackets.
fn find_statement_end(text: &str, from: usize) -> Option<(usize, u8)> {
	let bytes = text.as_bytes();
	let mut i = from;
	let mut depth = 0usize;
	while i < bytes.len() {
		match bytes[i] {
			b'"' | b'\'' => {
				let quote = bytes[i];
				i += 1;
				while i < bytes.len() && bytes[i] != quote {
					i += if bytes[i] == b'\\' { 2 } else { 1 };
				}
				i += 1;
			}
			b'/' if bytes.get(i + 1) == Some(&b'*') => {
				i = text[i + 2..]
					.find("*/")
					.map_or(bytes.len(), |p| i + 2 + p + 2);
			}
			b'(' | b'[' => {
				depth += 1;
				i += 1;
			}
			b')' | b']' => {
				depth = depth.saturating_sub(1);
				i += 1;
			}
			b';' if depth == 0 => return Some((i, b';')),
			b'{' if depth == 0 => return Some((i, b'{')),
			_ => i += 1,
		}
	}
	None
}

/// `url("x") layer(a) supports(display: grid) screen and (min-width: 1px)`.
fn parse_import(start: usize, end: usize, params: &str) -> Option<Import> {
	let params = params.trim();
	let (uri, rest) = take_uri(params)?;
	let full_uri = params[..params.len() - rest.len()].trim().to_owned();
	let mut rest = rest.trim_start();
	let mut layer = None;
	let mut supports = None;
	loop {
		let lower = rest.to_ascii_lowercase();
		if layer.is_none() && supports.is_none() && is_keyword(&lower, "layer") {
			if lower[5..].starts_with('(') {
				let (inner, after) = take_parens(&rest[5..])?;
				layer = Some(inner.trim().to_owned());
				rest = after.trim_start();
			} else {
				layer = Some(String::new());
				rest = rest[5..].trim_start();
			}
		} else if supports.is_none() && lower.starts_with("supports(") {
			let (inner, after) = take_parens(&rest[8..])?;
			supports = Some(inner.trim().to_owned());
			rest = after.trim_start();
		} else {
			break;
		}
	}
	let media = (!rest.is_empty()).then(|| rest.to_owned());
	Some(Import {
		start,
		end,
		uri,
		full_uri,
		layer,
		supports,
		media,
	})
}

fn is_keyword(lower: &str, word: &str) -> bool {
	lower.starts_with(word)
		&& lower[word.len()..]
			.chars()
			.next()
			.is_none_or(|c| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
}

/// The inside of `( ... )` at the start of `s` and what follows it.
fn take_parens(s: &str) -> Option<(&str, &str)> {
	let bytes = s.as_bytes();
	if bytes.first() != Some(&b'(') {
		return None;
	}
	let mut depth = 0usize;
	let mut i = 0;
	while i < bytes.len() {
		match bytes[i] {
			b'(' => depth += 1,
			b')' => {
				depth -= 1;
				if depth == 0 {
					return Some((&s[1..i], &s[i + 1..]));
				}
			}
			b'"' | b'\'' => {
				let quote = bytes[i];
				i += 1;
				while i < bytes.len() && bytes[i] != quote {
					i += if bytes[i] == b'\\' { 2 } else { 1 };
				}
			}
			_ => {}
		}
		i += 1;
	}
	None
}

/// A string or `url(...)` at the start of `s`, and what follows it.
fn take_uri(s: &str) -> Option<(String, &str)> {
	let lower = s.to_ascii_lowercase();
	if lower.starts_with("url(") {
		let (inner, after) = take_parens(&s[3..])?;
		let inner = inner.trim();
		let uri = if inner.starts_with(['"', '\'']) {
			take_string(inner)?.0
		} else {
			inner.to_owned()
		};
		return Some((uri, after));
	}
	if s.starts_with(['"', '\'']) {
		return take_string(s);
	}
	None
}

/// A quoted string at the start of `s` (escapes resolved) and what follows.
fn take_string(s: &str) -> Option<(String, &str)> {
	let quote = s.chars().next()?;
	let mut out = String::new();
	let mut chars = s[1..].char_indices();
	while let Some((i, c)) = chars.next() {
		if c == quote {
			return Some((out, &s[1 + i + 1..]));
		}
		if c == '\\' {
			if let Some((_, escaped)) = chars.next() {
				out.push(escaped);
			}
		} else {
			out.push(c);
		}
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	struct Dir(String);

	impl Dir {
		fn new(name: &str) -> Dir {
			let root = format!(
				"{}/kd_import_{name}_{}",
				std::env::temp_dir().display(),
				std::process::id()
			)
			.replace("//", "/");
			let _ = fs::remove_dir_all(&root);
			fs::create_dir_all(&root).unwrap();
			Dir(root)
		}

		fn write(&self, rel: &str, text: &str) -> String {
			let path = format!("{}/{rel}", self.0);
			fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
			fs::write(&path, text).unwrap();
			path
		}
	}

	impl Drop for Dir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn css(dir: &Dir, entry: &str, alias: &[(String, String)]) -> String {
		bundle(&format!("{}/{entry}", dir.0), alias).unwrap().css
	}

	#[test]
	fn the_preamble_is_scanned_up_to_the_first_rule() {
		let text = "@charset \"utf-8\";\n/* c */ @import 'a.css';\n@layer x, y;\n@import url(b.css) screen;\na { color: red }\n@import 'late.css';";
		let uris: Vec<(String, Option<String>)> = scan_preamble(text)
			.0
			.into_iter()
			.map(|i| (i.uri, i.media))
			.collect();
		assert_eq!(
			uris,
			[
				("a.css".to_owned(), None),
				("b.css".to_owned(), Some("screen".to_owned()))
			]
		);
	}

	#[test]
	fn the_forms_of_an_import_are_parsed() {
		let parsed = |params: &str| parse_import(0, 0, params).unwrap();
		let a = parsed(
			" url( \"x y.css\" ) layer(base) supports(display: grid) screen and (min-width: 1px)",
		);
		assert_eq!(a.uri, "x y.css");
		assert_eq!(a.layer.as_deref(), Some("base"));
		assert_eq!(a.supports.as_deref(), Some("display: grid"));
		assert_eq!(a.media.as_deref(), Some("screen and (min-width: 1px)"));
		let b = parsed("'a.css' layer");
		assert_eq!((b.layer.as_deref(), b.media), (Some(""), None));
		let c = parsed("url(plain.css)");
		assert_eq!(c.uri, "plain.css");
		assert!(parse_import(0, 0, "not-a-uri").is_none());
	}

	#[test]
	fn imports_are_inlined_in_place_with_their_conditions() {
		let dir = Dir::new("inline");
		dir.write("lib/a.css", "a { color: red }\n");
		dir.write("lib/b.css", "b { color: blue }\n");
		dir.write(
			"main.css",
			"@import 'lib/a.css';\n@import url(\"lib/b.css\") layer(x) supports(display: grid) screen;\nmain { color: green }\n",
		);
		assert_eq!(
			css(&dir, "main.css", &[]),
			"a { color: red }\n\n@media screen {\n@supports (display: grid) {\n@layer x {\nb { color: blue }\n}\n}\n}\n\nmain { color: green }\n"
		);
	}

	#[test]
	fn nested_imports_resolve_against_the_importing_file() {
		let dir = Dir::new("nested");
		dir.write("css/base/reset.css", "reset{}\n");
		dir.write("css/base/index.css", "@import './reset.css';\nbase{}\n");
		dir.write("css/main.css", "@import 'base/index.css';\nmain{}\n");
		assert_eq!(
			css(&dir, "css/main.css", &[]),
			"reset{}\n\nbase{}\n\nmain{}\n"
		);
	}

	#[test]
	fn an_alias_replaces_its_prefix_and_a_missing_extension_is_added() {
		let dir = Dir::new("alias");
		dir.write("styles/parts/card.css", "card{}\n");
		dir.write("pages/x.css", "@import '@/parts/card';\nx{}\n");
		let alias = [("@".to_owned(), format!("{}/styles", dir.0))];
		assert_eq!(css(&dir, "pages/x.css", &alias), "card{}\n\nx{}\n");
	}

	#[test]
	fn packages_resolve_through_style_main_or_index_and_nearer_ones_win() {
		let dir = Dir::new("packages");
		dir.write(
			"node_modules/with-style/package.json",
			r#"{ "style": "dist/s.css", "main": "x.js" }"#,
		);
		dir.write("node_modules/with-style/dist/s.css", "style{}\n");
		dir.write(
			"node_modules/with-main/package.json",
			r#"{ "main": "m.css" }"#,
		);
		dir.write("node_modules/with-main/m.css", "main-field{}\n");
		dir.write("node_modules/plain/index.css", "index{}\n");
		dir.write("node_modules/@scope/pkg/file.css", "scoped{}\n");
		dir.write("app/node_modules/plain/index.css", "nearer{}\n");
		dir.write(
			"app/main.css",
			"@import 'with-style';\n@import 'with-main';\n@import 'plain';\n@import '@scope/pkg/file.css';\n",
		);
		assert_eq!(
			css(&dir, "app/main.css", &[]),
			"style{}\n\nmain-field{}\n\nnearer{}\n\nscoped{}\n\n"
		);
	}

	#[test]
	fn a_file_imported_twice_or_in_a_cycle_is_inlined_once() {
		let dir = Dir::new("dedupe");
		dir.write("a.css", "@import 'b.css';\na{}\n");
		dir.write("b.css", "@import 'a.css';\nb{}\n");
		dir.write(
			"main.css",
			"@import 'a.css';\n@import 'b.css';\n@import 'a.css' print;\nmain{}\n",
		);
		// Behavior change: a file is inlined once per chain of conditions, so the `b` that `a` imports under `print` is inlined under `print` as well
		assert_eq!(
			css(&dir, "main.css", &[]),
			"\nb{}\n\na{}\n\n\n@media print {\n\nb{}\n}\n@media print {\n\na{}\n}\n\nmain{}\n"
		);
		// assert_eq!( // previous
		// 	css(&dir, "main.css", &[]), // previous
		// 	"\nb{}\n\na{}\n\n\n@media print {\n\na{}\n}\n\nmain{}\n" // previous
		// ); // previous
	}

	#[test]
	fn remote_imports_stay_and_an_imported_charset_goes() {
		let dir = Dir::new("remote");
		dir.write("a.css", "@charset \"utf-8\";\na{}\n");
		dir.write(
			"main.css",
			"@charset \"utf-8\";\n@import url(https://example.com/f.css);\n@import 'a.css';\n",
		);
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@charset \"utf-8\";\n@import url(https://example.com/f.css);\na{}\n\n"
		);
	}

	#[test]
	fn a_remote_import_in_the_middle_goes_to_the_top_after_the_charset() {
		let dir = Dir::new("remote-hoist");
		dir.write("x.css", "a{b:c}\n");
		dir.write(
			"main.css",
			"@charset \"utf-8\";\n@import 'x.css';\n@import url(https://example.com/font.css);\nb{}\n",
		);
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@charset \"utf-8\";\n@import url(https://example.com/font.css);\na{b:c}\n\nb{}\n"
		);
		// The map still points every run at the file it came from.
		let bundle = bundle(&format!("{}/main.css", dir.0), &[]).unwrap();
		for seg in &bundle.segments {
			assert_eq!(
				bundle.css[seg.out..seg.out + seg.len],
				bundle.files[seg.file].text[seg.src..seg.src + seg.len]
			);
		}
	}

	#[test]
	fn a_file_that_starts_with_multibyte_text_is_inlined() {
		let dir = Dir::new("multibyte");
		dir.write("a.css", "/* ベース */\n.日本語{color:red}\n");
		dir.write("b.css", ".日本語{color:blue}\n");
		dir.write("main.css", "@import 'a.css';\n@import 'b.css';\n");
		let out = css(&dir, "main.css", &[]);
		assert!(
			out.contains("ベース") && out.contains("color:blue"),
			"{out}"
		);
	}

	#[test]
	fn a_byte_order_mark_is_not_inlined() {
		let dir = Dir::new("bom");
		dir.write("a.css", "\u{feff}a{color:red}\n");
		dir.write("main.css", "\u{feff}@import 'a.css';\nb{}\n");
		assert_eq!(css(&dir, "main.css", &[]), "a{color:red}\n\nb{}\n");
	}

	#[test]
	fn what_was_read_and_what_was_probed_in_vain_are_dependencies() {
		let dir = Dir::new("deps");
		dir.write("pkg/node_modules/lib/index.css", "lib{}\n");
		let entry = dir.write("pkg/main.css", "@import 'lib';\n");
		let bundle = bundle(&entry, &[]).unwrap();
		let keys: Vec<&str> = bundle.deps.keys().map(|k| &k[dir.0.len() + 1..]).collect();
		assert_eq!(
			keys,
			[
				"pkg/lib",
				"pkg/lib.css",
				"pkg/main.css",
				"pkg/node_modules/lib",
				"pkg/node_modules/lib.css",
				"pkg/node_modules/lib/index.css",
				"pkg/node_modules/lib/package.json",
			]
		);
		assert_eq!(bundle.deps[&format!("{}/pkg/lib", dir.0)], Dep::missing());
		assert_ne!(bundle.deps[&entry], Dep::missing());
	}

	#[test]
	fn every_segment_is_a_copy_of_a_run_of_its_file() {
		let dir = Dir::new("segments");
		dir.write(
			"a.css",
			"@charset \"utf-8\";\n/* あ */ a { color : red }\n\n",
		);
		dir.write("b.css", "b { margin : 0 }\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' screen;\n@import 'b.css';\n@import url(https://example.com/x.css);\nmain { top : 0 }\n",
		);

		let bundle = bundle(&entry, &[]).unwrap();

		assert_eq!(bundle.files.len(), 3);
		assert_eq!(bundle.files[0].path, entry);
		for seg in &bundle.segments {
			assert_eq!(
				&bundle.css[seg.out..seg.out + seg.len],
				&bundle.files[seg.file].text[seg.src..seg.src + seg.len],
				"{seg:?}"
			);
		}
		// What is in no segment: the at-rule the media condition adds (16 and
		// 2 bytes) and the line break the bundler puts after each imported
		// file (it drops the trailing white space of the file first).
		let covered: usize = bundle.segments.iter().map(|s| s.len).sum();
		// The line break after the hoisted remote import is one more, and the
		// `@charset` of `a.css` (17 bytes and a line break) is put on top.
		assert_eq!(bundle.css.len() - covered, 16 + 2 + 1 + 1 + 1 + 18);
		assert!(bundle.segments.iter().any(|s| s.file == 1));
		assert!(bundle.segments.iter().any(|s| s.file == 2));
	}

	#[test]
	fn a_layer_order_after_the_imports_goes_in_front_of_the_imported_layers() {
		let dir = Dir::new("layer-order");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import 'b.css' layer(two);\n@layer two, one;\nx{y:z}\n",
		);
		// Behavior change: `one` is declared before `two`, as the imports do, so `@layer one;` is written in front of the order that names `two` first
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@layer one;\n@layer two, one;\n@layer one {\na{b:c}\n}\n\n@layer two {\nb{b:c}\n}\n\nx{y:z}\n"
		);
		// assert_eq!( // previous
		// 	css(&dir, "main.css", &[]), // previous
		// 	"@layer two, one;\n@layer one {\na{b:c}\n}\n\n@layer two {\nb{b:c}\n}\n\nx{y:z}\n" // previous
		// ); // previous
	}

	#[test]
	fn a_layer_order_after_a_rule_stays_where_it_is() {
		let dir = Dir::new("layer-late");
		dir.write("a.css", "a{b:c}\n");
		dir.write("main.css", "@import 'a.css';\nx{y:z}\n@layer one, two;\n");
		assert_eq!(
			css(&dir, "main.css", &[]),
			"a{b:c}\n\nx{y:z}\n@layer one, two;\n"
		);
	}

	fn every_segment_is_a_copy(bundle: &Bundle) {
		for seg in &bundle.segments {
			assert_eq!(
				&bundle.css[seg.out..seg.out + seg.len],
				&bundle.files[seg.file].text[seg.src..seg.src + seg.len],
				"{seg:?}"
			);
		}
	}

	#[test]
	fn a_remote_import_in_a_layered_file_goes_after_the_layer_statement_with_its_layer() {
		let dir = Dir::new("remote-layered");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css');\n.b { color: blue; }\n",
		);
		let entry = dir.write(
			"main.css",
			"@layer x, y;\n@import './_b.css' layer(y);\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@layer x, y;\n@import url('https://example.com/f.css') layer(y);\n@layer y {\n.b { color: blue; }\n}\n\n.a { color: red; }\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_remote_import_takes_the_conditions_of_the_imports_it_was_reached_through() {
		let dir = Dir::new("remote-conditions");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css');\n.b { color: blue; }\n",
		);
		let entry = dir.write(
			"main.css",
			"@import './_b.css' layer(y) supports(display: grid) screen;\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@import url('https://example.com/f.css') layer(y) supports(display: grid) screen;\n@media screen {\n@supports (display: grid) {\n@layer y {\n.b { color: blue; }\n}\n}\n}\n\n.a { color: red; }\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_remote_import_with_a_condition_of_its_own_adds_it_after_those_of_the_file() {
		let dir = Dir::new("remote-own");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css') layer(z) print;\n.b { color: blue; }\n",
		);
		let entry = dir.write(
			"main.css",
			"@import './_b.css' layer(y);\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// `layer(z) print` inside `layer(y)`: the layer is `y.z`, so the sheet is
		// imported by one import whose sheet is the import of the inner one.
		assert_eq!(
			bundle.css,
			"@import 'data:text/css;base64,QGltcG9ydCB1cmwoJ2h0dHBzOi8vZXhhbXBsZS5jb20vZi5jc3MnKSBsYXllcih6KSBwcmludA==' layer(y);\n@layer y {\n.b { color: blue; }\n}\n\n.a { color: red; }\n"
		);
	}

	#[test]
	fn conditions_nest_with_the_outermost_import_outermost() {
		let dir = Dir::new("remote-two-levels");
		dir.write(
			"_c.css",
			"@import url('https://example.com/f.css');\n.c{}\n",
		);
		dir.write("_b.css", "@import './_c.css' layer(b) print;\n.b{}\n");
		let entry = dir.write("main.css", "@import './_b.css' layer(a) screen;\n.a{}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// The inner import is the content of the data sheet that the import of
		// `layer(a) screen` loads: the layer is `a.b`, not `b.a`.
		assert_eq!(
			bundle.css,
			"@import 'data:text/css;base64,QGltcG9ydCB1cmwoJ2h0dHBzOi8vZXhhbXBsZS5jb20vZi5jc3MnKSBsYXllcihiKSBwcmludA==' layer(a) screen;\n@media screen {\n@layer a {\n@media print {\n@layer b {\n.c{}\n}\n}\n}\n}\n@media screen {\n@layer a {\n\n.b{}\n}\n}\n\n.a{}\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn conditions_with_a_layer_in_only_one_nest_the_way_postcss_import_writes_them() {
		let dir = Dir::new("remote-one-layer");
		dir.write(
			"_c.css",
			"@import url('https://example.com/f.css');\n.c{}\n",
		);
		dir.write("_b.css", "@import './_c.css' print;\n.b{}\n");
		let entry = dir.write("main.css", "@import './_b.css' screen;\n.a{}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// Which media query is outside makes no difference to a browser.
		assert_eq!(
			bundle.css,
			"@import 'data:text/css;base64,QGltcG9ydCB1cmwoJ2h0dHBzOi8vZXhhbXBsZS5jb20vZi5jc3MnKSBzY3JlZW4=' print;\n@media screen {\n@media print {\n.c{}\n}\n}\n@media screen {\n\n.b{}\n}\n\n.a{}\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn the_same_remote_import_is_written_once() {
		let dir = Dir::new("remote-twice");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css');\n.b{}\n",
		);
		dir.write(
			"_c.css",
			"@import url('https://example.com/f.css');\n.c{}\n",
		);
		dir.write(
			"_d.css",
			"@import url('https://example.com/f.css');\n.d{}\n",
		);
		let entry = dir.write(
			"main.css",
			"@import './_b.css';\n@import './_c.css';\n@import './_d.css' layer(y);\n.a{}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@import url('https://example.com/f.css');\n@import url('https://example.com/f.css') layer(y);\n.b{}\n\n.c{}\n\n@layer y {\n.d{}\n}\n\n.a{}\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn the_layer_statements_of_an_imported_file_go_to_the_header_with_its_conditions() {
		let dir = Dir::new("layer-statement");
		dir.write("_b.css", "@layer p, q;\n.b { color: blue; }\n");
		let entry = dir.write(
			"main.css",
			"@import './_b.css' layer(y);\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@layer y {\n@layer p, q;\n}\n@layer y {\n.b { color: blue; }\n}\n\n.a { color: red; }\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_statement_between_remote_imports_is_an_import_of_a_data_sheet() {
		let dir = Dir::new("layer-between");
		dir.write("_b.css", "@layer p, q;\n.b { color: blue; }\n");
		let entry = dir.write(
			"main.css",
			"@import url('https://example.com/e.css');\n@import './_b.css' layer(y);\n@import url('https://example.com/f.css');\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			format!(
				"@import url('https://example.com/e.css');\n@import 'data:text/css;base64,{}' layer(y);\n@import url('https://example.com/f.css');\n@layer y {{\n.b {{ color: blue; }}\n}}\n\n.a {{ color: red; }}\n",
				base64(b"@layer p, q")
			)
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn an_import_after_a_layer_statement_that_follows_an_import_is_left_out_with_a_warning() {
		let dir = Dir::new("import-after-layer");
		dir.write("_b.css", ".b { color: blue; }\n");
		dir.write("_c.css", ".c { color: green; }\n");
		let entry = dir.write(
			"main.css",
			"@import './_b.css';\n@layer x;\n@import './_c.css';\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@layer x;\n.b { color: blue; }\n\n.a { color: red; }\n"
		);
		assert_eq!(bundle.warnings.len(), 1);
		assert!(
			bundle.warnings[0].starts_with(&format!(
				"{entry}: @import statements must precede all other statements"
			)) && bundle.warnings[0].ends_with("@import './_c.css';"),
			"{:?}",
			bundle.warnings
		);
		assert!(bundle.files.iter().all(|f| !f.path.ends_with("_c.css")));
	}

	#[test]
	fn an_import_or_charset_after_a_rule_is_left_out_with_a_warning() {
		let dir = Dir::new("late");
		dir.write("_b.css", ".b { color: blue; }\n");
		let entry = dir.write(
			"main.css",
			"@import './_b.css';\na { color: red; }\n@import url('https://example.com/late.css');\n@media print { @import 'inside.css'; }\n@charset \"utf-8\";\nc { color: green; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			".b { color: blue; }\n\na { color: red; }\n@media print { @import 'inside.css'; }\nc { color: green; }\n"
		);
		assert_eq!(bundle.warnings.len(), 2, "{:?}", bundle.warnings);
		assert!(bundle.warnings[0].ends_with("@import url('https://example.com/late.css');"));
		assert_eq!(
			bundle.warnings[1],
			format!("{entry}: @charset must precede all other statements: @charset \"utf-8\";")
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn the_runs_of_an_anonymous_layer_that_a_left_out_import_splits_stay_one_layer() {
		let dir = Dir::new("late-anonymous");
		dir.write(
			"_b.css",
			".x { color: red; }\n@import 'late.css';\n.y { color: blue; }\n",
		);
		let entry = dir.write("main.css", "@import './_b.css' layer;\n");
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@layer {\n.x { color: red; }\n.y { color: blue; }\n}\n\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_warning_is_reported_once_for_a_file_imported_under_several_conditions() {
		let dir = Dir::new("late-twice");
		dir.write("_b.css", ".b { color: blue; }\n@import 'late.css';\n");
		let entry = dir.write(
			"main.css",
			"@import './_b.css' print;\n@import './_b.css' screen;\n",
		);
		assert_eq!(bundle(&entry, &[]).unwrap().warnings.len(), 1);
	}

	#[test]
	fn a_layer_statement_under_an_anonymous_layer_stays_in_its_block() {
		let dir = Dir::new("anonymous-statement");
		dir.write("_b.css", "@layer p, q;\n@layer q { .q { color: red; } }\n");
		let entry = dir.write("main.css", "@import './_b.css' layer;\n");
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@layer {\n@layer p, q;\n@layer q { .q { color: red; } }\n}\n\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_charset_in_the_middle_of_an_imported_file_is_left_out_with_a_warning() {
		let dir = Dir::new("late-charset");
		let b = dir.write("_b.css", ".x { color: red; }\n@charset \"utf-8\";\n");
		let entry = dir.write("main.css", "@import './_b.css';\n");
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(bundle.css, ".x { color: red; }\n\n");
		assert_eq!(
			bundle.warnings,
			[format!(
				"{b}: @charset must precede all other statements: @charset \"utf-8\";"
			)]
		);
	}

	#[test]
	fn a_stray_closing_brace_does_not_hide_the_statements_after_it() {
		let dir = Dir::new("stray-brace");
		let entry = dir.write(
			"main.css",
			"a { color: red; }\n}\n@import 'late.css';\nb { color: blue; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(bundle.css, "a { color: red; }\n}\nb { color: blue; }\n");
		assert_eq!(bundle.warnings.len(), 1);
	}

	#[test]
	fn a_file_is_inlined_again_under_other_conditions() {
		let dir = Dir::new("again");
		dir.write("a.css", "a{}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css';\n@import 'a.css' print;\n@import 'a.css' print;\n",
		);
		assert_eq!(
			bundle(&entry, &[]).unwrap().css,
			"a{}\n\n@media print {\na{}\n}\n\n\n"
		);
	}

	#[test]
	fn the_names_in_a_layer_statement_are_read_without_the_comments_in_it() {
		let dir = Dir::new("declare-comments");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@layer one /* first */, two;\n@import 'a.css' layer(one);\nx{y:z}\n",
		);
		assert!(
			bundle(&entry, &[])
				.unwrap()
				.css
				.starts_with("@layer one /* first */, two;\n@layer one {\n"),
		);
	}

	#[test]
	fn the_layer_of_a_nested_name_is_declared_with_its_parents() {
		let dir = Dir::new("declare-dots");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one.two);\n@layer three;\nx{y:z}\n",
		);
		assert!(
			bundle(&entry, &[])
				.unwrap()
				.css
				.starts_with("@layer one.two;\n@layer three;\n"),
		);
	}

	#[test]
	fn a_declaration_between_remote_imports_is_an_import_of_a_data_sheet() {
		let dir = Dir::new("declare-between");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import url('https://example.com/e.css');\n@import 'a.css' layer(one) screen;\n@import url('https://example.com/f.css');\n@layer two;\n",
		);
		let css = bundle(&entry, &[]).unwrap().css;
		// `@layer one` is the content of a data sheet that is imported under the
		// media query.
		assert!(
			css.starts_with(&format!(
				"@import url('https://example.com/e.css');\n@import 'data:text/css;base64,{}' screen;\n@import url('https://example.com/f.css');\n",
				base64(b"@layer one")
			)),
			"{css}"
		);
	}

	#[test]
	fn conditions_nest_through_three_levels_with_supports_and_layers() {
		let dir = Dir::new("remote-three-levels");
		dir.write(
			"_c.css",
			"@import url('https://example.com/f.css');\n.c{}\n",
		);
		dir.write("_b.css", "@import './_c.css' layer(c);\n.b{}\n");
		dir.write(
			"_a.css",
			"@import './_b.css' layer(b) supports(display: grid);\n.a{}\n",
		);
		let entry = dir.write("main.css", "@import './_a.css' layer(a);\n");
		let css = bundle(&entry, &[]).unwrap().css;
		// From the inside: `layer(c)`, then `layer(b) supports(display: grid)`,
		// and the import of `layer(a)` outermost.
		let inner = base64(b"@import url('https://example.com/f.css') layer(c)");
		let middle = base64(
			format!("@import 'data:text/css;base64,{inner}' layer(b) supports(display: grid)")
				.as_bytes(),
		);
		assert!(
			css.contains(&format!(
				"@import 'data:text/css;base64,{middle}' layer(a);\n"
			)),
			"{css}"
		);
	}

	#[test]
	fn an_import_that_names_no_file_is_left_out_with_a_warning() {
		let dir = Dir::new("no-uri");
		let entry = dir.write("main.css", "@import foo;\na { color: red; }\n");
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(bundle.css, "a { color: red; }\n");
		assert_eq!(
			bundle.warnings,
			[format!("{entry}: Unable to find uri in '@import foo;'")]
		);
	}

	#[test]
	fn the_layer_of_a_local_import_is_declared_where_the_source_declares_it() {
		let dir = Dir::new("declare");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import 'b.css' layer(two);\n@layer two, one;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// `one` is declared first, as the first import does, and `two` by the
		// statement, which names it first.
		assert!(
			bundle.css.starts_with("@layer one;\n@layer two, one;\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_that_is_declared_already_or_by_the_next_statement_first_is_not_declared_again() {
		let dir = Dir::new("declare-not");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		let before = dir.write(
			"before.css",
			"@layer one, two;\n@import 'a.css' layer(one);\n@import 'b.css' layer(two);\nx{y:z}\n",
		);
		assert!(
			bundle(&before, &[])
				.unwrap()
				.css
				.starts_with("@layer one, two;\n@layer one {\n"),
			"declared in front of the imports already"
		);
		let after = dir.write(
			"after.css",
			"@import 'a.css' layer(one);\n@layer one, two;\nx{y:z}\n",
		);
		assert!(
			bundle(&after, &[])
				.unwrap()
				.css
				.starts_with("@layer one, two;\n@layer one {\n"),
			"the statement names it first"
		);
		let nothing = dir.write("nothing.css", "@import 'a.css' layer(one);\nx{y:z}\n");
		assert!(
			bundle(&nothing, &[])
				.unwrap()
				.css
				.starts_with("@layer one {\n"),
			"nothing is declared after it"
		);
	}

	#[test]
	fn a_layer_that_a_remote_import_of_the_file_declares_first_is_not_declared_again() {
		let dir = Dir::new("declare-by-remote");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css');\nb{c:d}\n",
		);
		let entry = dir.write(
			"main.css",
			"@import './_b.css' layer(y);\n@layer x, y;\nx{y:z}\n",
		);
		assert!(
			bundle(&entry, &[])
				.unwrap()
				.css
				.starts_with("@import url('https://example.com/f.css') layer(y);\n@layer x, y;\n"),
		);
	}

	#[test]
	fn the_layer_of_an_import_of_a_file_with_nothing_in_it_is_declared_by_a_statement() {
		let dir = Dir::new("declare-empty");
		dir.write("empty.css", "\n");
		dir.write("b.css", "b{c:d}\n");
		let entry = dir.write(
			"main.css",
			"@import 'empty.css' layer(one);\n@import 'b.css' layer(two);\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// The body writes no block for `one`: without the statement it would
		// not be declared, and a later `@layer one` would come after `two`.
		assert!(bundle.css.starts_with("@layer one;\n"), "{}", bundle.css);
	}

	#[test]
	fn a_file_that_ends_with_a_statement_that_moved_ends_with_its_last_run() {
		let dir = Dir::new("ends-with-header");
		dir.write(
			"_b.css",
			"/* b */\n\n\n@import url('https://example.com/f.css');\n",
		);
		let entry = dir.write(
			"main.css",
			"@import './_b.css' layer(y);\n.a { color: red; }\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert_eq!(
			bundle.css,
			"@import url('https://example.com/f.css') layer(y);\n@layer y {\n/* b */\n}\n\n.a { color: red; }\n"
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn an_anonymous_layer_has_no_name_to_declare() {
		let dir = Dir::new("declare-anonymous");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write("main.css", "@import 'a.css' layer;\n@layer two;\nx{y:z}\n");
		assert!(
			bundle(&entry, &[])
				.unwrap()
				.css
				.starts_with("@layer two;\n@layer {\n"),
		);
	}

	#[test]
	fn the_layer_of_a_conditional_import_is_declared_under_its_condition() {
		let dir = Dir::new("declare-conditional");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one) screen;\n@layer two;\nx{y:z}\n",
		);
		assert!(
			bundle(&entry, &[])
				.unwrap()
				.css
				.starts_with("@media screen {\n@layer one;\n}\n@layer two;\n"),
		);
	}

	#[test]
	fn base64_is_the_standard_padded_encoding() {
		assert_eq!(base64(b""), "");
		assert_eq!(base64(b"M"), "TQ==");
		assert_eq!(base64(b"Ma"), "TWE=");
		assert_eq!(base64(b"Man"), "TWFu");
		assert_eq!(base64(b"Many hands"), "TWFueSBoYW5kcw==");
	}

	#[test]
	fn the_charset_of_an_imported_file_goes_on_top_when_the_entry_has_none() {
		let dir = Dir::new("charset-up");
		dir.write("a.css", "a{b:c}\n");
		dir.write("c.css", "@charset \"UTF-8\";\nc{d:e}\n");
		dir.write("main.css", "@import 'a.css';\n@import 'c.css';\nx{y:z}\n");
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@charset \"UTF-8\";\na{b:c}\n\nc{d:e}\n\nx{y:z}\n"
		);
	}

	#[test]
	fn charsets_that_differ_are_an_error() {
		let dir = Dir::new("charset-clash");
		dir.write("c.css", "@charset \"UTF-8\";\nc{d:e}\n");
		let entry = dir.write("main.css", "@charset \"ascii\";\n@import 'c.css';\n");
		assert!(
			bundle(&entry, &[])
				.unwrap_err()
				.contains("Incompatible @charset")
		);
	}

	#[test]
	fn an_import_that_cannot_be_found_names_the_file_and_the_specifier() {
		let dir = Dir::new("missing");
		let entry = dir.write("main.css", "@import './nope.css';\n");
		let e = bundle(&entry, &[]).unwrap_err();
		assert_eq!(e, format!("{entry}: cannot resolve @import \"./nope.css\""));
	}
}
