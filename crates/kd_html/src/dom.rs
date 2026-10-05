//! Arena DOM.
//!
//! All nodes of a document live in one `Vec`, addressed by `NodeId`; links
//! (parent, first/last child, previous/next sibling) are indices. Why an
//! arena: a page is built and dropped as a whole, so there is no per-node
//! allocation to free, nodes are cheap to copy around by id, and the
//! JavaScript side can hold a plain integer handle to a node.
//!
//! Removed nodes stay in the arena (they are only unlinked); a document is
//! short-lived, so reclaiming slots is not worth the bookkeeping.

/// Index of a node in its [`Document`].
pub type NodeId = u32;

/// The document node's id. Every document has exactly one root.
pub const ROOT: NodeId = 0;

/// One attribute. Names keep the case they were written in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Attr {
	pub name: String,
	pub value: String,
}

/// An element. `name` is lower-cased by the parser.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Element {
	pub name: String,
	pub attrs: Vec<Attr>,
	/// Created inside an `<svg>` subtree (including `<svg>` itself).
	pub svg: bool,
}

/// `<!DOCTYPE name [PUBLIC "p"] [SYSTEM] ["s"]>`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Doctype {
	pub name: String,
	pub public_id: String,
	pub system_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeKind {
	Document,
	Element(Element),
	Text(String),
	Comment(String),
	Doctype(Doctype),
	/// `<?php ... ?>` and friends, kept verbatim including the delimiters.
	ProcessingInstruction(String),
}

#[derive(Debug, Clone)]
struct Node {
	kind: NodeKind,
	parent: Option<NodeId>,
	first_child: Option<NodeId>,
	last_child: Option<NodeId>,
	prev: Option<NodeId>,
	next: Option<NodeId>,
}

/// A document: the arena plus the root node.
///
/// # Example
///
/// ```
/// use kd_html::dom::{Document, NodeKind, ROOT};
/// let mut doc = Document::new();
/// let p = doc.create_element("p");
/// doc.append_child(ROOT, p);
/// let text = doc.create_text("hi");
/// doc.append_child(p, text);
/// assert_eq!(doc.children(ROOT).count(), 1);
/// assert_eq!(doc.text_content(p), "hi");
/// ```
#[derive(Debug, Clone)]
pub struct Document {
	nodes: Vec<Node>,
}

impl Default for Document {
	fn default() -> Self {
		Self::new()
	}
}

impl Document {
	#[must_use]
	pub fn new() -> Document {
		Document {
			nodes: vec![Node {
				kind: NodeKind::Document,
				parent: None,
				first_child: None,
				last_child: None,
				prev: None,
				next: None,
			}],
		}
	}

	fn alloc(&mut self, kind: NodeKind) -> NodeId {
		let id = NodeId::try_from(self.nodes.len()).expect("fewer than 2^32 nodes");
		self.nodes.push(Node {
			kind,
			parent: None,
			first_child: None,
			last_child: None,
			prev: None,
			next: None,
		});
		id
	}

	pub fn create_element(&mut self, name: &str) -> NodeId {
		self.alloc(NodeKind::Element(Element {
			name: name.to_string(),
			attrs: Vec::new(),
			svg: false,
		}))
	}

	pub fn create_element_with(&mut self, element: Element) -> NodeId {
		self.alloc(NodeKind::Element(element))
	}

	pub fn create_text(&mut self, text: &str) -> NodeId {
		self.alloc(NodeKind::Text(text.to_string()))
	}

	pub fn create_comment(&mut self, data: &str) -> NodeId {
		self.alloc(NodeKind::Comment(data.to_string()))
	}

	pub fn create_doctype(&mut self, doctype: Doctype) -> NodeId {
		self.alloc(NodeKind::Doctype(doctype))
	}

	pub fn create_processing_instruction(&mut self, raw: &str) -> NodeId {
		self.alloc(NodeKind::ProcessingInstruction(raw.to_string()))
	}

	#[must_use]
	pub fn kind(&self, id: NodeId) -> &NodeKind {
		&self.nodes[id as usize].kind
	}

	pub fn kind_mut(&mut self, id: NodeId) -> &mut NodeKind {
		&mut self.nodes[id as usize].kind
	}

	#[must_use]
	pub fn element(&self, id: NodeId) -> Option<&Element> {
		match self.kind(id) {
			NodeKind::Element(e) => Some(e),
			_ => None,
		}
	}

	pub fn element_mut(&mut self, id: NodeId) -> Option<&mut Element> {
		match self.kind_mut(id) {
			NodeKind::Element(e) => Some(e),
			_ => None,
		}
	}

	#[must_use]
	pub fn parent(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id as usize].parent
	}

	#[must_use]
	pub fn first_child(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id as usize].first_child
	}

	#[must_use]
	pub fn last_child(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id as usize].last_child
	}

	#[must_use]
	pub fn next_sibling(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id as usize].next
	}

	#[must_use]
	pub fn prev_sibling(&self, id: NodeId) -> Option<NodeId> {
		self.nodes[id as usize].prev
	}

	/// Number of nodes ever created (including removed ones).
	#[must_use]
	pub fn len(&self) -> usize {
		self.nodes.len()
	}

	#[must_use]
	pub fn is_empty(&self) -> bool {
		self.nodes.len() == 1
	}

	/// Iterates the children of `id` in order.
	pub fn children(&self, id: NodeId) -> Children<'_> {
		Children {
			doc: self,
			next: self.first_child(id),
		}
	}

	/// Appends `child` as the last child of `parent`, detaching it first.
	pub fn append_child(&mut self, parent: NodeId, child: NodeId) {
		self.detach(child);
		let last = self.nodes[parent as usize].last_child;
		self.nodes[child as usize].parent = Some(parent);
		self.nodes[child as usize].prev = last;
		match last {
			Some(l) => self.nodes[l as usize].next = Some(child),
			None => self.nodes[parent as usize].first_child = Some(child),
		}
		self.nodes[parent as usize].last_child = Some(child);
	}

	/// Inserts `child` before `reference`, a child of some parent.
	pub fn insert_before(&mut self, reference: NodeId, child: NodeId) {
		self.detach(child);
		let parent = self.nodes[reference as usize]
			.parent
			.expect("reference node has a parent");
		let prev = self.nodes[reference as usize].prev;
		self.nodes[child as usize].parent = Some(parent);
		self.nodes[child as usize].prev = prev;
		self.nodes[child as usize].next = Some(reference);
		self.nodes[reference as usize].prev = Some(child);
		match prev {
			Some(p) => self.nodes[p as usize].next = Some(child),
			None => self.nodes[parent as usize].first_child = Some(child),
		}
	}

	/// Inserts `child` after `reference`, a child of some parent.
	pub fn insert_after(&mut self, reference: NodeId, child: NodeId) {
		match self.next_sibling(reference) {
			Some(next) => self.insert_before(next, child),
			None => {
				let parent = self.nodes[reference as usize]
					.parent
					.expect("reference node has a parent");
				self.append_child(parent, child);
			}
		}
	}

	/// Copies the subtree rooted at `node` of `from` into this arena and
	/// returns the id of the (detached) copy. For the document node of `from`
	/// the copy is a fragment holder: its children are the copied children,
	/// and the caller moves them where they belong.
	pub fn import_subtree(&mut self, from: &Document, node: NodeId) -> NodeId {
		let copy = match from.kind(node) {
			NodeKind::Document => {
				let holder = self.create_element("template");
				self.nodes[holder as usize].kind = NodeKind::Document;
				holder
			}
			NodeKind::Element(e) => self.create_element_with(e.clone()),
			NodeKind::Text(t) => self.create_text(t),
			NodeKind::Comment(c) => self.create_comment(c),
			NodeKind::Doctype(d) => self.create_doctype(d.clone()),
			NodeKind::ProcessingInstruction(raw) => self.create_processing_instruction(raw),
		};
		for child in from.children(node) {
			let child_copy = self.import_subtree(from, child);
			self.append_child(copy, child_copy);
		}
		copy
	}

	/// Inserts `child` as the first child of `parent`.
	pub fn prepend_child(&mut self, parent: NodeId, child: NodeId) {
		match self.first_child(parent) {
			Some(first) => self.insert_before(first, child),
			None => self.append_child(parent, child),
		}
	}

	/// Unlinks `id` from its parent. The node and its subtree stay in the
	/// arena and can be appended elsewhere.
	pub fn detach(&mut self, id: NodeId) {
		let Some(parent) = self.nodes[id as usize].parent else {
			return;
		};
		let prev = self.nodes[id as usize].prev;
		let next = self.nodes[id as usize].next;
		match prev {
			Some(p) => self.nodes[p as usize].next = next,
			None => self.nodes[parent as usize].first_child = next,
		}
		match next {
			Some(n) => self.nodes[n as usize].prev = prev,
			None => self.nodes[parent as usize].last_child = prev,
		}
		let node = &mut self.nodes[id as usize];
		node.parent = None;
		node.prev = None;
		node.next = None;
	}

	/// First element child of `id`.
	#[must_use]
	pub fn first_element_child(&self, id: NodeId) -> Option<NodeId> {
		self.children(id).find(|&c| self.element(c).is_some())
	}

	/// The concatenated text of all descendant text nodes, in document order.
	#[must_use]
	pub fn text_content(&self, id: NodeId) -> String {
		let mut out = String::new();
		self.collect_text(id, &mut out);
		out
	}

	fn collect_text(&self, id: NodeId, out: &mut String) {
		match self.kind(id) {
			NodeKind::Text(t) => out.push_str(t),
			NodeKind::Element(_) | NodeKind::Document => {
				for child in self.children(id) {
					self.collect_text(child, out);
				}
			}
			_ => {}
		}
	}

	/// Appends text to `parent`, merging into a trailing text node. Why merge:
	/// the tokenizer reports text and each decoded character reference
	/// separately, but they are one run of text to every consumer.
	pub fn append_text(&mut self, parent: NodeId, text: &str) {
		if let Some(last) = self.last_child(parent)
			&& let NodeKind::Text(existing) = self.kind_mut(last)
		{
			existing.push_str(text);
			return;
		}
		let id = self.create_text(text);
		self.append_child(parent, id);
	}
}

impl Element {
	/// Sets attribute `name` (exact match), keeping its position when it
	/// exists and appending it otherwise.
	pub fn set_attr(&mut self, name: &str, value: &str) {
		match self.attrs.iter_mut().find(|a| a.name == name) {
			Some(existing) => existing.value = value.to_owned(),
			None => self.attrs.push(Attr {
				name: name.to_owned(),
				value: value.to_owned(),
			}),
		}
	}

	/// Removes attribute `name` (exact match); whether it was there.
	pub fn remove_attr(&mut self, name: &str) -> bool {
		let before = self.attrs.len();
		self.attrs.retain(|a| a.name != name);
		self.attrs.len() != before
	}

	/// The value of attribute `name` (exact, case-sensitive match).
	#[must_use]
	pub fn attr(&self, name: &str) -> Option<&str> {
		self.attrs
			.iter()
			.find(|a| a.name == name)
			.map(|a| a.value.as_str())
	}
}

/// Iterator over a node's children.
pub struct Children<'a> {
	doc: &'a Document,
	next: Option<NodeId>,
}

impl Iterator for Children<'_> {
	type Item = NodeId;

	fn next(&mut self) -> Option<NodeId> {
		let current = self.next?;
		self.next = self.doc.next_sibling(current);
		Some(current)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn names(doc: &Document, parent: NodeId) -> Vec<String> {
		doc.children(parent)
			.map(|c| match doc.kind(c) {
				NodeKind::Element(e) => e.name.clone(),
				NodeKind::Text(t) => format!("#{t}"),
				_ => "?".to_string(),
			})
			.collect()
	}

	#[test]
	fn append_insert_prepend_and_detach_keep_links_consistent() {
		let mut doc = Document::new();
		let a = doc.create_element("a");
		let b = doc.create_element("b");
		let c = doc.create_element("c");
		doc.append_child(ROOT, a);
		doc.append_child(ROOT, c);
		doc.insert_before(c, b);
		assert_eq!(names(&doc, ROOT), ["a", "b", "c"]);

		let z = doc.create_element("z");
		doc.prepend_child(ROOT, z);
		assert_eq!(names(&doc, ROOT), ["z", "a", "b", "c"]);

		doc.detach(b);
		assert_eq!(names(&doc, ROOT), ["z", "a", "c"]);
		assert_eq!(doc.parent(b), None);
		assert_eq!(doc.next_sibling(a), Some(c));
		assert_eq!(doc.prev_sibling(c), Some(a));

		doc.detach(z);
		assert_eq!(doc.first_child(ROOT), Some(a));
		doc.detach(c);
		assert_eq!(doc.last_child(ROOT), Some(a));
		doc.detach(a);
		assert_eq!(doc.first_child(ROOT), None);
		assert_eq!(doc.last_child(ROOT), None);
	}

	#[test]
	fn appending_an_attached_node_moves_it() {
		let mut doc = Document::new();
		let a = doc.create_element("a");
		let b = doc.create_element("b");
		let x = doc.create_element("x");
		doc.append_child(ROOT, a);
		doc.append_child(ROOT, b);
		doc.append_child(a, x);
		doc.append_child(b, x);
		assert_eq!(names(&doc, a), Vec::<String>::new());
		assert_eq!(names(&doc, b), ["x"]);
		assert_eq!(doc.parent(x), Some(b));
	}

	#[test]
	fn text_nodes_merge_and_text_content_concatenates() {
		let mut doc = Document::new();
		let p = doc.create_element("p");
		doc.append_child(ROOT, p);
		doc.append_text(p, "a");
		doc.append_text(p, "&");
		doc.append_text(p, "b");
		assert_eq!(names(&doc, p), ["#a&b"]);
		let em = doc.create_element("em");
		doc.append_child(p, em);
		doc.append_text(em, "x");
		doc.append_text(p, "y");
		assert_eq!(names(&doc, p), ["#a&b", "em", "#y"]);
		assert_eq!(doc.text_content(p), "a&bxy");
	}

	#[test]
	fn element_helpers() {
		let mut doc = Document::new();
		let e = doc.create_element_with(Element {
			name: "a".into(),
			attrs: vec![Attr {
				name: "href".into(),
				value: "/x".into(),
			}],
			svg: false,
		});
		assert_eq!(doc.element(e).unwrap().attr("href"), Some("/x"));
		assert_eq!(doc.element(e).unwrap().attr("HREF"), None);
		doc.element_mut(e).unwrap().attrs.push(Attr {
			name: "id".into(),
			value: "i".into(),
		});
		assert_eq!(doc.element(e).unwrap().attrs.len(), 2);
		assert_eq!(doc.element(ROOT), None);
		assert_eq!(doc.first_element_child(ROOT), None);
		doc.append_child(ROOT, e);
		assert_eq!(doc.first_element_child(ROOT), Some(e));
		assert!(!doc.is_empty());
	}
}
