//! Compiling the page modules: every TypeScript / JSX / JavaScript file that a
//! JSX page (or a layout) imports is compiled by `kd_js` into a module of
//! its own, in a directory that mirrors the source tree, and Node loads the
//! results; imports between them are rewritten to point at each other.
//!
//! Why modules and not one bundle per page: a layout shared by 100000 pages
//! is compiled once, Node's module cache keeps one instance of it, and a
//! change to one file recompiles that file only.
//!
//! The directory is inside the project (`node_modules/.cache/...`) so that
//! imports of npm packages from the compiled modules resolve the way they do
//! from the sources.
//!
//! Every file read is recorded with its fingerprint (the bytes that were
//! compiled), so a page's dependencies are the whole import closure.

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::sync::{Arc, Mutex};

const CODE_EXTENSIONS: [&str; 7] = [".tsx", ".ts", ".mts", ".jsx", ".js", ".mjs", ".json"];

/// A compiled module.
#[derive(Debug)]
pub(crate) struct Compiled {
	/// The module Node loads (absolute path).
	pub out_path: String,
	/// The fingerprint of the source that was compiled.
	pub dep: kd_build::Dep,
	/// The local files this one imports (absolute source paths).
	pub imports: Vec<String>,
	pub has_default_export: bool,
}

/// The compiler of one build: a cache of compiled modules.
pub(crate) struct Modules {
	root_dir: String,
	out_dir: String,
	runtime: String,
	/// `(prefix, absolute directory)`, longest prefix first.
	alias: Vec<(String, String)>,
	/// `pages.define`: names and the expressions that replace them.
	define: Vec<(String, String)>,
	state: Mutex<HashMap<String, Arc<Compiled>>>,
}

fn is_file(path: &str) -> bool {
	fs::metadata(path).is_ok_and(|m| m.is_file())
}

fn write_if_changed(path: &str, bytes: &[u8]) -> Result<(), String> {
	if fs::read(path).is_ok_and(|existing| existing == bytes) {
		return Ok(());
	}
	if let Some(parent) = std::path::Path::new(path).parent() {
		fs::create_dir_all(parent)
			.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
	}
	// Modules are compiled on several threads, and two that share an import
	// write the same file with the same bytes; that is harmless because nobody
	// reads the files before the compile phase is over. A temporary file and a
	// rename would make it atomic, and cost twice the directory operations:
	// with tens of thousands of new files they are what the phase waits for.
	fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"))
}

impl Modules {
	/// `root_dir` is the project directory; compiled modules go to
	/// `<root_dir>/node_modules/.cache/kamado-v3/jsx`. `runtime` is the file
	/// URL of the JSX runtime.
	pub(crate) fn new(
		root_dir: &str,
		runtime: &str,
		alias: &std::collections::BTreeMap<String, String>,
		define: &std::collections::BTreeMap<String, String>,
	) -> Modules {
		// A relative target is relative to the project directory, not to the
		// directory the build happens to run in.
		let mut alias: Vec<(String, String)> = alias
			.iter()
			.map(|(k, v)| {
				(
					k.trim_end_matches('/').to_owned(),
					kd_site::path::join(root_dir, v),
				)
			})
			.collect();
		alias.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
		Modules {
			root_dir: root_dir.trim_end_matches('/').to_owned(),
			out_dir: format!(
				"{}/node_modules/.cache/kamado-v3/jsx",
				root_dir.trim_end_matches('/')
			),
			runtime: runtime.to_owned(),
			alias,
			define: define.iter().map(|(k, v)| (k.clone(), v.clone())).collect(),
			state: Mutex::new(HashMap::new()),
		}
	}

	fn out_path_for(&self, src: &str) -> String {
		let rel = match src.strip_prefix(&format!("{}/", self.root_dir)) {
			Some(rel) => rel.to_owned(),
			None => format!("__outside__/{}", src.trim_start_matches('/')),
		};
		if src.ends_with(".json") {
			format!("{}/{rel}", self.out_dir)
		} else {
			format!("{}/{rel}.mjs", self.out_dir)
		}
	}

	/// The source file a specifier written in `from_dir` names, or `None`
	/// for anything that is not a local file (npm packages, `node:`, URLs).
	fn resolve(&self, from_dir: &str, specifier: &str) -> Result<Option<String>, String> {
		let alias = self.alias.iter().find(|(prefix, _)| {
			specifier == prefix
				|| specifier
					.strip_prefix(prefix.as_str())
					.is_some_and(|rest| rest.starts_with('/'))
		});
		let base = if specifier.starts_with("./") || specifier.starts_with("../") {
			kd_site::path::join(from_dir, specifier)
		} else if let Some((prefix, dir)) = alias {
			kd_site::path::join(dir, specifier[prefix.len()..].trim_start_matches('/'))
		} else if specifier.starts_with('/') {
			kd_site::path::normalize(specifier)
		} else {
			return Ok(None);
		};
		let base = base.trim_end_matches('/').to_owned();
		if is_file(&base) {
			return Ok(Some(base));
		}
		// An extensionless import, and `./x.js` that means `x.ts`.
		let stem = base
			.strip_suffix(".js")
			.or_else(|| base.strip_suffix(".jsx"))
			.or_else(|| base.strip_suffix(".mjs"));
		let mut candidates: Vec<String> = CODE_EXTENSIONS
			.iter()
			.map(|e| format!("{base}{e}"))
			.collect();
		if let Some(stem) = stem {
			candidates.extend([".tsx", ".ts", ".mts"].iter().map(|e| format!("{stem}{e}")));
		}
		candidates.extend(CODE_EXTENSIONS.iter().map(|e| format!("{base}/index{e}")));
		candidates
			.into_iter()
			.find(|c| is_file(c))
			.map(Some)
			.ok_or_else(|| {
				format!(
					"cannot find {specifier:?} (looked for {base} and with the extensions {})",
					CODE_EXTENSIONS.join(", ")
				)
			})
	}

	/// Compiles `src` and everything it imports; the entry's result.
	///
	/// # Errors
	///
	/// A message with `path:line:column` for a syntax error, or the import
	/// that cannot be resolved.
	pub(crate) fn compile(&self, src: &str) -> Result<Arc<Compiled>, String> {
		self.compile_walk(src, false)
	}

	/// Like [`Modules::compile`], but also follows the imports of modules that
	/// were compiled before. A build compiles each module once and trusts the
	/// cache; after [`Modules::refresh`] some module of a cached closure may be
	/// missing, and only a walk through the cached modules finds it.
	pub(crate) fn compile_closure(&self, src: &str) -> Result<Arc<Compiled>, String> {
		self.compile_walk(src, true)
	}

	fn compile_walk(&self, src: &str, through_cached: bool) -> Result<Arc<Compiled>, String> {
		let mut queue = vec![src.to_owned()];
		let mut visited: HashSet<String> = HashSet::new();
		let mut entry: Option<Arc<Compiled>> = None;
		while let Some(next) = queue.pop() {
			if !visited.insert(next.clone()) {
				continue;
			}
			let cached = self.lock().get(&next).cloned();
			let compiled = match cached {
				Some(done) => {
					if through_cached {
						queue.extend(done.imports.iter().cloned());
					}
					done
				}
				None => {
					let compiled = Arc::new(self.compile_one(&next)?);
					self.lock().insert(next.clone(), Arc::clone(&compiled));
					queue.extend(compiled.imports.iter().cloned());
					compiled
				}
			};
			if entry.is_none() {
				entry = Some(compiled);
			}
		}
		Ok(entry.expect("the entry was compiled or cached"))
	}

	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Compiled>>> {
		self.state.lock().unwrap_or_else(|e| e.into_inner())
	}

	fn compile_one(&self, src: &str) -> Result<Compiled, String> {
		let (bytes, dep) =
			kd_build::read_with_fingerprint(src).map_err(|e| format!("cannot read {src}: {e}"))?;
		let out_path = self.out_path_for(src);
		if src.ends_with(".json") {
			write_if_changed(&out_path, &bytes)?;
			return Ok(Compiled {
				out_path,
				dep,
				imports: Vec::new(),
				has_default_export: true,
			});
		}
		let text =
			String::from_utf8(bytes).map_err(|_| format!("{src}: file is not valid UTF-8"))?;
		let from_dir = kd_site::path::dirname(src);
		let out_dir = kd_site::path::dirname(&out_path);
		let imports: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let errors: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let rewrite = |specifier: &str| -> Option<String> {
			match self.resolve(&from_dir, specifier) {
				Err(e) => {
					errors.borrow_mut().push(format!("{src}: {e}"));
					None
				}
				Ok(None) => None,
				Ok(Some(path)) => {
					if !CODE_EXTENSIONS.iter().any(|e| path.ends_with(e)) {
						errors.borrow_mut().push(format!(
							"{src}: {specifier:?} is not a TypeScript, JavaScript or JSON file; only those can be imported"
						));
						return None;
					}
					let target = self.out_path_for(&path);
					imports.borrow_mut().push(path);
					let rel = kd_site::path::relative(&out_dir, &target);
					Some(if rel.starts_with('.') {
						rel
					} else {
						format!("./{rel}")
					})
				}
			}
		};
		let is_ts = src.ends_with(".ts") || src.ends_with(".tsx") || src.ends_with(".mts");
		let output = kd_js::compile(
			&text,
			&kd_js::Options {
				runtime: &self.runtime,
				jsx: src.ends_with(".tsx") || src.ends_with(".jsx"),
				ts: is_ts,
				elide_imports: is_ts,
				rewrite: &rewrite,
				define: &self.define,
			},
		)
		.map_err(|e| format!("{src}:{e}"))?;
		if let Some(first) = errors.into_inner().into_iter().next() {
			return Err(first);
		}
		write_if_changed(&out_path, output.code.as_bytes())?;
		let mut seen = HashSet::new();
		let imports: Vec<String> = imports
			.into_inner()
			.into_iter()
			.filter(|p| seen.insert(p.clone()))
			.collect();
		Ok(Compiled {
			out_path,
			dep,
			imports,
			has_default_export: output.has_default_export,
		})
	}

	/// Forgets the compiled modules in the closure of `src` whose source has
	/// changed, so that the next [`Modules::compile`] compiles them again (the
	/// dev server calls this before every request). Returns whether any
	/// module was forgotten.
	pub(crate) fn refresh(&self, src: &str) -> bool {
		let fingerprinter = kd_build::Fingerprinter::new();
		let mut state = self.lock();
		let mut seen = HashSet::new();
		let mut stale = Vec::new();
		let mut stack = vec![src.to_owned()];
		while let Some(path) = stack.pop() {
			if !seen.insert(path.clone()) {
				continue;
			}
			if let Some(compiled) = state.get(&path) {
				if !fingerprinter.unchanged(&path, &compiled.dep) {
					stale.push(path.clone());
				}
				stack.extend(compiled.imports.iter().cloned());
			}
		}
		for path in &stale {
			state.remove(path);
		}
		!stale.is_empty()
	}

	/// The fingerprints of `src` and every file it imports, transitively.
	pub(crate) fn closure(&self, src: &str) -> BTreeMap<String, kd_build::Dep> {
		let state = self.lock();
		let mut out = BTreeMap::new();
		let mut stack = vec![src.to_owned()];
		while let Some(path) = stack.pop() {
			if out.contains_key(&path) {
				continue;
			}
			if let Some(compiled) = state.get(&path) {
				out.insert(path, compiled.dep.clone());
				stack.extend(compiled.imports.iter().cloned());
			}
		}
		out
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::collections::BTreeMap;

	struct Dir(String);

	impl Dir {
		fn new(name: &str) -> Dir {
			let path = kd_site::path::normalize(&format!(
				"{}/kd_core_jsx_{name}_{}",
				std::env::temp_dir().display(),
				std::process::id()
			));
			let _ = fs::remove_dir_all(&path);
			fs::create_dir_all(&path).unwrap();
			Dir(path)
		}

		fn write(&self, rel: &str, text: &str) -> String {
			let p = format!("{}/{rel}", self.0);
			fs::create_dir_all(std::path::Path::new(&p).parent().unwrap()).unwrap();
			fs::write(&p, text).unwrap();
			p
		}
	}

	impl Drop for Dir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn modules(dir: &Dir) -> Modules {
		Modules::new(
			&dir.0,
			"file:///runtime.js",
			&BTreeMap::from([("@".to_owned(), format!("{}/src/lib", dir.0))]),
			&BTreeMap::new(),
		)
	}

	#[test]
	fn a_page_and_what_it_imports_are_compiled_into_a_mirrored_tree() {
		let dir = Dir::new("tree");
		let page = dir.write(
			"src/a/index.tsx",
			"import { Card } from '../components/card';\nimport data from '../data.json';\nimport { x } from '@/util';\nimport fs from 'node:fs';\nexport default () => <Card n={x} d={data} f={fs} />;\n",
		);
		dir.write(
			"src/components/card.tsx",
			"import type { P } from './types';\nexport const Card = (p: any) => <b>{p.n}</b>;\n",
		);
		dir.write(
			"src/components/types.ts",
			"export type P = { n: number };\n",
		);
		dir.write("src/data.json", "{ \"a\": 1 }");
		dir.write("src/lib/util.ts", "export const x: number = 1;\n");
		let m = modules(&dir);
		let compiled = m.compile(&page).unwrap();
		assert!(compiled.has_default_export);
		assert_eq!(
			compiled.out_path,
			format!(
				"{}/node_modules/.cache/kamado-v3/jsx/src/a/index.tsx.mjs",
				dir.0
			)
		);
		let out = fs::read_to_string(&compiled.out_path).unwrap();
		assert!(out.contains("from \"../components/card.tsx.mjs\""));
		assert!(out.contains("from \"../data.json\" with { type: \"json\" }"));
		assert!(out.contains("from \"../lib/util.ts.mjs\""));
		assert!(out.contains("from 'node:fs'"));
		let card = fs::read_to_string(format!(
			"{}/node_modules/.cache/kamado-v3/jsx/src/components/card.tsx.mjs",
			dir.0
		))
		.unwrap();
		// The type-only import is gone and `types.ts` is not needed at run time.
		assert!(!card.contains("./types"));
		assert!(
			fs::metadata(format!(
				"{}/node_modules/.cache/kamado-v3/jsx/src/data.json",
				dir.0
			))
			.is_ok()
		);
		// The closure lists the page and every file that was compiled for it.
		let files: Vec<String> = m
			.closure(&page)
			.keys()
			.map(|p| p.strip_prefix(&format!("{}/", dir.0)).unwrap().to_owned())
			.collect();
		assert_eq!(
			files,
			[
				"src/a/index.tsx",
				"src/components/card.tsx",
				"src/data.json",
				"src/lib/util.ts"
			]
		);
	}

	#[test]
	fn imports_that_form_a_cycle_do_not_loop() {
		let dir = Dir::new("cycle");
		let a = dir.write(
			"a.ts",
			"import { b } from './b'; export const a = () => b;\n",
		);
		dir.write(
			"b.ts",
			"import { a } from './a'; export const b = () => a;\n",
		);
		let m = modules(&dir);
		m.compile(&a).unwrap();
		assert_eq!(m.closure(&a).len(), 2);
	}

	#[test]
	fn index_files_and_the_js_for_ts_convention_resolve() {
		let dir = Dir::new("resolve");
		let page = dir.write(
			"page.tsx",
			"import a from './dir';\nimport b from './b.js';\nexport default () => [a, b];\n",
		);
		dir.write("dir/index.tsx", "export default 1;\n");
		dir.write("b.ts", "export default 2;\n");
		let m = modules(&dir);
		let out_path = m.compile(&page).unwrap().out_path.clone();
		let out = fs::read_to_string(out_path).unwrap();
		assert!(out.contains("\"./dir/index.tsx.mjs\""));
		assert!(out.contains("\"./b.ts.mjs\""));
	}

	#[test]
	fn unresolvable_and_unsupported_imports_name_the_file_and_the_specifier() {
		let dir = Dir::new("errors");
		let page = dir.write("p.tsx", "import './missing';\nexport default () => null;\n");
		let err = modules(&dir).compile(&page).unwrap_err();
		assert!(err.contains("p.tsx: cannot find \"./missing\""), "{err}");

		let page = dir.write(
			"q.tsx",
			"import './style.css';\nexport default () => null;\n",
		);
		dir.write("style.css", "a{}");
		let err = modules(&dir).compile(&page).unwrap_err();
		assert!(err.contains("only those can be imported"), "{err}");

		let page = dir.write("r.tsx", "const a = ;\n");
		let err = modules(&dir).compile(&page).unwrap_err();
		assert!(err.contains("r.tsx:1:11:"), "{err}");
	}

	#[test]
	fn an_unchanged_module_is_not_rewritten() {
		let dir = Dir::new("stable");
		let page = dir.write("p.tsx", "export default () => <p>x</p>;\n");
		let out = modules(&dir).compile(&page).unwrap().out_path.clone();
		let before = fs::metadata(&out).unwrap().modified().unwrap();
		std::thread::sleep(std::time::Duration::from_millis(20));
		modules(&dir).compile(&page).unwrap();
		assert_eq!(fs::metadata(&out).unwrap().modified().unwrap(), before);
	}

	#[test]
	fn a_relative_alias_target_is_relative_to_the_project_and_define_replaces_globals() {
		let dir = Dir::new("alias-define");
		dir.write(
			"src/lib/mode.ts",
			"export const mode = DEBUG ? 'dev' : 'prod';\n",
		);
		let page = dir.write(
			"src/p.tsx",
			"import { mode } from '@/mode';\nexport default () => <p>{mode}{process.env.NODE_ENV}</p>;\n",
		);
		let modules = Modules::new(
			&dir.0,
			"file:///runtime.js",
			&BTreeMap::from([("@".to_owned(), "./src/lib".to_owned())]),
			&BTreeMap::from([
				("DEBUG".to_owned(), "false".to_owned()),
				(
					"process.env.NODE_ENV".to_owned(),
					"\"production\"".to_owned(),
				),
			]),
		);

		let compiled = modules.compile(&page).unwrap();

		assert_eq!(compiled.imports, [format!("{}/src/lib/mode.ts", dir.0)]);
		let page_js = fs::read_to_string(&compiled.out_path).unwrap();
		assert!(page_js.contains("\"production\""), "{page_js}");
		let mode_js = fs::read_to_string(modules.out_path_for(&compiled.imports[0])).unwrap();
		assert!(mode_js.contains("false ? 'dev' : 'prod'"), "{mode_js}");
	}
}
