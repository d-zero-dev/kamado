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

/// Elements whose text children are written without escaping.
#[must_use]
pub fn is_raw_text_element(name: &str) -> bool {
	matches!(name, "script" | "style" | "textarea" | "title" | "xmp")
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

fn push_node(doc: &Document, id: NodeId, parent_raw: bool, ent: &Entities, out: &mut String) {
	match doc.kind(id) {
		NodeKind::Document => push_children(doc, id, false, ent, out),
		NodeKind::Text(t) => {
			let mut text = String::new();
			if parent_raw {
				text.push_str(t);
			} else {
				push_escaped_text(t, &mut text);
			}
			// The content of script, style and xmp is code or plain text where
			// a character reference would not be decoded, so it is never
			// rewritten. title and textarea decode references.
			if ent.is_none() || (parent_raw && !parent_decodes_references(doc, id)) {
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
		NodeKind::Element(e) => push_element(doc, id, e, ent, out),
	}
}

fn push_children(doc: &Document, id: NodeId, parent_raw: bool, ent: &Entities, out: &mut String) {
	for child in doc.children(id) {
		push_node(doc, child, parent_raw, ent, out);
	}
}

/// Whether the parent of the text node `id` decodes character references
/// (`title`, `textarea`) as opposed to `script`, `style` and `xmp`.
fn parent_decodes_references(doc: &Document, id: NodeId) -> bool {
	doc.parent(id)
		.and_then(|p| doc.element(p))
		.is_some_and(|p| matches!(p.name.as_str(), "title" | "textarea"))
}

fn push_element(doc: &Document, id: NodeId, e: &Element, ent: &Entities, out: &mut String) {
	out.push('<');
	out.push_str(&e.name);
	for a in &e.attrs {
		push_attribute(&a.name, &a.value, ent, out);
	}
	if doc.first_child(id).is_none() {
		if e.svg {
			out.push_str(" />");
		} else if is_serializer_void(&e.name) {
			out.push('>');
		} else {
			out.push_str("></");
			out.push_str(&e.name);
			out.push('>');
		}
		return;
	}
	out.push('>');
	push_children(doc, id, is_raw_text_element(&e.name), ent, out);
	out.push_str("</");
	out.push_str(&e.name);
	out.push('>');
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
		.is_some_and(|p| is_raw_text_element(&p.name));
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
	let raw = doc
		.element(id)
		.is_some_and(|e| is_raw_text_element(&e.name));
	push_children(doc, id, raw, &options.entities, &mut out);
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
	fn raw_text_elements_are_written_verbatim() {
		let src = "<script>if(a<b&&c>d){x=\"</div>\"}</script><style>a>b{}&amp;</style>";
		assert_eq!(rt(src), src);
		assert_eq!(
			rt("<textarea>&lt;b&gt; &amp;</textarea>"),
			"<textarea>&lt;b&gt; &amp;</textarea>"
		);
		assert_eq!(
			rt("<title>a &amp; b &lt;c&gt;</title>"),
			"<title>a &amp; b &lt;c&gt;</title>"
		);
		assert_eq!(rt("<xmp><b>&amp;</xmp>"), "<xmp><b>&amp;</xmp>");
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
	fn entities_leave_script_style_and_xmp_alone_but_not_title_or_textarea() {
		let src = "<script>var s = \"©\";</script><style>a::after{content:\"©\"}</style><xmp>©</xmp><title>©</title><textarea>©</textarea>";
		assert_eq!(
			with_entities(src, Entities::All),
			"<script>var s = \"©\";</script><style>a::after{content:\"©\"}</style><xmp>©</xmp><title>&copy;</title><textarea>&copy;</textarea>"
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
}
