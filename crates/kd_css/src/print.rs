//! Printing the tree without white space.
//!
//! A printer can also record where each rule, at-rule and declaration starts
//! in the output next to where it started in the source (a [`Mark`]): that is
//! what a source map is made of.

use crate::parse::{AtRule, Body, Node};

/// Where a node starts in the output and in the source (byte offsets).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
	pub out: usize,
	pub src: usize,
}

/// Collects marks while printing.
type Marks<'a> = Option<&'a mut Vec<Mark>>;

fn mark(marks: &mut Marks<'_>, out: &str, src: usize) {
	if let Some(marks) = marks {
		marks.push(Mark {
			out: out.len(),
			src,
		});
	}
}

/// Prints a list of nodes without white space. The last node of the list
/// gets no `;`.
///
/// # Example
///
/// ```
/// use kd_css::parse::parse_stylesheet;
/// use kd_css::print::print_nodes;
///
/// let sheet = parse_stylesheet("a { b : c ; d : e } @import 'x';");
/// let mut out = String::new();
/// print_nodes(&sheet.nodes, &mut out);
/// assert_eq!(out, "a{b:c;d:e}@import 'x'");
/// ```
pub fn print_nodes(nodes: &[Node], out: &mut String) {
	nodes_marked(nodes, out, &mut None);
}

/// Like [`print_nodes`], and records a [`Mark`] for every rule, at-rule and
/// declaration in `marks`, in output order.
///
/// # Example
///
/// ```
/// use kd_css::parse::parse_stylesheet;
/// use kd_css::print::{print_nodes_marked, Mark};
///
/// let sheet = parse_stylesheet("a { b : c }\nd { e : f }");
/// let (mut out, mut marks) = (String::new(), Vec::new());
/// print_nodes_marked(&sheet.nodes, &mut out, &mut marks);
/// assert_eq!(out, "a{b:c}d{e:f}");
/// assert_eq!(marks[0], Mark { out: 0, src: 0 });
/// assert_eq!(marks[2], Mark { out: 6, src: 12 });
/// ```
pub fn print_nodes_marked(nodes: &[Node], out: &mut String, marks: &mut Vec<Mark>) {
	nodes_marked(nodes, out, &mut Some(marks));
}

fn nodes_marked(nodes: &[Node], out: &mut String, marks: &mut Marks<'_>) {
	// A `;` stays before a comment that follows a declaration: without it
	// the comment would read as part of the value.
	let len = nodes.len();
	for (i, n) in nodes.iter().enumerate() {
		node_marked(n, out, i + 1 == len, marks);
	}
}

/// Prints one node; `last` is whether nothing follows it in its block.
///
/// # Example
///
/// ```
/// use kd_css::parse::parse_stylesheet;
/// use kd_css::print::print_node;
///
/// let sheet = parse_stylesheet("a{b:c}");
/// let mut out = String::new();
/// print_node(&sheet.nodes[0], &mut out, true);
/// assert_eq!(out, "a{b:c}");
/// ```
pub fn print_node(node: &Node, out: &mut String, last: bool) {
	node_marked(node, out, last, &mut None);
}

fn node_marked(node: &Node, out: &mut String, last: bool, marks: &mut Marks<'_>) {
	match node {
		Node::Comment(c) => out.push_str(&c.text),
		Node::Declaration(d) => {
			mark(marks, out, d.offset);
			out.push_str(&d.property);
			out.push(':');
			out.push_str(&d.value);
			if d.important {
				out.push_str("!important");
			}
			if !last {
				out.push(';');
			}
		}
		Node::Rule(r) => {
			mark(marks, out, r.offset);
			out.push_str(&r.selector);
			out.push('{');
			nodes_marked(&r.nodes, out, marks);
			out.push('}');
		}
		Node::AtRule(a) => at_rule_marked(a, out, last, marks),
	}
}

/// Prints an at-rule.
///
/// # Example
///
/// ```
/// use kd_css::parse::{parse_stylesheet, Node};
/// use kd_css::print::print_at_rule;
///
/// let sheet = parse_stylesheet("@media print { a { b : c } }");
/// let Node::AtRule(at) = &sheet.nodes[0] else { panic!() };
/// let mut out = String::new();
/// print_at_rule(at, &mut out, true);
/// assert_eq!(out, "@media print{a{b:c}}");
/// ```
pub fn print_at_rule(a: &AtRule, out: &mut String, last: bool) {
	at_rule_marked(a, out, last, &mut None);
}

fn at_rule_marked(a: &AtRule, out: &mut String, last: bool, marks: &mut Marks<'_>) {
	mark(marks, out, a.offset);
	out.push('@');
	out.push_str(&a.name);
	if !a.prelude.is_empty() {
		if a.space {
			out.push(' ');
		}
		out.push_str(&a.prelude);
	}
	match &a.body {
		Body::None => {
			if !last {
				out.push(';');
			}
		}
		Body::Nodes(nodes) => {
			out.push('{');
			nodes_marked(nodes, out, marks);
			out.push('}');
		}
		Body::Raw(raw) => {
			out.push('{');
			out.push_str(raw);
			out.push('}');
		}
	}
}
