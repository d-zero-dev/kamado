//! `@import` bundling for stylesheets, with the semantics of postcss-import
//! as v2 used it.
//!
//! Only imports in the preamble of a file (before the first rule, after
//! `@charset` and empty `@layer` statements) are inlined; the statement is
//! replaced by the file's content, wrapped in `@layer` / `@supports` /
//! `@media` when the import names a condition. Remote imports (`http:`,
//! `https:`, `//`, `data:`) stay as they are.
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
}

/// An `@import` statement in the preamble of a file.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Import {
	/// Byte range of the whole statement, `@import ...;`.
	start: usize,
	end: usize,
	uri: String,
	layer: Option<String>,
	supports: Option<String>,
	media: Option<String>,
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
	/// Remote `@import`s in the order met; they go to the top of the bundle.
	remote: Vec<Remote>,
}

/// A remote `@import` statement and where it was written.
struct Remote {
	statement: String,
	file: usize,
	src: usize,
}

/// The text of one file after its imports were inlined, and where its runs
/// came from.
struct Piece {
	text: String,
	segments: Vec<Segment>,
}

/// Inlines the imports of `entry`.
///
/// # Errors
///
/// A message naming the file when a file cannot be read or an import cannot
/// be resolved.
///
/// # Example
///
/// ```no_run
/// let bundle = kd_core::style_import::bundle("/site/src/css/main.css", &[]).unwrap();
/// println!("{} bytes from {} files", bundle.css.len(), bundle.deps.len());
/// ```
pub fn bundle(entry: &str, alias: &[(String, String)]) -> Result<Bundle, String> {
	let mut ctx = Context {
		alias,
		deps: BTreeMap::new(),
		files: Vec::new(),
		stack: Vec::new(),
		done: BTreeSet::new(),
		remote: Vec::new(),
	};
	let mut piece = inline_file(&mut ctx, entry, true)?;
	hoist_remote(&mut piece, &ctx.remote);
	Ok(Bundle {
		css: piece.text,
		deps: ctx.deps,
		files: ctx.files,
		segments: piece.segments,
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

fn inline_file(ctx: &mut Context<'_>, path: &str, is_entry: bool) -> Result<Piece, String> {
	let (index, text) = read(ctx, path)?;
	ctx.stack.push(path.to_owned());
	let result = inline_text(ctx, path, index, &text, is_entry);
	ctx.stack.pop();
	result
}

fn inline_text(
	ctx: &mut Context<'_>,
	path: &str,
	index: usize,
	text: &str,
	is_entry: bool,
) -> Result<Piece, String> {
	let imports = scan_imports(text);
	let mut out = String::with_capacity(text.len());
	let mut segments = Vec::new();
	let copy = |out: &mut String, segments: &mut Vec<Segment>, from: usize, to: usize| {
		if to > from {
			segments.push(Segment {
				out: out.len(),
				len: to - from,
				file: index,
				src: from,
			});
			out.push_str(&text[from..to]);
		}
	};
	let mut last = 0;
	for import in &imports {
		copy(&mut out, &mut segments, last, import.start);
		last = import.end;
		if is_remote(&import.uri) {
			// An `@import` after a rule is ignored by the browser, so a remote
			// one met in an inlined file would stop working: it is hoisted.
			let statement = text[import.start..import.end].trim().to_owned();
			if !ctx.remote.iter().any(|r| r.statement == statement) {
				let lead = text[import.start..import.end].len()
					- text[import.start..import.end].trim_start().len();
				ctx.remote.push(Remote {
					statement,
					file: index,
					src: import.start + lead,
				});
			}
			// The line break after it goes with it.
			let after = &text[import.end..];
			last += after.len() - after.trim_start_matches(['\n', '\r']).len();
			continue;
		}
		let target = resolve(ctx, path, &import.uri)?;
		if ctx.stack.contains(&target) {
			continue;
		}
		let key = (
			target.clone(),
			format!(
				"{:?}|{:?}|{:?}",
				import.layer, import.supports, import.media
			),
		);
		if !ctx.done.insert(key) {
			continue;
		}
		let inner = inline_file(ctx, &target, false)?;
		let (wrapped, prefix, kept) = wrap(import, &inner.text);
		let base = out.len() + prefix;
		for seg in inner.segments {
			if seg.out < kept {
				segments.push(Segment {
					out: base + seg.out,
					len: seg.len.min(kept - seg.out),
					..seg
				});
			}
		}
		out.push_str(&wrapped);
	}
	copy(&mut out, &mut segments, last, text.len());
	if !is_entry {
		strip_charset(&mut out, &mut segments);
	}
	Ok(Piece {
		text: out,
		segments,
	})
}

/// The content of an imported file inside the at-rules its import names,
/// outermost first: `@media`, `@supports`, `@layer` (the nesting postcss-import
/// writes: a media condition that is false must also hide the layer). Returns the text, the
/// length of what is put before the content and the length of the content
/// that is kept (it loses trailing white space).
fn wrap(import: &Import, content: &str) -> (String, usize, usize) {
	let kept = content.trim_end();
	let mut prefix = String::new();
	let mut wrappers = 0;
	if let Some(media) = &import.media {
		prefix.push_str(&format!("@media {media} {{\n"));
		wrappers += 1;
	}
	if let Some(supports) = &import.supports {
		// `supports(display: grid)` names a condition; the at-rule needs it in
		// parentheses (`supports(not (x))` becomes `(not (x))`).
		prefix.push_str(&format!("@supports ({supports}) {{\n"));
		wrappers += 1;
	}
	if let Some(layer) = &import.layer {
		prefix.push_str(&if layer.is_empty() {
			"@layer {\n".to_owned()
		} else {
			format!("@layer {layer} {{\n")
		});
		wrappers += 1;
	}
	let text = format!("{prefix}{kept}\n{}", "}\n".repeat(wrappers));
	(text, prefix.len(), kept.len())
}

/// A `@charset` of an imported file is dropped: only the entry's counts. The
/// segments follow the text.
fn strip_charset(text: &mut String, segments: &mut Vec<Segment>) {
	if let Some((from, to)) = charset_range(text) {
		splice(text, segments, from, to, "");
	}
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

/// Puts the remote imports first, after a `@charset`.
fn hoist_remote(piece: &mut Piece, remote: &[Remote]) {
	if remote.is_empty() {
		return;
	}
	let at = charset_range(&piece.text).map_or(0, |(_, to)| to);
	let mut block = String::new();
	let mut hoisted = Vec::with_capacity(remote.len());
	for r in remote {
		hoisted.push(Segment {
			out: at + block.len(),
			len: r.statement.len(),
			file: r.file,
			src: r.src,
		});
		block.push_str(&r.statement);
		block.push('\n');
	}
	splice(&mut piece.text, &mut piece.segments, at, at, &block);
	// The statements are runs of their files like any other, in order.
	let position = piece.segments.partition_point(|s| s.out < at + block.len());
	piece.segments.splice(position..position, hoisted);
}

/// Replaces `from..to` of `text` with `with` and moves the segments along:
/// what is replaced is covered by none, and a segment that overlaps it is cut.
fn splice(text: &mut String, segments: &mut Vec<Segment>, from: usize, to: usize, with: &str) {
	text.replace_range(from..to, with);
	let removed = to - from;
	let added = with.len();
	let mut kept = Vec::with_capacity(segments.len());
	for seg in segments.drain(..) {
		let (start, stop) = (seg.out, seg.out + seg.len);
		if stop <= from {
			kept.push(seg);
		} else if start >= to {
			kept.push(Segment {
				out: start - removed + added,
				..seg
			});
		} else {
			// The segment overlaps the removed range: keep what is left of
			// each side.
			if start < from {
				kept.push(Segment {
					len: from - start,
					..seg
				});
			}
			if stop > to {
				kept.push(Segment {
					out: from + added,
					len: stop - to,
					src: seg.src + (to - start),
					..seg
				});
			}
		}
	}
	*segments = kept;
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

/// The imports of the preamble of a stylesheet.
fn scan_imports(text: &str) -> Vec<Import> {
	let bytes = text.as_bytes();
	let mut imports = Vec::new();
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
					("charset", b';') | ("layer", b';') => i = prelude_end + 1,
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
	imports
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
		let uris: Vec<(String, Option<String>)> = scan_imports(text)
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
		assert_eq!(
			css(&dir, "main.css", &[]),
			"\nb{}\n\na{}\n\n\n@media print {\n\na{}\n}\n\nmain{}\n"
		);
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
		// The line break after the hoisted remote import is one more.
		assert_eq!(bundle.css.len() - covered, 16 + 2 + 1 + 1 + 1);
		assert!(bundle.segments.iter().any(|s| s.file == 1));
		assert!(bundle.segments.iter().any(|s| s.file == 2));
	}

	#[test]
	fn an_import_that_cannot_be_found_names_the_file_and_the_specifier() {
		let dir = Dir::new("missing");
		let entry = dir.write("main.css", "@import './nope.css';\n");
		let e = bundle(&entry, &[]).unwrap_err();
		assert_eq!(e, format!("{entry}: cannot resolve @import \"./nope.css\""));
	}
}
