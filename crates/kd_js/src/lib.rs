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

/// The names the compiled code takes from the runtime (`import { <names> }`).
pub const RUNTIME_NAMES: &str = codegen::IMPORT_NAMES;

/// A module that [`compile_function`]'s code receives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModuleRef {
	/// The specifier to import it by (what `rewrite` made of the one written).
	pub specifier: String,
	/// It is JSON, which Node loads only with the attribute `type: "json"`.
	pub json: bool,
}

/// The result of [`compile_function`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FunctionOutput {
	/// An async arrow function that takes the namespaces of `modules`, in
	/// order, and returns `{ default }` (what the module exported as default):
	/// `async (__kd_mods) => { ...; return { default: Page }; }`. It uses the
	/// runtime's names (`RUNTIME_NAMES`) as free variables.
	pub code: String,
	pub modules: Vec<ModuleRef>,
	/// The module specifiers of the source, as written (like [`Output`]).
	pub specifiers: Vec<String>,
	pub meta: Option<(usize, usize)>,
	pub has_default_export: bool,
}

/// Compiles `src` as the body of a function instead of a module, so that many
/// modules can share one file: loading a file costs far more than calling a
/// function (Node's loader reads, resolves and links every module it imports,
/// which for a site of tens of thousands of pages is most of the time it
/// takes to render them).
///
/// `None` when the source cannot be one: it re-exports (`export * from`,
/// `export { a } from`), uses `import.meta`, imports a module only for its
/// effects, or starts with a hashbang. The caller compiles it as a module.
///
/// Imports become bindings taken from the namespaces passed in, hoisted to the
/// top as imports are; `export default` becomes the `default` of the result;
/// every other export is dropped (the host never reads them) and what it
/// declares stays a local. Specifiers are written by `rewrite`; line numbers
/// of the code are the ones of the source.
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
/// let out = kd_js::compile_function(
///     "import { Card } from './card';\nexport default () => <Card />;\n",
///     &options,
/// )
/// .unwrap()
/// .unwrap();
/// assert_eq!(out.modules[0].specifier, "./card");
/// assert!(out.code.starts_with("async (__kd_mods) => { const { Card } = __kd_mods[0];"));
/// assert!(out.code.ends_with("return { default: __kd_default };\n}"));
/// ```
pub fn compile_function(
	src: &str,
	options: &Options<'_>,
) -> Result<Option<FunctionOutput>, SyntaxError> {
	let parsed = parser::Parser::parse(src, options.jsx, options.ts)?;
	let info = &parsed.info;
	if info.reexports || info.import_meta || src.starts_with("#!") {
		return Ok(None);
	}
	// An import that has no bindings (`import "x"`) is there for its effects.
	let declared: HashSet<usize> = parsed.decls.iter().map(|d| d.record).collect();
	if parsed
		.imports
		.iter()
		.enumerate()
		.any(|(i, r)| r.kind == ast::ImportKind::Static && !declared.contains(&i))
	{
		return Ok(None);
	}
	let mut edits: Vec<Edit> = parsed.edits;
	if !options.define.is_empty() {
		edits.extend(define::edits(
			src,
			&parsed.refs,
			&parsed.shorthand,
			options.define,
		));
	}

	// Imports: the bindings that are used, taken from the namespaces.
	let used: HashSet<&str> = parsed.refs.iter().map(|&(s, e)| &src[s..e]).collect();
	let elide = options.ts && options.elide_imports;
	let mut modules: Vec<ModuleRef> = Vec::new();
	let mut bindings = String::new();
	for decl in &parsed.decls {
		let kept: Vec<&ast::ImportBinding> = decl
			.bindings
			.iter()
			.filter(|b| !elide || used.contains(b.local.as_str()))
			.collect();
		// Blank, keeping the line breaks, so that the lines after it stay put.
		edits.push(Edit {
			start: decl.start,
			end: decl.end,
			kind: EditKind::Erase,
		});
		if kept.is_empty() {
			continue;
		}
		let record = &parsed.imports[decl.record];
		let specifier =
			(options.rewrite)(&record.specifier).unwrap_or_else(|| record.specifier.clone());
		let json = specifier.ends_with(".json") || record.attributes;
		let index = match modules
			.iter()
			.position(|m| m.specifier == specifier && m.json == json)
		{
			Some(i) => i,
			None => {
				modules.push(ModuleRef { specifier, json });
				modules.len() - 1
			}
		};
		let mut named: Vec<String> = Vec::new();
		for b in kept {
			match b.kind {
				ast::BindingKind::Default => {
					bindings.push_str(&format!("const {} = __kd_mods[{index}].default; ", b.local));
				}
				ast::BindingKind::Namespace => {
					bindings.push_str(&format!("const {} = __kd_mods[{index}]; ", b.local));
				}
				ast::BindingKind::Named => {
					let imported = b.imported.as_deref().unwrap_or(&b.local);
					named.push(if imported == b.local {
						b.local.clone()
					} else if is_identifier(imported) {
						format!("{imported}: {}", b.local)
					} else {
						format!("{}: {}", strings::quote(imported), b.local)
					});
				}
			}
		}
		if !named.is_empty() {
			bindings.push_str(&format!(
				"const {{ {} }} = __kd_mods[{index}]; ",
				named.join(", ")
			));
		}
	}
	// `import()` is an expression and stays; its specifier is written by the host.
	for record in &parsed.imports {
		if record.kind != ast::ImportKind::Dynamic {
			continue;
		}
		let rewritten = (options.rewrite)(&record.specifier);
		let specifier = rewritten.as_deref().unwrap_or(&record.specifier);
		let json_attributes = specifier.ends_with(".json") && !record.attributes;
		if rewritten.is_none() && !json_attributes {
			continue;
		}
		let mut text = strings::quote(specifier);
		if json_attributes {
			text.push_str(", { with: { type: \"json\" } }");
		}
		edits.push(Edit {
			start: record.start,
			end: record.end,
			kind: EditKind::Replace(text),
		});
	}

	// Exports.
	let default_value = match &info.default_export {
		Some(d) => match (&d.name, d.is_declaration) {
			(Some(name), true) => {
				edits.push(Edit {
					start: d.start,
					end: d.end,
					kind: EditKind::Erase,
				});
				Some(name.clone())
			}
			_ => {
				edits.push(Edit {
					start: d.start,
					end: d.end,
					kind: EditKind::Replace("const __kd_default =".to_owned()),
				});
				if d.is_declaration {
					// A function or class expression needs the `;` its
					// declaration did not.
					edits.push(Edit {
						start: d.stmt_end,
						end: d.stmt_end,
						kind: EditKind::Replace(";".to_owned()),
					});
				}
				Some("__kd_default".to_owned())
			}
		},
		None => None,
	};
	for &(start, end) in info.export_keywords.iter().chain(&info.export_clauses) {
		edits.push(Edit {
			start,
			end,
			kind: EditKind::Erase,
		});
	}

	let mut applier = codegen::Applier::new(src, edits);
	let body = applier.render(0, src.len());
	let hoisted = applier.hoisted_constants();
	let mut code = String::with_capacity(body.len() + bindings.len() + hoisted.len() + 96);
	code.push_str("async (__kd_mods) => { ");
	code.push_str(&bindings);
	if !hoisted.is_empty() {
		code.push_str(&hoisted);
		code.push(' ');
	}
	code.push_str(&body);
	match default_value {
		Some(name) => code.push_str(&format!("\nreturn {{ default: {name} }};\n}}")),
		None => code.push_str("\nreturn {};\n}"),
	}
	Ok(Some(FunctionOutput {
		code,
		modules,
		specifiers: parsed.imports.iter().map(|r| r.specifier.clone()).collect(),
		meta: parsed.info.meta,
		has_default_export: parsed.info.has_default_export,
	}))
}

/// Whether `name` can be a property name without quotes.
fn is_identifier(name: &str) -> bool {
	let mut chars = name.chars();
	chars
		.next()
		.is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
		&& chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
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
	fn the_children_of_html_and_head_are_a_thunk_so_that_their_scope_is_seen() {
		// `<html static>` and `<head hoist={false}>` change how what is inside is
		// written, so the runtime must call the children after it set that up.
		let out =
			tsx("const x = <html static><head hoist={false}><title>{t}</title></head></html>;");
		assert!(out.contains("__kd_el(\"html\", { \"static\": true }, () => "));
		assert!(out.contains("__kd_el(\"head\", { \"hoist\": false }, () => "));
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

	fn function_of(src: &str) -> Option<FunctionOutput> {
		compile_function(
			src,
			&Options {
				runtime: "file:///rt.js",
				jsx: true,
				ts: true,
				elide_imports: true,
				rewrite: &|s| s.strip_prefix("@/").map(|r| format!("file:///lib/{r}.mjs")),
				define: &[],
			},
		)
		.unwrap()
	}

	#[test]
	fn a_page_becomes_a_function_that_takes_its_modules() {
		let out = function_of(
			"import { Card, Box as B } from './card';\nimport Layout from '@/layout';\nimport * as all from './card';\nimport type { P } from './types';\nexport const meta = { title: 'T' };\nconst n: number = 1;\nexport default function Page() { return <Card n={n}><B/><Layout/>{all.x}</Card>; }\n",
		)
		.unwrap();
		assert_eq!(
			out.modules,
			[
				ModuleRef {
					specifier: "./card".to_owned(),
					json: false
				},
				ModuleRef {
					specifier: "file:///lib/layout.mjs".to_owned(),
					json: false
				},
			]
		);
		assert!(out.code.starts_with(
			"async (__kd_mods) => { const { Card, Box: B } = __kd_mods[0]; const Layout = __kd_mods[1].default; const all = __kd_mods[0]; "
		));
		// What an export declares stays, as a local; the export itself is gone.
		assert!(out.code.contains("       const meta = { title: 'T' };"));
		assert!(
			out.code.contains("\n               function Page()"),
			"{}",
			out.code
		);
		assert!(out.code.ends_with("\nreturn { default: Page };\n}"));
		assert!(!out.code.contains("export") && !out.code.contains("import "));
		assert!(out.has_default_export);
		assert_eq!(out.specifiers, ["./card", "@/layout", "./card"]);
		// The lines of the source stay where they were.
		let body_start = out.code.find("\n").unwrap();
		assert!(
			out.code[..body_start].matches("const ").count() >= 3,
			"the bindings are on the first line"
		);
		// Seven lines in the source, one for the `return` and one for the closing brace.
		assert_eq!(out.code.matches('\n').count(), 7 + 2, "{}", out.code);
	}

	#[test]
	fn the_default_export_may_be_an_expression_or_an_anonymous_declaration() {
		let arrow = function_of("export default () => <p>x</p>;\n").unwrap();
		assert!(arrow.code.contains("const __kd_default = () =>"));
		assert!(arrow.code.ends_with("return { default: __kd_default };\n}"));

		let anonymous = function_of("export default function () { return 1 }\nfoo();\n").unwrap();
		assert!(
			anonymous
				.code
				.contains("const __kd_default = function () { return 1 };")
		);

		let class = function_of("export default class Page {}\n").unwrap();
		assert!(class.code.contains("class Page {}"));
		assert!(class.code.ends_with("return { default: Page };\n}"));

		let none = function_of("export const a = 1;\nexport { a as b };\n").unwrap();
		assert!(!none.has_default_export);
		assert!(none.code.ends_with("\nreturn {};\n}"));
		assert!(!none.code.contains("export"));
	}

	#[test]
	fn unused_imports_are_not_taken_and_json_is_marked() {
		let out = function_of(
			"import { A, B } from './x';\nimport C from './y';\nimport data from './d.json' with { type: 'json' };\nexport default () => <A d={data} />;\n",
		)
		.unwrap();
		assert_eq!(
			out.modules
				.iter()
				.map(|m| (m.specifier.as_str(), m.json))
				.collect::<Vec<_>>(),
			[("./x", false), ("./d.json", true)]
		);
		assert!(
			out.code
				.contains("const { A } = __kd_mods[0]; const data = __kd_mods[1].default;")
		);
		assert!(!out.code.contains("const C"));
	}

	#[test]
	fn what_cannot_be_a_function_is_left_to_the_module_compiler() {
		assert!(function_of("export * from './a';\n").is_none());
		assert!(function_of("export { a } from './a';\n").is_none());
		assert!(function_of("console.log(import.meta.url);\n").is_none());
		assert!(function_of("import './side-effect';\nexport default 1;\n").is_none());
		assert!(function_of("#!/usr/bin/env node\nexport default 1;\n").is_none());
		// A dynamic import is an expression and stays.
		let out = function_of("export default async () => (await import('@/a')).x;\n").unwrap();
		assert!(out.code.contains("import(\"file:///lib/a.mjs\")"));
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
