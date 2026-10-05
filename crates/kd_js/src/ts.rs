//! TypeScript type syntax. Types are parsed only to find where they end;
//! the callers erase the range.

use crate::lexer::Kind;
use crate::parser::{Parser, R};

impl Parser<'_> {
	/// Consumes `>` where a type argument or parameter list closes; a token
	/// such as `>>` or `>=` is split.
	fn expect_gt(&mut self) -> R<()> {
		if self.tok.kind == Kind::Punct && self.tok.punct.starts_with('>') {
			if self.tok.punct != ">" {
				let t = self.lex.split_gt(self.tok);
				self.tok = t;
			}
			self.advance()
		} else {
			self.unexpected("`>`")
		}
	}

	/// `<T, U extends V = W>` on a declaration: erased.
	pub(crate) fn type_parameters(&mut self) -> R<()> {
		let start = self.tok.start;
		self.type_parameters_skip()?;
		self.erase(start, self.prev_end);
		Ok(())
	}

	/// The same, for use inside syntax that is erased as a whole.
	pub(crate) fn type_parameters_skip(&mut self) -> R<()> {
		self.expect_p("<")?;
		while !self.is_gt() {
			while self.tok.kind == Kind::Ident && matches!(self.cur(), "const" | "in" | "out") {
				let next = self.peek()?;
				if next.kind == Kind::Ident {
					self.advance()?;
				} else {
					break;
				}
			}
			self.binding_ident()?;
			if self.eat_kw("extends")? {
				self.skip_type()?;
			}
			if self.eat_p("=")? {
				self.skip_type()?;
			}
			if !self.is_gt() {
				self.expect_p(",")?;
			}
		}
		self.expect_gt()
	}

	fn is_gt(&self) -> bool {
		self.tok.kind == Kind::Punct && self.tok.punct.starts_with('>')
	}

	/// `<A, B>` on a reference: skipped, not erased by itself.
	pub(crate) fn type_arguments_skip(&mut self) -> R<()> {
		self.expect_p("<")?;
		while !self.is_gt() {
			self.skip_type()?;
			if !self.is_gt() {
				self.expect_p(",")?;
			}
		}
		self.expect_gt()
	}

	/// A return type, which may also be a type predicate.
	pub(crate) fn skip_return_type(&mut self) -> R<()> {
		if self.is_kw("asserts") {
			let next = self.peek()?;
			if next.kind == Kind::Ident && !next.nl_before {
				self.advance()?;
				self.advance()?; // the parameter (or `this`)
				if self.is_kw("is") && !self.tok.nl_before {
					self.advance()?;
					self.skip_type()?;
				}
				return Ok(());
			}
		}
		if self.tok.kind == Kind::Ident {
			let next = self.peek()?;
			if next.kind == Kind::Ident && self.text(next) == "is" && !next.nl_before {
				self.advance()?;
				self.advance()?;
				return self.skip_type();
			}
		}
		self.skip_type()
	}

	/// A full type, conditional types included.
	pub(crate) fn skip_type(&mut self) -> R<()> {
		self.enter()?;
		// A nested type (parentheses, arguments, members) is a fresh context.
		let outer = std::mem::replace(&mut self.no_cond, false);
		let r = self.type_inner(true);
		self.no_cond = outer;
		self.leave();
		r
	}

	fn type_inner(&mut self, allow_conditional: bool) -> R<()> {
		if self.starts_function_type()? {
			return Ok(());
		}
		self.union_type()?;
		if allow_conditional && self.is_kw("extends") && !self.tok.nl_before {
			self.advance()?;
			let outer = std::mem::replace(&mut self.no_cond, true);
			let r = self.type_inner(false);
			self.no_cond = outer;
			r?;
			self.expect_p("?")?;
			self.skip_type()?;
			self.expect_p(":")?;
			self.skip_type()?;
		}
		Ok(())
	}

	/// A function or constructor type, if one starts here (and it is then
	/// consumed entirely).
	fn starts_function_type(&mut self) -> R<bool> {
		let is_new = self.is_kw("new")
			|| (self.is_kw("abstract") && {
				let next = self.peek()?;
				next.kind == Kind::Ident && self.text(next) == "new"
			});
		if !(self.is_p("(") || self.is_p("<") || is_new) {
			return Ok(false);
		}
		let ok = self
			.attempt(|p| {
				if p.is_kw("abstract") {
					p.advance()?;
				}
				if p.is_kw("new") {
					p.advance()?;
				}
				if p.is_p("<") {
					p.type_parameters_skip()?;
				}
				p.params()?;
				p.expect_p("=>")?;
				p.skip_return_type()
			})
			.is_some();
		Ok(ok)
	}

	fn union_type(&mut self) -> R<()> {
		self.eat_p("|")?;
		self.intersection_type()?;
		while self.is_p("|") {
			self.advance()?;
			self.intersection_type()?;
		}
		Ok(())
	}

	fn intersection_type(&mut self) -> R<()> {
		self.eat_p("&")?;
		self.type_operator()?;
		while self.is_p("&") {
			self.advance()?;
			self.type_operator()?;
		}
		Ok(())
	}

	fn type_operator(&mut self) -> R<()> {
		if self.tok.kind == Kind::Ident {
			match self.cur() {
				"keyof" | "readonly" => {
					let next = self.peek()?;
					// `keyof` as a type name is not worth supporting.
					if !(next.kind == Kind::Punct
						&& matches!(next.punct, "," | ">" | ")" | ";" | "=" | "|" | "&"))
					{
						self.advance()?;
						return self.type_operator();
					}
				}
				"unique" => {
					let next = self.peek()?;
					if next.kind == Kind::Ident {
						self.advance()?;
						return self.type_operator();
					}
				}
				"infer" => {
					self.advance()?;
					self.binding_ident()?;
					// `infer U extends C` (only when it is not the `extends` of
					// an enclosing conditional type).
					if self.is_kw("extends") {
						// In the `extends` clause of a conditional type the constraint is
						// always taken; elsewhere only when no `?` follows (then the
						// `extends` belongs to an enclosing conditional type).
						let in_extends_clause = self.no_cond;
						let _ = self.attempt(|p| {
							p.advance()?;
							let outer = std::mem::replace(&mut p.no_cond, true);
							let r = p.type_inner(false);
							p.no_cond = outer;
							r?;
							if !in_extends_clause && p.is_p("?") {
								p.err("that was the conditional")
							} else {
								Ok(())
							}
						});
					}
					return self.postfix_suffix();
				}
				_ => {}
			}
		}
		self.postfix_type()
	}

	fn postfix_type(&mut self) -> R<()> {
		self.primary_type()?;
		self.postfix_suffix()
	}

	fn postfix_suffix(&mut self) -> R<()> {
		while self.is_p("[") && !self.tok.nl_before {
			self.advance()?;
			if !self.is_p("]") {
				self.skip_type()?;
			}
			self.expect_p("]")?;
		}
		Ok(())
	}

	fn primary_type(&mut self) -> R<()> {
		match self.tok.kind {
			Kind::Str | Kind::Num | Kind::BigInt => self.advance(),
			Kind::Backtick => self.template_type(),
			Kind::Punct => match self.tok.punct {
				"(" => {
					self.advance()?;
					self.skip_type()?;
					self.expect_p(")")
				}
				"[" => self.tuple_type(),
				"{" => self.object_type(),
				"-" => {
					self.advance()?;
					if matches!(self.tok.kind, Kind::Num | Kind::BigInt) {
						self.advance()
					} else {
						self.unexpected("a number")
					}
				}
				_ => self.unexpected("a type"),
			},
			Kind::Ident => {
				match self.cur() {
					"typeof" => {
						self.advance()?;
						if self.is_kw("import") {
							return self.import_type();
						}
						self.qualified_name()?;
						if self.is_p("<") && !self.tok.nl_before {
							self.type_arguments_skip()?;
						}
						return Ok(());
					}
					"import" => return self.import_type(),
					_ => {}
				}
				self.qualified_name()?;
				if self.is_p("<") && !self.tok.nl_before {
					self.type_arguments_skip()?;
				}
				Ok(())
			}
			_ => self.unexpected("a type"),
		}
	}

	/// `a.b.c`
	fn qualified_name(&mut self) -> R<()> {
		if self.tok.kind != Kind::Ident {
			return self.unexpected("a type name");
		}
		self.advance()?;
		while self.is_p(".") {
			self.advance()?;
			if self.tok.kind != Kind::Ident {
				return self.unexpected("a name");
			}
			self.advance()?;
		}
		Ok(())
	}

	/// `import("x").A.B<T>`
	fn import_type(&mut self) -> R<()> {
		self.advance()?;
		self.expect_p("(")?;
		if self.tok.kind != Kind::Str {
			return self.unexpected("a string");
		}
		self.advance()?;
		if self.eat_p(",")? && !self.is_p(")") {
			self.object_literal_skip()?;
			self.eat_p(",")?;
		}
		self.expect_p(")")?;
		while self.is_p(".") {
			self.advance()?;
			self.advance()?;
		}
		if self.is_p("<") && !self.tok.nl_before {
			self.type_arguments_skip()?;
		}
		Ok(())
	}

	/// `{ with: { "resolution-mode": "import" } }` inside `import()` types.
	fn object_literal_skip(&mut self) -> R<()> {
		self.expect_p("{")?;
		let mut depth = 1usize;
		while depth > 0 {
			if self.tok.kind == Kind::Eof {
				return self.unexpected("`}`");
			}
			if self.is_p("{") {
				depth += 1;
			} else if self.is_p("}") {
				depth -= 1;
			}
			self.advance()?;
		}
		Ok(())
	}

	fn template_type(&mut self) -> R<()> {
		let mut from = self.tok.end;
		loop {
			let (_end, more) = self.lex.template_chunk(from)?;
			if more {
				self.prev_end = self.lex.pos;
				self.tok = self.lex.next()?;
				self.skip_type()?;
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

	fn tuple_type(&mut self) -> R<()> {
		self.expect_p("[")?;
		while !self.is_p("]") {
			self.eat_p("...")?;
			// A labelled member: `name: T` or `name?: T`.
			if self.tok.kind == Kind::Ident {
				let next = self.peek()?;
				let labelled = next.kind == Kind::Punct && next.punct == ":";
				let optional_labelled = next.kind == Kind::Punct && next.punct == "?" && {
					let save = self.snapshot();
					self.advance()?;
					self.advance()?;
					let after = self.tok;
					self.restore(save);
					after.kind == Kind::Punct && after.punct == ":"
				};
				if labelled {
					self.advance()?;
					self.advance()?;
				} else if optional_labelled {
					self.advance()?;
					self.advance()?;
					self.advance()?;
				}
			}
			self.skip_type()?;
			self.eat_p("?")?;
			if !self.is_p("]") {
				self.expect_p(",")?;
			}
		}
		self.advance()
	}

	/// `{ a: T; b?(): U; [k: string]: V; readonly c: W }`, also mapped types.
	pub(crate) fn object_type(&mut self) -> R<()> {
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.tok.kind == Kind::Eof {
				return self.unexpected("`}`");
			}
			self.type_member()?;
			if self.is_p(";") || self.is_p(",") {
				self.advance()?;
			} else if !self.is_p("}") && !self.tok.nl_before {
				return self.unexpected("`;` or `}`");
			}
		}
		self.advance()
	}

	fn type_member(&mut self) -> R<()> {
		// `readonly`, `+readonly`, `-readonly`
		if (self.is_p("+") || self.is_p("-")) && {
			let next = self.peek()?;
			next.kind == Kind::Ident && self.text(next) == "readonly"
		} {
			self.advance()?;
			self.advance()?;
		} else if self.is_kw("readonly") {
			let next = self.peek()?;
			let is_mod = matches!(next.kind, Kind::Ident | Kind::Str | Kind::Num)
				|| (next.kind == Kind::Punct && next.punct == "[");
			if is_mod {
				self.advance()?;
			}
		}
		// Call and construct signatures.
		if self.is_p("(") || self.is_p("<") {
			return self.signature_rest();
		}
		if self.is_kw("new") {
			let next = self.peek()?;
			if next.kind == Kind::Punct && (next.punct == "(" || next.punct == "<") {
				self.advance()?;
				return self.signature_rest();
			}
		}
		// `get x(): T` / `set x(v: T)`
		if (self.is_kw("get") || self.is_kw("set")) && {
			let next = self.peek()?;
			matches!(next.kind, Kind::Ident | Kind::Str | Kind::Num)
		} {
			self.advance()?;
		}
		if self.is_p("[") {
			// Index signature or mapped type: `[k: string]: T`, `[K in T as U]: V`,
			// or a computed key.
			self.advance()?;
			let is_index = self.tok.kind == Kind::Ident && {
				let next = self.peek()?;
				next.kind == Kind::Punct && next.punct == ":"
					|| (next.kind == Kind::Ident && self.text(next) == "in")
			};
			if is_index {
				self.advance()?;
				if self.eat_p(":")? {
					self.skip_type()?;
				} else {
					self.expect_kw("in")?;
					self.skip_type()?;
					if self.eat_kw("as")? {
						self.skip_type()?;
					}
				}
				self.expect_p("]")?;
			} else {
				self.assign()?;
				self.expect_p("]")?;
			}
			if self.is_p("+") || self.is_p("-") {
				self.advance()?;
			}
			self.eat_p("?")?;
			if self.is_p("(") || self.is_p("<") {
				return self.signature_rest();
			}
			if self.eat_p(":")? {
				self.skip_type()?;
			}
			return Ok(());
		}
		match self.tok.kind {
			Kind::Ident | Kind::Str | Kind::Num | Kind::BigInt => self.advance()?,
			_ => return self.unexpected("a member name"),
		}
		self.eat_p("?")?;
		if self.is_p("(") || self.is_p("<") {
			return self.signature_rest();
		}
		if self.eat_p(":")? {
			self.skip_type()?;
		}
		Ok(())
	}

	/// `<T>(params): R` of a signature.
	fn signature_rest(&mut self) -> R<()> {
		if self.is_p("<") {
			self.type_parameters_skip()?;
		}
		self.params()?;
		if self.eat_p(":")? {
			self.skip_return_type()?;
		}
		Ok(())
	}
}
