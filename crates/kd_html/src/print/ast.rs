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

#[derive(Debug)]
pub struct Node {
	pub kind: Kind,
	/// The node whose `children` holds this one; `None` for the root and for a node that a step
	/// took out of its parent's list. Written only in this module (read it with
	/// [`Node::parent`]).
	parent: Option<NodeId>,
	/// Where this node stands in its parent's `children`. Every way to change a list is a method
	/// of [`Ast`] (or [`build`], which sets every place at once at its end: the places are not
	/// set while the tree is being built), and it sets the places of what it moved before it
	/// returns, so [`Ast::prev`] and [`Ast::next`] read it without searching. A debug build
	/// checks it.
	index_in_parent: usize,
	/// The ids of the children, in order. Read it with [`Node::children`]; it is changed only by
	/// [`Ast::retain_children`], [`Ast::remove_first_child`] and [`Ast::clear_children`], so
	/// that no list changes without the places of its children following.
	children: Vec<NodeId>,
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
	/// The children, in order.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let ast = build("<ul><li>a</li><li>b</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// assert_eq!(ast.node(ul).children().len(), 2);
	/// ```
	#[must_use]
	pub fn children(&self) -> &[NodeId] {
		&self.children
	}

	/// The node this one is a child of. `None` for the root, and for a node that
	/// [`Ast::retain_children`], [`Ast::remove_first_child`] or [`Ast::clear_children`] took out
	/// of its parent's list: it has no siblings either. Only that node: what stands below it
	/// stays as it was, a detached subtree whose links to each other still hold.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let ast = build("<p>a</p>").unwrap();
	/// let p = ast.node(ast.root).children()[0];
	/// assert_eq!(ast.node(p).parent(), Some(ast.root));
	/// assert_eq!(ast.node(ast.root).parent(), None);
	/// ```
	#[must_use]
	pub fn parent(&self) -> Option<NodeId> {
		self.parent
	}

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
	/// Every node, in the order they were made. Read with [`Ast::node`], written with
	/// [`Ast::node_mut`] (the flags the preprocessing sets are fields of a node); the parent,
	/// place and list of a node change only through the methods of [`Ast`]. `Node` cannot be
	/// cloned and has no constructor outside this module, so no node can be replaced by a copy
	/// of another, which would carry the place and the list of the other along.
	nodes: Vec<Node>,
	pub root: NodeId,
	pub text: String,
	line_starts: Vec<usize>,
}

/// What [`Ast::retain_children`] does with the child it asks about.
///
/// # Example
///
/// ```
/// use kd_html::print::ast::{build, Retain};
///
/// let mut ast = build("<ul><li>a</li><li>b</li><li>c</li></ul>").unwrap();
/// let ul = ast.node(ast.root).children()[0];
/// let items = ast.node(ul).children().to_vec();
/// // `b` goes with the one after it.
/// ast.retain_children(ul, |_, child, _, _| {
///     if child == items[1] { Retain::DropWithNext } else { Retain::Keep }
/// });
/// assert_eq!(ast.node(ul).children(), [items[0]]);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Retain {
	/// The child stays.
	Keep,
	/// The child goes.
	Drop,
	/// The child stays, and the child kept before it goes: it takes the place of that one.
	/// There must be a kept child before it.
	InPlaceOfPrev,
	/// The child goes, and so does the one after it. There must be a child after it.
	DropWithNext,
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

	/// The node, to write the flags the preprocessing sets, and what the steps rewrite in place
	/// (`kind`, `value`, `span`). Its parent, place and children are private to this module, so
	/// they cannot be written through it.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let mut ast = build("<p>a</p>").unwrap();
	/// let p = ast.node(ast.root).children()[0];
	/// ast.node_mut(p).has_leading_spaces = true;
	/// assert!(ast.node(p).has_leading_spaces);
	/// ```
	pub fn node_mut(&mut self, id: NodeId) -> &mut Node {
		&mut self.nodes[id]
	}

	/// How many nodes were made, those that left the tree included.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let ast = build("<p>a</p>").unwrap();
	/// assert!(ast.node_count() >= 3);
	/// ```
	#[must_use]
	pub fn node_count(&self) -> usize {
		self.nodes.len()
	}

	/// The child before `id` in its parent's list. The place of `id` is read as it stands, not
	/// searched for, because every change of a list sets the places before it returns: so
	/// this is for a node that is in the tree, and it is not called from the `decide` of
	/// [`Ast::retain_children`] (which has no [`Ast`]). `None` for the first child, and for a
	/// node that has no parent.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let ast = build("<ul><li>a</li><li>b</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// let items = ast.node(ul).children().to_vec();
	/// assert_eq!(ast.prev(items[0]), None);
	/// assert_eq!(ast.prev(items[1]), Some(items[0]));
	/// ```
	#[must_use]
	pub fn prev(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = self.nodes[id].index_in_parent;
		debug_assert_eq!(siblings.get(i), Some(&id), "stale place of node {id}");
		i.checked_sub(1).map(|j| siblings[j])
	}

	/// The child after `id` in its parent's list; the counterpart of [`Ast::prev`], with the
	/// same conditions.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let ast = build("<ul><li>a</li><li>b</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// let items = ast.node(ul).children().to_vec();
	/// assert_eq!(ast.next(items[0]), Some(items[1]));
	/// assert_eq!(ast.next(items[1]), None);
	/// ```
	#[must_use]
	pub fn next(&self, id: NodeId) -> Option<NodeId> {
		let parent = self.nodes[id].parent?;
		let siblings = &self.nodes[parent].children;
		let i = self.nodes[id].index_in_parent;
		debug_assert_eq!(siblings.get(i), Some(&id), "stale place of node {id}");
		siblings.get(i + 1).copied()
	}

	/// Whether every child of `parent` has `parent` as its parent and the place its list says.
	#[must_use]
	pub(super) fn children_agree(&self, parent: NodeId) -> bool {
		self.nodes[parent]
			.children
			.iter()
			.enumerate()
			.all(|(i, &c)| {
				self.nodes[c].parent == Some(parent) && self.nodes[c].index_in_parent == i
			})
	}

	/// Sets `index_in_parent` of the children of `parent` from slot `from` on.
	fn reindex_from(&mut self, parent: NodeId, from: usize) {
		for i in from..self.nodes[parent].children.len() {
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

	/// Goes over the children of `parent` once, in order, and keeps or drops each as `decide`
	/// says. `decide(nodes, child, prev, next)` gets the nodes (to read and write the child, and
	/// `prev` and `next`), the child, the child kept last (`prev`) and the one still to be read
	/// after it (`next`, which may itself be dropped when its turn comes). The children that
	/// stay are moved to the front of the same list, so that a parent with thousands of children
	/// costs one pass, not a move of everything behind each child that goes (which `Vec::remove`
	/// is).
	///
	/// A child that goes has no parent and no siblings afterwards. The places are set again from
	/// the first slot whose child changed, and not at all when nothing changed.
	///
	/// While `decide` runs, the list of `parent` is taken out: `nodes[parent].children()` reads
	/// as empty (the children of the other nodes, `prev` and `next` among them, read as they
	/// are), and `decide` is not given the [`Ast`], so it cannot ask [`Ast::prev`] or
	/// [`Ast::next`]. A panic in `decide` leaves `parent` without its list; the tree is not used
	/// after one.
	///
	/// A verdict that needs a neighbour that is not there (`InPlaceOfPrev` of the first kept
	/// child, `DropWithNext` of the last child) is a mistake of the caller: a debug build stops
	/// at it, and a release build takes `Keep` / `Drop` instead, which leaves the list whole
	/// rather than indexing outside it.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::{build, Retain};
	///
	/// let mut ast = build("<ul><li>a</li><li>b</li><li>c</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// let items = ast.node(ul).children().to_vec();
	/// // Drop the first and the last.
	/// ast.retain_children(ul, |_, child, _prev, _next| {
	///     if child == items[1] { Retain::Keep } else { Retain::Drop }
	/// });
	/// assert_eq!(ast.node(ul).children(), [items[1]]);
	/// assert_eq!(ast.prev(items[1]), None);
	/// assert_eq!(ast.node(items[0]).parent(), None);
	/// ```
	pub fn retain_children(
		&mut self,
		parent: NodeId,
		mut decide: impl FnMut(&mut [Node], NodeId, Option<NodeId>, Option<NodeId>) -> Retain,
	) {
		let mut list = std::mem::take(&mut self.nodes[parent].children);
		let (mut read, mut kept) = (0usize, 0usize);
		let mut dirty = usize::MAX;
		while read < list.len() {
			let child = list[read];
			let prev = kept.checked_sub(1).map(|j| list[j]);
			let next = list.get(read + 1).copied();
			let verdict = match decide(&mut self.nodes, child, prev, next) {
				Retain::InPlaceOfPrev if prev.is_none() => {
					debug_assert!(false, "InPlaceOfPrev of the first kept child");
					Retain::Keep
				}
				Retain::DropWithNext if next.is_none() => {
					debug_assert!(false, "DropWithNext of the last child");
					Retain::Drop
				}
				v => v,
			};
			match verdict {
				Retain::Keep => {
					if kept != read {
						list[kept] = child;
						dirty = dirty.min(kept);
					}
					kept += 1;
					read += 1;
				}
				Retain::Drop => {
					self.nodes[child].parent = None;
					dirty = dirty.min(kept);
					read += 1;
				}
				Retain::InPlaceOfPrev => {
					let gone = list[kept - 1];
					self.nodes[gone].parent = None;
					list[kept - 1] = child;
					dirty = dirty.min(kept - 1);
					read += 1;
				}
				Retain::DropWithNext => {
					self.nodes[child].parent = None;
					if let Some(x) = next {
						self.nodes[x].parent = None;
					}
					dirty = dirty.min(kept);
					read += 2;
				}
			}
		}
		list.truncate(kept);
		self.nodes[parent].children = list;
		if dirty != usize::MAX {
			self.reindex_from(parent, dirty);
		}
	}

	/// Takes the first child of `parent` out of its list; it has no parent afterwards. The
	/// places of the rest are set again, which is a pass over the list: for the one child that a
	/// step takes out of a list (the line feed that starts a `pre`, the end comment of a merged
	/// conditional comment), not for a loop over many (use [`Ast::retain_children`]).
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let mut ast = build("<ul><li>a</li><li>b</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// let items = ast.node(ul).children().to_vec();
	/// ast.remove_first_child(ul);
	/// assert_eq!(ast.node(ul).children(), [items[1]]);
	/// assert_eq!(ast.prev(items[1]), None);
	/// ```
	pub fn remove_first_child(&mut self, parent: NodeId) {
		if self.nodes[parent].children.is_empty() {
			return;
		}
		let first = self.nodes[parent].children.remove(0);
		self.nodes[first].parent = None;
		self.reindex_from(parent, 0);
	}

	/// Takes every child of `parent` out of its list; they have no parent afterwards.
	///
	/// # Example
	///
	/// ```
	/// use kd_html::print::ast::build;
	///
	/// let mut ast = build("<ul><li>a</li><li>b</li></ul>").unwrap();
	/// let ul = ast.node(ast.root).children()[0];
	/// ast.clear_children(ul);
	/// assert!(ast.node(ul).children().is_empty());
	/// ```
	pub fn clear_children(&mut self, parent: NodeId) {
		let list = std::mem::take(&mut self.nodes[parent].children);
		for c in list {
			self.nodes[c].parent = None;
		}
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
	}

	#[test]
	fn the_places_hold_after_each_step_that_takes_children_out() {
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
	#[cfg(debug_assertions)]
	#[should_panic(expected = "stale place")]
	fn a_stale_place_is_caught_instead_of_answered_with_another_sibling() {
		// A list changed behind the API: the node that stood behind the removed one has the
		// place its old neighbour had.
		let mut ast = build("<p><a></a><b></b><i></i></p>").unwrap();
		let p = ast.node(ast.root).children()[0];
		let kids = ast.node(p).children().to_vec();
		ast.nodes[p].children.remove(0);
		let _ = ast.prev(kids[1]);
	}

	/// The `<li>`s of `<ul><li>0</li>…<li>4</li></ul>`.
	fn five_items() -> (Ast, NodeId, Vec<NodeId>) {
		let ast = build("<ul><li>0</li><li>1</li><li>2</li><li>3</li><li>4</li></ul>").unwrap();
		let ul = ast.node(ast.root).children()[0];
		let items = ast.node(ul).children().to_vec();
		assert_eq!(items.len(), 5);
		(ast, ul, items)
	}

	#[test]
	fn retain_children_keeps_and_drops() {
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, child, _, _| {
			if child == items[1] || child == items[3] {
				Retain::Drop
			} else {
				Retain::Keep
			}
		});
		assert_eq!(ast.node(ul).children(), [items[0], items[2], items[4]]);
		assert!(places_agree(&ast));
		assert_eq!(ast.node(items[1]).parent(), None);
		assert_eq!(ast.node(items[3]).parent(), None);
		assert_eq!(ast.prev(items[2]), Some(items[0]));
		assert_eq!(ast.next(items[2]), Some(items[4]));
		assert_eq!((ast.prev(items[1]), ast.next(items[1])), (None, None));
	}

	#[test]
	fn retain_children_replaces_the_child_before() {
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, child, prev, _| {
			if child == items[2] {
				assert_eq!(prev, Some(items[1]));
				Retain::InPlaceOfPrev
			} else {
				Retain::Keep
			}
		});
		assert_eq!(
			ast.node(ul).children(),
			[items[0], items[2], items[3], items[4]]
		);
		assert!(places_agree(&ast));
		assert_eq!(ast.node(items[1]).parent(), None);
		assert_eq!(ast.prev(items[2]), Some(items[0]));
		assert_eq!(ast.next(items[0]), Some(items[2]));
	}

	#[test]
	fn retain_children_drops_a_child_with_the_one_after_it() {
		let (mut ast, ul, items) = five_items();
		let mut seen = Vec::new();
		ast.retain_children(ul, |_, child, prev, next| {
			seen.push((child, prev, next));
			if child == items[1] {
				Retain::DropWithNext
			} else {
				Retain::Keep
			}
		});
		assert_eq!(ast.node(ul).children(), [items[0], items[3], items[4]]);
		assert!(places_agree(&ast));
		assert_eq!(ast.node(items[1]).parent(), None);
		assert_eq!(ast.node(items[2]).parent(), None);
		// The one after a dropped pair is looked at with the last kept child as its `prev`.
		assert_eq!(
			seen,
			[
				(items[0], None, Some(items[1])),
				(items[1], Some(items[0]), Some(items[2])),
				(items[3], Some(items[0]), Some(items[4])),
				(items[4], Some(items[3]), None),
			]
		);
	}

	#[test]
	fn retain_children_with_nothing_to_change_changes_nothing() {
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, _, _, _| Retain::Keep);
		assert_eq!(ast.node(ul).children(), items.as_slice());
		assert!(places_agree(&ast));
	}

	#[test]
	fn a_node_that_replaces_one_keeps_its_place_next_to_what_stands_before() {
		// The merged `<html>` takes the slot of the start comment, behind the doctype: a place
		// counted from where the element was read would leave it one too far.
		let ast = preprocessed(
			"<!DOCTYPE html><!--[if IE]><!--><html lang=\"ja\"><!--<![endif]--><body></body></html>",
			WhitespaceSensitivity::Css,
		);
		let kids = ast.node(ast.root).children().to_vec();
		assert_eq!(kids.len(), 2);
		assert_eq!(ast.node(kids[0]).kind, Kind::DocType);
		assert_eq!(ast.node(kids[1]).condition.as_deref(), Some("IE"));
		assert_eq!(ast.prev(kids[1]), Some(kids[0]));
		assert_eq!(ast.next(kids[0]), Some(kids[1]));
		assert!(places_agree(&ast));
	}

	#[test]
	fn retain_children_sets_the_places_from_the_first_slot_that_changed() {
		// The first goes (every place changes), then the last (no place to set).
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, child, _, _| {
			if child == items[0] || child == items[4] {
				Retain::Drop
			} else {
				Retain::Keep
			}
		});
		assert_eq!(ast.node(ul).children(), &items[1..4]);
		assert!(places_agree(&ast));
		assert!(ast.children_agree(ul));

		// A drop, then a replacement: the place of the replacement is the one of what it replaces.
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, child, _, _| {
			if child == items[1] {
				Retain::Drop
			} else if child == items[3] {
				Retain::InPlaceOfPrev
			} else {
				Retain::Keep
			}
		});
		assert_eq!(ast.node(ul).children(), [items[0], items[3], items[4]]);
		assert!(places_agree(&ast));
		assert_eq!(ast.node(items[2]).parent(), None);

		// A pair at the start goes: what follows has no `prev` among the kept.
		let (mut ast, ul, items) = five_items();
		let mut first_prev = Some(items[0]);
		ast.retain_children(ul, |_, child, prev, _| {
			if child == items[0] {
				return Retain::DropWithNext;
			}
			if child == items[2] {
				first_prev = prev;
			}
			Retain::Keep
		});
		assert_eq!(first_prev, None);
		assert_eq!(ast.node(ul).children(), &items[2..]);
		assert!(places_agree(&ast));
	}

	#[test]
	fn retain_children_of_a_parent_without_children_does_nothing() {
		let mut ast = build("<p></p>").unwrap();
		let p = ast.node(ast.root).children()[0];
		ast.retain_children(p, |_, _, _, _| panic!("there is no child to ask about"));
		assert!(ast.node(p).children().is_empty());
	}

	#[test]
	fn the_list_being_looked_at_reads_as_empty_and_the_others_as_they_are() {
		let (mut ast, ul, items) = five_items();
		let mut seen = Vec::new();
		ast.retain_children(ul, |nodes, child, _, _| {
			seen.push((nodes[ul].children().len(), nodes[child].children().len()));
			Retain::Keep
		});
		assert_eq!(seen, [(0, 1); 5]);
		assert_eq!(ast.node(ul).children(), items.as_slice());
	}

	#[test]
	#[cfg(debug_assertions)]
	#[should_panic(expected = "InPlaceOfPrev of the first kept child")]
	fn a_replacement_without_a_child_before_it_is_a_mistake() {
		let (mut ast, ul, _) = five_items();
		ast.retain_children(ul, |_, _, _, _| Retain::InPlaceOfPrev);
	}

	#[test]
	#[cfg(debug_assertions)]
	#[should_panic(expected = "DropWithNext of the last child")]
	fn dropping_the_last_child_with_the_next_is_a_mistake() {
		let (mut ast, ul, items) = five_items();
		ast.retain_children(ul, |_, child, _, _| {
			if child == items[4] {
				Retain::DropWithNext
			} else {
				Retain::Keep
			}
		});
	}

	#[test]
	#[cfg(debug_assertions)]
	#[should_panic(expected = "stale place")]
	fn a_stale_place_is_caught_for_the_next_sibling_too() {
		let mut ast = build("<p><a></a><b></b><i></i></p>").unwrap();
		let p = ast.node(ast.root).children()[0];
		let kids = ast.node(p).children().to_vec();
		ast.nodes[p].children.remove(0);
		let _ = ast.next(kids[1]);
	}

	#[test]
	fn children_agree_tells_a_list_that_was_changed_behind_the_api() {
		let mut ast = build("<p><a></a><b></b></p>").unwrap();
		let p = ast.node(ast.root).children()[0];
		assert!(ast.children_agree(p));
		ast.nodes[p].children.remove(0);
		assert!(!ast.children_agree(p));
	}

	#[test]
	fn a_parent_with_thousands_of_children_between_which_white_space_goes_keeps_its_places() {
		let src = format!("<ul>{}</ul>", "\n <li>x</li> ".repeat(10_000));
		let ast = preprocessed(&src, WhitespaceSensitivity::Css);
		assert!(places_agree(&ast));
		let ul = ast.node(ast.root).children()[0];
		let items = ast.node(ul).children().to_vec();
		assert_eq!(items.len(), 10_000);
		assert_eq!(ast.prev(items[0]), None);
		for w in items.windows(2) {
			assert_eq!(ast.next(w[0]), Some(w[1]));
		}
	}

	#[test]
	fn the_first_child_and_all_children_can_be_taken_out() {
		let (mut ast, ul, items) = five_items();
		ast.remove_first_child(ul);
		assert_eq!(ast.node(ul).children(), &items[1..]);
		assert_eq!(ast.node(items[0]).parent(), None);
		assert!(places_agree(&ast));
		assert_eq!(ast.prev(items[1]), None);
		assert_eq!(ast.next(items[1]), Some(items[2]));

		ast.clear_children(ul);
		assert!(ast.node(ul).children().is_empty());
		for &item in &items {
			assert_eq!(ast.node(item).parent(), None);
		}
		// Nothing to take out of an empty list.
		ast.remove_first_child(ul);
		ast.clear_children(ul);
		assert!(places_agree(&ast));
	}

	#[test]
	fn what_the_steps_take_out_has_no_parent() {
		// For each page: the nodes (by their place among the children of the root's first child,
		// or of the root) that a step takes out of a list.
		type TakenOut = dyn Fn(&Ast) -> Vec<NodeId>;
		let pages: [(&str, &TakenOut); 4] = [
			("<div> <p>a</p> </div>", &|ast| {
				let div = ast.node(ast.root).children()[0];
				let kids = ast.node(div).children();
				vec![kids[0], kids[2]]
			}),
			("<!--[if IE]><!--><html><!--<![endif]--></html>", &|ast| {
				let kids = ast.node(ast.root).children();
				let html = kids[1];
				vec![kids[0], ast.node(html).children()[0]]
			}),
			("<svg>a<![CDATA[b]]>c</svg>", &|ast| {
				let svg = ast.node(ast.root).children()[0];
				ast.node(svg).children()[1..].to_vec()
			}),
			("<p>a<b>x</b>c</p>", &|ast| {
				let p = ast.node(ast.root).children()[0];
				ast.node(p).children()[1..].to_vec()
			}),
		];
		for (src, taken_out) in pages {
			let before = build(src).unwrap();
			let ids = taken_out(&before);
			assert!(!ids.is_empty(), "{src}");
			let mut ast = build(src).unwrap();
			preprocess::run(&mut ast, WhitespaceSensitivity::Css);
			for id in ids {
				assert_eq!(ast.node(id).parent(), None, "{src}: node {id}");
				assert!(!in_tree(&ast).contains(&id), "{src}: node {id}");
			}
		}
	}
}
