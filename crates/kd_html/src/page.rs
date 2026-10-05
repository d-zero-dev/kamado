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
use crate::parser::parse;
use crate::serialize::{document_html, outer_html};

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

/// Replaces every `<!-- … --!>` with `<!-- … -->` (the first terminator after
/// the opener wins, as a non-greedy match would).
fn normalize_comment_ends(html: &str) -> String {
	let mut out = String::with_capacity(html.len());
	let mut rest = html;
	while let Some(open) = rest.find("<!--") {
		let body_start = open + 4;
		out.push_str(&rest[..body_start]);
		let body = &rest[body_start..];
		let close = match (body.find("-->"), body.find("--!>")) {
			(Some(a), Some(b)) if b < a => Some((b, true)),
			(Some(a), _) => Some((a, false)),
			(None, Some(b)) => Some((b, true)),
			(None, None) => None,
		};
		match close {
			Some((at, alternate)) => {
				out.push_str(&body[..at]);
				out.push_str("-->");
				rest = &body[at + if alternate { 4 } else { 3 }..];
			}
			None => {
				out.push_str(body);
				rest = "";
			}
		}
	}
	out.push_str(rest);
	out
}

/// Skips leading whitespace and complete comments.
fn strip_leading_comments(html: &str) -> &str {
	let mut s = html.trim();
	while let Some(after) = s.strip_prefix("<!--") {
		match after.find("-->") {
			Some(end) => s = after[end + 3..].trim_start(),
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
		return stripped[9..]
			.chars()
			.next()
			.is_some_and(char::is_whitespace);
	}
	starts_with_ignore_case(stripped, "<html")
		&& stripped[5..]
			.chars()
			.next()
			.is_some_and(|c| c.is_whitespace() || c == '>')
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
		if self.is_fragment {
			return document_html(&self.doc);
		}
		self.root
			.map_or_else(String::new, |root| outer_html(&self.doc, root))
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
		assert_eq!(rt("<!-- a --> --!> <p>"), "<!-- a --> --!&gt; <p></p>");
	}

	#[test]
	fn doctype_needs_whitespace_after_it_to_count() {
		assert!(Page::parse("<!doctypehtml>").is_fragment);
		assert!(!Page::parse("<!DocType\thtml>").is_fragment);
	}
}
