//! The tree the printer works on: prettier's HTML AST. It is built from the
//! parser's raw tree (`angular`) the way prettier's `parser-html` builds it
//! (names and namespaces, attribute values, IE conditional comments), and then
//! rewritten by the steps in `preprocess`.

use super::angular::{self, ParseError, RawAttr, RawKind, RawTree, Span, TagDef};
use super::tables;

pub type NodeId = usize;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	Root,
	Element,
	Text,
	Comment,
	DocType,
	Cdata,
	IeConditionalComment,
	IeConditionalStartComment,
	IeConditionalEndComment,
}

/// CSS `display` as prettier's HTML printer distinguishes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Display {
	Block,
	Inline,
	InlineBlock,
	ListItem,
	None,
	Contents,
	Ruby,
	RubyText,
	Table,
	TableCaption,
	TableColumnGroup,
	TableColumn,
	TableHeaderGroup,
	TableRowGroup,
	TableFooterGroup,
	TableRow,
	TableCell,
	/// Anything else a `<!-- display: x -->` comment names.
	Other,
}

#[derive(Debug, Clone)]
pub struct Attr {
	/// The name as printed: with its namespace when it was written with one.
	pub raw_name: String,
	/// `namespace:name` (or just the name).
	pub full_name: String,
	/// The value without quotes; `None` for a bare attribute.
	pub value: Option<String>,
	pub span: Span,
	/// The value including quotes.
	pub value_span: Option<Span>,
}

#[derive(Debug, Clone)]
pub struct Node {
	pub kind: Kind,
	pub parent: Option<NodeId>,
	/// Where this node stands in its parent's `children`: a hint that
	/// [`Ast::prev`] and [`Ast::next`] check and fall back from, so that a step
	/// that removes children without updating it costs time, never correctness.
	/// Private so that it is only written here, by [`Ast::set_children`],
	/// [`Ast::reindex_children`] and the end of [`build`] (which sets every place at once: the
	/// places are not set while the tree is being built).
	index_in_parent: usize,
	/// A step that takes children out of this list leaves `index_in_parent` of the rest stale
	/// until [`Ast::set_children`] or [`Ast::reindex_children`] runs: `extract_whitespaces`
	/// does it for every node with children, and the last step does it for what it merged. Until
	/// then [`Ast::prev`] and [`Ast::next`] are right but search; a step that runs after those
	/// two and removes children calls `reindex_children` itself.
	pub children: Vec<NodeId>,
	pub span: Span,
	pub start_span: Span,
	pub end_span: Option<Span>,
	/// Element name (lower-cased when it is a known HTML name).
	pub name: String,
	pub namespace: Option<String>,
	pub has_explicit_namespace: bool,
	pub attrs: Vec<Attr>,
	/// Text: its source text. Comment: the text between `<!--` and `-->`.
	/// DocType: what follows `<!doctype`. Cdata: its content.
	pub value: String,
	pub condition: Option<String>,
	pub complete: bool,
	pub tag_def: TagDef,

	// Set by the preprocessing steps.
	pub has_leading_spaces: bool,
	pub has_trailing_spaces: bool,
	pub has_dangling_spaces: bool,
	pub is_whitespace_sensitive: bool,
	pub is_indentation_sensitive: bool,
	pub is_leading_space_sensitive: bool,
	pub is_trailing_space_sensitive: bool,
	pub is_dangling_space_sensitive: bool,
	pub css_display: Display,
	pub is_self_closing: bool,
	pub has_htm_component_closing_tag: bool,
}

impl Node {
	fn new(kind: Kind, span: Span) -> Node {
		Node {
			kind,
			parent: None,
			index_in_parent: 0,
			children: Vec::new(),
			span,
			start_span: span,
			end_span: None,
			name: String::new(),
			namespace: None,
			has_explicit_namespace: false,
			attrs: Vec::new(),
			value: String::new(),
			condition: None,
			complete: true,
			tag_def: angular::tag_def(""),
			has_leading_spaces: false,
			has_trailing_spaces: false,
			has_dangling_spaces: false,
			is_whitespace_sensitive: false,
			is_indentation_sensitive: false,
			is_leading_space_sensitive: false,
			is_trailing_space_sensitive: false,
			is_dangling_space_sensitive: false,
			css_display: Display::Inline,
			is_self_closing: false,
			has_htm_component_closing_tag: false,
		}
	}

	/// `fullName`: `namespace:name`, or the name.
	#[must_use]
	pub fn full_name(&self) -> String {
		match &self.namespace {
			Some(ns) => format!("{ns}:{}", self.name),
			None => self.name.clone(),
		}
	}

	/// `rawName`: how the name is printed.
	#[must_use]
	pub fn raw_name(&self) -> String {
		if self.has_explicit_namespace {
			self.full_name()
		} else {
			self.name.clone()
		}
	}

	/// The attribute with this full name.
	#[must_use]
	pub fn attr(&self, full_name: &str) -> Option<&Attr> {
		self.attrs.iter().find(|a| a.full_name == full_name)
	}

	/// Prettier's `isUnknownNamespace`: an element that was not written with a
	/// namespace and whose namespace is neither html nor svg. (An element with
	/// no namespace at all counts, as it does in prettier.)
	#[must_use]
	pub fn is_unknown_namespace(&self) -> bool {
		self.kind == Kind::Element
			&& !self.has_explicit_namespace
			&& !matches!(self.namespace.as_deref(), Some("html" | "svg"))
	}
}

/// The whole tree and the text it was parsed from.
#[derive(Debug)]
pub struct Ast {
	pub nodes: Vec<Node>,
	pub root: NodeId,
	pub text: String,
	line_starts: Vec<usize>,
	/// How many times [`Ast::place`] had to search because the hint was wrong: a test reads it
	/// to see that no step forgot to update the places.
	#[cfg(test)]
	misses: std::cell::Cell<usize>,
}

impl Ast {
	/// The 0-based line of a byte offset.
	#[must_use]
	pub fn line_of(&self, offset: usize) -> usize {
		match self.line_starts.binary_search(&offset) {
			Ok(i) => i,
			Err(i) => i - 1,
		}
	}

	#[must_use]
	pub fn node(&self, id: NodeId) -> &Node {
		&self.nodes[id]
	}

	/// The place of `id` among the `siblings`: the hint when it is right, else a search.
	fn place(&self, id: NodeId, siblings: &[NodeId]) -> Option<usize> {
		let hint = self.nodes[id].index_in_parent;
		if siblings.get(hint) == Some(&id) {
			Some(hint)
		} else {
			#[cfg(test)]
			self.misses.set(self.misses.get() + 1);
			siblings.iter().position(|&c| c == id)
		}
	}

	#[must_use]
	pub fn prev(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = self.place(id, siblings)?;
		i.checked_sub(1).map(|j| siblings[j])
	}

	#[must_use]
	pub fn next(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = self.place(id, siblings)?;
		siblings.get(i + 1).copied()
	}

	/// Sets `index_in_parent` of every child of `parent` from its `children`. It costs one pass
	/// over the children, so a step calls it once after it changed the list, not for each change.
	pub fn reindex_children(&mut self, parent: NodeId) {
		for i in 0..self.nodes[parent].children.len() {
			let c = self.nodes[parent].children[i];
			self.nodes[c].index_in_parent = i;
		}
	}

	#[must_use]
	pub fn first_child(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id].children.first().copied()
	}

	#[must_use]
	pub fn last_child(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id].children.last().copied()
	}

	/// The source text of a span.
	#[must_use]
	pub fn slice(&self, span: Span) -> &str {
		&self.text[span.start.min(self.text.len())..span.end.min(self.text.len())]
	}

	/// Replaces the children of `parent`, fixing the parent links.
	pub fn set_children(&mut self, parent: NodeId, children: Vec<NodeId>) {
		for (i, &c) in children.iter().enumerate() {
			self.nodes[c].parent = Some(parent);
			self.nodes[c].index_in_parent = i;
		}
		self.nodes[parent].children = children;
	}
}

fn compute_line_starts(text: &str) -> Vec<usize> {
	let mut starts = vec![0];
	for (i, b) in text.bytes().enumerate() {
		if b == b'\n' {
			starts.push(i + 1);
		}
	}
	starts
}

/// Replaces every character except line feeds by spaces (`vt`), as many as the
/// character has bytes, so that a byte offset in the result is the same offset
/// in `text` (the spans of what follows are byte positions).
fn blank(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for c in text.chars() {
		if c == '\n' {
			out.push('\n');
		} else {
			for _ in 0..c.len_utf8() {
				out.push(' ');
			}
		}
	}
	out
}

struct Builder<'a> {
	text: &'a str,
	nodes: Vec<Node>,
}

fn lower_if_known_element(name: &str) -> String {
	// Both outcomes are the name itself when nothing in it is upper case.
	if !name.bytes().any(|b| b.is_ascii_uppercase()) {
		return name.to_owned();
	}
	let lower = name.to_ascii_lowercase();
	if tables::ELEMENT_NAMES.binary_search(&lower.as_str()).is_ok() {
		lower
	} else {
		name.to_owned()
	}
}

fn lower_if_known_attribute(element: &str, name: &str) -> String {
	// Both outcomes are the name itself when nothing in it is upper case.
	if !name.bytes().any(|b| b.is_ascii_uppercase()) {
		return name.to_owned();
	}
	let lower = name.to_ascii_lowercase();
	let known_for = |list: &str| -> bool {
		tables::ATTRIBUTES
			.binary_search_by(|(e, _)| (*e).cmp(list))
			.ok()
			.is_some_and(|i| {
				tables::ATTRIBUTES[i]
					.1
					.binary_search(&lower.as_str())
					.is_ok()
			})
	};
	let has_element = tables::ATTRIBUTES
		.binary_search_by(|(e, _)| (*e).cmp(element))
		.is_ok();
	if has_element && (known_for("*") || known_for(element)) {
		lower
	} else {
		name.to_owned()
	}
}

impl Builder<'_> {
	fn alloc(&mut self, node: Node) -> NodeId {
		self.nodes.push(node);
		self.nodes.len() - 1
	}

	fn convert_attr(&self, element_name: &str, raw: &RawAttr) -> Attr {
		// `Qi`: the namespace is the prefix the lexer saw; the name is the raw
		// text, without the prefix when it was written explicitly.
		let namespace = if raw.prefix.is_empty() {
			None
		} else {
			Some(raw.prefix.clone())
		};
		let written = &self.text[raw.name_span.start..raw.name_span.end];
		let explicit = namespace
			.as_deref()
			.is_some_and(|ns| written.starts_with(&format!("{ns}:")));
		// normalizeAttributeName: only attributes without a namespace.
		let name = if explicit {
			written[namespace.as_deref().map_or(0, str::len) + 1..].to_owned()
		} else if namespace.is_none() {
			lower_if_known_attribute(element_name, written)
		} else {
			written.to_owned()
		};
		let full_name = match &namespace {
			Some(ns) => format!("{ns}:{name}"),
			None => name.clone(),
		};
		let raw_name = if explicit { full_name.clone() } else { name };
		let value = raw.value_span.map(|vs| {
			let v = &self.text[vs.start..vs.end];
			if v.starts_with(['"', '\'']) && v.len() >= 2 {
				v[1..v.len() - 1].to_owned()
			} else if v.starts_with(['"', '\'']) {
				String::new()
			} else {
				v.to_owned()
			}
		});
		Attr {
			raw_name,
			full_name,
			value,
			span: raw.span,
			value_span: raw.value_span,
		}
	}

	fn convert(&mut self, raw: &RawTree, id: usize, parent: Option<NodeId>) -> Option<NodeId> {
		let rn = &raw.nodes[id];
		let node = match &rn.kind {
			RawKind::Element {
				full_name,
				attrs,
				self_closing: _,
				start_span,
				end_span,
				name_span,
			} => {
				let mut n = Node::new(Kind::Element, rn.span);
				n.start_span = *start_span;
				n.end_span = *end_span;
				// `Qi` on the element: namespace from the full name, name from
				// the raw text of the tag name.
				let (ns, _) = angular::split_full_name(full_name);
				let written = &self.text[name_span.start..name_span.end];
				let explicit = ns.is_some_and(|ns| written.starts_with(&format!("{ns}:")));
				n.namespace = ns.map(str::to_owned);
				n.has_explicit_namespace = explicit;
				let mut name = if explicit {
					written[ns.map_or(0, str::len) + 1..].to_owned()
				} else {
					written.to_owned()
				};
				// Tag definition: the table entry when the namespace is absent
				// or implied, the default otherwise.
				let def = angular::tag_def(&name);
				let ns_implied = ns.is_none() || ns == def.implicit_namespace;
				n.tag_def = if ns_implied || n.is_unknown_namespace() {
					def
				} else {
					angular::tag_def("")
				};
				// normalizeTagName
				if ns_implied || n.is_unknown_namespace() {
					name = lower_if_known_element(&name);
				}
				n.name = name.clone();
				n.attrs = attrs.iter().map(|a| self.convert_attr(&name, a)).collect();
				n
			}
			RawKind::Text => {
				let mut n = Node::new(Kind::Text, rn.span);
				n.value = self.text[rn.span.start..rn.span.end].to_owned();
				n
			}
			RawKind::Comment => {
				let text = &self.text[rn.span.start..rn.span.end];
				// `sourceSpan.toString().slice(4, -3)`, clamped like JavaScript's.
				let chars: Vec<char> = text.chars().collect();
				let from = 4.min(chars.len());
				let to = chars.len().saturating_sub(3).max(from);
				let value: String = chars[from..to].iter().collect();
				let mut n = Node::new(Kind::Comment, rn.span);
				n.value = value;
				n
			}
			RawKind::DocType => {
				let mut n = Node::new(Kind::DocType, rn.span);
				n.value = rn.value.clone();
				n
			}
			RawKind::Cdata => {
				let mut n = Node::new(Kind::Cdata, rn.span);
				n.value = rn.value.clone();
				n
			}
		};
		let is_comment = node.kind == Kind::Comment;
		let id_new = self.alloc(node);
		self.nodes[id_new].parent = parent;
		if is_comment && let Some(ie) = self.ie_conditional(id_new) {
			// The comment is replaced by the node built from it.
			return Some(ie);
		}
		let children: Vec<NodeId> = rn
			.children
			.iter()
			.filter_map(|&c| self.convert(raw, c, Some(id_new)))
			.collect();
		self.nodes[id_new].children = children;
		Some(id_new)
	}

	/// IE conditional comments: `<!--[if IE]>…<![endif]-->`,
	/// `<!--[if !IE]><!-->` and `<!--<![endif]-->`.
	fn ie_conditional(&mut self, comment: NodeId) -> Option<NodeId> {
		let span = self.nodes[comment].span;
		let value = self.nodes[comment].value.clone();
		let parent = self.nodes[comment].parent;
		if let Some(rest) = value.strip_prefix("[if")
			&& let Some(close) = rest.find("]>")
		{
			let condition = &rest[..close];
			if !condition.contains(']') {
				let after = &rest[close + 2..];
				// start: `[if cond]><!`
				if after == "<!" {
					let mut n = Node::new(Kind::IeConditionalStartComment, span);
					n.condition = Some(collapse_ws(condition));
					n.parent = parent;
					self.nodes[comment] = n;
					return Some(comment);
				}
				// full: `[if cond]>data<![endif]` where `<!` + optional ws + `[endif]` ends the value
				let data_end = find_endif(after)?;
				let suffix_len = "[if".len() + close + 2;
				let data_start = span.start + 4 + suffix_len;
				let data = &after[..data_end];
				let data_end_offset = data_start + data.len();
				let children = self.parse_nested(data_start, data);
				let mut n = Node::new(Kind::IeConditionalComment, span);
				n.condition = Some(collapse_ws(condition));
				n.start_span = Span {
					start: span.start,
					end: data_start,
				};
				n.end_span = Some(Span {
					start: data_end_offset,
					end: span.end,
				});
				n.parent = parent;
				match children {
					Some(children) => {
						n.complete = true;
						self.nodes[comment] = n;
						for &c in &children {
							self.nodes[c].parent = Some(comment);
						}
						self.nodes[comment].children = children;
					}
					None => {
						n.complete = false;
						self.nodes[comment] = n;
						let mut t = Node::new(
							Kind::Text,
							Span {
								start: data_start,
								end: data_end_offset,
							},
						);
						t.value = data.to_owned();
						let tid = self.alloc(t);
						self.nodes[tid].parent = Some(comment);
						self.nodes[comment].children = vec![tid];
					}
				}
				return Some(comment);
			}
		}
		// end: `<![endif]` with optional white space after `<!`
		if let Some(rest) = value.strip_prefix("<!")
			&& rest.trim_start_matches(super::util::is_js_space) == "[endif]"
		{
			let mut n = Node::new(Kind::IeConditionalEndComment, span);
			n.parent = parent;
			self.nodes[comment] = n;
			return Some(comment);
		}
		None
	}

	/// Parses the data of a conditional comment in place: the text before it
	/// is blanked (newlines kept) so that spans and lines stay those of the
	/// whole document.
	fn parse_nested(&mut self, offset: usize, data: &str) -> Option<Vec<NodeId>> {
		let padded = format!("{}{}", blank(&self.text[..offset]), data);
		let raw = angular::parse(&padded).ok()?;
		let mut ids = Vec::new();
		for &r in &raw.roots {
			if let Some(id) = self.convert(&raw, r, None) {
				ids.push(id);
			}
		}
		// The first child holds the blank padding (`Ho` slices it off).
		if let Some(&first) = ids.first()
			&& self.nodes[first].kind == Kind::Text
			&& self.nodes[first].span.start == 0
		{
			let n = &mut self.nodes[first];
			n.span.start = offset.min(n.span.end);
			// `blank` pads one ASCII byte per source byte, so `offset` counts bytes.
			n.value = n.value.get(offset..).unwrap_or_default().to_owned();
		}
		Some(ids)
	}
}

fn collapse_ws(s: &str) -> String {
	s.trim_matches(crate::parser::is_js_space)
		.split(crate::parser::is_js_space)
		.filter(|p| !p.is_empty())
		.collect::<Vec<_>>()
		.join(" ")
}

/// Where `data<!\s*[endif]` ends the data: the position of the final `<!`.
fn find_endif(after: &str) -> Option<usize> {
	let tail = after.strip_suffix("[endif]")?;
	let tail = tail.trim_end_matches(super::util::is_js_space);
	let data = tail.strip_suffix("<!")?;
	Some(data.len())
}

/// The deepest nesting that is taken. The conversion and the printer recurse once per
/// level, and a pool thread has a stack of 2 MiB that ends at about a thousand levels,
/// so what is deeper is refused with an error instead of overflowing the stack (no real
/// page comes near).
pub const MAX_DEPTH: usize = 256;

/// The source offset of the first node deeper than [`MAX_DEPTH`], found without recursion.
fn too_deep(raw: &RawTree) -> Option<usize> {
	let mut stack: Vec<(usize, usize)> = raw.roots.iter().map(|&r| (r, 1)).collect();
	while let Some((id, depth)) = stack.pop() {
		let node = &raw.nodes[id];
		if depth > MAX_DEPTH {
			return Some(node.span.start);
		}
		for &child in &node.children {
			stack.push((child, depth + 1));
		}
	}
	None
}

/// Parses `text` into prettier's AST.
///
/// # Errors
///
/// The first error prettier's parser would throw, and one for elements nested deeper than
/// [`MAX_DEPTH`].
pub fn build(text: &str) -> Result<Ast, ParseError> {
	let raw = angular::parse(text)?;
	if let Some(offset) = too_deep(&raw) {
		return Err(ParseError {
			message: format!("elements are nested deeper than {MAX_DEPTH} levels"),
			offset,
		});
	}
	let mut b = Builder {
		text,
		nodes: Vec::with_capacity((raw.nodes.len() + 1).min(1 << 16)),
	};
	let root_span = Span {
		start: 0,
		end: text.len(),
	};
	let mut root = Node::new(Kind::Root, root_span);
	root.complete = true;
	let root_id = b.alloc(root);
	let mut children = Vec::new();
	for &r in &raw.roots {
		if let Some(id) = b.convert(&raw, r, Some(root_id)) {
			children.push(id);
		}
	}
	b.nodes[root_id].children = children;
	let mut ast = Ast {
		nodes: b.nodes,
		root: root_id,
		text: text.to_owned(),
		line_starts: compute_line_starts(text),
		#[cfg(test)]
		misses: std::cell::Cell::new(0),
	};
	fix_parents(&mut ast);
	Ok(ast)
}

/// Makes every child's `parent` and `index_in_parent` agree with the `children` lists.
fn fix_parents(ast: &mut Ast) {
	let mut stack = vec![ast.root];
	while let Some(id) = stack.pop() {
		let children = std::mem::take(&mut ast.nodes[id].children);
		for (i, &c) in children.iter().enumerate() {
			ast.nodes[c].parent = Some(id);
			ast.nodes[c].index_in_parent = i;
			stack.push(c);
		}
		ast.nodes[id].children = children;
	}
}

#[cfg(test)]
mod tests {
	use super::super::preprocess::{self, WhitespaceSensitivity};
	use super::*;

	/// Whether every node that is still in the tree (reached through the `children` lists: a
	/// node the preprocessing took out keeps its old place) has the place and the parent its
	/// parent's list says.
	fn places_agree(ast: &Ast) -> bool {
		let mut stack = vec![ast.root];
		while let Some(id) = stack.pop() {
			for (i, &c) in ast.nodes[id].children.iter().enumerate() {
				if ast.nodes[c].index_in_parent != i || ast.nodes[c].parent != Some(id) {
					return false;
				}
				stack.push(c);
			}
		}
		true
	}

	fn preprocessed(src: &str, sensitivity: WhitespaceSensitivity) -> Ast {
		let mut ast = build(src).unwrap();
		preprocess::run(&mut ast, sensitivity);
		ast
	}

	/// The node ids in the tree, parents first.
	fn in_tree(ast: &Ast) -> Vec<NodeId> {
		let mut all = Vec::new();
		let mut stack = vec![ast.root];
		while let Some(id) = stack.pop() {
			all.push(id);
			stack.extend(ast.node(id).children.iter().rev().copied());
		}
		all
	}

	#[test]
	fn a_node_knows_its_place_among_its_siblings() {
		let src = format!("<ul>{}</ul>", "<li>x</li>".repeat(5000));
		let ast = build(&src).unwrap();
		assert!(places_agree(&ast));
		let ul = ast.node(ast.root).children[0];
		let items = ast.node(ul).children.clone();
		assert_eq!(items.len(), 5000);
		assert_eq!(ast.prev(items[0]), None);
		assert_eq!(ast.next(items[4999]), None);
		for w in items.windows(2) {
			assert_eq!(ast.next(w[0]), Some(w[1]));
			assert_eq!(ast.prev(w[1]), Some(w[0]));
		}
		assert_eq!(ast.misses.get(), 0);
	}

	#[test]
	fn the_places_hold_and_are_never_searched_for_after_each_step_that_takes_children_out() {
		// One page for each step: blank text between elements goes away, text around a simple
		// element is merged, the line feed that starts a `pre` is dropped with its text, a
		// conditional comment is merged into the tag it opens, a CDATA section is merged into
		// The last page has all of them in a parent with hundreds of children.
		let mut wide = String::from("<ul>");
		for i in 0..300 {
			wide.push_str(&format!(
				"\n <li>{i}</li> <!-- c{i} -->\n <li><b>x</b>y<i>z</i>w</li><pre>\n<b>q</b></pre>"
			));
		}
		wide.push_str("</ul><svg>a<![CDATA[b]]>c</svg>");
		let pages = [
			"<div> <p>a</p> \n <b>x</b>y<i>z</i>w<!-- c --> <span> </span>\n</div>",
			"<pre>\n</pre><pre>\n<b>x</b></pre><textarea>\n</textarea>",
			"<!--[if IE]><!--><html lang=\"ja\"><!--<![endif]--><body><p>a</p></body></html>",
			"<svg>a<![CDATA[b]]>c<g></g><![CDATA[d]]></svg>",
			wide.as_str(),
		];
		for sensitivity in [
			WhitespaceSensitivity::Css,
			WhitespaceSensitivity::Strict,
			WhitespaceSensitivity::Ignore,
		] {
			for (n, src) in pages.into_iter().enumerate() {
				let ast = preprocessed(src, sensitivity);
				assert!(places_agree(&ast), "page {n}, {sensitivity:?}");
				for id in in_tree(&ast) {
					if let Some(next) = ast.next(id) {
						assert_eq!(ast.prev(next), Some(id), "page {n}, {sensitivity:?}");
					}
				}
				assert_eq!(ast.misses.get(), 0, "page {n}, {sensitivity:?}");
			}
		}
	}

	#[test]
	fn what_the_steps_take_out_is_gone_from_the_lists() {
		let ast = preprocessed(
			"<ul> <li>a</li> \n <li>b</li> <li>c</li></ul>",
			WhitespaceSensitivity::Css,
		);
		let ul = ast.node(ast.root).children[0];
		let items = ast.node(ul).children.clone();
		assert_eq!(items.len(), 3);
		assert_eq!(ast.prev(items[0]), None);
		assert_eq!(ast.next(items[0]), Some(items[1]));
		assert_eq!(ast.prev(items[2]), Some(items[1]));
		assert_eq!(ast.next(items[2]), None);

		let ast = preprocessed("<pre>\n<b>x</b></pre>", WhitespaceSensitivity::Css);
		let pre = ast.node(ast.root).children[0];
		assert_eq!(ast.node(pre).children.len(), 1);
		let b = ast.node(pre).children[0];
		assert_eq!(ast.node(b).kind, Kind::Element);
		assert_eq!((ast.prev(b), ast.next(b)), (None, None));

		let ast = preprocessed(
			"<svg>a<![CDATA[b]]>c<g></g></svg>",
			WhitespaceSensitivity::Css,
		);
		let svg = ast.node(ast.root).children[0];
		let kinds: Vec<Kind> = ast
			.node(svg)
			.children
			.iter()
			.map(|&c| ast.node(c).kind)
			.collect();
		assert_eq!(kinds, [Kind::Text, Kind::Element]);
		let text = ast.node(svg).children[0];
		assert_eq!(ast.node(text).value, "a<![CDATA[b]]>c");

		let ast = preprocessed(
			"<!--[if IE]><!--><html lang=\"ja\"><!--<![endif]--><body></body></html>",
			WhitespaceSensitivity::Css,
		);
		let kids = &ast.node(ast.root).children;
		assert_eq!(kids.len(), 1);
		assert_eq!(ast.node(kids[0]).condition.as_deref(), Some("IE"));
	}

	#[test]
	fn an_element_of_white_space_only_keeps_no_children_and_a_dangling_space() {
		let ast = preprocessed("<span> </span><span></span>", WhitespaceSensitivity::Css);
		let kids = ast.node(ast.root).children.clone();
		assert_eq!(kids.len(), 2);
		assert!(ast.node(kids[0]).children.is_empty());
		assert!(ast.node(kids[0]).has_dangling_spaces);
		assert!(ast.node(kids[1]).children.is_empty());
		assert!(!ast.node(kids[1]).has_dangling_spaces);
	}

	#[test]
	fn a_stale_place_does_not_change_the_answer() {
		// The hint of a node that stood behind a removed one, and one past the end of a list that
		// got shorter.
		let mut ast = build("<p><a></a><b></b><i></i></p>").unwrap();
		let p = ast.node(ast.root).children[0];
		let kids = ast.node(p).children.clone();
		ast.nodes[p].children.remove(0);
		assert_eq!(ast.prev(kids[1]), None);
		assert_eq!(ast.next(kids[1]), Some(kids[2]));
		assert_eq!(ast.prev(kids[2]), Some(kids[1]));
		ast.nodes[p].children.pop();
		assert_eq!(ast.next(kids[1]), None);
		assert_eq!(
			ast.prev(kids[2]),
			None,
			"a node that left the list has no sibling"
		);
		assert!(ast.misses.get() > 0);
	}
}
