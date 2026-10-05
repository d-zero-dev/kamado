//! JSX: the syntax of elements, attributes and children. Elements are read
//! straight from the source text; the JavaScript inside `{...}` goes back to
//! the token parser.

use crate::ast::{Edit, EditKind, JsxAttr, JsxChild, JsxElement, JsxTag};
use crate::jsx_entities;
use crate::lexer::{is_id_part, is_id_start};
use crate::parser::{Parser, R};

impl Parser<'_> {
	/// A JSX element or fragment at the current `<` token, where an
	/// expression is expected: recorded as an edit.
	pub(crate) fn jsx_root(&mut self) -> R<()> {
		let start = self.tok.start;
		let mut i = self.tok.end;
		self.enter()?;
		let element = self.jsx_element(start, &mut i)?;
		self.leave();
		self.edits.push(Edit {
			start,
			end: i,
			kind: EditKind::Jsx(Box::new(element)),
		});
		self.lex.pos = i;
		self.prev_end = i;
		self.tok = self.lex.next()?;
		Ok(())
	}

	fn byte(&self, i: usize) -> u8 {
		self.src.as_bytes().get(i).copied().unwrap_or(0)
	}

	fn jsx_err<T>(&self, at: usize, message: impl Into<String>) -> R<T> {
		Err(self.lex.error(at, message))
	}

	/// White space and comments between tokens inside a tag.
	fn jsx_skip_trivia(&self, i: &mut usize) -> R<()> {
		loop {
			match self.byte(*i) {
				b' ' | b'\t' | b'\n' | b'\r' | 0x0B | 0x0C => *i += 1,
				b'/' if self.byte(*i + 1) == b'/' => {
					while !matches!(self.byte(*i), b'\n' | b'\r' | 0) {
						*i += 1;
					}
				}
				b'/' if self.byte(*i + 1) == b'*' => {
					let start = *i;
					*i += 2;
					while !(self.byte(*i) == b'*' && self.byte(*i + 1) == b'/') {
						if *i >= self.src.len() {
							return self.jsx_err(start, "unterminated comment");
						}
						*i += 1;
					}
					*i += 2;
				}
				_ => {
					// Non-ASCII white space.
					match self.src.get(*i..).and_then(|s| s.chars().next()) {
						Some(c) if c.is_whitespace() && !c.is_ascii() => *i += c.len_utf8(),
						_ => return Ok(()),
					}
				}
			}
		}
	}

	/// A tag or attribute name: identifier characters and `-`, with `.` (tag
	/// members) or `:` (namespaces) between parts.
	fn jsx_name(&self, i: &mut usize, allow_member: bool) -> R<String> {
		let start = *i;
		let first = self.src.get(*i..).and_then(|s| s.chars().next());
		if !first.is_some_and(is_id_start) {
			return self.jsx_err(*i, "expected a JSX name");
		}
		loop {
			while let Some(c) = self.src.get(*i..).and_then(|s| s.chars().next()) {
				if is_id_part(c) || c == '-' {
					*i += c.len_utf8();
				} else {
					break;
				}
			}
			let sep = self.byte(*i);
			let next_starts_name = self
				.src
				.get(*i + 1..)
				.and_then(|s| s.chars().next())
				.is_some_and(is_id_start);
			if (sep == b'.' && allow_member || sep == b':') && next_starts_name {
				*i += 1;
			} else {
				break;
			}
		}
		Ok(self.src[start..*i].to_owned())
	}

	/// One element or fragment; `*i` is just after its `<`. Leaves `*i` after
	/// the closing `>`.
	fn jsx_element(&mut self, start: usize, i: &mut usize) -> R<JsxElement> {
		self.jsx_skip_trivia(i)?;
		let mut element = JsxElement {
			start,
			end: 0,
			tag: JsxTag::Fragment,
			attrs: Vec::new(),
			children: Vec::new(),
		};
		let mut name = String::new();
		if self.byte(*i) == b'>' {
			*i += 1;
		} else {
			let name_start = *i;
			name = self.jsx_name(i, true)?;
			element.tag = classify(&name);
			if matches!(element.tag, JsxTag::Component(_)) {
				// The first identifier of the name is a use of that binding.
				let first_end = name_start + name.find(['.', ':']).unwrap_or(name.len());
				self.refs.push((name_start, first_end));
			}
			self.jsx_skip_trivia(i)?;
			// TypeScript type arguments: `<Table<Row> rows={...} />`.
			if self.ts && self.byte(*i) == b'<' {
				self.lex.pos = *i;
				self.tok = self.lex.next()?;
				let s = self.tok.start;
				self.type_arguments_skip()?;
				self.erase(s, self.prev_end);
				*i = self.prev_end;
				self.jsx_skip_trivia(i)?;
			}
			// Attributes.
			let mut self_closing = false;
			loop {
				self.jsx_skip_trivia(i)?;
				match self.byte(*i) {
					b'>' => {
						*i += 1;
						break;
					}
					b'/' if self.byte(*i + 1) == b'>' => {
						*i += 2;
						self_closing = true;
						break;
					}
					b'/' => {
						*i += 1;
						self.jsx_skip_trivia(i)?;
						if self.byte(*i) != b'>' {
							return self.jsx_err(*i, "expected `>`");
						}
						*i += 1;
						self_closing = true;
						break;
					}
					b'{' => {
						let (start, end) = self.jsx_spread(i)?;
						element.attrs.push(JsxAttr::Spread { start, end });
					}
					0 => return self.jsx_err(start, "unterminated JSX element"),
					_ => {
						let attr = self.jsx_attribute(i)?;
						element.attrs.push(attr);
					}
				}
			}
			if self_closing {
				element.end = *i;
				return Ok(element);
			}
		}
		// Children up to the closing tag.
		self.jsx_children(i, &mut element.children)?;
		// `</` name? `>`
		*i += 2;
		self.jsx_skip_trivia(i)?;
		let close_start = *i;
		let close = if self.byte(*i) == b'>' {
			String::new()
		} else {
			self.jsx_name(i, true)?
		};
		if close != name {
			return self.jsx_err(
				close_start,
				format!("expected the closing tag `</{name}>`, found `</{close}>`",),
			);
		}
		self.jsx_skip_trivia(i)?;
		if self.byte(*i) != b'>' {
			return self.jsx_err(*i, "expected `>`");
		}
		*i += 1;
		element.end = *i;
		Ok(element)
	}

	/// `{...expression}` of an attribute; the range of the expression.
	fn jsx_spread(&mut self, i: &mut usize) -> R<(usize, usize)> {
		self.lex.pos = *i + 1;
		self.tok = self.lex.next()?;
		if !self.is_p("...") {
			return self.unexpected("`...`");
		}
		self.advance()?;
		let start = self.tok.start;
		self.jsx_expression_flags(|p| p.assign())?;
		let end = self.prev_end;
		if !self.is_p("}") {
			return self.unexpected("`}`");
		}
		*i = self.tok.end;
		Ok((start, end))
	}

	/// Parses with the flags of a fresh expression context.
	fn jsx_expression_flags(&mut self, f: impl FnOnce(&mut Self) -> R<()>) -> R<()> {
		let outer = (self.no_in, self.in_params, self.in_cond_true);
		self.no_in = false;
		self.in_params = false;
		self.in_cond_true = false;
		let r = f(self);
		(self.no_in, self.in_params, self.in_cond_true) = outer;
		r
	}

	fn jsx_attribute(&mut self, i: &mut usize) -> R<JsxAttr> {
		let name = self.jsx_name(i, false)?;
		self.jsx_skip_trivia(i)?;
		if self.byte(*i) != b'=' {
			return Ok(JsxAttr::True { name });
		}
		*i += 1;
		self.jsx_skip_trivia(i)?;
		match self.byte(*i) {
			q @ (b'"' | b'\'') => {
				let start = *i + 1;
				let mut j = start;
				while self.byte(j) != q {
					if j >= self.src.len() {
						return self.jsx_err(*i, "unterminated attribute string");
					}
					j += 1;
				}
				let value = decode_entities(&self.src[start..j]);
				*i = j + 1;
				Ok(JsxAttr::Str { name, value })
			}
			b'{' => {
				self.lex.pos = *i + 1;
				self.tok = self.lex.next()?;
				if self.is_p("}") {
					return self.err("an attribute value cannot be empty");
				}
				let start = self.tok.start;
				self.jsx_expression_flags(|p| p.expression())?;
				let end = self.prev_end;
				if !self.is_p("}") {
					return self.unexpected("`}`");
				}
				*i = self.tok.end;
				Ok(JsxAttr::Expr { name, start, end })
			}
			b'<' => {
				// An element as the value: `icon=<Icon />`.
				let start = *i;
				self.lex.pos = *i;
				self.tok = self.lex.next()?;
				self.jsx_root_in_place()?;
				let end = self.prev_end;
				*i = end;
				Ok(JsxAttr::Expr { name, start, end })
			}
			_ => self.jsx_err(*i, "expected an attribute value"),
		}
	}

	/// Like [`Self::jsx_root`], but leaves the parser where the element ends
	/// without reading the token after it.
	fn jsx_root_in_place(&mut self) -> R<()> {
		let start = self.tok.start;
		let mut i = self.tok.end;
		self.enter()?;
		let element = self.jsx_element(start, &mut i)?;
		self.leave();
		self.edits.push(Edit {
			start,
			end: i,
			kind: EditKind::Jsx(Box::new(element)),
		});
		self.prev_end = i;
		Ok(())
	}

	/// Text, `{expressions}` and nested elements until `</`.
	fn jsx_children(&mut self, i: &mut usize, out: &mut Vec<JsxChild>) -> R<()> {
		loop {
			let text_start = *i;
			while !matches!(self.byte(*i), b'{' | b'<') {
				if *i >= self.src.len() {
					return self.jsx_err(text_start, "unterminated JSX element");
				}
				*i += 1;
			}
			if *i > text_start
				&& let Some(text) = clean_text(&self.src[text_start..*i])
			{
				out.push(JsxChild::Text(text));
			}
			match self.byte(*i) {
				b'{' => {
					self.lex.pos = *i + 1;
					self.tok = self.lex.next()?;
					if self.is_p("}") {
						// `{}` or `{/* comment */}`: nothing.
						*i = self.tok.end;
						continue;
					}
					if self.is_p("...") {
						return self.err("spread children are not supported");
					}
					let start = self.tok.start;
					self.jsx_expression_flags(|p| p.expression())?;
					let end = self.prev_end;
					if !self.is_p("}") {
						return self.unexpected("`}`");
					}
					*i = self.tok.end;
					out.push(JsxChild::Expr { start, end });
				}
				_ => {
					// `<`: a closing tag or a nested element.
					let mut j = *i + 1;
					self.jsx_skip_trivia(&mut j)?;
					if self.byte(j) == b'/' {
						// Leave `*i` at `<` of `</`; the caller moves past it.
						return Ok(());
					}
					let start = *i;
					*i += 1;
					self.enter()?;
					let child = self.jsx_element(start, i)?;
					self.leave();
					out.push(JsxChild::Element(Box::new(child)));
				}
			}
		}
	}
}

/// Intrinsic (HTML) elements start with an ASCII lower-case letter and have
/// no member access; everything else is a component.
fn classify(name: &str) -> JsxTag {
	let intrinsic =
		name.as_bytes().first().is_some_and(u8::is_ascii_lowercase) && !name.contains('.');
	if intrinsic {
		JsxTag::Host(name.to_owned())
	} else {
		JsxTag::Component(name.to_owned())
	}
}

/// The text of a JSX child after JSX's white space rules: each line is
/// trimmed (the first line only at its end, the last only at its start),
/// empty lines vanish and the rest is joined with single spaces. `None` if
/// nothing is left.
fn clean_text(raw: &str) -> Option<String> {
	// Only spaces and tabs count as white space here (no-break spaces stay),
	// and character references are decoded afterwards: `&#10;` is a newline in
	// the text, not a line break to trim around. Tabs inside a line are kept.
	let is_blank = |c: char| c == ' ' || c == '\t';
	let normalized = raw.replace("\r\n", "\n");
	let lines: Vec<&str> = normalized.split('\n').collect();
	let last_non_empty = lines
		.iter()
		.rposition(|l| l.contains(|c: char| !is_blank(c)))
		.unwrap_or(0);
	let mut out = String::new();
	for (n, line) in lines.iter().enumerate() {
		let mut line = *line;
		if n != 0 {
			line = line.trim_start_matches(is_blank);
		}
		if n != lines.len() - 1 {
			line = line.trim_end_matches(is_blank);
		}
		if !line.is_empty() {
			out.push_str(line);
			if n != last_non_empty {
				out.push(' ');
			}
		}
	}
	if out.is_empty() {
		None
	} else {
		Some(decode_entities(&out))
	}
}

/// Decodes the character references of JSX text and attribute strings:
/// numeric ones, and the named ones JSX knows.
pub(crate) fn decode_entities(text: &str) -> String {
	if !text.contains('&') {
		return text.to_owned();
	}
	let mut out = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(at) = rest.find('&') {
		out.push_str(&rest[..at]);
		let after = &rest[at + 1..];
		let end = after
			.char_indices()
			.find(|&(_, c)| !c.is_ascii_alphanumeric() && c != '#')
			.map_or(after.len(), |(i, _)| i);
		let body = &after[..end];
		let decoded = if after[end..].starts_with(';') && !body.is_empty() {
			if let Some(num) = body.strip_prefix('#') {
				let code = num.strip_prefix(['x', 'X']).map_or_else(
					|| num.parse::<u32>().ok(),
					|h| u32::from_str_radix(h, 16).ok(),
				);
				code.and_then(char::from_u32).map(String::from)
			} else {
				jsx_entities::named(body).map(str::to_owned)
			}
		} else {
			None
		};
		match decoded {
			Some(d) => {
				out.push_str(&d);
				rest = &after[end + 1..];
			}
			None => {
				out.push('&');
				rest = after;
			}
		}
	}
	out.push_str(rest);
	out
}
