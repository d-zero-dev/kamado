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

/// One binding of an import declaration.
#[derive(Debug, Clone)]
pub struct ImportBinding {
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
}

/// Facts about the module that the host needs.
#[derive(Debug, Clone, Default)]
pub struct ModuleInfo {
	/// The initializer of `export const meta = ...` (the range of the
	/// expression, a trailing `as const` or `satisfies T` included).
	pub meta: Option<(usize, usize)>,
	pub has_default_export: bool,
}
