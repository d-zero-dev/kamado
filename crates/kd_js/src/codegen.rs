//! Applying the edits: TypeScript syntax becomes white space, module
//! specifiers are rewritten and JSX becomes calls to the runtime.
//!
//! Output shape for JSX (the runtime is in `packages/kamado-v3/src/jsx`):
//!
//! - A subtree with no dynamic part is one module-level constant,
//!   `const __kd_s0 = __kd_m("<p class=\"a\">b</p>")`, created once when the
//!   module loads.
//! - An ordinary element with dynamic parts is one concatenation:
//!   `__kd_m("<div" + __kd_a("className", x) + ">" + __kd_c(y) + "</div>")`.
//!   Static text and static attributes are folded into the string pieces.
//! - A component is `__kd_k(Card, { title: t, children: ... })`.
//! - Elements whose rendering depends on the document around them (`head`,
//!   `title`, `meta`, ...), and elements with spread attributes or
//!   `dangerouslySetInnerHTML`, go through the generic `__kd_el(tag, props,
//!   children)` of the runtime.

use std::collections::HashMap;

use crate::ast::{Edit, EditKind, JsxAttr, JsxChild, JsxElement, JsxTag};
use crate::lexer::{Kind, Lexer};
use crate::react_attrs;
use crate::strings;

/// Elements the runtime must render itself, because what they output (or
/// where) depends on context that only exists while rendering: the document
/// preamble of React 19 and form control state.
///
/// - `img` is here because React 19 emits a preload `<link>` for it (unless
///   it is `loading="lazy"`, which is decided at compile time below), and
///   `picture` / `noscript` because images inside them get none;
/// - `pre` and `listing` get an extra line break when their text starts with
///   one.
const RUNTIME_TAGS: [&str; 20] = [
	"html",
	"head",
	"body",
	"title",
	"meta",
	"link",
	"script",
	"style",
	"base",
	"noscript",
	"select",
	"option",
	"optgroup",
	"textarea",
	"img",
	"picture",
	"pre",
	"listing",
	"svg",
	"foreignObject",
];
const RUNTIME_TAGS_MORE: [&str; 3] = ["input", "form", "button"];

/// Elements whose children the runtime wants lazily (state set by the
/// parent, a form control's value, the picture scope or the SVG namespace,
/// is visible while the children are evaluated).
const LAZY_CHILDREN: [&str; 8] = [
	"html",
	"head",
	"select",
	"optgroup",
	"picture",
	"noscript",
	"svg",
	"foreignObject",
];

pub(crate) const IMPORT_NAMES: &str =
	"m as __kd_m, c as __kd_c, a as __kd_a, el as __kd_el, k as __kd_k";

pub(crate) struct Applier<'a> {
	pub src: &'a str,
	pub edits: Vec<Edit>,
	/// `const` declarations for static subtrees, in order of first use.
	pub hoisted: Vec<String>,
	cache: HashMap<String, usize>,
	pub uses_runtime: bool,
}

#[derive(Debug)]
enum Piece {
	/// HTML text (already escaped).
	Lit(String),
	/// A JavaScript expression that evaluates to an HTML string.
	Dyn(String),
}

enum Literal {
	Str(String),
	Num(String),
	Bool(bool),
	Null,
}

fn escape_html(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for c in text.chars() {
		match c {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			'\'' => out.push_str("&#x27;"),
			c => out.push(c),
		}
	}
	out
}

fn is_runtime_tag(tag: &str) -> bool {
	RUNTIME_TAGS.contains(&tag) || RUNTIME_TAGS_MORE.contains(&tag) || tag.contains('-')
}

impl<'a> Applier<'a> {
	pub(crate) fn new(src: &'a str, mut edits: Vec<Edit>) -> Applier<'a> {
		// Outermost first when ranges start together.
		edits.sort_by(|a, b| a.start.cmp(&b.start).then(b.end.cmp(&a.end)));
		Applier {
			src,
			edits,
			hoisted: Vec::new(),
			cache: HashMap::new(),
			uses_runtime: false,
		}
	}

	/// The hoisted constants, on one line.
	pub(crate) fn hoisted_constants(&self) -> String {
		self.hoisted.join(" ")
	}

	/// `import { ... } from "<runtime>";` and the hoisted constants, on one
	/// line so that line numbers of the rest do not move.
	pub(crate) fn prologue(&self, runtime: &str) -> String {
		let mut out = String::new();
		if self.uses_runtime {
			out.push_str(&format!(
				"import {{ {IMPORT_NAMES} }} from {};",
				strings::quote(runtime)
			));
			for h in &self.hoisted {
				out.push(' ');
				out.push_str(h);
			}
			out.push(' ');
		}
		out
	}

	/// The source between `start` and `end` with the edits inside applied.
	pub(crate) fn render(&mut self, start: usize, end: usize) -> String {
		let mut out = String::with_capacity(end - start);
		let mut cursor = start;
		let mut index = self.edits.partition_point(|e| e.start < start);
		while index < self.edits.len() && self.edits[index].start < end {
			let (e_start, e_end) = (self.edits[index].start, self.edits[index].end);
			if e_start < cursor || e_end > end {
				// Inside an edit that was already applied (or straddling the
				// range, which only happens for edits the caller made
				// obsolete).
				index += 1;
				continue;
			}
			out.push_str(&self.src[cursor..e_start]);
			let replacement = match self.edits[index].kind.clone() {
				EditKind::Erase => blank(&self.src[e_start..e_end]),
				EditKind::Replace(text) => text,
				EditKind::Jsx(element) => {
					let mut code = self.element_expression(&element);
					// Keep the line numbers of what follows.
					let newlines = self.src[e_start..e_end].matches('\n').count();
					code.push_str(&"\n".repeat(newlines));
					code
				}
			};
			out.push_str(&replacement);
			cursor = e_end;
			index += 1;
		}
		out.push_str(&self.src[cursor..end]);
		out
	}

	// ----- JSX -----

	/// A JavaScript expression for the element: a `Markup`.
	fn element_expression(&mut self, el: &JsxElement) -> String {
		self.uses_runtime = true;
		match &el.tag {
			JsxTag::Component(name) => self.component_call(name, el),
			JsxTag::Host(tag) if self.must_be_generic(tag, el) => self.generic_element(tag, el),
			_ => {
				let mut pieces = Vec::new();
				self.element_pieces(el, &mut pieces);
				self.pieces_expression(pieces)
			}
		}
	}

	fn must_be_generic(&self, tag: &str, el: &JsxElement) -> bool {
		// An image that is statically lazy never gets a preload hint.
		let lazy_image = tag == "img"
			&& el.attrs.iter().any(
				|a| matches!(a, JsxAttr::Str { name, value } if name == "loading" && value == "lazy"),
			);
		// React 19 keeps `<a href="">` but drops an empty `href` elsewhere: an
		// anchor whose `href` is not a plain non-empty string is the runtime's.
		let anchor_needs_runtime = tag == "a"
			&& el.attrs.iter().any(|a| match a {
				JsxAttr::Str { name, value } => name == "href" && value.is_empty(),
				JsxAttr::True { name } | JsxAttr::Expr { name, .. } => {
					name == "href" && !self.is_literal_nonempty_string(a)
				}
				JsxAttr::Spread { .. } => false,
			});
		(is_runtime_tag(tag) && !lazy_image)
			|| anchor_needs_runtime
			|| el.attrs.iter().any(|a| match a {
				JsxAttr::Spread { .. } => true,
				JsxAttr::Str { name, .. } | JsxAttr::True { name } | JsxAttr::Expr { name, .. } => {
					matches!(name.as_str(), "dangerouslySetInnerHTML" | "children")
				}
			})
	}

	/// Whether an attribute is `{"..."}` with a non-empty string literal.
	fn is_literal_nonempty_string(&self, attr: &JsxAttr) -> bool {
		match attr {
			JsxAttr::Expr { start, end, .. } => {
				matches!(self.literal(*start, *end), Some(Literal::Str(s)) if !s.is_empty())
			}
			_ => false,
		}
	}

	/// Appends the HTML of `el` to `out`. `el` is a fragment or an ordinary
	/// element; anything else becomes a dynamic piece.
	fn element_pieces(&mut self, el: &JsxElement, out: &mut Vec<Piece>) {
		match &el.tag {
			JsxTag::Fragment => self.children_pieces(&el.children, out),
			JsxTag::Component(name) => {
				let call = self.component_call(name, el);
				out.push(Piece::Dyn(format!("__kd_c({call})")));
			}
			JsxTag::Host(tag) => {
				if self.must_be_generic(tag, el) {
					let call = self.generic_element(tag, el);
					out.push(Piece::Dyn(format!("__kd_c({call})")));
					return;
				}
				out.push(Piece::Lit(format!("<{tag}")));
				for attr in &el.attrs {
					self.attribute_piece(attr, out);
				}
				if react_attrs::is_void_element(tag) {
					out.push(Piece::Lit("/>".to_owned()));
					return;
				}
				out.push(Piece::Lit(">".to_owned()));
				self.children_pieces(&el.children, out);
				out.push(Piece::Lit(format!("</{tag}>")));
			}
		}
	}

	fn children_pieces(&mut self, children: &[JsxChild], out: &mut Vec<Piece>) {
		for child in children {
			match child {
				JsxChild::Text(text) => out.push(Piece::Lit(escape_html(text))),
				JsxChild::Expr { start, end } => match self.literal(*start, *end) {
					Some(Literal::Str(s)) => out.push(Piece::Lit(escape_html(&s))),
					Some(Literal::Num(n)) if is_plain_integer(&n) => out.push(Piece::Lit(n)),
					Some(Literal::Bool(_) | Literal::Null) => {}
					_ => {
						let code = self.render(*start, *end);
						out.push(Piece::Dyn(format!("__kd_c({code})")));
					}
				},
				JsxChild::Element(el) => self.element_pieces(el, out),
			}
		}
	}

	fn attribute_piece(&mut self, attr: &JsxAttr, out: &mut Vec<Piece>) {
		let (name, literal, expr) = match attr {
			JsxAttr::Str { name, value } => (name, Some(Literal::Str(value.clone())), None),
			JsxAttr::True { name } => (name, Some(Literal::Bool(true)), None),
			JsxAttr::Expr { name, start, end } => {
				(name, self.literal(*start, *end), Some((*start, *end)))
			}
			JsxAttr::Spread { .. } => return,
		};
		if matches!(name.as_str(), "key" | "ref") {
			return;
		}
		if let Some(lit) = &literal
			&& let Some(text) = static_attribute(name, lit)
		{
			if !text.is_empty() {
				out.push(Piece::Lit(text));
			}
			return;
		}
		let value = match (&literal, expr) {
			(_, Some((s, e))) => self.render(s, e),
			(Some(Literal::Str(v)), None) => strings::quote(v),
			(Some(Literal::Bool(b)), None) => b.to_string(),
			_ => "undefined".to_owned(),
		};
		out.push(Piece::Dyn(format!(
			"__kd_a({}, {value})",
			strings::quote(name)
		)));
	}

	/// `__kd_k(Component, { ...props, children })`
	fn component_call(&mut self, name: &str, el: &JsxElement) -> String {
		let props = self.props_object(el, true);
		format!("__kd_k({name}, {props})")
	}

	/// `__kd_el("tag", { ...props }, children)`
	fn generic_element(&mut self, tag: &str, el: &JsxElement) -> String {
		let props = self.props_object(el, false);
		let children = self.children_value(&el.children);
		let has_children_attr = el.attrs.iter().any(|a| {
			matches!(a, JsxAttr::Str { name, .. } | JsxAttr::True { name } | JsxAttr::Expr { name, .. } if name == "children")
		});
		let _ = has_children_attr;
		match children {
			None => format!("__kd_el({}, {props})", strings::quote(tag)),
			Some(c) if LAZY_CHILDREN.contains(&tag) => {
				format!("__kd_el({}, {props}, () => {c})", strings::quote(tag))
			}
			Some(c) => format!("__kd_el({}, {props}, {c})", strings::quote(tag)),
		}
	}

	/// `{ "a": 1, ...b, children: ... }` (children only for components).
	fn props_object(&mut self, el: &JsxElement, with_children: bool) -> String {
		let mut parts: Vec<String> = Vec::new();
		for attr in &el.attrs {
			match attr {
				JsxAttr::Str { name, value } => {
					if name != "key" {
						parts.push(format!(
							"{}: {}",
							strings::quote(name),
							strings::quote(value)
						));
					}
				}
				JsxAttr::True { name } => {
					if name != "key" {
						parts.push(format!("{}: true", strings::quote(name)));
					}
				}
				JsxAttr::Expr { name, start, end } => {
					if name != "key" {
						let code = self.render(*start, *end);
						parts.push(format!("{}: {code}", strings::quote(name)));
					}
				}
				JsxAttr::Spread { start, end } => {
					let code = self.render(*start, *end);
					parts.push(format!("...{code}"));
				}
			}
		}
		if with_children && let Some(children) = self.children_value(&el.children) {
			parts.push(format!("children: {children}"));
		}
		format!("{{ {} }}", parts.join(", "))
	}

	/// The value of the `children` prop: nothing, one child, or an array.
	fn children_value(&mut self, children: &[JsxChild]) -> Option<String> {
		let mut values: Vec<String> = Vec::new();
		for child in children {
			match child {
				JsxChild::Text(text) => values.push(strings::quote(text)),
				JsxChild::Expr { start, end } => values.push(self.render(*start, *end)),
				JsxChild::Element(el) => {
					let code = self.element_expression(el);
					values.push(code);
				}
			}
		}
		match values.len() {
			0 => None,
			1 => values.pop(),
			_ => Some(format!("[{}]", values.join(", "))),
		}
	}

	/// Merges the pieces into one expression, hoisting it when it has no
	/// dynamic part.
	fn pieces_expression(&mut self, pieces: Vec<Piece>) -> String {
		let mut merged: Vec<Piece> = Vec::new();
		for piece in pieces {
			match (merged.last_mut(), piece) {
				(Some(Piece::Lit(last)), Piece::Lit(next)) => last.push_str(&next),
				(_, piece) => merged.push(piece),
			}
		}
		if merged.iter().all(|p| matches!(p, Piece::Lit(_))) {
			let html: String = merged
				.iter()
				.map(|p| match p {
					Piece::Lit(s) => s.as_str(),
					Piece::Dyn(_) => "",
				})
				.collect();
			return self.hoist(html);
		}
		let parts: Vec<String> = merged
			.into_iter()
			.map(|p| match p {
				Piece::Lit(s) => strings::quote(&s),
				Piece::Dyn(code) => code,
			})
			.collect();
		// The first operand must be a string for `+` to concatenate.
		let first_is_string = parts[0].starts_with('"');
		let joined = if first_is_string {
			parts.join(" + ")
		} else {
			format!("\"\" + {}", parts.join(" + "))
		};
		format!("__kd_m({joined})")
	}

	fn hoist(&mut self, html: String) -> String {
		if let Some(&n) = self.cache.get(&html) {
			return format!("__kd_s{n}");
		}
		let n = self.hoisted.len();
		self.hoisted.push(format!(
			"const __kd_s{n} = __kd_m({});",
			strings::quote(&html)
		));
		self.cache.insert(html, n);
		format!("__kd_s{n}")
	}

	/// The value of an expression that is one literal token.
	fn literal(&self, start: usize, end: usize) -> Option<Literal> {
		let text = &self.src[start..end];
		let mut lexer = Lexer::new(text);
		let first = lexer.next().ok()?;
		let value = match first.kind {
			Kind::Str => Literal::Str(strings::decode(lexer.text(first))),
			Kind::Num => Literal::Num(lexer.text(first).to_owned()),
			Kind::Ident => match lexer.text(first) {
				"true" => Literal::Bool(true),
				"false" => Literal::Bool(false),
				"null" | "undefined" => Literal::Null,
				_ => return None,
			},
			_ => return None,
		};
		if lexer.next().ok()?.kind != Kind::Eof {
			return None;
		}
		Some(value)
	}
}

fn is_plain_integer(raw: &str) -> bool {
	// Up to 15 digits an integer prints as written; beyond that JavaScript
	// switches to rounded digits or an exponent.
	!raw.is_empty()
		&& raw.len() <= 15
		&& raw.bytes().all(|b| b.is_ascii_digit())
		&& (raw == "0" || !raw.starts_with('0'))
}

/// White space with the same line structure.
fn blank(text: &str) -> String {
	text.chars()
		.map(|c| if matches!(c, '\n' | '\r') { c } else { ' ' })
		.collect()
}

/// The attribute text for a literal value, when it can be written at compile
/// time exactly as React writes it at run time. `Some("")` means the
/// attribute is omitted. `None` leaves the decision to the runtime.
fn static_attribute(prop: &str, value: &Literal) -> Option<String> {
	let entry = react_attrs::lookup(prop);
	let (attr, kind) = match entry {
		Some((attr, kind)) => (attr, kind),
		None => {
			// Written as is when it is an ordinary lower-case or dashed name that is
			// not an event handler.
			let ordinary = prop
				.bytes()
				.all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
				&& prop.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
				&& !prop.starts_with("on");
			if !ordinary {
				return None;
			}
			(prop, react_attrs::STRING)
		}
	};
	let dashed_data = prop.starts_with("data-") || prop.starts_with("aria-");
	match (value, kind) {
		(Literal::Str(s), react_attrs::STRING | react_attrs::BOOLEANISH_STRING) => {
			Some(format!(" {attr}=\"{}\"", escape_html(s)))
		}
		(Literal::Str(s), react_attrs::URL_ATTR | react_attrs::URL_ATTR_KEEP_EMPTY) => {
			let trimmed = s.trim_start().to_ascii_lowercase();
			if trimmed.starts_with("javascript:") || (s.is_empty() && kind == react_attrs::URL_ATTR)
			{
				None
			} else {
				Some(format!(" {attr}=\"{}\"", escape_html(s)))
			}
		}
		(Literal::Str(s), react_attrs::BOOLEAN) => Some(if s.is_empty() {
			String::new()
		} else {
			format!(" {attr}=\"\"")
		}),
		(Literal::Num(n), react_attrs::STRING | react_attrs::BOOLEANISH_STRING)
			if is_plain_integer(n) =>
		{
			Some(format!(" {attr}=\"{n}\""))
		}
		(Literal::Bool(true), react_attrs::BOOLEAN) => Some(format!(" {attr}=\"\"")),
		(Literal::Bool(false), react_attrs::BOOLEAN) => Some(String::new()),
		(Literal::Bool(b), react_attrs::BOOLEANISH_STRING) => Some(format!(" {attr}=\"{b}\"")),
		(Literal::Bool(b), react_attrs::STRING) if dashed_data => Some(format!(" {attr}=\"{b}\"")),
		(Literal::Null, k) if k != react_attrs::RESERVED => Some(String::new()),
		_ => None,
	}
}
