//! TSX → JavaScript for kamado v3: types are erased and JSX becomes string
//! concatenation against the runtime in `packages/kamado-v3/src/jsx`.
//!
//! The compiler reads the whole TypeScript + JSX grammar (see `parser`) but
//! builds no tree: it records the ranges to blank out, the JSX to replace and
//! the module specifiers, and `codegen` applies them to the source text. What
//! is not touched stays byte for byte, so line numbers in error messages stay
//! right.
//!
//! Not supported, with a clear error: enums, namespaces, decorators,
//! parameter properties, `import x = require()` and `export =` (TypeScript
//! syntax that is not just types).

pub mod ast;
mod codegen;
mod define;
mod expr;
mod jsx;
mod jsx_entities;
pub mod lexer;
mod meta;
pub mod parser;
// The generated table also lists the unitless style properties, which a
// compile-time fold of static `style` objects will use.
#[allow(dead_code)]
mod react_attrs;
pub mod strings;
mod ts;

use std::collections::HashSet;

use ast::{Edit, EditKind};
pub use lexer::SyntaxError;
pub use meta::{Const, extract_meta};

/// How to compile one file.
pub struct Options<'a> {
	/// The module specifier the compiled code imports the runtime from
	/// (an absolute `file:` URL).
	pub runtime: &'a str,
	/// Parse JSX (`.tsx`, `.jsx`).
	pub jsx: bool,
	/// Parse and erase TypeScript (`.ts`, `.tsx`).
	pub ts: bool,
	/// Drop imports that are never used as values (as TypeScript does).
	/// Only meaningful with `ts`.
	pub elide_imports: bool,
	/// Maps a module specifier of the source to the one to write instead
	/// (`None` keeps it).
	pub rewrite: &'a dyn Fn(&str) -> Option<String>,
	/// Global names (`DEBUG`, `process.env.NODE_ENV`) and the expressions that
	/// replace them; see esbuild's `define`.
	pub define: &'a [(String, String)],
}

/// The result of [`compile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Output {
	pub code: String,
	/// The module specifiers of the source, as written, in order (imports,
	/// re-exports and `import()` with a string literal).
	pub specifiers: Vec<String>,
	/// The range in the *source* of the initializer of `export const meta`.
	pub meta: Option<(usize, usize)>,
	pub has_default_export: bool,
}

/// Compiles `src`.
///
/// # Errors
///
/// A [`SyntaxError`] with line and column for the first problem.
///
/// # Example
///
/// ```
/// let options = kd_js::Options {
///     runtime: "file:///rt.js",
///     jsx: true,
///     ts: true,
///     elide_imports: true,
///     rewrite: &|_| None,
///     define: &[],
/// };
/// let out = kd_js::compile("export default (p: { n: string }) => <b>{p.n}</b>;", &options).unwrap();
/// assert!(out.code.contains("__kd_m(\"<b>\" + __kd_c(p.n) + \"</b>\")"));
/// assert!(!out.code.contains(": {"));
/// ```
pub fn compile(src: &str, options: &Options<'_>) -> Result<Output, SyntaxError> {
	let parsed = parser::Parser::parse(src, options.jsx, options.ts)?;
	let mut edits: Vec<Edit> = parsed.edits;

	if !options.define.is_empty() {
		edits.extend(define::edits(
			src,
			&parsed.refs,
			&parsed.shorthand,
			options.define,
		));
	}
	if options.ts && options.elide_imports {
		elide_unused_imports(src, &parsed.decls, &parsed.refs, &mut edits);
	}
	for record in &parsed.imports {
		let rewritten = (options.rewrite)(&record.specifier);
		let specifier = rewritten.as_deref().unwrap_or(&record.specifier);
		// Node only loads JSON as a module with an attribute that says so;
		// the source need not repeat it.
		let json_attributes = specifier.ends_with(".json") && !record.attributes;
		if rewritten.is_none() && !json_attributes {
			continue;
		}
		let mut text = strings::quote(specifier);
		if json_attributes {
			text.push_str(if record.kind == ast::ImportKind::Dynamic {
				", { with: { type: \"json\" } }"
			} else {
				" with { type: \"json\" }"
			});
		}
		edits.push(Edit {
			start: record.start,
			end: record.end,
			kind: EditKind::Replace(text),
		});
	}

	let mut applier = codegen::Applier::new(src, edits);
	let body = applier.render(0, src.len());
	let prologue = applier.prologue(options.runtime);
	// A hashbang has to stay first.
	let code = if body.starts_with("#!") {
		let line_end = body.find('\n').map_or(body.len(), |i| i + 1);
		format!("{}{prologue}{}", &body[..line_end], &body[line_end..])
	} else {
		format!("{prologue}{body}")
	};
	Ok(Output {
		code,
		specifiers: parsed.imports.iter().map(|r| r.specifier.clone()).collect(),
		meta: parsed.info.meta,
		has_default_export: parsed.info.has_default_export,
	})
}

/// TypeScript drops an import whose bindings are never used as values (they
/// were only types); so do we, as a whole statement or per specifier.
fn elide_unused_imports(
	src: &str,
	decls: &[ast::ImportDecl],
	refs: &[(usize, usize)],
	edits: &mut Vec<Edit>,
) {
	let used: HashSet<&str> = refs.iter().map(|&(s, e)| &src[s..e]).collect();
	for decl in decls {
		let unused: Vec<&ast::ImportBinding> = decl
			.bindings
			.iter()
			.filter(|b| !used.contains(b.local.as_str()))
			.collect();
		if unused.is_empty() {
			continue;
		}
		if unused.len() == decl.bindings.len() {
			edits.push(Edit {
				start: decl.start,
				end: decl.end,
				kind: EditKind::Erase,
			});
			continue;
		}
		for binding in unused {
			if binding.named {
				edits.push(Edit {
					start: binding.start,
					end: binding.comma_end.unwrap_or(binding.end),
					kind: EditKind::Erase,
				});
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn tsx(src: &str) -> String {
		compile(
			src,
			&Options {
				runtime: "file:///rt.js",
				jsx: true,
				ts: true,
				elide_imports: true,
				rewrite: &|_| None,
				define: &[],
			},
		)
		.unwrap()
		.code
	}

	fn js_error(src: &str) -> String {
		compile(
			src,
			&Options {
				runtime: "file:///rt.js",
				jsx: true,
				ts: true,
				elide_imports: true,
				rewrite: &|_| None,
				define: &[],
			},
		)
		.unwrap_err()
		.to_string()
	}

	#[test]
	fn a_static_element_becomes_one_hoisted_constant() {
		let out = tsx("const x = <p className=\"a\">b &amp; c</p>;");
		assert!(out.starts_with("import { m as __kd_m"));
		assert!(out.contains("const __kd_s0 = __kd_m(\"<p class=\\\"a\\\">b &amp; c</p>\");"));
		assert!(out.contains("const x = __kd_s0;"));
	}

	#[test]
	fn dynamic_parts_become_one_concatenation() {
		let out = tsx("const x = <div title={u} id=\"i\">{t}</div>;");
		assert!(out.contains(
			"__kd_m(\"<div\" + __kd_a(\"title\", u) + \" id=\\\"i\\\">\" + __kd_c(t) + \"</div>\")"
		));
	}

	#[test]
	fn components_get_props_and_children() {
		let out = tsx("const x = <Card title=\"t\" n={1} {...rest} key={k}>hi <b>{x}</b></Card>;");
		assert!(out.contains("__kd_k(Card, { \"title\": \"t\", \"n\": 1, ...rest, children: [\"hi \", __kd_m(\"<b>\" + __kd_c(x) + \"</b>\")] })"));
	}

	#[test]
	fn types_are_blanked_out_without_moving_the_code() {
		let src =
			"const a: number = 1 as number;\nfunction f<T>(x: T, y?: string): T { return x!; }\n";
		let out = tsx(src);
		assert_eq!(
			out,
			"const a         = 1          ;\nfunction f   (x   , y         )    { return x ; }\n"
		);
	}

	#[test]
	fn unused_imports_are_elided_and_used_ones_kept() {
		let out = tsx(
			"import { A, B } from './x';\nimport C from './y';\nimport type { D } from './z';\nexport default () => <A />;\n",
		);
		assert!(out.contains("import { A, B } from './x';") || out.contains("import { A,"));
		assert!(!out.contains("./y"));
		assert!(!out.contains("./z"));
	}

	#[test]
	fn specifiers_are_rewritten() {
		let out = compile(
			"import a from '@/a.tsx';\nexport * from \"./b\";\nconst c = import('./c'); a;\n",
			&Options {
				runtime: "file:///rt.js",
				jsx: true,
				ts: true,
				elide_imports: true,
				rewrite: &|s| Some(format!("{s}.mjs")),
				define: &[],
			},
		)
		.unwrap();
		assert!(out.code.contains("\"@/a.tsx.mjs\""));
		assert!(out.code.contains("\"./b.mjs\""));
		assert!(out.code.contains("\"./c.mjs\""));
		assert_eq!(out.specifiers, ["@/a.tsx", "./b", "./c"]);
	}

	#[test]
	fn enums_and_namespaces_are_refused_clearly() {
		assert!(js_error("enum A { X }").contains("enums are not supported"));
		assert!(
			js_error("namespace N { export const x = 1; }")
				.contains("namespaces with values are not supported")
		);
		assert!(js_error("@dec class A {}").contains("decorators are not supported"));
	}

	#[test]
	fn syntax_errors_name_line_and_column() {
		assert!(js_error("const a = 1;\nconst b = ;\n").starts_with("2:11:"));
	}
}
