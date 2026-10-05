//! A tolerant parser for declaration values and at-rule preludes, in the
//! shape postcss-value-parser gives them, because cssnano's rules are written
//! against that shape: words, strings, dividers (`,` `/` `:`), spaces,
//! comments, functions and `unicode-range` tokens.
//!
//! Printing a parsed value reproduces the input byte for byte, so a rule that
//! changes nothing changes nothing.

/// One node of a parsed value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ValueNode {
	/// Anything that is not one of the others: `12px`, `red`, `#fff`, `+`.
	Word(String),
	/// `"..."` or `'...'`; `value` is the text between the quotes, as written.
	Str {
		quote: char,
		value: String,
		unclosed: bool,
	},
	/// `,` `/` or `:` with the white space around it.
	Div {
		before: String,
		value: char,
		after: String,
	},
	/// A run of white space.
	Space(String),
	/// `/* ... */`.
	Comment { value: String, unclosed: bool },
	/// `name(...)`; `url(` with an unquoted argument holds one word.
	Function {
		name: String,
		before: String,
		after: String,
		nodes: Vec<ValueNode>,
		unclosed: bool,
	},
	/// `U+26`, `u+0-7F`, `U+4??`.
	UnicodeRange(String),
}

impl ValueNode {
	/// The text a node stands for when it is a plain token (`""` for the
	/// structured ones), as postcss-value-parser's `node.value`.
	pub fn value(&self) -> String {
		match self {
			ValueNode::Word(s) | ValueNode::UnicodeRange(s) | ValueNode::Space(s) => s.clone(),
			ValueNode::Str { value, .. } | ValueNode::Comment { value, .. } => value.clone(),
			ValueNode::Div { value, .. } => value.to_string(),
			ValueNode::Function { name, .. } => name.clone(),
		}
	}

	/// Whether the node is a word.
	pub fn is_word(&self) -> bool {
		matches!(self, ValueNode::Word(_))
	}

	/// Whether the node is white space.
	pub fn is_space(&self) -> bool {
		matches!(self, ValueNode::Space(_))
	}

	/// Whether the node is a divider with this character.
	pub fn is_div(&self, c: char) -> bool {
		matches!(self, ValueNode::Div { value, .. } if *value == c)
	}

	/// The word text, when it is a word.
	pub fn word(&self) -> Option<&str> {
		match self {
			ValueNode::Word(s) => Some(s),
			_ => None,
		}
	}

	/// A word node.
	pub fn new_word(s: &str) -> ValueNode {
		ValueNode::Word(s.to_owned())
	}

	/// A single space node.
	pub fn new_space() -> ValueNode {
		ValueNode::Space(" ".to_owned())
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Parent {
	/// Nothing has been opened yet (the state of the parser at the start).
	Undefined,
	/// Back at the top after a function was closed.
	Root,
	Func {
		calc: bool,
	},
}

struct Frame {
	name: String,
	before: String,
	nodes: Vec<ValueNode>,
}

/// Parses a value.
///
/// # Example
///
/// ```
/// use kd_css::value::{parse, stringify, ValueNode};
///
/// let nodes = parse("1px solid rgb(0, 0, 0)");
/// assert_eq!(nodes.len(), 5);
/// assert!(matches!(nodes[4], ValueNode::Function { .. }));
/// assert_eq!(stringify(&nodes), "1px solid rgb(0, 0, 0)");
/// ```
pub fn parse(input: &str) -> Vec<ValueNode> {
	let b = input.as_bytes();
	let max = b.len();
	let mut stack: Vec<Frame> = vec![Frame {
		name: String::new(),
		before: String::new(),
		nodes: Vec::new(),
	}];
	let mut parent = Parent::Undefined;
	let mut pos = 0;
	let mut name = String::new();
	let mut before = String::new();
	let mut after = String::new();

	let code_at = |i: usize| -> Option<u8> { b.get(i).copied() };
	let is_space_code = |c: Option<u8>| c.is_some_and(|c| c <= 32);

	while pos < max {
		let code = b[pos];
		if code <= 32 {
			let mut next = pos + 1;
			while is_space_code(code_at(next)) {
				next += 1;
			}
			let token = &input[pos..next];
			let nc = code_at(next);
			let balanced = stack.len() > 1;
			let top = stack.last_mut().expect("the root frame");
			if nc == Some(b')') && balanced {
				after = token.to_owned();
			} else if let Some(ValueNode::Div { after: a, .. }) = top.nodes.last_mut() {
				*a = token.to_owned();
			} else if nc == Some(b',')
				|| nc == Some(b':')
				|| (nc == Some(b'/')
					&& code_at(next + 1) != Some(b'*')
					// postcss-value-parser treats the top level as a function
					// only until the first function closes; after that
					// `url(a) center / cover` keeps the space before `/`.
					// Here the top level is always one, so it goes.
					&& matches!(
						parent,
						Parent::Undefined | Parent::Root | Parent::Func { calc: false }
					)) {
				before = token.to_owned();
			} else {
				top.nodes.push(ValueNode::Space(token.to_owned()));
			}
			pos = next;
		} else if code == b'\'' || code == b'"' {
			let quote = code;
			let mut next = pos;
			let mut unclosed = false;
			loop {
				let mut escape = false;
				match input.as_bytes()[next + 1..]
					.iter()
					.position(|&c| c == quote)
				{
					Some(off) => {
						next = next + 1 + off;
						let mut p = next;
						while p > 0 && b[p - 1] == b'\\' {
							p -= 1;
							escape = !escape;
						}
					}
					None => {
						next = max;
						unclosed = true;
					}
				}
				if !escape {
					break;
				}
			}
			let value = input[pos + 1..next].to_owned();
			stack
				.last_mut()
				.expect("the root frame")
				.nodes
				.push(ValueNode::Str {
					quote: quote as char,
					value,
					unclosed,
				});
			pos = if unclosed { max } else { next + 1 };
		} else if code == b'/' && code_at(pos + 1) == Some(b'*') {
			let (value, unclosed, end) = match input[pos + 2..].find("*/") {
				Some(off) => (
					input[pos + 2..pos + 2 + off].to_owned(),
					false,
					pos + 2 + off + 2,
				),
				None => (input[pos + 2..].to_owned(), true, max),
			};
			stack
				.last_mut()
				.expect("the root frame")
				.nodes
				.push(ValueNode::Comment { value, unclosed });
			pos = end;
		} else if (code == b'/' || code == b'*') && parent == (Parent::Func { calc: true }) {
			stack
				.last_mut()
				.expect("the root frame")
				.nodes
				.push(ValueNode::Word((code as char).to_string()));
			pos += 1;
		} else if code == b'/' || code == b',' || code == b':' {
			stack
				.last_mut()
				.expect("the root frame")
				.nodes
				.push(ValueNode::Div {
					before: std::mem::take(&mut before),
					value: code as char,
					after: String::new(),
				});
			pos += 1;
		} else if code == b'(' {
			let mut next = pos + 1;
			while is_space_code(code_at(next)) {
				next += 1;
			}
			let fn_before = input[pos + 1..next].to_owned();
			let open = pos;
			pos = next;
			let c = code_at(next);
			if name == "url" && c != Some(b'\'') && c != Some(b'"') {
				// An unquoted URL: everything up to the closing parenthesis.
				let mut n = next.wrapping_sub(1);
				let mut unclosed = false;
				loop {
					let mut escape = false;
					let from = n.wrapping_add(1);
					match input
						.as_bytes()
						.get(from..)
						.and_then(|s| s.iter().position(|&c| c == b')'))
					{
						Some(off) => {
							n = from + off;
							let mut p = n;
							while p > 0 && b[p - 1] == b'\\' {
								p -= 1;
								escape = !escape;
							}
						}
						None => {
							n = max;
							unclosed = true;
						}
					}
					if !escape {
						break;
					}
				}
				// White space before the closing parenthesis.
				let mut ws = n;
				loop {
					if ws == 0 {
						break;
					}
					ws -= 1;
					if b[ws] > 32 {
						break;
					}
					if ws <= open {
						break;
					}
				}
				let mut nodes = Vec::new();
				let fn_after;
				if open < ws && b[ws] > 32 {
					if pos != ws + 1 {
						nodes.push(ValueNode::Word(input[pos..ws + 1].to_owned()));
					}
					if unclosed && ws + 1 != n {
						fn_after = String::new();
						nodes.push(ValueNode::Space(input[ws + 1..n].to_owned()));
					} else {
						fn_after = input[ws + 1..n].to_owned();
					}
				} else {
					fn_after = String::new();
				}
				stack
					.last_mut()
					.expect("the root frame")
					.nodes
					.push(ValueNode::Function {
						name: std::mem::take(&mut name),
						before: fn_before,
						after: fn_after,
						nodes,
						unclosed,
					});
				pos = if unclosed { max } else { n + 1 };
			} else {
				stack.push(Frame {
					name: std::mem::take(&mut name),
					before: fn_before,
					nodes: Vec::new(),
				});
				parent = Parent::Func {
					calc: stack.last().is_some_and(|f| f.name == "calc"),
				};
			}
			name.clear();
		} else if code == b')' && stack.len() > 1 {
			pos += 1;
			let frame = stack.pop().expect("a function frame");
			let node = ValueNode::Function {
				name: frame.name,
				before: frame.before,
				after: std::mem::take(&mut after),
				nodes: frame.nodes,
				unclosed: false,
			};
			stack.last_mut().expect("the parent frame").nodes.push(node);
			parent = if stack.len() == 1 {
				Parent::Root
			} else {
				Parent::Func {
					calc: stack.last().is_some_and(|f| f.name == "calc"),
				}
			};
		} else {
			let mut next = pos;
			let mut c;
			loop {
				if b[next] == b'\\' {
					next += 1;
					// Skip the whole escaped character.
					while next + 1 < max && (0x80..0xc0).contains(&b[next + 1]) {
						next += 1;
					}
				}
				next += 1;
				c = code_at(next);
				let stop = match c {
					None => true,
					Some(c) => {
						c <= 32
							|| c == b'\'' || c == b'"'
							|| c == b',' || c == b':'
							|| c == b'/' || c == b'('
							|| (c == b'*' && parent == (Parent::Func { calc: true }))
							|| (c == b')' && stack.len() > 1)
					}
				};
				if stop {
					break;
				}
			}
			let next = next.min(max);
			let token = &input[pos..next];
			if c == Some(b'(') {
				name = token.to_owned();
			} else {
				let tb = token.as_bytes();
				let node = if (tb[0] == b'u' || tb[0] == b'U')
					&& tb.get(1) == Some(&b'+')
					&& tb.len() > 2 && tb[2..]
					.iter()
					.all(|c| c.is_ascii_hexdigit() || *c == b'?' || *c == b'-')
				{
					ValueNode::UnicodeRange(token.to_owned())
				} else {
					ValueNode::Word(token.to_owned())
				};
				stack.last_mut().expect("the root frame").nodes.push(node);
			}
			pos = next;
		}
	}
	// Close what is still open.
	while stack.len() > 1 {
		let frame = stack.pop().expect("a function frame");
		let node = ValueNode::Function {
			name: frame.name,
			before: frame.before,
			after: String::new(),
			nodes: frame.nodes,
			unclosed: true,
		};
		stack.last_mut().expect("the parent frame").nodes.push(node);
	}
	stack.pop().map(|f| f.nodes).unwrap_or_default()
}

/// Prints nodes back as text.
///
/// # Example
///
/// ```
/// use kd_css::value::{parse, stringify};
///
/// assert_eq!(stringify(&parse("a , b")), "a , b");
/// ```
pub fn stringify(nodes: &[ValueNode]) -> String {
	let mut out = String::new();
	for n in nodes {
		push_node(&mut out, n);
	}
	out
}

/// Appends one node's text to `out`.
pub fn push_node(out: &mut String, node: &ValueNode) {
	match node {
		ValueNode::Word(s) | ValueNode::UnicodeRange(s) | ValueNode::Space(s) => out.push_str(s),
		ValueNode::Str {
			quote,
			value,
			unclosed,
		} => {
			out.push(*quote);
			out.push_str(value);
			if !unclosed {
				out.push(*quote);
			}
		}
		ValueNode::Comment { value, unclosed } => {
			out.push_str("/*");
			out.push_str(value);
			if !unclosed {
				out.push_str("*/");
			}
		}
		ValueNode::Div {
			before,
			value,
			after,
		} => {
			out.push_str(before);
			out.push(*value);
			out.push_str(after);
		}
		ValueNode::Function {
			name,
			before,
			after,
			nodes,
			unclosed,
		} => {
			out.push_str(name);
			out.push('(');
			out.push_str(before);
			for n in nodes {
				push_node(out, n);
			}
			out.push_str(after);
			if !unclosed {
				out.push(')');
			}
		}
	}
}

/// Splits a number from its unit the way postcss-value-parser's `unit` does:
/// `None` when the text does not start like a number.
///
/// # Example
///
/// ```
/// use kd_css::value::unit;
///
/// assert_eq!(unit("1.5em"), Some(("1.5", "em")));
/// assert_eq!(unit("-.5e3px"), Some(("-.5e3", "px")));
/// assert_eq!(unit("red"), None);
/// ```
pub fn unit(value: &str) -> Option<(&str, &str)> {
	let b = value.as_bytes();
	let at = |i: usize| b.get(i).copied();
	let digit = |c: Option<u8>| c.is_some_and(|c| c.is_ascii_digit());
	let starts = match at(0) {
		Some(b'+' | b'-') => digit(at(1)) || (at(1) == Some(b'.') && digit(at(2))),
		Some(b'.') => digit(at(1)),
		c => digit(c),
	};
	if !starts {
		return None;
	}
	let mut pos = 0;
	if matches!(at(0), Some(b'+' | b'-')) {
		pos += 1;
	}
	while digit(at(pos)) {
		pos += 1;
	}
	if at(pos) == Some(b'.') && digit(at(pos + 1)) {
		pos += 2;
		while digit(at(pos)) {
			pos += 1;
		}
	}
	if matches!(at(pos), Some(b'e' | b'E')) {
		let n = at(pos + 1);
		if digit(n) {
			pos += 2;
			while digit(at(pos)) {
				pos += 1;
			}
		} else if matches!(n, Some(b'+' | b'-')) && digit(at(pos + 2)) {
			pos += 3;
			while digit(at(pos)) {
				pos += 1;
			}
		}
	}
	Some((&value[..pos], &value[pos..]))
}

/// Splits the nodes at dividers, like cssnano's `getArguments`: dividers are
/// dropped, everything else is cloned into its group.
pub fn arguments(nodes: &[ValueNode]) -> Vec<Vec<ValueNode>> {
	let mut list: Vec<Vec<ValueNode>> = vec![Vec::new()];
	for n in nodes {
		if matches!(n, ValueNode::Div { .. }) {
			list.push(Vec::new());
		} else {
			list.last_mut().expect("a group").push(n.clone());
		}
	}
	list
}

/// Visits every node, parents before children. The callback returns whether
/// to descend into a function's arguments.
pub fn walk(nodes: &mut [ValueNode], f: &mut dyn FnMut(&mut ValueNode) -> bool) {
	for n in nodes.iter_mut() {
		let descend = f(n);
		if descend && let ValueNode::Function { nodes, .. } = n {
			walk(nodes, f);
		}
	}
}
