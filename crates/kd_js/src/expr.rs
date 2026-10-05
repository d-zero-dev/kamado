//! Expressions.

use crate::lexer::Kind;
use crate::parser::{Parser, R, is_reserved};

/// Binary operator precedence (higher binds tighter); `None` for tokens that
/// are not binary operators.
fn binary_precedence(op: &str) -> Option<u8> {
	Some(match op {
		"??" => 1,
		"||" => 1,
		"&&" => 2,
		"|" => 3,
		"^" => 4,
		"&" => 5,
		"==" | "!=" | "===" | "!==" => 6,
		"<" | ">" | "<=" | ">=" => 7,
		"<<" | ">>" | ">>>" => 8,
		"+" | "-" => 9,
		"*" | "/" | "%" => 10,
		"**" => 11,
		_ => return None,
	})
}

const ASSIGNMENT: [&str; 16] = [
	"=", "+=", "-=", "*=", "/=", "%=", "**=", "<<=", ">>=", ">>>=", "&=", "|=", "^=", "&&=", "||=",
	"??=",
];

impl Parser<'_> {
	/// `a, b, c`
	pub(crate) fn expression(&mut self) -> R<()> {
		self.enter()?;
		loop {
			self.assign()?;
			if !self.eat_p(",")? {
				break;
			}
		}
		self.leave();
		Ok(())
	}

	/// An assignment expression (no comma operator).
	pub(crate) fn assign(&mut self) -> R<()> {
		self.enter()?;
		let r = self.assign_inner();
		self.leave();
		r
	}

	fn assign_inner(&mut self) -> R<()> {
		if self.arrow_function()? {
			return Ok(());
		}
		if self.is_kw("yield") {
			let next = self.peek()?;
			let ends = next.nl_before
				|| next.kind == Kind::Eof
				|| (next.kind == Kind::Punct
					&& matches!(next.punct, ")" | "]" | "}" | "," | ";" | ":"));
			self.advance()?;
			if !ends {
				self.eat_p("*")?;
				self.assign()?;
			}
			return Ok(());
		}
		self.conditional()?;
		if self.tok.kind == Kind::Punct && ASSIGNMENT.contains(&self.tok.punct) {
			self.advance()?;
			self.assign()?;
		}
		Ok(())
	}

	fn conditional(&mut self) -> R<()> {
		self.binary(0)?;
		if self.is_p("?") {
			self.advance()?;
			let outer = (self.in_cond_true, self.no_in);
			self.in_cond_true = true;
			self.no_in = false;
			self.assign()?;
			(self.in_cond_true, self.no_in) = outer;
			self.expect_p(":")?;
			self.assign()?;
		}
		Ok(())
	}

	fn binary(&mut self, min_prec: u8) -> R<()> {
		self.enter()?;
		self.unary_and_subscripts()?;
		loop {
			// TypeScript `as` and `satisfies`.
			if self.ts
				&& self.tok.kind == Kind::Ident
				&& !self.tok.nl_before
				&& matches!(self.cur(), "as" | "satisfies")
				&& 7 >= min_prec
			{
				let start = self.tok.start;
				self.advance()?;
				if self.is_kw("const") {
					self.advance()?;
				} else {
					self.skip_type()?;
				}
				self.erase(start, self.prev_end);
				continue;
			}
			let prec = match self.tok.kind {
				Kind::Punct => binary_precedence(self.tok.punct),
				Kind::Ident => match self.cur() {
					"instanceof" => Some(7),
					"in" if !self.no_in => Some(7),
					_ => None,
				},
				_ => None,
			};
			let Some(prec) = prec else { break };
			if prec < min_prec || (prec == min_prec && min_prec != 0 && self.tok.punct != "**") {
				// Left associative: the caller handles equal precedence.
				if prec < min_prec {
					break;
				}
				if prec == min_prec && self.tok.punct != "**" {
					break;
				}
			}
			let right_assoc = self.tok.punct == "**";
			self.advance()?;
			self.binary(if right_assoc { prec } else { prec + 1 })?;
		}
		self.leave();
		Ok(())
	}

	/// Prefix operators, the primary expression with its member / call
	/// chain, and postfix operators.
	pub(crate) fn unary_and_subscripts(&mut self) -> R<()> {
		self.enter()?;
		let r = self.unary_inner();
		self.leave();
		r
	}

	fn unary_inner(&mut self) -> R<()> {
		match self.tok.kind {
			Kind::Punct => match self.tok.punct {
				"!" | "~" | "+" | "-" | "++" | "--" => {
					self.advance()?;
					return self.unary_and_subscripts();
				}
				_ => {}
			},
			Kind::Ident => {
				if matches!(self.cur(), "typeof" | "void" | "delete" | "await") {
					self.advance()?;
					return self.unary_and_subscripts();
				}
			}
			_ => {}
		}
		self.primary()?;
		self.subscripts()?;
		if (self.is_p("++") || self.is_p("--")) && !self.tok.nl_before {
			self.advance()?;
		}
		Ok(())
	}

	/// Member accesses, calls, tagged templates, non-null assertions and
	/// call type arguments.
	fn subscripts(&mut self) -> R<()> {
		loop {
			match self.tok.kind {
				Kind::Punct => match self.tok.punct {
					"." => {
						self.advance()?;
						self.property_name()?;
					}
					"?." => {
						self.advance()?;
						if self.is_p("(") {
							self.arguments()?;
						} else if self.is_p("[") {
							self.advance()?;
							self.expression()?;
							self.expect_p("]")?;
						} else {
							self.property_name()?;
						}
					}
					"[" => {
						self.advance()?;
						let outer = self.no_in;
						self.no_in = false;
						self.expression()?;
						self.no_in = outer;
						self.expect_p("]")?;
					}
					"(" => self.arguments()?,
					"!" if self.ts && !self.tok.nl_before => {
						let (s, e) = (self.tok.start, self.tok.end);
						self.erase(s, e);
						self.advance()?;
					}
					"<" if self.ts => {
						let start = self.tok.start;
						let ok = self
							.attempt(|p| {
								p.type_arguments_skip()?;
								if p.is_p("(") || p.tok.kind == Kind::Backtick {
									Ok(())
								} else {
									p.err("not type arguments")
								}
							})
							.is_some();
						if !ok {
							break;
						}
						self.erase(start, self.prev_end);
					}
					_ => break,
				},
				Kind::Backtick => self.template()?,
				_ => break,
			}
		}
		Ok(())
	}

	fn arguments(&mut self) -> R<()> {
		self.expect_p("(")?;
		let outer = (self.no_in, self.in_params);
		self.no_in = false;
		self.in_params = false;
		while !self.is_p(")") {
			self.eat_p("...")?;
			self.assign()?;
			if !self.is_p(")") {
				self.expect_p(",")?;
			}
		}
		(self.no_in, self.in_params) = outer;
		self.advance()
	}

	pub(crate) fn primary(&mut self) -> R<()> {
		match self.tok.kind {
			Kind::Num | Kind::BigInt | Kind::Str | Kind::Private => self.advance(),
			Kind::Backtick => self.template(),
			Kind::Ident => self.primary_word(),
			Kind::Punct => match self.tok.punct {
				"(" => {
					self.advance()?;
					let outer = (self.no_in, self.in_params, self.in_cond_true);
					self.no_in = false;
					self.in_params = false;
					self.in_cond_true = false;
					self.expression()?;
					(self.no_in, self.in_params, self.in_cond_true) = outer;
					self.expect_p(")")
				}
				"[" => self.array_literal(),
				"{" => self.object_literal(),
				"/" | "/=" => {
					let tok = self.tok;
					let re = self.lex.rescan_regex(tok.start, tok.nl_before)?;
					self.tok = re;
					self.advance()
				}
				"<" => {
					if self.jsx {
						self.jsx_root()
					} else {
						self.err("unexpected `<` (type assertions are not supported; use `as`)")
					}
				}
				_ => self.unexpected("an expression"),
			},
			_ => self.unexpected("an expression"),
		}
	}

	fn primary_word(&mut self) -> R<()> {
		let word = self.cur();
		match word {
			"function" => {
				let had_body = self.function_rest(false)?;
				if !had_body {
					return self.err("a function expression needs a body");
				}
				Ok(())
			}
			"async" => {
				let next = self.peek()?;
				if next.kind == Kind::Ident && self.text(next) == "function" && !next.nl_before {
					self.advance()?;
					let had_body = self.function_rest(false)?;
					if !had_body {
						return self.err("a function expression needs a body");
					}
					Ok(())
				} else {
					self.identifier_reference()
				}
			}
			"class" => self.class(false),
			"new" => self.new_expression(),
			"this" | "null" | "true" | "false" | "super" => self.advance(),
			"import" => self.import_expression(),
			_ => self.identifier_reference(),
		}
	}

	fn identifier_reference(&mut self) -> R<()> {
		if is_reserved(self.cur()) && !matches!(self.cur(), "yield" | "await") {
			return self.unexpected("an expression");
		}
		let t = self.tok;
		self.push_ref(t);
		self.advance()
	}

	fn new_expression(&mut self) -> R<()> {
		self.advance()?;
		if self.is_p(".") {
			self.advance()?;
			return self.property_name();
		}
		// The callee: a primary with member accesses only.
		self.enter()?;
		if self.is_kw("new") {
			self.new_expression()?;
		} else {
			self.primary()?;
		}
		loop {
			if self.is_p(".") {
				self.advance()?;
				self.property_name()?;
			} else if self.is_p("[") {
				self.advance()?;
				self.expression()?;
				self.expect_p("]")?;
			} else {
				break;
			}
		}
		self.leave();
		if self.ts && self.is_p("<") {
			let start = self.tok.start;
			let ok = self
				.attempt(|p| {
					p.type_arguments_skip()?;
					if p.is_p("(") {
						Ok(())
					} else {
						p.err("not type arguments")
					}
				})
				.is_some();
			if ok {
				self.erase(start, self.prev_end);
			}
		}
		if self.is_p("(") {
			self.arguments()?;
		}
		Ok(())
	}

	fn import_expression(&mut self) -> R<()> {
		self.advance()?;
		if self.is_p(".") {
			self.advance()?;
			return self.property_name();
		}
		self.expect_p("(")?;
		let mut record = None;
		if self.tok.kind == Kind::Str {
			let next = self.peek()?;
			if next.kind == Kind::Punct && (next.punct == ")" || next.punct == ",") {
				let tok = self.tok;
				record = Some(self.imports.len());
				self.imports.push(crate::ast::ImportRecord {
					start: tok.start,
					end: tok.end,
					specifier: crate::strings::decode(self.text(tok)),
					kind: crate::ast::ImportKind::Dynamic,
					attributes: false,
				});
			}
		}
		self.assign()?;
		if self.eat_p(",")? && !self.is_p(")") {
			// The second argument holds the import attributes.
			if let Some(i) = record {
				self.imports[i].attributes = true;
			}
			self.assign()?;
			self.eat_p(",")?;
		}
		self.expect_p(")")
	}

	fn array_literal(&mut self) -> R<()> {
		self.expect_p("[")?;
		let outer = (self.no_in, self.in_params);
		self.no_in = false;
		self.in_params = false;
		while !self.is_p("]") {
			if self.is_p(",") {
				self.advance()?;
				continue;
			}
			self.eat_p("...")?;
			self.assign()?;
			if !self.is_p("]") {
				self.expect_p(",")?;
			}
		}
		(self.no_in, self.in_params) = outer;
		self.advance()
	}

	fn object_literal(&mut self) -> R<()> {
		self.expect_p("{")?;
		let outer = (self.no_in, self.in_params);
		self.no_in = false;
		self.in_params = false;
		while !self.is_p("}") {
			self.object_member()?;
			if !self.is_p("}") {
				self.expect_p(",")?;
			}
		}
		(self.no_in, self.in_params) = outer;
		self.advance()
	}

	fn object_member(&mut self) -> R<()> {
		if self.eat_p("...")? {
			return self.assign();
		}
		// Modifiers: `async`, `get`, `set`, `*`.
		let mut is_method = false;
		if self.tok.kind == Kind::Ident && matches!(self.cur(), "async" | "get" | "set") {
			let next = self.peek()?;
			let continues = match next.kind {
				Kind::Ident | Kind::Str | Kind::Num | Kind::BigInt | Kind::Private => {
					!(self.cur() == "async" && next.nl_before)
				}
				Kind::Punct => matches!(next.punct, "[" | "*"),
				_ => false,
			};
			if continues {
				self.advance()?;
				is_method = true;
			}
		}
		if self.eat_p("*")? {
			is_method = true;
		}
		let key = self.tok;
		if self.is_p("[") {
			self.advance()?;
			self.assign()?;
			self.expect_p("]")?;
		} else {
			self.property_name()?;
		}
		if self.is_p("(") || (self.ts && self.is_p("<")) {
			if !self.function_signature_and_body()? {
				return self.err("a method needs a body");
			}
			return Ok(());
		}
		if is_method {
			return self.unexpected("`(`");
		}
		if self.eat_p(":")? {
			return self.assign();
		}
		// Shorthand `{ a }` or with a default `{ a = 1 }` (destructuring).
		if key.kind != Kind::Ident {
			return self.unexpected("`:`");
		}
		self.push_ref(key);
		if self.eat_p("=")? {
			self.assign()?;
		}
		Ok(())
	}

	/// A template literal (current token is the opening backtick).
	pub(crate) fn template(&mut self) -> R<()> {
		let mut from = self.tok.end;
		loop {
			let (_end, more) = self.lex.template_chunk(from)?;
			if more {
				self.prev_end = self.lex.pos;
				self.tok = self.lex.next()?;
				let outer = (self.no_in, self.in_params, self.in_cond_true);
				self.no_in = false;
				self.in_params = false;
				self.in_cond_true = false;
				self.expression()?;
				(self.no_in, self.in_params, self.in_cond_true) = outer;
				if !self.is_p("}") {
					return self.unexpected("`}`");
				}
				from = self.tok.end;
			} else {
				self.prev_end = self.lex.pos;
				self.tok = self.lex.next()?;
				return Ok(());
			}
		}
	}

	// ----- arrow functions -----

	/// Parses an arrow function if one starts here; whether it did.
	fn arrow_function(&mut self) -> R<bool> {
		let is_async_word = self.is_kw("async");
		// `x => ...`, `async => ...`
		if self.tok.kind == Kind::Ident {
			let next = self.peek()?;
			if next.kind == Kind::Punct && next.punct == "=>" && !next.nl_before {
				if is_reserved(self.cur()) {
					return Ok(false);
				}
				self.advance()?;
				self.advance()?;
				self.arrow_body()?;
				return Ok(true);
			}
			// `async x => ...`
			if is_async_word
				&& next.kind == Kind::Ident
				&& !next.nl_before
				&& self.text(next) != "function"
				&& !is_reserved(self.text(next))
			{
				let ok = self
					.attempt(|p| {
						p.advance()?;
						p.advance()?;
						if !p.is_p("=>") {
							return p.unexpected("`=>`");
						}
						p.advance()?;
						p.arrow_body()
					})
					.is_some();
				return Ok(ok);
			}
		}
		let starts_params = self.is_p("(")
			|| (is_async_word && {
				let next = self.peek()?;
				next.kind == Kind::Punct
					&& (next.punct == "(" || (self.ts && next.punct == "<"))
					&& !next.nl_before
			}) || (self.ts && self.is_p("<") && self.looks_like_generic_arrow()?);
		if !starts_params || self.not_arrow.contains(&self.tok.start) {
			return Ok(false);
		}
		let start = self.tok.start;
		let ok = self
			.attempt(|p| {
				if p.is_kw("async") {
					p.advance()?;
				}
				if p.ts && p.is_p("<") {
					p.type_parameters()?;
				}
				p.params()?;
				let mut had_return_type = false;
				if p.ts && p.is_p(":") {
					let s = p.tok.start;
					p.advance()?;
					p.skip_return_type()?;
					p.erase(s, p.prev_end);
					had_return_type = true;
				}
				if !p.is_p("=>") || p.tok.nl_before {
					return p.unexpected("`=>`");
				}
				let cond = p.in_cond_true;
				p.advance()?;
				p.arrow_body()?;
				if had_return_type && cond && !p.is_p(":") {
					return p
						.err("an arrow function with a return type in a conditional needs `:`");
				}
				Ok(())
			})
			.is_some();
		if !ok {
			self.not_arrow.insert(start);
		}
		Ok(ok)
	}

	/// `<T,>(...)=>` or `<T extends U>(...)=>` (TSX needs the comma or the
	/// constraint to tell the type parameter from a JSX tag).
	fn looks_like_generic_arrow(&mut self) -> R<bool> {
		let save = self.snapshot();
		let result = (|| -> R<bool> {
			self.advance()?; // `<`
			if self.is_kw("const") {
				self.advance()?;
			}
			if self.tok.kind != Kind::Ident {
				return Ok(false);
			}
			self.advance()?;
			Ok(self.is_p(",") || self.is_kw("extends") || self.is_p("=") || !self.jsx)
		})();
		self.restore(save);
		result
	}

	fn arrow_body(&mut self) -> R<()> {
		if self.is_p("{") {
			let outer = (self.no_in, self.in_params, self.in_cond_true);
			self.no_in = false;
			self.in_params = false;
			self.in_cond_true = false;
			self.block()?;
			(self.no_in, self.in_params, self.in_cond_true) = outer;
			Ok(())
		} else {
			let outer = self.in_cond_true;
			self.in_cond_true = false;
			let r = self.assign();
			self.in_cond_true = outer;
			r
		}
	}
}
