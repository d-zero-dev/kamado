//! The minifier proper: parse, rewrite every selector, prelude and value,
//! drop what cssnano's `discard-*` plugins drop, print.

use std::collections::{HashMap, HashSet};

use crate::merge::merge_rules;
use crate::numeric::DeclContext;
use crate::params::minify_params;
use crate::parse::{
	AtRule, Body, Declaration, Node, Rule, line_col, parse_declaration_list, parse_stylesheet,
};
use crate::selector::minify_selector_list;
use crate::strings::normalize_strings;
use crate::values::minify_value;

/// A style sheet the minifier cannot process.
///
/// CSS is parsed the way a browser recovers from errors, so an error is for
/// input that is not a style sheet in any useful sense: text larger than the
/// 4 GiB an offset can address, and blocks nested more than 256 deep (a run
/// of `{`), which no browser keeps either and which would overflow the stack
/// of every pass over the tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	pub message: String,
	/// 1-based line of the problem.
	pub line: usize,
	/// 1-based column of the problem.
	pub column: usize,
}

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}:{}: {}", self.line, self.column, self.message)
	}
}

impl std::error::Error for Error {}

fn check_size(source: &str) -> Result<(), Error> {
	if u32::try_from(source.len()).is_err() {
		return Err(Error {
			message: "the style sheet is larger than 4 GiB".to_owned(),
			line: 1,
			column: 1,
		});
	}
	Ok(())
}

#[derive(Clone, Copy, Default)]
struct Scope {
	/// The children are keyframe blocks.
	keyframe_list: bool,
	/// The children are the declarations of a keyframe block.
	keyframe_block: bool,
	/// The children are the descriptors of a `@property` with a percentage
	/// syntax.
	percent_syntax: bool,
}

struct Minifier {
	selectors: HashMap<(bool, String), String>,
}

fn unprefixed(name: &str) -> String {
	let lower = name.to_ascii_lowercase();
	if let Some(rest) = lower.strip_prefix('-')
		&& let Some((vendor, tail)) = rest.split_once('-')
		&& !vendor.is_empty()
		&& vendor
			.bytes()
			.all(|c| c.is_ascii_alphanumeric() || c == b'_')
	{
		return tail.to_owned();
	}
	lower
}

fn percent_syntax(nodes: &[Node]) -> bool {
	nodes.iter().any(|n| match n {
		Node::Declaration(d) => {
			d.property.eq_ignore_ascii_case("syntax")
				&& matches!(
					d.value.as_str(),
					"'<percentage>'"
						| "\"<percentage>\""
						| "'<length-percentage>'"
						| "\"<length-percentage>\""
				)
		}
		_ => false,
	})
}

impl Minifier {
	fn selector(&mut self, selector: &str, keyframe: bool) -> String {
		if let Some(s) = self.selectors.get(&(keyframe, selector.to_owned())) {
			return s.clone();
		}
		let mut s = minify_selector_list(selector, keyframe);
		if s.contains(['\'', '"']) {
			s = normalize_strings(&s);
		}
		self.selectors
			.insert((keyframe, selector.to_owned()), s.clone());
		s
	}

	fn declaration(&mut self, d: &mut Declaration, scope: Scope) {
		let ctx = DeclContext {
			in_keyframes: scope.keyframe_block,
			percent_syntax: scope.percent_syntax,
		};
		d.value = minify_value(&d.property, &d.value, &ctx);
	}

	fn rule(&mut self, r: &mut Rule, scope: Scope) {
		r.selector = self.selector(&r.selector, scope.keyframe_list);
		let child = Scope {
			keyframe_block: scope.keyframe_list,
			..Scope::default()
		};
		self.list(&mut r.nodes, child);
	}

	fn at_rule(&mut self, a: &mut AtRule, scope: Scope) {
		a.prelude = minify_params(&a.name, &a.prelude);
		if let Body::Nodes(nodes) = &mut a.body {
			let base = unprefixed(&a.name);
			let child = Scope {
				keyframe_list: base == "keyframes",
				keyframe_block: false,
				percent_syntax: base == "property" && percent_syntax(nodes),
			};
			let _ = scope;
			self.list(nodes, child);
		}
	}

	fn list(&mut self, nodes: &mut [Node], scope: Scope) {
		for n in nodes.iter_mut() {
			match n {
				Node::Declaration(d) => self.declaration(d, scope),
				Node::Rule(r) => self.rule(r, scope),
				Node::AtRule(a) => self.at_rule(a, scope),
				Node::Comment(_) => {}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// discard-overridden

fn is_overridable(name: &str) -> bool {
	matches!(unprefixed(name).as_str(), "keyframes" | "counter-style")
}

fn scope_key(chain: &[String], a: &AtRule) -> String {
	let mut key = chain.join("|");
	if !key.is_empty() {
		key.push('|');
	}
	key.push_str(&a.name.to_ascii_lowercase());
	key.push('|');
	key.push_str(&a.prelude);
	key
}

fn collect_overridable(
	nodes: &[Node],
	chain: &mut Vec<String>,
	last: &mut HashMap<String, usize>,
	counter: &mut usize,
) {
	for n in nodes {
		match n {
			Node::AtRule(a) => {
				if is_overridable(&a.name) {
					*counter += 1;
					last.insert(scope_key(chain, a), *counter);
				}
				if let Body::Nodes(children) = &a.body {
					chain.push(format!("{} {}", a.name.to_ascii_lowercase(), a.prelude));
					collect_overridable(children, chain, last, counter);
					chain.pop();
				}
			}
			Node::Rule(r) => collect_overridable(&r.nodes, chain, last, counter),
			_ => {}
		}
	}
}

fn remove_overridden(
	nodes: &mut Vec<Node>,
	chain: &mut Vec<String>,
	last: &HashMap<String, usize>,
	counter: &mut usize,
) {
	nodes.retain_mut(|n| match n {
		Node::AtRule(a) => {
			if is_overridable(&a.name) {
				*counter += 1;
				if last.get(&scope_key(chain, a)) != Some(counter) {
					return false;
				}
			}
			let key = format!("{} {}", a.name.to_ascii_lowercase(), a.prelude);
			if let Body::Nodes(children) = &mut a.body {
				chain.push(key);
				remove_overridden(children, chain, last, counter);
				chain.pop();
			}
			true
		}
		Node::Rule(r) => {
			remove_overridden(&mut r.nodes, chain, last, counter);
			true
		}
		_ => true,
	});
}

// ---------------------------------------------------------------------------
// discard-duplicates

fn declaration_key(d: &Declaration) -> String {
	let mut k = String::with_capacity(d.property.len() + d.value.len() + 3);
	k.push_str(&d.property);
	k.push(':');
	k.push_str(&d.value);
	if d.important {
		k.push('!');
	}
	k
}

fn only_comments(nodes: &[Node]) -> bool {
	!nodes.iter().any(|n| !matches!(n, Node::Comment(_)))
}

fn dedupe(nodes: &mut Vec<Node>) {
	for n in nodes.iter_mut() {
		match n {
			Node::Rule(r) => dedupe(&mut r.nodes),
			Node::AtRule(a) => {
				if let Body::Nodes(children) = &mut a.body {
					dedupe(children);
				}
			}
			_ => {}
		}
	}
	let len = nodes.len();
	let mut remove = vec![false; len];
	{
		let mut seen_declarations: HashSet<(&str, &str, bool)> = HashSet::new();
		let mut seen_at_rules: HashSet<String> = HashSet::new();
		for i in (0..len).rev() {
			match &nodes[i] {
				Node::Declaration(d) => {
					if !seen_declarations.insert((
						d.property.as_str(),
						d.value.as_str(),
						d.important,
					)) {
						remove[i] = true;
					}
				}
				Node::AtRule(a) if a.name != "layer" => {
					let mut key = String::new();
					crate::print::print_at_rule(a, &mut key, false);
					if !seen_at_rules.insert(key) {
						remove[i] = true;
					}
				}
				_ => {}
			}
		}
	}
	// Rules with the same selector: what a later rule declares again is
	// dropped from the earlier ones. From the last rule to the first, the
	// declarations of the rules after it are the set to drop.
	let mut groups: HashMap<&str, Vec<usize>> = HashMap::new();
	for (i, n) in nodes.iter().enumerate() {
		if let Node::Rule(r) = n {
			groups.entry(r.selector.as_str()).or_default().push(i);
		}
	}
	let work: Vec<Vec<usize>> = groups.into_values().filter(|g| g.len() > 1).collect();
	let mut rule_removed = vec![false; len];
	for group in &work {
		let mut later: HashSet<String> = HashSet::new();
		for &idx in group.iter().rev() {
			let Node::Rule(r) = &mut nodes[idx] else {
				continue;
			};
			let own: Vec<String> = r
				.nodes
				.iter()
				.filter_map(|n| match n {
					Node::Declaration(d) => Some(declaration_key(d)),
					_ => None,
				})
				.collect();
			if !later.is_empty() {
				r.nodes.retain(|n| match n {
					Node::Declaration(d) => !later.contains(&declaration_key(d)),
					_ => true,
				});
				if only_comments(&r.nodes) {
					rule_removed[idx] = true;
				}
			}
			later.extend(own);
		}
	}
	let mut i = 0;
	nodes.retain(|_| {
		let keep = !remove[i] && !rule_removed[i];
		i += 1;
		keep
	});
}

// ---------------------------------------------------------------------------
// discard-empty

fn layer_path(name: &str) -> Vec<String> {
	let mut path = Vec::new();
	let mut component = String::new();
	let mut escaped = false;
	for c in name.chars() {
		if c == '\\' && !escaped {
			escaped = true;
			component.push(c);
		} else if c == '.' && !escaped {
			path.push(component.trim().to_owned());
			component.clear();
		} else {
			component.push(c);
			escaped = false;
		}
	}
	path.push(component.trim().to_owned());
	path
}

fn discard_empty(nodes: &mut Vec<Node>, path: &[String], non_empty: &mut HashSet<String>) {
	nodes.retain_mut(|n| match n {
		Node::Declaration(d) => !(d.value.is_empty() && !d.property.starts_with("--")),
		Node::Comment(_) => true,
		Node::Rule(r) => {
			discard_empty(&mut r.nodes, path, non_empty);
			!(r.selector.is_empty() || r.nodes.is_empty())
		}
		Node::AtRule(a) => {
			let is_layer = a.name == "layer";
			let layer_name = if is_layer {
				a.prelude.trim().to_owned()
			} else {
				String::new()
			};
			let current: Vec<String> = if layer_name.is_empty() {
				path.to_vec()
			} else {
				let mut p = path.to_vec();
				p.extend(layer_path(&layer_name));
				p
			};
			let sub_len = match &mut a.body {
				Body::Nodes(children) => {
					discard_empty(children, &current, non_empty);
					Some(children.len())
				}
				Body::Raw(s) => Some(usize::from(!s.is_empty())),
				Body::None => None,
			};
			let is_empty_layer = is_layer && !layer_name.is_empty() && sub_len == Some(0);
			let key = current.join("\0");
			let discard = (sub_len == Some(0) && !is_layer)
				|| (is_empty_layer && non_empty.contains(&key))
				|| (sub_len.is_none() && a.prelude.is_empty())
				|| (a.prelude.is_empty() && sub_len == Some(0));
			if !discard && is_layer && sub_len.is_some_and(|l| l > 0) {
				non_empty.insert(key);
			}
			!discard
		}
	});
}

// ---------------------------------------------------------------------------
// charset

fn normalize_charset(nodes: &mut Vec<Node>) {
	let mut first: Option<Node> = None;
	nodes.retain(|n| match n {
		Node::AtRule(a) if a.name == "charset" => {
			if first.is_none() {
				first = Some(n.clone());
			}
			false
		}
		_ => true,
	});
	let Some(charset) = first else {
		return;
	};
	let mut text = String::new();
	let mut non_ascii = false;
	for n in nodes.iter() {
		text.clear();
		crate::print::print_node(n, &mut text, false);
		if !text.is_ascii() {
			non_ascii = true;
			break;
		}
	}
	if non_ascii {
		nodes.insert(0, charset);
	}
}

/// Minifies a style sheet: what a `.css` file or a `<style>` element holds.
///
/// Comments are removed except `/*! ... */`; white space, the last `;` of a
/// block, empty rules and duplicated rules and declarations go; selectors,
/// colours, numbers, strings, `url()`s, fonts, positions and the like are
/// rewritten to their shortest equal spelling (see the crate documentation).
/// Custom properties keep their values as written.
///
/// # Example
///
/// ```
/// let css = "a { color : #FF0000 ; margin : 0px 0px }\n/* gone */\n/*! kept */\n";
/// assert_eq!(kd_css::minify(css).unwrap(), "a{color:red;margin:0}/*! kept */");
/// ```
pub fn minify_stylesheet(source: &str) -> Result<String, Error> {
	check_size(source)?;
	let sheet = parse_stylesheet(source);
	if let Some(offset) = sheet.too_deep {
		let (line, column) = line_col(source, offset);
		return Err(Error {
			message: format!(
				"blocks are nested more than {} deep",
				crate::parse::MAX_NESTING
			),
			line,
			column,
		});
	}
	let mut nodes = sheet.nodes;
	let mut m = Minifier {
		selectors: HashMap::new(),
	};
	m.list(&mut nodes, Scope::default());
	let mut last = HashMap::new();
	let mut counter = 0;
	collect_overridable(&nodes, &mut Vec::new(), &mut last, &mut counter);
	let mut counter = 0;
	remove_overridden(&mut nodes, &mut Vec::new(), &last, &mut counter);
	normalize_charset(&mut nodes);
	dedupe(&mut nodes);
	discard_empty(&mut nodes, &[], &mut HashSet::new());
	merge_rules(&mut nodes);
	// Merged rules may repeat a declaration.
	dedupe(&mut nodes);
	let mut out = String::with_capacity(source.len() / 2);
	crate::print::print_nodes(&nodes, &mut out);
	Ok(out)
}

/// Minifies the declarations of a `style` attribute.
///
/// # Example
///
/// ```
/// assert_eq!(kd_css::minify_declarations("color: red;  margin : 0px ;").unwrap(), "color:red;margin:0");
/// ```
pub fn minify_declaration_list(source: &str) -> Result<String, Error> {
	check_size(source)?;
	let mut decls = parse_declaration_list(source);
	let mut m = Minifier {
		selectors: HashMap::new(),
	};
	let mut nodes: Vec<Node> = decls.drain(..).map(Node::Declaration).collect();
	m.list(&mut nodes, Scope::default());
	dedupe(&mut nodes);
	discard_empty(&mut nodes, &[], &mut HashSet::new());
	let mut out = String::with_capacity(source.len());
	crate::print::print_nodes(&nodes, &mut out);
	Ok(out)
}
