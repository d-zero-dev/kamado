//! Site structure: how input files map to output files and URLs.
//!
//! Paths are POSIX strings (`/` separated). v3 targets macOS and Linux only,
//! so there is no separator translation; absolute paths are expected for
//! directories and the caller (CLI / JS layer) resolves relative ones.
//!
//! The rules are those of kamado v2 and are kept exactly so that output
//! locations stay stable across the rewrite:
//! - the output tree mirrors the input tree with the extension replaced;
//! - a front matter field (`outputPathField`) may override the location with
//!   `/a/b.ext`, `/a/b` (extension appended) or `/a/b/` (`index` appended);
//! - two inputs that produce one output are a conflict, resolved by policy.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::fs;

pub mod meta;
pub mod path;

use path::{basename, dirname, extname, join, normalize, relative};

/// Error raised while resolving an override path or on an output collision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	pub message: String,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.message)
	}
}

impl std::error::Error for Error {}

fn err(message: impl Into<String>) -> Error {
	Error {
		message: message.into(),
	}
}

/// Directories and extension used to derive output locations.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dirs<'a> {
	/// Absolute input directory.
	pub input_dir: &'a str,
	/// Absolute output directory.
	pub output_dir: &'a str,
	/// Output extension including the dot (`.html`), or empty.
	pub output_extension: &'a str,
}

/// Output location derived from an input path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputPathInfo {
	/// Absolute output path.
	pub output_path: String,
	/// File name without extension.
	pub name: String,
	/// Lower-cased input extension including the dot (`.tsx`), or empty.
	pub extension: String,
	/// Directory relative to the input directory (`pages/about`, or empty).
	pub rel_dir: String,
	/// `rel_dir/name`.
	pub root_rel_path: String,
	/// `root_rel_path` with the output extension.
	pub root_rel_path_with_ext: String,
}

/// Mirrors the input tree into the output tree and swaps the extension.
///
/// # Example
///
/// ```
/// let info = kd_site::compute_output_path(
///     "/site/src/pages/about/index.tsx",
///     &kd_site::Dirs { input_dir: "/site/src", output_dir: "/site/htdocs", output_extension: ".html" },
/// );
/// assert_eq!(info.output_path, "/site/htdocs/pages/about/index.html");
/// assert_eq!(info.root_rel_path_with_ext, "pages/about/index.html");
/// ```
#[must_use]
pub fn compute_output_path(input_path: &str, dirs: &Dirs<'_>) -> OutputPathInfo {
	let input_path = normalize(input_path);
	let original_extension = extname(&input_path);
	let extension = original_extension.to_ascii_lowercase();
	let base = basename(&input_path);
	let name = base[..base.len() - original_extension.len()].to_string();
	let dir = dirname(&input_path);
	let rel_dir = relative(&normalize(dirs.input_dir), &dir);
	let root_rel_path = join(&rel_dir, &name);
	let root_rel_path_with_ext = format!("{root_rel_path}{}", dirs.output_extension);
	let output_path = join(&normalize(dirs.output_dir), &root_rel_path_with_ext);
	OutputPathInfo {
		output_path,
		name,
		extension,
		rel_dir,
		root_rel_path,
		root_rel_path_with_ext,
	}
}

/// An override location resolved from a front matter field.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedMetaPath {
	pub output_path: String,
	pub root_rel_path_with_ext: String,
}

/// Resolves an `outputPathField` value.
///
/// Accepted forms: `/foo/bar.html` (as is), `/foo/bar` (extension appended),
/// `/foo/bar/` or `/` (`index<ext>` appended). Rejected: a value that does
/// not start with `/`, `.` or `..` segments, and anything that would land
/// outside the output directory.
///
/// # Example
///
/// ```
/// let r = kd_site::resolve_meta_path("/news/2026/", "/out", ".html").unwrap();
/// assert_eq!(r.output_path, "/out/news/2026/index.html");
/// ```
pub fn resolve_meta_path(
	meta_path: &str,
	output_dir: &str,
	output_extension: &str,
) -> Result<ResolvedMetaPath, Error> {
	if !meta_path.starts_with('/') {
		return Err(err(format!("'path' must start with '/': {meta_path:?}")));
	}
	let stripped = &meta_path[1..];
	let ends_with_slash = stripped.ends_with('/') || stripped.is_empty();
	let segments: Vec<&str> = stripped.split('/').filter(|s| !s.is_empty()).collect();
	if segments.iter().any(|s| *s == "." || *s == "..") {
		return Err(err(format!(
			"'path' must not contain '.' or '..' segments: {meta_path:?}"
		)));
	}
	let root_rel_path_with_ext = if ends_with_slash {
		let mut parts = segments.clone();
		let index = format!("index{output_extension}");
		parts.push(&index);
		parts.join("/")
	} else {
		let last = segments.last().copied().unwrap_or("");
		if extname(last).is_empty() {
			format!("{}{output_extension}", segments.join("/"))
		} else {
			segments.join("/")
		}
	};
	let resolved_output_dir = normalize(output_dir);
	let output_path = join(&resolved_output_dir, &root_rel_path_with_ext);
	// Defense in depth: segment validation above already prevents escapes.
	if output_path != resolved_output_dir
		&& !output_path.starts_with(&format!("{resolved_output_dir}/"))
	{
		return Err(err(format!(
			"'path' resolves outside of the output directory: {meta_path:?}"
		)));
	}
	Ok(ResolvedMetaPath {
		output_path,
		root_rel_path_with_ext,
	})
}

/// A page or asset file as templates see it (v2's `CompilableFile` minus
/// `date`, which the JavaScript layer adds).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageFile {
	pub input_path: String,
	pub output_path: String,
	/// File name without extension; for `index` the parent directory name
	/// (empty for the root `index`).
	pub file_slug: String,
	/// `/`-prefixed output path relative to the output dir, without extension.
	pub file_path_stem: String,
	/// `/`-prefixed URL; a trailing `index.<ext>` is removed.
	pub url: String,
	/// Lower-cased input extension including the dot.
	pub extension: String,
}

/// Builds the file record for an input path using the default mapping.
///
/// # Example
///
/// ```
/// let dirs = kd_site::Dirs { input_dir: "/s", output_dir: "/o", output_extension: ".html" };
/// let f = kd_site::page_file("/s/about/index.tsx", &dirs);
/// assert_eq!(f.url, "/about/");
/// assert_eq!(f.file_slug, "about");
/// assert_eq!(f.file_path_stem, "/about/index");
/// ```
#[must_use]
pub fn page_file(input_path: &str, dirs: &Dirs<'_>) -> PageFile {
	let info = compute_output_path(input_path, dirs);
	let file_slug = if info.name == "index" {
		basename(&dirname(&normalize(input_path))).to_string()
	} else {
		info.name.clone()
	};
	PageFile {
		input_path: normalize(input_path),
		output_path: info.output_path,
		file_slug,
		file_path_stem: format!("/{}", info.root_rel_path),
		url: url_from_root_rel(&info.root_rel_path_with_ext),
		extension: info.extension,
	}
}

/// `pages/index.html` → `/pages/`, `a/b.html` → `/a/b.html`, `index.html` → `/`.
fn url_from_root_rel(root_rel_path_with_ext: &str) -> String {
	let base = basename(root_rel_path_with_ext);
	let ext = extname(base);
	let stem = &base[..base.len() - ext.len()];
	let is_index = stem == "index"
		&& ext.chars().skip(1).all(|c| c.is_ascii_lowercase())
		&& (ext.is_empty() || ext.len() > 1);
	if is_index {
		let dir = &root_rel_path_with_ext[..root_rel_path_with_ext.len() - base.len()];
		format!("/{dir}")
	} else {
		format!("/{root_rel_path_with_ext}")
	}
}

/// Rebuilds a file record with an override path from front matter.
///
/// # Example
///
/// ```
/// let dirs = kd_site::Dirs { input_dir: "/s", output_dir: "/o", output_extension: ".html" };
/// let f = kd_site::page_file("/s/170370.html", &dirs);
/// let f = kd_site::apply_meta_path_override(&f, "/en/library/2016_summer.html", &dirs).unwrap();
/// assert_eq!(f.output_path, "/o/en/library/2016_summer.html");
/// assert_eq!(f.url, "/en/library/2016_summer.html");
/// assert_eq!(f.file_slug, "2016_summer");
/// ```
pub fn apply_meta_path_override(
	file: &PageFile,
	meta_path: &str,
	dirs: &Dirs<'_>,
) -> Result<PageFile, Error> {
	let resolved = resolve_meta_path(meta_path, dirs.output_dir, dirs.output_extension)?;
	let rel = &resolved.root_rel_path_with_ext;
	let base = basename(rel);
	let final_ext = extname(base);
	let base_name = &base[..base.len() - final_ext.len()];
	let parent_dir = dirname(rel);
	let file_path_stem = format!("/{}", &rel[..rel.len() - final_ext.len()]);
	let file_slug = if base_name == "index" {
		if parent_dir == "." || parent_dir.is_empty() {
			String::new()
		} else {
			basename(&parent_dir).to_string()
		}
	} else {
		base_name.to_string()
	};
	Ok(PageFile {
		input_path: file.input_path.clone(),
		output_path: resolved.output_path,
		file_slug,
		file_path_stem,
		url: url_from_root_rel(rel),
		extension: file.extension.clone(),
	})
}

/// Converts a URL (or a bare path) to an output-relative local path, the
/// rule the dev server and virtual pages share: `/` and `/a/` become
/// `index<ext>`, a last segment without a dot gets `<ext>`, and a segment
/// with a dot is kept. Scheme, host, query and fragment are ignored.
///
/// # Example
///
/// ```
/// assert_eq!(kd_site::url_to_local_path("https://example.com/", ".html"), "index.html");
/// assert_eq!(kd_site::url_to_local_path("/path/", ".html"), "path/index.html");
/// assert_eq!(kd_site::url_to_local_path("/file?x=1#top", ".html"), "file.html");
/// assert_eq!(kd_site::url_to_local_path("/file.js", ""), "file.js");
/// ```
#[must_use]
pub fn url_to_local_path(url: &str, extension: &str) -> String {
	// Pathname: drop scheme+host, then query and fragment.
	let mut pathname = match url.find("://") {
		Some(i) => {
			let after = &url[i + 3..];
			match after.find('/') {
				Some(j) => &after[j..],
				None => "/",
			}
		}
		None => url,
	};
	if let Some(i) = pathname.find(['?', '#']) {
		pathname = &pathname[..i];
	}
	if pathname.is_empty() {
		pathname = "/";
	}
	let pathname = pathname.strip_prefix('/').unwrap_or(pathname);
	if pathname.is_empty() || pathname.ends_with('/') {
		return format!("{pathname}index{extension}");
	}
	let last = basename(pathname);
	if !last.contains('.') {
		return format!("{pathname}{extension}");
	}
	pathname.to_string()
}

/// What to do when two inputs produce the same output path.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ConflictPolicy {
	Error,
	Warning,
	Silent,
}

/// A file before conflict resolution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Candidate {
	pub file: PageFile,
	/// True when the location came from an `outputPathField` override.
	pub from_override: bool,
}

/// Result of conflict resolution: the surviving files (first-seen order)
/// and the collision messages (one per dropped file, for `Warning`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Resolved {
	pub files: Vec<PageFile>,
	pub warnings: Vec<String>,
}

/// Drops files whose output path is already taken. An override beats a
/// default location; otherwise the first file seen wins and keeps its
/// position.
///
/// # Example
///
/// ```
/// use kd_site::{Candidate, ConflictPolicy, Dirs, page_file, resolve_conflicts};
/// let dirs = Dirs { input_dir: "/s", output_dir: "/o", output_extension: ".html" };
/// let a = Candidate { file: page_file("/s/a.html", &dirs), from_override: false };
/// let b = Candidate { file: page_file("/s/a.tsx", &dirs), from_override: false };
/// let r = resolve_conflicts(vec![a, b], ConflictPolicy::Warning).unwrap();
/// assert_eq!(r.files.len(), 1);
/// assert_eq!(r.files[0].input_path, "/s/a.html");
/// assert_eq!(r.warnings.len(), 1);
/// ```
pub fn resolve_conflicts(
	candidates: Vec<Candidate>,
	policy: ConflictPolicy,
) -> Result<Resolved, Error> {
	let mut order: Vec<String> = Vec::new();
	let mut seen: HashMap<String, Candidate> = HashMap::new();
	let mut warnings = Vec::new();
	for candidate in candidates {
		let key = candidate.file.output_path.clone();
		match seen.get(&key) {
			None => {
				order.push(key.clone());
				seen.insert(key, candidate);
			}
			Some(previous) => {
				let message = format!(
					"Output path collision: '{}' is produced by both '{}' and '{}'",
					key, previous.file.input_path, candidate.file.input_path
				);
				match policy {
					ConflictPolicy::Error => return Err(err(message)),
					ConflictPolicy::Warning => warnings.push(message),
					ConflictPolicy::Silent => {}
				}
				if candidate.from_override && !previous.from_override {
					seen.insert(key, candidate);
				}
			}
		}
	}
	let files = order
		.into_iter()
		.map(|key| seen.remove(&key).expect("every key was inserted").file)
		.collect();
	Ok(Resolved { files, warnings })
}

/// One thing to look for in a walk: the files that match any of `files` and
/// none of `ignore`.
#[derive(Clone, Copy)]
pub struct Search<'a> {
	pub files: &'a [kd_glob::Pattern],
	pub ignore: &'a [kd_glob::Pattern],
}

/// Lists the files under `input_dir` that match any of `files` and none of
/// `ignore`. Paths are returned relative to `input_dir`, `/` separated and
/// sorted. Symlinked directories are followed once (cycles are skipped).
/// Directories matched by an `ignore` pattern ending in `**` are not entered.
///
/// # Example
///
/// ```no_run
/// let files = [kd_glob::Pattern::new("**/*.{html,tsx}").unwrap()];
/// let ignore = [kd_glob::Pattern::new("_includes/**").unwrap()];
/// let found = kd_site::discover("/site/src", &files, &ignore).unwrap();
/// ```
pub fn discover(
	input_dir: &str,
	files: &[kd_glob::Pattern],
	ignore: &[kd_glob::Pattern],
) -> std::io::Result<Vec<String>> {
	let mut found = discover_all(input_dir, &[Search { files, ignore }])?;
	Ok(found.pop().unwrap_or_default())
}

/// Like [`discover`] for several searches at once, walking the tree a single
/// time: with a hundred thousand files the walk is a cost of its own. A
/// directory is entered unless every search ignores it. The result has one
/// sorted list per search.
///
/// # Example
///
/// ```no_run
/// let pages = [kd_glob::Pattern::new("**/*.html").unwrap()];
/// let styles = [kd_glob::Pattern::new("**/*.css").unwrap()];
/// let found = kd_site::discover_all(
///     "/site/src",
///     &[
///         kd_site::Search { files: &pages, ignore: &[] },
///         kd_site::Search { files: &styles, ignore: &[] },
///     ],
/// ).unwrap();
/// assert_eq!(found.len(), 2);
/// ```
pub fn discover_all(input_dir: &str, searches: &[Search<'_>]) -> std::io::Result<Vec<Vec<String>>> {
	let root = std::path::Path::new(input_dir);
	let mut out: Vec<Vec<String>> = vec![Vec::new(); searches.len()];
	let mut visited: HashSet<std::path::PathBuf> = HashSet::new();
	if let Ok(canon) = fs::canonicalize(root) {
		visited.insert(canon);
	}
	walk(root, "", searches, &mut out, &mut visited)?;
	for list in &mut out {
		list.sort();
	}
	Ok(out)
}

fn walk(
	dir: &std::path::Path,
	rel_prefix: &str,
	searches: &[Search<'_>],
	out: &mut [Vec<String>],
	visited: &mut HashSet<std::path::PathBuf>,
) -> std::io::Result<()> {
	let ignored_everywhere = |rel: &str| {
		searches
			.iter()
			.all(|s| s.ignore.iter().any(|p| p.covers_dir(rel)))
	};
	let entries = match fs::read_dir(dir) {
		Ok(entries) => entries,
		// An unreadable directory the config ignores must not abort the build.
		Err(_) if !rel_prefix.is_empty() && ignored_everywhere(rel_prefix) => {
			return Ok(());
		}
		Err(e) => return Err(e),
	};
	for entry in entries {
		let entry = entry?;
		let name = entry.file_name();
		let Some(name) = name.to_str() else {
			// Not valid UTF-8: cannot be referenced from a config; skip.
			continue;
		};
		// The type comes with the directory listing; only a symlink needs a
		// `stat` (it is followed, so a linked directory is walked).
		let file_type = entry.file_type()?;
		let (is_dir, is_file) = if file_type.is_symlink() {
			match fs::metadata(entry.path()) {
				Ok(m) => (m.is_dir(), m.is_file()),
				Err(_) => continue, // dangling symlink
			}
		} else {
			(file_type.is_dir(), file_type.is_file())
		};
		let rel = if rel_prefix.is_empty() {
			name.to_string()
		} else {
			format!("{rel_prefix}/{name}")
		};
		if is_dir {
			// Prune: an ignored directory (`_includes/**`, `**/node_modules/**`)
			// is never entered, so a large ignored tree costs nothing.
			if ignored_everywhere(&rel) {
				continue;
			}
			if let Ok(canon) = fs::canonicalize(entry.path())
				&& !visited.insert(canon)
			{
				continue;
			}
			walk(&entry.path(), &rel, searches, out, visited)?;
		} else if is_file {
			for (search, list) in searches.iter().zip(out.iter_mut()) {
				if search.files.iter().any(|p| p.matches(&rel))
					&& !search.ignore.iter().any(|p| p.matches(&rel))
				{
					list.push(rel.clone());
				}
			}
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	const DIRS: Dirs<'static> = Dirs {
		input_dir: "/path/to/src",
		output_dir: "/path/to/dist",
		output_extension: ".html",
	};

	#[test]
	fn output_path_mirrors_the_tree_and_swaps_the_extension() {
		let info = compute_output_path("/path/to/src/pages/index.tsx", &DIRS);
		assert_eq!(info.output_path, "/path/to/dist/pages/index.html");
		assert_eq!(info.name, "index");
		assert_eq!(info.extension, ".tsx");
		assert_eq!(info.rel_dir, "pages");
		assert_eq!(info.root_rel_path, "pages/index");
		assert_eq!(info.root_rel_path_with_ext, "pages/index.html");
	}

	#[test]
	fn output_path_for_a_root_file_and_a_nested_file() {
		let root = compute_output_path("/path/to/src/index.tsx", &DIRS);
		assert_eq!(root.output_path, "/path/to/dist/index.html");
		assert_eq!(root.rel_dir, "");
		assert_eq!(root.root_rel_path, "index");

		let nested = compute_output_path("/path/to/src/pages/about/contact.tsx", &DIRS);
		assert_eq!(nested.output_path, "/path/to/dist/pages/about/contact.html");
		assert_eq!(nested.rel_dir, "pages/about");
		assert_eq!(nested.root_rel_path_with_ext, "pages/about/contact.html");
	}

	#[test]
	fn output_path_other_extensions_and_empty_extension() {
		let css = compute_output_path(
			"/path/to/src/styles/main.scss",
			&Dirs {
				output_extension: ".css",
				..DIRS
			},
		);
		assert_eq!(css.output_path, "/path/to/dist/styles/main.css");
		assert_eq!(css.extension, ".scss");

		let none = compute_output_path(
			"/path/to/src/assets/image.png",
			&Dirs {
				output_extension: "",
				..DIRS
			},
		);
		assert_eq!(none.output_path, "/path/to/dist/assets/image");
		assert_eq!(none.root_rel_path_with_ext, "assets/image");
	}

	#[test]
	fn output_path_lowercases_the_input_extension() {
		assert_eq!(
			compute_output_path("/path/to/src/pages/index.TSX", &DIRS).extension,
			".tsx"
		);
		assert_eq!(
			compute_output_path("/path/to/src/styles/main.ScSs", &DIRS).output_path,
			"/path/to/dist/styles/main.html"
		);
	}

	#[test]
	fn output_path_normalizes_dot_segments_in_inputs() {
		let info = compute_output_path("/path/to/src/pages/../pages/./index.tsx", &DIRS);
		assert_eq!(info.output_path, "/path/to/dist/pages/index.html");
	}

	#[test]
	fn meta_path_forms() {
		let r = resolve_meta_path("/foo/bar.html", "/out", ".html").unwrap();
		assert_eq!(
			(r.output_path.as_str(), r.root_rel_path_with_ext.as_str()),
			("/out/foo/bar.html", "foo/bar.html")
		);
		let r = resolve_meta_path("/foo/bar", "/out", ".html").unwrap();
		assert_eq!(r.output_path, "/out/foo/bar.html");
		let r = resolve_meta_path("/foo/bar/", "/out", ".html").unwrap();
		assert_eq!(r.output_path, "/out/foo/bar/index.html");
		let r = resolve_meta_path("/", "/out", ".html").unwrap();
		assert_eq!(
			(r.output_path.as_str(), r.root_rel_path_with_ext.as_str()),
			("/out/index.html", "index.html")
		);
		let r = resolve_meta_path("/feed", "/out", ".xml").unwrap();
		assert_eq!(r.output_path, "/out/feed.xml");
		let r = resolve_meta_path("/sitemap.xml", "/out", ".html").unwrap();
		assert_eq!(r.output_path, "/out/sitemap.xml");
		let r = resolve_meta_path("/a//b/", "/out/", ".htm").unwrap();
		assert_eq!(r.output_path, "/out/a/b/index.htm");
	}

	#[test]
	fn meta_path_rejections() {
		assert_eq!(
			resolve_meta_path("foo/bar.html", "/out", ".html")
				.unwrap_err()
				.message,
			"'path' must start with '/': \"foo/bar.html\""
		);
		for bad in ["/foo/../bar", "/./foo", "/../escape.html"] {
			assert_eq!(
				resolve_meta_path(bad, "/out", ".html").unwrap_err().message,
				format!("'path' must not contain '.' or '..' segments: {bad:?}")
			);
		}
	}

	#[test]
	fn page_file_url_slug_and_stem() {
		let dirs = Dirs {
			input_dir: "/s",
			output_dir: "/o",
			output_extension: ".html",
		};
		let f = page_file("/s/index.tsx", &dirs);
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/", "s", "/index")
		);
		let f = page_file("/s/about/index.html", &dirs);
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/about/", "about", "/about/index")
		);
		let f = page_file("/s/news/2026.tsx", &dirs);
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/news/2026.html", "2026", "/news/2026")
		);
		assert_eq!(f.output_path, "/o/news/2026.html");
		assert_eq!(f.extension, ".tsx");
		// `index` followed by an uppercase or non-letter extension is not stripped (v2 regex).
		let f = page_file(
			"/s/x/index.tsx",
			&Dirs {
				output_extension: ".HTML",
				..dirs
			},
		);
		assert_eq!(f.url, "/x/index.HTML");
	}

	#[test]
	fn override_rebuilds_url_slug_and_stem() {
		let dirs = Dirs {
			input_dir: "/s",
			output_dir: "/o",
			output_extension: ".html",
		};
		let base = page_file("/s/100001.html", &dirs);
		let f = apply_meta_path_override(&base, "/a/b/", &dirs).unwrap();
		assert_eq!(f.output_path, "/o/a/b/index.html");
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/a/b/", "b", "/a/b/index")
		);
		let f = apply_meta_path_override(&base, "/", &dirs).unwrap();
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/", "", "/index")
		);
		let f = apply_meta_path_override(&base, "/legacy/page.htm", &dirs).unwrap();
		assert_eq!(
			(
				f.url.as_str(),
				f.file_slug.as_str(),
				f.file_path_stem.as_str()
			),
			("/legacy/page.htm", "page", "/legacy/page")
		);
		assert_eq!(f.input_path, "/s/100001.html");
		assert_eq!(f.extension, ".html");
		assert!(apply_meta_path_override(&base, "nope", &dirs).is_err());
	}

	#[test]
	fn url_to_local_path_rules() {
		assert_eq!(
			url_to_local_path("https://example.com/", ".html"),
			"index.html"
		);
		assert_eq!(
			url_to_local_path("https://example.com", ".html"),
			"index.html"
		);
		assert_eq!(
			url_to_local_path("https://example.com/path/", ".html"),
			"path/index.html"
		);
		assert_eq!(
			url_to_local_path("https://example.com/file", ".html"),
			"file.html"
		);
		assert_eq!(
			url_to_local_path("https://example.com/file.js", ""),
			"file.js"
		);
		assert_eq!(url_to_local_path("/", ".html"), "index.html");
		assert_eq!(url_to_local_path("", ".html"), "index.html");
		assert_eq!(url_to_local_path("/a/b", ".html"), "a/b.html");
		assert_eq!(url_to_local_path("/a/b.htm", ".html"), "a/b.htm");
		assert_eq!(url_to_local_path("/a.b/c", ".html"), "a.b/c.html");
		assert_eq!(url_to_local_path("/x?q=1#frag", ".html"), "x.html");
		assert_eq!(url_to_local_path("/x/?q=1", ".html"), "x/index.html");
	}

	fn candidate(input: &str, from_override: bool) -> Candidate {
		let dirs = Dirs {
			input_dir: "/s",
			output_dir: "/o",
			output_extension: ".html",
		};
		Candidate {
			file: page_file(input, &dirs),
			from_override,
		}
	}

	#[test]
	fn conflicts_first_seen_wins_and_keeps_position() {
		let r = resolve_conflicts(
			vec![
				candidate("/s/a.html", false),
				candidate("/s/b.html", false),
				candidate("/s/a.tsx", false),
			],
			ConflictPolicy::Warning,
		)
		.unwrap();
		let inputs: Vec<&str> = r.files.iter().map(|f| f.input_path.as_str()).collect();
		assert_eq!(inputs, ["/s/a.html", "/s/b.html"]);
		assert_eq!(
			r.warnings,
			["Output path collision: '/o/a.html' is produced by both '/s/a.html' and '/s/a.tsx'"]
		);
	}

	#[test]
	fn conflicts_override_beats_default_but_not_another_override() {
		let r = resolve_conflicts(
			vec![candidate("/s/a.html", false), candidate("/s/a.tsx", true)],
			ConflictPolicy::Silent,
		)
		.unwrap();
		assert_eq!(r.files[0].input_path, "/s/a.tsx");
		assert!(r.warnings.is_empty());

		let r = resolve_conflicts(
			vec![candidate("/s/a.html", true), candidate("/s/a.tsx", true)],
			ConflictPolicy::Silent,
		)
		.unwrap();
		assert_eq!(r.files[0].input_path, "/s/a.html");
	}

	#[test]
	fn conflicts_error_policy_throws() {
		let e = resolve_conflicts(
			vec![candidate("/s/a.html", false), candidate("/s/a.tsx", false)],
			ConflictPolicy::Error,
		)
		.unwrap_err();
		assert!(e.message.starts_with("Output path collision: '/o/a.html'"));
	}

	#[test]
	fn discover_walks_matches_ignores_and_sorts() {
		let tmp = std::env::temp_dir().join(format!("kd_site_discover_{}", std::process::id()));
		let _ = fs::remove_dir_all(&tmp);
		for rel in [
			"b/page.html",
			"a/index.tsx",
			"a/.draft/x.tsx",
			"_includes/h.html",
			"a/style.css",
			"c/deep/er/leaf.html",
		] {
			let p = tmp.join(rel);
			fs::create_dir_all(p.parent().unwrap()).unwrap();
			fs::write(&p, b"").unwrap();
		}
		let files = [kd_glob::Pattern::new("**/*.{html,tsx}").unwrap()];
		let ignore = [kd_glob::Pattern::new("_includes/**").unwrap()];
		let found = discover(tmp.to_str().unwrap(), &files, &ignore).unwrap();
		assert_eq!(found, ["a/index.tsx", "b/page.html", "c/deep/er/leaf.html"]);
		let _ = fs::remove_dir_all(&tmp);
	}

	#[test]
	fn discover_all_answers_several_searches_in_one_walk() {
		let tmp = std::env::temp_dir().join(format!("kd_site_all_{}", std::process::id()));
		let _ = fs::remove_dir_all(&tmp);
		for rel in [
			"a/index.html",
			"a/style.css",
			"a/app.ts",
			"vendor/lib.css",
			"vendor/lib.html",
			"drafts/d.html",
			"drafts/d.css",
		] {
			let p = tmp.join(rel);
			fs::create_dir_all(p.parent().unwrap()).unwrap();
			fs::write(&p, b"").unwrap();
		}
		let pages = [kd_glob::Pattern::new("**/*.html").unwrap()];
		let styles = [kd_glob::Pattern::new("**/*.css").unwrap()];
		let scripts = [kd_glob::Pattern::new("**/*.ts").unwrap()];
		let ignore_vendor = [kd_glob::Pattern::new("vendor/**").unwrap()];
		let ignore_drafts = [kd_glob::Pattern::new("drafts/**").unwrap()];
		let found = discover_all(
			tmp.to_str().unwrap(),
			&[
				Search {
					files: &pages,
					ignore: &ignore_drafts,
				},
				Search {
					files: &styles,
					ignore: &ignore_vendor,
				},
				Search {
					files: &scripts,
					ignore: &[],
				},
			],
		)
		.unwrap();
		// Each search has its own ignore; a directory is walked while any
		// search still wants it.
		assert_eq!(found[0], ["a/index.html", "vendor/lib.html"]);
		assert_eq!(found[1], ["a/style.css", "drafts/d.css"]);
		assert_eq!(found[2], ["a/app.ts"]);
		let _ = fs::remove_dir_all(&tmp);
	}

	#[test]
	fn discover_does_not_enter_ignored_directories() {
		use std::os::unix::fs::PermissionsExt;
		let tmp = std::env::temp_dir().join(format!("kd_site_prune_{}", std::process::id()));
		let _ = fs::remove_dir_all(&tmp);
		fs::create_dir_all(tmp.join("keep")).unwrap();
		fs::write(tmp.join("keep/a.html"), b"").unwrap();
		fs::create_dir_all(tmp.join("node_modules/pkg")).unwrap();
		fs::write(tmp.join("node_modules/pkg/x.html"), b"").unwrap();
		// An ignored directory that cannot be read must not abort discovery.
		fs::create_dir_all(tmp.join("sealed")).unwrap();
		fs::write(tmp.join("sealed/s.html"), b"").unwrap();
		fs::set_permissions(tmp.join("sealed"), fs::Permissions::from_mode(0o000)).unwrap();

		let files = [kd_glob::Pattern::new("**/*.html").unwrap()];
		let ignore = [
			kd_glob::Pattern::new("**/node_modules/**").unwrap(),
			kd_glob::Pattern::new("sealed/**").unwrap(),
		];
		let found = discover(tmp.to_str().unwrap(), &files, &ignore);
		fs::set_permissions(tmp.join("sealed"), fs::Permissions::from_mode(0o755)).unwrap();
		assert_eq!(found.unwrap(), ["keep/a.html"]);

		// The same unreadable directory without an ignore pattern is an error.
		fs::set_permissions(tmp.join("sealed"), fs::Permissions::from_mode(0o000)).unwrap();
		let strict = discover(tmp.to_str().unwrap(), &files, &[]);
		fs::set_permissions(tmp.join("sealed"), fs::Permissions::from_mode(0o755)).unwrap();
		assert!(strict.is_err());
		let _ = fs::remove_dir_all(&tmp);
	}
}
