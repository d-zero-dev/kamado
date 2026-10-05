//! Serializer: the markup linkedom produced from a tree, so that a tree
//! built by the parser prints the way v2's intermediate HTML did.
//!
//! The rules, all taken from linkedom's `toString` implementations:
//! - Text is escaped for `&`, `<`, `>` and U+00A0 (as `&#160;`); nothing else.
//! - Attribute values escape only `"` (as `&quot;`); `&`, `<`, `>` stay raw.
//! - An empty attribute whose name is in the HTML boolean/empty set prints as
//!   the bare name; any other empty attribute prints as `name=""`.
//! - An empty `id`, `class` or `style` is dropped entirely.
//! - Void elements print `<br>`; an empty SVG element prints `<path />`.
//! - Comments print verbatim; processing instructions print verbatim.
//!
//! Departures from linkedom: the content of `<script>`, `<style>`,
//! `<textarea>`, `<title>` and `<xmp>` is written raw and never goes through
//! a string splice (linkedom injected the text at the first `><` of the
//! start tag, which broke on an attribute value containing `><`), and `<xmp>`
//! is raw like the others (linkedom escaped it).

use crate::dom::{Document, Element, NodeId, NodeKind, ROOT};
use crate::entities::Entities;

/// Attribute names that print bare when their value is empty.
fn is_empty_attribute(name: &str) -> bool {
	matches!(
		name,
		"allowfullscreen"
			| "allowpaymentrequest"
			| "async" | "autofocus"
			| "autoplay"
			| "checked"
			| "class" | "contenteditable"
			| "controls"
			| "default"
			| "defer" | "disabled"
			| "draggable"
			| "formnovalidate"
			| "hidden"
			| "id" | "ismap"
			| "itemscope"
			| "loop" | "multiple"
			| "muted" | "nomodule"
			| "novalidate"
			| "open" | "playsinline"
			| "readonly"
			| "required"
			| "reversed"
			| "selected"
			| "style" | "truespeed"
	)
}

/// Void elements for the serializer. This is not the parser's list:
/// `menuitem` is void here but not there, `basefont`, `frame`, `command` and
/// `isindex` are void there but not here.
fn is_serializer_void(name: &str) -> bool {
	matches!(
		name,
		"area"
			| "base" | "br"
			| "col" | "embed"
			| "hr" | "img"
			| "input" | "keygen"
			| "link" | "menuitem"
			| "meta" | "param"
			| "source"
			| "track" | "wbr"
	)
}

/// Elements whose content is written as raw text: `script`, `style`,
/// `textarea` and `title`, unless they were created inside an `<svg>` (there
/// they are ordinary elements and their text is escaped, as in linkedom, which
/// builds them as plain SVG elements). `xmp` is not one of them: linkedom
/// escapes its text like any other element's.
#[must_use]
pub fn is_raw_text_element(element: &Element) -> bool {
	!element.svg
		&& matches!(
			element.name.as_str(),
			"script" | "style" | "textarea" | "title"
		)
}

/// The text of all descendant text nodes, in order. A raw-text element
/// prints only this: element children (which only the page glue can add, e.g.
/// a `<head>` inserted into a root that is a `<style>`) and comments do not
/// show, as with linkedom's `textContent`-based serialization.
fn raw_text_content(doc: &Document, id: NodeId) -> String {
	let mut out = String::new();
	let mut stack: Vec<NodeId> = doc.children(id).collect();
	stack.reverse();
	while let Some(node) = stack.pop() {
		match doc.kind(node) {
			NodeKind::Text(t) => out.push_str(t),
			NodeKind::Element(_) => {
				let mut children: Vec<NodeId> = doc.children(node).collect();
				children.reverse();
				stack.extend(children);
			}
			_ => {}
		}
	}
	out
}

/// Escapes text content: `&`, `<`, `>` and U+00A0.
///
/// # Example
///
/// ```
/// assert_eq!(kd_html::serialize::escape_text("a & <b>\u{A0}"), "a &amp; &lt;b&gt;&#160;");
/// ```
#[must_use]
pub fn escape_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	push_escaped_text(text, &mut out);
	out
}

fn push_escaped_text(text: &str, out: &mut String) {
	let mut last = 0;
	for (i, c) in text.char_indices() {
		let rep = match c {
			'&' => "&amp;",
			'<' => "&lt;",
			'>' => "&gt;",
			'\u{A0}' => "&#160;",
			_ => continue,
		};
		out.push_str(&text[last..i]);
		out.push_str(rep);
		last = i + c.len_utf8();
	}
	out.push_str(&text[last..]);
}

/// Prints one attribute (with a leading space), or nothing for an empty
/// `id`, `class` or `style`.
fn push_attribute(name: &str, value: &str, ent: &Entities, out: &mut String) {
	if value.is_empty() {
		if is_empty_attribute(name) {
			if matches!(name, "id" | "class" | "style") {
				return;
			}
			out.push(' ');
			out.push_str(name);
			return;
		}
		out.push(' ');
		out.push_str(name);
		out.push_str("=\"\"");
		return;
	}
	out.push(' ');
	out.push_str(name);
	out.push_str("=\"");
	let mut quoted = String::with_capacity(value.len());
	for c in value.chars() {
		if c == '"' {
			quoted.push_str("&quot;");
		} else {
			quoted.push(c);
		}
	}
	if ent.is_none() {
		out.push_str(&quoted);
	} else {
		out.push_str(&ent.apply(&quoted));
	}
	out.push('"');
}

/// A step of the iterative walk: why it is not recursive: a page can nest as
/// deeply as its markup does (unclosed `<font>`s add up), and recursion would
/// overflow the stack of a worker thread long before any realistic limit.
enum Work<'a> {
	Visit(NodeId),
	Close(&'a str),
}

fn push_children_reversed<'a>(doc: &'a Document, id: NodeId, stack: &mut Vec<Work<'a>>) {
	let mut child = doc.last_child(id);
	while let Some(c) = child {
		stack.push(Work::Visit(c));
		child = doc.prev_sibling(c);
	}
}

/// Writes `id` and everything below it. `parent_raw` tells a starting text
/// node that its parent is a raw-text element.
fn push_node(doc: &Document, id: NodeId, parent_raw: bool, ent: &Entities, out: &mut String) {
	let mut stack: Vec<Work<'_>> = vec![Work::Visit(id)];
	let mut starting = true;
	while let Some(work) = stack.pop() {
		let node = match work {
			Work::Close(name) => {
				out.push_str("</");
				out.push_str(name);
				out.push('>');
				continue;
			}
			Work::Visit(node) => node,
		};
		let raw_parent = std::mem::take(&mut starting) && parent_raw;
		match doc.kind(node) {
			NodeKind::Document => push_children_reversed(doc, node, &mut stack),
			NodeKind::Text(t) => {
				let mut text = String::new();
				if raw_parent {
					text.push_str(t);
				} else {
					push_escaped_text(t, &mut text);
				}
				// The content of script, style and xmp is code or plain text
				// where a character reference would not be decoded, so it is
				// never rewritten. title and textarea decode references.
				if ent.is_none() || (raw_parent && !parent_decodes_references(doc, node)) {
					out.push_str(&text);
				} else {
					out.push_str(&ent.apply(&text));
				}
			}
			NodeKind::Comment(c) => {
				out.push_str("<!--");
				out.push_str(&ent.apply(c));
				out.push_str("-->");
			}
			NodeKind::ProcessingInstruction(raw) => out.push_str(raw),
			NodeKind::Doctype(d) => {
				out.push_str("<!DOCTYPE ");
				out.push_str(&d.name);
				if !d.public_id.is_empty() {
					out.push_str(" PUBLIC \"");
					out.push_str(&d.public_id);
					out.push('"');
				}
				if !d.system_id.is_empty() {
					if d.public_id.is_empty() {
						out.push_str(" SYSTEM");
					}
					out.push_str(" \"");
					out.push_str(&d.system_id);
					out.push('"');
				}
				out.push('>');
			}
			NodeKind::Element(e) => {
				out.push('<');
				out.push_str(&e.name);
				for a in &e.attrs {
					push_attribute(&a.name, &a.value, ent, out);
				}
				if is_raw_text_element(e) {
					out.push('>');
					let text = raw_text_content(doc, node);
					if !ent.is_none() && matches!(e.name.as_str(), "title" | "textarea") {
						out.push_str(&ent.apply(&text));
					} else {
						out.push_str(&text);
					}
					out.push_str("</");
					out.push_str(&e.name);
					out.push('>');
				} else if doc.first_child(node).is_none() {
					if e.svg {
						out.push_str(" />");
					} else if is_serializer_void(&e.name) {
						out.push('>');
					} else {
						out.push_str("></");
						out.push_str(&e.name);
						out.push('>');
					}
				} else {
					out.push('>');
					stack.push(Work::Close(&e.name));
					push_children_reversed(doc, node, &mut stack);
				}
			}
		}
	}
}

/// Whether the parent of the text node `id` decodes character references
/// (`title`, `textarea`) as opposed to `script`, `style` and `xmp`.
fn parent_decodes_references(doc: &Document, id: NodeId) -> bool {
	doc.parent(id)
		.and_then(|p| doc.element(p))
		.is_some_and(|p| matches!(p.name.as_str(), "title" | "textarea"))
}

/// How the serializer writes.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Options {
	/// Which characters become character references.
	pub entities: Entities,
}

/// The markup of `id` including the node itself.
///
/// # Example
///
/// ```
/// let doc = kd_html::parser::parse("<p class=\"a  b\">x &amp; y</p>");
/// let p = doc.first_child(kd_html::dom::ROOT).unwrap();
/// assert_eq!(kd_html::serialize::outer_html(&doc, p), "<p class=\"a b\">x &amp; y</p>");
/// ```
#[must_use]
pub fn outer_html(doc: &Document, id: NodeId) -> String {
	outer_html_with(doc, id, &Options::default())
}

/// [`outer_html`] with options.
#[must_use]
pub fn outer_html_with(doc: &Document, id: NodeId, options: &Options) -> String {
	let mut out = String::new();
	let parent_raw = doc
		.parent(id)
		.and_then(|p| doc.element(p))
		.is_some_and(is_raw_text_element);
	push_node(doc, id, parent_raw, &options.entities, &mut out);
	out
}

/// The markup of the children of `id`.
#[must_use]
pub fn inner_html(doc: &Document, id: NodeId) -> String {
	inner_html_with(doc, id, &Options::default())
}

/// [`inner_html`] with options.
#[must_use]
pub fn inner_html_with(doc: &Document, id: NodeId, options: &Options) -> String {
	let mut out = String::new();
	if doc.element(id).is_some_and(is_raw_text_element) {
		return raw_text_content(doc, id);
	}
	for child in doc.children(id) {
		push_node(doc, child, false, &options.entities, &mut out);
	}
	out
}

/// The whole document: all children of the root.
#[must_use]
pub fn document_html(doc: &Document) -> String {
	inner_html(doc, ROOT)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::entities::Entities;
	use crate::parser::parse;

	fn rt(src: &str) -> String {
		document_html(&parse(src))
	}

	#[test]
	fn text_escaping_is_amp_lt_gt_and_nbsp_only() {
		assert_eq!(rt("a & b < c > d"), "a &amp; b &lt; c &gt; d");
		assert_eq!(rt("<p>a&nbsp;b&#160;c</p>"), "<p>a&#160;b&#160;c</p>");
		assert_eq!(rt("&copy; \"q\" 'a'"), "© \"q\" 'a'");
		assert_eq!(rt("<p>&lt;b&gt; &amp;</p>"), "<p>&lt;b&gt; &amp;</p>");
	}

	#[test]
	fn attribute_values_escape_only_the_double_quote() {
		assert_eq!(
			rt("<a title='He said \"hi\"' alt=\"it's\">x</a>"),
			"<a title=\"He said &quot;hi&quot;\" alt=\"it's\">x</a>"
		);
		assert_eq!(
			rt("<a href=\"?a=1&b=2&amp;c=3\">x</a>"),
			"<a href=\"?a=1&b=2&c=3\">x</a>"
		);
		assert_eq!(
			rt("<a title=\"a<b>c&d\">x</a>"),
			"<a title=\"a<b>c&d\">x</a>"
		);
	}

	#[test]
	fn empty_and_boolean_attributes() {
		assert_eq!(
			rt("<div id=\"\" class=\"\" style=\"\" hidden=\"\" data-x data-y=\"\">x</div>"),
			"<div hidden data-x=\"\" data-y=\"\">x</div>"
		);
		assert_eq!(
			rt("<input disabled value='a\"b'>"),
			"<input disabled value=\"a&quot;b\">"
		);
		assert_eq!(
			rt("<input checked=\"checked\">"),
			"<input checked=\"checked\">"
		);
		assert_eq!(
			rt("<script async defer src=a.js></script>"),
			"<script async defer src=\"a.js\"></script>"
		);
		assert_eq!(
			rt("<p CLASS=\"\" HIDDEN=\"\">"),
			"<p CLASS=\"\" HIDDEN=\"\"></p>"
		);
		assert_eq!(rt("<p class=\"  \">x</p>"), "<p>x</p>");
	}

	#[test]
	fn void_elements_and_empty_elements() {
		assert_eq!(
			rt("<br><br/><img src=a.png alt=x>"),
			"<br><br><img src=\"a.png\" alt=\"x\">"
		);
		assert_eq!(rt("<div></div><span></span>"), "<div></div><span></span>");
		assert_eq!(
			rt("<basefont><frame><command><isindex><keygen><menuitem>x</menuitem><wbr><embed>"),
			"<basefont></basefont><frame></frame><command></command><isindex></isindex><keygen><menuitem>x</menuitem><wbr><embed>"
		);
	}

	#[test]
	fn svg_elements_use_a_self_closing_form_when_empty() {
		assert_eq!(
			rt("<svg viewBox=\"0 0 1 1\"><path d=\"M0\"/><circle r=1></circle></svg>"),
			"<svg viewBox=\"0 0 1 1\"><path d=\"M0\" /><circle r=\"1\" /></svg>"
		);
		assert_eq!(
			rt("<SVG viewBox=1><Path/></SVG>"),
			"<svg viewBox=\"1\"><path /></svg>"
		);
		assert_eq!(rt("<svg></svg>"), "<svg />");
	}

	#[test]
	fn raw_text_elements_inside_svg_are_ordinary_elements_whose_text_is_escaped() {
		assert_eq!(
			rt("<svg><script>a<b</script><style>p>q{}</style><title>a & b</title></svg>"),
			"<svg><script>a&lt;b</script><style>p&gt;q{}</style><title>a &amp; b</title></svg>"
		);
		assert_eq!(
			rt("<script>a<b</script><title>a & b</title>"),
			"<script>a<b</script><title>a & b</title>"
		);
	}

	#[test]
	fn a_raw_text_element_prints_only_its_text() {
		let mut doc = parse("<style>a{}</style>");
		let style = doc.first_child(ROOT).unwrap();
		let head = doc.create_element("head");
		doc.prepend_child(style, head);
		let comment = doc.create_comment("c");
		doc.append_child(style, comment);
		assert_eq!(
			document_html(&doc),
			"<style>a{}</style>",
			"element children and comments of a raw-text element do not show"
		);
		assert_eq!(inner_html(&doc, style), "a{}");
	}

	#[test]
	fn raw_text_elements_are_written_verbatim() {
		let src = "<script>if(a<b&&c>d){x=\"</div>\"}</script><style>a>b{}&amp;</style>";
		assert_eq!(rt(src), src);
		assert_eq!(
			rt("<textarea>&lt;b&gt; &amp;</textarea>"),
			"<textarea>&lt;b&gt; &amp;</textarea>"
		);
		// `<xmp>` is read as raw text but written with the usual escaping, as
		// linkedom does.
		assert_eq!(rt("<xmp><b>&amp;</xmp>"), "<xmp>&lt;b&gt;&amp;amp;</xmp>");
		// An attribute value containing `><` no longer swallows the content.
		assert_eq!(
			rt("<script src=\"a>b\" data-x=\"><\">x</script>"),
			"<script src=\"a>b\" data-x=\"><\">x</script>"
		);
		// Escaped, unlike the raw-text elements.
		assert_eq!(
			rt("<noscript><b>&amp;</b></noscript>"),
			"<noscript><b>&amp;</b></noscript>"
		);
		assert_eq!(rt("<iframe>a&lt;b</iframe>"), "<iframe>a&lt;b</iframe>");
	}

	#[test]
	fn comments_cdata_declarations_and_doctype() {
		assert_eq!(rt("<!-- c --><!----><!-->x"), "<!-- c --><!----><!---->x");
		assert_eq!(rt("<![CDATA[x<y]]>"), "<!--[CDATA[x<y]]-->");
		assert_eq!(rt("<!-- unclosed"), "<!-- unclosed-->");
		assert_eq!(rt("<!doctype html>x"), "<!DOCTYPE html>x");
		assert_eq!(rt("<!ELEMENT a>y"), "y");
		assert_eq!(
			rt("<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0//EN\" \"http://example.com/x.dtd\">"),
			"<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0//EN\" \"http://example.com/x.dtd\">"
		);
		assert_eq!(
			rt("<!DOCTYPE note SYSTEM \"note.dtd\">"),
			"<!DOCTYPE note SYSTEM \"note.dtd\">"
		);
	}

	#[test]
	fn processing_instructions_round_trip() {
		assert_eq!(rt("<?php echo $a->b; ?>text"), "<?php echo $a->b; ?>text");
		assert_eq!(
			rt("<div><?php include('x.php'); ?><p>a</p></div>"),
			"<div><?php include('x.php'); ?><p>a</p></div>"
		);
		assert_eq!(
			rt("<a class=\"<?php echo $c; ?>\" href=\"<?= $url ?>\">x</a>"),
			"<a class=\"<?php echo $c; ?>\" href=\"<?= $url ?>\">x</a>"
		);
	}

	#[test]
	fn inner_and_outer_html_of_a_subtree() {
		let doc = parse("<ul><li>a</li><li class=\"x\">b</li></ul>");
		let ul = doc.first_child(ROOT).unwrap();
		assert_eq!(inner_html(&doc, ul), "<li>a</li><li class=\"x\">b</li>");
		let second = doc.last_child(ul).unwrap();
		assert_eq!(outer_html(&doc, second), "<li class=\"x\">b</li>");
		let script_doc = parse("<script>a<b</script>");
		let script = script_doc.first_child(ROOT).unwrap();
		assert_eq!(inner_html(&script_doc, script), "a<b");
		let text = script_doc.first_child(script).unwrap();
		assert_eq!(
			outer_html(&script_doc, text),
			"a<b",
			"a text node under script is raw"
		);
	}

	#[test]
	fn multibyte_content_round_trips() {
		assert_eq!(
			rt("<p title=\"日本語\">こんにちは &amp; é</p>"),
			"<p title=\"日本語\">こんにちは &amp; é</p>"
		);
	}

	fn with_entities(src: &str, entities: Entities) -> String {
		let doc = parse(src);
		inner_html_with(&doc, ROOT, &Options { entities })
	}

	#[test]
	fn entities_all_rewrites_text_attributes_and_comments() {
		assert_eq!(
			with_entities("<p title=\"é\">© 日本 <!-- — --></p>", Entities::All),
			"<p title=\"&eacute;\">&copy; 日本 <!-- &mdash; --></p>"
		);
	}

	#[test]
	fn entities_leave_script_and_style_alone_but_not_title_textarea_or_xmp() {
		let src = "<script>var s = \"©\";</script><style>a::after{content:\"©\"}</style><xmp>©</xmp><title>©</title><textarea>©</textarea>";
		assert_eq!(
			with_entities(src, Entities::All),
			"<script>var s = \"©\";</script><style>a::after{content:\"©\"}</style><xmp>&copy;</xmp><title>&copy;</title><textarea>&copy;</textarea>"
		);
	}

	#[test]
	fn custom_entities_replace_only_the_listed_characters() {
		let custom = Entities::Custom(vec![('©', "&#169;".to_owned())]);
		assert_eq!(with_entities("<p>© é</p>", custom), "<p>&#169; é</p>");
		assert_eq!(
			with_entities("<p>© é</p>", Entities::Custom(vec![])),
			"<p>© é</p>"
		);
	}

	#[test]
	fn entities_apply_after_escaping_so_ampersands_stay_valid() {
		assert_eq!(
			with_entities("<p>a & é</p>", Entities::All),
			"<p>a &amp; &eacute;</p>"
		);
		assert_eq!(
			with_entities("<p title='\"é'>x</p>", Entities::All),
			"<p title=\"&quot;&eacute;\">x</p>"
		);
	}

	#[test]
	fn title_text_is_decoded_and_printed_unescaped_like_v2() {
		assert_eq!(rt("<title>A &amp; B</title>"), "<title>A & B</title>");
		assert_eq!(
			rt("<title>a &lt;c&gt; &quot;q&quot;</title>"),
			"<title>a <c> \"q\"</title>"
		);
		assert_eq!(
			rt("<title>Q&amp;A &copy; 日本</title>"),
			"<title>Q&A © 日本</title>"
		);
		assert_eq!(rt("<title>a & b</title>"), "<title>a & b</title>");
	}

	#[test]
	fn title_references_that_would_change_meaning_stay_as_written() {
		// `&amp;copy` is the text `&copy`; written raw it would show as a copyright sign.
		assert_eq!(rt("<title>&amp;copy</title>"), "<title>&amp;copy</title>");
		assert_eq!(
			rt("<title>x &amp;lt; y</title>"),
			"<title>x &amp;lt; y</title>"
		);
		assert_eq!(rt("<title>&amp;#65;</title>"), "<title>&amp;#65;</title>");
		// `&lt;/title&gt;` would otherwise become a tag that ends the title.
		assert_eq!(
			rt("<title>a&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;</title>"),
			"<title>a&lt;/title><script>alert(1)</script></title>"
		);
	}

	#[test]
	fn a_doctype_in_the_middle_of_a_fragment_keeps_the_content_around_it() {
		// linkedom drops everything except the doctype; that is data loss.
		assert_eq!(
			document_html(&parse("<p>a</p><!doctype html><p>b</p>")),
			"<!DOCTYPE html><p>a</p><p>b</p>"
		);
	}
}
