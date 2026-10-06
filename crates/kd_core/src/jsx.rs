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
	/// Files that were looked for and not found before the ones imports
	/// resolved to (`./card` found as `card.ts` was not `card.tsx`). Creating
	/// one of them changes what the import means, so they are dependencies.
	pub missing: Vec<String>,
	pub has_default_export: bool,
	/// `out_path` exists. A page compiled as a function (see
	/// [`Modules::compile_page_code`]) has none: nobody imports a page, and
	/// one that is imported is compiled again as a module.
	pub file_written: bool,
}

/// How a page is compiled for rendering in a build.
pub(crate) enum PageCode {
	/// A function, to be put into a chunk with others (see `kd_js::compile_function`).
	Function {
		code: String,
		modules: Vec<kd_js::ModuleRef>,
		compiled: Arc<Compiled>,
	},
	/// A module file, which the renderer imports.
	Module(Arc<Compiled>),
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
	/// Sources that were read already, with their fingerprints, by path. A
	/// module takes its entry out when it is compiled.
	prefetched: Mutex<HashMap<String, (String, kd_build::Dep)>>,
}

/// A file URL for an absolute path, with what a URL cannot hold escaped.
pub(crate) fn file_url(path: &str) -> String {
	let mut url = String::with_capacity(path.len() + 8);
	url.push_str("file://");
	for &b in path.as_bytes() {
		if b.is_ascii_alphanumeric() || b"-._~/".contains(&b) {
			url.push(b as char);
		} else {
			url.push_str(&format!("%{b:02X}"));
		}
	}
	url
}

fn is_file(path: &str) -> bool {
	fs::metadata(path).is_ok_and(|m| m.is_file())
}

/// Writes `bytes` to `path` unless the file already has them.
///
/// Why `create_new` first: on a first build every module is new, and asking
/// whether the file has these bytes (opening it to read) before creating it
/// doubles the number of opens, which is what a file system with a slow
/// `open` spends its time on. A file that exists is read and compared.
pub(crate) fn write_if_changed(path: &str, bytes: &[u8]) -> Result<(), String> {
	use std::io::{ErrorKind, Write};
	// Modules are compiled on several threads, and two that share an import
	// write the same file with the same bytes; that is harmless because nobody
	// reads the files before the compile phase is over. A temporary file and a
	// rename would make it atomic, and cost twice the directory operations:
	// with tens of thousands of new files they are what the phase waits for.
	let create = || {
		std::fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(path)
	};
	let mut file = match create() {
		Ok(file) => file,
		Err(e) if e.kind() == ErrorKind::AlreadyExists => {
			if fs::read(path).is_ok_and(|existing| existing == bytes) {
				return Ok(());
			}
			return fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"));
		}
		Err(e) if e.kind() == ErrorKind::NotFound => {
			if let Some(parent) = std::path::Path::new(path).parent() {
				fs::create_dir_all(parent)
					.map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
			}
			match create() {
				Ok(file) => file,
				// Another thread made it in the meantime.
				Err(e) if e.kind() == ErrorKind::AlreadyExists => {
					return fs::write(path, bytes).map_err(|e| format!("cannot write {path}: {e}"));
				}
				Err(e) => return Err(format!("cannot write {path}: {e}")),
			}
		}
		Err(e) => return Err(format!("cannot write {path}: {e}")),
	};
	file.write_all(bytes)
		.map_err(|e| format!("cannot write {path}: {e}"))
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
			prefetched: Mutex::new(HashMap::new()),
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
	///
	/// The second value lists the candidates tried before the one found.
	fn resolve(
		&self,
		from_dir: &str,
		specifier: &str,
	) -> Result<Option<(String, Vec<String>)>, String> {
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
			return Ok(Some((base, Vec::new())));
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
		let mut missing = vec![base.clone()];
		for candidate in candidates {
			if is_file(&candidate) {
				return Ok(Some((candidate, missing)));
			}
			missing.push(candidate);
		}
		Err(format!(
			"cannot find {specifier:?} (looked for {base} and with the extensions {})",
			CODE_EXTENSIONS.join(", ")
		))
	}

	/// Compiles `src` and everything it imports; the entry's result.
	///
	/// # Errors
	///
	/// A message with `path:line:column` for a syntax error, or the import
	/// that cannot be resolved.
	pub(crate) fn compile(&self, src: &str) -> Result<Arc<Compiled>, String> {
		self.compile_walk(src, false, None)
	}

	/// Like [`Modules::compile`], but also follows the imports of modules that
	/// were compiled before. A build compiles each module once and trusts the
	/// cache; after [`Modules::refresh`] some module of a cached closure may be
	/// missing, and only a walk through the cached modules finds it.
	pub(crate) fn compile_closure(&self, src: &str) -> Result<Arc<Compiled>, String> {
		self.compile_walk(src, true, None)
	}

	/// Compiles `src` and what it imports. `preset` is the entry when it was
	/// compiled already (as a function): only its imports are walked.
	fn compile_walk(
		&self,
		src: &str,
		through_cached: bool,
		preset: Option<Arc<Compiled>>,
	) -> Result<Arc<Compiled>, String> {
		let mut queue = vec![src.to_owned()];
		let mut visited: HashSet<String> = HashSet::new();
		let mut entry: Option<Arc<Compiled>> = None;
		// Why modules are published only when the walk is over: a module in the
		// shared table is trusted to have its imports in it too. Publishing one
		// before its imports are compiled lets another thread take it from the
		// table and see an incomplete closure, so a page would miss a
		// dependency and stay stale after the dependency changes.
		let mut fresh: HashMap<String, Arc<Compiled>> = HashMap::new();
		if let Some(preset) = preset {
			queue = preset.imports.clone();
			visited.insert(src.to_owned());
			fresh.insert(src.to_owned(), Arc::clone(&preset));
			entry = Some(preset);
		}
		while let Some(next) = queue.pop() {
			if !visited.insert(next.clone()) {
				continue;
			}
			let cached = match fresh.get(&next) {
				Some(done) => Some(done.clone()),
				None => self.lock().get(&next).cloned(),
			};
			// A page that was compiled as a function has no file to import.
			let cached = cached.filter(|done| done.file_written);
			let compiled = match cached {
				Some(done) => {
					if through_cached {
						queue.extend(done.imports.iter().cloned());
					}
					done
				}
				None => {
					let compiled = Arc::new(self.compile_one(&next)?);
					fresh.insert(next.clone(), Arc::clone(&compiled));
					queue.extend(compiled.imports.iter().cloned());
					compiled
				}
			};
			if entry.is_none() {
				entry = Some(compiled);
			}
		}
		if !fresh.is_empty() {
			self.lock().extend(fresh);
		}
		Ok(entry.expect("the entry was compiled or cached"))
	}

	fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Compiled>>> {
		self.state.lock().unwrap_or_else(|e| e.into_inner())
	}

	fn compile_one(&self, src: &str) -> Result<Compiled, String> {
		let prefetched = self
			.prefetched
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.remove(src);
		let (bytes, dep) = match prefetched {
			Some((text, dep)) => (text.into_bytes(), dep),
			None => kd_build::read_with_fingerprint(src)
				.map_err(|e| format!("cannot read {src}: {e}"))?,
		};
		let out_path = self.out_path_for(src);
		if src.ends_with(".json") {
			write_if_changed(&out_path, &bytes)?;
			return Ok(Compiled {
				out_path,
				dep,
				imports: Vec::new(),
				missing: Vec::new(),
				has_default_export: true,
				file_written: true,
			});
		}
		let text =
			String::from_utf8(bytes).map_err(|_| format!("{src}: file is not valid UTF-8"))?;
		let imports: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let missing: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let errors: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let rewrite = self.rewriter(src, &out_path, false, &imports, &missing, &errors);
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
		drop(rewrite);
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
			missing: {
				let mut seen = HashSet::new();
				missing
					.into_inner()
					.into_iter()
					.filter(|p| seen.insert(p.clone()))
					.collect()
			},
			has_default_export: output.has_default_export,
			file_written: true,
		})
	}

	/// The file URL of the JSX runtime.
	pub(crate) fn runtime(&self) -> &str {
		&self.runtime
	}

	/// Where the chunks of pages are written.
	pub(crate) fn chunk_dir(&self) -> String {
		format!("{}/__chunks__", self.out_dir)
	}

	/// What `rewrite` writes for the specifiers of `src`: where the module they
	/// name will be, relative to `out_path` (or, with `absolute`, as a file
	/// URL, for code that does not live next to its imports). What it resolves
	/// goes into `imports`, the candidates it did not find into `missing` and
	/// what it cannot resolve into `errors`.
	fn rewriter<'a>(
		&'a self,
		src: &'a str,
		out_path: &'a str,
		absolute: bool,
		imports: &'a RefCell<Vec<String>>,
		missing: &'a RefCell<Vec<String>>,
		errors: &'a RefCell<Vec<String>>,
	) -> impl Fn(&str) -> Option<String> + 'a {
		let from_dir = kd_site::path::dirname(src);
		let out_dir = kd_site::path::dirname(out_path);
		move |specifier: &str| -> Option<String> {
			match self.resolve(&from_dir, specifier) {
				Err(e) => {
					errors.borrow_mut().push(format!("{src}: {e}"));
					None
				}
				Ok(None) => None,
				Ok(Some((path, tried))) => {
					if !CODE_EXTENSIONS.iter().any(|e| path.ends_with(e)) {
						errors.borrow_mut().push(format!(
							"{src}: {specifier:?} is not a TypeScript, JavaScript or JSON file; only those can be imported"
						));
						return None;
					}
					let target = self.out_path_for(&path);
					imports.borrow_mut().push(path);
					missing.borrow_mut().extend(tried);
					if absolute {
						return Some(file_url(&target));
					}
					let rel = kd_site::path::relative(&out_dir, &target);
					Some(if rel.starts_with('.') {
						rel
					} else {
						format!("./{rel}")
					})
				}
			}
		}
	}

	/// Compiles a page for rendering in a build: as a function when it can be
	/// one, else as a module. The modules it imports are compiled as files.
	///
	/// Why: a page compiled to its own file is created by the compiler and then
	/// opened, read, resolved and linked by Node, and for tens of thousands of
	/// pages those file operations are most of the time the build takes; a
	/// function costs a call (see `kd_js::compile_function`).
	pub(crate) fn compile_page_code(&self, src: &str) -> Result<PageCode, String> {
		if !(src.ends_with(".tsx") || src.ends_with(".jsx")) {
			return self.compile(src).map(PageCode::Module);
		}
		let prefetched = self
			.prefetched
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.remove(src);
		let (text, dep) = match prefetched {
			Some(read) => read,
			None => {
				let (bytes, dep) = kd_build::read_with_fingerprint(src)
					.map_err(|e| format!("cannot read {src}: {e}"))?;
				let text = String::from_utf8(bytes)
					.map_err(|_| format!("{src}: file is not valid UTF-8"))?;
				(text, dep)
			}
		};
		let out_path = self.out_path_for(src);
		let imports: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let missing: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let errors: RefCell<Vec<String>> = RefCell::new(Vec::new());
		let rewrite = self.rewriter(src, &out_path, true, &imports, &missing, &errors);
		let compiled = kd_js::compile_function(
			&text,
			&kd_js::Options {
				runtime: &self.runtime,
				jsx: true,
				ts: src.ends_with(".tsx"),
				elide_imports: src.ends_with(".tsx"),
				rewrite: &rewrite,
				define: &self.define,
			},
		)
		.map_err(|e| format!("{src}:{e}"))?;
		drop(rewrite);
		if let Some(first) = errors.into_inner().into_iter().next() {
			return Err(first);
		}
		let Some(function) = compiled else {
			// Not expressible as a function: compile it as a module (from the text
			// that was read).
			self.prefetch(src, text, dep);
			return self.compile(src).map(PageCode::Module);
		};
		let dedupe = |paths: Vec<String>| {
			let mut seen = HashSet::new();
			paths
				.into_iter()
				.filter(|p| seen.insert(p.clone()))
				.collect::<Vec<_>>()
		};
		let entry = Arc::new(Compiled {
			out_path,
			dep,
			imports: dedupe(imports.into_inner()),
			missing: dedupe(missing.into_inner()),
			has_default_export: function.has_default_export,
			file_written: false,
		});
		let compiled = self.compile_walk(src, false, Some(Arc::clone(&entry)))?;
		Ok(PageCode::Function {
			code: function.code,
			modules: function.modules,
			compiled,
		})
	}

	/// Gives the compiler the text of `path` and its fingerprint, which the
	/// caller read already: the file is not read again when it is compiled.
	pub(crate) fn prefetch(&self, path: &str, text: String, dep: kd_build::Dep) {
		self.prefetched
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.insert(path.to_owned(), (text, dep));
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
				for candidate in &compiled.missing {
					out.entry(candidate.clone())
						.or_insert_with(kd_build::Dep::missing);
				}
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
	fn threads_compiling_a_shared_chain_all_see_the_whole_closure() {
		let dir = Dir::new("shared-chain");
		let depth = 30;
		for i in 0..depth {
			let next = if i + 1 < depth {
				format!("import {{ f{} }} from './m{}';\n", i + 1, i + 1)
			} else {
				String::new()
			};
			dir.write(
				&format!("src/m{i}.ts"),
				&format!("{next}export const f{i} = {i};\n"),
			);
		}
		let pages: Vec<String> = (0..16)
			.map(|p| {
				dir.write(
					&format!("src/p{p}.tsx"),
					"import { f0 } from './m0';\nexport default () => <p>{f0}</p>;\n",
				)
			})
			.collect();
		let m = modules(&dir);
		let last = format!("{}/src/m{}.ts", dir.0, depth - 1);
		std::thread::scope(|scope| {
			for page in &pages {
				let (m, last) = (&m, &last);
				scope.spawn(move || {
					m.compile(page).unwrap();
					assert!(
						m.closure(page).contains_key(last),
						"the deepest module is in the closure of {page}"
					);
				});
			}
		});
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
		// The closure lists the page and every file that was compiled for it,
		// and the candidates that were tried before the file an import resolved to
		// (`./card` is `card.tsx`, so a file named `card` would have won).
		let closure = m.closure(&page);
		let existing: Vec<String> = closure
			.iter()
			.filter(|(_, dep)| **dep != kd_build::Dep::missing())
			.map(|(p, _)| p.strip_prefix(&format!("{}/", dir.0)).unwrap().to_owned())
			.collect();
		assert_eq!(
			existing,
			[
				"src/a/index.tsx",
				"src/components/card.tsx",
				"src/data.json",
				"src/lib/util.ts"
			]
		);
		let absent: Vec<String> = closure
			.iter()
			.filter(|(_, dep)| **dep == kd_build::Dep::missing())
			.map(|(p, _)| p.strip_prefix(&format!("{}/", dir.0)).unwrap().to_owned())
			.collect();
		assert_eq!(
			absent,
			["src/components/card", "src/lib/util", "src/lib/util.tsx"]
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
		let present = m
			.closure(&a)
			.values()
			.filter(|dep| **dep != kd_build::Dep::missing())
			.count();
		assert_eq!(present, 2);
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
