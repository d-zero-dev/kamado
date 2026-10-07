//! What the parser records. There is no syntax tree: the parser walks the
//! whole grammar but keeps only what the transform needs, namely the ranges
//! to blank out (TypeScript syntax), the JSX roots to replace, the module
//! specifiers, and which identifiers are used as values.

/// A change to the source text.
#[derive(Debug, Clone)]
pub struct Edit {
	pub start: usize,
	pub end: usize,
	pub kind: EditKind,
}

#[derive(Debug, Clone)]
pub enum EditKind {
	/// TypeScript syntax: replaced by white space of the same shape so that
	/// line and column numbers of the code that stays are unchanged.
	Erase,
	/// Other text in place of the range (a rewritten module specifier).
	Replace(String),
	/// A JSX element or fragment that sits where a JavaScript expression is
	/// expected (nested elements are part of their root).
	Jsx(Box<JsxElement>),
}

#[derive(Debug, Clone)]
pub struct JsxElement {
	pub start: usize,
	pub end: usize,
	pub tag: JsxTag,
	pub attrs: Vec<JsxAttr>,
	pub children: Vec<JsxChild>,
}

#[derive(Debug, Clone)]
pub enum JsxTag {
	Fragment,
	/// A lower-case or dashed name: an HTML (or custom) element.
	Host(String),
	/// A component: the name exactly as written (`Card`, `ui.Card`).
	Component(String),
}

#[derive(Debug, Clone)]
pub enum JsxAttr {
	/// `name="text"`, the text already decoded.
	Str { name: String, value: String },
	/// `name` alone.
	True { name: String },
	/// `name={expression}`; the range is the expression without braces.
	Expr {
		name: String,
		start: usize,
		end: usize,
	},
	/// `{...expression}`.
	Spread { start: usize, end: usize },
}

#[derive(Debug, Clone)]
pub enum JsxChild {
	/// Text after JSX white space rules and entity decoding.
	Text(String),
	/// `{expression}`; the range is the expression without braces.
	Expr {
		start: usize,
		end: usize,
	},
	Element(Box<JsxElement>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImportKind {
	/// `import ... from "x"` or `import "x"`.
	Static,
	/// `export ... from "x"`.
	ExportFrom,
	/// `import("x")` with a string literal.
	Dynamic,
}

/// A module specifier written in the source.
#[derive(Debug, Clone)]
pub struct ImportRecord {
	/// The range of the string literal, quotes included.
	pub start: usize,
	pub end: usize,
	/// The specifier with escapes decoded.
	pub specifier: String,
	pub kind: ImportKind,
	/// Import attributes (`with { type: "json" }`, or the second argument of
	/// `import()`) are already written.
	pub attributes: bool,
}

/// What an import binding takes from the module.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BindingKind {
	/// `import x from "m"`: the `default` export.
	Default,
	/// `import * as x from "m"`: the namespace.
	Namespace,
	/// `import { a as x } from "m"`: the export `a`.
	Named,
}

/// One binding of an import declaration.
#[derive(Debug, Clone)]
pub struct ImportBinding {
	pub kind: BindingKind,
	/// The name the module exports it as (named bindings).
	pub imported: Option<String>,
	pub local: String,
	/// The range of the whole specifier (`a`, `a as b`; for `default` and
	/// namespace imports the identifier itself).
	pub start: usize,
	pub end: usize,
	/// The end of the comma that follows a named specifier, if any.
	pub comma_end: Option<usize>,
	/// A named specifier (inside braces).
	pub named: bool,
}

/// An import declaration with value bindings.
#[derive(Debug, Clone)]
pub struct ImportDecl {
	pub start: usize,
	pub end: usize,
	pub bindings: Vec<ImportBinding>,
	/// The index of the declaration's specifier in the list of imports.
	pub record: usize,
}

/// `export default ...`.
#[derive(Debug, Clone)]
pub struct DefaultExport {
	/// The range of `export default`.
	pub start: usize,
	pub end: usize,
	/// The end of the statement.
	pub stmt_end: usize,
	/// The name a function or class declaration gives itself (`export default
	/// function Page() {}`); anything else is an expression.
	pub name: Option<String>,
	/// A function or class (a declaration, which needs no `;` after it).
	pub is_declaration: bool,
}

/// Facts about the module that the host needs.
#[derive(Debug, Clone, Default)]
pub struct ModuleInfo {
	/// The initializer of `export const meta = ...` (the range of the
	/// expression, a trailing `as const` or `satisfies T` included).
	pub meta: Option<(usize, usize)>,
	pub has_default_export: bool,
	/// Where `export default` is (only when something is exported).
	pub default_export: Option<DefaultExport>,
	/// The `export` keywords in front of declarations (`export const a`).
	pub export_keywords: Vec<(usize, usize)>,
	/// Whole `export { a, b as c };` statements (without `from`).
	pub export_clauses: Vec<(usize, usize)>,
	/// `export * from` or `export { a } from`.
	pub reexports: bool,
	/// `import.meta` is used.
	pub import_meta: bool,
}
