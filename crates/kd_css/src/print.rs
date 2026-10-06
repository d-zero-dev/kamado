//! Printing the tree without white space.

use crate::parse::{AtRule, Body, Node};

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
	// A `;` stays before a comment that follows a declaration: without it
	// the comment would read as part of the value.
	let len = nodes.len();
	for (i, n) in nodes.iter().enumerate() {
		print_node(n, out, i + 1 == len);
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
	match node {
		Node::Comment(c) => out.push_str(&c.text),
		Node::Declaration(d) => {
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
			out.push_str(&r.selector);
			out.push('{');
			print_nodes(&r.nodes, out);
			out.push('}');
		}
		Node::AtRule(a) => print_at_rule(a, out, last),
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
			print_nodes(nodes, out);
			out.push('}');
		}
		Body::Raw(raw) => {
			out.push('{');
			out.push_str(raw);
			out.push('}');
		}
	}
}
