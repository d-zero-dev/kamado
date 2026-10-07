//! The parser prettier formats HTML with: a port of the lexer and tree
//! builder of angular-html-parser, with the options prettier's `html` parser
//! sets (`canSelfClose`, `allowHtmComponentClosingTags`, names not case
//! sensitive; no Angular blocks, `@let` or ICU expansions).
//!
//! What it produces is a tree of raw nodes with byte spans into the input.
//! Text is *not* decoded: prettier prints text from the source, and uses
//! the parser only for structure and positions.
//!
//! Errors: prettier throws the first error the lexer or the tree builder
//! recorded, so any input that records one is an `Err` here. What is *not* an
//! error, and must stay one, is as important: a `<` that does not start a tag
//! is text, an element left open at the end of the input is closed silently,
//! and a self-closed element of any name is accepted.

use crate::parser::is_js_space;

/// A byte range in the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Span {
	pub start: usize,
	pub end: usize,
}

/// A failure to parse.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParseError {
	pub message: String,
	pub offset: usize,
}

impl std::fmt::Display for ParseError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{} (at offset {})", self.message, self.offset)
	}
}

impl std::error::Error for ParseError {}

/// One attribute as the parser saw it.
#[derive(Debug, Clone)]
pub struct RawAttr {
	/// The prefix of `prefix:name` (`""` when there is none).
	pub prefix: String,
	pub name: String,
	/// From the name through the end of the value (or the name alone).
	pub span: Span,
	/// The name as written.
	pub name_span: Span,
	/// The value including its quotes; `None` for a bare attribute.
	pub value_span: Option<Span>,
}

#[derive(Debug, Clone)]
pub enum RawKind {
	Element {
		/// `":prefix:name"` or `"name"`, as the tree builder names it.
		full_name: String,
		attrs: Vec<RawAttr>,
		/// `<name ... />`
		self_closing: bool,
		start_span: Span,
		end_span: Option<Span>,
		/// The tag name as written (after `<`).
		name_span: Span,
	},
	Text,
	Comment,
	DocType,
	Cdata,
}

#[derive(Debug, Clone)]
pub struct RawNode {
	pub kind: RawKind,
	pub span: Span,
	pub children: Vec<usize>,
	/// DocType: the text after `<!doctype`, trimmed. Cdata: its content.
	pub value: String,
}

/// The result of a parse: all nodes, and the top-level ones.
#[derive(Debug)]
pub struct RawTree {
	pub nodes: Vec<RawNode>,
	pub roots: Vec<usize>,
}

// ----- tag definitions -----

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ContentType {
	RawText,
	EscapableRawText,
	Parsable,
}

#[derive(Debug, Clone, Copy)]
pub struct TagDef {
	pub closed_by_children: &'static [&'static str],
	pub closed_by_parent: bool,
	pub is_void: bool,
	pub ignore_first_lf: bool,
	pub implicit_namespace: Option<&'static str>,
	pub prevent_namespace_inheritance: bool,
	pub content_type: ContentType,
}

const DEFAULT_DEF: TagDef = TagDef {
	closed_by_children: &[],
	closed_by_parent: false,
	is_void: false,
	ignore_first_lf: false,
	implicit_namespace: None,
	prevent_namespace_inheritance: false,
	content_type: ContentType::Parsable,
};

const VOID_DEF: TagDef = TagDef {
	is_void: true,
	closed_by_parent: true,
	..DEFAULT_DEF
};

/// (`foreignObject` has no entry on purpose: prettier's table keys it in camel
/// case but looks names up in lower case, so it never matches there either,
/// and its children inherit the namespace.)
///
/// The definition of a tag by its (plain) name, case-insensitively. A name
/// the table does not know has the default definition.
#[must_use]
pub fn tag_def(name: &str) -> TagDef {
	let lower = name.to_ascii_lowercase();
	match lower.as_str() {
		"base" | "meta" | "area" | "embed" | "link" | "img" | "input" | "param" | "hr" | "br"
		| "source" | "track" | "wbr" | "col" => VOID_DEF,
		"p" => TagDef {
			closed_by_children: &[
				"address",
				"article",
				"aside",
				"blockquote",
				"div",
				"dl",
				"fieldset",
				"footer",
				"form",
				"h1",
				"h2",
				"h3",
				"h4",
				"h5",
				"h6",
				"header",
				"hgroup",
				"hr",
				"main",
				"nav",
				"ol",
				"p",
				"pre",
				"section",
				"table",
				"ul",
			],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"thead" => TagDef {
			closed_by_children: &["tbody", "tfoot"],
			..DEFAULT_DEF
		},
		"tbody" => TagDef {
			closed_by_children: &["tbody", "tfoot"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"tfoot" => TagDef {
			closed_by_children: &["tbody"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"tr" => TagDef {
			closed_by_children: &["tr"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"td" | "th" => TagDef {
			closed_by_children: &["td", "th"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"svg" => TagDef {
			implicit_namespace: Some("svg"),
			..DEFAULT_DEF
		},
		"math" => TagDef {
			implicit_namespace: Some("math"),
			..DEFAULT_DEF
		},
		"li" => TagDef {
			closed_by_children: &["li"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"dt" => TagDef {
			closed_by_children: &["dt", "dd"],
			..DEFAULT_DEF
		},
		"dd" => TagDef {
			closed_by_children: &["dt", "dd"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"rb" | "rt" | "rp" => TagDef {
			closed_by_children: &["rb", "rt", "rtc", "rp"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"rtc" => TagDef {
			closed_by_children: &["rb", "rtc", "rp"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"optgroup" => TagDef {
			closed_by_children: &["optgroup"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"option" => TagDef {
			closed_by_children: &["option", "optgroup"],
			closed_by_parent: true,
			..DEFAULT_DEF
		},
		"pre" | "listing" => TagDef {
			ignore_first_lf: true,
			..DEFAULT_DEF
		},
		"style" | "script" => TagDef {
			content_type: ContentType::RawText,
			..DEFAULT_DEF
		},
		"title" => TagDef {
			content_type: ContentType::EscapableRawText,
			..DEFAULT_DEF
		},
		"textarea" => TagDef {
			content_type: ContentType::EscapableRawText,
			ignore_first_lf: true,
			..DEFAULT_DEF
		},
		_ => DEFAULT_DEF,
	}
}

/// The definition the tree builder uses for an element by its *full* name:
/// a namespaced name (`:svg:path`) is not in the table, so it gets the
/// default definition.
fn def_of_full_name(full: &str) -> TagDef {
	if full.starts_with(':') {
		DEFAULT_DEF
	} else {
		tag_def(full)
	}
}

impl TagDef {
	fn is_closed_by_child(&self, full_name: &str) -> bool {
		self.is_void
			|| self
				.closed_by_children
				.contains(&full_name.to_ascii_lowercase().as_str())
	}
}

/// `":ns:name"` → `(Some("ns"), "name")`; anything else → `(None, name)`.
#[must_use]
pub fn split_full_name(full: &str) -> (Option<&str>, &str) {
	if let Some(rest) = full.strip_prefix(':')
		&& let Some(i) = rest.find(':')
	{
		return (Some(&rest[..i]), &rest[i + 1..]);
	}
	(None, full)
}

fn full_name_of(prefix: &str, name: &str) -> String {
	if prefix.is_empty() {
		name.to_owned()
	} else {
		format!(":{prefix}:{name}")
	}
}

// ----- lexer -----

#[derive(Debug, Clone)]
enum Tok {
	TagOpen {
		prefix: String,
		name: String,
		attrs: Vec<RawAttr>,
		/// From `<` to just after `>`.
		span: Span,
		name_span: Span,
		void: bool,
	},
	TagClose {
		prefix: String,
		name: String,
		/// `</ />` (`allowHtmComponentClosingTags`).
		htm: bool,
		span: Span,
	},
	Text {
		span: Span,
	},
	Comment {
		span: Span,
	},
	Cdata {
		text: Span,
		span: Span,
	},
	DocType {
		text: Span,
		span: Span,
	},
	Eof,
}

struct Lexer<'a> {
	src: &'a str,
	bytes: &'a [u8],
	pos: usize,
	tokens: Vec<Tok>,
}

type LexResult<T> = Result<T, ParseError>;

fn is_ws(c: u32) -> bool {
	(9..=32).contains(&c) || c == 160
}

fn is_alpha(c: u32) -> bool {
	(97..=122).contains(&c) || (65..=90).contains(&c)
}

fn is_digit(c: u32) -> bool {
	(48..=57).contains(&c)
}

fn is_hex(c: u32) -> bool {
	(97..=102).contains(&c) || (65..=70).contains(&c) || is_digit(c)
}

/// Ends an attribute or tag name.
fn is_name_end(c: u32) -> bool {
	is_ws(c) || matches!(c, 62 | 60 | 47 | 39 | 34 | 61 | 0)
}

fn is_prefix_end(c: u32) -> bool {
	!(is_alpha(c) || is_digit(c))
}

/// `parseInt(digits, radix)`: the longest valid prefix, `None` for NaN.
fn js_parse_int(digits: &str, radix: u32) -> Option<u64> {
	let mut value: u64 = 0;
	let mut any = false;
	for c in digits.chars() {
		let Some(d) = c.to_digit(radix) else { break };
		any = true;
		value = value
			.saturating_mul(u64::from(radix))
			.saturating_add(u64::from(d));
	}
	any.then_some(value)
}

impl<'a> Lexer<'a> {
	fn peek(&self) -> u32 {
		if self.pos >= self.bytes.len() {
			return 0;
		}
		let b = self.bytes[self.pos];
		if b < 0x80 {
			return u32::from(b);
		}
		self.src[self.pos..].chars().next().map_or(0, |c| c as u32)
	}

	fn peek_second(&self) -> u32 {
		let mut it = self.src[self.pos..].chars();
		it.next();
		it.next().map_or(0, |c| c as u32)
	}

	fn advance(&mut self) -> LexResult<()> {
		if self.pos >= self.bytes.len() {
			return Err(self.err("Unexpected character \"EOF\""));
		}
		let b = self.bytes[self.pos];
		self.pos += if b < 0x80 {
			1
		} else {
			self.src[self.pos..]
				.chars()
				.next()
				.map_or(1, char::len_utf8)
		};
		Ok(())
	}

	fn err(&self, message: &str) -> ParseError {
		ParseError {
			message: message.to_owned(),
			offset: self.pos.min(self.bytes.len()),
		}
	}

	fn unexpected(&self) -> ParseError {
		let c = self.peek();
		let shown = if c == 0 {
			"EOF".to_owned()
		} else {
			char::from_u32(c).map_or_else(String::new, |c| c.to_string())
		};
		self.err(&format!("Unexpected character \"{shown}\""))
	}

	fn attempt_char(&mut self, c: u32) -> LexResult<bool> {
		if self.peek() == c {
			self.advance()?;
			Ok(true)
		} else {
			Ok(false)
		}
	}

	fn attempt_str(&mut self, s: &str) -> bool {
		if self.src[self.pos..].starts_with(s) {
			self.pos += s.len();
			true
		} else {
			false
		}
	}

	fn attempt_str_ci(&mut self, s: &str) -> bool {
		let rest = &self.bytes[self.pos..];
		if rest.len() >= s.len() && rest[..s.len()].eq_ignore_ascii_case(s.as_bytes()) {
			self.pos += s.len();
			true
		} else {
			false
		}
	}

	/// Advances until `stop` holds for the current character.
	fn skip_until(&mut self, mut stop: impl FnMut(u32) -> bool) -> LexResult<()> {
		while !stop(self.peek()) {
			self.advance()?;
		}
		Ok(())
	}

	fn skip_ws(&mut self) -> LexResult<()> {
		while self.peek() != 0 && is_ws(self.peek()) {
			self.advance()?;
		}
		Ok(())
	}

	fn is_tag_start(&self) -> bool {
		if self.peek() == 60 {
			let c = self.peek_second();
			return is_alpha(c) || c == 47 || c == 33 || c == 63;
		}
		false
	}

	fn tokenize(&mut self) -> LexResult<()> {
		while self.peek() != 0 {
			let start = self.pos;
			if self.attempt_char(60)? {
				if self.attempt_char(33)? {
					if self.attempt_str("[CDATA[") {
						self.consume_cdata(start)?;
					} else if self.attempt_str("--") {
						self.consume_comment(start)?;
					} else if self.attempt_str_ci("doctype") {
						self.consume_doctype(start)?;
					} else {
						self.consume_bogus_comment(start)?;
					}
				} else if self.attempt_char(47)? {
					self.consume_tag_close(start)?;
				} else if self.peek() == 63 {
					self.consume_bogus_comment(start)?;
				} else {
					self.consume_tag_open(start)?;
				}
			} else {
				self.consume_text(start)?;
			}
		}
		self.tokens.push(Tok::Eof);
		Ok(())
	}

	/// Text up to the next tag start. `{{ … }}` is skipped as a unit, so a
	/// `&` inside it is not a character reference.
	fn consume_text(&mut self, start: usize) -> LexResult<()> {
		while !(self.is_tag_start() || self.peek() == 0) {
			if self.src[self.pos..].starts_with("{{") {
				self.pos += 2;
				self.consume_interpolation(&|l: &Lexer<'_>| l.is_tag_start())?;
			} else if self.peek() == 38 {
				self.consume_entity()?;
			} else {
				self.advance()?;
			}
		}
		self.push_text(start);
		Ok(())
	}

	fn push_text(&mut self, start: usize) {
		if self.pos <= start {
			return;
		}
		if let Some(Tok::Text { span }) = self.tokens.last_mut()
			&& span.end == start
		{
			span.end = self.pos;
			return;
		}
		self.tokens.push(Tok::Text {
			span: Span {
				start,
				end: self.pos,
			},
		});
	}

	/// After `{{`: up to and including `}}`, or up to where `stop` holds / the
	/// end of the input. Quotes hide a `}}`.
	fn consume_interpolation(&mut self, stop: &dyn Fn(&Lexer<'_>) -> bool) -> LexResult<()> {
		let mut quote: Option<u32> = None;
		let mut in_line_comment = false;
		while self.peek() != 0 && !stop(self) {
			if quote.is_none() {
				if self.attempt_str("}}") {
					return Ok(());
				}
				if self.src[self.pos..].starts_with("//") {
					in_line_comment = true;
				}
			}
			let c = self.peek();
			self.advance()?;
			if c == 92 {
				self.advance()?;
			} else if Some(c) == quote {
				quote = None;
			} else if !in_line_comment && quote.is_none() && matches!(c, 39 | 34 | 96) {
				quote = Some(c);
			}
		}
		Ok(())
	}

	/// `&…;` in text and values: an unknown or malformed reference is an
	/// error, a lone `&` or `&name` without `;` is text.
	fn consume_entity(&mut self) -> LexResult<()> {
		let begin = self.pos;
		self.advance()?;
		if self.attempt_char(35)? {
			let hex = self.attempt_char(120)? || self.attempt_char(88)?;
			let digits_start = self.pos;
			self.skip_until(|c| c == 59 || c == 0 || !is_hex(c))?;
			if self.peek() != 59 {
				self.advance()?;
				let kind = if hex { "hexadecimal" } else { "decimal" };
				return Err(self.err(&format!(
					"Unable to parse entity \"{}\" - {kind} character reference entities must end with \";\"",
					&self.src[begin..self.pos]
				)));
			}
			let digits = &self.src[digits_start..self.pos];
			self.advance()?;
			// `String.fromCodePoint(parseInt(..))` throws for NaN and for
			// values past U+10FFFF; a surrogate is accepted.
			match js_parse_int(digits, if hex { 16 } else { 10 }) {
				Some(v) if v <= 0x10_FFFF => Ok(()),
				_ => Err(self.err(&format!(
					"Unknown entity \"{}\" - use the \"&#<decimal>;\" or  \"&#x<hex>;\" syntax",
					&self.src[begin..self.pos]
				))),
			}
		} else {
			let name_start = self.pos;
			self.skip_until(|c| c == 59 || c == 0 || !(is_alpha(c) || is_digit(c)))?;
			if self.peek() != 59 {
				// `&name` without `;`: the `&` is text; scanning resumes after it.
				self.pos = name_start;
				return Ok(());
			}
			let name = &self.src[name_start..self.pos];
			self.advance()?;
			if super::entity_names::is_known(name) {
				Ok(())
			} else {
				Err(self.err(&format!(
					"Unknown entity \"{name}\" - use the \"&#<decimal>;\" or  \"&#x<hex>;\" syntax"
				)))
			}
		}
	}

	/// Consumes raw text up to the position where `terminator` holds (the
	/// cursor is left there). `terminator` may move the cursor; it is reset
	/// after every try.
	fn consume_raw_text(
		&mut self,
		with_entities: bool,
		mut terminator: impl FnMut(&mut Lexer<'a>) -> bool,
	) -> LexResult<()> {
		loop {
			let save = self.pos;
			let found = terminator(self);
			self.pos = save;
			if found {
				return Ok(());
			}
			if with_entities && self.peek() == 38 {
				self.consume_entity()?;
			} else {
				self.advance()?;
			}
		}
	}

	fn consume_comment(&mut self, start: usize) -> LexResult<()> {
		self.consume_raw_text(false, |l| l.attempt_str("-->"))?;
		self.pos += 3;
		self.tokens.push(Tok::Comment {
			span: Span {
				start,
				end: self.pos,
			},
		});
		Ok(())
	}

	/// `<!…>` and `<?…>`: a comment up to the first `>`.
	fn consume_bogus_comment(&mut self, start: usize) -> LexResult<()> {
		self.consume_raw_text(false, |l| l.peek() == 62)?;
		self.advance()?;
		self.tokens.push(Tok::Comment {
			span: Span {
				start,
				end: self.pos,
			},
		});
		Ok(())
	}

	fn consume_cdata(&mut self, start: usize) -> LexResult<()> {
		let text_start = self.pos;
		self.consume_raw_text(false, |l| l.attempt_str("]]>"))?;
		let text_end = self.pos;
		self.pos += 3;
		self.tokens.push(Tok::Cdata {
			text: Span {
				start: text_start,
				end: text_end,
			},
			span: Span {
				start,
				end: self.pos,
			},
		});
		Ok(())
	}

	fn consume_doctype(&mut self, start: usize) -> LexResult<()> {
		let text_start = self.pos;
		self.consume_raw_text(false, |l| l.peek() == 62)?;
		let text_end = self.pos;
		self.advance()?;
		self.tokens.push(Tok::DocType {
			text: Span {
				start: text_start,
				end: text_end,
			},
			span: Span {
				start,
				end: self.pos,
			},
		});
		Ok(())
	}

	/// `prefix:name` where the name ends where `end` holds; `end` is a
	/// closure so that bracketed attribute names can track their depth.
	fn consume_prefix_and_name(
		&mut self,
		mut end: impl FnMut(u32) -> bool,
	) -> LexResult<(String, String)> {
		let begin = self.pos;
		let mut prefix = String::new();
		while self.peek() != 58 && !is_prefix_end(self.peek()) {
			self.advance()?;
		}
		let name_start = if self.peek() == 58 {
			prefix = self.src[begin..self.pos].to_owned();
			self.advance()?;
			self.pos
		} else {
			begin
		};
		let min = usize::from(!prefix.is_empty());
		let before = self.pos;
		self.skip_until(&mut end)?;
		if self.pos - before < min {
			return Err(self.unexpected());
		}
		Ok((prefix, self.src[name_start..self.pos].to_owned()))
	}

	fn consume_tag_open(&mut self, start: usize) -> LexResult<()> {
		if !is_alpha(self.peek()) {
			// A `<` that does not start a tag is text (the cursor is already
			// just after it).
			self.push_text(start);
			return Ok(());
		}
		self.consume_tag_open_inner(start).map_err(|e| ParseError {
			message: format!("Opening tag not terminated ({})", e.message),
			offset: e.offset,
		})
	}

	fn consume_tag_open_inner(&mut self, start: usize) -> LexResult<()> {
		let (prefix, name) = self.consume_prefix_and_name(is_name_end)?;
		let name_span = Span {
			start: start + 1,
			end: self.pos,
		};
		self.skip_ws()?;
		let mut attrs = Vec::new();
		loop {
			let c = self.peek();
			if matches!(c, 47 | 62 | 60 | 0) {
				break;
			}
			attrs.push(self.consume_attribute()?);
		}
		let void = self.attempt_char(47)?;
		if self.peek() != 62 {
			return Err(self.unexpected());
		}
		self.advance()?;
		self.tokens.push(Tok::TagOpen {
			prefix: prefix.clone(),
			name: name.clone(),
			attrs,
			span: Span {
				start,
				end: self.pos,
			},
			name_span,
			void,
		});
		if void {
			return Ok(());
		}
		match tag_def(&name).content_type {
			ContentType::Parsable => Ok(()),
			ContentType::RawText => self.consume_raw_text_with_tag_close(&prefix, &name, false),
			ContentType::EscapableRawText => {
				self.consume_raw_text_with_tag_close(&prefix, &name, true)
			}
		}
	}

	fn consume_raw_text_with_tag_close(
		&mut self,
		prefix: &str,
		name: &str,
		with_entities: bool,
	) -> LexResult<()> {
		let text_start = self.pos;
		let full = if prefix.is_empty() {
			name.to_owned()
		} else {
			format!("{prefix}:{name}")
		};
		self.consume_raw_text(with_entities, |l| {
			if !l.attempt_char(60).unwrap_or(false) || !l.attempt_char(47).unwrap_or(false) {
				return false;
			}
			let _ = l.skip_ws();
			if !l.attempt_str_ci(&full) {
				return false;
			}
			let _ = l.skip_ws();
			l.attempt_char(62).unwrap_or(false)
		})?;
		if self.pos > text_start {
			self.tokens.push(Tok::Text {
				span: Span {
					start: text_start,
					end: self.pos,
				},
			});
		}
		let close_start = self.pos;
		self.skip_until(|c| c == 62)?;
		self.advance()?;
		self.tokens.push(Tok::TagClose {
			prefix: prefix.to_owned(),
			name: name.to_owned(),
			htm: false,
			span: Span {
				start: close_start,
				end: self.pos,
			},
		});
		Ok(())
	}

	fn consume_attribute(&mut self) -> LexResult<RawAttr> {
		let first = self.peek();
		if first == 39 || first == 34 {
			return Err(self.unexpected());
		}
		let begin = self.pos;
		let (prefix, name) = if first == 91 {
			// `[`…`]` names (Angular bindings) may contain anything but a
			// line end inside the brackets.
			let mut depth: i32 = 0;
			self.consume_prefix_and_name(move |ch| {
				if ch == 91 {
					depth += 1;
				} else if ch == 93 {
					depth -= 1;
				}
				if depth <= 0 {
					is_name_end(ch)
				} else {
					ch == 10 || ch == 13
				}
			})?
		} else {
			self.consume_prefix_and_name(is_name_end)?
		};
		let name_span = Span {
			start: begin,
			end: self.pos,
		};
		self.skip_ws()?;
		let mut value_span = None;
		if self.attempt_char(61)? {
			self.skip_ws()?;
			let value_start = self.pos;
			self.consume_attribute_value()?;
			value_span = Some(Span {
				start: value_start,
				end: self.pos,
			});
		}
		let end = value_span.map_or(name_span.end, |v| v.end);
		self.skip_ws()?;
		Ok(RawAttr {
			prefix,
			name,
			span: Span { start: begin, end },
			name_span,
			value_span,
		})
	}

	fn consume_attribute_value(&mut self) -> LexResult<()> {
		let q = self.peek();
		if q == 39 || q == 34 {
			self.advance()?;
			self.consume_value_text(&|l: &Lexer<'_>| l.peek() == q)?;
			if self.peek() != q {
				return Err(self.unexpected());
			}
			self.advance()?;
		} else {
			self.consume_value_text(&|l: &Lexer<'_>| is_name_end(l.peek()))?;
		}
		Ok(())
	}

	/// Value text up to where `end` holds (not consumed).
	fn consume_value_text(&mut self, end: &dyn Fn(&Lexer<'_>) -> bool) -> LexResult<()> {
		while !end(self) {
			if self.peek() == 0 {
				return Err(self.unexpected());
			}
			if self.src[self.pos..].starts_with("{{") {
				self.pos += 2;
				self.consume_interpolation(end)?;
			} else if self.peek() == 38 {
				self.consume_entity()?;
			} else {
				self.advance()?;
			}
		}
		Ok(())
	}

	fn consume_tag_close(&mut self, start: usize) -> LexResult<()> {
		self.skip_ws()?;
		if self.attempt_char(47)? {
			// `</ />`: prettier's `allowHtmComponentClosingTags`
			self.skip_ws()?;
			if self.peek() != 62 {
				return Err(self.unexpected());
			}
			self.advance()?;
			self.tokens.push(Tok::TagClose {
				prefix: String::new(),
				name: String::new(),
				htm: true,
				span: Span {
					start,
					end: self.pos,
				},
			});
			return Ok(());
		}
		let (prefix, name) = self.consume_prefix_and_name(is_name_end)?;
		self.skip_ws()?;
		if self.peek() != 62 {
			return Err(self.unexpected());
		}
		self.advance()?;
		self.tokens.push(Tok::TagClose {
			prefix,
			name,
			htm: false,
			span: Span {
				start,
				end: self.pos,
			},
		});
		Ok(())
	}
}

// ----- tree builder -----

struct Open {
	node: usize,
	full_name: String,
}

struct Builder<'a> {
	src: &'a str,
	tokens: Vec<Tok>,
	index: usize,
	nodes: Vec<RawNode>,
	roots: Vec<usize>,
	stack: Vec<Open>,
}

impl Builder<'_> {
	fn peek(&self) -> &Tok {
		&self.tokens[self.index.min(self.tokens.len() - 1)]
	}

	fn advance(&mut self) -> Tok {
		let t = self.peek().clone();
		if self.index < self.tokens.len() - 1 {
			self.index += 1;
		}
		t
	}

	fn add_to_parent(&mut self, node: usize) {
		match self.stack.last() {
			Some(open) => {
				let parent = open.node;
				self.nodes[parent].children.push(node);
			}
			None => self.roots.push(node),
		}
	}

	fn alloc(&mut self, kind: RawKind, span: Span, value: String) -> usize {
		self.nodes.push(RawNode {
			kind,
			span,
			children: Vec::new(),
			value,
		});
		self.nodes.len() - 1
	}

	fn container_def(&self) -> Option<TagDef> {
		self.stack.last().map(|o| def_of_full_name(&o.full_name))
	}

	fn close_void_element(&mut self) {
		if self.container_def().is_some_and(|def| def.is_void) {
			self.stack.pop();
		}
	}

	/// The prefix a tag takes: the one written, the tag's own implicit one,
	/// or the namespace of the closest element unless that one prevents it.
	fn prefix_for(&self, written: &str, name: &str) -> String {
		if !written.is_empty() {
			return written.to_owned();
		}
		if let Some(own) = tag_def(name).implicit_namespace {
			return own.to_owned();
		}
		if let Some(open) = self.stack.last() {
			let (namespace, local) = split_full_name(&open.full_name);
			if !tag_def(local).prevent_namespace_inheritance
				&& let Some(ns) = namespace
			{
				return ns.to_owned();
			}
		}
		String::new()
	}

	fn build(&mut self) -> Result<(), ParseError> {
		loop {
			match self.peek().clone() {
				Tok::Eof => return Ok(()),
				Tok::TagOpen { .. } => {
					let t = self.advance();
					self.consume_element_start(t);
				}
				Tok::TagClose { .. } => {
					self.close_void_element();
					let t = self.advance();
					self.consume_element_end(t)?;
				}
				Tok::Cdata { .. } | Tok::Comment { .. } => {
					self.close_void_element();
					let t = self.advance();
					self.consume_leaf(t);
				}
				Tok::Text { .. } => {
					self.close_void_element();
					let t = self.advance();
					self.consume_text(t);
				}
				Tok::DocType { .. } => {
					let t = self.advance();
					self.consume_leaf(t);
				}
			}
		}
	}

	fn consume_leaf(&mut self, t: Tok) {
		match t {
			Tok::Cdata { text, span } => {
				let value = self.src[text.start..text.end].to_owned();
				let id = self.alloc(RawKind::Cdata, span, value);
				self.add_to_parent(id);
			}
			Tok::Comment { span } => {
				let id = self.alloc(RawKind::Comment, span, String::new());
				self.add_to_parent(id);
			}
			Tok::DocType { text, span } => {
				let value = self.src[text.start..text.end]
					.trim_matches(is_js_space)
					.to_owned();
				let id = self.alloc(RawKind::DocType, span, value);
				self.add_to_parent(id);
			}
			_ => {}
		}
	}

	fn consume_text(&mut self, t: Tok) {
		let Tok::Text { mut span } = t else { return };
		// A `\n` right after `<pre>`, `<textarea>`, `<listing>` is not content:
		// a text that is nothing else makes no node.
		let mut only_the_ignored_lf = false;
		if self.src.as_bytes().get(span.start) == Some(&b'\n')
			&& let Some(open) = self.stack.last()
			&& self.nodes[open.node].children.is_empty()
			&& def_of_full_name(&open.full_name).ignore_first_lf
		{
			only_the_ignored_lf = span.end == span.start + 1;
		}
		while let Tok::Text { span: next } = self.peek().clone() {
			if next.start != span.end {
				break;
			}
			self.advance();
			span.end = next.end;
			only_the_ignored_lf = false;
		}
		if only_the_ignored_lf {
			return;
		}
		let id = self.alloc(RawKind::Text, span, String::new());
		self.add_to_parent(id);
	}

	fn consume_element_start(&mut self, t: Tok) {
		let Tok::TagOpen {
			prefix,
			name,
			attrs,
			span,
			name_span,
			void,
		} = t
		else {
			return;
		};
		let prefix = self.prefix_for(&prefix, &name);
		let full_name = full_name_of(&prefix, &name);
		let id = self.alloc(
			RawKind::Element {
				full_name: full_name.clone(),
				attrs,
				self_closing: void,
				start_span: span,
				end_span: None,
				name_span,
			},
			span,
			String::new(),
		);
		if self
			.container_def()
			.is_some_and(|def| def.is_closed_by_child(&full_name))
		{
			self.stack.pop();
		}
		self.add_to_parent(id);
		self.stack.push(Open {
			node: id,
			full_name: full_name.clone(),
		});
		if void {
			self.pop_container(Some(&full_name), Some(span));
		}
	}

	fn consume_element_end(&mut self, t: Tok) -> Result<(), ParseError> {
		let Tok::TagClose {
			prefix,
			name,
			htm,
			span,
		} = t
		else {
			return Ok(());
		};
		let full_name = if htm && name.is_empty() {
			None
		} else {
			Some(full_name_of(&self.prefix_for(&prefix, &name), &name))
		};
		if let Some(full) = &full_name
			&& def_of_full_name(full).is_void
		{
			return Err(ParseError {
				message: format!("Void elements do not have end tags \"{name}\""),
				offset: span.start,
			});
		}
		if !self.pop_container(full_name.as_deref(), Some(span)) {
			return Err(ParseError {
				message: format!(
					"Unexpected closing tag \"{}\". It may happen when the tag has already been closed by another tag. For more info see https://www.w3.org/TR/html5/syntax.html#closing-elements-that-have-implied-end-tags",
					full_name.as_deref().unwrap_or("")
				),
				offset: span.start,
			});
		}
		Ok(())
	}

	/// Closes the innermost open element named `name` (`None`: the innermost
	/// without a namespace) and everything above it. `false` when there is no
	/// such element, or when something that may not be closed implicitly lies
	/// between.
	fn pop_container(&mut self, name: Option<&str>, span: Option<Span>) -> bool {
		let mut unexpected = false;
		for i in (0..self.stack.len()).rev() {
			let open_node = self.stack[i].node;
			let open_name = self.stack[i].full_name.clone();
			let has_namespace = split_full_name(&open_name).0.is_some();
			let matches = match name {
				Some(n) => open_name == n,
				None => !has_namespace,
			};
			if matches {
				if let Some(s) = span
					&& let RawKind::Element { end_span, .. } = &mut self.nodes[open_node].kind
				{
					*end_span = Some(s);
					self.nodes[open_node].span.end = s.end;
				}
				self.stack.truncate(i);
				return !unexpected;
			}
			if !def_of_full_name(&open_name).closed_by_parent {
				unexpected = true;
			}
		}
		false
	}
}

/// Parses `src` (line ends already normalized to `\n`).
///
/// # Errors
///
/// The first error prettier would throw.
pub fn parse(src: &str) -> Result<RawTree, ParseError> {
	let mut lexer = Lexer {
		src,
		bytes: src.as_bytes(),
		pos: 0,
		tokens: Vec::new(),
	};
	lexer.tokenize()?;
	let tokens = std::mem::take(&mut lexer.tokens);
	let mut builder = Builder {
		src,
		tokens,
		index: 0,
		nodes: Vec::new(),
		roots: Vec::new(),
		stack: Vec::new(),
	};
	builder.build()?;
	Ok(RawTree {
		nodes: builder.nodes,
		roots: builder.roots,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn shape(src: &str) -> String {
		fn go(tree: &RawTree, id: usize, src: &str, out: &mut String) {
			let n = &tree.nodes[id];
			match &n.kind {
				RawKind::Element {
					full_name,
					attrs,
					self_closing,
					end_span,
					..
				} => {
					out.push_str(full_name);
					for a in attrs {
						out.push(' ');
						out.push_str(&src[a.span.start..a.span.end]);
					}
					if *self_closing {
						out.push('/');
					}
					if end_span.is_none() {
						out.push('?');
					}
					out.push('(');
					for (i, &c) in n.children.iter().enumerate() {
						if i > 0 {
							out.push(',');
						}
						go(tree, c, src, out);
					}
					out.push(')');
				}
				RawKind::Text => out.push_str(&format!("#{:?}", &src[n.span.start..n.span.end])),
				RawKind::Comment => out.push_str(&format!("c{:?}", &src[n.span.start..n.span.end])),
				RawKind::DocType => out.push_str(&format!("doctype{:?}", n.value)),
				RawKind::Cdata => out.push_str(&format!("cdata{:?}", n.value)),
			}
		}
		let tree = parse(src).unwrap();
		let mut out = String::new();
		for (i, &r) in tree.roots.iter().enumerate() {
			if i > 0 {
				out.push(',');
			}
			go(&tree, r, src, &mut out);
		}
		out
	}

	#[test]
	fn elements_attributes_and_text() {
		assert_eq!(
			shape("<p class=\"a\" hidden>x<b>y</b></p>"),
			"p class=\"a\" hidden(#\"x\",b(#\"y\"))"
		);
		assert_eq!(
			shape("<a href=x title='t'>1</a>"),
			"a href=x title='t'(#\"1\")"
		);
	}

	#[test]
	fn void_elements_close_themselves() {
		assert_eq!(shape("<br><img src=a>text"), "br?(),img src=a?(),#\"text\"");
		assert_eq!(shape("<p>a<br>b</p>"), "p(#\"a\",br?(),#\"b\")");
	}

	#[test]
	fn a_self_closed_element_of_any_name_is_accepted() {
		assert_eq!(shape("<div/>x"), "div/(),#\"x\"");
		assert_eq!(shape("<my-el a=1 />"), "my-el a=1/()");
	}

	#[test]
	fn implied_end_tags() {
		assert_eq!(shape("<ul><li>1<li>2</ul>"), "ul(li?(#\"1\"),li?(#\"2\"))");
		assert_eq!(shape("<p>a<p>b"), "p?(#\"a\"),p?(#\"b\")");
		assert_eq!(
			shape("<table><tr><td>a<td>b</table>"),
			"table(tr?(td?(#\"a\"),td?(#\"b\")))"
		);
	}

	#[test]
	fn text_comments_doctype_and_cdata() {
		assert_eq!(
			shape("<!DOCTYPE html><!-- c --><![CDATA[x<y]]><?php echo 1; ?>t"),
			"doctype\"html\",c\"<!-- c -->\",cdata\"x<y\",c\"<?php echo 1; ?>\",#\"t\""
		);
	}

	#[test]
	fn a_lt_that_does_not_start_a_tag_is_text() {
		assert_eq!(shape("a < b <3 c"), "#\"a < b <3 c\"");
		assert_eq!(shape("<p>1</p><3"), "p(#\"1\"),#\"<3\"");
	}

	#[test]
	fn raw_text_elements() {
		assert_eq!(
			shape("<script>if(a<b){}</script>"),
			"script(#\"if(a<b){}\")"
		);
		assert_eq!(shape("<style>a>b{}</STYLE >"), "style(#\"a>b{}\")");
		assert_eq!(
			shape("<textarea>a &amp; <b></textarea>"),
			"textarea(#\"a &amp; <b>\")"
		);
		assert_eq!(shape("<title>A &amp; B</title>"), "title(#\"A &amp; B\")");
	}

	#[test]
	fn the_first_line_feed_of_pre_and_textarea_is_not_content() {
		assert_eq!(shape("<pre>\n</pre>"), "pre()");
		assert_eq!(shape("<pre>\nx</pre>"), "pre(#\"\\nx\")");
	}

	#[test]
	fn namespaces_are_inherited_inside_svg() {
		assert_eq!(
			shape("<svg><path d=x /></svg>"),
			":svg:svg(:svg:path d=x/())"
		);
		assert_eq!(
			shape("<svg><foreignObject><div></div></foreignObject></svg>"),
			":svg:svg(:svg:foreignObject(:svg:div()))"
		);
	}

	#[test]
	fn errors_are_the_ones_prettier_throws() {
		for bad in [
			"</div>",
			"<div></span>",
			"<br></br>",
			"<div",
			"<div class=\"a",
			"<a \"x\">",
			"<p>&unknown;</p>",
			"<p>&#xZZ;</p>",
			"<p>&#1114112;</p>",
			"<p>&#</p>",
			"<script>never closed",
			"<!-- never closed",
			"<a / b>",
		] {
			assert!(parse(bad).is_err(), "`{bad}` should be an error");
		}
	}

	#[test]
	fn entities_that_are_not_errors() {
		for ok in [
			"<p>&amp; &copy; &#65; &#x41; &nbsp</p>",
			"<p>& &a</p>x",
			"<p>{{ &unknown; }}</p>",
			"<a href=\"?a=1&b=2&copy=3\">x</a>",
		] {
			assert!(parse(ok).is_ok(), "`{ok}` should parse");
		}
	}

	#[test]
	fn spans_cover_start_tag_through_end_tag() {
		let src = "<div>x</div>";
		let tree = parse(src).unwrap();
		let n = &tree.nodes[tree.roots[0]];
		assert_eq!((n.span.start, n.span.end), (0, 12));
		let RawKind::Element {
			start_span,
			end_span,
			..
		} = &n.kind
		else {
			panic!("an element")
		};
		assert_eq!((start_span.start, start_span.end), (0, 5));
		assert_eq!(end_span.map(|s| (s.start, s.end)), Some((6, 12)));
	}
}
