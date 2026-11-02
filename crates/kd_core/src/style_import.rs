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
//!   (the layer of the import, and the `@layer` blocks and statements in the
//!   file) only after them; where that changes the order, `@layer name;` is
//!   written at the place of the import. A remote import without a layer may
//!   declare any layer, so the layers declared in front of it stay in front.
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
	/// `@layer name;` for the layer of a local import or a layer the body of
	/// its file declares, so that the layer is declared where the source
	/// declares it. Written only where it changes the order
	/// (`keep_declarations`).
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
	// The source declares the layers of the body here, before what comes after
	// the import; the bundle writes every body after the header. `@layer name;`
	// for each is a candidate that `keep_declarations` keeps only where leaving it
	// out would change the order.
	// Inside an anonymous layer there is no name to write. The body of the
	// entry comes after the whole header in the source too.
	let declared_in_body: Vec<Header> = flat
		.body
		.iter()
		.filter(|c| {
			!is_entry && c.file == index && !c.chain.iter().any(|l| l.layer.as_deref() == Some(""))
		})
		.flat_map(|c| {
			body_layers(&text[c.from..c.to])
				.into_iter()
				.filter_map(|(conditions, inner)| {
					let mut chain = c.chain.clone();
					chain.extend(conditions);
					declare_path(&chain, &inner)
				})
		})
		.collect();
	flat.header.extend(declared_in_body);
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

/// The layers that the `@layer` blocks and statements in a run of a body
/// declare, in order, each as its names inside the layers of the run (`@layer
/// a { @layer b; }` gives `["a"]` and `["a", "b"]`), with the `@media` and
/// `@supports` it is inside (as conditions, outermost first). An anonymous
/// block has no name to declare, nor have the layers inside it. A layer inside
/// a rule or another at-rule (`@container`, `@scope`) depends on what the
/// bundler does not read, and so does an invalid `@layer` (no name, a block
/// with two names), which a browser drops: neither is listed.
fn body_layers(text: &str) -> Vec<(Chain, Vec<String>)> {
	let mut out = Vec::new();
	// Most runs have no layer in them.
	if text
		.as_bytes()
		.windows(6)
		.any(|w| w.eq_ignore_ascii_case(b"@layer"))
	{
		body_layers_in(text, 0, text.len(), &Vec::new(), &[], &mut out);
	}
	out
}

fn body_layers_in(
	text: &str,
	from: usize,
	to: usize,
	conditions: &Chain,
	parent: &[String],
	out: &mut Vec<(Chain, Vec<String>)>,
) {
	let bytes = text.as_bytes();
	let path_of = |name: &str| {
		let mut path = parent.to_vec();
		path.extend(name.split('.').map(|s| s.trim().to_owned()));
		path
	};
	let mut i = from;
	while i < to {
		match bytes[i] {
			b' ' | b'\t' | b'\n' | b'\r' | 0x0C | b'}' => i += 1,
			b'/' if bytes.get(i + 1) == Some(&b'*') => {
				i = text[i + 2..].find("*/").map_or(to, |p| i + 2 + p + 2);
			}
			b'<' if text[i..].starts_with("<!--") => i += 4,
			b'-' if text[i..].starts_with("-->") => i += 3,
			_ => {
				let name_end = (bytes[i] == b'@').then(|| {
					text[i + 1..]
						.find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
						.map_or(to, |p| i + 1 + p)
				});
				// A statement also ends at the `}` of the block it is in, or at the
				// end of the text (CSS Syntax § 5.4.2).
				let (end, terminator) = find_statement_end(text, name_end.unwrap_or(i))
					.filter(|&(end, _)| end < to)
					.unwrap_or((to, b';'));
				let name = name_end.map(|n| text[i + 1..n].to_ascii_lowercase());
				let prelude = name_end.map(|n| without_comments(&text[n..end]));
				let prelude = prelude.as_deref().map(str::trim).unwrap_or_default();
				// Each name is identifiers joined by `.`, with nothing in between.
				let valid_names = |names: &str| {
					names
						.split(',')
						.all(|n| n.trim().split('.').all(is_layer_ident))
				};
				if terminator == b';' {
					if name.as_deref() == Some("layer") && valid_names(prelude) {
						out.extend(prelude.split(',').map(|n| (conditions.clone(), path_of(n))));
					}
					i = end + 1;
					continue;
				}
				let close = skip_block(text, end).min(to);
				// A block that the text ends in has no `}` to leave out.
				let closed = close > end + 1 && bytes[close - 1] == b'}';
				let inner = (end + 1, if closed { close - 1 } else { close });
				match name.as_deref() {
					Some("layer") if !prelude.contains(',') && valid_names(prelude) => {
						let path = path_of(prelude);
						out.push((conditions.clone(), path.clone()));
						body_layers_in(text, inner.0, inner.1, conditions, &path, out);
					}
					Some(rule @ ("media" | "supports")) if !prelude.is_empty() => {
						let mut nested = conditions.clone();
						nested.push(Condition {
							layer: None,
							// As `supports()` of an import has it: without the parentheses
							// that the at-rule needs around it.
							supports: (rule == "supports")
								.then(|| unwrap_parens(prelude).to_owned()),
							media: (rule == "media").then(|| prelude.to_owned()),
						});
						body_layers_in(text, inner.0, inner.1, &nested, parent, out);
					}
					_ => {}
				}
				i = close;
			}
		}
	}
}

/// Whether `s` is one name of a layer: an identifier (no white space, not
/// starting with a digit; an escape or a character outside ASCII is part of
/// it).
fn is_layer_ident(s: &str) -> bool {
	!s.is_empty()
		&& !s.starts_with(|c: char| c.is_ascii_digit())
		&& s.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '\\') || !c.is_ascii())
}

/// `s` without the parentheses around all of it: `(a)` gives `a`, but
/// `(a) and (b)` stays as it is.
fn unwrap_parens(s: &str) -> &str {
	let Some(inner) = s.strip_prefix('(').and_then(|r| r.strip_suffix(')')) else {
		return s;
	};
	let mut depth = 0usize;
	for c in inner.chars() {
		match c {
			'(' => depth += 1,
			')' if depth == 0 => return s,
			')' => depth -= 1,
			_ => {}
		}
	}
	inner
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
	declare_path(chain, &[])
}

/// `@layer a.b.c;` for the layer `inner` (`["c"]`) inside the layers of
/// `chain` (`a.b`), under the media and supports conditions of the chain.
/// `None` when a layer of the chain is anonymous: it has no name to write.
fn declare_path(chain: &Chain, inner: &[String]) -> Option<Header> {
	if chain.iter().any(|c| c.layer.as_deref() == Some("")) {
		return None;
	}
	let path: Vec<String> = chain
		.iter()
		.filter_map(|c| c.layer.as_deref())
		.flat_map(|l| l.split('.').map(|s| s.trim().to_owned()))
		.chain(inner.iter().cloned())
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
/// layers are declared. The order the source means is that of every statement
/// of the header, the written ones at the place of their import; the body then
/// declares the layer of every import that has rules, and the layers of the
/// `@layer` blocks and statements in it, in the order of those statements.
///
/// A statement is decided one at a time from the last (a written one is what
/// an earlier one has to come in front of). Left out, it no longer declares
/// the layers it is the first to declare; each is then first declared where it
/// is next named. That changes the order when a sibling of the layer (a layer
/// of the same parent, § 6.4.3) that the source declares after the statement is
/// declared in between. Deciding by the next statement alone would miss a
/// written one that comes in between: `@layer one;` left out in front of
/// `@layer two;` and `@layer one, two;` declares `two` first. Once the body is
/// reached nothing can come in between: what the body declares before the
/// layer, the statements in front of this one declared already.
///
/// A statement under a condition declares nothing where the condition does
/// not hold, so it is decided where its own condition holds: alone, and
/// together with each other condition (a layer it would let come first is
/// declared by a statement under one condition). A condition holds only when
/// the conditions it is nested in do. Every combination of conditions would
/// grow as 2 to their number.
///
/// A remote import may declare any layer (inside its own, if it has one), so
/// it counts as declaring a layer no statement names: the layers the source
/// declares in front of it stay in front of it.
///
/// Each statement looks only at the statements kept after it, up to the next
/// place its layer is named, and stops at the body: the `@layer` blocks of a
/// body, which come one after another, are each decided in a few steps.
/// Recomputing the whole order for each statement grows as the square of
/// their number, seconds for a few thousand blocks on every rebuild.
fn keep_declarations(items: Vec<Header>) -> Vec<Header> {
	let mut keep = vec![true; items.len()];
	// A statement that something before it declares already is never needed.
	// Deciding it below would drop it too; this is for speed, as every
	// `@layer` block of a body is a statement here.
	let mut declared: BTreeSet<(&str, &[String])> = BTreeSet::new();
	for (item, kept) in items.iter().zip(keep.iter_mut()) {
		if item.kind == Kind::Declare {
			let d = &item.declares[0];
			if declared.contains(&(d.wrappers.as_str(), d.path.as_slice())) {
				*kept = false;
				continue;
			}
		}
		for d in &item.declares {
			for n in 1..=d.path.len() {
				declared.insert((d.wrappers.as_str(), &d.path[..n]));
			}
		}
	}
	// Only the body declares anything, in the order of the statements, unless
	// the file of an import has no body to declare its layer with. Deciding
	// each statement below would drop all of them too; this is for speed.
	if items.iter().all(|h| h.kind == Kind::Declare && !h.pinned) {
		return Vec::new();
	}
	let mut seen_imports: BTreeSet<String> = BTreeSet::new();
	let unknown: Vec<Option<Decl>> = items
		.iter()
		.enumerate()
		.map(|(i, h)| {
			if h.kind != Kind::Import {
				return None;
			}
			// The same import is written once (`write_header`).
			if !seen_imports.insert(import_statement(h)) {
				return None;
			}
			let mut path = h
				.declares
				.first()
				.map(|d| d.path.clone())
				.unwrap_or_default();
			path.push(format!("\0remote{i}"));
			Some(Decl {
				wrappers: wrappers_key(&h.chain),
				path,
			})
		})
		.collect();
	let decls_of = |j: usize| items[j].declares.iter().chain(&unknown[j]);
	let mut conditions: Vec<&str> = (0..items.len())
		.flat_map(decls_of)
		.map(|d| d.wrappers.as_str())
		.filter(|w| !w.is_empty())
		.collect();
	conditions.sort_unstable();
	conditions.dedup();
	// A condition with the conditions it is nested in.
	let with_outer = |w: &str| -> BTreeSet<&str> {
		conditions
			.iter()
			.copied()
			.filter(|outer| !w.is_empty() && nests_in(w, outer))
			.collect()
	};
	// Where the source first declares each layer, under the conditions that
	// hold. The body declares nothing first: each of its layers is the layer
	// of a statement.
	let mut first: BTreeMap<BTreeSet<&str>, BTreeMap<&[String], usize>> = BTreeMap::new();
	// The statements kept after the one being decided, last first.
	let mut kept_after: Vec<usize> = Vec::new();
	for i in (0..items.len()).rev() {
		if items[i].kind != Kind::Declare || !keep[i] {
			if keep[i] {
				kept_after.push(i);
			}
			continue;
		}
		let own = &items[i].declares[0];
		let base = with_outer(&own.wrappers);
		let mut worlds = vec![base.clone()];
		worlds.extend(conditions.iter().map(|k| {
			let mut world = base.clone();
			world.extend(with_outer(k));
			world
		}));
		worlds.sort();
		worlds.dedup();
		let changes = worlds.into_iter().any(|world| {
			let holds = |d: &Decl| d.wrappers.is_empty() || world.contains(d.wrappers.as_str());
			let first = first.entry(world.clone()).or_insert_with(|| {
				let mut at = BTreeMap::new();
				for j in 0..items.len() {
					for d in decls_of(j).filter(|d| holds(d)) {
						for n in 1..=d.path.len() {
							at.entry(&d.path[..n]).or_insert(j);
						}
					}
				}
				at
			});
			(1..=own.path.len())
				.map(|n| &own.path[..n])
				.filter(|layer| first.get(layer) == Some(&i))
				.any(|layer| {
					let parent = &layer[..layer.len() - 1];
					// Whether `d` names the layer, or else declares a sibling of it
					// first, which would then come before it.
					let mut verdict = |d: &Decl| -> Option<bool> {
						if d.path.starts_with(layer) {
							return Some(false);
						}
						let sibling = d.path.len() > parent.len() && d.path.starts_with(parent);
						(sibling
							&& first
								.get(&d.path[..=parent.len()])
								.is_some_and(|&at| at > i))
						.then_some(true)
					};
					let in_header = kept_after
						.iter()
						.rev()
						.flat_map(|&j| decls_of(j))
						.filter(|d| holds(d))
						.find_map(&mut verdict);
					match in_header {
						Some(changes) => changes,
						// The body names it, and nothing comes first in between.
						None if !items[i].pinned => false,
						None => items[i + 1..]
							.iter()
							.filter(|h| h.kind == Kind::Declare && !h.pinned)
							.flat_map(|h| &h.declares)
							.filter(|d| holds(d))
							.find_map(&mut verdict)
							.unwrap_or(true),
					}
				})
		});
		keep[i] = changes;
		if changes {
			kept_after.push(i);
		}
	}
	items
		.into_iter()
		.zip(keep)
		.filter_map(|(item, keep)| keep.then_some(item))
		.collect()
}

/// Whether the conditions `inner` holds under include all of `outer`'s: the
/// keys of [`wrappers_key`] list the conditions outermost first, so `outer`
/// is the first parts of `inner`.
fn nests_in(inner: &str, outer: &str) -> bool {
	inner == outer
		|| inner
			.strip_prefix(outer)
			.is_some_and(|rest| rest.starts_with(';'))
}

/// The statement a remote import is written as: as written in the source, or,
/// under conditions, with them. Two imports with the same statement are one.
fn import_statement(item: &Header) -> String {
	if item.chain.is_empty() {
		item.text.clone()
	} else {
		format!("@import {};", import_params(&item.uri, &item.chain))
	}
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
			let statement = import_statement(item);
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
	fn layers_that_a_later_statement_declares_in_the_same_order_are_not_declared_again() {
		let dir = Dir::new("declare-run");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		dir.write("c.css", "c{b:c}\n");
		dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import 'b.css' layer(two);\n@import 'c.css' layer(two);\n@layer one, two;\nx{y:z}\n",
		);
		// The statement declares `one` and then `two`, as the imports do: nothing
		// is written for them, and `two` does not come in front of `one`.
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@layer one, two;\n@layer one {\na{b:c}\n}\n\n@layer two {\nb{b:c}\n}\n\n@layer two {\nc{b:c}\n}\n\nx{y:z}\n"
		);
	}

	#[test]
	fn a_layer_that_the_body_of_an_imported_file_declares_is_declared_at_the_import() {
		let dir = Dir::new("declare-body");
		dir.write("a.css", "@layer z {\na{b:c}\n}\n");
		let entry = dir.write("main.css", "@import 'a.css';\n@layer w, z;\nx{y:z}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// The block of `a.css` declares `z` before the statement declares `w`; in
		// the bundle the block comes after the statement.
		assert!(
			bundle
				.css
				.starts_with("@layer z;\n@layer w, z;\n@layer z {\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_inside_another_is_ordered_only_against_its_siblings() {
		let dir = Dir::new("declare-nested-body");
		dir.write("a.css", "@layer x {\na{b:c}\n}\n");
		dir.write("b.css", "b{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(a);\n@import 'b.css' layer(b);\n@layer a, b;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// `a.x` is declared after `b` in the bundle, but `b` is not a sibling of
		// `x`: nothing has to be written for it.
		assert!(
			bundle.css.starts_with("@layer a, b;\n@layer a {\n"),
			"{}",
			bundle.css
		);
	}

	#[test]
	fn the_layers_of_a_body_are_its_layer_blocks_and_statements_with_their_names() {
		let path = |names: &[&str]| names.iter().map(|&n| n.to_owned()).collect::<Vec<_>>();
		let paths = |text: &str| -> Vec<Vec<String>> {
			body_layers(text).into_iter().map(|(_, p)| p).collect()
		};
		assert_eq!(
			paths(
				"a{b:c}\n@layer x.y {\n@layer z;\n@LAYER w { b{c:d} }\n}\n@layer p, /* c */ q;\n"
			),
			[
				path(&["x", "y"]),
				path(&["x", "y", "z"]),
				path(&["x", "y", "w"]),
				path(&["p"]),
				path(&["q"]),
			]
		);
		assert_eq!(
			paths(
				"@layer { @layer a; }\n@container (width > 1px) { @layer b {} }\nc{ content: '@layer d;' }\n"
			),
			Vec::<Vec<String>>::new(),
			"an anonymous block, another at-rule and a string declare nothing"
		);
		assert_eq!(
			paths("@layer p, q { a{b:c} }\n@layer;\n@layer a, ;\n@layer .b {}\n"),
			Vec::<Vec<String>>::new(),
			"an invalid prelude, which a browser drops, declares nothing"
		);
	}

	/// `(media, supports)` of a condition.
	type Wrapper = (Option<String>, Option<String>);

	/// What `body_layers` finds, as the wrappers of each condition and the path.
	fn found(text: &str) -> Vec<(Vec<Wrapper>, Vec<String>)> {
		body_layers(text)
			.into_iter()
			.map(|(conditions, path)| {
				(
					conditions
						.into_iter()
						.map(|c| (c.media, c.supports))
						.collect(),
					path,
				)
			})
			.collect()
	}

	fn names(names: &[&str]) -> Vec<String> {
		names.iter().map(|&n| n.to_owned()).collect()
	}

	#[test]
	fn a_layer_inside_media_or_supports_in_a_body_is_under_its_conditions() {
		let print = (Some("print".to_owned()), None);
		let grid = (None, Some("display: grid".to_owned()));
		let screen = (Some("screen".to_owned()), None);
		assert_eq!(
			found(
				"@media print {\n@supports (display: grid) {\n@layer x;\n}\n}\n@layer y { @media screen { @layer z {} } }\n"
			),
			[
				(vec![print, grid], names(&["x"])),
				(vec![], names(&["y"])),
				(vec![screen], names(&["y", "z"])),
			]
		);
	}

	#[test]
	fn a_statement_ends_at_the_end_of_its_block_or_of_the_text() {
		assert_eq!(
			found("@layer a { @layer b }\n"),
			[(vec![], names(&["a"])), (vec![], names(&["a", "b"]))],
			"a statement that the `}}` of its block ends"
		);
		assert_eq!(
			found("@layer a { @layer b;"),
			[(vec![], names(&["a"])), (vec![], names(&["a", "b"]))],
			"the last statement of a block the text ends in"
		);
		assert_eq!(
			found("@media print { @layer y;"),
			[(vec![(Some("print".to_owned()), None)], names(&["y"]))],
			"a statement in a media block the text ends in"
		);
	}

	#[test]
	fn a_layer_is_declared_when_two_conditions_hold_and_a_third_does_not() {
		let dir = Dir::new("declare-two-conditions");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "@layer y;\n");
		dir.write("c.css", "c{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'c.css' layer(x) print;\n@import 'a.css' layer(x) (min-width: 1px);\n@import 'b.css' (min-width: 2px);\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// At 2px wide and not in print, only the second import declares `x`
		// before `y`.
		assert!(
			bundle.css.starts_with(
				"@media print {\n@layer x;\n}\n@media (min-width: 1px) {\n@layer x;\n}\n@media (min-width: 2px) {\n@layer y;\n}\n@media print {\n@layer x {\n"
			),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_in_front_of_a_remote_import_in_its_parent_layer_is_declared() {
		let dir = Dir::new("declare-before-remote-in-layer");
		dir.write("g.css", "g{b:c}\n");
		dir.write(
			"f.css",
			"@import 'g.css' layer(x);\n@import url(https://example.com/r.css);\nf{b:c}\n",
		);
		let entry = dir.write("main.css", "@import 'f.css' layer(a);\nx{y:z}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// The remote sheet is in `a` and may declare `a.y` before `a.x`.
		assert!(
			bundle.css.starts_with(
				"@layer a.x;\n@import url(https://example.com/r.css) layer(a);\n@layer a {\n"
			),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_in_front_of_a_conditional_remote_import_is_declared() {
		let dir = Dir::new("declare-before-conditional-remote");
		dir.write("a.css", "a{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import url(https://example.com/r.css) print;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// In print the remote sheet may declare layers before `one`.
		assert!(
			bundle.css.starts_with(
				"@layer one;\n@import url(https://example.com/r.css) print;\n@layer one {\n"
			),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_declared_already_is_not_declared_again_under_a_condition() {
		let dir = Dir::new("declare-once-conditional");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		dir.write("c.css", "c{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import 'b.css' layer(one) screen;\n@import 'c.css' layer(two);\n@layer two, one;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// The first import declares `one`; the one under `screen` does not
		// declare it first.
		assert!(
			bundle
				.css
				.starts_with("@layer one;\n@layer two, one;\n@layer one {\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn the_layer_of_an_empty_file_is_declared_where_nothing_after_names_it() {
		let dir = Dir::new("declare-empty-last");
		dir.write("a.css", "a{b:c}\n");
		dir.write("e.css", "\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(x);\n@import 'e.css' layer(one);\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// The body has no block for `one`: the statement is what declares it, and
		// `x` has to come before it.
		assert!(
			bundle
				.css
				.starts_with("@layer x;\n@layer one;\n@layer x {\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_layer_block_written_in_capitals_in_a_body_counts() {
		let dir = Dir::new("declare-body-capitals");
		dir.write("a.css", "@LAYER z {\na{b:c}\n}\n");
		let entry = dir.write("main.css", "@import 'a.css';\n@layer w, z;\nx{y:z}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		assert!(
			bundle.css.starts_with("@layer z;\n@layer w, z;\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn the_layers_in_a_file_imported_into_an_anonymous_layer_are_not_declared() {
		let dir = Dir::new("declare-body-anonymous");
		dir.write("a.css", "@layer z {\na{b:c}\n}\n");
		let entry = dir.write("main.css", "@import 'a.css' layer;\n@layer w, z;\nx{y:z}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// The `z` of the file is inside the anonymous layer, which has no name
		// to write.
		assert!(
			bundle.css.starts_with("@layer w, z;\n@layer {\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
	}

	#[test]
	fn a_remote_import_under_a_condition_in_a_layer_declares_nothing_where_it_does_not_hold() {
		let dir = Dir::new("declare-conditional-remote-in-layer");
		dir.write(
			"r.css",
			"@import url(https://example.com/r.css) print;\nf{b:c}\n",
		);
		dir.write("b.css", "b{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'r.css' layer(a);\n@import 'b.css' layer(b);\n@layer b, a;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// Out of print the remote import declares nothing, and the statement
		// would declare `b` first: `a` has to be declared in front of it.
		let a = bundle.css.find("@layer a;\n");
		let order = bundle.css.find("@layer b, a;\n");
		assert!(a.is_some() && a < order, "{}", bundle.css);
	}

	#[test]
	fn a_name_that_is_not_an_identifier_declares_nothing() {
		assert!(is_layer_ident("a-b_c"));
		assert!(is_layer_ident("名前"));
		assert!(!is_layer_ident("1a"));
		assert!(!is_layer_ident("b a"));
		assert!(!is_layer_ident(""));
		assert_eq!(
			body_layers("@layer y x {}\n@layer a .b;\n@media print { @layer b a{c:d} }\n"),
			Vec::<(Chain, Vec<String>)>::new()
		);
	}

	#[test]
	fn the_parentheses_around_a_whole_condition_are_left_out() {
		assert_eq!(unwrap_parens("(display: grid)"), "display: grid");
		assert_eq!(unwrap_parens("((a) or (b))"), "(a) or (b)");
		assert_eq!(unwrap_parens("(a) and (b)"), "(a) and (b)");
		assert_eq!(unwrap_parens("not (a)"), "not (a)");
	}

	#[test]
	fn a_supports_block_in_a_body_is_the_same_condition_as_supports_of_an_import() {
		let dir = Dir::new("declare-body-supports");
		dir.write(
			"a.css",
			"@supports (display: grid) {\n@layer z {\na{b:c}\n}\n}\n",
		);
		let entry = dir.write(
			"main.css",
			"@import 'a.css' supports(display: grid);\n@layer w, z;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		assert!(
			bundle.css.starts_with(
				"@supports (display: grid) {\n@supports (display: grid) {\n@layer z;\n}\n}\n@layer w, z;\n"
			),
			"{}",
			bundle.css
		);
	}

	#[test]
	fn conditions_nest_in_the_conditions_they_start_with() {
		assert!(nests_in("A;B;C", "A"));
		assert!(nests_in("A;B;C", "A;B"));
		assert!(nests_in("A", "A"));
		assert!(!nests_in("A;B", "A;BC"));
		assert!(!nests_in("AB", "A"));
		assert!(!nests_in("A", "A;B"));
	}

	#[test]
	fn a_layer_under_three_nested_conditions_is_decided_with_all_of_them() {
		let dir = Dir::new("declare-three-conditions");
		dir.write("a.css", "a{b:c}\n");
		dir.write("y.css", "@layer y;\n");
		dir.write(
			"mid.css",
			"@import 'a.css' layer(x) (min-width: 3px);\n@import 'y.css' (min-width: 4px);\n",
		);
		dir.write("outer.css", "@import 'mid.css' (min-width: 2px);\n");
		let entry = dir.write(
			"main.css",
			"@import 'outer.css' (min-width: 1px);\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// Where all four hold, `x` is declared before `y`, as in the source.
		let x = bundle.css.find("@layer x;\n");
		let y = bundle.css.find("@layer y;\n");
		assert!(x.is_some() && x < y, "{}", bundle.css);
	}

	#[test]
	fn the_same_remote_import_twice_counts_once() {
		let dir = Dir::new("declare-remote-twice");
		dir.write("a.css", "a{b:c}\n");
		dir.write(
			"main.css",
			"@import url(https://example.com/x.css);\n@import 'a.css' layer(a);\n@import url(https://example.com/x.css);\nx{y:z}\n",
		);
		// The second import is not written, so nothing comes between the first
		// and the body that declares `a`.
		assert_eq!(
			css(&dir, "main.css", &[]),
			"@import url(https://example.com/x.css);\n@layer a {\na{b:c}\n}\n\nx{y:z}\n"
		);
	}

	#[test]
	fn a_layer_of_a_body_under_a_media_query_is_declared_under_it() {
		let dir = Dir::new("declare-body-media");
		dir.write("a.css", "@media print {\n@layer z {\na{b:c}\n}\n}\n");
		let entry = dir.write("main.css", "@import 'a.css';\n@layer w, z;\nx{y:z}\n");
		let bundle = bundle(&entry, &[]).unwrap();
		// In print, the source declares `z` before `w`.
		assert!(
			bundle
				.css
				.starts_with("@media print {\n@layer z;\n}\n@layer w, z;\n"),
			"{}",
			bundle.css
		);
	}

	#[test]
	fn a_layer_in_front_of_a_remote_import_without_a_layer_is_declared() {
		let dir = Dir::new("declare-before-remote");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'b.css' layer(b);\n@import url(https://example.com/x.css);\n@import 'a.css' layer(a);\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// The remote sheet may declare layers of its own (`@layer a, b;`): `b`
		// has to be declared before it, as the source does.
		assert!(
			bundle
				.css
				.starts_with("@layer b;\n@import url(https://example.com/x.css);\n@layer b {\n"),
			"{}",
			bundle.css
		);
	}

	#[test]
	fn layers_under_many_conditions_that_the_body_declares_in_order_are_not_declared() {
		let dir = Dir::new("declare-many-conditions");
		dir.write("a.css", "a{b:c}\n");
		let imports: String = (1..=9)
			.map(|n| format!("@import 'a.css' layer(l{n}) (min-width: {n}px);\n"))
			.collect();
		let entry = dir.write("main.css", &format!("{imports}x{{y:z}}\n"));
		let bundle = bundle(&entry, &[]).unwrap();
		// Nothing comes in front of the body, which declares them in order.
		assert!(
			bundle
				.css
				.starts_with("@media (min-width: 1px) {\n@layer l1 {\n"),
			"{}",
			bundle.css
		);
	}

	#[test]
	fn a_layer_that_the_next_statement_declares_is_declared_when_another_comes_in_between() {
		let dir = Dir::new("declare-between");
		dir.write("a.css", "a{b:c}\n");
		dir.write("b.css", "b{b:c}\n");
		dir.write("c.css", "c{b:c}\n");
		let entry = dir.write(
			"main.css",
			"@import 'a.css' layer(one);\n@import 'b.css' layer(two);\n@import 'c.css' layer(three);\n@layer one, three;\nx{y:z}\n",
		);
		let bundle = bundle(&entry, &[]).unwrap();
		// `two` has to be declared before the statement declares `three`, and
		// `one` before `two`.
		assert!(
			bundle
				.css
				.starts_with("@layer one;\n@layer two;\n@layer one, three;\n"),
			"{}",
			bundle.css
		);
		every_segment_is_a_copy(&bundle);
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
