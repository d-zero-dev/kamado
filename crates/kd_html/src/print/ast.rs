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

	#[must_use]
	pub fn prev(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = siblings.iter().position(|&c| c == id)?;
		i.checked_sub(1).map(|j| siblings[j])
	}

	#[must_use]
	pub fn next(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = siblings.iter().position(|&c| c == id)?;
		siblings.get(i + 1).copied()
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
		for &c in &children {
			self.nodes[c].parent = Some(parent);
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
	let lower = name.to_ascii_lowercase();
	if tables::ELEMENT_NAMES.binary_search(&lower.as_str()).is_ok() {
		lower
	} else {
		name.to_owned()
	}
}

fn lower_if_known_attribute(element: &str, name: &str) -> String {
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
		let mut name = if explicit {
			written[namespace.as_deref().map_or(0, str::len) + 1..].to_owned()
		} else {
			written.to_owned()
		};
		// normalizeAttributeName: only attributes without a namespace.
		if namespace.is_none() {
			name = lower_if_known_attribute(element_name, &name);
		}
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
			n.value = n.value.chars().skip(offset).collect();
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
		nodes: Vec::new(),
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
	};
	fix_parents(&mut ast);
	Ok(ast)
}

/// Makes every child's `parent` agree with the `children` lists.
fn fix_parents(ast: &mut Ast) {
	let mut stack = vec![ast.root];
	while let Some(id) = stack.pop() {
		let children = ast.nodes[id].children.clone();
		for c in children {
			ast.nodes[c].parent = Some(id);
			stack.push(c);
		}
	}
}
