//! Prettier's HTML printer: from the preprocessed tree to a document.
//!
//! The function names follow prettier's (`printChildren`, `printElement`,
//! `needsToBorrowPrevClosingTagEndMarker`, …) so that the port can be checked
//! against it line by line. The central idea, which explains most of what looks
//! odd: in whitespace-sensitive places (inline content) a space between two
//! nodes cannot be turned into a line break, so the *tags* are broken instead:
//! the `>` of an opening tag or the `</tag` of a closing tag is "borrowed" and
//! printed at the start or the end of the neighbouring node.

use super::angular::Span;
use super::ast::{Ast, Display, Kind, Node, NodeId};
use super::doc::{BREAK_PARENT, DocId, Docs, EMPTY, HARDLINE, LINE, LITERALLINE, SOFTLINE};
use super::preprocess::is_pre_like;
use super::util;

/// What the printer reads from the options.
#[derive(Debug, Clone, Copy)]
pub struct Settings {
	pub tab_width: usize,
	pub bracket_same_line: bool,
	pub single_attribute_per_line: bool,
}

pub struct Printer<'a> {
	pub ast: &'a Ast,
	pub docs: &'a mut Docs,
	pub settings: Settings,
}

impl Printer<'_> {
	fn node(&self, id: NodeId) -> &Node {
		self.ast.node(id)
	}

	fn text(&mut self, s: impl Into<String>) -> DocId {
		self.docs.text(s)
	}

	fn concat(&mut self, parts: Vec<DocId>) -> DocId {
		self.docs.concat(parts)
	}

	// ----- predicates over nodes -----

	fn is_text_like(&self, id: NodeId) -> bool {
		matches!(self.node(id).kind, Kind::Text | Kind::Comment)
	}

	fn has_prettier_ignore(&self, id: NodeId) -> bool {
		match self.ast.prev(id) {
			Some(p) => {
				let pn = self.node(p);
				pn.kind == Kind::Comment && util_js_trim(&pn.value) == "prettier-ignore"
			}
			None => false,
		}
	}

	fn line_of(&self, offset: usize) -> usize {
		self.ast.line_of(offset)
	}

	fn has_leading_line_break(&self, id: NodeId) -> bool {
		let n = self.node(id);
		n.has_leading_spaces
			&& match self.ast.prev(id) {
				Some(p) => self.line_of(self.node(p).span.end) < self.line_of(n.span.start),
				None => {
					let parent = self.node(n.parent.unwrap_or(self.ast.root));
					parent.kind == Kind::Root
						|| self.line_of(parent.start_span.end) < self.line_of(n.span.start)
				}
			}
	}

	fn has_trailing_line_break(&self, id: NodeId) -> bool {
		let n = self.node(id);
		n.has_trailing_spaces
			&& match self.ast.next(id) {
				Some(x) => self.line_of(self.node(x).span.start) > self.line_of(n.span.end),
				None => {
					let parent = self.node(n.parent.unwrap_or(self.ast.root));
					parent.kind == Kind::Root
						|| parent
							.end_span
							.is_some_and(|e| self.line_of(e.start) > self.line_of(n.span.end))
				}
			}
	}

	fn has_surrounding_line_break(&self, id: NodeId) -> bool {
		self.has_leading_line_break(id) && self.has_trailing_line_break(id)
	}

	fn force_next_empty_line(&self, id: NodeId) -> bool {
		match self.ast.next(id) {
			Some(x) => {
				self.line_of(self.node(id).span.end) + 1 < self.line_of(self.node(x).span.start)
			}
			None => false,
		}
	}

	fn is_hardline_kind(&self, id: NodeId) -> bool {
		let n = self.node(id);
		match n.kind {
			Kind::IeConditionalComment | Kind::Comment => true,
			Kind::Element => matches!(n.name.as_str(), "script" | "select"),
			_ => false,
		}
	}

	fn prefer_hardline_as_trailing_spaces(&self, id: NodeId) -> bool {
		self.is_hardline_kind(id)
			|| (self.node(id).kind == Kind::Element && self.node(id).full_name() == "br")
			|| self.has_surrounding_line_break(id)
	}

	fn prefer_hardline_as_leading_spaces(&self, id: NodeId) -> bool {
		self.is_hardline_kind(id)
			|| self
				.ast
				.prev(id)
				.is_some_and(|p| self.prefer_hardline_as_trailing_spaces(p))
			|| self.has_surrounding_line_break(id)
	}

	fn force_break_children(&self, id: NodeId) -> bool {
		let n = self.node(id);
		n.kind == Kind::Element
			&& !n.children.is_empty()
			&& (matches!(n.name.as_str(), "html" | "head" | "ul" | "ol" | "select")
				|| (matches!(
					n.css_display,
					Display::Table
						| Display::TableCaption
						| Display::TableColumnGroup
						| Display::TableColumn
						| Display::TableHeaderGroup
						| Display::TableRowGroup
						| Display::TableFooterGroup
						| Display::TableRow
				)))
	}

	fn force_break_content(&self, id: NodeId) -> bool {
		let n = self.node(id);
		if self.force_break_children(id) {
			return true;
		}
		if n.kind == Kind::Element
			&& !n.children.is_empty()
			&& (matches!(n.name.as_str(), "body" | "script" | "style")
				|| n.children.iter().any(|&c| {
					self.node(c)
						.children
						.iter()
						.any(|&g| self.node(g).kind != Kind::Text)
				})) {
			return true;
		}
		if let (Some(first), Some(last)) = (self.ast.first_child(id), self.ast.last_child(id))
			&& first == last
			&& self.node(first).kind != Kind::Text
			&& self.has_leading_line_break(first)
			&& (!self.node(last).is_trailing_space_sensitive || self.has_trailing_line_break(last))
		{
			return true;
		}
		false
	}

	fn last_descendant(&self, id: NodeId) -> NodeId {
		let mut cursor = id;
		while let Some(last) = self.ast.last_child(cursor) {
			cursor = last;
		}
		cursor
	}

	fn should_preserve_content(&self, id: NodeId) -> bool {
		let n = self.node(id);
		if n.kind == Kind::IeConditionalComment
			&& let Some(last) = self.ast.last_child(id)
			&& !self.node(last).is_self_closing
			&& self.node(last).end_span.is_none()
		{
			return true;
		}
		if n.kind == Kind::IeConditionalComment && !n.complete {
			return true;
		}
		is_pre_like(n) && n.children.iter().any(|&c| self.node(c).kind != Kind::Text)
	}

	// ----- borrowing of tag markers -----

	fn needs_to_borrow_prev_closing_tag_end_marker(&self, id: NodeId) -> bool {
		let n = self.node(id);
		self.ast.prev(id).is_some_and(|p| {
			self.node(p).kind != Kind::DocType
				&& !self.is_text_like(p)
				&& n.is_leading_space_sensitive
				&& !n.has_leading_spaces
		})
	}

	fn needs_to_borrow_last_child_closing_tag_end_marker(&self, id: NodeId) -> bool {
		let n = self.node(id);
		self.ast.last_child(id).is_some_and(|last| {
			self.node(last).is_trailing_space_sensitive
				&& !self.node(last).has_trailing_spaces
				&& !self.is_text_like(self.last_descendant(last))
				&& !is_pre_like(n)
		})
	}

	fn needs_to_borrow_parent_closing_tag_start_marker(&self, id: NodeId) -> bool {
		let n = self.node(id);
		self.ast.next(id).is_none()
			&& !n.has_trailing_spaces
			&& n.is_trailing_space_sensitive
			&& self.is_text_like(self.last_descendant(id))
	}

	fn needs_to_borrow_next_opening_tag_start_marker(&self, id: NodeId) -> bool {
		let n = self.node(id);
		self.ast.next(id).is_some_and(|x| {
			!self.is_text_like(x)
				&& self.is_text_like(id)
				&& n.is_trailing_space_sensitive
				&& !n.has_trailing_spaces
		})
	}

	fn needs_to_borrow_parent_opening_tag_end_marker(&self, id: NodeId) -> bool {
		let n = self.node(id);
		self.ast.prev(id).is_none() && n.is_leading_space_sensitive && !n.has_leading_spaces
	}

	// ----- markers -----

	fn should_not_print_closing_tag(&self, id: NodeId) -> bool {
		let n = self.node(id);
		!n.is_self_closing
			&& n.end_span.is_none()
			&& (self.has_prettier_ignore(id)
				|| n.parent.is_some_and(|p| self.should_preserve_content(p)))
	}

	fn print_closing_tag_start_marker(&self, id: NodeId) -> String {
		if self.should_not_print_closing_tag(id) {
			return String::new();
		}
		let n = self.node(id);
		match n.kind {
			Kind::IeConditionalComment => "<!".to_owned(),
			Kind::Element if n.has_htm_component_closing_tag => "<//".to_owned(),
			_ => format!("</{}", n.raw_name()),
		}
	}

	fn print_closing_tag_end_marker(&self, id: NodeId) -> String {
		if self.should_not_print_closing_tag(id) {
			return String::new();
		}
		let n = self.node(id);
		match n.kind {
			Kind::IeConditionalComment | Kind::IeConditionalEndComment => "[endif]-->".to_owned(),
			Kind::IeConditionalStartComment => "]><!-->".to_owned(),
			Kind::Element if n.is_self_closing => "/>".to_owned(),
			_ => ">".to_owned(),
		}
	}

	fn print_opening_tag_start_marker(&self, id: NodeId) -> String {
		let n = self.node(id);
		match n.kind {
			Kind::IeConditionalComment | Kind::IeConditionalStartComment => {
				format!("<!--[if {}", n.condition.as_deref().unwrap_or(""))
			}
			Kind::IeConditionalEndComment => "<!--<!".to_owned(),
			Kind::DocType => {
				// As written: prettier only normalizes it when it knows the file
				// is `.html`, which kamado's v2 call did not tell it.
				let start = n.span.start;
				self.ast
					.text
					.get(start..start + 9)
					.unwrap_or("<!doctype")
					.to_owned()
			}
			Kind::Element if n.condition.is_some() => {
				format!(
					"<!--[if {}]><!--><{}",
					n.condition.as_deref().unwrap_or(""),
					n.raw_name()
				)
			}
			_ => format!("<{}", n.raw_name()),
		}
	}

	fn print_opening_tag_end_marker(&self, id: NodeId) -> String {
		let n = self.node(id);
		match n.kind {
			Kind::IeConditionalComment => "]>".to_owned(),
			Kind::Element if n.condition.is_some() => "><!--<![endif]-->".to_owned(),
			_ => ">".to_owned(),
		}
	}

	fn print_opening_tag_prefix(&self, id: NodeId) -> String {
		if self.needs_to_borrow_parent_opening_tag_end_marker(id) {
			return self
				.print_opening_tag_end_marker(self.node(id).parent.unwrap_or(self.ast.root));
		}
		if self.needs_to_borrow_prev_closing_tag_end_marker(id)
			&& let Some(p) = self.ast.prev(id)
		{
			return self.print_closing_tag_end_marker(p);
		}
		String::new()
	}

	fn print_closing_tag_suffix(&self, id: NodeId) -> String {
		if self.needs_to_borrow_parent_closing_tag_start_marker(id) {
			return self
				.print_closing_tag_start_marker(self.node(id).parent.unwrap_or(self.ast.root));
		}
		if self.needs_to_borrow_next_opening_tag_start_marker(id)
			&& let Some(x) = self.ast.next(id)
		{
			return self.print_opening_tag_start_marker(x);
		}
		String::new()
	}

	fn print_closing_tag_prefix(&self, id: NodeId) -> String {
		if self.needs_to_borrow_last_child_closing_tag_end_marker(id)
			&& let Some(last) = self.ast.last_child(id)
		{
			return self.print_closing_tag_end_marker(last);
		}
		String::new()
	}

	fn print_opening_tag_start(&mut self, id: NodeId) -> DocId {
		if self
			.ast
			.prev(id)
			.is_some_and(|p| self.needs_to_borrow_next_opening_tag_start_marker(p))
		{
			return EMPTY;
		}
		let s = format!(
			"{}{}",
			self.print_opening_tag_prefix(id),
			self.print_opening_tag_start_marker(id)
		);
		self.text(s)
	}

	fn print_opening_tag_end(&mut self, id: NodeId) -> DocId {
		if self
			.ast
			.first_child(id)
			.is_some_and(|c| self.needs_to_borrow_parent_opening_tag_end_marker(c))
		{
			return EMPTY;
		}
		let s = self.print_opening_tag_end_marker(id);
		self.text(s)
	}

	fn print_closing_tag_start(&mut self, id: NodeId) -> DocId {
		if self
			.ast
			.last_child(id)
			.is_some_and(|c| self.needs_to_borrow_parent_closing_tag_start_marker(c))
		{
			return EMPTY;
		}
		let s = format!(
			"{}{}",
			self.print_closing_tag_prefix(id),
			self.print_closing_tag_start_marker(id)
		);
		self.text(s)
	}

	fn print_closing_tag_end(&mut self, id: NodeId) -> DocId {
		let n = self.node(id);
		let borrowed = match self.ast.next(id) {
			Some(x) => self.needs_to_borrow_prev_closing_tag_end_marker(x),
			None => self.needs_to_borrow_last_child_closing_tag_end_marker(
				n.parent.unwrap_or(self.ast.root),
			),
		};
		if borrowed {
			return EMPTY;
		}
		let s = format!(
			"{}{}",
			self.print_closing_tag_end_marker(id),
			self.print_closing_tag_suffix(id)
		);
		self.text(s)
	}

	fn print_closing_tag(&mut self, id: NodeId) -> DocId {
		let start = if self.node(id).is_self_closing {
			EMPTY
		} else {
			self.print_closing_tag_start(id)
		};
		let end = self.print_closing_tag_end(id);
		self.concat(vec![start, end])
	}

	// ----- attributes -----

	fn print_attributes(&mut self, id: NodeId) -> DocId {
		let n = self.node(id);
		if n.attrs.is_empty() {
			let s = if n.is_self_closing { " " } else { "" };
			return self.text(s);
		}
		let ignore = self.ignored_attributes(id);
		let mut printed: Vec<DocId> = Vec::with_capacity(self.node(id).attrs.len());
		for i in 0..self.node(id).attrs.len() {
			let attr = self.node(id).attrs[i].clone();
			let doc = if match &ignore {
				Ignore::All => true,
				Ignore::Some(names) => names.contains(&attr.raw_name),
				Ignore::None => false,
			} {
				let raw = self.ast.slice(attr.span).to_owned();
				self.docs.replace_end_of_line(&raw, LITERALLINE)
			} else {
				self.print_attribute(id, i)
			};
			printed.push(doc);
		}
		let n = self.node(id);
		let force_not_to_break = n.kind == Kind::Element
			&& n.full_name() == "script"
			&& n.attrs.len() == 1
			&& n.attrs[0].full_name == "src"
			&& n.children.is_empty();
		let per_line = self.settings.single_attribute_per_line && n.attrs.len() > 1;
		let first_line = if force_not_to_break {
			self.text(" ")
		} else {
			LINE
		};
		let separator = if per_line { HARDLINE } else { LINE };
		let joined = self.docs.join(separator, &printed);
		let joined = self.concat(joined);
		let inner = self.concat(vec![first_line, joined]);
		let indented = self.docs.indent(inner);
		let mut parts = vec![indented];
		let n = self.node(id);
		let is_self_closing = n.is_self_closing;
		let first_borrows = self
			.ast
			.first_child(id)
			.is_some_and(|c| self.needs_to_borrow_parent_opening_tag_end_marker(c));
		let parent_borrows = n
			.parent
			.is_some_and(|p| self.needs_to_borrow_last_child_closing_tag_end_marker(p));
		if first_borrows
			|| (is_self_closing && parent_borrows)
			|| force_not_to_break
			|| self.settings.bracket_same_line
		{
			parts.push(self.text(if is_self_closing { " " } else { "" }));
		} else {
			parts.push(if is_self_closing { LINE } else { SOFTLINE });
		}
		self.concat(parts)
	}

	fn ignored_attributes(&self, id: NodeId) -> Ignore {
		let Some(prev) = self.ast.prev(id) else {
			return Ignore::None;
		};
		let p = self.node(prev);
		if p.kind != Kind::Comment {
			return Ignore::None;
		}
		let trimmed = util_js_trim(&p.value);
		let Some(rest) = trimmed.strip_prefix("prettier-ignore-attribute") else {
			return Ignore::None;
		};
		if rest.is_empty() {
			return Ignore::All;
		}
		if !rest.starts_with(util::is_js_space) {
			return Ignore::None;
		}
		let names: Vec<String> = rest
			.trim_start_matches(util::is_js_space)
			.split(util::is_js_space)
			.filter(|s| !s.is_empty())
			.map(str::to_owned)
			.collect();
		if names.is_empty() {
			Ignore::All
		} else {
			Ignore::Some(names)
		}
	}

	fn print_attribute(&mut self, element: NodeId, index: usize) -> DocId {
		let attr = self.node(element).attrs[index].clone();
		let Some(value) = attr.value.clone() else {
			return self.text(attr.raw_name);
		};
		if !value.is_empty()
			&& let Some(doc) =
				self.print_embedded_attribute(element, &attr.full_name, &attr.raw_name, &value)
		{
			return doc;
		}
		// prettier prints the value from the text between the quotes with
		// `&apos;` and `&quot;` turned back into quotes, and picks the quote
		// that needs fewer escapes (double by default).
		let unescaped = value.replace("&apos;", "'").replace("&quot;", "\"");
		let doubles = unescaped.matches('"').count();
		let singles = unescaped.matches('\'').count();
		let quote = if doubles > singles { '\'' } else { '"' };
		let body = if quote == '"' {
			unescaped.replace('"', "&quot;")
		} else {
			unescaped.replace('\'', "&apos;")
		};
		let q = quote.to_string();
		let name = self.text(format!("{}={q}", attr.raw_name));
		let body = self.docs.replace_end_of_line(&body, LITERALLINE);
		let close = self.text(q);
		self.concat(vec![name, body, close])
	}

	/// The attributes prettier formats instead of printing as written.
	fn print_embedded_attribute(
		&mut self,
		element: NodeId,
		full_name: &str,
		raw_name: &str,
		value: &str,
	) -> Option<DocId> {
		let parent_name = self.node(element).full_name();
		let unescaped = value.replace("&apos;", "'").replace("&quot;", "\"");
		let doc = match full_name {
			"srcset" if matches!(parent_name.as_str(), "img" | "source") => {
				self.print_srcset(&unescaped)?
			}
			"class" if !value.contains("{{") => {
				let collapsed = unescaped
					.trim_matches(util::is_js_space)
					.split(util::is_js_space)
					.filter(|p| !p.is_empty())
					.collect::<Vec<_>>()
					.join(" ");
				if collapsed.is_empty() {
					return None;
				}
				self.text(collapsed)
			}
			"allow" if parent_name == "iframe" && !value.contains("{{") => {
				self.print_allow(&unescaped)
			}
			_ => return None,
		};
		// strings inside are written with `"` as `&quot;`; the attribute is
		// double quoted
		let head = self.text(format!("{raw_name}=\""));
		let grouped = self.group_escaping_quotes(doc);
		let tail = self.text("\"");
		Some(self.concat(vec![head, grouped, tail]))
	}

	/// `group(doc)` with every `"` in the doc's strings written as `&quot;`.
	fn group_escaping_quotes(&mut self, doc: DocId) -> DocId {
		let mapped = self.docs.map_text(doc, &|s| s.replace('"', "&quot;"));
		self.docs.group(mapped)
	}

	fn print_expand(&mut self, doc: DocId, can_have_trailing_whitespace: bool) -> DocId {
		let inner = self.concat(vec![SOFTLINE, doc]);
		let indented = self.docs.indent(inner);
		self.concat(vec![
			indented,
			if can_have_trailing_whitespace {
				SOFTLINE
			} else {
				EMPTY
			},
		])
	}

	fn print_allow(&mut self, value: &str) -> DocId {
		let mut entries: Vec<Vec<&str>> = Vec::new();
		for piece in value.split(';') {
			let piece = util::trim(piece);
			if piece.is_empty() {
				continue;
			}
			entries.push(util::split_ws(piece));
		}
		if entries.is_empty() {
			return EMPTY;
		}
		let last = entries.len() - 1;
		let mut docs: Vec<DocId> = Vec::new();
		for (i, parts) in entries.iter().enumerate() {
			let head = self.text(parts.join(" "));
			let tail = if i == last {
				let semicolon = self.text(";");
				self.docs.if_break(semicolon, EMPTY, None)
			} else {
				let semicolon = self.text(";");
				self.concat(vec![semicolon, LINE])
			};
			docs.push(self.concat(vec![head, tail]));
		}
		let all = self.concat(docs);
		self.print_expand(all, true)
	}

	fn print_srcset(&mut self, value: &str) -> Option<DocId> {
		let candidates = super::srcset::parse(value).ok()?;
		let kinds = super::srcset::used_descriptor(&candidates).ok()?;
		let unit = kinds.map_or("", super::srcset::Descriptor::unit);
		let urls: Vec<&str> = candidates.iter().map(|c| c.url.as_str()).collect();
		let max_url = urls.iter().map(|u| u.chars().count()).max().unwrap_or(0);
		let values: Vec<String> = candidates
			.iter()
			.map(|c| kinds.map_or_else(String::new, |k| c.value_of(k)))
			.collect();
		let dots: Vec<usize> = values
			.iter()
			.map(|v| v.find('.').unwrap_or(v.len()))
			.collect();
		let max_dot = dots.iter().copied().max().unwrap_or(0);
		let mut items: Vec<DocId> = Vec::new();
		for (i, url) in urls.iter().enumerate() {
			let mut part = vec![self.text(*url)];
			if !values[i].is_empty() {
				let pad = max_url - url.chars().count() + 1 + (max_dot - dots[i]);
				let padding = self.text(" ".repeat(pad));
				let space = self.text(" ");
				part.push(self.docs.if_break(padding, space, None));
				part.push(self.text(format!("{}{unit}", values[i])));
			}
			items.push(self.concat(part));
		}
		let comma = self.text(",");
		let separator = self.concat(vec![comma, LINE]);
		let joined = self.docs.join(separator, &items);
		let joined = self.concat(joined);
		Some(self.print_expand(joined, true))
	}

	// ----- elements -----

	fn print_opening_tag(&mut self, id: NodeId) -> DocId {
		let start = self.print_opening_tag_start(id);
		let attrs = self.print_attributes(id);
		let end = if self.node(id).is_self_closing {
			EMPTY
		} else {
			self.print_opening_tag_end(id)
		};
		self.concat(vec![start, attrs, end])
	}

	fn node_content(&self, id: NodeId) -> String {
		let n = self.node(id);
		let Some(end) = n.end_span else {
			return String::new();
		};
		let mut from = n.start_span.end;
		if self
			.ast
			.first_child(id)
			.is_some_and(|c| self.needs_to_borrow_parent_opening_tag_end_marker(c))
		{
			from -= self.print_opening_tag_end_marker(id).len();
		}
		let mut to = end.start;
		if self
			.ast
			.last_child(id)
			.is_some_and(|c| self.needs_to_borrow_parent_closing_tag_start_marker(c))
		{
			to += self.print_closing_tag_start_marker(id).len();
		} else if self.needs_to_borrow_last_child_closing_tag_end_marker(id)
			&& let Some(last) = self.ast.last_child(id)
		{
			to -= self.print_closing_tag_end_marker(last).len();
		}
		self.ast
			.slice(Span {
				start: from,
				end: to,
			})
			.to_owned()
	}

	fn depth(&self, id: NodeId) -> usize {
		let mut count = 0;
		let mut cursor = self.node(id).parent;
		while let Some(p) = cursor {
			count += 1;
			cursor = self.node(p).parent;
		}
		count
	}

	fn print_element(&mut self, id: NodeId) -> DocId {
		if self.should_preserve_content(id) {
			let prefix = self.print_opening_tag_prefix(id);
			let prefix = self.text(prefix);
			let opening = self.print_opening_tag(id);
			let opening = self.docs.group(opening);
			let content = self.node_content(id);
			let content = self.docs.replace_end_of_line(&content, LITERALLINE);
			let closing = self.print_closing_tag(id);
			let suffix = self.print_closing_tag_suffix(id);
			let suffix = self.text(suffix);
			return self.concat(vec![prefix, opening, content, closing, suffix]);
		}
		let attr_group = self.docs.new_group_id();
		let n = self.node(id);
		let children_empty = n.children.is_empty();
		let dangling = n.has_dangling_spaces && n.is_dangling_space_sensitive;

		let build_tag = |this: &mut Self, body: DocId| -> DocId {
			let opening = this.print_opening_tag(id);
			let opening = this.docs.group_with(opening, false, Some(attr_group));
			let closing = this.print_closing_tag(id);
			let all = this.concat(vec![opening, body, closing]);
			this.docs.group(all)
		};
		if children_empty {
			return build_tag(self, if dangling { LINE } else { EMPTY });
		}

		let first = self.ast.first_child(id).unwrap_or(0);
		let last = self.ast.last_child(id).unwrap_or(0);

		// printLineBeforeChildren
		let line_before = {
			let f = self.node(first);
			if f.has_leading_spaces && f.is_leading_space_sensitive {
				LINE
			} else if f.kind == Kind::Text
				&& self.node(id).is_whitespace_sensitive
				&& self.node(id).is_indentation_sensitive
			{
				self.docs.dedent_to_root(SOFTLINE)
			} else {
				SOFTLINE
			}
		};
		// printLineAfterChildren
		let line_after = {
			let n = self.node(id);
			let borrow = match self.ast.next(id) {
				Some(x) => self.needs_to_borrow_prev_closing_tag_end_marker(x),
				None => self.needs_to_borrow_last_child_closing_tag_end_marker(
					n.parent.unwrap_or(self.ast.root),
				),
			};
			let l = self.node(last);
			if borrow {
				if l.has_trailing_spaces && l.is_trailing_space_sensitive {
					self.text(" ")
				} else {
					EMPTY
				}
			} else if is_pre_like(n) && self.needs_to_borrow_parent_closing_tag_start_marker(last) {
				EMPTY
			} else if l.has_trailing_spaces && l.is_trailing_space_sensitive {
				LINE
			} else if (l.kind == Kind::Comment
				|| (l.kind == Kind::Text
					&& n.is_whitespace_sensitive
					&& n.is_indentation_sensitive))
				&& ends_with_line_and_indent(
					&l.value,
					self.settings.tab_width * (self.depth(id) - 1),
				) {
				EMPTY
			} else {
				SOFTLINE
			}
		};

		let children_doc = self.print_children(id);
		let before_and_children = self.concat(vec![line_before, children_doc]);
		let indented = self.docs.indent(before_and_children);
		let break_parent = if self.force_break_content(id) {
			BREAK_PARENT
		} else {
			EMPTY
		};
		let body = self.concat(vec![break_parent, indented, line_after]);
		build_tag(self, body)
	}

	// ----- children -----

	fn print_between_line(&mut self, prev: NodeId, next: NodeId) -> DocId {
		let (p, n) = (self.node(prev), self.node(next));
		if self.is_text_like(prev) && self.is_text_like(next) {
			return if p.is_trailing_space_sensitive {
				if p.has_trailing_spaces {
					if self.prefer_hardline_as_leading_spaces(next) {
						HARDLINE
					} else {
						LINE
					}
				} else {
					EMPTY
				}
			} else if self.prefer_hardline_as_leading_spaces(next) {
				HARDLINE
			} else {
				SOFTLINE
			};
		}
		if (self.needs_to_borrow_next_opening_tag_start_marker(prev)
			&& (self.has_prettier_ignore(next)
				|| !n.children.is_empty()
				|| n.is_self_closing
				|| (n.kind == Kind::Element && !n.attrs.is_empty())))
			|| (p.kind == Kind::Element
				&& p.is_self_closing
				&& self.needs_to_borrow_prev_closing_tag_end_marker(next))
		{
			return EMPTY;
		}
		if n.kind == Kind::Comment && n.is_leading_space_sensitive && !n.has_leading_spaces {
			return SOFTLINE;
		}
		let nested_borrow = self.needs_to_borrow_prev_closing_tag_end_marker(next)
			&& self.ast.last_child(prev).is_some_and(|lc| {
				self.needs_to_borrow_parent_closing_tag_start_marker(lc)
					&& self.ast.last_child(lc).is_some_and(|llc| {
						self.needs_to_borrow_parent_closing_tag_start_marker(llc)
					})
			});
		if !n.is_leading_space_sensitive
			|| self.prefer_hardline_as_leading_spaces(next)
			|| nested_borrow
		{
			HARDLINE
		} else if n.has_leading_spaces {
			LINE
		} else {
			SOFTLINE
		}
	}

	fn end_location(&self, id: NodeId) -> usize {
		let n = self.node(id);
		let end = n.span.end;
		if n.kind == Kind::Element
			&& n.end_span.is_none()
			&& !n.children.is_empty()
			&& let Some(last) = self.ast.last_child(id)
		{
			return end.max(self.end_location(last));
		}
		end
	}

	fn print_child(&mut self, id: NodeId) -> DocId {
		if self.has_prettier_ignore(id) {
			let n = self.node(id);
			let skip_start = match self.ast.prev(id) {
				Some(p) if self.needs_to_borrow_next_opening_tag_start_marker(p) => {
					self.print_opening_tag_start_marker(id).len()
				}
				_ => 0,
			};
			let skip_end = match self.ast.next(id) {
				Some(x) if self.needs_to_borrow_prev_closing_tag_end_marker(x) => {
					self.print_closing_tag_end_marker(id).len()
				}
				_ => 0,
			};
			let from = n.span.start + skip_start;
			let to = self.end_location(id).saturating_sub(skip_end);
			let raw = util::trim_end(self.ast.slice(Span {
				start: from,
				end: to.max(from),
			}))
			.to_owned();
			let prefix = self.print_opening_tag_prefix(id);
			let prefix = self.text(prefix);
			let body = self.docs.replace_end_of_line(&raw, LITERALLINE);
			let suffix = self.print_closing_tag_suffix(id);
			let suffix = self.text(suffix);
			return self.concat(vec![prefix, body, suffix]);
		}
		self.print_node(id)
	}

	fn print_children(&mut self, id: NodeId) -> DocId {
		let children = self.node(id).children.clone();
		if self.node(id).kind == Kind::Element && self.force_break_children(id) {
			let mut parts = vec![BREAK_PARENT];
			for &child in &children {
				let prev = self.ast.prev(child);
				let between = match prev {
					Some(p) => self.print_between_line(p, child),
					None => EMPTY,
				};
				let lead = if between == EMPTY {
					EMPTY
				} else {
					let extra = if prev.is_some_and(|p| self.force_next_empty_line(p)) {
						HARDLINE
					} else {
						EMPTY
					};
					self.concat(vec![between, extra])
				};
				let printed = self.print_child(child);
				parts.push(self.concat(vec![lead, printed]));
			}
			return self.concat(parts);
		}
		let group_ids: Vec<u32> = children.iter().map(|_| self.docs.new_group_id()).collect();
		let mut out: Vec<DocId> = Vec::with_capacity(children.len());
		for (index, &child) in children.iter().enumerate() {
			let prev = self.ast.prev(child);
			let next = self.ast.next(child);
			if self.is_text_like(child) {
				if let Some(p) = prev
					&& self.is_text_like(p)
				{
					let between = self.print_between_line(p, child);
					if between != EMPTY {
						let printed = self.print_child(child);
						if self.force_next_empty_line(p) {
							out.push(self.concat(vec![HARDLINE, HARDLINE, printed]));
						} else {
							out.push(self.concat(vec![between, printed]));
						}
						continue;
					}
				}
				out.push(self.print_child(child));
				continue;
			}
			let mut prev_parts: Vec<DocId> = Vec::new();
			let mut leading_parts: Vec<DocId> = Vec::new();
			let mut trailing_parts: Vec<DocId> = Vec::new();
			let mut next_parts: Vec<DocId> = Vec::new();
			let prev_between = match prev {
				Some(p) => self.print_between_line(p, child),
				None => EMPTY,
			};
			let next_between = match next {
				Some(x) => self.print_between_line(child, x),
				None => EMPTY,
			};
			if prev_between != EMPTY {
				let p = prev.unwrap_or(child);
				if self.force_next_empty_line(p) {
					prev_parts.push(HARDLINE);
					prev_parts.push(HARDLINE);
				} else if prev_between == HARDLINE {
					prev_parts.push(HARDLINE);
				} else if self.is_text_like(p) {
					leading_parts.push(prev_between);
				} else {
					let gid = group_ids[index - 1];
					leading_parts.push(self.docs.if_break(EMPTY, SOFTLINE, Some(gid)));
				}
			}
			if next_between != EMPTY {
				let x = next.unwrap_or(child);
				if self.force_next_empty_line(child) {
					if self.is_text_like(x) {
						next_parts.push(HARDLINE);
						next_parts.push(HARDLINE);
					}
				} else if next_between == HARDLINE {
					if self.is_text_like(x) {
						next_parts.push(HARDLINE);
					}
				} else {
					trailing_parts.push(next_between);
				}
			}
			let printed = self.print_child(child);
			let mut inner = vec![printed];
			inner.extend(trailing_parts);
			let inner = self.concat(inner);
			let inner = self.docs.group_with(inner, false, Some(group_ids[index]));
			let mut outer = leading_parts;
			outer.push(inner);
			let outer = self.concat(outer);
			let outer = self.docs.group(outer);
			let mut item = prev_parts;
			item.push(outer);
			item.extend(next_parts);
			out.push(self.concat(item));
		}
		self.concat(out)
	}

	// ----- nodes -----

	fn text_value_parts(&mut self, id: NodeId) -> Vec<DocId> {
		let n = self.node(id);
		let value = n.value.clone();
		let parent = self.node(n.parent.unwrap_or(self.ast.root));
		if parent.is_whitespace_sensitive {
			if parent.is_indentation_sensitive {
				return self.replace_eol_parts(&value, LITERALLINE);
			}
			let dedented = util::dedent_string(util::trim_preserve_indentation(&value));
			return self.replace_eol_parts(&dedented, HARDLINE);
		}
		let words = util::split_ws(&value);
		let docs: Vec<DocId> = words.iter().map(|w| self.docs.text(*w)).collect();
		self.docs.join(LINE, &docs)
	}

	/// The formatted JSON of a `<script type="application/ld+json">` (or
	/// `importmap`, `speculationrules`, any type ending in `json`): prettier
	/// formats it with its JavaScript printer and v2 kept that. `None` for any
	/// other text and for JSON that is not formatted (see `json`).
	fn embedded_json(&mut self, id: NodeId) -> Option<DocId> {
		let n = self.node(id);
		let parent = self.node(n.parent?);
		if parent.kind != Kind::Element || parent.full_name() != "script" {
			return None;
		}
		let ty = parent
			.attrs
			.iter()
			.find(|a| a.full_name == "type")?
			.value
			.clone()?;
		if !(ty.ends_with("json") || ty.ends_with("importmap") || ty == "speculationrules") {
			return None;
		}
		let value = n.value.clone();
		if value.trim_matches(util::is_js_space).is_empty() {
			return None;
		}
		let text = util::trim_preserve_indentation(&value).to_owned();
		super::json::format(self.docs, &text)
	}

	/// `replaceEndOfLine(text, replacement)` as the parts of a fill: pieces
	/// alternating with the replacement.
	fn replace_eol_parts(&mut self, text: &str, replacement: DocId) -> Vec<DocId> {
		let pieces: Vec<DocId> = text.split('\n').map(|p| self.docs.text(p)).collect();
		self.docs.join(replacement, &pieces)
	}

	fn print_node(&mut self, id: NodeId) -> DocId {
		let ast: &Ast = self.ast;
		let n = ast.node(id);
		match n.kind {
			Kind::Root => {
				let children = self.print_children(id);
				let g = self.docs.group(children);
				self.concat(vec![g, HARDLINE])
			}
			Kind::Element | Kind::IeConditionalComment => self.print_element(id),
			Kind::IeConditionalStartComment | Kind::IeConditionalEndComment => {
				let a = self.print_opening_tag_start(id);
				let b = self.print_closing_tag_end(id);
				self.concat(vec![a, b])
			}
			Kind::Text => {
				let prefix = self.print_opening_tag_prefix(id);
				let suffix = self.print_closing_tag_suffix(id);
				if let Some(json) = self.embedded_json(id) {
					let prefix = self.text(prefix);
					let suffix = self.text(suffix);
					return self.concat(vec![BREAK_PARENT, prefix, json, suffix]);
				}
				let mut parts = self.text_value_parts(id);
				let first = parts[0];
				let prefix = self.text(prefix);
				parts[0] = self.concat(vec![prefix, first]);
				let last = parts.pop().unwrap_or(EMPTY);
				let suffix = self.text(suffix);
				parts.push(self.concat(vec![last, suffix]));
				self.docs.fill(parts)
			}
			Kind::DocType => {
				let start = self.print_opening_tag_start(id);
				let value = {
					let v = &n.value;
					// `replace(/^html\b/i, "html")`, then runs of white space become one space
					let lowered = if v.len() >= 4
						&& v.as_bytes()[..4].eq_ignore_ascii_case(b"html")
						&& v.as_bytes()
							.get(4)
							.is_none_or(|b| !(b.is_ascii_alphanumeric() || *b == b'_'))
					{
						format!("html{}", &v[4..])
					} else {
						v.clone()
					};
					collapse_js_ws(&lowered)
				};
				let value = self.text(value);
				let sp = self.text(" ");
				let head = self.concat(vec![start, sp, value]);
				let head = self.docs.group(head);
				let end = self.print_closing_tag_end(id);
				self.concat(vec![head, end])
			}
			Kind::Comment => {
				let prefix = self.print_opening_tag_prefix(id);
				let prefix = self.text(prefix);
				let raw = self.ast.slice(n.span).to_owned();
				let body = self.docs.replace_end_of_line(&raw, LITERALLINE);
				let suffix = self.print_closing_tag_suffix(id);
				let suffix = self.text(suffix);
				self.concat(vec![prefix, body, suffix])
			}
			Kind::Cdata => EMPTY,
		}
	}
}

enum Ignore {
	None,
	All,
	Some(Vec<String>),
}

fn util_js_trim(s: &str) -> &str {
	s.trim_matches(util::is_js_space)
}

fn collapse_js_ws(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let mut in_ws = false;
	for c in s.chars() {
		if util::is_js_space(c) {
			if !in_ws {
				out.push(' ');
				in_ws = true;
			}
		} else {
			out.push(c);
			in_ws = false;
		}
	}
	out
}

/// `/\n[\t ]{n}$/`
fn ends_with_line_and_indent(value: &str, n: usize) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() < n + 1 {
		return false;
	}
	let tail = &bytes[bytes.len() - n..];
	tail.iter().all(|&b| b == b' ' || b == b'\t') && bytes[bytes.len() - n - 1] == b'\n'
}

/// The document of a whole page.
pub fn print_root(ast: &Ast, docs: &mut Docs, settings: Settings) -> DocId {
	let mut printer = Printer {
		ast,
		docs,
		settings,
	};
	printer.print_node(ast.root)
}
