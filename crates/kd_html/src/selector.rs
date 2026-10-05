//! CSS selectors over the arena DOM, for the declarative rules.
//!
//! Supported: type (`div`, `*`), `#id`, `.class`, attribute selectors
//! (`[a]`, `[a=v]`, `[a~=v]`, `[a|=v]`, `[a^=v]`, `[a$=v]`, `[a*=v]`, each
//! optionally with an `i` flag), the combinators ` `, `>`, `+`, `~`, selector
//! lists with `,`, and the pseudo-classes `:not(<list>)`, `:is(<list>)`,
//! `:first-child`, `:last-child`, `:only-child`, `:first-of-type`,
//! `:last-of-type`, `:nth-child(an+b)`, `:nth-of-type(an+b)`, `:empty`,
//! `:root`. Anything else is a parse error: a rule that silently matches
//! nothing is worse than a build that stops.
//!
//! Names (tags, attribute names) compare ASCII-case-insensitively as in an
//! HTML document; attribute values compare exactly unless the `i` flag is
//! given. Matching walks right to left from the candidate, so a compound
//! selector is tested without materializing intermediate sets.

use crate::dom::{Document, NodeId, NodeKind, ROOT};

/// A selector that failed to parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelectorError {
	pub selector: String,
	pub message: String,
}

impl std::fmt::Display for SelectorError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "invalid selector `{}`: {}", self.selector, self.message)
	}
}

impl std::error::Error for SelectorError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Op {
	Exists,
	Equals,
	Includes,
	Dash,
	Prefix,
	Suffix,
	Substring,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Simple {
	Type(String),
	Universal,
	Id(String),
	Class(String),
	Attr {
		name: String,
		op: Op,
		value: String,
		insensitive: bool,
	},
	Not(Vec<Complex>),
	Is(Vec<Complex>),
	Nth {
		a: i64,
		b: i64,
		of_type: bool,
		from_end: bool,
	},
	Empty,
	Root,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Combinator {
	Descendant,
	Child,
	Adjacent,
	Sibling,
}

/// `compounds[0]` is the leftmost; `combinators[i]` joins `compounds[i]` to
/// `compounds[i + 1]`.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Complex {
	compounds: Vec<Vec<Simple>>,
	combinators: Vec<Combinator>,
}

/// A parsed selector list.
///
/// # Example
///
/// ```
/// use kd_html::{parser::parse, selector::Selector};
/// let doc = parse("<ul><li class=a>1</li><li>2</li></ul>");
/// let sel = Selector::parse("ul > li.a").unwrap();
/// assert_eq!(sel.select_all(&doc).len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selector {
	list: Vec<Complex>,
}

struct Reader<'a> {
	src: &'a str,
	bytes: &'a [u8],
	pos: usize,
}

fn is_ident_start(b: u8) -> bool {
	b.is_ascii_alphabetic() || b == b'_' || b == b'-' || b >= 0x80
}

fn is_ident(b: u8) -> bool {
	is_ident_start(b) || b.is_ascii_digit()
}

impl<'a> Reader<'a> {
	fn err<T>(&self, message: &str) -> Result<T, SelectorError> {
		Err(SelectorError {
			selector: self.src.to_owned(),
			message: message.to_owned(),
		})
	}

	fn peek(&self) -> Option<u8> {
		self.bytes.get(self.pos).copied()
	}

	fn skip_ws(&mut self) -> bool {
		let start = self.pos;
		while self.peek().is_some_and(|b| b.is_ascii_whitespace()) {
			self.pos += 1;
		}
		self.pos > start
	}

	fn ident(&mut self) -> Result<String, SelectorError> {
		let start = self.pos;
		let mut out = String::new();
		while let Some(b) = self.peek() {
			if b == b'\\' {
				self.pos += 1;
				let Some(next) = self.src[self.pos..].chars().next() else {
					return self.err("a backslash at the end");
				};
				out.push(next);
				self.pos += next.len_utf8();
			} else if is_ident(b) {
				let ch = self.src[self.pos..].chars().next().unwrap();
				out.push(ch);
				self.pos += ch.len_utf8();
			} else {
				break;
			}
		}
		if self.pos == start {
			return self.err("a name was expected");
		}
		Ok(out)
	}

	fn string_or_ident(&mut self) -> Result<String, SelectorError> {
		match self.peek() {
			Some(q @ (b'"' | b'\'')) => {
				self.pos += 1;
				let mut out = String::new();
				loop {
					let Some(ch) = self.src[self.pos..].chars().next() else {
						return self.err("an unterminated string");
					};
					self.pos += ch.len_utf8();
					if ch as u32 == u32::from(q) {
						return Ok(out);
					}
					if ch == '\\' {
						let Some(next) = self.src[self.pos..].chars().next() else {
							return self.err("an unterminated string");
						};
						self.pos += next.len_utf8();
						out.push(next);
					} else {
						out.push(ch);
					}
				}
			}
			_ => self.ident(),
		}
	}

	fn list(&mut self, nested: bool) -> Result<Vec<Complex>, SelectorError> {
		let mut list = vec![self.complex()?];
		loop {
			self.skip_ws();
			match self.peek() {
				Some(b',') => {
					self.pos += 1;
					list.push(self.complex()?);
				}
				Some(b')') if nested => return Ok(list),
				None if !nested => return Ok(list),
				None => return self.err("a `)` is missing"),
				Some(_) => return self.err("an unexpected character"),
			}
		}
	}

	fn complex(&mut self) -> Result<Complex, SelectorError> {
		self.skip_ws();
		let mut compounds = vec![self.compound()?];
		let mut combinators = Vec::new();
		loop {
			let had_ws = self.skip_ws();
			let combinator = match self.peek() {
				Some(b'>') => Combinator::Child,
				Some(b'+') => Combinator::Adjacent,
				Some(b'~') => Combinator::Sibling,
				Some(b',' | b')') | None => break,
				Some(_) if had_ws => {
					combinators.push(Combinator::Descendant);
					compounds.push(self.compound()?);
					continue;
				}
				Some(_) => return self.err("an unexpected character"),
			};
			self.pos += 1;
			self.skip_ws();
			combinators.push(combinator);
			compounds.push(self.compound()?);
		}
		Ok(Complex {
			compounds,
			combinators,
		})
	}

	fn compound(&mut self) -> Result<Vec<Simple>, SelectorError> {
		let mut simples = Vec::new();
		match self.peek() {
			Some(b'*') => {
				self.pos += 1;
				simples.push(Simple::Universal);
			}
			Some(b) if is_ident_start(b) || b == b'\\' => {
				simples.push(Simple::Type(self.ident()?.to_ascii_lowercase()));
			}
			_ => {}
		}
		loop {
			match self.peek() {
				Some(b'#') => {
					self.pos += 1;
					simples.push(Simple::Id(self.ident()?));
				}
				Some(b'.') => {
					self.pos += 1;
					simples.push(Simple::Class(self.ident()?));
				}
				Some(b'[') => {
					self.pos += 1;
					simples.push(self.attribute()?);
				}
				Some(b':') => {
					self.pos += 1;
					simples.push(self.pseudo()?);
				}
				_ => break,
			}
		}
		if simples.is_empty() {
			return self.err("a selector was expected");
		}
		Ok(simples)
	}

	fn attribute(&mut self) -> Result<Simple, SelectorError> {
		self.skip_ws();
		let name = self.ident()?.to_ascii_lowercase();
		self.skip_ws();
		let op = match self.peek() {
			Some(b']') => {
				self.pos += 1;
				return Ok(Simple::Attr {
					name,
					op: Op::Exists,
					value: String::new(),
					insensitive: false,
				});
			}
			Some(b'=') => {
				self.pos += 1;
				Op::Equals
			}
			Some(c @ (b'~' | b'|' | b'^' | b'$' | b'*')) => {
				self.pos += 1;
				if self.peek() != Some(b'=') {
					return self.err("`=` was expected");
				}
				self.pos += 1;
				match c {
					b'~' => Op::Includes,
					b'|' => Op::Dash,
					b'^' => Op::Prefix,
					b'$' => Op::Suffix,
					_ => Op::Substring,
				}
			}
			_ => return self.err("an attribute operator was expected"),
		};
		self.skip_ws();
		let value = self.string_or_ident()?;
		self.skip_ws();
		let mut insensitive = false;
		if matches!(self.peek(), Some(b'i' | b'I')) {
			self.pos += 1;
			insensitive = true;
			self.skip_ws();
		}
		if self.peek() != Some(b']') {
			return self.err("a `]` is missing");
		}
		self.pos += 1;
		Ok(Simple::Attr {
			name,
			op,
			value,
			insensitive,
		})
	}

	fn pseudo(&mut self) -> Result<Simple, SelectorError> {
		let name = self.ident()?.to_ascii_lowercase();
		match name.as_str() {
			"first-child" => Ok(Simple::Nth {
				a: 0,
				b: 1,
				of_type: false,
				from_end: false,
			}),
			"last-child" => Ok(Simple::Nth {
				a: 0,
				b: 1,
				of_type: false,
				from_end: true,
			}),
			"first-of-type" => Ok(Simple::Nth {
				a: 0,
				b: 1,
				of_type: true,
				from_end: false,
			}),
			"last-of-type" => Ok(Simple::Nth {
				a: 0,
				b: 1,
				of_type: true,
				from_end: true,
			}),
			"only-child" => Ok(Self::only_child()),
			"empty" => Ok(Simple::Empty),
			"root" => Ok(Simple::Root),
			"not" | "is" => {
				self.expect_open()?;
				let list = self.list(true)?;
				self.pos += 1;
				Ok(if name == "not" {
					Simple::Not(list)
				} else {
					Simple::Is(list)
				})
			}
			"nth-child" | "nth-last-child" | "nth-of-type" | "nth-last-of-type" => {
				self.expect_open()?;
				let (a, b) = self.nth()?;
				self.skip_ws();
				if self.peek() != Some(b')') {
					return self.err("a `)` is missing");
				}
				self.pos += 1;
				Ok(Simple::Nth {
					a,
					b,
					of_type: name.ends_with("of-type"),
					from_end: name.contains("last"),
				})
			}
			_ => self.err(&format!("the pseudo-class `:{name}` is not supported")),
		}
	}

	/// `:only-child` is a first and a last child at once.
	fn only_child() -> Simple {
		let first = Complex {
			compounds: vec![vec![Simple::Nth {
				a: 0,
				b: 1,
				of_type: false,
				from_end: false,
			}]],
			combinators: vec![],
		};
		let last = Complex {
			compounds: vec![vec![Simple::Nth {
				a: 0,
				b: 1,
				of_type: false,
				from_end: true,
			}]],
			combinators: vec![],
		};
		// first-child AND last-child == NOT(NOT first OR NOT last)
		let not_first = Complex {
			compounds: vec![vec![Simple::Not(vec![first])]],
			combinators: vec![],
		};
		let not_last = Complex {
			compounds: vec![vec![Simple::Not(vec![last])]],
			combinators: vec![],
		};
		Simple::Not(vec![not_first, not_last])
	}

	fn expect_open(&mut self) -> Result<(), SelectorError> {
		if self.peek() != Some(b'(') {
			return self.err("a `(` was expected");
		}
		self.pos += 1;
		self.skip_ws();
		Ok(())
	}

	/// `odd`, `even`, `<int>`, `an+b`.
	fn nth(&mut self) -> Result<(i64, i64), SelectorError> {
		self.skip_ws();
		let start = self.pos;
		while self.peek().is_some_and(|b| b != b')') {
			self.pos += 1;
		}
		let text: String = self.src[start..self.pos]
			.chars()
			.filter(|c| !c.is_whitespace())
			.collect::<String>()
			.to_ascii_lowercase();
		match text.as_str() {
			"odd" => return Ok((2, 1)),
			"even" => return Ok((2, 0)),
			_ => {}
		}
		let parsed = if let Some(n_at) = text.find('n') {
			let a = match &text[..n_at] {
				"" | "+" => Some(1),
				"-" => Some(-1),
				s => s.parse::<i64>().ok(),
			};
			let rest = &text[n_at + 1..];
			let b = if rest.is_empty() {
				Some(0)
			} else if rest.starts_with('+') || rest.starts_with('-') {
				rest.parse::<i64>().ok()
			} else {
				None
			};
			a.zip(b)
		} else {
			text.parse::<i64>().ok().map(|b| (0, b))
		};
		match parsed {
			Some(ab) => Ok(ab),
			None => self.err("an invalid `an+b` expression"),
		}
	}
}

impl Selector {
	/// Parses a selector list.
	///
	/// # Errors
	///
	/// A [`SelectorError`] for syntax this engine does not support.
	pub fn parse(source: &str) -> Result<Selector, SelectorError> {
		let mut reader = Reader {
			src: source,
			bytes: source.as_bytes(),
			pos: 0,
		};
		let list = reader.list(false)?;
		Ok(Selector { list })
	}

	/// Whether `node` (an element) matches any selector of the list.
	#[must_use]
	pub fn matches(&self, doc: &Document, node: NodeId) -> bool {
		doc.element(node).is_some() && self.list.iter().any(|c| matches_complex(doc, node, c))
	}

	/// All matching elements in document order, under the root.
	#[must_use]
	pub fn select_all(&self, doc: &Document) -> Vec<NodeId> {
		self.select_in(doc, ROOT)
	}

	/// All matching elements strictly below `scope`, in document order.
	#[must_use]
	pub fn select_in(&self, doc: &Document, scope: NodeId) -> Vec<NodeId> {
		let mut out = Vec::new();
		let mut stack: Vec<NodeId> = Vec::new();
		let mut cursor = doc.last_child(scope);
		while let Some(c) = cursor {
			stack.push(c);
			cursor = doc.prev_sibling(c);
		}
		while let Some(node) = stack.pop() {
			if self.matches(doc, node) {
				out.push(node);
			}
			let mut child = doc.last_child(node);
			while let Some(c) = child {
				stack.push(c);
				child = doc.prev_sibling(c);
			}
		}
		out
	}

	/// The first match in document order.
	#[must_use]
	pub fn select_first(&self, doc: &Document) -> Option<NodeId> {
		self.select_all(doc).into_iter().next()
	}
}

fn matches_complex(doc: &Document, node: NodeId, complex: &Complex) -> bool {
	matches_from(doc, node, complex, complex.compounds.len() - 1)
}

fn matches_from(doc: &Document, node: NodeId, complex: &Complex, index: usize) -> bool {
	if !matches_compound(doc, node, &complex.compounds[index]) {
		return false;
	}
	if index == 0 {
		return true;
	}
	match complex.combinators[index - 1] {
		Combinator::Child => doc
			.parent(node)
			.is_some_and(|p| doc.element(p).is_some() && matches_from(doc, p, complex, index - 1)),
		Combinator::Descendant => {
			let mut up = doc.parent(node);
			while let Some(p) = up {
				if doc.element(p).is_some() && matches_from(doc, p, complex, index - 1) {
					return true;
				}
				up = doc.parent(p);
			}
			false
		}
		Combinator::Adjacent => {
			previous_element(doc, node).is_some_and(|p| matches_from(doc, p, complex, index - 1))
		}
		Combinator::Sibling => {
			let mut prev = previous_element(doc, node);
			while let Some(p) = prev {
				if matches_from(doc, p, complex, index - 1) {
					return true;
				}
				prev = previous_element(doc, p);
			}
			false
		}
	}
}

fn previous_element(doc: &Document, node: NodeId) -> Option<NodeId> {
	let mut prev = doc.prev_sibling(node);
	while let Some(p) = prev {
		if doc.element(p).is_some() {
			return Some(p);
		}
		prev = doc.prev_sibling(p);
	}
	None
}

fn next_element(doc: &Document, node: NodeId) -> Option<NodeId> {
	let mut next = doc.next_sibling(node);
	while let Some(n) = next {
		if doc.element(n).is_some() {
			return Some(n);
		}
		next = doc.next_sibling(n);
	}
	None
}

fn matches_compound(doc: &Document, node: NodeId, compound: &[Simple]) -> bool {
	compound.iter().all(|s| matches_simple(doc, node, s))
}

fn attribute_value<'a>(doc: &'a Document, node: NodeId, name: &str) -> Option<&'a str> {
	doc.element(node)?
		.attrs
		.iter()
		.find(|a| a.name.eq_ignore_ascii_case(name))
		.map(|a| a.value.as_str())
}

fn matches_simple(doc: &Document, node: NodeId, simple: &Simple) -> bool {
	let Some(element) = doc.element(node) else {
		return false;
	};
	match simple {
		Simple::Universal => true,
		Simple::Type(name) => element.name.eq_ignore_ascii_case(name),
		Simple::Id(id) => attribute_value(doc, node, "id") == Some(id.as_str()),
		Simple::Class(class) => attribute_value(doc, node, "class")
			.is_some_and(|v| v.split_ascii_whitespace().any(|c| c == class)),
		Simple::Attr {
			name,
			op,
			value,
			insensitive,
		} => {
			let Some(actual) = attribute_value(doc, node, name) else {
				return false;
			};
			attribute_matches(actual, *op, value, *insensitive)
		}
		Simple::Not(list) => !list.iter().any(|c| matches_complex(doc, node, c)),
		Simple::Is(list) => list.iter().any(|c| matches_complex(doc, node, c)),
		Simple::Empty => doc.children(node).all(|c| match doc.kind(c) {
			NodeKind::Element(_) => false,
			NodeKind::Text(t) => t.is_empty(),
			_ => true,
		}),
		Simple::Root => {
			doc.parent(node) == Some(ROOT) && {
				// the first element child of the document
				doc.first_element_child(ROOT) == Some(node)
			}
		}
		Simple::Nth {
			a,
			b,
			of_type,
			from_end,
		} => {
			let mut position = 1_i64;
			let mut cursor = if *from_end {
				next_element(doc, node)
			} else {
				previous_element(doc, node)
			};
			while let Some(sibling) = cursor {
				if !*of_type || doc.element(sibling).is_some_and(|e| e.name == element.name) {
					position += 1;
				}
				cursor = if *from_end {
					next_element(doc, sibling)
				} else {
					previous_element(doc, sibling)
				};
			}
			nth_matches(*a, *b, position)
		}
	}
}

fn nth_matches(a: i64, b: i64, position: i64) -> bool {
	if a == 0 {
		return position == b;
	}
	let diff = position - b;
	diff % a == 0 && diff / a >= 0
}

fn attribute_matches(actual: &str, op: Op, expected: &str, insensitive: bool) -> bool {
	let (actual, expected) = if insensitive {
		(actual.to_lowercase(), expected.to_lowercase())
	} else {
		(actual.to_owned(), expected.to_owned())
	};
	match op {
		Op::Exists => true,
		Op::Equals => actual == expected,
		Op::Includes => {
			!expected.is_empty() && actual.split_ascii_whitespace().any(|w| w == expected)
		}
		Op::Dash => {
			actual == expected
				|| actual
					.strip_prefix(&expected)
					.is_some_and(|r| r.starts_with('-'))
		}
		Op::Prefix => !expected.is_empty() && actual.starts_with(&expected),
		Op::Suffix => !expected.is_empty() && actual.ends_with(&expected),
		Op::Substring => !expected.is_empty() && actual.contains(&expected),
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::parser::parse;

	fn texts(html: &str, selector: &str) -> Vec<String> {
		let doc = parse(html);
		Selector::parse(selector)
			.unwrap()
			.select_all(&doc)
			.into_iter()
			.map(|n| doc.text_content(n))
			.collect()
	}

	#[test]
	fn type_id_class_and_universal() {
		let html = "<div id=a class='x y'>1</div><p class=x>2</p><span>3</span>";
		assert_eq!(texts(html, "p"), ["2"]);
		assert_eq!(texts(html, "#a"), ["1"]);
		assert_eq!(texts(html, ".x"), ["1", "2"]);
		assert_eq!(texts(html, "div.x.y"), ["1"]);
		assert_eq!(texts(html, "*"), ["1", "2", "3"]);
		assert_eq!(texts(html, "DIV"), ["1"]);
		assert_eq!(texts(html, ".missing"), Vec::<String>::new());
	}

	#[test]
	fn attribute_operators() {
		let html = "<a href='/x/y.pdf' lang='en-US' rel='a b' data-k='Foo'>t</a><a href='/z'>u</a>";
		assert_eq!(texts(html, "[href]"), ["t", "u"]);
		assert_eq!(texts(html, "[href='/z']"), ["u"]);
		assert_eq!(texts(html, "[href$='.pdf']"), ["t"]);
		assert_eq!(texts(html, "[href^='/x']"), ["t"]);
		assert_eq!(texts(html, "[href*='y.']"), ["t"]);
		assert_eq!(texts(html, "[rel~=b]"), ["t"]);
		assert_eq!(texts(html, "[lang|=en]"), ["t"]);
		assert_eq!(texts(html, "[data-k=foo]"), Vec::<String>::new());
		assert_eq!(texts(html, "[data-k=foo i]"), ["t"]);
		assert_eq!(texts(html, "[href$='']"), Vec::<String>::new());
	}

	#[test]
	fn combinators() {
		let html =
			"<div><p>a</p><section><p>b</p></section></div><p>c</p><h1>h</h1><p>d</p><p>e</p>";
		assert_eq!(texts(html, "div p"), ["a", "b"]);
		assert_eq!(texts(html, "div > p"), ["a"]);
		assert_eq!(texts(html, "h1 + p"), ["d"]);
		assert_eq!(texts(html, "h1 ~ p"), ["d", "e"]);
		assert_eq!(texts(html, "div>p"), ["a"]);
		assert_eq!(texts(html, "section p, h1"), ["b", "h"]);
	}

	#[test]
	fn pseudo_classes() {
		let html = "<ul><li>1</li><li>2</li><li>3</li><li>4</li></ul><p></p><p>x</p>";
		assert_eq!(texts(html, "li:first-child"), ["1"]);
		assert_eq!(texts(html, "li:last-child"), ["4"]);
		assert_eq!(texts(html, "li:nth-child(2)"), ["2"]);
		assert_eq!(texts(html, "li:nth-child(odd)"), ["1", "3"]);
		assert_eq!(texts(html, "li:nth-child(even)"), ["2", "4"]);
		assert_eq!(texts(html, "li:nth-child(2n+1)"), ["1", "3"]);
		assert_eq!(texts(html, "li:nth-child(-n+2)"), ["1", "2"]);
		assert_eq!(texts(html, "li:nth-last-child(1)"), ["4"]);
		assert_eq!(texts(html, "li:not(:first-child)"), ["2", "3", "4"]);
		assert_eq!(texts(html, "p:empty").len(), 1);
		assert_eq!(texts(html, ":is(ul, p) li").len(), 4);
		assert_eq!(texts("<p>a</p>", "p:only-child"), ["a"]);
		assert_eq!(
			texts("<p>a</p><p>b</p>", "p:only-child"),
			Vec::<String>::new()
		);
		assert_eq!(texts("<i>1</i><b>2</b><i>3</i>", "i:last-of-type"), ["3"]);
		assert_eq!(texts("<i>1</i><b>2</b><i>3</i>", "i:first-of-type"), ["1"]);
		assert_eq!(texts("<html><body>x</body></html>", ":root").len(), 1);
	}

	#[test]
	fn matches_tests_a_single_node() {
		let doc = parse("<div class=a><p>x</p></div>");
		let div = doc.first_child(ROOT).unwrap();
		let sel = Selector::parse(".a").unwrap();
		assert!(sel.matches(&doc, div));
		let text = doc.first_child(doc.first_child(div).unwrap()).unwrap();
		assert!(!sel.matches(&doc, text), "a text node never matches");
	}

	#[test]
	fn select_in_stays_below_the_scope() {
		let doc = parse("<div id=a><p>1</p></div><div id=b><p>2</p></div>");
		let b = Selector::parse("#b").unwrap().select_first(&doc).unwrap();
		let hits = Selector::parse("p").unwrap().select_in(&doc, b);
		assert_eq!(hits.len(), 1);
		assert_eq!(doc.text_content(hits[0]), "2");
	}

	#[test]
	fn invalid_selectors_are_errors_not_silent_misses() {
		for bad in [
			"",
			"div >",
			"[a",
			"a[b==c]",
			":hover",
			"div::before",
			"p:nth-child(x)",
			":not(a",
			"a,",
			", a",
			"a b >> c",
		] {
			assert!(Selector::parse(bad).is_err(), "`{bad}` should not parse");
		}
	}

	#[test]
	fn escapes_and_quotes_in_identifiers_and_values() {
		let html = "<div class='a:b'>1</div><a title='x]y'>2</a>";
		assert_eq!(texts(html, ".a\\:b"), ["1"]);
		assert_eq!(texts(html, "[title=\"x]y\"]"), ["2"]);
		assert_eq!(texts(html, "[title='x]y']"), ["2"]);
	}

	#[test]
	fn document_order_is_kept_for_nested_matches() {
		let html = "<div>a<div>b<div>c</div></div></div>";
		assert_eq!(texts(html, "div"), ["abc", "bc", "c"]);
	}
}
