//! Printing the tree without white space.

use crate::parse::{AtRule, Body, Node};

/// Prints a list of nodes. The last node of the list gets no `;`.
pub fn print_nodes(nodes: &[Node], out: &mut String, _root: bool) {
	let len = nodes.len();
	for (i, n) in nodes.iter().enumerate() {
		print_node(n, out, i + 1 == len);
	}
}

/// Prints one node; `last` is whether nothing follows it in its block.
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
			print_nodes(&r.nodes, out, false);
			out.push('}');
		}
		Node::AtRule(a) => print_at_rule(a, out, last),
	}
}

/// Prints an at-rule.
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
			print_nodes(nodes, out, false);
			out.push('}');
		}
		Body::Raw(raw) => {
			out.push('{');
			out.push_str(raw);
			out.push('}');
		}
	}
}
