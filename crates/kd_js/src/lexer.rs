//! The tokenizer. It is driven by the parser: it never decides whether `/`
//! starts a regular expression (the parser asks for a re-scan where an
//! expression is expected), never splits `>>` for type arguments (the parser
//! re-scans there too) and never reads template literals or JSX on its own.
//! That keeps every context decision in the one place that knows the grammar.

use std::fmt;

/// What a token is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	Eof,
	/// An identifier or a keyword; the parser compares the text.
	Ident,
	/// `#name`.
	Private,
	Num,
	BigInt,
	Str,
	/// A punctuator; its text is in the token's `punct`.
	Punct,
	/// The opening backtick of a template literal.
	Backtick,
	/// A regular expression literal (only produced by [`Lexer::rescan_regex`]).
	Regex,
}

/// One token.
#[derive(Debug, Clone, Copy)]
pub struct Token {
	pub kind: Kind,
	pub start: usize,
	pub end: usize,
	/// A line terminator lies between the previous token and this one.
	pub nl_before: bool,
	/// The text of a punctuator, `""` for other kinds.
	pub punct: &'static str,
}

impl Token {
	pub const EOF: Token = Token {
		kind: Kind::Eof,
		start: 0,
		end: 0,
		nl_before: false,
		punct: "",
	};
}

/// A syntax error with the position it was found at.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
	pub message: String,
	pub offset: usize,
	pub line: usize,
	pub column: usize,
}

impl fmt::Display for SyntaxError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}:{}: {}", self.line, self.column, self.message)
	}
}

impl std::error::Error for SyntaxError {}

/// Line and column (both 1-based, columns in characters) of `offset`.
#[must_use]
pub fn position(src: &str, offset: usize) -> (usize, usize) {
	let upto = &src[..offset.min(src.len())];
	let line = upto.matches('\n').count() + 1;
	let column = upto.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
	(line, column)
}

pub struct Lexer<'s> {
	pub src: &'s str,
	bytes: &'s [u8],
	pub pos: usize,
}

const PUNCTS: [&str; 59] = [
	">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=",
	"<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
	"<<", ">>", "**", "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%",
	"&", "|", "^", "!", "~", "?", ":", "=", ".", "@", "\\",
];

pub fn is_id_start(c: char) -> bool {
	c == '$' || c == '_' || c.is_ascii_alphabetic() || (!c.is_ascii() && c.is_alphabetic())
}

pub fn is_id_part(c: char) -> bool {
	c == '$'
		|| c == '_'
		|| c.is_ascii_alphanumeric()
		|| c == '\u{200C}'
		|| c == '\u{200D}'
		|| (!c.is_ascii() && (c.is_alphanumeric() || is_combining(c)))
}

fn is_combining(c: char) -> bool {
	matches!(c as u32, 0x0300..=0x036F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE00..=0xFE0F | 0xFE20..=0xFE2F | 0x0900..=0x0903 | 0x093A..=0x094F | 0x3099..=0x309A)
}

fn is_line_terminator(c: char) -> bool {
	matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

fn is_js_space(c: char) -> bool {
	matches!(
		c,
		' ' | '\t' | '\u{0B}' | '\u{0C}' | '\u{A0}' | '\u{FEFF}' | '\u{1680}' | '\u{2000}'
			..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}'
	)
}

impl<'s> Lexer<'s> {
	#[must_use]
	pub fn new(src: &'s str) -> Lexer<'s> {
		let mut lexer = Lexer {
			src,
			bytes: src.as_bytes(),
			pos: 0,
		};
		// A hashbang is a comment on the first line.
		if src.starts_with("#!") {
			lexer.pos = src.find(['\n', '\r']).unwrap_or(src.len());
		}
		lexer
	}

	pub fn error(&self, offset: usize, message: impl Into<String>) -> SyntaxError {
		let (line, column) = position(self.src, offset);
		SyntaxError {
			message: message.into(),
			offset,
			line,
			column,
		}
	}

	fn char_at(&self, at: usize) -> Option<char> {
		self.src.get(at..)?.chars().next()
	}

	/// Skips white space and comments; whether a line terminator was seen.
	fn skip_trivia(&mut self) -> Result<bool, SyntaxError> {
		let mut newline = false;
		loop {
			let Some(&b) = self.bytes.get(self.pos) else {
				return Ok(newline);
			};
			match b {
				b' ' | b'\t' | 0x0B | 0x0C => self.pos += 1,
				b'\n' | b'\r' => {
					newline = true;
					self.pos += 1;
				}
				b'/' => match self.bytes.get(self.pos + 1) {
					Some(b'/') => {
						self.pos += 2;
						while let Some(c) = self.char_at(self.pos) {
							if is_line_terminator(c) {
								break;
							}
							self.pos += c.len_utf8();
						}
					}
					Some(b'*') => {
						let start = self.pos;
						self.pos += 2;
						loop {
							match self.bytes.get(self.pos) {
								None => return Err(self.error(start, "unterminated comment")),
								Some(b'*') if self.bytes.get(self.pos + 1) == Some(&b'/') => {
									self.pos += 2;
									break;
								}
								Some(_) => {
									let c = self.char_at(self.pos).unwrap_or(' ');
									if is_line_terminator(c) {
										newline = true;
									}
									self.pos += c.len_utf8();
								}
							}
						}
					}
					_ => return Ok(newline),
				},
				b if b >= 0x80 => {
					let c = self.char_at(self.pos).unwrap_or(' ');
					if is_js_space(c) {
						self.pos += c.len_utf8();
					} else if is_line_terminator(c) {
						newline = true;
						self.pos += c.len_utf8();
					} else {
						return Ok(newline);
					}
				}
				_ => return Ok(newline),
			}
		}
	}

	/// The next token.
	///
	/// # Errors
	///
	/// A [`SyntaxError`] for an unterminated string or comment, or a
	/// character that starts no token.
	#[allow(clippy::should_implement_trait)]
	pub fn next(&mut self) -> Result<Token, SyntaxError> {
		let nl_before = self.skip_trivia()?;
		let start = self.pos;
		let make = |kind, end, punct| Token {
			kind,
			start,
			end,
			nl_before,
			punct,
		};
		let Some(&b) = self.bytes.get(start) else {
			return Ok(make(Kind::Eof, start, ""));
		};
		match b {
			b'0'..=b'9' => return self.number(start, nl_before),
			b'.' if self.bytes.get(start + 1).is_some_and(u8::is_ascii_digit) => {
				return self.number(start, nl_before);
			}
			b'"' | b'\'' => {
				self.pos = self.string(start, b)?;
				return Ok(make(Kind::Str, self.pos, ""));
			}
			b'`' => {
				self.pos = start + 1;
				return Ok(make(Kind::Backtick, self.pos, ""));
			}
			b'#' => {
				let mut end = start + 1;
				let first = self.char_at(end);
				if first.is_some_and(is_id_start) {
					end = self.ident_end(end);
					self.pos = end;
					return Ok(make(Kind::Private, end, ""));
				}
				return Err(self.error(start, "unexpected `#`"));
			}
			_ => {}
		}
		if let Some(c) = self.char_at(start)
			&& (is_id_start(c) || c == '\\')
		{
			let end = self.ident_end(start);
			self.pos = end;
			return Ok(make(Kind::Ident, end, ""));
		}
		for p in PUNCTS {
			if self.src[start..].starts_with(p) {
				// `?.` followed by a digit is `?` then `.5`.
				if p == "?." && self.bytes.get(start + 2).is_some_and(u8::is_ascii_digit) {
					continue;
				}
				self.pos = start + p.len();
				return Ok(make(Kind::Punct, self.pos, p));
			}
		}
		Err(self.error(
			start,
			format!(
				"unexpected character {:?}",
				self.char_at(start).unwrap_or('\0')
			),
		))
	}

	fn ident_end(&self, from: usize) -> usize {
		let mut end = from;
		while let Some(c) = self.char_at(end) {
			if is_id_part(c) {
				end += c.len_utf8();
			} else if c == '\\' && self.bytes.get(end + 1) == Some(&b'u') {
				// `\uXXXX` or `\u{...}` in an identifier.
				end += 2;
				if self.bytes.get(end) == Some(&b'{') {
					while self.bytes.get(end).is_some_and(|&b| b != b'}') {
						end += 1;
					}
					end += 1;
				} else {
					end += 4;
				}
			} else {
				break;
			}
		}
		end.min(self.src.len())
	}

	fn number(&mut self, start: usize, nl_before: bool) -> Result<Token, SyntaxError> {
		let b = self.bytes;
		let mut i = start;
		let mut kind = Kind::Num;
		if b[i] == b'0' && matches!(b.get(i + 1), Some(b'x' | b'X' | b'o' | b'O' | b'b' | b'B')) {
			i += 2;
			while b
				.get(i)
				.is_some_and(|c| c.is_ascii_alphanumeric() || *c == b'_')
			{
				i += 1;
			}
			if b[i - 1] == b'n' {
				kind = Kind::BigInt;
			}
		} else {
			while b.get(i).is_some_and(|c| c.is_ascii_digit() || *c == b'_') {
				i += 1;
			}
			if b.get(i) == Some(&b'n') {
				i += 1;
				kind = Kind::BigInt;
			} else {
				if b.get(i) == Some(&b'.') {
					i += 1;
					while b.get(i).is_some_and(|c| c.is_ascii_digit() || *c == b'_') {
						i += 1;
					}
				}
				if matches!(b.get(i), Some(b'e' | b'E')) {
					let mut j = i + 1;
					if matches!(b.get(j), Some(b'+' | b'-')) {
						j += 1;
					}
					if b.get(j).is_some_and(u8::is_ascii_digit) {
						i = j;
						while b.get(i).is_some_and(|c| c.is_ascii_digit() || *c == b'_') {
							i += 1;
						}
					}
				}
			}
		}
		if self.char_at(i).is_some_and(is_id_start) {
			return Err(self.error(i, "an identifier cannot directly follow a number"));
		}
		self.pos = i;
		Ok(Token {
			kind,
			start,
			end: i,
			nl_before,
			punct: "",
		})
	}

	fn string(&self, start: usize, quote: u8) -> Result<usize, SyntaxError> {
		let mut i = start + 1;
		loop {
			match self.bytes.get(i) {
				None | Some(b'\n' | b'\r') => {
					return Err(self.error(start, "unterminated string"));
				}
				Some(b'\\') => {
					// An escaped line break (including CRLF) continues the string.
					i += 1;
					if self.bytes.get(i) == Some(&b'\r') && self.bytes.get(i + 1) == Some(&b'\n') {
						i += 1;
					}
					i += self.char_at(i).map_or(1, char::len_utf8);
				}
				Some(&c) if c == quote => return Ok(i + 1),
				Some(_) => i += self.char_at(i).map_or(1, char::len_utf8),
			}
		}
	}

	/// Re-scans the current `/` or `/=` token as a regular expression
	/// literal. `start` is the token's start.
	///
	/// # Errors
	///
	/// A [`SyntaxError`] for an unterminated literal.
	pub fn rescan_regex(&mut self, start: usize, nl_before: bool) -> Result<Token, SyntaxError> {
		let mut i = start + 1;
		let mut in_class = false;
		loop {
			let Some(c) = self.char_at(i) else {
				return Err(self.error(start, "unterminated regular expression"));
			};
			if is_line_terminator(c) {
				return Err(self.error(start, "unterminated regular expression"));
			}
			i += c.len_utf8();
			match c {
				'\\' => i += self.char_at(i).map_or(0, char::len_utf8),
				'[' => in_class = true,
				']' => in_class = false,
				'/' if !in_class => break,
				_ => {}
			}
		}
		while self.char_at(i).is_some_and(is_id_part) {
			i += self.char_at(i).map_or(1, char::len_utf8);
		}
		self.pos = i;
		Ok(Token {
			kind: Kind::Regex,
			start,
			end: i,
			nl_before,
			punct: "",
		})
	}

	/// Re-scans a token that starts with `>` as just `>` (so that `>>` in
	/// `Array<Array<T>>` closes one type argument list at a time).
	pub fn split_gt(&mut self, tok: Token) -> Token {
		self.pos = tok.start + 1;
		Token {
			kind: Kind::Punct,
			start: tok.start,
			end: tok.start + 1,
			nl_before: tok.nl_before,
			punct: ">",
		}
	}

	/// Scans one template chunk starting at `from` (just after a backtick or
	/// a `}`): the end of the chunk's text and whether it ended with `${`
	/// (`false`: with the closing backtick). `pos` is left after the
	/// terminator.
	///
	/// # Errors
	///
	/// A [`SyntaxError`] for an unterminated template.
	pub fn template_chunk(&mut self, from: usize) -> Result<(usize, bool), SyntaxError> {
		let mut i = from;
		loop {
			match self.bytes.get(i) {
				None => return Err(self.error(from, "unterminated template literal")),
				Some(b'\\') => {
					i += 1;
					i += self.char_at(i).map_or(1, char::len_utf8);
				}
				Some(b'`') => {
					self.pos = i + 1;
					return Ok((i, false));
				}
				Some(b'$') if self.bytes.get(i + 1) == Some(&b'{') => {
					self.pos = i + 2;
					return Ok((i, true));
				}
				Some(_) => i += self.char_at(i).map_or(1, char::len_utf8),
			}
		}
	}

	/// The text of a token.
	#[must_use]
	pub fn text(&self, tok: Token) -> &'s str {
		&self.src[tok.start..tok.end]
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tokens(src: &str) -> Vec<(Kind, String)> {
		let mut lexer = Lexer::new(src);
		let mut out = Vec::new();
		loop {
			let tok = lexer.next().unwrap();
			if tok.kind == Kind::Eof {
				return out;
			}
			out.push((tok.kind, lexer.text(tok).to_owned()));
		}
	}

	#[test]
	fn punctuators_are_matched_longest_first() {
		let t = tokens("a >>>= b ?? c ?.d ... =>");
		let texts: Vec<&str> = t.iter().map(|(_, s)| s.as_str()).collect();
		assert_eq!(texts, ["a", ">>>=", "b", "??", "c", "?.", "d", "...", "=>"]);
	}

	#[test]
	fn optional_chain_before_a_digit_is_a_conditional() {
		let texts: Vec<String> = tokens("a?.5:1").into_iter().map(|(_, s)| s).collect();
		assert_eq!(texts, ["a", "?", ".5", ":", "1"]);
	}

	#[test]
	fn numbers_strings_and_bigints() {
		let t = tokens("0x1F 1_000 .5e-3 10n 'a\\'b' \"c\"");
		let kinds: Vec<Kind> = t.iter().map(|(k, _)| *k).collect();
		assert_eq!(
			kinds,
			[
				Kind::Num,
				Kind::Num,
				Kind::Num,
				Kind::BigInt,
				Kind::Str,
				Kind::Str
			]
		);
	}

	#[test]
	fn comments_and_newlines_are_trivia_with_a_newline_flag() {
		let mut lexer = Lexer::new("a // x\n/* y\n */ b /* z */ c");
		let a = lexer.next().unwrap();
		let b = lexer.next().unwrap();
		let c = lexer.next().unwrap();
		assert!(!a.nl_before);
		assert!(b.nl_before);
		assert!(!c.nl_before);
	}

	#[test]
	fn a_slash_is_a_punctuator_until_the_parser_rescans_it() {
		let mut lexer = Lexer::new("/ab[/]c/gi.test");
		let slash = lexer.next().unwrap();
		assert_eq!(slash.punct, "/");
		let re = lexer.rescan_regex(slash.start, false).unwrap();
		assert_eq!(lexer.text(re), "/ab[/]c/gi");
	}

	#[test]
	fn template_chunks_stop_at_substitutions_and_the_closing_backtick() {
		let mut lexer = Lexer::new("`a${b}c`");
		let tick = lexer.next().unwrap();
		assert_eq!(tick.kind, Kind::Backtick);
		let (end, more) = lexer.template_chunk(tick.end).unwrap();
		assert_eq!((end, more), (2, true));
		let b = lexer.next().unwrap();
		assert_eq!(lexer.text(b), "b");
		let close = lexer.next().unwrap();
		assert_eq!(close.punct, "}");
		let (end, more) = lexer.template_chunk(close.end).unwrap();
		assert_eq!((end, more), (7, false));
	}

	#[test]
	fn errors_carry_a_line_and_column() {
		let mut lexer = Lexer::new("a\n  'oops");
		lexer.next().unwrap();
		let err = lexer.next().unwrap_err();
		assert_eq!((err.line, err.column), (2, 3));
	}

	#[test]
	fn unicode_identifiers_and_a_hashbang_are_accepted() {
		let t = tokens("#!/usr/bin/env node\nconst 変数 = 1;");
		assert_eq!(t[0].1, "const");
		assert_eq!(t[1].1, "変数");
	}
}
