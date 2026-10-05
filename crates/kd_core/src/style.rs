//! Building one stylesheet: `@import`s are inlined, the banner is put in
//! front, and the whole is minified, in the order v2's style compiler ran
//! postcss-import and cssnano over `banner + "\n" + css`.
//!
//! The banner is an important comment (`/*! ... */`) so that minification
//! keeps it.

use std::collections::BTreeMap;

use kd_build::Dep;

use crate::style_import;

/// What every stylesheet of a build shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleSettings {
	/// `(prefix, absolute directory)` for `@import "prefix/..."`.
	pub alias: Vec<(String, String)>,
	/// The banner comment, or `None` when disabled.
	pub banner: Option<String>,
	pub minify: bool,
}

impl StyleSettings {
	/// Reads the settings from the config; `banner` is the already rendered
	/// banner. A relative alias target is relative to the project directory.
	#[must_use]
	pub fn new(config: &kd_config::Config, banner: Option<String>) -> StyleSettings {
		let s = &config.styles;
		StyleSettings {
			alias: s
				.alias
				.iter()
				.map(|(k, v)| {
					(
						k.trim_end_matches('/').to_owned(),
						kd_site::path::join(&config.root_dir, v),
					)
				})
				.collect(),
			banner,
			minify: s.minify,
		}
	}
}

/// A built stylesheet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Built {
	pub css: String,
	/// Fingerprints of every file that was read (and of the candidates that
	/// were probed and missing).
	pub deps: BTreeMap<String, Dep>,
}

/// Builds the stylesheet `input`.
///
/// # Errors
///
/// A message naming the file for an import that cannot be resolved or read,
/// or for CSS that cannot be minified.
///
/// # Example
///
/// ```no_run
/// let settings = kd_core::style::StyleSettings {
///     alias: Vec::new(),
///     banner: Some("/*! rev. 2026-01-01 */".to_owned()),
///     minify: true,
/// };
/// let built = kd_core::style::build("/site/src/css/main.css", &settings).unwrap();
/// assert!(built.css.starts_with("/*! rev. 2026-01-01 */"));
/// ```
pub fn build(input: &str, settings: &StyleSettings) -> Result<Built, String> {
	let bundle = style_import::bundle(input, &settings.alias)?;
	let source = match &settings.banner {
		Some(banner) if !banner.is_empty() => format!("{banner}\n{}", bundle.css),
		_ => bundle.css,
	};
	let css = if settings.minify {
		kd_css::minify(&source).map_err(|e| format!("{input}: {e}"))?
	} else {
		source
	};
	Ok(Built {
		css,
		deps: bundle.deps,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	struct Dir(String);

	impl Dir {
		fn new(name: &str) -> Dir {
			let root = format!(
				"{}/kd_style_{name}_{}",
				std::env::temp_dir().display(),
				std::process::id()
			)
			.replace("//", "/");
			let _ = fs::remove_dir_all(&root);
			fs::create_dir_all(&root).unwrap();
			Dir(root)
		}

		fn write(&self, rel: &str, text: &str) -> String {
			let path = format!("{}/{rel}", self.0);
			fs::create_dir_all(std::path::Path::new(&path).parent().unwrap()).unwrap();
			fs::write(&path, text).unwrap();
			path
		}
	}

	impl Drop for Dir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn imports_are_inlined_then_the_whole_is_minified_with_the_banner_in_front() {
		let dir = Dir::new("build");
		dir.write("base.css", "a { color : white }\n");
		let main = dir.write("main.css", "@import 'base.css';\nb { margin : 0px 0px }\n");
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: Some("/*!\nrev. 2026-01-02\n*/".to_owned()),
			minify: true,
		};

		let built = build(&main, &settings).unwrap();

		assert_eq!(
			built.css,
			"/*!\nrev. 2026-01-02\n*/a{color:#fff}b{margin:0}"
		);
		assert!(built.deps.contains_key(&format!("{}/base.css", dir.0)));
		assert!(built.deps.contains_key(&main));
	}

	#[test]
	fn without_minify_the_bundle_is_kept_as_it_is_and_without_a_banner_nothing_is_added() {
		let dir = Dir::new("plain");
		let main = dir.write("main.css", "a  { color : white }\n");
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: false,
		};

		assert_eq!(
			build(&main, &settings).unwrap().css,
			"a  { color : white }\n"
		);
	}

	#[test]
	fn an_unresolvable_import_names_the_file() {
		let dir = Dir::new("missing");
		let main = dir.write("main.css", "@import './gone.css';\n");
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: true,
		};

		let e = build(&main, &settings).unwrap_err();

		assert!(e.starts_with(&format!("{main}: cannot resolve")), "{e}");
	}
}
