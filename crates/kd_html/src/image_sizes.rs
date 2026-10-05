//! `html.imageSizes`: `width` and `height` for `<img>` and
//! `<picture> > <source>` elements from the image files themselves.
//!
//! The same rules as v2:
//! - `src` is trimmed; empty values, `data:` URIs, `http(s)://` and `//` URLs
//!   and files whose extension (before any `?` or `#`) is not one of the
//!   supported ones are left alone. The extension test is case-sensitive.
//! - The path is resolved against the output directory whatever the page's
//!   own URL is (a relative `src` is root-relative too), and a path that
//!   leaves the output directory is skipped without being read.
//! - A file that does not exist is skipped, but the reader is still asked for
//!   it, so the build can record it as a dependency and rebuild the page when
//!   the image appears.
//!
//! Differences: a damaged or unsupported image fails the page with the file's
//! path in the message (v2 threw an anonymous parser error), and with
//! `keep_authored` an element that already has `width` or `height` is left
//! exactly as written (v2 always overwrote both).

use crate::dom::NodeId;
use crate::page::Page;
use crate::selector::Selector;

/// What `src` extensions are measured by default.
pub const DEFAULT_EXTENSIONS: [&str; 6] = ["png", "jpg", "jpeg", "webp", "avif", "svg"];

/// Where image bytes come from. The build implements it to record every path
/// asked for, existing or not.
pub trait ImageSource {
	/// The bytes of `path`; `Ok(None)` when the file does not exist.
	///
	/// # Errors
	///
	/// A message for any failure other than a missing file.
	fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String>;
}

/// An image that cannot be measured.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageSizeError(pub String);

impl std::fmt::Display for ImageSizeError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

impl std::error::Error for ImageSizeError {}

/// Options of one run.
#[derive(Debug, Clone, Copy)]
pub struct Options<'a> {
	/// The directory `src` paths are resolved against (the output directory).
	pub root_dir: &'a str,
	/// Leave elements that already carry `width` or `height` alone.
	pub keep_authored: bool,
	/// Supported extensions, without the dot.
	pub extensions: &'a [&'a str],
}

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

/// The absolute file for `src_path`, or `None` when it leaves `root`.
fn resolve(root: &str, src_path: &str) -> Option<String> {
	let root = normalize(root);
	// A leading `..` would be clamped by `normalize`; judge the climb on the
	// segments instead, as `path.relative(root, file).startsWith('..')` does.
	let mut depth: i64 = 0;
	for segment in src_path.split('/') {
		match segment {
			"" | "." => {}
			".." => {
				depth -= 1;
				if depth < 0 {
					return None;
				}
			}
			_ => depth += 1,
		}
	}
	let joined = normalize(&format!("{root}/{src_path}"));
	let prefix = format!("{}/", root.trim_end_matches('/'));
	(joined == root || joined.starts_with(&prefix)).then_some(joined)
}

fn is_remote_or_inline(src: &str) -> bool {
	src.starts_with("data:")
		|| src.starts_with("http://")
		|| src.starts_with("https://")
		|| src.starts_with("//")
}

/// Sets `width` and `height` on the images of `page`.
///
/// # Errors
///
/// An [`ImageSizeError`] when a file cannot be read or is not a supported
/// image.
///
/// # Example
///
/// ```
/// use kd_html::image_sizes::{apply, ImageSource, Options, DEFAULT_EXTENSIONS};
/// use kd_html::page::Page;
/// struct One;
/// impl ImageSource for One {
///     fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
///         Ok((path == "/out/a.svg").then(|| b"<svg width=\"4\" height=\"3\"></svg>".to_vec()))
///     }
/// }
/// let mut page = Page::parse("<img src=\"/a.svg\">");
/// let options = Options { root_dir: "/out", keep_authored: false, extensions: &DEFAULT_EXTENSIONS };
/// apply(&mut page, &options, &One).unwrap();
/// assert_eq!(page.serialize(), "<img src=\"/a.svg\" width=\"4\" height=\"3\">");
/// ```
pub fn apply(
	page: &mut Page,
	options: &Options<'_>,
	source: &dyn ImageSource,
) -> Result<(), ImageSizeError> {
	// Constant, valid selector: a failure here is a bug in this file.
	let images = Selector::parse("img, picture > source").expect("valid selector");
	let nodes: Vec<NodeId> = images.select_all(&page.doc);
	for node in nodes {
		let Some(element) = page.doc.element(node) else {
			continue;
		};
		if options.keep_authored
			&& (element.attr("width").is_some() || element.attr("height").is_some())
		{
			continue;
		}
		let Some(src) = element.attr("src").map(str::trim) else {
			continue;
		};
		let src_path = src.split(['?', '#']).next().unwrap_or("");
		if src.is_empty()
			|| is_remote_or_inline(src)
			|| !options
				.extensions
				.iter()
				.any(|e| src_path.ends_with(&format!(".{e}")))
		{
			continue;
		}
		let Some(file) = resolve(options.root_dir, src_path) else {
			continue;
		};
		let bytes = source
			.read(&file)
			.map_err(|e| ImageSizeError(format!("cannot read the image `{file}`: {e}")))?;
		let Some(bytes) = bytes else {
			continue;
		};
		let size = kd_image::size_of(&bytes)
			.map_err(|e| ImageSizeError(format!("cannot measure the image `{file}`: {e}")))?;
		let Some(size) = size else {
			continue;
		};
		if let Some(element) = page.doc.element_mut(node) {
			element.set_attr("width", &size.width.to_string());
			element.set_attr("height", &size.height.to_string());
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::cell::RefCell;
	use std::collections::BTreeMap;

	struct Files {
		files: BTreeMap<&'static str, Vec<u8>>,
		asked: RefCell<Vec<String>>,
	}

	impl Files {
		fn new(files: &[(&'static str, &[u8])]) -> Files {
			Files {
				files: files.iter().map(|(k, v)| (*k, v.to_vec())).collect(),
				asked: RefCell::new(Vec::new()),
			}
		}
	}

	impl ImageSource for Files {
		fn read(&self, path: &str) -> Result<Option<Vec<u8>>, String> {
			self.asked.borrow_mut().push(path.to_owned());
			Ok(self.files.get(path).cloned())
		}
	}

	const SVG_A: &[u8] = b"<svg width=\"20\" height=\"10\"></svg>";

	fn run(html: &str, files: &Files, keep_authored: bool) -> Result<String, ImageSizeError> {
		let mut page = Page::parse(html);
		let options = Options {
			root_dir: "/out",
			keep_authored,
			extensions: &DEFAULT_EXTENSIONS,
		};
		apply(&mut page, &options, files)?;
		Ok(page.serialize())
	}

	#[test]
	fn img_and_picture_sources_get_their_size() {
		let files = Files::new(&[("/out/a.svg", SVG_A), ("/out/dir/b.svg", SVG_A)]);
		assert_eq!(
			run(
				"<img src=\"/a.svg\"><picture><source src=\"/dir/b.svg\"><img src=\"dir/b.svg\"></picture>",
				&files,
				false
			)
			.unwrap(),
			"<img src=\"/a.svg\" width=\"20\" height=\"10\"><picture><source src=\"/dir/b.svg\" width=\"20\" height=\"10\"><img src=\"dir/b.svg\" width=\"20\" height=\"10\"></picture>"
		);
	}

	#[test]
	fn authored_sizes_are_overwritten_unless_kept() {
		let files = Files::new(&[("/out/a.svg", SVG_A)]);
		let html = "<img src=\"/a.svg\" width=\"1\" height=\"2\"><img src=\"/a.svg\" height=\"2\">";
		assert_eq!(
			run(html, &files, false).unwrap(),
			"<img src=\"/a.svg\" width=\"20\" height=\"10\"><img src=\"/a.svg\" height=\"10\" width=\"20\">"
		);
		assert_eq!(run(html, &files, true).unwrap(), html);
	}

	#[test]
	fn remote_inline_and_unsupported_sources_are_left_alone_and_unread() {
		let files = Files::new(&[]);
		let html = "<img src=\"https://x.test/a.png\"><img src=\"http://x.test/a.png\"><img src=\"//x.test/a.png\"><img src=\"data:image/png;base64,AAAA\"><img src=\"/a.gif\"><img src=\"/a.PNG\"><img><img src=\"\"><img src=\"  \">";
		assert_eq!(
			run(html, &files, false).unwrap(),
			"<img src=\"https://x.test/a.png\"><img src=\"http://x.test/a.png\"><img src=\"//x.test/a.png\"><img src=\"data:image/png;base64,AAAA\"><img src=\"/a.gif\"><img src=\"/a.PNG\"><img><img src=\"\"><img src=\"  \">"
		);
		assert!(files.asked.borrow().is_empty());
	}

	#[test]
	fn query_strings_fragments_and_surrounding_spaces_are_handled() {
		let files = Files::new(&[("/out/a.svg", SVG_A)]);
		assert_eq!(
			run("<img src=\" /a.svg?v=2#x \">", &files, false).unwrap(),
			"<img src=\" /a.svg?v=2#x \" width=\"20\" height=\"10\">"
		);
	}

	#[test]
	fn paths_that_leave_the_output_directory_are_not_read() {
		let files = Files::new(&[("/etc/x.svg", SVG_A), ("/x.svg", SVG_A)]);
		let html = "<img src=\"../x.svg\"><img src=\"/../x.svg\"><img src=\"a/../../x.svg\"><img src=\"../../etc/x.svg\">";
		assert_eq!(run(html, &files, false).unwrap(), html);
		assert!(
			files.asked.borrow().is_empty(),
			"{:?}",
			files.asked.borrow()
		);
	}

	#[test]
	fn dot_segments_that_stay_inside_are_resolved() {
		let files = Files::new(&[("/out/b.svg", SVG_A)]);
		assert_eq!(
			run("<img src=\"/a/../b.svg\">", &files, false).unwrap(),
			"<img src=\"/a/../b.svg\" width=\"20\" height=\"10\">"
		);
	}

	#[test]
	fn a_missing_file_is_skipped_but_still_asked_for() {
		let files = Files::new(&[]);
		assert_eq!(
			run("<img src=\"/missing.png\">", &files, false).unwrap(),
			"<img src=\"/missing.png\">"
		);
		assert_eq!(files.asked.borrow().as_slice(), ["/out/missing.png"]);
	}

	#[test]
	fn a_damaged_image_names_its_file() {
		let files = Files::new(&[("/out/bad.png", b"not a png")]);
		let error = run("<img src=\"/bad.png\">", &files, false).unwrap_err();
		assert!(error.0.contains("/out/bad.png"), "{error}");
	}

	#[test]
	fn an_svg_without_a_usable_size_is_left_alone() {
		let files = Files::new(&[("/out/c.svg", b"<svg viewBox=\"0,0,1,1\"></svg>")]);
		assert_eq!(
			run("<img src=\"/c.svg\">", &files, false).unwrap(),
			"<img src=\"/c.svg\">"
		);
	}

	#[test]
	fn custom_extensions_limit_what_is_measured() {
		let files = Files::new(&[("/out/a.svg", SVG_A)]);
		let mut page = Page::parse("<img src=\"/a.svg\">");
		let options = Options {
			root_dir: "/out",
			keep_authored: false,
			extensions: &["png"],
		};
		apply(&mut page, &options, &files).unwrap();
		assert_eq!(page.serialize(), "<img src=\"/a.svg\">");
	}
}
