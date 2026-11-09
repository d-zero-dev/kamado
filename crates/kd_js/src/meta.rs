//! `export const meta = { ... }`: the metadata of a page, read from the
//! source without running it. Only literals are accepted (strings, numbers,
//! booleans, `null`, arrays, objects, template literals without
//! substitutions, a leading `-` or `+` on a number); anything else is an
//! error with the position, because a value that needs evaluation would
//! need the page's JavaScript to run before the build can plan.

use crate::lexer::{Kind, Lexer, SyntaxError, Token};
use crate::parser::Parser;
use crate::strings;

/// A literal value of the metadata.
#[derive(Debug, Clone, PartialEq)]
pub enum Const {
	Null,
	Bool(bool),
	Num(f64),
	Str(String),
	Array(Vec<Const>),
	Object(Vec<(String, Const)>),
}

/// The `meta` of a module, if it exports one.
///
/// # Errors
///
/// A [`SyntaxError`] if the source does not parse, or if `meta` is not a
/// literal (naming the first part that is not).
///
/// # Example
///
/// ```
/// let src = "export const meta = { title: 'T', tags: ['a', 'b'], n: -1 } as const;\nexport default () => null;";
/// let meta = kd_js::extract_meta(src, false, true).unwrap().unwrap();
/// assert_eq!(
///     meta,
///     kd_js::Const::Object(vec![
///         ("title".to_owned(), kd_js::Const::Str("T".to_owned())),
///         (
///             "tags".to_owned(),
///             kd_js::Const::Array(vec![
///                 kd_js::Const::Str("a".to_owned()),
///                 kd_js::Const::Str("b".to_owned())
///             ])
///         ),
///         ("n".to_owned(), kd_js::Const::Num(-1.0)),
///     ])
/// );
/// ```
pub fn extract_meta(src: &str, jsx: bool, ts: bool) -> Result<Option<Const>, SyntaxError> {
	let parsed = Parser::parse(src, jsx, ts)?;
	let Some((start, end)) = parsed.info.meta else {
		return Ok(None);
	};
	let mut lex = Lexer::new(src);
	lex.pos = start;
	let tok = lex.next()?;
	let mut eval = Eval::new(lex, tok, end);
	let value = eval.value()?;
	// `as const` / `satisfies T` may follow: types are not evaluated.
	if !eval.at_end()
		&& !(eval.tok.kind == Kind::Ident && matches!(eval.text(), "as" | "satisfies"))
	{
		return eval.fail("only a literal can follow the value of `meta`");
	}
	Ok(Some(value))
}

/// One property of the `meta` object literal, as byte offsets into the
/// source (see [`locate_meta`]).
///
/// # Example
///
/// ```
/// use kd_js::MetaPlace;
/// let src = "export const meta = { a: 1, 'b-c': (2) };";
/// let MetaPlace::Object(layout) = kd_js::locate_meta(src, false, true).unwrap() else { panic!() };
/// let member = &layout.members[1];
/// assert_eq!(member.key, "b-c");
/// assert_eq!(&src[member.value_start..member.value_end], "(2)");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Member {
	/// The name of the property (a string key is decoded).
	pub key: String,
	pub key_start: usize,
	pub key_end: usize,
	/// The value, a parenthesis or a sign in front of it included.
	pub value_start: usize,
	pub value_end: usize,
	/// The `,` after the property, if any.
	pub comma: Option<usize>,
}

/// The `{ ... }` of `export const meta = { ... }` and where each of its properties is
/// (see [`locate_meta`]).
///
/// # Example
///
/// ```
/// use kd_js::MetaPlace;
/// let src = "export const meta = { a: 1 };";
/// let MetaPlace::Object(layout) = kd_js::locate_meta(src, false, true).unwrap() else { panic!() };
/// assert_eq!(&src[layout.open..=layout.open], "{");
/// assert_eq!(&src[layout.close..=layout.close], "}");
/// assert_eq!(layout.members.len(), 1);
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectLayout {
	/// The `{`.
	pub open: usize,
	/// The `}`.
	pub close: usize,
	pub members: Vec<Member>,
	/// Strings in the object are written more often with `'` than with `"`.
	pub prefers_single_quotes: bool,
}

/// Where the metadata of a module is (see [`locate_meta`]).
///
/// # Example
///
/// ```
/// use kd_js::MetaPlace;
/// let place = kd_js::locate_meta("import a from 'a';\nexport default a;\n", false, true).unwrap();
/// assert!(matches!(place, MetaPlace::Missing { after_import: true, .. }));
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MetaPlace {
	/// The module does not export `meta`. `insert_at` is where a declaration goes: after
	/// the last `import` statement, else after the directives (`'use strict'`) the module
	/// starts with, else before the first token, below a comment at the top, which may
	/// carry a pragma (`after_import` is true for the first two: something comes before
	/// the declaration, and a blank line separates them).
	Missing {
		insert_at: usize,
		after_import: bool,
	},
	/// `meta` is an object literal.
	Object(ObjectLayout),
	/// `meta` is a literal that is not an object (`null`, an array).
	NotAnObject,
}

/// The end of the `import` statement whose module specifier ends at `spec_end`: after its
/// import attributes (`with { type: "json" }`) and its `;`, if it has them.
fn import_end(src: &str, spec_end: usize) -> Result<usize, SyntaxError> {
	let mut lex = Lexer::new(src);
	lex.pos = spec_end;
	let mut tok = lex.next()?;
	let is = |t: Token, p: &str| t.kind == Kind::Punct && t.punct == p;
	if tok.kind == Kind::Ident && matches!(lex.text(tok), "with" | "assert") && !tok.nl_before {
		while tok.kind != Kind::Eof && !is(tok, "}") {
			tok = lex.next()?;
		}
		let mut end = tok.end;
		let after = lex.next()?;
		if is(after, ";") {
			end = after.end;
		}
		return Ok(end);
	}
	Ok(if is(tok, ";") { tok.end } else { spec_end })
}

/// The end of the directives (`'use strict';`) a module starts with, if it has any.
fn directives_end(src: &str) -> Result<Option<usize>, SyntaxError> {
	let mut lex = Lexer::new(src);
	let mut tok = lex.next()?;
	let mut end = None;
	while tok.kind == Kind::Str {
		let string = tok;
		let next = lex.next()?;
		let semicolon = next.kind == Kind::Punct && next.punct == ";";
		let statement_ends =
			semicolon || next.kind == Kind::Eof || (next.nl_before && next.kind != Kind::Punct);
		if !statement_ends {
			break;
		}
		end = Some(if semicolon { next.end } else { string.end });
		tok = if semicolon { lex.next()? } else { next };
	}
	Ok(end)
}

/// Where a declaration goes after the statement that ends at `end`: the start of the next
/// line if nothing but blanks or a `//` comment follows on the line, else right after the
/// statement (code or a block comment follows it on the line).
fn after_statement(src: &str, end: usize) -> usize {
	let line_end = src[end..].find('\n').map_or(src.len(), |i| end + i);
	let rest = src[end..line_end].trim_start_matches([' ', '\t']);
	if rest.is_empty() || rest == "\r" || rest.starts_with("//") {
		if line_end < src.len() {
			line_end + 1
		} else {
			line_end
		}
	} else {
		end
	}
}

/// Finds the metadata of a module in the source.
///
/// # Errors
///
/// A [`SyntaxError`] as for [`extract_meta`].
///
/// # Example
///
/// ```
/// use kd_js::MetaPlace;
/// let src = "export const meta = { title: 'T', n: 1 };\n";
/// let MetaPlace::Object(layout) = kd_js::locate_meta(src, false, true).unwrap() else { panic!() };
/// let m = &layout.members[1];
/// assert_eq!(&src[m.value_start..m.value_end], "1");
/// ```
pub fn locate_meta(src: &str, jsx: bool, ts: bool) -> Result<MetaPlace, SyntaxError> {
	let parsed = Parser::parse(src, jsx, ts)?;
	let Some((start, end)) = parsed.info.meta else {
		let last_import = parsed
			.imports
			.iter()
			.filter(|i| i.kind == crate::ast::ImportKind::Static)
			.map(|i| i.end)
			// the imports of types are no imports of the module, and are statements of the
			// head of it as much
			.chain(parsed.info.erased_imports.iter().map(|&(_, end)| end))
			.max();
		if let Some(at) = last_import {
			return Ok(MetaPlace::Missing {
				insert_at: after_statement(src, import_end(src, at)?),
				after_import: true,
			});
		}
		if let Some(at) = directives_end(src)? {
			return Ok(MetaPlace::Missing {
				insert_at: after_statement(src, at),
				after_import: true,
			});
		}
		let first = Lexer::new(src).next()?;
		let insert_at = if first.kind == Kind::Eof {
			src.len()
		} else {
			first.start
		};
		return Ok(MetaPlace::Missing {
			insert_at,
			after_import: false,
		});
	};
	let mut lex = Lexer::new(src);
	lex.pos = start;
	let tok = lex.next()?;
	let mut eval = Eval::new(lex, tok, end);
	while eval.is_p("(") {
		eval.advance()?;
	}
	if !eval.is_p("{") {
		// Anything else is checked (and its error reported) by the same rules
		// as extraction.
		eval.value()?;
		return Ok(MetaPlace::NotAnObject);
	}
	let layout = eval.object_layout()?;
	Ok(MetaPlace::Object(layout))
}

struct Eval<'s> {
	prev_end: usize,
	singles: usize,
	doubles: usize,
	lex: Lexer<'s>,
	tok: Token,
	end: usize,
}

type R<T> = Result<T, SyntaxError>;

impl<'s> Eval<'s> {
	fn new(lex: Lexer<'s>, tok: Token, end: usize) -> Eval<'s> {
		Eval {
			prev_end: 0,
			singles: 0,
			doubles: 0,
			lex,
			tok,
			end,
		}
	}

	/// Counts the quote a string token is written with, to follow the file's
	/// style when a string is added.
	fn count_quote(&mut self) {
		match self.lex.text(self.tok).as_bytes().first() {
			Some(b'\'') => self.singles += 1,
			Some(b'"') => self.doubles += 1,
			_ => {}
		}
	}

	fn text(&self) -> &str {
		self.lex.text(self.tok)
	}

	fn at_end(&self) -> bool {
		self.tok.kind == Kind::Eof || self.tok.start >= self.end
	}

	fn fail<T>(&self, message: &str) -> R<T> {
		Err(self.lex.error(
			self.tok.start,
			format!("`meta` must be a literal: {message}"),
		))
	}

	fn advance(&mut self) -> R<()> {
		self.prev_end = self.tok.end;
		self.tok = self.lex.next()?;
		Ok(())
	}

	fn is_p(&self, p: &str) -> bool {
		self.tok.kind == Kind::Punct && self.tok.punct == p && !self.at_end()
	}

	fn value(&mut self) -> R<Const> {
		if self.at_end() {
			return self.fail("a value is missing");
		}
		match self.tok.kind {
			Kind::Str => {
				self.count_quote();
				let s = strings::decode(self.text());
				self.advance()?;
				Ok(Const::Str(s))
			}
			Kind::Num => self.number(1.0),
			Kind::BigInt => self.fail("a BigInt cannot be stored as metadata"),
			Kind::Backtick => self.template(),
			Kind::Ident => match self.text() {
				"true" => {
					self.advance()?;
					Ok(Const::Bool(true))
				}
				"false" => {
					self.advance()?;
					Ok(Const::Bool(false))
				}
				"null" => {
					self.advance()?;
					Ok(Const::Null)
				}
				name => {
					let message = format!(
						"found `{name}`; write the value itself (a variable or a call would need the page to run)"
					);
					self.fail(&message)
				}
			},
			Kind::Punct => match self.tok.punct {
				"-" | "+" => {
					let sign = if self.tok.punct == "-" { -1.0 } else { 1.0 };
					self.advance()?;
					if self.tok.kind == Kind::Num {
						self.number(sign)
					} else {
						self.fail("a sign may only precede a number")
					}
				}
				"[" => self.array(),
				"{" => self.object(),
				"(" => {
					self.advance()?;
					let v = self.value()?;
					if !self.is_p(")") {
						return self.fail("expected `)`");
					}
					self.advance()?;
					Ok(v)
				}
				_ => self.fail("expected a string, number, boolean, null, array or object"),
			},
			_ => self.fail("expected a string, number, boolean, null, array or object"),
		}
	}

	fn number(&mut self, sign: f64) -> R<Const> {
		let raw: String = self.text().chars().filter(|c| *c != '_').collect();
		let parsed = if let Some(hex) = raw.strip_prefix("0x").or_else(|| raw.strip_prefix("0X")) {
			u64::from_str_radix(hex, 16).ok().map(|n| n as f64)
		} else if let Some(oct) = raw.strip_prefix("0o").or_else(|| raw.strip_prefix("0O")) {
			u64::from_str_radix(oct, 8).ok().map(|n| n as f64)
		} else if let Some(bin) = raw.strip_prefix("0b").or_else(|| raw.strip_prefix("0B")) {
			u64::from_str_radix(bin, 2).ok().map(|n| n as f64)
		} else {
			raw.parse::<f64>().ok()
		};
		let Some(n) = parsed else {
			return self.fail("this number is not valid");
		};
		self.advance()?;
		Ok(Const::Num(sign * n))
	}

	fn template(&mut self) -> R<Const> {
		let from = self.tok.end;
		let (end, more) = self.lex.template_chunk(from)?;
		if more {
			return self.fail("a template literal cannot contain `${}`");
		}
		let raw = &self.lex.src[from..end];
		let cooked = strings::decode(&format!("`{raw}`")).replace("\r\n", "\n");
		self.advance()?;
		// `advance` recorded the end of the opening backtick; the literal ends
		// after the closing one.
		self.prev_end = end + 1;
		Ok(Const::Str(cooked))
	}

	fn array(&mut self) -> R<Const> {
		self.advance()?;
		let mut items = Vec::new();
		while !self.is_p("]") {
			if self.is_p(",") {
				return self.fail("an array cannot have empty slots");
			}
			if self.is_p("...") {
				return self.fail("spread is not allowed");
			}
			items.push(self.value()?);
			if !self.is_p("]") {
				if !self.is_p(",") {
					return self.fail("expected `,` or `]`");
				}
				self.advance()?;
			}
		}
		self.advance()?;
		Ok(Const::Array(items))
	}

	fn object(&mut self) -> R<Const> {
		self.advance()?;
		let mut members: Vec<(String, Const)> = Vec::new();
		while !self.is_p("}") {
			if self.is_p("...") {
				return self.fail("spread is not allowed");
			}
			if self.is_p("[") {
				return self.fail("a computed key is not allowed");
			}
			let key = match self.tok.kind {
				Kind::Ident => {
					let k = self.text().to_owned();
					self.advance()?;
					k
				}
				Kind::Str => {
					let k = strings::decode(self.text());
					self.advance()?;
					k
				}
				Kind::Num => self.number_key()?,
				_ => return self.fail("expected a property name"),
			};
			if !self.is_p(":") {
				return self
					.fail("expected `:` (shorthand properties and methods are not allowed)");
			}
			self.advance()?;
			let value = self.value()?;
			// A repeated key keeps the last value, as in JavaScript.
			if let Some(existing) = members.iter_mut().find(|(k, _)| *k == key) {
				existing.1 = value;
			} else {
				members.push((key, value));
			}
			if !self.is_p("}") {
				if !self.is_p(",") {
					return self.fail("expected `,` or `}`");
				}
				self.advance()?;
			}
		}
		self.advance()?;
		Ok(Const::Object(members))
	}

	/// The same walk as [`Eval::object`], keeping where each property is. It is a second
	/// walk and not a flag of the first: extraction runs for every page of every build
	/// and must not pay for what only the editor needs, and the two have to be kept
	/// the same when the literals `meta` accepts change.
	fn object_layout(&mut self) -> R<ObjectLayout> {
		let open = self.tok.start;
		self.advance()?;
		let mut members: Vec<Member> = Vec::new();
		while !self.is_p("}") {
			if self.is_p("...") {
				return self.fail("spread is not allowed");
			}
			if self.is_p("[") {
				return self.fail("a computed key is not allowed");
			}
			let key_start = self.tok.start;
			let key = match self.tok.kind {
				Kind::Ident => {
					let k = self.text().to_owned();
					self.advance()?;
					k
				}
				Kind::Str => {
					self.count_quote();
					let k = strings::decode(self.text());
					self.advance()?;
					k
				}
				Kind::Num => self.number_key()?,
				_ => return self.fail("expected a property name"),
			};
			let key_end = self.prev_end;
			if !self.is_p(":") {
				return self
					.fail("expected `:` (shorthand properties and methods are not allowed)");
			}
			self.advance()?;
			let value_start = self.tok.start;
			self.value()?;
			let value_end = self.prev_end;
			let mut comma = None;
			if !self.is_p("}") {
				if !self.is_p(",") {
					return self.fail("expected `,` or `}`");
				}
				comma = Some(self.tok.start);
				self.advance()?;
			}
			members.push(Member {
				key,
				key_start,
				key_end,
				value_start,
				value_end,
				comma,
			});
		}
		let close = self.tok.start;
		Ok(ObjectLayout {
			open,
			close,
			members,
			prefers_single_quotes: self.singles > self.doubles,
		})
	}

	/// A numeric key (`{ 1: "a" }`) is the number's string form; the token
	/// is consumed here.
	fn number_key(&mut self) -> R<String> {
		let raw = self.text().to_owned();
		let Const::Num(n) = self.number(1.0)? else {
			return self.fail("expected a number");
		};
		Ok(if n.fract() == 0.0 && n.abs() < 1e15 {
			format!("{}", n as i64)
		} else {
			raw
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn meta(src: &str) -> Const {
		extract_meta(src, false, true).unwrap().unwrap()
	}

	fn error(src: &str) -> String {
		extract_meta(src, false, true).unwrap_err().to_string()
	}

	#[test]
	fn a_module_without_meta_has_none() {
		assert_eq!(
			extract_meta("export default 1;", false, true).unwrap(),
			None
		);
	}

	#[test]
	fn literals_nest_and_keys_may_be_quoted_or_numbers() {
		assert_eq!(
			meta(
				"export const meta = { 'a-b': [1, 2.5, -3, 0x10, 1_000], c: { d: null, e: true }, 7: 'x', f: `t\\n` };"
			),
			Const::Object(vec![
				(
					"a-b".to_owned(),
					Const::Array(vec![
						Const::Num(1.0),
						Const::Num(2.5),
						Const::Num(-3.0),
						Const::Num(16.0),
						Const::Num(1000.0)
					])
				),
				(
					"c".to_owned(),
					Const::Object(vec![
						("d".to_owned(), Const::Null),
						("e".to_owned(), Const::Bool(true))
					])
				),
				("7".to_owned(), Const::Str("x".to_owned())),
				("f".to_owned(), Const::Str("t\n".to_owned())),
			])
		);
	}

	#[test]
	fn a_repeated_key_keeps_the_last_value() {
		assert_eq!(
			meta("export const meta = { a: 1, a: 2 };"),
			Const::Object(vec![("a".to_owned(), Const::Num(2.0))])
		);
	}

	#[test]
	fn types_around_the_literal_are_allowed() {
		meta("export const meta: Meta = { a: 1 } as const;");
		meta("export const meta = { a: 1 } satisfies Meta;");
		meta("export const meta = ({ a: 1 });");
	}

	#[test]
	fn anything_that_needs_evaluation_is_an_error_with_a_position() {
		assert!(error("const t = 'x';\nexport const meta = { title: t };").starts_with("2:30:"));
		assert!(error("export const meta = { title: f() };").contains("found `f`"));
		assert!(error("export const meta = { ...base };").contains("spread is not allowed"));
		assert!(error("export const meta = { [k]: 1 };").contains("computed key"));
		assert!(error("export const meta = { a };").contains("shorthand"));
		assert!(
			error("export const meta = { m() {} };").contains("shorthand properties and methods")
		);
		assert!(error("export const meta = { a: `x${y}` };").contains("cannot contain"));
		assert!(error("export const meta = [1, , 2];").contains("empty slots"));
		assert!(error("export const meta = 1n;").contains("BigInt"));
	}

	#[test]
	fn a_syntax_error_in_the_module_is_reported_too() {
		assert!(error("export const meta = {").contains("expected"));
	}
}
