//! `html.inject`: static markup written into the head or body of a document.
//!
//! Only full documents take part: a fragment has no `<head>` or `<body>` to
//! write into, and guessing one would put markup in places v2 never did.
//! A document without a `<body>` skips the body positions for the same
//! reason (the parser does not invent one).
//!
//! The same markup is never written twice: if the target already contains
//! the serialized form of what would be inserted, the injection is skipped.
//! That keeps a page that already carries the tag (written by hand, or by an
//! earlier build step) from getting a second copy.
//!
//! Two implementations write the markup, and a change to what an injection
//! means has to be made in both. [`apply`] works on the tree of a page the
//! pipeline builds: it can write anywhere the parser put an element, and the
//! serializer prints the result. [`apply_to_text`] splices into the text of a
//! file the dev server sends as it is: the tree would print the doctype, the
//! line breaks and the quotes of such a file in another form, so it finds the
//! tags in the text instead, and writes only the markup. The tests of both
//! check the same behaviors (the position, the mode, the duplicate, the
//! fragment).

use crate::dom::NodeId;
use crate::page::Page;
use crate::rules::fragment;
use crate::serialize::{inner_html, outer_html};

/// Where in the document the markup goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectPosition {
	HeadStart,
	HeadEnd,
	BodyStart,
	BodyEnd,
}

/// When an injection applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InjectMode {
	Build,
	Serve,
	Both,
}

/// What the pipeline is doing right now.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
	Build,
	Serve,
}

/// One injection.
///
/// # Example
///
/// ```
/// use kd_html::{inject::{apply, Inject, InjectMode, InjectPosition, Phase}, page::Page};
/// let mut page = Page::parse("<html><head><title>t</title></head><body></body></html>");
/// let injects = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "<link rel=\"x\">")];
/// apply(&mut page, &injects, Phase::Build);
/// assert_eq!(page.serialize(), "<html><head><title>t</title><link rel=\"x\"></head><body></body></html>");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Inject {
	pub position: InjectPosition,
	pub mode: InjectMode,
	pub html: String,
}

impl Inject {
	#[must_use]
	pub fn new(position: InjectPosition, mode: InjectMode, html: &str) -> Inject {
		Inject {
			position,
			mode,
			html: html.to_owned(),
		}
	}

	/// Whether the injection is written in `phase` (`mode`: `both` in both,
	/// `build` and `serve` in their own).
	///
	/// # Example
	///
	/// ```
	/// use kd_html::inject::{Inject, InjectMode, InjectPosition, Phase};
	/// let both = Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "<i></i>");
	/// let serve = Inject::new(InjectPosition::HeadEnd, InjectMode::Serve, "<i></i>");
	/// assert!(both.applies_in(Phase::Build) && both.applies_in(Phase::Serve));
	/// assert!(serve.applies_in(Phase::Serve) && !serve.applies_in(Phase::Build));
	/// ```
	#[must_use]
	pub fn applies_in(&self, phase: Phase) -> bool {
		matches!(
			(self.mode, phase),
			(InjectMode::Both, _)
				| (InjectMode::Build, Phase::Build)
				| (InjectMode::Serve, Phase::Serve)
		)
	}
}

fn named_child(page: &Page, parent: NodeId, name: &str) -> Option<NodeId> {
	page.doc
		.children(parent)
		.find(|&c| page.doc.element(c).is_some_and(|e| e.name == name))
}

/// The element a position is in, and whether it is the start of it.
fn target_of(position: InjectPosition) -> (&'static str, bool) {
	match position {
		InjectPosition::HeadStart => ("head", true),
		InjectPosition::HeadEnd => ("head", false),
		InjectPosition::BodyStart => ("body", true),
		InjectPosition::BodyEnd => ("body", false),
	}
}

/// The text in lower case with what is not markup blanked out (the same
/// length, so every offset is the same): comments and the content of
/// `<script>`, `<style>` and `<textarea>`. A tag written in them is not one.
fn searchable(text: &str) -> String {
	let lower = text.to_ascii_lowercase();
	let mut bytes = lower.as_bytes().to_vec();
	let mut at = 0;
	while let Some(found) = lower[at..].find('<') {
		let start = at + found;
		let rest = &lower[start..];
		let (from, to) = if let Some(inside) = rest.strip_prefix("<!--") {
			let end = inside
				.find("-->")
				.map_or(lower.len(), |e| start + 4 + e + 3);
			(start, end)
		} else if let Some(name) = ["script", "style", "textarea"]
			.into_iter()
			.find(|name| is_start_tag_of(rest, name))
		{
			let Some(content) = end_of_tag(&lower, start + 1 + name.len()) else {
				break;
			};
			let end = lower[content..]
				.find(&format!("</{name}"))
				.map_or(lower.len(), |e| content + e);
			(content, end)
		} else {
			at = start + 1;
			continue;
		};
		bytes[from..to].fill(b' ');
		at = to.max(start + 1);
	}
	// Every blanked range starts and ends at an ASCII delimiter (`<`, `>`), so
	// no multi-byte character is cut.
	String::from_utf8(bytes).expect("blanking between ASCII delimiters keeps the text UTF-8")
}

/// Whether `html` is written in `range` of `text`, outside what `view` (the
/// `searchable` form of `text`) has blanked out: the markup in a comment or
/// in a script is not an element of the document, so it does not count.
fn is_written(text: &str, view: &str, range: std::ops::Range<usize>, html: &str) -> bool {
	let start = range.start;
	text[range].match_indices(html).any(|(at, found)| {
		let from = start + at;
		view.as_bytes()[from..from + found.len()]
			.iter()
			.any(|&byte| byte != b' ')
	})
}

/// Where the tag whose name ends at `after` ends (just after its `>`). A `>`
/// inside a quoted attribute value does not end it; a quote opens a value only
/// right after `=`, so a stray one in an unquoted value does not.
fn end_of_tag(text: &str, after: usize) -> Option<usize> {
	let mut quote = None;
	let mut last = 0u8;
	for (offset, &byte) in text.as_bytes()[after..].iter().enumerate() {
		match quote {
			Some(open) => {
				if byte == open {
					quote = None;
					last = byte;
				}
			}
			None => match byte {
				b'"' | b'\'' if last == b'=' => quote = Some(byte),
				b'>' => return Some(after + offset + 1),
				b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' => {}
				_ => last = byte,
			},
		}
	}
	None
}

/// Whether `rest` starts with the start tag of `name` (`<header>` is not `<head>`:
/// the name ends at a space, `/` or `>`).
fn is_start_tag_of(rest: &str, name: &str) -> bool {
	rest.strip_prefix('<')
		.and_then(|r| r.strip_prefix(name))
		.and_then(|r| r.bytes().next())
		.is_some_and(|b| matches!(b, b' ' | b'\t' | b'\r' | b'\n' | b'\x0c' | b'/' | b'>'))
}

/// Where the start tag of `name` ends (just after its `>`), found in `searchable`.
fn end_of_start_tag(searchable: &str, name: &str) -> Option<usize> {
	let pattern = format!("<{name}");
	let mut from = 0;
	while let Some(found) = searchable[from..].find(&pattern) {
		let start = from + found;
		let after = start + pattern.len();
		if !is_start_tag_of(&searchable[start..], name) {
			from = after;
			continue;
		}
		return end_of_tag(searchable, after);
	}
	None
}

/// Where the end tag of `name` starts, at or after `from`, found in `searchable`.
fn start_of_end_tag(searchable: &str, name: &str, from: usize) -> Option<usize> {
	let pattern = format!("</{name}");
	let bytes = searchable.as_bytes();
	let mut at = from;
	while let Some(found) = searchable[at..].find(&pattern) {
		let start = at + found;
		let mut end = start + pattern.len();
		while bytes.get(end).is_some_and(u8::is_ascii_whitespace) {
			end += 1;
		}
		if bytes.get(end) == Some(&b'>') {
			return Some(start);
		}
		at = start + pattern.len();
	}
	None
}

/// Applies the injections that belong to `phase` to the text of a document,
/// in order, and leaves every other byte as it was. `None` when nothing was
/// written (no injection applies, the element is not there, or it already
/// has the markup).
///
/// The markup goes right after the start tag (`head-start`, `body-start`:
/// a line break, then the markup) or right before the end tag (`head-end`,
/// `body-end`: the markup, then a line break), found in any case. It is a
/// string splice, so the doctype, the line breaks and the quotes of the
/// document stay as written; the dev server uses it for the files it sends
/// as they are.
///
/// Why not the tree of [`apply`]: printing it would write the doctype, the
/// line breaks and the quotes of the file in another form, and a file nothing
/// can be written into would come back changed.
///
/// What it takes the tags to be: comments and the content of `<script>`,
/// `<style>` and `<textarea>` hold no tag; a `>` inside a quoted attribute
/// value does not end a start tag (a quote opens a value only right after
/// `=`); the first start tag and the first end tag after it are used. What an
/// attribute value or a `<title>` holds is not looked at, so a tag written
/// there counts (as with the string replacement of v2). An
/// element needs both: a document without the end tag (or without `<head>`,
/// or a fragment) is left alone, as the string replacement of v2 left it.
/// The same markup is not written twice: the text between the two tags, as
/// written (not printed), is searched for it, outside the comments and raw
/// text elements above.
///
/// # Example
///
/// ```
/// use kd_html::inject::{apply_to_text, Inject, InjectMode, InjectPosition, Phase};
/// let injects = [Inject::new(InjectPosition::HeadEnd, InjectMode::Serve, "<link rel=\"x\">")];
/// assert_eq!(
///     apply_to_text("<HEAD></HEAD>", &injects, Phase::Serve).as_deref(),
///     Some("<HEAD><link rel=\"x\">\n</HEAD>")
/// );
/// assert_eq!(apply_to_text("<HEAD></HEAD>", &injects, Phase::Build), None);
/// ```
pub fn apply_to_text<'i>(
	source: &str,
	injects: impl IntoIterator<Item = &'i Inject>,
	phase: Phase,
) -> Option<String> {
	let mut text: Option<String> = None;
	// Made when an injection needs it and again after one was written.
	let mut view: Option<String> = None;
	for inject in injects.into_iter().filter(|i| i.applies_in(phase)) {
		if inject.html.is_empty() {
			continue;
		}
		let current = text.as_deref().unwrap_or(source);
		let (tag, at_start) = target_of(inject.position);
		let view_of_current = view.get_or_insert_with(|| searchable(current));
		let Some(open_end) = end_of_start_tag(view_of_current, tag) else {
			continue;
		};
		let Some(close_start) = start_of_end_tag(view_of_current, tag, open_end) else {
			continue;
		};
		if is_written(
			current,
			view_of_current,
			open_end..close_start,
			&inject.html,
		) {
			continue;
		}
		let mut out = String::with_capacity(current.len() + inject.html.len() + 1);
		if at_start {
			out.push_str(&current[..open_end]);
			out.push('\n');
			out.push_str(&inject.html);
			out.push_str(&current[open_end..]);
		} else {
			out.push_str(&current[..close_start]);
			out.push_str(&inject.html);
			out.push('\n');
			out.push_str(&current[close_start..]);
		}
		text = Some(out);
		view = None;
	}
	text
}

/// Applies the injections that belong to `phase`, in order.
pub fn apply<'i>(page: &mut Page, injects: impl IntoIterator<Item = &'i Inject>, phase: Phase) {
	let Some(root) = page.root else {
		return;
	};
	for inject in injects.into_iter().filter(|i| i.applies_in(phase)) {
		let (tag, at_start) = target_of(inject.position);
		let Some(target) = named_child(page, root, tag) else {
			continue;
		};
		let nodes = fragment(&mut page.doc, &inject.html);
		if nodes.is_empty() {
			continue;
		}
		let wanted: String = nodes.iter().map(|&n| outer_html(&page.doc, n)).collect();
		if inner_html(&page.doc, target).contains(&wanted) {
			continue;
		}
		if at_start {
			for n in nodes.into_iter().rev() {
				page.doc.prepend_child(target, n);
			}
		} else {
			for n in nodes {
				page.doc.append_child(target, n);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	const DOC: &str =
		"<!doctype html><html><head><title>t</title></head><body><p>x</p></body></html>";

	fn run(html: &str, injects: &[Inject], phase: Phase) -> String {
		let mut page = Page::parse(html);
		apply(&mut page, injects, phase);
		page.serialize()
	}

	#[test]
	fn the_four_positions() {
		let cases = [
			(
				InjectPosition::HeadStart,
				"<html><head><i></i><title>t</title></head><body><p>x</p></body></html>",
			),
			(
				InjectPosition::HeadEnd,
				"<html><head><title>t</title><i></i></head><body><p>x</p></body></html>",
			),
			(
				InjectPosition::BodyStart,
				"<html><head><title>t</title></head><body><i></i><p>x</p></body></html>",
			),
			(
				InjectPosition::BodyEnd,
				"<html><head><title>t</title></head><body><p>x</p><i></i></body></html>",
			),
		];
		for (position, expected) in cases {
			let i = [Inject::new(position, InjectMode::Both, "<i></i>")];
			assert_eq!(run(DOC, &i, Phase::Build), expected, "{position:?}");
		}
	}

	#[test]
	fn several_nodes_keep_their_order_at_the_start() {
		let i = [Inject::new(
			InjectPosition::HeadStart,
			InjectMode::Both,
			"<a></a><b></b>",
		)];
		assert_eq!(
			run(DOC, &i, Phase::Build),
			"<html><head><a></a><b></b><title>t</title></head><body><p>x</p></body></html>"
		);
	}

	#[test]
	fn modes_select_the_phase() {
		let build = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Build,
			"<i></i>",
		)];
		let serve = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Serve,
			"<i></i>",
		)];
		assert!(run(DOC, &build, Phase::Build).contains("<i></i>"));
		assert!(!run(DOC, &build, Phase::Serve).contains("<i></i>"));
		assert!(run(DOC, &serve, Phase::Serve).contains("<i></i>"));
		assert!(!run(DOC, &serve, Phase::Build).contains("<i></i>"));
	}

	#[test]
	fn the_same_markup_is_not_written_twice() {
		let i = [
			Inject::new(
				InjectPosition::HeadEnd,
				InjectMode::Both,
				"<link rel=\"x\" href=\"/a.css\">",
			),
			Inject::new(
				InjectPosition::HeadEnd,
				InjectMode::Both,
				"<link rel=\"x\" href=\"/a.css\">",
			),
		];
		assert_eq!(
			run(DOC, &i, Phase::Build),
			"<html><head><title>t</title><link rel=\"x\" href=\"/a.css\"></head><body><p>x</p></body></html>"
		);
		let handwritten = "<html><head><link href=\"/a.css\" rel=\"x\"></head><body></body></html>";
		let again = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			"<link href=/a.css rel=x>",
		)];
		assert_eq!(run(handwritten, &again, Phase::Build), handwritten);
	}

	#[test]
	fn fragments_and_missing_targets_are_left_alone() {
		let i = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			"<i></i>",
		)];
		assert_eq!(run("<p>x</p>", &i, Phase::Build), "<p>x</p>");
		let body = [Inject::new(
			InjectPosition::BodyEnd,
			InjectMode::Both,
			"<i></i>",
		)];
		assert_eq!(
			run("<html><head></head></html>", &body, Phase::Build),
			"<html><head></head></html>"
		);
	}

	#[test]
	fn an_empty_injection_is_a_no_op() {
		let i = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "")];
		assert_eq!(run(DOC, &i, Phase::Build), run(DOC, &[], Phase::Build));
	}

	const TEXT_DOC: &str = "<!DOCTYPE html>\r\n<HTML><HEAD>\r\n<title>t</title>\r\n</HEAD>\r\n<BODY>\r\n<p>x</p>\r\n</BODY></HTML>\r\n";

	fn at(position: InjectPosition) -> [Inject; 1] {
		[Inject::new(position, InjectMode::Both, "<i></i>")]
	}

	#[test]
	fn text_gets_the_markup_at_the_four_positions_and_keeps_every_other_byte() {
		let cases = [
			(
				InjectPosition::HeadStart,
				"<!DOCTYPE html>\r\n<HTML><HEAD>\n<i></i>\r\n<title>t</title>\r\n</HEAD>\r\n<BODY>\r\n<p>x</p>\r\n</BODY></HTML>\r\n",
			),
			(
				InjectPosition::HeadEnd,
				"<!DOCTYPE html>\r\n<HTML><HEAD>\r\n<title>t</title>\r\n<i></i>\n</HEAD>\r\n<BODY>\r\n<p>x</p>\r\n</BODY></HTML>\r\n",
			),
			(
				InjectPosition::BodyStart,
				"<!DOCTYPE html>\r\n<HTML><HEAD>\r\n<title>t</title>\r\n</HEAD>\r\n<BODY>\n<i></i>\r\n<p>x</p>\r\n</BODY></HTML>\r\n",
			),
			(
				InjectPosition::BodyEnd,
				"<!DOCTYPE html>\r\n<HTML><HEAD>\r\n<title>t</title>\r\n</HEAD>\r\n<BODY>\r\n<p>x</p>\r\n<i></i>\n</BODY></HTML>\r\n",
			),
		];
		for (position, expected) in cases {
			assert_eq!(
				apply_to_text(TEXT_DOC, &at(position), Phase::Build).as_deref(),
				Some(expected),
				"{position:?}"
			);
		}
	}

	#[test]
	fn text_takes_the_tags_with_attributes_and_in_any_case() {
		let doc = "<html lang=ja><head data-x=\"a>b\"><title>t</title></head></html>";
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::HeadStart), Phase::Build).as_deref(),
			Some("<html lang=ja><head data-x=\"a>b\">\n<i></i><title>t</title></head></html>")
		);
	}

	#[test]
	fn text_follows_the_mode_of_the_phase() {
		let serve = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Serve,
			"<i></i>",
		)];
		assert!(apply_to_text(DOC, &serve, Phase::Serve).is_some());
		assert!(apply_to_text(DOC, &serve, Phase::Build).is_none());
		let both = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			"<i></i>",
		)];
		assert!(apply_to_text(DOC, &both, Phase::Serve).is_some());
		assert!(apply_to_text(DOC, &both, Phase::Build).is_some());
	}

	#[test]
	fn text_without_the_target_or_a_document_is_none() {
		assert_eq!(
			apply_to_text("<p>x</p>", &at(InjectPosition::HeadEnd), Phase::Build),
			None
		);
		assert_eq!(
			apply_to_text(
				"<html><head></head></html>",
				&at(InjectPosition::BodyEnd),
				Phase::Build
			),
			None
		);
		assert_eq!(
			apply_to_text("<html><body></body></html>", &[], Phase::Build),
			None
		);
		let empty = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "")];
		assert_eq!(apply_to_text(DOC, &empty, Phase::Build), None);
	}

	#[test]
	fn text_that_already_has_the_markup_in_the_target_is_none() {
		let doc = "<html><head><i></i></head><body></body></html>";
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::HeadEnd), Phase::Build),
			None
		);
		// The same markup in the other element is not a duplicate.
		assert!(apply_to_text(doc, &at(InjectPosition::BodyEnd), Phase::Build).is_some());
	}

	#[test]
	fn text_does_not_take_a_tag_inside_a_comment_a_script_a_style_or_a_textarea() {
		let doc = "<html><head><!-- </head> --><script>document.write(\"</head>\")</script><style>/* </head> */</style><title>t</title></head><body><!-- <body> --><textarea></body></textarea><script>x='</body>'</script><p>x</p></body></html>";
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::HeadEnd), Phase::Build).as_deref(),
			Some(
				"<html><head><!-- </head> --><script>document.write(\"</head>\")</script><style>/* </head> */</style><title>t</title><i></i>\n</head><body><!-- <body> --><textarea></body></textarea><script>x='</body>'</script><p>x</p></body></html>"
			)
		);
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::BodyEnd), Phase::Build).as_deref(),
			Some(
				"<html><head><!-- </head> --><script>document.write(\"</head>\")</script><style>/* </head> */</style><title>t</title></head><body><!-- <body> --><textarea></body></textarea><script>x='</body>'</script><p>x</p><i></i>\n</body></html>"
			)
		);
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::BodyStart), Phase::Build).as_deref(),
			Some(
				"<html><head><!-- </head> --><script>document.write(\"</head>\")</script><style>/* </head> */</style><title>t</title></head><body>\n<i></i><!-- <body> --><textarea></body></textarea><script>x='</body>'</script><p>x</p></body></html>"
			)
		);
	}

	#[test]
	fn text_a_quote_opens_a_value_only_after_an_equal_sign() {
		let doc = "<body onload=init() data-t=it's class = \"a>b\"><p>x</p></body>";
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::BodyStart), Phase::Build).as_deref(),
			Some("<body onload=init() data-t=it's class = \"a>b\">\n<i></i><p>x</p></body>")
		);
	}

	#[test]
	fn text_and_tree_agree_that_a_white_space_only_injection_is_written() {
		let i = [Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "  ")];
		assert!(run(DOC, &i, Phase::Build).contains("<title>t</title>  </head>"));
		assert_eq!(
			apply_to_text(DOC, &i, Phase::Build).as_deref(),
			Some(
				"<!doctype html><html><head><title>t</title>  \n</head><body><p>x</p></body></html>"
			)
		);
	}

	#[test]
	fn text_with_multi_byte_characters_around_what_is_blanked_keeps_every_byte() {
		let doc = "\u{feff}<html><head><title>日本語</title><!-- 日本語 --><script>\"日本語</head>\"</script></head><body><textarea>日本語</body></textarea><p>日本語</p></body></html>";
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::HeadEnd), Phase::Build).as_deref(),
			Some(
				"\u{feff}<html><head><title>日本語</title><!-- 日本語 --><script>\"日本語</head>\"</script><i></i>\n</head><body><textarea>日本語</body></textarea><p>日本語</p></body></html>"
			)
		);
		assert_eq!(
			apply_to_text(doc, &at(InjectPosition::BodyEnd), Phase::Build).as_deref(),
			Some(
				"\u{feff}<html><head><title>日本語</title><!-- 日本語 --><script>\"日本語</head>\"</script></head><body><textarea>日本語</body></textarea><p>日本語</p><i></i>\n</body></html>"
			)
		);
	}

	#[test]
	fn text_with_an_unterminated_comment_or_raw_text_element_finds_no_end_tag() {
		for doc in [
			"<html><head></head><body><!-- </body></html>",
			"<html><head></head><body><script>x </body></html>",
			"<html><head></head><body><style>x </body></html>",
			"<html><head></head><body><textarea>x </body></html>",
		] {
			assert_eq!(
				apply_to_text(doc, &at(InjectPosition::BodyEnd), Phase::Build),
				None,
				"{doc}"
			);
		}
	}

	#[test]
	fn text_takes_the_raw_text_elements_in_any_case_and_with_a_greater_than_in_an_attribute() {
		let upper = "<HTML><BODY><SCRIPT>'</BODY>'</SCRIPT><STYLE></BODY></STYLE><TEXTAREA></BODY></TEXTAREA><P></BODY></HTML>";
		assert!(
			apply_to_text(upper, &at(InjectPosition::BodyEnd), Phase::Build)
				.is_some_and(|out| out.ends_with("<P><i></i>\n</BODY></HTML>"))
		);
		let attribute = "<head><script data-x=\"a>b\"></head></script><title>t</title></head>";
		assert_eq!(
			apply_to_text(attribute, &at(InjectPosition::HeadEnd), Phase::Build).as_deref(),
			Some("<head><script data-x=\"a>b\"></head></script><title>t</title><i></i>\n</head>")
		);
	}

	#[test]
	fn text_does_not_take_a_tag_whose_name_only_starts_like_the_one_it_wants() {
		assert_eq!(
			apply_to_text(
				"<html><body><header></header></body></html>",
				&at(InjectPosition::HeadStart),
				Phase::Build
			),
			None
		);
		// `</header>` does not end `<head>`; the white space before `>` is allowed.
		assert_eq!(
			apply_to_text(
				"<head></header></head >",
				&at(InjectPosition::HeadEnd),
				Phase::Build
			)
			.as_deref(),
			Some("<head></header><i></i>\n</head >")
		);
		// A start tag that never ends.
		assert_eq!(
			apply_to_text(
				"<html><head data-x=\"a",
				&at(InjectPosition::HeadEnd),
				Phase::Build
			),
			None
		);
	}

	#[test]
	fn text_that_has_the_markup_only_in_a_comment_or_a_script_still_gets_it() {
		let markup = "<link rel=\"x\" href=\"/a.css\">";
		let i = [Inject::new(
			InjectPosition::HeadEnd,
			InjectMode::Both,
			markup,
		)];
		let commented = format!("<html><head><!-- {markup} --></head></html>");
		assert_eq!(
			apply_to_text(&commented, &i, Phase::Build).as_deref(),
			Some(format!("<html><head><!-- {markup} -->{markup}\n</head></html>").as_str())
		);
		let scripted = format!("<html><head><script>x='{markup}'</script></head></html>");
		assert!(apply_to_text(&scripted, &i, Phase::Build).is_some());
		let written = format!("<html><head>{markup}<!-- {markup} --></head></html>");
		assert_eq!(apply_to_text(&written, &i, Phase::Build), None);
	}

	#[test]
	fn text_takes_several_injections_in_order() {
		let i = [
			Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "<a></a>"),
			Inject::new(InjectPosition::HeadEnd, InjectMode::Both, "<b></b>"),
			Inject::new(InjectPosition::BodyEnd, InjectMode::Both, "<c></c>"),
		];
		assert_eq!(
			apply_to_text(DOC, &i, Phase::Build).as_deref(),
			Some(
				"<!doctype html><html><head><title>t</title><a></a>\n<b></b>\n</head><body><p>x</p><c></c>\n</body></html>"
			)
		);
	}
}
