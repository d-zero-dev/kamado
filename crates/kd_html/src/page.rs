//! A page as the post-processing pipeline sees it: parsed once, classified as
//! a fragment or a full document, and serialized back in the same shape.
//!
//! This is v2's `getDOM` expressed on the arena DOM:
//! - `--!>` is normalized to `-->` before anything else, because the parser
//!   (like linkedom) only closes a comment on `-->`.
//! - Leading comments and whitespace are skipped to classify the input. It is
//!   a document when what follows starts with `<html` or `<!doctype`,
//!   otherwise a fragment.
//! - A fragment serializes all its children (text and comments included).
//! - A document serializes its first element child only (`documentElement`),
//!   so a doctype is not part of the output and a bare doctype gives an empty
//!   string. A `<head>` is inserted when the root has none, so rules that
//!   insert into the head always have an anchor.

use crate::dom::{Document, NodeId, ROOT};
use crate::parser::{is_js_space, parse};
use crate::serialize::{Options, inner_html_with, outer_html_with};

/// A parsed page.
pub struct Page {
	/// The tree.
	pub doc: Document,
	/// Whether the input was a fragment.
	pub is_fragment: bool,
	/// The element rules start from: `<html>` for a document, `None` for a
	/// document with no element.
	pub root: Option<NodeId>,
}

/// `html.replaceAll(/<!--([\s\S]*?)--!>/g, '<!--$1-->')`: from each `<!--`,
/// up to the nearest `--!>` (whatever lies between, a `-->` included), becomes
/// a comment that ends in `-->`. Exactly the regex, because v2's output
/// depends on its quirks; it is a single pass, since the scan for `--!>` never
/// looks back and a missing `--!>` ends the search for every later opener too.
fn normalize_comment_ends(html: &str) -> String {
	let mut out = String::with_capacity(html.len());
	let mut pos = 0;
	while let Some(open) = html[pos..].find("<!--") {
		let body = pos + open + 4;
		let Some(end) = html[body..].find("--!>") else {
			break;
		};
		out.push_str(&html[pos..body + end]);
		out.push_str("-->");
		pos = body + end + 4;
	}
	out.push_str(&html[pos..]);
	out
}

/// Skips leading whitespace and complete comments. "Whitespace" is
/// JavaScript's (`trim()` and `\s`): it includes U+FEFF, so a byte order mark
/// does not hide a document, and it does not include U+0085.
fn strip_leading_comments(html: &str) -> &str {
	let mut s = html.trim_matches(is_js_space);
	while let Some(after) = s.strip_prefix("<!--") {
		match after.find("-->") {
			Some(end) => s = after[end + 3..].trim_start_matches(is_js_space),
			None => break,
		}
	}
	s
}

fn starts_with_ignore_case(s: &str, prefix: &str) -> bool {
	s.len() >= prefix.len() && s.as_bytes()[..prefix.len()].eq_ignore_ascii_case(prefix.as_bytes())
}

fn is_document(stripped: &str) -> bool {
	if starts_with_ignore_case(stripped, "<!doctype") {
		return stripped[9..].chars().next().is_some_and(is_js_space);
	}
	starts_with_ignore_case(stripped, "<html")
		&& stripped[5..]
			.chars()
			.next()
			.is_some_and(|c| is_js_space(c) || c == '>')
}

impl Page {
	/// Parses `html` the way v2 did.
	///
	/// # Example
	///
	/// ```
	/// let page = kd_html::page::Page::parse("<!doctype html><html><body>x</body></html>");
	/// assert!(!page.is_fragment);
	/// assert_eq!(page.serialize(), "<html><head></head><body>x</body></html>");
	/// ```
	#[must_use]
	pub fn parse(html: &str) -> Page {
		let normalized = normalize_comment_ends(html);
		let is_fragment = !is_document(strip_leading_comments(&normalized));
		let mut doc = parse(&normalized);
		if is_fragment {
			return Page {
				doc,
				is_fragment,
				root: None,
			};
		}
		let root = doc.first_element_child(ROOT);
		if let Some(root) = root {
			let has_head = doc
				.children(root)
				.any(|c| doc.element(c).is_some_and(|e| e.name == "head"));
			if !has_head {
				let head = doc.create_element("head");
				doc.prepend_child(root, head);
			}
		}
		Page {
			doc,
			is_fragment,
			root,
		}
	}

	/// The markup of the page in the shape it came in.
	#[must_use]
	pub fn serialize(&self) -> String {
		self.serialize_with(&Options::default())
	}

	/// [`Page::serialize`] with serializer options.
	#[must_use]
	pub fn serialize_with(&self, options: &Options) -> String {
		if self.is_fragment {
			return inner_html_with(&self.doc, ROOT, options);
		}
		self.root.map_or_else(String::new, |root| {
			outer_html_with(&self.doc, root, options)
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rt(src: &str) -> String {
		Page::parse(src).serialize()
	}

	#[test]
	fn fragments_come_back_as_fragments() {
		assert_eq!(rt("<p>a</p>text<!-- c -->"), "<p>a</p>text<!-- c -->");
		assert_eq!(rt(""), "");
		assert_eq!(rt("<htmlish>x</htmlish>"), "<htmlish>x</htmlish>");
	}

	#[test]
	fn documents_serialize_the_root_element_and_gain_a_head() {
		assert_eq!(
			rt("<!doctype html><html><body>x</body></html>"),
			"<html><head></head><body>x</body></html>"
		);
		assert_eq!(
			rt("<HTML lang=ja><head><title>t</title></head></HTML>"),
			"<html lang=\"ja\"><head><title>t</title></head></html>"
		);
		assert_eq!(
			rt("<html><head></head></html>"),
			"<html><head></head></html>"
		);
	}

	#[test]
	fn a_bare_doctype_gives_an_empty_string() {
		assert_eq!(rt("<!doctype html>"), "");
		assert_eq!(rt("<!DOCTYPE html>\n"), "");
	}

	#[test]
	fn leading_comments_do_not_make_a_document_a_fragment() {
		let page = Page::parse("<!-- license -->\n<!doctype html><html><body></body></html>");
		assert!(!page.is_fragment);
		let page = Page::parse("<!-- a --><!-- b --><html></html>");
		assert!(!page.is_fragment);
		let page = Page::parse("<!-- unclosed <html></html>");
		assert!(page.is_fragment);
	}

	#[test]
	fn the_alternate_comment_terminator_is_normalized() {
		assert_eq!(rt("<!-- a --!><p>x</p>"), "<!-- a --><p>x</p>");
		assert_eq!(rt("<!-- a --!> b --> <p>"), "<!-- a --> b --&gt; <p></p>");
		// The regex looks for `--!>` only: a `-->` in between does not stop it.
		assert_eq!(rt("<!-- a --> --!> <p>"), "<!-- a --> --&gt; <p></p>");
		assert_eq!(rt("<!-- a --> b --!> c"), "<!-- a --> b --&gt; c");
		assert_eq!(rt("<!-- a --> <!-- b --!> c"), "<!-- a --> <!-- b --> c");
		assert_eq!(rt("<!-- a --!>x<!-- b --!>y"), "<!-- a -->x<!-- b -->y");
		assert_eq!(rt("<!---!>x"), "<!---!>x-->");
	}

	#[test]
	fn many_comments_without_the_alternate_terminator_are_scanned_once() {
		let html = "<!-- x -->".repeat(100_000);
		let started = std::time::Instant::now();
		assert_eq!(Page::parse(&html).serialize().len(), html.len());
		assert!(
			started.elapsed().as_secs() < 5,
			"the normalization must be linear"
		);
	}

	#[test]
	fn a_byte_order_mark_does_not_hide_a_document() {
		let page = Page::parse("\u{FEFF}<!doctype html><html><body>x</body></html>");
		assert!(!page.is_fragment);
		assert_eq!(page.serialize(), "<html><head></head><body>x</body></html>");
		assert!(!Page::parse("\u{FEFF}<html></html>").is_fragment);
		// U+0085 is white space to Rust but not to JavaScript.
		assert!(Page::parse("\u{85}<!doctype html><html></html>").is_fragment);
	}

	#[test]
	fn very_deep_nesting_does_not_overflow_the_stack() {
		let html = "<div>".repeat(50_000) + "x" + &"</div>".repeat(50_000);
		let handle = std::thread::Builder::new()
			.stack_size(1 << 20)
			.spawn(move || Page::parse(&html).serialize().len())
			.unwrap();
		assert_eq!(handle.join().unwrap(), 50_000 * "<div></div>".len() + 1);
	}

	#[test]
	fn doctype_needs_whitespace_after_it_to_count() {
		assert!(Page::parse("<!doctypehtml>").is_fragment);
		assert!(!Page::parse("<!DocType\thtml>").is_fragment);
	}

	#[test]
	fn a_processing_instruction_that_never_ends_stays_literal_text() {
		assert_eq!(rt("<?php echo 1"), "&lt;?php echo 1");
		assert_eq!(rt("<p>a</p><?php"), "<p>a</p>&lt;?php");
		// With a `>` but no `?>` it ends at that `>`, like a declaration.
		assert_eq!(rt("<?xml version=\"1.0\">x"), "<?xml version=\"1.0\">x");
	}

	#[test]
	fn many_processing_instructions_without_a_terminator_are_scanned_once() {
		let html = "<?a>".repeat(100_000);
		let started = std::time::Instant::now();
		assert_eq!(Page::parse(&html).serialize().len(), html.len());
		assert!(
			started.elapsed().as_secs() < 5,
			"the `?>` search must not restart each time"
		);
	}

	#[test]
	fn a_terminator_far_away_is_still_found_by_every_instruction_before_it() {
		assert_eq!(rt("<?a>x<?b>y<?c ?>z"), "<?a>x<?b>y<?c ?>z");
		assert_eq!(rt("<?a >=> <?b ?>"), "<?a >=> <?b ?>");
		assert_eq!(
			rt("<?php echo $a->b; ?>t<?php echo 2 ?>"),
			"<?php echo $a->b; ?>t<?php echo 2 ?>"
		);
	}
}
