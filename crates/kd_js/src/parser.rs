//! The parser: statements, modules, functions, classes and patterns. It
//! walks JavaScript and TypeScript (with JSX) completely, because the only
//! reliable way to find where JSX starts and where a type annotation ends is
//! to follow the grammar, but it builds no tree (see `ast`).
//!
//! Expressions are in `expr`, type syntax in `ts`, JSX in `jsx`.

use std::collections::HashSet;

use crate::ast::{Edit, EditKind, ImportBinding, ImportDecl, ImportKind, ImportRecord, ModuleInfo};
use crate::lexer::{Kind, Lexer, SyntaxError, Token};

pub(crate) type R<T> = Result<T, SyntaxError>;

/// How deeply nested the source may be; deeper input is an error rather than
/// a stack overflow.
pub(crate) const MAX_DEPTH: usize = 300;

const RESERVED: [&str; 38] = [
	"break",
	"case",
	"catch",
	"class",
	"const",
	"continue",
	"debugger",
	"default",
	"delete",
	"do",
	"else",
	"enum",
	"export",
	"extends",
	"false",
	"finally",
	"for",
	"function",
	"if",
	"import",
	"in",
	"instanceof",
	"new",
	"null",
	"return",
	"super",
	"switch",
	"this",
	"throw",
	"true",
	"try",
	"typeof",
	"var",
	"void",
	"while",
	"with",
	"yield",
	"await",
];

pub(crate) fn is_reserved(word: &str) -> bool {
	RESERVED.contains(&word)
}

/// A restorable parser state (for speculative parsing).
#[derive(Clone, Copy)]
pub(crate) struct Snap {
	pos: usize,
	tok: Token,
	prev_end: usize,
	edits: usize,
	imports: usize,
	refs: usize,
	decls: usize,
}

pub struct Parser<'s> {
	pub(crate) src: &'s str,
	pub(crate) lex: Lexer<'s>,
	pub(crate) tok: Token,
	pub(crate) prev_end: usize,
	/// Parse `<` at the start of an expression as JSX.
	pub(crate) jsx: bool,
	/// Parse and erase TypeScript syntax.
	pub(crate) ts: bool,
	pub(crate) edits: Vec<Edit>,
	pub(crate) imports: Vec<ImportRecord>,
	/// Identifiers used as values (name ranges).
	pub(crate) refs: Vec<(usize, usize)>,
	pub(crate) decls: Vec<ImportDecl>,
	pub(crate) info: ModuleInfo,
	pub(crate) depth: usize,
	/// Offsets of `(` that were tried as arrow function parameters and were
	/// not: they are never tried again (this keeps nested parentheses from
	/// being re-parsed exponentially).
	pub(crate) not_arrow: HashSet<usize>,
	/// Inside the middle operand of `a ? b : c`: an arrow function with a
	/// return type there must be followed by the `:`.
	pub(crate) in_cond_true: bool,
	/// `in` is not an operator (the head of a `for` statement).
	pub(crate) no_in: bool,
	/// Inside parentheses that may turn out to be arrow parameters.
	pub(crate) in_params: bool,
	/// Parsing the `extends` type of a conditional type, where `infer U extends C`
	/// takes its constraint even when a `?` follows.
	pub(crate) no_cond: bool,
}

/// What a parse produced.
pub struct Parsed {
	pub edits: Vec<Edit>,
	pub imports: Vec<ImportRecord>,
	pub refs: Vec<(usize, usize)>,
	pub decls: Vec<ImportDecl>,
	pub info: ModuleInfo,
}

impl<'s> Parser<'s> {
	/// Parses `src` as a module.
	///
	/// # Errors
	///
	/// A [`SyntaxError`] with the position of the first problem.
	pub fn parse(src: &'s str, jsx: bool, ts: bool) -> R<Parsed> {
		let mut lex = Lexer::new(src);
		let tok = lex.next()?;
		let mut p = Parser {
			src,
			lex,
			tok,
			prev_end: 0,
			jsx,
			ts,
			edits: Vec::new(),
			imports: Vec::new(),
			refs: Vec::new(),
			decls: Vec::new(),
			info: ModuleInfo::default(),
			depth: 0,
			not_arrow: HashSet::new(),
			in_cond_true: false,
			no_in: false,
			in_params: false,
			no_cond: false,
		};
		while p.tok.kind != Kind::Eof {
			p.statement(true)?;
		}
		Ok(Parsed {
			edits: p.edits,
			imports: p.imports,
			refs: p.refs,
			decls: p.decls,
			info: p.info,
		})
	}

	// ----- token helpers -----

	pub(crate) fn text(&self, t: Token) -> &'s str {
		&self.src[t.start..t.end]
	}

	pub(crate) fn cur(&self) -> &'s str {
		&self.src[self.tok.start..self.tok.end]
	}

	pub(crate) fn is_p(&self, p: &str) -> bool {
		self.tok.kind == Kind::Punct && self.tok.punct == p
	}

	pub(crate) fn is_kw(&self, k: &str) -> bool {
		self.tok.kind == Kind::Ident && self.cur() == k
	}

	pub(crate) fn advance(&mut self) -> R<()> {
		self.prev_end = self.tok.end;
		self.tok = self.lex.next()?;
		Ok(())
	}

	pub(crate) fn eat_p(&mut self, p: &str) -> R<bool> {
		if self.is_p(p) {
			self.advance()?;
			Ok(true)
		} else {
			Ok(false)
		}
	}

	pub(crate) fn eat_kw(&mut self, k: &str) -> R<bool> {
		if self.is_kw(k) {
			self.advance()?;
			Ok(true)
		} else {
			Ok(false)
		}
	}

	pub(crate) fn expect_p(&mut self, p: &str) -> R<()> {
		if self.is_p(p) {
			self.advance()
		} else {
			self.unexpected(&format!("`{p}`"))
		}
	}

	pub(crate) fn expect_kw(&mut self, k: &str) -> R<()> {
		if self.is_kw(k) {
			self.advance()
		} else {
			self.unexpected(&format!("`{k}`"))
		}
	}

	pub(crate) fn err<T>(&self, message: impl Into<String>) -> R<T> {
		Err(self.lex.error(self.tok.start, message))
	}

	pub(crate) fn unexpected<T>(&self, expected: &str) -> R<T> {
		let found = if self.tok.kind == Kind::Eof {
			"the end of the file".to_owned()
		} else {
			format!("`{}`", self.cur())
		};
		self.err(format!("expected {expected}, found {found}"))
	}

	/// The token after the current one.
	pub(crate) fn peek(&mut self) -> R<Token> {
		let save = self.lex.pos;
		let t = self.lex.next();
		self.lex.pos = save;
		t
	}

	pub(crate) fn snapshot(&self) -> Snap {
		Snap {
			pos: self.lex.pos,
			tok: self.tok,
			prev_end: self.prev_end,
			edits: self.edits.len(),
			imports: self.imports.len(),
			refs: self.refs.len(),
			decls: self.decls.len(),
		}
	}

	pub(crate) fn restore(&mut self, s: Snap) {
		self.lex.pos = s.pos;
		self.tok = s.tok;
		self.prev_end = s.prev_end;
		self.edits.truncate(s.edits);
		self.imports.truncate(s.imports);
		self.refs.truncate(s.refs);
		self.decls.truncate(s.decls);
	}

	/// Runs `f`; if it fails the parser is put back where it was.
	pub(crate) fn attempt<T>(&mut self, f: impl FnOnce(&mut Self) -> R<T>) -> Option<T> {
		let snap = self.snapshot();
		let (no_in, in_params, in_cond) = (self.no_in, self.in_params, self.in_cond_true);
		let depth = self.depth;
		match f(self) {
			Ok(v) => Some(v),
			Err(_) => {
				self.restore(snap);
				self.no_in = no_in;
				self.in_params = in_params;
				self.in_cond_true = in_cond;
				self.depth = depth;
				None
			}
		}
	}

	pub(crate) fn enter(&mut self) -> R<()> {
		self.depth += 1;
		if self.depth > MAX_DEPTH {
			return self.err("the code is nested too deeply");
		}
		Ok(())
	}

	pub(crate) fn leave(&mut self) {
		self.depth -= 1;
	}

	pub(crate) fn erase(&mut self, start: usize, end: usize) {
		if start < end {
			self.edits.push(Edit {
				start,
				end,
				kind: EditKind::Erase,
			});
		}
	}

	/// Statement end: `;`, or a line break, `}` or the end of the file.
	pub(crate) fn semicolon(&mut self) -> R<()> {
		if self.eat_p(";")? {
			return Ok(());
		}
		if self.is_p("}") || self.tok.kind == Kind::Eof || self.tok.nl_before {
			return Ok(());
		}
		self.unexpected("`;`")
	}

	pub(crate) fn push_ref(&mut self, tok: Token) {
		self.refs.push((tok.start, tok.end));
	}

	// ----- identifiers and binding patterns -----

	/// A binding identifier (not a reserved word).
	pub(crate) fn binding_ident(&mut self) -> R<Token> {
		if self.tok.kind != Kind::Ident || is_reserved(self.cur()) {
			return self.unexpected("an identifier");
		}
		let t = self.tok;
		self.advance()?;
		Ok(t)
	}

	/// An identifier, a pattern or a keyword used as a name; returns the
	/// identifier token for plain bindings.
	pub(crate) fn binding_target(&mut self) -> R<Option<Token>> {
		self.enter()?;
		let result = if self.is_p("[") {
			self.array_pattern()?;
			None
		} else if self.is_p("{") {
			self.object_pattern()?;
			None
		} else {
			Some(self.binding_ident()?)
		};
		self.leave();
		Ok(result)
	}

	fn array_pattern(&mut self) -> R<()> {
		self.expect_p("[")?;
		while !self.is_p("]") {
			if self.is_p(",") {
				self.advance()?;
				continue;
			}
			if self.eat_p("...")? {
				self.binding_target()?;
			} else {
				self.binding_element()?;
			}
			if !self.is_p("]") {
				self.expect_p(",")?;
			}
		}
		self.expect_p("]")
	}

	/// A pattern with an optional default.
	pub(crate) fn binding_element(&mut self) -> R<()> {
		self.binding_target()?;
		if self.eat_p("=")? {
			self.assign()?;
		}
		Ok(())
	}

	fn object_pattern(&mut self) -> R<()> {
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.eat_p("...")? {
				self.binding_target()?;
			} else {
				// key, `key: pattern`, `key = default`, `[computed]: pattern`
				if self.is_p("[") {
					self.advance()?;
					self.assign()?;
					self.expect_p("]")?;
					self.expect_p(":")?;
					self.binding_element()?;
				} else {
					let key = self.tok;
					self.property_name()?;
					if self.eat_p(":")? {
						self.binding_element()?;
					} else {
						// Shorthand: the key is the binding.
						if key.kind != Kind::Ident {
							return self.unexpected("`:`");
						}
						if self.eat_p("=")? {
							self.assign()?;
						}
					}
				}
			}
			if !self.is_p("}") {
				self.expect_p(",")?;
			}
		}
		self.expect_p("}")
	}

	/// A property name: identifier (keywords included), string, number or
	/// private name.
	pub(crate) fn property_name(&mut self) -> R<()> {
		match self.tok.kind {
			Kind::Ident | Kind::Str | Kind::Num | Kind::BigInt | Kind::Private => self.advance(),
			_ => self.unexpected("a property name"),
		}
	}

	// ----- statements -----

	pub(crate) fn statement(&mut self, top: bool) -> R<()> {
		self.enter()?;
		let r = self.statement_inner(top);
		self.leave();
		r
	}

	fn statement_inner(&mut self, top: bool) -> R<()> {
		if self.tok.kind == Kind::Punct {
			match self.tok.punct {
				"{" => return self.block(),
				";" => return self.advance(),
				"@" => return self.err("decorators are not supported"),
				_ => {}
			}
		}
		if self.tok.kind == Kind::Ident {
			let word = self.cur();
			match word {
				"var" | "const" => {
					// `const enum` is TypeScript.
					if word == "const" && self.ts {
						let next = self.peek()?;
						if next.kind == Kind::Ident && self.text(next) == "enum" {
							return self.err("enums are not supported (use a plain object)");
						}
					}
					return self.var_statement();
				}
				"using" if self.starts_using()? => return self.var_statement(),
				"await" => {
					// `await using x = ...`
					let next = self.peek()?;
					if next.kind == Kind::Ident && self.text(next) == "using" {
						let save = self.snapshot();
						self.advance()?;
						if self.starts_using()? {
							return self.var_statement();
						}
						self.restore(save);
					}
				}
				"let" => {
					let next = self.peek()?;
					let starts_binding = next.kind == Kind::Ident
						|| (next.kind == Kind::Punct && (next.punct == "[" || next.punct == "{"));
					if starts_binding {
						return self.var_statement();
					}
				}
				"function" => return self.function_declaration(false, None),
				"async" => {
					let next = self.peek()?;
					if next.kind == Kind::Ident && self.text(next) == "function" && !next.nl_before
					{
						return self.function_declaration(true, None);
					}
				}
				"class" => return self.class(true),
				"if" => return self.if_statement(),
				"for" => return self.for_statement(),
				"while" => {
					self.advance()?;
					self.paren_expression()?;
					return self.statement(false);
				}
				"do" => return self.do_statement(),
				"return" => {
					self.advance()?;
					if !(self.is_p(";")
						|| self.is_p("}") || self.tok.kind == Kind::Eof
						|| self.tok.nl_before)
					{
						self.expression()?;
					}
					return self.semicolon();
				}
				"break" | "continue" => {
					self.advance()?;
					if self.tok.kind == Kind::Ident
						&& !self.tok.nl_before
						&& !is_reserved(self.cur())
					{
						self.advance()?;
					}
					return self.semicolon();
				}
				"throw" => {
					self.advance()?;
					self.expression()?;
					return self.semicolon();
				}
				"try" => return self.try_statement(),
				"switch" => return self.switch_statement(),
				"debugger" => {
					self.advance()?;
					return self.semicolon();
				}
				"with" => return self.err("`with` is not supported in modules"),
				"import" => {
					let next = self.peek()?;
					let is_expr =
						next.kind == Kind::Punct && (next.punct == "(" || next.punct == ".");
					if !is_expr {
						if !top {
							return self.err("`import` is only allowed at the top level");
						}
						return self.import_declaration();
					}
				}
				"export" => {
					if !top {
						return self.err("`export` is only allowed at the top level");
					}
					return self.export_declaration();
				}
				"interface" if self.ts => {
					let next = self.peek()?;
					if next.kind == Kind::Ident && !next.nl_before {
						return self.interface_declaration();
					}
				}
				"type" if self.ts => {
					let next = self.peek()?;
					if next.kind == Kind::Ident && !next.nl_before {
						return self.type_alias();
					}
				}
				"enum" if self.ts => {
					return self.err("enums are not supported (use a plain object)");
				}
				"declare" if self.ts => {
					let next = self.peek()?;
					if next.kind == Kind::Ident && !next.nl_before {
						return self.declare_statement();
					}
				}
				"abstract" if self.ts => {
					let next = self.peek()?;
					if next.kind == Kind::Ident && self.text(next) == "class" && !next.nl_before {
						let start = self.tok.start;
						self.advance()?;
						let end = self.tok.start;
						self.erase(start, end);
						return self.class(true);
					}
				}
				"namespace" | "module" if self.ts => {
					let next = self.peek()?;
					if (next.kind == Kind::Ident || next.kind == Kind::Str) && !next.nl_before {
						return self.namespace_declaration(self.tok.start);
					}
				}
				_ => {}
			}
			// A label.
			if !is_reserved(word) {
				let next = self.peek()?;
				if next.kind == Kind::Punct && next.punct == ":" {
					self.advance()?;
					self.advance()?;
					return self.statement(false);
				}
			}
		}
		self.expression()?;
		self.semicolon()
	}

	/// At `using` of `using x = ...` (explicit resource management): an
	/// identifier follows on the same line.
	fn starts_using(&mut self) -> R<bool> {
		let next = self.peek()?;
		Ok(next.kind == Kind::Ident
			&& !next.nl_before
			&& !matches!(self.text(next), "in" | "of" | "instanceof"))
	}

	pub(crate) fn block(&mut self) -> R<()> {
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.tok.kind == Kind::Eof {
				return self.unexpected("`}`");
			}
			self.statement(false)?;
		}
		self.advance()
	}

	fn paren_expression(&mut self) -> R<()> {
		self.expect_p("(")?;
		self.expression()?;
		self.expect_p(")")
	}

	fn if_statement(&mut self) -> R<()> {
		self.advance()?;
		self.paren_expression()?;
		self.statement(false)?;
		if self.eat_kw("else")? {
			self.statement(false)?;
		}
		Ok(())
	}

	fn do_statement(&mut self) -> R<()> {
		self.advance()?;
		self.statement(false)?;
		self.expect_kw("while")?;
		self.paren_expression()?;
		self.eat_p(";")?;
		Ok(())
	}

	fn for_statement(&mut self) -> R<()> {
		self.advance()?;
		self.eat_kw("await")?;
		self.expect_p("(")?;
		let outer_no_in = self.no_in;
		if self.is_p(";") {
			// no init
		} else {
			self.no_in = true;
			if self.is_kw("await") {
				// `for (await using x of y)`
				let next = self.peek()?;
				if next.kind == Kind::Ident && self.text(next) == "using" {
					self.advance()?;
				}
			}
			let is_decl = self.is_kw("var")
				|| self.is_kw("const")
				|| (self.is_kw("using") && self.starts_using()?)
				|| (self.is_kw("let") && {
					let next = self.peek()?;
					next.kind == Kind::Ident
						|| (next.kind == Kind::Punct && (next.punct == "[" || next.punct == "{"))
				});
			if is_decl {
				self.advance()?;
				self.declarators()?;
			} else {
				self.expression()?;
			}
			self.no_in = outer_no_in;
		}
		self.no_in = outer_no_in;
		if self.is_kw("of") || self.is_kw("in") {
			self.advance()?;
			self.assign_or_comma()?;
		} else {
			self.expect_p(";")?;
			if !self.is_p(";") {
				self.expression()?;
			}
			self.expect_p(";")?;
			if !self.is_p(")") {
				self.expression()?;
			}
		}
		self.expect_p(")")?;
		self.statement(false)
	}

	fn assign_or_comma(&mut self) -> R<()> {
		self.expression()
	}

	fn try_statement(&mut self) -> R<()> {
		self.advance()?;
		self.block()?;
		if self.eat_kw("catch")? {
			if self.eat_p("(")? {
				self.binding_target()?;
				if self.ts && self.is_p(":") {
					let start = self.tok.start;
					self.advance()?;
					self.skip_type()?;
					self.erase(start, self.prev_end);
				}
				self.expect_p(")")?;
			}
			self.block()?;
		}
		if self.eat_kw("finally")? {
			self.block()?;
		}
		Ok(())
	}

	fn switch_statement(&mut self) -> R<()> {
		self.advance()?;
		self.paren_expression()?;
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.eat_kw("case")? {
				self.expression()?;
			} else {
				self.expect_kw("default")?;
			}
			self.expect_p(":")?;
			while !self.is_p("}") && !self.is_kw("case") && !self.is_kw("default") {
				if self.tok.kind == Kind::Eof {
					return self.unexpected("`}`");
				}
				self.statement(false)?;
			}
		}
		self.advance()
	}

	fn var_statement(&mut self) -> R<()> {
		self.advance()?;
		self.declarators()?;
		self.semicolon()
	}

	/// `a = 1, b: T = 2, [c, d] = e`.
	pub(crate) fn declarators(&mut self) -> R<()> {
		loop {
			let target = self.binding_target()?;
			if self.ts {
				// `let x!: T`
				if target.is_some() && self.is_p("!") && !self.tok.nl_before {
					let (s, e) = (self.tok.start, self.tok.end);
					self.erase(s, e);
					self.advance()?;
				}
				if self.is_p(":") {
					let start = self.tok.start;
					self.advance()?;
					self.skip_type()?;
					self.erase(start, self.prev_end);
				}
			}
			if self.eat_p("=")? {
				self.assign()?;
			}
			if !self.eat_p(",")? {
				return Ok(());
			}
		}
	}

	// ----- functions -----

	/// A function declaration. `erase_from` is where an overload signature's
	/// erased range starts when it does not start at `function` (`export`).
	fn function_declaration(&mut self, is_async: bool, erase_from: Option<usize>) -> R<()> {
		let start = erase_from.unwrap_or(self.tok.start);
		if is_async {
			self.advance()?;
		}
		let had_body = self.function_rest(true)?;
		if !had_body {
			// A TypeScript overload signature: no code.
			self.erase(start, self.prev_end);
			self.eat_p(";")?;
		}
		Ok(())
	}

	/// After `function` (current token): `*`, name, type parameters,
	/// parameters, return type, body. Returns whether there was a body.
	pub(crate) fn function_rest(&mut self, name_required: bool) -> R<bool> {
		self.expect_kw("function")?;
		self.eat_p("*")?;
		if self.tok.kind == Kind::Ident && !self.is_p("(") && !self.is_kw("function") {
			self.advance()?;
		} else if name_required && !self.is_p("(") {
			return self.unexpected("a function name");
		}
		self.function_signature_and_body()
	}

	/// Type parameters, parameters, return type and body. The body is
	/// optional in TypeScript (overloads and ambient declarations).
	pub(crate) fn function_signature_and_body(&mut self) -> R<bool> {
		if self.ts && self.is_p("<") {
			self.type_parameters()?;
		}
		self.params()?;
		if self.ts && self.is_p(":") {
			let start = self.tok.start;
			self.advance()?;
			self.skip_return_type()?;
			self.erase(start, self.prev_end);
		}
		if self.is_p("{") {
			let outer = (self.no_in, self.in_params, self.in_cond_true);
			self.no_in = false;
			self.in_params = false;
			self.in_cond_true = false;
			self.block()?;
			(self.no_in, self.in_params, self.in_cond_true) = outer;
			Ok(true)
		} else if self.ts {
			self.semicolon()?;
			Ok(false)
		} else {
			self.unexpected("`{`")
		}
	}

	/// `(a, b?: T, {c}: D = {}, ...rest)`.
	pub(crate) fn params(&mut self) -> R<()> {
		self.expect_p("(")?;
		while !self.is_p(")") {
			self.param()?;
			if !self.is_p(")") {
				self.expect_p(",")?;
			}
		}
		self.advance()
	}

	fn param(&mut self) -> R<()> {
		let start = self.tok.start;
		// TypeScript `this` parameter: erased with its comma.
		if self.ts && self.is_kw("this") {
			let next = self.peek()?;
			if next.kind == Kind::Punct && next.punct == ":" {
				self.advance()?;
				self.advance()?;
				self.skip_type()?;
				// The comma goes with it; the caller still sees the token.
				let end = if self.is_p(",") {
					self.tok.end
				} else {
					self.prev_end
				};
				self.erase(start, end);
				return Ok(());
			}
		}
		if self.ts
			&& self.tok.kind == Kind::Ident
			&& matches!(
				self.cur(),
				"public" | "private" | "protected" | "readonly" | "override"
			) {
			let next = self.peek()?;
			let starts_param = next.kind == Kind::Ident
				|| (next.kind == Kind::Punct && (next.punct == "{" || next.punct == "["));
			if starts_param {
				return self
					.err("parameter properties are not supported (assign in the constructor)");
			}
		}
		self.eat_p("...")?;
		self.binding_target()?;
		if self.ts {
			if self.is_p("?") {
				let (s, e) = (self.tok.start, self.tok.end);
				self.erase(s, e);
				self.advance()?;
			}
			if self.is_p(":") {
				let s = self.tok.start;
				self.advance()?;
				self.skip_type()?;
				self.erase(s, self.prev_end);
			}
		}
		if self.eat_p("=")? {
			self.assign()?;
		}
		Ok(())
	}

	// ----- classes -----

	pub(crate) fn class(&mut self, is_decl: bool) -> R<()> {
		self.expect_kw("class")?;
		if self.tok.kind == Kind::Ident && !self.is_kw("extends") && !self.is_kw("implements") {
			self.advance()?;
		} else if is_decl {
			return self.unexpected("a class name");
		}
		if self.ts && self.is_p("<") {
			self.type_parameters()?;
		}
		if self.eat_kw("extends")? {
			self.unary_and_subscripts()?;
			// `extends Base<T>`: the type arguments are not part of the expression.
			if self.ts && self.is_p("<") {
				let s = self.tok.start;
				self.type_arguments_skip()?;
				self.erase(s, self.prev_end);
			}
		}
		if self.ts && self.is_kw("implements") {
			let start = self.tok.start;
			self.advance()?;
			loop {
				self.skip_type()?;
				if !self.eat_p(",")? {
					break;
				}
			}
			self.erase(start, self.prev_end);
		}
		self.class_body()
	}

	fn class_body(&mut self) -> R<()> {
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.tok.kind == Kind::Eof {
				return self.unexpected("`}`");
			}
			self.class_member()?;
		}
		self.advance()
	}

	fn class_member(&mut self) -> R<()> {
		if self.eat_p(";")? {
			return Ok(());
		}
		if self.is_p("@") {
			return self.err("decorators are not supported");
		}
		let start = self.tok.start;
		let mut erase_member = false;
		// Modifiers. A modifier is a word followed by something that can
		// continue a member; otherwise the word is the member's name.
		loop {
			if self.tok.kind != Kind::Ident {
				break;
			}
			let word = self.cur();
			let is_modifier = matches!(word, "static" | "async" | "get" | "set" | "accessor")
				|| (self.ts
					&& matches!(
						word,
						"public"
							| "private" | "protected"
							| "readonly" | "abstract"
							| "override" | "declare"
					));
			if !is_modifier {
				break;
			}
			let next = self.peek()?;
			let continues = match next.kind {
				Kind::Ident | Kind::Str | Kind::Num | Kind::BigInt | Kind::Private => {
					// `get`/`set`/`async` need to be on the same line as the name.
					!(matches!(word, "async") && next.nl_before)
				}
				Kind::Punct => matches!(next.punct, "[" | "*" | "{"),
				_ => false,
			};
			if !continues {
				break;
			}
			if word == "static" && next.kind == Kind::Punct && next.punct == "{" {
				// A static initialization block.
				self.advance()?;
				return self.block();
			}
			if self.ts && matches!(word, "abstract" | "declare") {
				erase_member = true;
			}
			if self.ts
				&& matches!(
					word,
					"public"
						| "private" | "protected"
						| "readonly" | "abstract"
						| "override" | "declare"
				) {
				let (s, e) = (self.tok.start, self.tok.end);
				self.erase(s, e);
			}
			self.advance()?;
		}
		self.eat_p("*")?;
		// Index signature: `[key: string]: T;`
		if self.ts && self.is_p("[") {
			let save = self.snapshot();
			self.advance()?;
			if self.tok.kind == Kind::Ident {
				let next = self.peek()?;
				if next.kind == Kind::Punct && next.punct == ":" {
					self.restore(save);
					self.advance()?;
					self.advance()?;
					self.advance()?;
					self.skip_type()?;
					self.expect_p("]")?;
					if self.eat_p(":")? {
						self.skip_type()?;
					}
					self.eat_p(";")?;
					self.erase(start, self.prev_end);
					return Ok(());
				}
			}
			self.restore(save);
		}
		// The key.
		if self.is_p("[") {
			self.advance()?;
			self.assign()?;
			self.expect_p("]")?;
		} else {
			self.property_name()?;
		}
		// TypeScript markers on the key.
		if self.ts && (self.is_p("?") || self.is_p("!")) {
			let (s, e) = (self.tok.start, self.tok.end);
			self.erase(s, e);
			self.advance()?;
		}
		if self.is_p("(") || (self.ts && self.is_p("<")) {
			// A method.
			let had_body = self.function_signature_and_body()?;
			if !had_body {
				erase_member = true;
			}
		} else {
			// A field.
			if self.ts && self.is_p(":") {
				let s = self.tok.start;
				self.advance()?;
				self.skip_type()?;
				self.erase(s, self.prev_end);
			}
			if self.eat_p("=")? {
				self.assign()?;
			}
			self.semicolon()?;
		}
		if erase_member {
			self.erase(start, self.prev_end);
		}
		Ok(())
	}

	// ----- modules -----

	fn string_value(&self, tok: Token) -> String {
		crate::strings::decode(self.text(tok))
	}

	fn module_specifier(&mut self, kind: ImportKind) -> R<()> {
		if self.tok.kind != Kind::Str {
			return self.unexpected("a module specifier");
		}
		let tok = self.tok;
		self.imports.push(ImportRecord {
			start: tok.start,
			end: tok.end,
			specifier: self.string_value(tok),
			kind,
			attributes: false,
		});
		let record = self.imports.len() - 1;
		self.advance()?;
		// Import attributes: `with { type: "json" }`.
		if self.is_kw("with") || (self.is_kw("assert") && !self.tok.nl_before) {
			self.imports[record].attributes = true;
			self.advance()?;
			self.expect_p("{")?;
			while !self.is_p("}") {
				self.property_name()?;
				self.expect_p(":")?;
				if self.tok.kind != Kind::Str {
					return self.unexpected("a string");
				}
				self.advance()?;
				if !self.is_p("}") {
					self.expect_p(",")?;
				}
			}
			self.advance()?;
		}
		Ok(())
	}

	fn import_declaration(&mut self) -> R<()> {
		let start = self.tok.start;
		self.advance()?;
		// `import "x";`
		if self.tok.kind == Kind::Str {
			self.module_specifier(ImportKind::Static)?;
			return self.semicolon();
		}
		// `import type ...` is erased as a whole.
		if self.ts && self.is_kw("type") {
			let next = self.peek()?;
			// `import type from "x"` imports a default binding named `type`.
			let is_type_import = (next.kind == Kind::Punct
				&& (next.punct == "{" || next.punct == "*"))
				|| (next.kind == Kind::Ident && self.text(next) != "from");
			if is_type_import {
				self.advance()?;
				self.import_clause_skip()?;
				self.expect_kw("from")?;
				self.module_specifier_erased()?;
				self.semicolon()?;
				self.erase(start, self.prev_end);
				return Ok(());
			}
		}
		let mut bindings: Vec<ImportBinding> = Vec::new();
		// Default import.
		if self.tok.kind == Kind::Ident && !self.is_p("{") {
			let t = self.binding_ident()?;
			// `import x = require("y")`
			if self.ts && self.is_p("=") {
				return self.err("`import x = require()` is not supported (use `import`)");
			}
			bindings.push(ImportBinding {
				local: self.text(t).to_owned(),
				start: t.start,
				end: t.end,
				comma_end: None,
				named: false,
			});
			if self.is_p(",") {
				self.advance()?;
			}
		}
		if self.is_p("*") {
			self.advance()?;
			self.expect_kw("as")?;
			let t = self.binding_ident()?;
			bindings.push(ImportBinding {
				local: self.text(t).to_owned(),
				start: t.start,
				end: t.end,
				comma_end: None,
				named: false,
			});
		} else if self.is_p("{") {
			self.advance()?;
			while !self.is_p("}") {
				let spec_start = self.tok.start;
				let mut is_type = false;
				if self.ts && self.is_kw("type") {
					let next = self.peek()?;
					// `type X`, `type X as Y`; but `type` or `type as Y` import a value.
					let is_mod = next.kind == Kind::Ident
						&& !(self.text(next) == "as" && {
							let save = self.snapshot();
							self.advance()?;
							self.advance()?;
							let after = self.tok;
							self.restore(save);
							after.kind == Kind::Punct && (after.punct == "," || after.punct == "}")
								|| after.kind == Kind::Eof
						});
					is_type = is_mod;
				}
				if is_type {
					self.advance()?;
				}
				let imported = self.tok;
				self.property_name()?;
				let mut local = imported;
				if self.eat_kw("as")? {
					local = self.binding_ident()?;
				}
				let spec_end = self.prev_end;
				let comma_end = if self.is_p(",") {
					let e = self.tok.end;
					self.advance()?;
					Some(e)
				} else {
					None
				};
				if is_type {
					let end = comma_end.unwrap_or(spec_end);
					self.erase(spec_start, end);
				} else {
					bindings.push(ImportBinding {
						local: self.text(local).to_owned(),
						start: spec_start,
						end: spec_end,
						comma_end,
						named: true,
					});
				}
				if comma_end.is_none() && !self.is_p("}") {
					return self.unexpected("`,` or `}`");
				}
			}
			self.advance()?;
		}
		if bindings.is_empty() && !self.is_kw("from") {
			return self.unexpected("an import clause");
		}
		self.expect_kw("from")?;
		self.module_specifier(ImportKind::Static)?;
		self.semicolon()?;
		self.decls.push(ImportDecl {
			start,
			end: self.prev_end,
			bindings,
		});
		Ok(())
	}

	/// The bindings of an erased `import type` clause.
	fn import_clause_skip(&mut self) -> R<()> {
		if self.tok.kind == Kind::Ident && !self.is_kw("from") {
			self.advance()?;
			self.eat_p(",")?;
		}
		if self.is_p("*") {
			self.advance()?;
			self.expect_kw("as")?;
			self.binding_ident()?;
		} else if self.is_p("{") {
			self.advance()?;
			while !self.is_p("}") {
				if self.tok.kind == Kind::Eof {
					return self.unexpected("`}`");
				}
				self.advance()?;
			}
			self.advance()?;
		}
		Ok(())
	}

	/// A specifier that is erased with its statement: it is not an import.
	fn module_specifier_erased(&mut self) -> R<()> {
		if self.tok.kind != Kind::Str {
			return self.unexpected("a module specifier");
		}
		self.advance()
	}

	fn export_declaration(&mut self) -> R<()> {
		let start = self.tok.start;
		self.advance()?;
		if self.tok.kind == Kind::Punct && self.tok.punct == "=" {
			return self.err("`export =` is not supported (use `export default`)");
		}
		if self.is_kw("default") {
			self.advance()?;
			self.info.has_default_export = true;
			if self.is_kw("function")
				|| (self.is_kw("async") && {
					let next = self.peek()?;
					next.kind == Kind::Ident && self.text(next) == "function" && !next.nl_before
				}) {
				let is_async = self.is_kw("async");
				if is_async {
					self.advance()?;
				}
				let had_body = self.function_rest(false)?;
				if !had_body {
					self.erase(start, self.prev_end);
				}
				return Ok(());
			}
			if self.is_kw("class") {
				return self.class(false);
			}
			if self.ts && self.is_kw("abstract") {
				let next = self.peek()?;
				if next.kind == Kind::Ident && self.text(next) == "class" {
					let s = self.tok.start;
					self.advance()?;
					self.erase(s, self.tok.start);
					return self.class(false);
				}
			}
			if self.ts && self.is_kw("interface") {
				self.interface_declaration()?;
				self.erase(start, self.prev_end);
				self.info.has_default_export = false;
				return Ok(());
			}
			self.assign()?;
			return self.semicolon();
		}
		if self.is_p("*") {
			self.advance()?;
			if self.eat_kw("as")? {
				self.property_name()?;
			}
			self.expect_kw("from")?;
			self.module_specifier(ImportKind::ExportFrom)?;
			return self.semicolon();
		}
		if self.is_p("{") {
			return self.export_clause(start, false);
		}
		if self.ts && self.is_kw("type") {
			let next = self.peek()?;
			if next.kind == Kind::Punct && (next.punct == "{" || next.punct == "*") {
				self.advance()?;
				self.export_clause_erased()?;
				self.semicolon()?;
				self.erase(start, self.prev_end);
				return Ok(());
			}
			if next.kind == Kind::Ident {
				self.type_alias()?;
				self.erase(start, self.prev_end);
				return Ok(());
			}
		}
		if self.ts && self.is_kw("interface") {
			self.interface_declaration()?;
			self.erase(start, self.prev_end);
			return Ok(());
		}
		if self.ts && self.is_kw("declare") {
			self.declare_statement()?;
			self.erase(start, self.prev_end);
			return Ok(());
		}
		if self.ts && self.is_kw("enum") {
			return self.err("enums are not supported (use a plain object)");
		}
		if self.ts && (self.is_kw("namespace") || self.is_kw("module")) {
			return self.namespace_declaration(start);
		}
		if self.ts && self.is_kw("abstract") {
			let s = self.tok.start;
			self.advance()?;
			self.erase(s, self.tok.start);
			return self.class(true);
		}
		// `export const meta = { ... }` is remembered for the host.
		let is_meta = self.is_kw("const") && {
			let next = self.peek()?;
			next.kind == Kind::Ident && self.text(next) == "meta"
		};
		if is_meta {
			self.advance()?;
			self.binding_ident()?;
			if self.ts && self.is_p(":") {
				let s = self.tok.start;
				self.advance()?;
				self.skip_type()?;
				self.erase(s, self.prev_end);
			}
			if self.is_p("=") {
				self.advance()?;
				let init_start = self.tok.start;
				self.assign()?;
				self.info.meta = Some((init_start, self.prev_end));
				if self.eat_p(",")? {
					// More declarators after `meta`.
					self.declarators()?;
				}
				return self.semicolon();
			}
			return self.unexpected("`=`");
		}
		match self.tok.kind {
			Kind::Ident => match self.cur() {
				"const" | "let" | "var" => self.var_statement(),
				"function" => self.function_declaration(false, Some(start)),
				"async" => self.function_declaration(true, Some(start)),
				"class" => self.class(true),
				_ => self.unexpected("a declaration"),
			},
			_ => self.unexpected("a declaration"),
		}
	}

	fn export_clause(&mut self, start: usize, _type_only: bool) -> R<()> {
		self.expect_p("{")?;
		let mut locals: Vec<Token> = Vec::new();
		while !self.is_p("}") {
			let spec_start = self.tok.start;
			let mut is_type = false;
			if self.ts && self.is_kw("type") {
				let next = self.peek()?;
				is_type = next.kind == Kind::Ident && self.text(next) != "as";
			}
			if is_type {
				self.advance()?;
			}
			let local = self.tok;
			self.property_name()?;
			if self.eat_kw("as")? {
				self.property_name()?;
			}
			let spec_end = self.prev_end;
			let comma = if self.is_p(",") {
				let e = self.tok.end;
				self.advance()?;
				Some(e)
			} else {
				None
			};
			if is_type {
				self.erase(spec_start, comma.unwrap_or(spec_end));
			} else {
				locals.push(local);
			}
			if comma.is_none() && !self.is_p("}") {
				return self.unexpected("`,` or `}`");
			}
		}
		self.advance()?;
		if self.eat_kw("from")? {
			self.module_specifier(ImportKind::ExportFrom)?;
		} else {
			for t in locals {
				if t.kind == Kind::Ident {
					self.push_ref(t);
				}
			}
		}
		let _ = start;
		self.semicolon()
	}

	fn export_clause_erased(&mut self) -> R<()> {
		if self.is_p("*") {
			self.advance()?;
			if self.eat_kw("as")? {
				self.property_name()?;
			}
		} else {
			self.expect_p("{")?;
			while !self.is_p("}") {
				if self.tok.kind == Kind::Eof {
					return self.unexpected("`}`");
				}
				self.advance()?;
			}
			self.advance()?;
		}
		if self.eat_kw("from")? {
			self.module_specifier_erased()?;
		}
		Ok(())
	}

	// ----- TypeScript declarations (all erased) -----

	fn interface_declaration(&mut self) -> R<()> {
		let start = self.tok.start;
		self.advance()?;
		self.binding_ident()?;
		if self.is_p("<") {
			self.type_parameters_skip()?;
		}
		if self.eat_kw("extends")? {
			loop {
				self.skip_type()?;
				if !self.eat_p(",")? {
					break;
				}
			}
		}
		self.object_type()?;
		self.erase(start, self.prev_end);
		Ok(())
	}

	fn type_alias(&mut self) -> R<()> {
		let start = self.tok.start;
		self.advance()?;
		self.binding_ident()?;
		if self.is_p("<") {
			self.type_parameters_skip()?;
		}
		self.expect_p("=")?;
		self.skip_type()?;
		self.semicolon()?;
		self.erase(start, self.prev_end);
		Ok(())
	}

	/// `declare ...`: parsed so that the end is known, then erased.
	fn declare_statement(&mut self) -> R<()> {
		let start = self.tok.start;
		self.advance()?;
		if self.is_kw("module") || self.is_kw("namespace") || self.is_kw("global") {
			self.advance()?;
			if self.tok.kind == Kind::Str || self.tok.kind == Kind::Ident {
				self.advance()?;
			}
			self.skip_braces()?;
		} else if self.is_kw("enum")
			|| (self.is_kw("const") && {
				let next = self.peek()?;
				next.kind == Kind::Ident && self.text(next) == "enum"
			}) {
			if self.is_kw("const") {
				self.advance()?;
			}
			self.advance()?;
			self.binding_ident()?;
			self.skip_braces()?;
		} else if self.is_kw("interface") {
			self.interface_declaration()?;
		} else if self.is_kw("type") {
			self.type_alias()?;
		} else if self.is_kw("abstract") {
			self.advance()?;
			self.class(true)?;
		} else if self.is_kw("class") {
			self.class(true)?;
		} else if self.is_kw("function") {
			self.function_rest(true)?;
		} else if self.is_kw("async") {
			self.advance()?;
			self.function_rest(true)?;
		} else if self.is_kw("var") || self.is_kw("let") || self.is_kw("const") {
			self.var_statement()?;
		} else {
			return self.unexpected("a declaration after `declare`");
		}
		self.erase(start, self.prev_end);
		Ok(())
	}

	/// `namespace N { ... }` that holds only types is erased; one with values
	/// would need code generation and is refused.
	fn namespace_declaration(&mut self, erase_from: usize) -> R<()> {
		self.advance()?;
		if self.tok.kind == Kind::Str {
			self.advance()?;
		} else {
			self.binding_ident()?;
			while self.eat_p(".")? {
				self.binding_ident()?;
			}
		}
		self.expect_p("{")?;
		while !self.is_p("}") {
			if self.tok.kind == Kind::Eof {
				return self.unexpected("`}`");
			}
			let stmt_start = self.tok.start;
			let before = self.edits.len();
			self.statement(true)?;
			let covered = self.edits[before..].iter().any(|e| {
				matches!(e.kind, EditKind::Erase) && e.start <= stmt_start && e.end >= self.prev_end
			});
			if !covered {
				return self.err("namespaces with values are not supported (use modules)");
			}
		}
		self.advance()?;
		self.erase(erase_from, self.prev_end);
		Ok(())
	}

	/// Skips a `{ ... }` of declarations by matching braces.
	fn skip_braces(&mut self) -> R<()> {
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
}
