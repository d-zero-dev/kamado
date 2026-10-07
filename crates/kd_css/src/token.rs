//! A CSS Syntax Level 3 tokenizer.
//!
//! The tokens are lossless: they tile the input without gaps, so the source
//! slices of all tokens, concatenated, are the input again (comments and
//! white space are tokens too). That is what lets the parser copy anything it
//! does not understand through unchanged, and what lets a later source map
//! step map output back to input offsets.
//!
//! Differences from the specification text, none of which change what a
//! browser does with the result: the input is not preprocessed (a NUL stays a
//! NUL and counts as a name character, CR LF is two white space characters),
//! and token values are not decoded; a token only knows its byte range.

/// What a token is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
	/// One or more white space characters.
	Whitespace,
	/// `/* ... */`, closed or not.
	Comment,
	/// `foo`, `--foo`, `f\6f o`.
	Ident,
	/// `foo(`.
	Function,
	/// `@foo`.
	AtKeyword,
	/// `#foo`, `#fff`.
	Hash,
	/// `"..."` or `'...'`.
	String,
	/// A string cut short by an unescaped newline.
	BadString,
	/// `url(foo)` with an unquoted argument.
	Url,
	/// An unquoted `url(` whose argument is malformed.
	BadUrl,
	/// Any other single character.
	Delim,
	/// `12`, `-.5e3`.
	Number,
	/// `50%`.
	Percentage,
	/// `12px`.
	Dimension,
	/// `<!--`.
	Cdo,
	/// `-->`.
	Cdc,
	/// `:`.
	Colon,
	/// `;`.
	Semicolon,
	/// `,`.
	Comma,
	/// `[`.
	LBracket,
	/// `]`.
	RBracket,
	/// `(`.
	LParen,
	/// `)`.
	RParen,
	/// `{`.
	LBrace,
	/// `}`.
	RBrace,
}

/// A token: its kind and its byte range in the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
	pub kind: Kind,
	pub start: usize,
	pub end: usize,
}

impl Token {
	/// The source text of the token.
	///
	/// # Example
	///
	/// ```
	/// let src = "a{b:c}";
	/// let tokens = kd_css::token::tokenize(src);
	/// assert_eq!(tokens[0].text(src), "a");
	/// assert_eq!(tokens[1].text(src), "{");
	/// ```
	pub fn text<'a>(&self, source: &'a str) -> &'a str {
		&source[self.start..self.end]
	}
}

fn is_ws(b: u8) -> bool {
	matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c)
}

fn is_newline(b: u8) -> bool {
	matches!(b, b'\n' | b'\r' | 0x0c)
}

fn is_ident_start(b: u8) -> bool {
	b.is_ascii_alphabetic() || b == b'_' || b >= 0x80 || b == 0
}

fn is_name_char(b: u8) -> bool {
	is_ident_start(b) || b.is_ascii_digit() || b == b'-'
}

struct Lexer<'a> {
	b: &'a [u8],
	pos: usize,
}

impl Lexer<'_> {
	fn at(&self, i: usize) -> Option<u8> {
		self.b.get(i).copied()
	}

	/// A `\` at `i` that starts an escape (it is not followed by a newline).
	fn valid_escape(&self, i: usize) -> bool {
		self.at(i) == Some(b'\\') && !self.at(i + 1).is_some_and(is_newline)
	}

	/// Whether an identifier starts at `i`.
	fn starts_ident(&self, i: usize) -> bool {
		match self.at(i) {
			Some(b'-') => match self.at(i + 1) {
				Some(c) if is_ident_start(c) || c == b'-' => true,
				Some(b'\\') => self.valid_escape(i + 1),
				_ => false,
			},
			Some(b'\\') => self.valid_escape(i),
			Some(c) => is_ident_start(c),
			None => false,
		}
	}

	/// Whether a number starts at `i`.
	fn starts_number(&self, i: usize) -> bool {
		match self.at(i) {
			Some(b'+' | b'-') => match self.at(i + 1) {
				Some(c) if c.is_ascii_digit() => true,
				Some(b'.') => self.at(i + 2).is_some_and(|c| c.is_ascii_digit()),
				_ => false,
			},
			Some(b'.') => self.at(i + 1).is_some_and(|c| c.is_ascii_digit()),
			Some(c) => c.is_ascii_digit(),
			None => false,
		}
	}

	/// Consumes an escape whose backslash is at `pos`.
	fn escape(&mut self) {
		self.pos += 1;
		match self.at(self.pos) {
			None => {}
			Some(c) if c.is_ascii_hexdigit() => {
				let mut n = 0;
				while n < 6 && self.at(self.pos).is_some_and(|c| c.is_ascii_hexdigit()) {
					self.pos += 1;
					n += 1;
				}
				match self.at(self.pos) {
					Some(b'\r') if self.at(self.pos + 1) == Some(b'\n') => self.pos += 2,
					Some(c) if is_ws(c) => self.pos += 1,
					_ => {}
				}
			}
			Some(_) => self.char(),
		}
	}

	/// Advances over one whole character.
	fn char(&mut self) {
		self.pos += 1;
		while self.at(self.pos).is_some_and(|c| (0x80..0xc0).contains(&c)) {
			self.pos += 1;
		}
	}

	fn name(&mut self) {
		loop {
			match self.at(self.pos) {
				Some(c) if is_name_char(c) => self.pos += 1,
				Some(b'\\') if self.valid_escape(self.pos) => self.escape(),
				_ => break,
			}
		}
	}

	fn number(&mut self) {
		if matches!(self.at(self.pos), Some(b'+' | b'-')) {
			self.pos += 1;
		}
		while self.at(self.pos).is_some_and(|c| c.is_ascii_digit()) {
			self.pos += 1;
		}
		if self.at(self.pos) == Some(b'.')
			&& self.at(self.pos + 1).is_some_and(|c| c.is_ascii_digit())
		{
			self.pos += 1;
			while self.at(self.pos).is_some_and(|c| c.is_ascii_digit()) {
				self.pos += 1;
			}
		}
		if matches!(self.at(self.pos), Some(b'e' | b'E')) {
			let sign = matches!(self.at(self.pos + 1), Some(b'+' | b'-'));
			let d = self.pos + 1 + usize::from(sign);
			if self.at(d).is_some_and(|c| c.is_ascii_digit()) {
				self.pos = d;
				while self.at(self.pos).is_some_and(|c| c.is_ascii_digit()) {
					self.pos += 1;
				}
			}
		}
	}

	fn string(&mut self, quote: u8) -> Kind {
		self.pos += 1;
		loop {
			match self.at(self.pos) {
				None => return Kind::String,
				Some(c) if c == quote => {
					self.pos += 1;
					return Kind::String;
				}
				Some(b'\n' | b'\r' | 0x0c) => return Kind::BadString,
				Some(b'\\') => match self.at(self.pos + 1) {
					None => self.pos += 1,
					Some(b'\r') if self.at(self.pos + 2) == Some(b'\n') => self.pos += 3,
					Some(b'\n' | b'\r' | 0x0c) => self.pos += 2,
					Some(_) => self.escape(),
				},
				Some(_) => self.pos += 1,
			}
		}
	}

	/// After `url(`: an unquoted URL, or a function when it is quoted.
	fn url(&mut self) -> Kind {
		// `self.pos` is just after the `(`.
		let mut i = self.pos;
		while self.at(i).is_some_and(is_ws) {
			i += 1;
		}
		if matches!(self.at(i), Some(b'"' | b'\'')) {
			return Kind::Function;
		}
		self.pos = i;
		loop {
			match self.at(self.pos) {
				None => return Kind::Url,
				Some(b')') => {
					self.pos += 1;
					return Kind::Url;
				}
				Some(c) if is_ws(c) => {
					while self.at(self.pos).is_some_and(is_ws) {
						self.pos += 1;
					}
					match self.at(self.pos) {
						None => return Kind::Url,
						Some(b')') => {
							self.pos += 1;
							return Kind::Url;
						}
						Some(_) => {
							self.bad_url();
							return Kind::BadUrl;
						}
					}
				}
				Some(b'"' | b'\'' | b'(') => {
					self.bad_url();
					return Kind::BadUrl;
				}
				Some(c) if c < 0x09 || c == 0x0b || (0x0e..0x20).contains(&c) || c == 0x7f => {
					self.bad_url();
					return Kind::BadUrl;
				}
				Some(b'\\') => {
					if self.valid_escape(self.pos) {
						self.escape();
					} else {
						self.bad_url();
						return Kind::BadUrl;
					}
				}
				Some(_) => self.pos += 1,
			}
		}
	}

	fn bad_url(&mut self) {
		loop {
			match self.at(self.pos) {
				None => return,
				Some(b')') => {
					self.pos += 1;
					return;
				}
				Some(b'\\') if self.valid_escape(self.pos) => self.escape(),
				Some(_) => self.pos += 1,
			}
		}
	}

	fn next(&mut self) -> Token {
		let start = self.pos;
		let c = self.b[start];
		let kind = match c {
			c if is_ws(c) => {
				while self.at(self.pos).is_some_and(is_ws) {
					self.pos += 1;
				}
				Kind::Whitespace
			}
			b'/' if self.at(start + 1) == Some(b'*') => {
				self.pos += 2;
				loop {
					match self.at(self.pos) {
						None => break,
						Some(b'*') if self.at(self.pos + 1) == Some(b'/') => {
							self.pos += 2;
							break;
						}
						Some(_) => self.pos += 1,
					}
				}
				Kind::Comment
			}
			b'"' | b'\'' => self.string(c),
			b'#' => {
				if self.at(start + 1).is_some_and(is_name_char) || self.valid_escape(start + 1) {
					self.pos += 1;
					self.name();
					Kind::Hash
				} else {
					self.pos += 1;
					Kind::Delim
				}
			}
			b'(' => {
				self.pos += 1;
				Kind::LParen
			}
			b')' => {
				self.pos += 1;
				Kind::RParen
			}
			b',' => {
				self.pos += 1;
				Kind::Comma
			}
			b':' => {
				self.pos += 1;
				Kind::Colon
			}
			b';' => {
				self.pos += 1;
				Kind::Semicolon
			}
			b'[' => {
				self.pos += 1;
				Kind::LBracket
			}
			b']' => {
				self.pos += 1;
				Kind::RBracket
			}
			b'{' => {
				self.pos += 1;
				Kind::LBrace
			}
			b'}' => {
				self.pos += 1;
				Kind::RBrace
			}
			b'+' | b'.' | b'-' if self.starts_number(start) => self.numeric(),
			b'-' if self.at(start + 1) == Some(b'-') && self.at(start + 2) == Some(b'>') => {
				self.pos += 3;
				Kind::Cdc
			}
			b'<' if self.b[start..].starts_with(b"<!--") => {
				self.pos += 4;
				Kind::Cdo
			}
			b'@' => {
				if self.starts_ident(start + 1) {
					self.pos += 1;
					self.name();
					Kind::AtKeyword
				} else {
					self.pos += 1;
					Kind::Delim
				}
			}
			c if c.is_ascii_digit() => self.numeric(),
			b'\\' if self.valid_escape(start) => self.ident_like(),
			c if is_ident_start(c) => self.ident_like(),
			b'-' if self.starts_ident(start) => self.ident_like(),
			_ => {
				self.char();
				Kind::Delim
			}
		};
		Token {
			kind,
			start,
			end: self.pos,
		}
	}

	fn numeric(&mut self) -> Kind {
		self.number();
		if self.starts_ident(self.pos) {
			self.name();
			Kind::Dimension
		} else if self.at(self.pos) == Some(b'%') {
			self.pos += 1;
			Kind::Percentage
		} else {
			Kind::Number
		}
	}

	fn ident_like(&mut self) -> Kind {
		let start = self.pos;
		self.name();
		if self.at(self.pos) == Some(b'(') {
			let is_url = self.b[start..self.pos].eq_ignore_ascii_case(b"url");
			self.pos += 1;
			if is_url { self.url() } else { Kind::Function }
		} else {
			Kind::Ident
		}
	}
}

/// Splits a style sheet into tokens.
///
/// # Example
///
/// ```
/// use kd_css::token::{tokenize, Kind};
///
/// let src = "a { color: #fff } /* x */";
/// let tokens = tokenize(src);
/// let kinds: Vec<Kind> = tokens.iter().map(|t| t.kind).collect();
/// assert_eq!(kinds[0], Kind::Ident);
/// assert_eq!(kinds[2], Kind::LBrace);
/// // Lossless: the slices rebuild the input.
/// let rebuilt: String = tokens.iter().map(|t| t.text(src)).collect();
/// assert_eq!(rebuilt, src);
/// ```
pub fn tokenize(source: &str) -> Vec<Token> {
	let mut lexer = Lexer {
		b: source.as_bytes(),
		pos: 0,
	};
	let mut tokens = Vec::with_capacity(source.len() / 4 + 4);
	while lexer.pos < lexer.b.len() {
		tokens.push(lexer.next());
	}
	tokens
}
