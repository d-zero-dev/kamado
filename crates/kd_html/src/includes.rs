//! `html.includes`: pulling other files into a page while it is a tree.
//!
//! Four forms share one engine: a *site* (a node of the page naming a file),
//! a path resolution rule per form, a containment check, a read through the
//! caller's [`Reader`] (which is where the build records the file as a
//! dependency), an optional `pick` (the part of the file to use) and a
//! replacement. Included content is searched for further sites, so includes
//! nest; a cycle or a nesting deeper than [`MAX_DEPTH`] is an error.
//!
//! - **ssi** — `<!--#include virtual="/p.html" -->`. The path is relative to
//!   the output directory (or, with `dir`, to a server document root that is
//!   mapped onto it): the files an SSI server would see are the built site.
//! - **includeComment** — `<!-- @include(PATH) -->`. `<documentRoot>/x` is
//!   relative to the input directory, `/x` to `root`, anything else to the
//!   including file.
//! - **burgerEditorImport** — every `bge-import[src]` inside a
//!   `[data-bge-container]` is replaced, together with that container, by the
//!   `[data-bge-container]` of the file `src` names. `src` must start with `/`
//!   and is relative to `root`.
//! - **selector** — a configured selector, the attribute that holds the
//!   path, the `root`, an optional `pick` selector and whether the match or
//!   its children are replaced.
//!
//! A path that leaves its root (`..` that climbs out, or a different absolute
//! path) is an error, never a read: the includes are the one place a page
//! author's text turns into a file read.

use crate::dom::{Document, NodeId, NodeKind, ROOT};
use crate::parser::parse;
use crate::selector::Selector;

/// How deep includes may nest: a page may include a file that includes a file
/// ... [`MAX_DEPTH`] times, and not one more.
pub const MAX_DEPTH: usize = 16;

/// How many includes one page may expand in total. Nesting and cycle checks
/// do not bound a file that includes the next one ten times over (ten to the
/// power of the depth), so the total is bounded too.
pub const MAX_EXPANSIONS: usize = 10_000;

/// Reads files for the includes. The build implements this to record every
/// file it is asked for, including the ones that do not exist.
pub trait Reader {
	/// The text of `path`, or why it could not be read.
	///
	/// # Errors
	///
	/// A message describing the failure (typically "No such file").
	fn read(&self, path: &str) -> Result<String, String>;
}

/// An include that failed in a way that stops the build.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IncludeError(pub String);

impl std::fmt::Display for IncludeError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

impl std::error::Error for IncludeError {}

/// What to do when an included file cannot be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OnMissing {
	/// Fail the page.
	Error,
	/// Replace the include by nothing and report a warning.
	Warn,
	/// Replace the include by nothing.
	Silent,
}

/// What replaces the matched node of a `selector` include.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Replace {
	/// The matched element is replaced by the picked content.
	Element,
	/// The matched element stays; its children are replaced.
	Children,
}

/// One include rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Include {
	Ssi {
		/// A server document root mapped onto the output directory.
		dir: Option<String>,
	},
	IncludeComment {
		root: String,
	},
	BurgerEditorImport {
		root: String,
	},
	Selector {
		selector: Selector,
		attr: String,
		root: String,
		pick: Option<Selector>,
		replace: Replace,
	},
}

/// The directories and the reader an include run works with.
pub struct Env<'a> {
	pub input_dir: &'a str,
	pub output_dir: &'a str,
	/// The input file of the page being processed.
	pub page_file: &'a str,
	pub reader: &'a dyn Reader,
	pub on_missing: OnMissing,
}

/// What an include run reports besides changing the page.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Report {
	/// Messages for includes that were skipped under [`OnMissing::Warn`].
	pub warnings: Vec<String>,
	/// How many includes were read and expanded (nested ones included).
	pub expansions: usize,
}

// ----- paths (POSIX strings) -----

fn normalize(path: &str) -> String {
	let mut parts: Vec<&str> = Vec::new();
	for segment in path.split('/') {
		match segment {
			"" | "." => {}
			".." => {
				parts.pop();
			}
			s => parts.push(s),
		}
	}
	format!("/{}", parts.join("/"))
}

fn dirname(path: &str) -> &str {
	match path.rfind('/') {
		Some(0) | None => "/",
		Some(i) => &path[..i],
	}
}

fn within(path: &str, root: &str) -> bool {
	let root = normalize(root);
	path == root || path.starts_with(&format!("{}/", root.trim_end_matches('/')))
}

/// Joins `relative` onto `base` (both absolute/normalized) refusing anything
/// that ends up outside `root`.
fn confine(base: &str, relative: &str, roots: &[&str], what: &str) -> Result<String, IncludeError> {
	// Containment is judged on `/`-separated text. A backslash would be a
	// separator to a reader on another platform, and NUL ends a path in C APIs:
	// either could make the path the reader opens differ from the one judged.
	if relative.contains(['\\', '\0']) {
		return Err(IncludeError(format!(
			"the include path `{what}` contains a backslash or NUL"
		)));
	}
	let joined = if relative.starts_with('/') {
		normalize(relative)
	} else {
		normalize(&format!("{base}/{relative}"))
	};
	// `normalize` clamps `..` at the filesystem root exactly as the OS does, so
	// the containment check on the result is the whole check.
	if !roots.iter().any(|r| within(&joined, r)) {
		return Err(IncludeError(format!(
			"the include path `{what}` leaves its root directory"
		)));
	}
	Ok(joined)
}

// ----- sites -----

struct Site {
	node: NodeId,
	path: String,
	/// Which node the replacement takes the place of.
	target: NodeId,
	rule: usize,
}

fn comment_text(doc: &Document, node: NodeId) -> Option<&str> {
	match doc.kind(node) {
		NodeKind::Comment(c) => Some(c.as_str()),
		_ => None,
	}
}

/// `#include virtual="PATH"` (the comment's data), whitespace tolerant.
fn ssi_path(data: &str) -> Option<String> {
	let rest = data.trim_start().strip_prefix("#include")?;
	if !rest.starts_with(char::is_whitespace) {
		return None;
	}
	let rest = rest.trim_start().strip_prefix("virtual=\"")?;
	let end = rest.find('"')?;
	if end == 0 || !rest[end + 1..].trim().is_empty() {
		return None;
	}
	Some(rest[..end].to_owned())
}

/// `@include(PATH)` (the comment's data), whitespace tolerant.
fn include_comment_path(data: &str) -> Option<String> {
	let rest = data.trim().strip_prefix("@include(")?;
	let inner = rest.strip_suffix(')')?.trim();
	let inner = inner
		.strip_prefix('"')
		.and_then(|s| s.strip_suffix('"'))
		.or_else(|| inner.strip_prefix('\'').and_then(|s| s.strip_suffix('\'')))
		.unwrap_or(inner);
	(!inner.is_empty()).then(|| inner.to_owned())
}

fn all_nodes(doc: &Document, scope: NodeId) -> Vec<NodeId> {
	let mut out = Vec::new();
	let mut stack: Vec<NodeId> = doc.children(scope).collect();
	stack.reverse();
	while let Some(n) = stack.pop() {
		out.push(n);
		let mut children: Vec<NodeId> = doc.children(n).collect();
		children.reverse();
		stack.extend(children);
	}
	out
}

fn closest(doc: &Document, node: NodeId, selector: &Selector) -> Option<NodeId> {
	let mut cursor = doc.parent(node);
	while let Some(n) = cursor {
		if selector.matches(doc, n) {
			return Some(n);
		}
		cursor = doc.parent(n);
	}
	None
}

fn find_sites(doc: &Document, scope: NodeId, rules: &[Include], bge: &BgeSelectors) -> Vec<Site> {
	let mut sites = Vec::new();
	for node in all_nodes(doc, scope) {
		for (index, rule) in rules.iter().enumerate() {
			match rule {
				Include::Ssi { .. } => {
					if let Some(path) = comment_text(doc, node).and_then(ssi_path) {
						sites.push(Site {
							node,
							path,
							target: node,
							rule: index,
						});
					}
				}
				Include::IncludeComment { .. } => {
					if let Some(path) = comment_text(doc, node).and_then(include_comment_path) {
						sites.push(Site {
							node,
							path,
							target: node,
							rule: index,
						});
					}
				}
				Include::BurgerEditorImport { .. } => {
					if bge.import.matches(doc, node)
						&& let Some(src) = doc
							.element(node)
							.and_then(|e| e.attr("src"))
							.map(str::to_owned)
						&& let Some(container) = closest(doc, node, &bge.container)
					{
						sites.push(Site {
							node,
							path: src,
							target: container,
							rule: index,
						});
					}
				}
				Include::Selector { selector, attr, .. } => {
					if selector.matches(doc, node)
						&& let Some(path) = doc
							.element(node)
							.and_then(|e| e.attr(attr))
							.map(str::to_owned)
					{
						sites.push(Site {
							node,
							path,
							target: node,
							rule: index,
						});
					}
				}
			}
		}
	}
	sites
}

struct BgeSelectors {
	container: Selector,
	import: Selector,
	picked: Selector,
}

fn bge_selectors() -> BgeSelectors {
	// Constant, valid selectors: a failure here is a bug in this file.
	BgeSelectors {
		container: Selector::parse("[data-bge-container]").expect("valid selector"),
		import: Selector::parse("[data-bge-container] [data-bgi=import] bge-import")
			.expect("valid selector"),
		picked: Selector::parse("[data-bge-container]").expect("valid selector"),
	}
}

// ----- resolving and replacing -----

fn resolve(
	rule: &Include,
	site: &Site,
	env: &Env<'_>,
	current_file: &str,
) -> Result<String, IncludeError> {
	let input = normalize(env.input_dir);
	let output = normalize(env.output_dir);
	match rule {
		Include::Ssi { dir } => {
			let relative = match dir {
				Some(dir) => {
					let dir = normalize(dir);
					let virtual_path = normalize(&site.path);
					if !within(&virtual_path, &dir) {
						return Err(IncludeError(format!(
							"the include path `{}` is outside the document root `{dir}`",
							site.path
						)));
					}
					virtual_path[dir.trim_end_matches('/').len()..]
						.trim_start_matches('/')
						.to_owned()
				}
				None => site.path.trim_start_matches('/').to_owned(),
			};
			confine(&output, &relative, &[&output], &site.path)
		}
		Include::IncludeComment { root } => {
			let root = normalize(root);
			let path = &site.path;
			if let Some(rest) = path.strip_prefix("<documentRoot>/") {
				confine(&input, rest, &[&input, &root], path)
			} else if let Some(rest) = path.strip_prefix('/') {
				confine(&root, rest, &[&root, &input], path)
			} else {
				confine(dirname(current_file), path, &[&root, &input], path)
			}
		}
		Include::BurgerEditorImport { root } => {
			let root = normalize(root);
			let Some(rest) = site.path.strip_prefix('/') else {
				return Err(IncludeError(format!(
					"the bge-import src `{}` must start with `/`",
					site.path
				)));
			};
			confine(&root, rest, &[&root], &site.path)
		}
		Include::Selector { root, .. } => {
			let root = normalize(root);
			let path = &site.path;
			match path.strip_prefix('/') {
				Some(rest) => confine(&root, rest, &[&root], path),
				None => confine(dirname(current_file), path, &[&root], path),
			}
		}
	}
}

/// Detaches `target`'s replacement nodes from `source` into `doc`.
fn picked_nodes(
	doc: &mut Document,
	source: &Document,
	pick: Option<&Selector>,
	whole_element: bool,
) -> Result<Vec<NodeId>, IncludeError> {
	let (origin, take_children) = match pick {
		None => (ROOT, true),
		Some(selector) => match selector.select_first(source) {
			Some(n) => (n, !whole_element),
			None => return Ok(Vec::new()),
		},
	};
	let nodes: Vec<NodeId> = if take_children {
		source.children(origin).collect()
	} else {
		vec![origin]
	};
	Ok(nodes
		.into_iter()
		.map(|n| doc.import_subtree(source, n))
		.collect())
}

/// Every `[data-bge-container]` of the imported file, in document order (v2
/// took all of them, not the first). One inside another stays in the outer one.
fn burger_nodes(doc: &mut Document, source: &Document, picked: &Selector) -> Vec<NodeId> {
	let all = picked.select_all(source);
	let mut taken: Vec<NodeId> = Vec::new();
	for &n in &all {
		let mut up = source.parent(n);
		let mut inside = false;
		while let Some(p) = up {
			if taken.contains(&p) {
				inside = true;
				break;
			}
			up = source.parent(p);
		}
		if !inside {
			taken.push(n);
		}
	}
	taken
		.into_iter()
		.map(|n| doc.import_subtree(source, n))
		.collect()
}

fn splice(doc: &mut Document, at: NodeId, nodes: &[NodeId]) {
	for &n in nodes {
		doc.insert_before(at, n);
	}
	doc.detach(at);
}

#[allow(clippy::too_many_arguments)]
fn expand(
	doc: &mut Document,
	scope: NodeId,
	rules: &[Include],
	bge: &BgeSelectors,
	env: &Env<'_>,
	current_file: &str,
	stack: &mut Vec<String>,
	report: &mut Report,
) -> Result<(), IncludeError> {
	// The stack holds the page itself as well as the files being expanded.
	if stack.len() > MAX_DEPTH + 1 {
		return Err(IncludeError(format!(
			"includes are nested more than {MAX_DEPTH} levels deep: {}",
			stack.join(" -> ")
		)));
	}
	for site in find_sites(doc, scope, rules, bge) {
		// A site that an earlier one removed (it sat inside an element that was
		// replaced, or inside the container being swapped) is no longer part of
		// what is being expanded: reading its file would be pointless, and
		// would fail the page for a file nothing refers to any more.
		if !attached(doc, site.node, scope) || !attached(doc, site.target, scope) {
			continue;
		}
		report.expansions += 1;
		if report.expansions > MAX_EXPANSIONS {
			return Err(IncludeError(format!(
				"a page may expand at most {MAX_EXPANSIONS} includes"
			)));
		}
		let rule = &rules[site.rule];
		let path = resolve(rule, &site, env, current_file)?;
		if stack.contains(&path) {
			return Err(IncludeError(format!(
				"the include `{path}` includes itself: {} -> {path}",
				stack.join(" -> ")
			)));
		}
		let text = match env.reader.read(&path) {
			Ok(t) => t,
			Err(message) => match env.on_missing {
				OnMissing::Error => {
					return Err(IncludeError(format!(
						"cannot include `{}`: {message}",
						site.path
					)));
				}
				OnMissing::Warn => {
					report
						.warnings
						.push(format!("cannot include `{}`: {message}", site.path));
					remove_site(doc, rule, &site);
					continue;
				}
				OnMissing::Silent => {
					remove_site(doc, rule, &site);
					continue;
				}
			},
		};
		let source = parse(&text);
		let nodes = match rule {
			Include::BurgerEditorImport { .. } => burger_nodes(doc, &source, &bge.picked),
			Include::Selector { pick, replace, .. } => {
				picked_nodes(doc, &source, pick.as_ref(), *replace == Replace::Element)?
			}
			_ => picked_nodes(doc, &source, None, false)?,
		};
		// Expand inside the new nodes before they are placed, so the file
		// they came from is the base for their relative paths.
		let holder = doc.create_element("template");
		for &n in &nodes {
			doc.append_child(holder, n);
		}
		stack.push(path.clone());
		let nested = expand(doc, holder, rules, bge, env, &path, stack, report);
		stack.pop();
		nested?;
		let nodes: Vec<NodeId> = doc.children(holder).collect();
		match rule {
			Include::Selector {
				replace: Replace::Children,
				..
			} => {
				let children: Vec<NodeId> = doc.children(site.node).collect();
				for c in children {
					doc.detach(c);
				}
				for n in nodes {
					doc.append_child(site.node, n);
				}
			}
			_ => splice(doc, site.target, &nodes),
		}
	}
	Ok(())
}

/// Whether `node` is still below `scope`.
fn attached(doc: &Document, node: NodeId, scope: NodeId) -> bool {
	let mut cursor = node;
	while let Some(parent) = doc.parent(cursor) {
		if parent == scope {
			return true;
		}
		cursor = parent;
	}
	false
}

fn remove_site(doc: &mut Document, rule: &Include, site: &Site) {
	match rule {
		Include::BurgerEditorImport { .. } => doc.detach(site.target),
		Include::Selector {
			replace: Replace::Children,
			..
		} => {
			let children: Vec<NodeId> = doc.children(site.node).collect();
			for c in children {
				doc.detach(c);
			}
		}
		_ => doc.detach(site.node),
	}
}

/// Expands every include rule in `doc`.
///
/// # Errors
///
/// An [`IncludeError`] for a path that leaves its root, an unreadable file
/// under [`OnMissing::Error`], a cycle, or nesting that is too deep.
pub fn apply(doc: &mut Document, rules: &[Include], env: &Env<'_>) -> Result<Report, IncludeError> {
	let mut report = Report::default();
	if rules.is_empty() {
		return Ok(report);
	}
	let bge = bge_selectors();
	let mut stack = vec![normalize(env.page_file)];
	expand(
		doc,
		ROOT,
		rules,
		&bge,
		env,
		&normalize(env.page_file),
		&mut stack,
		&mut report,
	)?;
	Ok(report)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::serialize::document_html;
	use std::cell::RefCell;
	use std::collections::BTreeMap;

	struct Files {
		files: BTreeMap<&'static str, &'static str>,
		reads: RefCell<Vec<String>>,
	}

	impl Files {
		fn new(files: &[(&'static str, &'static str)]) -> Files {
			Files {
				files: files.iter().copied().collect(),
				reads: RefCell::new(Vec::new()),
			}
		}
	}

	impl Reader for Files {
		fn read(&self, path: &str) -> Result<String, String> {
			self.reads.borrow_mut().push(path.to_owned());
			self.files
				.get(path)
				.map(|s| (*s).to_owned())
				.ok_or_else(|| "No such file".to_owned())
		}
	}

	fn env<'a>(files: &'a Files, on_missing: OnMissing) -> Env<'a> {
		Env {
			input_dir: "/site/src",
			output_dir: "/site/dist",
			page_file: "/site/src/a/page.html",
			reader: files,
			on_missing,
		}
	}

	fn run(html: &str, rules: &[Include], files: &Files) -> Result<String, IncludeError> {
		let mut doc = parse(html);
		apply(&mut doc, rules, &env(files, OnMissing::Error))?;
		Ok(document_html(&doc))
	}

	#[test]
	fn ssi_reads_from_the_output_directory() {
		let files = Files::new(&[("/site/dist/inc/h.html", "<header>H</header>")]);
		let rules = [Include::Ssi { dir: None }];
		assert_eq!(
			run(
				"<body><!--#include virtual=\"/inc/h.html\" --><main></main></body>",
				&rules,
				&files
			)
			.unwrap(),
			"<body><header>H</header><main></main></body>"
		);
		assert_eq!(files.reads.borrow().as_slice(), ["/site/dist/inc/h.html"]);
	}

	#[test]
	fn ssi_with_a_document_root_maps_the_prefix_away() {
		let files = Files::new(&[("/site/dist/inc/h.html", "H")]);
		let rules = [Include::Ssi {
			dir: Some("/home/www/root/".to_owned()),
		}];
		assert_eq!(
			run(
				"<!--#include virtual=\"/home/www/root/inc/h.html\"-->",
				&rules,
				&files
			)
			.unwrap(),
			"H"
		);
		assert!(
			run(
				"<!--#include virtual=\"/elsewhere/h.html\"-->",
				&rules,
				&files
			)
			.is_err()
		);
	}

	#[test]
	fn ssi_ignores_other_comments_and_malformed_directives() {
		let files = Files::new(&[]);
		let rules = [Include::Ssi { dir: None }];
		let html = "<!-- #include virtual=x --><!--#include file=\"a\"--><!--#includevirtual=\"a\"--><!-- plain -->";
		assert_eq!(run(html, &rules, &files).unwrap(), html);
		assert!(files.reads.borrow().is_empty());
	}

	#[test]
	fn paths_cannot_leave_their_root() {
		let files = Files::new(&[("/site/secret.txt", "S"), ("/site/dist/x.html", "X")]);
		let rules = [Include::Ssi { dir: None }];
		for bad in [
			"../secret.txt",
			"/../secret.txt",
			"a/../../secret.txt",
			"/a/../../secret.txt",
		] {
			let html = format!("<!--#include virtual=\"{bad}\"-->");
			assert!(
				run(&html, &rules, &files).is_err(),
				"`{bad}` must be refused"
			);
		}
		assert!(
			files.reads.borrow().is_empty(),
			"nothing is read for a refused path"
		);
		assert_eq!(
			run("<!--#include virtual=\"/a/../x.html\"-->", &rules, &files).unwrap(),
			"X"
		);
	}

	#[test]
	fn include_comment_resolves_three_kinds_of_paths_and_nests() {
		let files = Files::new(&[
			(
				"/site/src/a/part.html",
				"<p>rel</p><!-- @include(sub/deep.html) -->",
			),
			("/site/src/a/sub/deep.html", "<i>deep</i>"),
			("/site/src/shared/s.html", "<b>doc</b>"),
			("/site/lib/l.html", "<u>root</u>"),
		]);
		let rules = [Include::IncludeComment {
			root: "/site/lib".to_owned(),
		}];
		assert_eq!(
			run("<!-- @include(part.html) --><!-- @include(<documentRoot>/shared/s.html) --><!-- @include(/l.html) -->", &rules, &files).unwrap(),
			"<p>rel</p><i>deep</i><b>doc</b><u>root</u>"
		);
	}

	#[test]
	fn an_included_file_keeps_its_trailing_line_break() {
		// The children of the file are placed as they are: the line break at its end is a
		// text node of its own, next to the one that follows the comment.
		let files = Files::new(&[
			("/site/lib/with.html", "<p>a</p>\n"),
			("/site/lib/without.html", "<p>b</p>"),
		]);
		let rules = [Include::IncludeComment {
			root: "/site/lib".to_owned(),
		}];
		assert_eq!(
			run(
				"<div>\n<!-- @include(/with.html) -->\n<i></i></div>",
				&rules,
				&files
			)
			.unwrap(),
			"<div>\n<p>a</p>\n\n<i></i></div>"
		);
		assert_eq!(
			run(
				"<div>\n<!-- @include(/without.html) -->\n<i></i></div>",
				&rules,
				&files
			)
			.unwrap(),
			"<div>\n<p>b</p>\n<i></i></div>"
		);
	}

	#[test]
	fn included_files_that_include_themselves_fail() {
		let files = Files::new(&[
			("/site/src/a/x.html", "<!-- @include(y.html) -->"),
			("/site/src/a/y.html", "<!-- @include(x.html) -->"),
		]);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		let error = run("<!-- @include(x.html) -->", &rules, &files).unwrap_err();
		assert!(error.0.contains("includes itself"), "{error}");
	}

	#[test]
	fn nesting_depth_is_limited() {
		let mut names: Vec<String> = Vec::new();
		let mut contents: Vec<String> = Vec::new();
		for i in 0..(MAX_DEPTH + 4) {
			names.push(format!("/site/src/a/f{i}.html"));
			contents.push(format!("<!-- @include(f{}.html) -->", i + 1));
		}
		let leaked: Vec<(&'static str, &'static str)> = names
			.iter()
			.zip(contents.iter())
			.map(|(n, c)| {
				(
					&*Box::leak(n.clone().into_boxed_str()),
					&*Box::leak(c.clone().into_boxed_str()),
				)
			})
			.collect();
		let files = Files::new(&leaked);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		let error = run("<!-- @include(f0.html) -->", &rules, &files).unwrap_err();
		assert!(error.0.contains("levels deep"), "{error}");
	}

	#[test]
	fn relative_paths_may_climb_while_they_stay_inside_the_root() {
		let files = Files::new(&[("/site/src/shared/x.html", "<i>x</i>")]);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		assert_eq!(
			run("<!-- @include(../shared/x.html) -->", &rules, &files).unwrap(),
			"<i>x</i>"
		);
		assert!(run("<!-- @include(../../x.html) -->", &rules, &files).is_err());
	}

	#[test]
	fn missing_files_follow_the_policy() {
		let files = Files::new(&[]);
		let rules = [Include::Ssi { dir: None }];
		let html = "<p>a</p><!--#include virtual=\"/nope.html\"--><p>b</p>";
		assert!(run(html, &rules, &files).is_err());
		let mut doc = parse(html);
		let report = apply(&mut doc, &rules, &env(&files, OnMissing::Warn)).unwrap();
		assert_eq!(document_html(&doc), "<p>a</p><p>b</p>");
		assert_eq!(report.warnings.len(), 1);
		let mut doc = parse(html);
		let report = apply(&mut doc, &rules, &env(&files, OnMissing::Silent)).unwrap();
		assert_eq!(document_html(&doc), "<p>a</p><p>b</p>");
		assert!(report.warnings.is_empty());
	}

	#[test]
	fn burger_editor_import_swaps_the_container() {
		let files = Files::new(&[(
			"/site/src/blocks/b.html",
			"<!doctype html><html><body><div data-bge-container=\"1\"><p>from file</p></div></body></html>",
		)]);
		let rules = [Include::BurgerEditorImport {
			root: "/site/src".to_owned(),
		}];
		let html = "<main><div data-bge-container=\"old\"><div data-bgi=\"import\"><bge-import src=\"/blocks/b.html\"></bge-import></div></div><div data-bge-container=\"keep\">k</div></main>";
		assert_eq!(
			run(html, &rules, &files).unwrap(),
			"<main><div data-bge-container=\"1\"><p>from file</p></div><div data-bge-container=\"keep\">k</div></main>"
		);
		let relative = "<div data-bge-container><div data-bgi=\"import\"><bge-import src=\"b.html\"></bge-import></div></div>";
		assert!(run(relative, &rules, &files).is_err());
	}

	#[test]
	fn selector_includes_replace_the_element_or_its_children() {
		let files = Files::new(&[(
			"/site/src/frag.html",
			"<section><h2>t</h2><p>body</p></section>",
		)]);
		let element = [Include::Selector {
			selector: Selector::parse("[data-include]").unwrap(),
			attr: "data-include".to_owned(),
			root: "/site/src".to_owned(),
			pick: Some(Selector::parse("section").unwrap()),
			replace: Replace::Element,
		}];
		assert_eq!(
			run(
				"<div data-include=\"/frag.html\">old</div>",
				&element,
				&files
			)
			.unwrap(),
			"<section><h2>t</h2><p>body</p></section>"
		);
		let children = [Include::Selector {
			selector: Selector::parse("[data-include]").unwrap(),
			attr: "data-include".to_owned(),
			root: "/site/src".to_owned(),
			pick: Some(Selector::parse("section").unwrap()),
			replace: Replace::Children,
		}];
		assert_eq!(
			run(
				"<div data-include=\"/frag.html\" id=\"k\">old</div>",
				&children,
				&files
			)
			.unwrap(),
			"<div data-include=\"/frag.html\" id=\"k\"><h2>t</h2><p>body</p></div>"
		);
	}

	#[test]
	fn a_pick_that_matches_nothing_inserts_nothing() {
		let files = Files::new(&[("/site/src/frag.html", "<p>x</p>")]);
		let rules = [Include::Selector {
			selector: Selector::parse("i[src]").unwrap(),
			attr: "src".to_owned(),
			root: "/site/src".to_owned(),
			pick: Some(Selector::parse("section").unwrap()),
			replace: Replace::Element,
		}];
		assert_eq!(
			run("<b>a</b><i src=\"/frag.html\"></i><b>b</b>", &rules, &files).unwrap(),
			"<b>a</b><b>b</b>"
		);
	}

	#[test]
	fn included_markup_that_is_php_survives() {
		let files = Files::new(&[(
			"/site/dist/p.html",
			"<?php echo $x; ?><p class=\"<?= $c ?>\">x</p>",
		)]);
		let rules = [Include::Ssi { dir: None }];
		assert_eq!(
			run("<!--#include virtual=\"/p.html\"-->", &rules, &files).unwrap(),
			"<?php echo $x; ?><p class=\"<?= $c ?>\">x</p>"
		);
	}

	fn chain(len: usize) -> Files {
		let mut files: Vec<(&'static str, &'static str)> = Vec::new();
		for i in 0..len {
			let path: &'static str = Box::leak(format!("/site/src/a/f{i}.html").into_boxed_str());
			let body: &'static str = if i + 1 == len {
				"<i>leaf</i>"
			} else {
				Box::leak(format!("<!-- @include(f{}.html) -->", i + 1).into_boxed_str())
			};
			files.push((path, body));
		}
		Files::new(&files)
	}

	#[test]
	fn exactly_max_depth_includes_are_allowed_and_one_more_fails() {
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		assert_eq!(
			run("<!-- @include(f0.html) -->", &rules, &chain(MAX_DEPTH)).unwrap(),
			"<i>leaf</i>"
		);
		let error = run("<!-- @include(f0.html) -->", &rules, &chain(MAX_DEPTH + 1)).unwrap_err();
		assert!(error.0.contains("levels deep"), "{error}");
	}

	#[test]
	fn a_file_that_includes_the_next_one_many_times_over_hits_the_total_limit() {
		// Each level includes the next ten times: 10^N expansions without a
		// cycle and within the depth limit, so only the total can stop it.
		let mut files: Vec<(&'static str, &'static str)> = Vec::new();
		for i in 0..8 {
			let path: &'static str = Box::leak(format!("/site/src/a/f{i}.html").into_boxed_str());
			let body: &'static str = if i == 7 {
				"<i></i>"
			} else {
				Box::leak(
					format!("<!-- @include(f{}.html) -->", i + 1)
						.repeat(10)
						.into_boxed_str(),
				)
			};
			files.push((path, body));
		}
		let files = Files::new(&files);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		let error = run("<!-- @include(f0.html) -->", &rules, &files).unwrap_err();
		assert!(error.0.contains("at most"), "{error}");
	}

	#[test]
	fn a_sibling_directory_sharing_the_root_prefix_is_outside() {
		let files = Files::new(&[("/site/srcx/y.html", "E"), ("/site/dist-evil/y.html", "E")]);
		let comment = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		assert!(run("<!-- @include(../../srcx/y.html) -->", &comment, &files).is_err());
		let ssi = [Include::Ssi { dir: None }];
		assert!(
			run(
				"<!--#include virtual=\"../dist-evil/y.html\"-->",
				&ssi,
				&files
			)
			.is_err()
		);
		let ssi_dir = [Include::Ssi {
			dir: Some("/www/root".to_owned()),
		}];
		assert!(
			run(
				"<!--#include virtual=\"/www/root-evil/y.html\"-->",
				&ssi_dir,
				&files
			)
			.is_err()
		);
		assert!(files.reads.borrow().is_empty());
	}

	#[test]
	fn the_page_cannot_include_itself() {
		let files = Files::new(&[("/site/src/a/page.html", "x")]);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		let error = run("<!-- @include(page.html) -->", &rules, &files).unwrap_err();
		assert!(error.0.contains("includes itself"), "{error}");
	}

	#[test]
	fn backslashes_and_nul_are_refused_without_reading() {
		let files = Files::new(&[]);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		for bad in ["..\\..\\x.html", "a\\..\\b.html", "a\0b.html"] {
			let html = format!("<!-- @include({bad}) -->");
			assert!(run(&html, &rules, &files).is_err(), "{bad:?}");
		}
		assert!(files.reads.borrow().is_empty());
	}

	#[test]
	fn the_same_file_may_be_included_twice_as_siblings() {
		let files = Files::new(&[("/site/src/a/x.html", "<i>x</i>")]);
		let rules = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		assert_eq!(
			run(
				"<!-- @include(x.html) --><!-- @include(x.html) -->",
				&rules,
				&files
			)
			.unwrap(),
			"<i>x</i><i>x</i>"
		);
	}

	#[test]
	fn includes_inside_a_replaced_element_are_not_read() {
		let files = Files::new(&[("/site/src/outer.html", "<b>outer</b>")]);
		let rules = [
			Include::Selector {
				selector: Selector::parse("[data-include]").unwrap(),
				attr: "data-include".to_owned(),
				root: "/site/src".to_owned(),
				pick: None,
				replace: Replace::Element,
			},
			Include::IncludeComment {
				root: "/site/src".to_owned(),
			},
		];
		// The comment sits inside the element that the first rule replaces; its
		// file does not exist, and must not be asked for.
		let html = "<div data-include=\"/outer.html\"><!-- @include(/never.html) --></div>";
		assert_eq!(run(html, &rules, &files).unwrap(), "<b>outer</b>");
		assert_eq!(files.reads.borrow().as_slice(), ["/site/src/outer.html"]);
	}

	#[test]
	fn burger_editor_import_takes_every_container_of_the_file() {
		let files = Files::new(&[(
			"/site/src/b.html",
			"<div data-bge-container=\"1\">one</div><div data-bge-container=\"2\">two<div data-bge-container=\"2a\">in</div></div><div data-bge-container=\"3\">three</div>",
		)]);
		let rules = [Include::BurgerEditorImport {
			root: "/site/src".to_owned(),
		}];
		let html = "<main><div data-bge-container=\"old\"><div data-bgi=\"import\"><bge-import src=\"/b.html\"></bge-import></div></div></main>";
		let mut doc = parse(html);
		apply(&mut doc, &rules, &env(&files, OnMissing::Silent)).unwrap();
		assert_eq!(
			document_html(&doc),
			"<main><div data-bge-container=\"1\">one</div><div data-bge-container=\"2\">two<div data-bge-container=\"2a\">in</div></div><div data-bge-container=\"3\">three</div></main>"
		);
	}

	#[test]
	fn burger_editor_missing_imports_remove_the_container() {
		let files = Files::new(&[]);
		let rules = [Include::BurgerEditorImport {
			root: "/site/src".to_owned(),
		}];
		let html = "<main><div data-bge-container><div data-bgi=\"import\"><bge-import src=\"/x.html\"></bge-import></div></div><p>k</p></main>";
		for policy in [OnMissing::Warn, OnMissing::Silent] {
			let mut doc = parse(html);
			apply(&mut doc, &rules, &env(&files, policy)).unwrap();
			assert_eq!(document_html(&doc), "<main><p>k</p></main>");
		}
	}

	#[test]
	fn two_imports_in_one_container_swap_it_once() {
		let files = Files::new(&[
			("/site/src/a.html", "<div data-bge-container=\"A\">a</div>"),
			("/site/src/b.html", "<div data-bge-container=\"B\">b</div>"),
		]);
		let rules = [Include::BurgerEditorImport {
			root: "/site/src".to_owned(),
		}];
		let html = "<div data-bge-container><div data-bgi=\"import\"><bge-import src=\"/a.html\"></bge-import><bge-import src=\"/b.html\"></bge-import></div></div>";
		assert_eq!(
			run(html, &rules, &files).unwrap(),
			"<div data-bge-container=\"A\">a</div>"
		);
		assert_eq!(files.reads.borrow().as_slice(), ["/site/src/a.html"]);
	}

	#[test]
	fn directive_variants() {
		let files = Files::new(&[("/site/dist/a.html", "A")]);
		let ssi = [Include::Ssi { dir: None }];
		assert_eq!(
			run("<!--#include virtual=\"/a.html\"-->", &ssi, &files).unwrap(),
			"A"
		);
		assert_eq!(
			run("<!--  #include\tvirtual=\"/a.html\"  -->", &ssi, &files).unwrap(),
			"A"
		);
		for ignored in [
			"<!--#include virtual=''-->",
			"<!--#include virtual=\"\"-->",
			"<!--#include virtual=\"/a.html\" extra-->",
			"<!--#include virtual='/a.html'-->",
		] {
			assert_eq!(run(ignored, &ssi, &files).unwrap(), ignored, "{ignored}");
		}
		let files = Files::new(&[("/site/src/a/x.html", "X")]);
		let comment = [Include::IncludeComment {
			root: "/site/src".to_owned(),
		}];
		assert_eq!(
			run("<!-- @include( \"x.html\" ) -->", &comment, &files).unwrap(),
			"X"
		);
		assert_eq!(
			run("<!-- @include('x.html') -->", &comment, &files).unwrap(),
			"X"
		);
		for ignored in [
			"<!-- @include() -->",
			"<!-- @include(x.html -->",
			"<!-- @includes(x.html) -->",
		] {
			assert_eq!(
				run(ignored, &comment, &files).unwrap(),
				ignored,
				"{ignored}"
			);
		}
	}
}
