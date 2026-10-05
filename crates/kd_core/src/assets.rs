//! Styles and scripts: the files of the input tree that are not pages.
//!
//! Discovery follows `styles.files` / `scripts.files` (minus their `ignore`)
//! and mirrors the input tree into the output tree with the extension
//! `.css` / `.js`. A script that matches `pages.files` is a page, not a
//! script: the default `scripts.files` matches `.tsx` too, and a component
//! must not be bundled as a browser script just because it is not a page of
//! its own.

use std::collections::{BTreeMap, HashMap};

use kd_config::Config;
use kd_site::Dirs;

use crate::compile_globs;

/// What an asset is built into.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AssetKind {
	Style,
	Script,
}

impl AssetKind {
	/// The name used in the report and in messages.
	#[must_use]
	pub fn as_str(self) -> &'static str {
		match self {
			AssetKind::Style => "style",
			AssetKind::Script => "script",
		}
	}

	/// The extension of the output file.
	#[must_use]
	pub fn extension(self) -> &'static str {
		match self {
			AssetKind::Style => ".css",
			AssetKind::Script => ".js",
		}
	}
}

/// One style or script and where it is written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Asset {
	pub kind: AssetKind,
	pub input_path: String,
	pub output_path: String,
	/// The input path relative to the input directory, for `targets`.
	pub rel: String,
}

/// Finds the assets of one kind.
///
/// # Errors
///
/// A message when the input directory cannot be read, a glob is invalid, or
/// an asset would be written over its own source.
///
/// # Example
///
/// ```no_run
/// let loaded = kd_core::load("/site/kamado.config.jsonc").unwrap();
/// let scripts = kd_core::assets::discover(&loaded.config, kd_core::assets::AssetKind::Script).unwrap();
/// for s in &scripts {
///     println!("{} -> {}", s.input_path, s.output_path);
/// }
/// ```
pub fn discover(config: &Config, kind: AssetKind) -> Result<Vec<Asset>, String> {
	let (files, ignore) = match kind {
		AssetKind::Style => (&config.styles.files, &config.styles.ignore),
		AssetKind::Script => (&config.scripts.files, &config.scripts.ignore),
	};
	let files = compile_globs(files)?;
	let ignore = compile_globs(ignore)?;
	let page_files = compile_globs(&config.pages.files)?;
	let found = kd_site::discover(&config.dir.input, &files, &ignore)
		.map_err(|e| format!("cannot read input directory {}: {e}", config.dir.input))?;

	// The output directory inside the input directory is not a source.
	let output_rel = kd_site::path::relative(&config.dir.input, &config.dir.output);
	let output_inside_input = !output_rel.is_empty() && !output_rel.starts_with("..");

	let dirs = Dirs {
		input_dir: &config.dir.input,
		output_dir: &config.dir.output,
		output_extension: kind.extension(),
	};
	let mut assets = Vec::with_capacity(found.len());
	for rel in found {
		if output_inside_input && (rel == output_rel || rel.starts_with(&format!("{output_rel}/")))
		{
			continue;
		}
		if kind == AssetKind::Script && page_files.iter().any(|p| p.matches(&rel)) {
			continue;
		}
		let input_path = format!("{}/{rel}", config.dir.input.trim_end_matches('/'));
		let file = kd_site::page_file(&input_path, &dirs);
		if file.output_path == file.input_path {
			return Err(format!(
				"{}: its output path is the file itself; the build would overwrite the source",
				file.input_path
			));
		}
		assets.push(Asset {
			kind,
			input_path: file.input_path,
			output_path: file.output_path,
			rel,
		});
	}
	let mut seen: HashMap<&str, &str> = HashMap::new();
	for a in &assets {
		if let Some(first) = seen.insert(&a.output_path, &a.input_path) {
			return Err(format!(
				"{} and {} would both be written to {}",
				first, a.input_path, a.output_path
			));
		}
	}
	Ok(assets)
}

/// The options that every script shares, resolved against the project root.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScriptSettings {
	pub alias: BTreeMap<String, String>,
	pub define: BTreeMap<String, String>,
	pub target: String,
	pub minify: bool,
	pub sourcemap: bool,
	/// The banner comment, or `None` when disabled.
	pub banner: Option<String>,
}

/// An alias target that starts with `.` or `/` is a path (resolved against the
/// project root); anything else is a package name for esbuild to resolve.
fn resolve_alias_target(root: &str, target: &str) -> String {
	if target.starts_with('.') || target.starts_with('/') {
		kd_site::path::join(root, target)
	} else {
		target.to_owned()
	}
}

impl ScriptSettings {
	/// Reads the settings from the config. `serving` turns on `onServer`
	/// source maps; `banner` is the already rendered banner.
	#[must_use]
	pub fn new(config: &Config, serving: bool, banner: Option<String>) -> ScriptSettings {
		let s = &config.scripts;
		ScriptSettings {
			alias: s
				.alias
				.iter()
				.map(|(k, v)| (k.clone(), resolve_alias_target(&config.root_dir, v)))
				.collect(),
			define: s.define.clone(),
			target: s.target.clone(),
			minify: s.minify,
			sourcemap: sourcemap_enabled(s.sourcemap, serving),
			banner,
		}
	}

	/// The part of the request that does not change from script to script.
	#[must_use]
	pub fn to_json(&self) -> kd_jsonc::Value {
		use kd_jsonc::Value;
		let map = |m: &BTreeMap<String, String>| {
			Value::Object(
				m.iter()
					.map(|(k, v)| (k.clone(), Value::String(v.clone())))
					.collect(),
			)
		};
		Value::Object(vec![
			("alias".to_owned(), map(&self.alias)),
			("define".to_owned(), map(&self.define)),
			("target".to_owned(), Value::String(self.target.clone())),
			("minify".to_owned(), Value::Bool(self.minify)),
			("sourcemap".to_owned(), Value::Bool(self.sourcemap)),
			(
				"banner".to_owned(),
				self.banner
					.as_ref()
					.map_or(Value::Null, |b| Value::String(b.clone())),
			),
		])
	}
}

/// `onServer` source maps are written only while serving.
#[must_use]
pub fn sourcemap_enabled(setting: kd_config::Sourcemap, serving: bool) -> bool {
	match setting {
		kd_config::Sourcemap::On => true,
		kd_config::Sourcemap::Off => false,
		kd_config::Sourcemap::OnServer => serving,
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	fn site(name: &str) -> String {
		let root = format!(
			"{}/kd_assets_{name}_{}",
			std::env::temp_dir().display(),
			std::process::id()
		)
		.replace("//", "/");
		let _ = fs::remove_dir_all(&root);
		fs::create_dir_all(format!("{root}/src/js/lib")).unwrap();
		fs::create_dir_all(format!("{root}/src/css")).unwrap();
		root
	}

	fn config(root: &str, extra: &str) -> Config {
		kd_config::parse(
			&format!(r#"{{ "dir": {{ "input": "src", "output": "out" }}{extra} }}"#),
			root,
			None,
		)
		.unwrap()
	}

	#[test]
	fn scripts_mirror_the_tree_and_leave_pages_alone() {
		let root = site("scripts");
		fs::write(format!("{root}/src/js/app.ts"), "export {};").unwrap();
		fs::write(format!("{root}/src/js/lib/util.mjs"), "export {};").unwrap();
		fs::write(
			format!("{root}/src/index.tsx"),
			"export default () => null;",
		)
		.unwrap();
		fs::write(format!("{root}/src/js/skip.js"), "").unwrap();
		let c = config(&root, r#", "scripts": { "ignore": ["**/skip.js"] }"#);
		let found = discover(&c, AssetKind::Script).unwrap();
		let outs: Vec<(&str, &str)> = found
			.iter()
			.map(|a| (a.rel.as_str(), &a.output_path[root.len() + 1..]))
			.collect();
		assert_eq!(
			outs,
			[
				("js/app.ts", "out/js/app.js"),
				("js/lib/util.mjs", "out/js/lib/util.js")
			]
		);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn styles_become_css_and_the_output_directory_is_not_a_source() {
		let root = site("styles");
		fs::write(format!("{root}/src/css/main.css"), "a{}").unwrap();
		fs::create_dir_all(format!("{root}/src/out")).unwrap();
		fs::write(format!("{root}/src/out/built.css"), "a{}").unwrap();
		let c = kd_config::parse(
			r#"{ "dir": { "input": "src", "output": "src/out" } }"#,
			&root,
			None,
		)
		.unwrap();
		let found = discover(&c, AssetKind::Style).unwrap();
		assert_eq!(found.len(), 1);
		assert_eq!(found[0].rel, "css/main.css");
		assert!(found[0].output_path.ends_with("/src/out/css/main.css"));
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn two_sources_for_one_output_are_an_error() {
		let root = site("collision");
		fs::write(format!("{root}/src/js/a.ts"), "").unwrap();
		fs::write(format!("{root}/src/js/a.js"), "").unwrap();
		let c = config(&root, "");
		let e = discover(&c, AssetKind::Script).unwrap_err();
		assert!(e.contains("would both be written to"), "{e}");
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn alias_paths_are_resolved_against_the_root_and_packages_are_kept() {
		let root = site("alias");
		let c = config(
			&root,
			r#", "scripts": { "alias": { "@": "./src/js", "lodash": "lodash-es" }, "sourcemap": "onServer" }"#,
		);
		let build = ScriptSettings::new(&c, false, None);
		assert_eq!(build.alias["@"], format!("{root}/src/js"));
		assert_eq!(build.alias["lodash"], "lodash-es");
		assert!(!build.sourcemap);
		assert!(ScriptSettings::new(&c, true, Some("/* b */".to_owned())).sourcemap);
		assert_eq!(
			build.to_json().get("target").and_then(|t| t.as_str()),
			Some("es2022")
		);
		let _ = fs::remove_dir_all(&root);
	}
}
