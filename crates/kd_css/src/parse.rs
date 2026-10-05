//! A forgiving parser from tokens to a small tree.
//!
//! It follows CSS Syntax Level 3 and CSS Nesting where a browser's recovery
//! decides what a stylesheet means:
//! - a qualified rule's prelude runs to the next `{` even across `;` (so
//!   `a{} ; b{}` makes `; b` a selector a browser rejects), and a qualified
//!   rule cut short by the end of the input is dropped;
//! - an at-rule is kept when the input ends inside its prelude;
//! - an unterminated string, comment or block is closed at the end of input;
//! - inside a style rule, an item that reaches `{` before `;` is a nested
//!   rule, anything else is a declaration, and a declaration without a colon
//!   is dropped (browsers ignore it too).
//!
//! What the parser does not know it keeps as text: the block of an at-rule it
//! has no grammar for is held verbatim ([`Body::Raw`]), and custom property
//! values keep every byte except the surrounding white space.
//!
//! Every node remembers the byte offset of its first token, so a source map
//! step can turn it into a line and column with [`line_col`].

use crate::token::{Kind, Token, tokenize};

/// A parsed style sheet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stylesheet {
	pub nodes: Vec<Node>,
}

/// A node of a style sheet or of a block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Node {
	Rule(Rule),
	AtRule(AtRule),
	Declaration(Declaration),
	/// A `/*! ... */` comment (all others are dropped by the parser).
	Comment(Comment),
}

/// A qualified rule: `selector { ... }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
	/// The selector text with comments removed, otherwise as written.
	pub selector: String,
	/// Declarations, nested rules and nested at-rules.
	pub nodes: Vec<Node>,
	/// Byte offset of the rule in the source.
	pub offset: usize,
}

/// The block of an at-rule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
	/// The at-rule ends with `;`.
	None,
	/// A block the parser has a grammar for.
	Nodes(Vec<Node>),
	/// A block of an unknown at-rule, copied as written (trimmed).
	Raw(String),
}

/// An at-rule: `@name prelude;` or `@name prelude { ... }`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtRule {
	/// The name without the `@`, as written.
	pub name: String,
	/// The prelude with comments replaced by a space, trimmed.
	pub prelude: String,
	/// Whether white space (or a comment) separated the name from the
	/// prelude in the source: `@media (x)` against `@media(x)`.
	pub space: bool,
	pub body: Body,
	/// Byte offset of the rule in the source.
	pub offset: usize,
}

/// A declaration: `property: value !important`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Declaration {
	/// The property name, as written.
	pub property: String,
	/// The value, trimmed, without `!important`. Comments are replaced by a
	/// space, except in custom properties, which keep them.
	pub value: String,
	pub important: bool,
	/// Byte offset of the declaration in the source.
	pub offset: usize,
}

/// A kept comment (`/*! ... */`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
	/// The comment with its delimiters.
	pub text: String,
	/// Byte offset of the comment in the source.
	pub offset: usize,
}

/// Converts a byte offset to a 1-based line and column (in characters).
///
/// # Example
///
/// ```
/// let src = "a{}\nb{}";
/// assert_eq!(kd_css::parse::line_col(src, 4), (2, 1));
/// ```
pub fn line_col(source: &str, offset: usize) -> (usize, usize) {
	let offset = offset.min(source.len());
	let mut line = 1;
	let mut line_start = 0;
	let b = source.as_bytes();
	let mut i = 0;
	while i < offset {
		match b[i] {
			b'\n' | 0x0c => {
				line += 1;
				line_start = i + 1;
			}
			b'\r' => {
				if b.get(i + 1) == Some(&b'\n') {
					i += 1;
				}
				line += 1;
				line_start = i + 1;
			}
			_ => {}
		}
		i += 1;
	}
	let mut end = offset;
	while !source.is_char_boundary(end) {
		end -= 1;
	}
	let start = line_start.min(end);
	(line, source[start..end].chars().count() + 1)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ctx {
	/// A list of rules.
	Rules,
	/// Declarations mixed with rules (a style rule's block).
	Block,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Text {
	Selector,
	Plain,
}

struct Parser<'a> {
	src: &'a str,
	toks: Vec<Token>,
	pos: usize,
}

fn is_css_ws(c: char) -> bool {
	matches!(c, ' ' | '\t' | '\n' | '\r' | '\x0c')
}

/// Whether a token ends with `close`, not escaped by a backslash, and is at
/// least `min_len` bytes long (a string is closed by a second quote, not by
/// its first).
fn ends_with_unescaped(s: &[u8], close: u8, min_len: usize) -> bool {
	if s.len() < min_len || s.last() != Some(&close) {
		return false;
	}
	let slashes = s[..s.len() - 1]
		.iter()
		.rev()
		.take_while(|&&c| c == b'\\')
		.count();
	slashes % 2 == 0
}

/// Which grammar the block of an at-rule has.
enum BodyKind {
	/// Rules at the top level, declarations and rules inside a style rule.
	Conditional,
	Rules,
	Declarations,
	Raw,
}

fn body_kind(name: &str) -> BodyKind {
	let lower = name.to_ascii_lowercase();
	let bare = match lower.strip_prefix('-') {
		Some(rest) => rest.split_once('-').map_or(rest, |(_, r)| r),
		None => &lower,
	};
	match bare {
		"media" | "supports" | "document" | "layer" | "container" | "scope" | "starting-style" => {
			BodyKind::Conditional
		}
		"keyframes" | "font-feature-values" => BodyKind::Rules,
		"font-face"
		| "page"
		| "property"
		| "counter-style"
		| "font-palette-values"
		| "position-try"
		| "view-transition"
		| "viewport"
		| "swash"
		| "annotation"
		| "ornaments"
		| "stylistic"
		| "styleset"
		| "character-variant"
		| "top-left-corner"
		| "top-left"
		| "top-center"
		| "top-right"
		| "top-right-corner"
		| "bottom-left-corner"
		| "bottom-left"
		| "bottom-center"
		| "bottom-right"
		| "bottom-right-corner"
		| "left-top"
		| "left-middle"
		| "left-bottom"
		| "right-top"
		| "right-middle"
		| "right-bottom" => BodyKind::Declarations,
		_ => BodyKind::Raw,
	}
}

impl Parser<'_> {
	fn text_of(&self, t: Token) -> &str {
		&self.src[t.start..t.end]
	}

	/// Source text of the tokens `from..to` with comments dropped (selectors)
	/// or replaced by a space (everything else), `/*!` comments included.
	fn text(&self, from: usize, to: usize, mode: Text) -> String {
		let mut out = String::new();
		for t in &self.toks[from..to] {
			if t.kind == Kind::Comment {
				if mode == Text::Plain {
					out.push(' ');
				}
			} else {
				out.push_str(self.text_of(*t));
			}
		}
		out.trim_matches(is_css_ws).to_owned()
	}

	/// Finds where the item starting at token `from` ends: the first `{`
	/// (unless `braces_nest`), `;` (when `stop_semi`) or `}` (when `nested`)
	/// that is not inside a parenthesis, bracket or brace.
	fn scan(
		&self,
		from: usize,
		stop_semi: bool,
		nested: bool,
		braces_nest: bool,
	) -> (usize, Option<Kind>) {
		let mut stack: Vec<Kind> = Vec::new();
		let mut i = from;
		while i < self.toks.len() {
			let k = self.toks[i].kind;
			if stack.is_empty() {
				match k {
					Kind::LBrace if !braces_nest => return (i, Some(Kind::LBrace)),
					Kind::Semicolon if stop_semi => return (i, Some(Kind::Semicolon)),
					Kind::RBrace if nested => return (i, Some(Kind::RBrace)),
					_ => {}
				}
			}
			match k {
				Kind::LParen | Kind::Function => stack.push(Kind::RParen),
				Kind::LBracket => stack.push(Kind::RBracket),
				Kind::LBrace => stack.push(Kind::RBrace),
				Kind::RParen | Kind::RBracket | Kind::RBrace if stack.last() == Some(&k) => {
					stack.pop();
				}
				_ => {}
			}
			i += 1;
		}
		(self.toks.len(), None)
	}

	fn parse_list(&mut self, ctx: Ctx, nested: bool) -> Vec<Node> {
		let mut out = Vec::new();
		while let Some(&t) = self.toks.get(self.pos) {
			match t.kind {
				Kind::Whitespace => self.pos += 1,
				Kind::Comment => {
					let text = self.text_of(t);
					if text.starts_with("/*!") {
						out.push(Node::Comment(Comment {
							text: text.to_owned(),
							offset: t.start,
						}));
					}
					self.pos += 1;
				}
				Kind::Semicolon if ctx == Ctx::Block => self.pos += 1,
				Kind::RBrace if nested => break,
				Kind::Cdo | Kind::Cdc if !nested && ctx == Ctx::Rules => self.pos += 1,
				Kind::AtKeyword => {
					if let Some(n) = self.at_rule(ctx, nested) {
						out.push(n);
					}
				}
				_ => match ctx {
					Ctx::Rules => {
						if let Some(n) = self.qualified(nested) {
							out.push(n);
						}
					}
					Ctx::Block => {
						if let Some(n) = self.block_item(nested) {
							out.push(n);
						}
					}
				},
			}
		}
		out
	}

	/// A qualified rule in a list of rules.
	fn qualified(&mut self, nested: bool) -> Option<Node> {
		let start = self.pos;
		let (end, term) = self.scan(start, false, nested, false);
		if term == Some(Kind::LBrace) {
			Some(self.finish_rule(start, end))
		} else {
			// Cut short by the end of the input or of the block: dropped.
			self.pos = end;
			None
		}
	}

	/// The rule whose prelude is the tokens `start..end` and whose `{` is the
	/// token at `end`.
	fn finish_rule(&mut self, start: usize, end: usize) -> Node {
		let selector = self.text(start, end, Text::Selector);
		let offset = self.toks[start].start;
		self.pos = end + 1;
		let nodes = self.parse_list(Ctx::Block, true);
		if self
			.toks
			.get(self.pos)
			.is_some_and(|t| t.kind == Kind::RBrace)
		{
			self.pos += 1;
		}
		Node::Rule(Rule {
			selector,
			nodes,
			offset,
		})
	}

	fn is_custom_start(&self, i: usize) -> bool {
		let t = self.toks[i];
		if t.kind != Kind::Ident || !self.text_of(t).starts_with("--") {
			return false;
		}
		let mut j = i + 1;
		while self
			.toks
			.get(j)
			.is_some_and(|t| matches!(t.kind, Kind::Whitespace | Kind::Comment))
		{
			j += 1;
		}
		self.toks.get(j).is_some_and(|t| t.kind == Kind::Colon)
	}

	/// A declaration or a nested rule inside a style rule.
	fn block_item(&mut self, nested: bool) -> Option<Node> {
		let start = self.pos;
		let custom = self.is_custom_start(start);
		let (end, term) = self.scan(start, true, nested, custom);
		if term == Some(Kind::LBrace) {
			return Some(self.finish_rule(start, end));
		}
		let decl = self.declaration(start, end, term.is_none());
		self.pos = end;
		if term == Some(Kind::Semicolon) {
			self.pos += 1;
		}
		decl.map(Node::Declaration)
	}

	/// What closes the strings, URLs and blocks left open by the tokens
	/// `from..to` when the input ends inside them.
	fn closers(&self, from: usize, to: usize) -> String {
		let mut stack: Vec<Kind> = Vec::new();
		let mut tail = String::new();
		for t in &self.toks[from..to] {
			match t.kind {
				Kind::LParen | Kind::Function => stack.push(Kind::RParen),
				Kind::LBracket => stack.push(Kind::RBracket),
				Kind::LBrace => stack.push(Kind::RBrace),
				Kind::RParen | Kind::RBracket | Kind::RBrace => {
					if stack.last() == Some(&t.kind) {
						stack.pop();
					}
				}
				Kind::String => {
					let s = self.text_of(*t).as_bytes();
					if !ends_with_unescaped(s, s[0], 2) {
						tail.push(s[0] as char);
					}
				}
				Kind::Url => {
					let s = self.text_of(*t).as_bytes();
					if !ends_with_unescaped(s, b')', 5) {
						tail.push(')');
					}
				}
				_ => {}
			}
		}
		while let Some(k) = stack.pop() {
			tail.push(match k {
				Kind::RParen => ')',
				Kind::RBracket => ']',
				_ => '}',
			});
		}
		tail
	}

	fn declaration(&self, start: usize, end: usize, eof: bool) -> Option<Declaration> {
		let mut colon = None;
		let mut depth = 0usize;
		for i in start..end {
			match self.toks[i].kind {
				Kind::Colon if depth == 0 => {
					colon = Some(i);
					break;
				}
				Kind::LParen | Kind::Function | Kind::LBracket | Kind::LBrace => depth += 1,
				Kind::RParen | Kind::RBracket | Kind::RBrace => depth = depth.saturating_sub(1),
				_ => {}
			}
		}
		let colon = colon?;
		let property = self.text(start, colon, Text::Selector);
		if property.is_empty() {
			return None;
		}
		let custom = property.starts_with("--");
		// `!important` at the end.
		let mut value_end = end;
		let mut important = false;
		let sig = |mut i: usize, floor: usize| -> Option<usize> {
			while i > floor {
				i -= 1;
				if !matches!(self.toks[i].kind, Kind::Whitespace | Kind::Comment) {
					return Some(i);
				}
			}
			None
		};
		if let Some(last) = sig(end, colon + 1)
			&& self.toks[last].kind == Kind::Ident
			&& self
				.text_of(self.toks[last])
				.eq_ignore_ascii_case("important")
			&& let Some(bang) = sig(last, colon + 1)
			&& self.toks[bang].kind == Kind::Delim
			&& self.text_of(self.toks[bang]) == "!"
		{
			important = true;
			value_end = bang;
		}
		let value = if custom {
			let first = self.toks[colon + 1..value_end]
				.iter()
				.position(|t| t.kind != Kind::Whitespace);
			match first {
				None => String::new(),
				Some(f) => {
					let from = self.toks[colon + 1 + f].start;
					let to = if value_end > colon + 1 {
						self.toks[value_end - 1].end
					} else {
						from
					};
					self.src[from..to].trim_matches(is_css_ws).to_owned()
				}
			}
		} else {
			self.text(colon + 1, value_end, Text::Plain)
		};
		let mut value = value;
		if eof && !important {
			value.push_str(&self.closers(colon + 1, value_end));
		}
		Some(Declaration {
			property,
			value,
			important,
			offset: self.toks[start].start,
		})
	}

	fn at_rule(&mut self, ctx: Ctx, nested: bool) -> Option<Node> {
		let t = self.toks[self.pos];
		let name = self.src[t.start + 1..t.end].to_owned();
		self.pos += 1;
		let space = self
			.toks
			.get(self.pos)
			.is_some_and(|t| matches!(t.kind, Kind::Whitespace | Kind::Comment));
		let (end, term) = self.scan(self.pos, true, nested, false);
		let mut prelude = self.text(self.pos, end, Text::Plain);
		if term.is_none() {
			prelude.push_str(&self.closers(self.pos, end));
		}
		self.pos = end;
		let body = match term {
			Some(Kind::Semicolon) => {
				self.pos += 1;
				Body::None
			}
			Some(Kind::LBrace) => {
				self.pos += 1;
				match body_kind(&name) {
					BodyKind::Raw => {
						let (close, _) = self.scan(self.pos, false, true, true);
						let from = self.toks.get(self.pos).map_or(self.src.len(), |t| t.start);
						let to = self.toks.get(close).map_or(self.src.len(), |t| t.start);
						let raw = if from < to { &self.src[from..to] } else { "" };
						self.pos = close;
						if self
							.toks
							.get(self.pos)
							.is_some_and(|t| t.kind == Kind::RBrace)
						{
							self.pos += 1;
						}
						Body::Raw(raw.trim_matches(is_css_ws).to_owned())
					}
					kind => {
						let child = match kind {
							BodyKind::Conditional if ctx == Ctx::Block => Ctx::Block,
							BodyKind::Conditional | BodyKind::Rules => Ctx::Rules,
							_ => Ctx::Block,
						};
						let nodes = self.parse_list(child, true);
						if self
							.toks
							.get(self.pos)
							.is_some_and(|t| t.kind == Kind::RBrace)
						{
							self.pos += 1;
						}
						Body::Nodes(nodes)
					}
				}
			}
			_ => Body::None,
		};
		Some(Node::AtRule(AtRule {
			name,
			prelude,
			space,
			body,
			offset: t.start,
		}))
	}
}

/// Parses a style sheet.
///
/// # Example
///
/// ```
/// use kd_css::parse::{parse_stylesheet, Node};
///
/// let sheet = parse_stylesheet("a { color: red !important }");
/// let Node::Rule(rule) = &sheet.nodes[0] else { panic!() };
/// assert_eq!(rule.selector, "a");
/// let Node::Declaration(d) = &rule.nodes[0] else { panic!() };
/// assert_eq!((d.property.as_str(), d.value.as_str(), d.important), ("color", "red", true));
/// ```
pub fn parse_stylesheet(source: &str) -> Stylesheet {
	let mut p = Parser {
		src: source,
		toks: tokenize(source),
		pos: 0,
	};
	let mut nodes = Vec::new();
	while p.pos < p.toks.len() {
		nodes.extend(p.parse_list(Ctx::Rules, false));
	}
	Stylesheet { nodes }
}

/// Parses the content of a `style` attribute: a list of declarations. Rules
/// and at-rules in it are dropped, as a browser does.
///
/// # Example
///
/// ```
/// let decls = kd_css::parse::parse_declaration_list("color: red; margin: 0");
/// assert_eq!(decls.len(), 2);
/// ```
pub fn parse_declaration_list(source: &str) -> Vec<Declaration> {
	let mut p = Parser {
		src: source,
		toks: tokenize(source),
		pos: 0,
	};
	let mut nodes = Vec::new();
	while p.pos < p.toks.len() {
		let before = p.pos;
		nodes.extend(p.parse_list(Ctx::Block, false));
		if p.pos == before {
			p.pos += 1;
		}
	}
	nodes
		.into_iter()
		.filter_map(|n| match n {
			Node::Declaration(d) => Some(d),
			_ => None,
		})
		.collect()
}
