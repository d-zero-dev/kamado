//! The minifier on the tree: what [`super::minify`] does to the attributes of
//! every element and to the text of `<script>` and `<style>`, done before the
//! page is serialized and formatted instead of by parsing the formatted text
//! again.
//!
//! It runs the minifier's own decisions (`Minifier::normalize_attr` and the
//! hooks), so which attribute goes, which value is tidied and which code is
//! handed to the hooks is the same. What it leaves to other stages, because
//! they are not decisions about one element:
//!
//! - the quotes of an attribute and how a quote inside a value is written (the
//!   serializer writes `"` and `&quot;`, the minifier chose the quote that
//!   needed fewer escapes and wrote `&#34;` / `&#39;`);
//! - the minifier parser's repairs of broken markup (a `<colgroup>` around a
//!   bare `<col>`, `<br />` losing its slash, unclosed elements closed): the
//!   tree is already well formed, and the printer writes void elements;
//! - the closing tag of an element the minifier reads as empty (`</frame>`,
//!   `</basefont>`, `</isindex>`; [`super::is_empty_element`]): the serializer
//!   writes it, as linkedom does, and the formatter
//!   (`print::Options::empty_like_minifier`) or, without it,
//!   [`super::strip_empty_element_end_tags`] leaves it out;
//! - an empty boolean attribute written bare: the serializer does that
//!   (`Options::bare_booleans`).
//!
//! Why the code of `<script>` and `<style>` is minified here and not after the
//! formatter: it is the text of one node, and the printer (with `hug_script` /
//! `hug_style`) writes it where it stands, as the minifier did.

use std::cell::RefCell;

use super::{
	Attr, FILL_ATTRS, Hooks, Minifier, Options, in_ci, is_boolean_attribute, is_executable_script,
	is_style_sheet,
};
use crate::dom::{Attr as DomAttr, Document, NodeId, NodeKind, ROOT};

/// Minifies the attributes and the code of `doc` in place; the result is what
/// the hooks could not minify (kept as it was, the page is minified all the
/// same), in document order.
///
/// It cannot fail: the one place where `html-minifier-terser` throws, a
/// `<meta>` with an `http-equiv` that has no value, cannot be told from an
/// empty one in the tree, and the serializer writes it `http-equiv=""`, which
/// the minifier read without a throw even when it ran on the serialized text.
///
/// # Example
///
/// ```
/// use kd_html::minify::{apply_to_dom, NoMinification, Options};
/// use kd_html::page::Page;
///
/// let mut page = Page::parse("<input disabled=\"disabled\" type=\"text\">");
/// apply_to_dom(&mut page.doc, &Options::default(), &NoMinification);
/// let options = kd_html::serialize::Options {
///     bare_booleans: true,
///     ..Default::default()
/// };
/// assert_eq!(page.serialize_with(&options), "<input disabled>");
/// ```
pub fn apply_to_dom(doc: &mut Document, options: &Options, hooks: &dyn Hooks) -> Vec<String> {
	let mut m = Minifier {
		options,
		hooks,
		buffer: Vec::new(),
		current_tag: String::new(),
		current_attrs: Vec::new(),
		svg_depth: 0,
		stack: Vec::new(),
		last_tag: String::new(),
		failure: RefCell::new(None),
		hook_failures: RefCell::new(Vec::new()),
		fragments: &[],
		fragment_uid: "",
	};
	for id in elements_in_order(doc) {
		let edit = minify_element(doc, id, &mut m);
		if let Some(element) = doc.element_mut(edit.element) {
			element.attrs = edit.attrs;
		}
		for (node, text) in edit.texts {
			*doc.kind_mut(node) = NodeKind::Text(text);
		}
	}
	m.hook_failures.into_inner()
}

/// What one element becomes: its attributes and the text of its children.
struct Edit {
	element: NodeId,
	attrs: Vec<DomAttr>,
	texts: Vec<(NodeId, String)>,
}

/// The elements of the tree, in document order (an iterative walk: a page can
/// nest as deeply as its markup does).
fn elements_in_order(doc: &Document) -> Vec<NodeId> {
	let mut found = Vec::new();
	let mut stack = vec![ROOT];
	while let Some(id) = stack.pop() {
		if matches!(doc.kind(id), NodeKind::Element(_)) {
			found.push(id);
		}
		let mut child = doc.last_child(id);
		while let Some(c) = child {
			stack.push(c);
			child = doc.prev_sibling(c);
		}
	}
	found
}

fn minify_element(doc: &Document, id: NodeId, m: &mut Minifier<'_>) -> Edit {
	let Some(element) = doc.element(id) else {
		return Edit {
			element: id,
			attrs: Vec::new(),
			texts: Vec::new(),
		};
	};
	m.svg_depth = usize::from(element.svg);
	let tag = m.name(&element.name);
	// Most elements have no attributes and are not code: nothing to copy.
	if element.attrs.is_empty() && !matches!(tag.as_str(), "script" | "style") {
		return Edit {
			element: id,
			attrs: Vec::new(),
			texts: Vec::new(),
		};
	}
	// A bare attribute of the fill list has its own name for a value, as the
	// minifier's parser reads it; the tree holds both `x` and `x=""` as "".
	let context: Vec<Attr> = element
		.attrs
		.iter()
		.map(|a| Attr {
			name: a.name.clone(),
			value: Some(if a.value.is_empty() && in_ci(FILL_ATTRS, &a.name) {
				a.name.clone()
			} else {
				a.value.clone()
			}),
		})
		.collect();
	let attrs: Vec<DomAttr> = context
		.iter()
		.filter_map(|a| m.normalize_attr(a, &context, &tag))
		.map(|n| {
			let collapsed = m.options.collapse_boolean_attributes
				&& n.value.as_ref().is_some_and(|v| {
					is_boolean_attribute(&n.name.to_lowercase(), &v.to_lowercase())
				});
			DomAttr {
				value: if collapsed {
					String::new()
				} else {
					n.value.unwrap_or_default()
				},
				name: n.name,
			}
		})
		.collect();
	let mut edit = Edit {
		element: id,
		attrs,
		texts: Vec::new(),
	};

	let code = if is_executable_script(&tag, &context) && m.options.minify_js {
		Code::Js
	} else if is_style_sheet(&tag, &context) && m.options.minify_css {
		Code::Css
	} else {
		return edit;
	};
	for child in doc.children(id) {
		if let NodeKind::Text(text) = doc.kind(child) {
			let minified = match code {
				Code::Js => m.through_hook(
					text,
					|hooks, text| hooks.js(text, false),
					|| "a <script>".to_owned(),
				),
				Code::Css => m.through_hook(
					text,
					|hooks, text| hooks.css(text, super::CssKind::Block),
					|| "a <style>".to_owned(),
				),
			};
			edit.texts.push((child, minified));
		}
	}
	edit
}

enum Code {
	Js,
	Css,
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::minify::{CssKind, NoMinification};
	use crate::page::Page;
	use crate::serialize::Options as Serialize;

	/// Prefixes what a hook was asked for, so that its work shows.
	struct Marking;

	impl Hooks for Marking {
		fn css(&self, text: &str, kind: CssKind) -> Result<String, String> {
			Ok(format!("css:{kind:?}:{}", text.trim()))
		}
		fn js(&self, text: &str, inline: bool) -> Result<String, String> {
			if text.contains("broken") {
				return Err("cannot read it".to_owned());
			}
			Ok(format!("js:{inline}:{}", text.trim()))
		}
	}

	fn run(html: &str, options: &Options, hooks: &dyn Hooks) -> (String, Vec<String>) {
		let mut page = Page::parse(html);
		let failures = apply_to_dom(&mut page.doc, options, hooks);
		let out = page.serialize_with(&Serialize {
			bare_booleans: true,
			..Serialize::default()
		});
		(out, failures)
	}

	fn tidy(html: &str) -> String {
		run(html, &Options::default(), &NoMinification).0
	}

	#[test]
	fn redundant_and_boolean_attributes_go_and_collapse() {
		assert_eq!(
			tidy("<input disabled=\"disabled\" type=\"text\"><form method=\"get\"></form>"),
			"<input disabled><form></form>"
		);
		assert_eq!(
			tidy(
				"<script type=\"text/javascript\" src=\"a.js\"></script><link rel=\"stylesheet\" type=\"text/css\" href=\"a.css\">"
			),
			"<script src=\"a.js\"></script><link rel=\"stylesheet\" href=\"a.css\">"
		);
	}

	#[test]
	fn a_module_script_keeps_its_type_and_the_attribute_options_are_independent() {
		assert_eq!(
			tidy("<script type=\"module\">a()</script>"),
			"<script type=\"module\">a()</script>"
		);
		let only_booleans = Options {
			remove_redundant_attributes: false,
			remove_script_type_attributes: false,
			remove_style_link_type_attributes: false,
			..Options::default()
		};
		assert_eq!(
			run(
				"<input type=\"text\" checked=\"checked\"><script type=\"text/javascript\"></script>",
				&only_booleans,
				&NoMinification
			)
			.0,
			"<input type=\"text\" checked><script type=\"text/javascript\"></script>"
		);
	}

	#[test]
	fn values_are_tidied_and_names_are_lower_cased_outside_of_svg() {
		assert_eq!(
			tidy("<a HREF=\"  /x  \" CLASS=\"a   b\" Style=\" color : red ; \">t</a>"),
			"<a href=\"/x\" class=\"a b\" style=\"color : red;\">t</a>"
		);
		assert_eq!(
			tidy("<svg viewBox=\"0 0 1 1\"><path d=\"M0\"></path></svg>"),
			"<svg viewBox=\"0 0 1 1\"><path d=\"M0\" /></svg>"
		);
	}

	#[test]
	fn the_code_of_a_page_goes_through_the_hooks_where_the_minifier_gives_it_to_them() {
		let (out, failures) = run(
			"<p style=\"a:b\" onclick=\"go()\"></p><style>b{}</style><script>c()</script><script type=\"application/ld+json\">{}</script><script type=\"text/template\">t</script>",
			&Options::default(),
			&Marking,
		);
		assert_eq!(
			out,
			"<p style=\"css:Inline:a:b\" onclick=\"js:true:go()\"></p><style>css:Block:b{}</style><script>js:false:c()</script><script type=\"application/ld+json\">{}</script><script type=\"text/template\">t</script>"
		);
		assert!(failures.is_empty());
	}

	#[test]
	fn what_a_hook_cannot_minify_stays_and_is_reported_in_document_order() {
		let (out, failures) = run(
			"<script>broken(</script><p onclick=\"broken\"></p><script>fine()</script>",
			&Options::default(),
			&Marking,
		);
		assert_eq!(
			out,
			"<script>broken(</script><p onclick=\"broken\"></p><script>js:false:fine()</script>"
		);
		assert_eq!(
			failures,
			[
				"a <script>: cannot read it",
				"the onclick attribute of <p>: cannot read it"
			]
		);
	}

	#[test]
	fn the_code_options_leave_the_code_alone() {
		let options = Options {
			minify_css: false,
			minify_js: false,
			..Options::default()
		};
		let html = "<p style=\"a:b\"></p><style>b{}</style><script>c()</script>";
		assert_eq!(run(html, &options, &Marking).0, html);
	}

	#[test]
	fn a_meta_http_equiv_without_a_value_is_not_an_error_on_the_tree() {
		assert_eq!(
			tidy("<meta http-equiv content=\"x\"><input disabled=\"disabled\">"),
			"<meta http-equiv=\"\" content=\"x\"><input disabled>"
		);
	}
}
