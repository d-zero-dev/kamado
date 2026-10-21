//! Building one stylesheet: `@import`s are inlined, the banner is put in
//! front, and the whole is minified, in the order v2's style compiler ran
//! postcss-import and cssnano over `banner + "\n" + css`.
//!
//! The banner is an important comment (`/*! ... */`) so that minification
//! keeps it.
//!
//! Without minification the bundle is written as it is, except that the
//! `@custom-media` are resolved all the same: v2 ran postcss-custom-media on
//! every build, and no browser knows the at-rule yet.
//!
//! A source map, when asked for, is appended as an inline comment. It maps
//! every rule and declaration of the output to its place in the file it was
//! written in, through the bundler's record of where each run of the bundle
//! came from. Granularity is the rule and the declaration, not the token;
//! without minification, the line and each part the `@custom-media` rewrote.

use std::collections::BTreeMap;

use kd_build::Dep;

use crate::sourcemap::{self, Point, Source};
use crate::style_import::{self, Bundle};

/// What every stylesheet of a build shares.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StyleSettings {
	/// `(prefix, absolute directory)` for `@import "prefix/..."`.
	pub alias: Vec<(String, String)>,
	/// The banner comment, or `None` when disabled.
	pub banner: Option<String>,
	pub minify: bool,
	/// Append an inline source map.
	pub sourcemap: bool,
}

impl StyleSettings {
	/// Reads the settings from the config; `banner` is the already rendered
	/// banner. A relative alias target is relative to the project directory.
	/// `serving` turns on source maps set to `onServer`.
	#[must_use]
	pub fn new(config: &kd_config::Config, banner: Option<String>, serving: bool) -> StyleSettings {
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
			sourcemap: crate::assets::sourcemap_enabled(s.sourcemap, serving),
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
	/// A message for each statement of the sources that was left out (see
	/// [`crate::style_import::Bundle::warnings`]), for the build report.
	pub warnings: Vec<String>,
}

/// Builds the stylesheet `input`, which is written to `output` (that is where
/// the paths in a source map start from).
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
///     sourcemap: false,
/// };
/// let built = kd_core::style::build("/site/src/css/main.css", "/site/out/css/main.css", &settings).unwrap();
/// assert!(built.css.starts_with("/*! rev. 2026-01-01 */"));
/// ```
pub fn build(input: &str, output: &str, settings: &StyleSettings) -> Result<Built, String> {
	let bundle = style_import::bundle(input, &settings.alias)?;
	let prefix = match &settings.banner {
		Some(banner) if !banner.is_empty() => format!("{banner}\n"),
		_ => String::new(),
	};
	let (head, tail) = bundle.css.split_at(bundle.banner_at);
	let source = format!("{head}{prefix}{tail}");
	let (mut css, marks) = if settings.minify {
		if settings.sourcemap {
			kd_css::minify_with_marks(&source).map_err(|e| format!("{input}: {e}"))?
		} else {
			(
				kd_css::minify(&source).map_err(|e| format!("{input}: {e}"))?,
				Vec::new(),
			)
		}
	} else if settings.sourcemap {
		// Not minified: the source as written, with the custom media resolved
		// (no browser knows `@custom-media` yet).
		kd_css::resolve_custom_media_with_marks(&source)
	} else {
		(kd_css::resolve_custom_media(&source), Vec::new())
	};
	if settings.sourcemap {
		let map = map_of(&css, output, &bundle, prefix.len(), &marks);
		css.push('\n');
		css.push_str(&sourcemap::inline_css_comment(&map));
	}
	Ok(Built {
		css,
		deps: bundle.deps,
		warnings: bundle.warnings,
	})
}

/// The source map of `css`, whose marks refer to the bundle behind a banner
/// of `prefix` bytes.
fn map_of(
	css: &str,
	output: &str,
	bundle: &Bundle,
	prefix: usize,
	marks: &[kd_css::print::Mark],
) -> String {
	let out_dir = kd_site::path::dirname(output);
	let sources: Vec<Source> = bundle
		.files
		.iter()
		.map(|f| Source {
			path: kd_site::path::relative(&out_dir, &f.path),
			text: f.text.clone(),
		})
		.collect();
	let points: Vec<Point> = marks
		.iter()
		.filter_map(|m| {
			// The banner is in no file; it sits at `banner_at` of the bundle.
			let at = if m.src < bundle.banner_at {
				m.src
			} else {
				(m.src - bundle.banner_at).checked_sub(prefix)? + bundle.banner_at
			};
			let i = bundle
				.segments
				.partition_point(|s| s.out <= at)
				.checked_sub(1)?;
			let seg = bundle.segments[i];
			(at < seg.out + seg.len).then_some(Point {
				generated: m.out,
				source: seg.file,
				offset: seg.src + (at - seg.out),
			})
		})
		.collect();
	sourcemap::build(kd_site::path::basename(output), css, &sources, &points)
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
			sourcemap: false,
		};

		let built = build(&main, &format!("{}/out/main.css", dir.0), &settings).unwrap();

		assert_eq!(
			built.css,
			"/*!\nrev. 2026-01-02\n*/a{color:#fff}b{margin:0}"
		);
		assert!(built.deps.contains_key(&format!("{}/base.css", dir.0)));
		assert!(built.deps.contains_key(&main));
	}

	#[test]
	fn a_custom_media_defined_in_an_imported_file_is_resolved_in_the_importing_one() {
		let dir = Dir::new("custom_media");
		dir.write(
			"media.css",
			"@custom-media --narrow (width < 100px);\n@custom-media --l (width < 1px), print;\n",
		);
		dir.write(
			"main.css",
			"@import 'media.css';\n@media (not (--narrow)) { a { top: 0 } }\n@media not (--l) { b { top: 0 } }\n",
		);

		let built = minified(&dir, "main.css");

		assert_eq!(
			built.css,
			"@media (not (width < 100px)){a{top:0}}@media (width < 1px),print{@media not (max-color:2147477350){b{top:0}}}@media not print{@media not all and (width < 1px){@media not (color:2147477350){b{top:0}}}}"
		);
	}

	fn minified(dir: &Dir, main: &str) -> Built {
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: true,
			sourcemap: false,
		};
		build(
			&format!("{}/{main}", dir.0),
			&format!("{}/out/{main}", dir.0),
			&settings,
		)
		.unwrap()
	}

	#[test]
	fn a_remote_import_of_an_imported_file_keeps_the_layer_of_its_import() {
		let dir = Dir::new("remote-layer");
		dir.write(
			"_b.css",
			"@import url('https://example.com/f.css');\n.b { color: blue; }\n",
		);
		dir.write(
			"main.css",
			"@layer x, y;\n@import './_b.css' layer(y);\n.a { color: red; }\n",
		);

		let built = minified(&dir, "main.css");

		assert_eq!(
			built.css,
			"@layer x, y;@import url(\"https://example.com/f.css\") layer(y);@layer y{.b{color:blue}}.a{color:red}"
		);
		assert!(built.warnings.is_empty());
	}

	#[test]
	fn an_import_that_cannot_stand_where_it_is_is_left_out_and_reported() {
		let dir = Dir::new("import-reported");
		dir.write("_b.css", ".b { color: blue; }\n");
		dir.write("_c.css", ".c { color: green; }\n");
		dir.write(
			"main.css",
			"@import './_b.css';\n@layer x;\n@import './_c.css';\n.a { color: red; }\n",
		);

		let built = minified(&dir, "main.css");

		assert_eq!(built.css, "@layer x;.b{color:blue}.a{color:red}");
		assert_eq!(built.warnings.len(), 1);
		assert!(built.warnings[0].contains("must precede all other statements"));
	}

	#[test]
	fn the_charset_and_the_layer_order_hoisted_to_the_top_stay_in_front_of_the_banner() {
		let dir = Dir::new("hoisted");
		dir.write("base.css", "a { color : white }\n");
		let main = dir.write(
			"main.css",
			"@import 'base.css' layer(one);\n@layer two, one;\nb { margin : 0px 0px }\n",
		);
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: Some("/*! v */".to_owned()),
			minify: true,
			sourcemap: false,
		};

		let built = build(&main, &format!("{}/out/main.css", dir.0), &settings).unwrap();

		// Behavior change: `one` is declared before `two`, as the import does, so `@layer one;` is written in front of the order that names `two` first
		assert_eq!(
			built.css,
			"@layer one;@layer two, one;/*! v */@layer one{a{color:#fff}}b{margin:0}"
		);
		// assert_eq!( // previous
		// 	built.css, // previous
		// 	"@layer two, one;/*! v */@layer one{a{color:#fff}}b{margin:0}" // previous
		// ); // previous
	}

	#[test]
	fn without_minify_the_bundle_is_kept_as_it_is_and_without_a_banner_nothing_is_added() {
		let dir = Dir::new("plain");
		let main = dir.write("main.css", "a  { color : white }\n");
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: false,
			sourcemap: false,
		};

		assert_eq!(
			build(&main, &format!("{}/out/main.css", dir.0), &settings)
				.unwrap()
				.css,
			"a  { color : white }\n"
		);
	}

	/// The map of a built stylesheet, decoded.
	fn inline_map(css: &str) -> String {
		let marker = "/*# sourceMappingURL=data:application/json;base64,";
		let encoded = css[css.find(marker).unwrap() + marker.len()..]
			.trim_end()
			.trim_end_matches("*/")
			.trim_end();
		let table = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
		let mut bytes = Vec::new();
		let mut bits = 0u32;
		let mut count = 0;
		for c in encoded.bytes().filter(|&b| b != b'=') {
			bits = (bits << 6) | table.iter().position(|&t| t == c).unwrap() as u32;
			count += 6;
			if count >= 8 {
				count -= 8;
				bytes.push((bits >> count) as u8);
				bits &= (1 << count) - 1;
			}
		}
		String::from_utf8(bytes).unwrap()
	}

	#[test]
	fn the_source_map_points_each_rule_and_declaration_at_the_file_it_was_written_in() {
		let dir = Dir::new("map");
		dir.write("base.css", "a { color : white }\n");
		let main = dir.write("main.css", "@import 'base.css';\nb {\n  margin : 0px\n}\n");
		let output = format!("{}/out/css/main.css", dir.0);
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: true,
			sourcemap: true,
		};

		let built = build(&main, &output, &settings).unwrap();

		// Generated: `a{color:#fff}b{margin:0}` on the first line.
		assert!(
			built.css.starts_with("a{color:#fff}b{margin:0}\n"),
			"{}",
			built.css
		);
		let map = inline_map(&built.css);
		let value = kd_jsonc::parse(&map).unwrap();
		assert_eq!(value.get("file").and_then(|f| f.as_str()), Some("main.css"));
		let sources: Vec<&str> = value
			.get("sources")
			.and_then(|s| s.as_array())
			.unwrap()
			.iter()
			.filter_map(|s| s.as_str())
			.collect();
		assert_eq!(sources, ["../../main.css", "../../base.css"]);
		// (generated column, source, line, column): `a` rule and `color` in
		// base.css; `b` rule and `margin` in main.css.
		let points: Vec<_> = crate::sourcemap::decode(&map)
			.into_iter()
			.map(|(_, c, s, l, sc)| (c, s, l, sc))
			.collect();
		assert_eq!(
			points,
			[(0, 1, 0, 0), (2, 1, 0, 4), (13, 0, 1, 0), (15, 0, 2, 2)]
		);
	}

	#[test]
	fn without_minify_every_line_maps_to_itself_behind_the_banner() {
		let dir = Dir::new("map-plain");
		let main = dir.write("main.css", "a {\n  b: c\n}\n");
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: Some("/*! x */".to_owned()),
			minify: false,
			sourcemap: true,
		};

		let built = build(&main, &format!("{}/main.out.css", dir.0), &settings).unwrap();

		let points: Vec<_> = crate::sourcemap::decode(&inline_map(&built.css))
			.into_iter()
			.map(|(gl, gc, _, sl, sc)| (gl, gc, sl, sc))
			.collect();
		// Generated line 0 is the banner; lines 1-3 are the three source lines.
		assert_eq!(points, [(1, 0, 0, 0), (2, 0, 1, 0), (3, 0, 2, 0)]);
	}

	#[test]
	fn without_minify_or_a_source_map_a_custom_media_of_an_imported_file_is_resolved() {
		let dir = Dir::new("custom_media_no_map");
		dir.write("media.css", "@custom-media --l (width < 1px), print;\n");
		let main = dir.write(
			"main.css",
			"@import 'media.css';\n/* keep */\n@media not (--l) {\n  a { top : 0 }\n}\n",
		);
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: Some("/*! v */".to_owned()),
			minify: false,
			sourcemap: false,
		};

		let built = build(&main, &format!("{}/out/main.css", dir.0), &settings).unwrap();

		assert_eq!(
			built.css,
			"/*! v */\n\n/* keep */\n@media (width < 1px), print { @media not (max-color:2147477350) {\n  a { top : 0 }\n} }\n@media not print { @media not all and (width < 1px) { @media not (color:2147477350) {\n  a { top : 0 }\n} } }\n"
		);
	}

	#[test]
	fn without_minify_a_custom_media_is_resolved_and_each_line_maps_to_where_it_was_written() {
		let dir = Dir::new("custom_media_plain");
		dir.write("media.css", "@custom-media --narrow (width < 100px);\n");
		let main = dir.write(
			"main.css",
			"@import 'media.css';\n@media (--narrow) {\n  a { top: 0 }\n}\n",
		);
		let settings = StyleSettings {
			alias: Vec::new(),
			banner: None,
			minify: false,
			sourcemap: true,
		};

		let built = build(&main, &format!("{}/main.out.css", dir.0), &settings).unwrap();

		let marker = "\n/*# sourceMappingURL=";
		assert_eq!(
			&built.css[..built.css.find(marker).unwrap()],
			"\n@media (width < 100px) {\n  a { top: 0 }\n}\n"
		);
		let points = crate::sourcemap::decode(&inline_map(&built.css));
		// (generated line, column, source, line, column); source 0 is
		// main.css. The blank first line is the end of the line of `@import`,
		// whose definition went; the query is where the reference was.
		assert_eq!(
			points,
			[
				(0, 0, 0, 0, 20),
				(1, 0, 0, 1, 0),
				(1, 7, 0, 1, 7),
				(1, 22, 0, 1, 17),
				(2, 0, 0, 2, 0),
				(3, 0, 0, 3, 0)
			]
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
			sourcemap: false,
		};

		let e = build(&main, &format!("{}/out/main.css", dir.0), &settings).unwrap_err();

		assert!(e.starts_with(&format!("{main}: cannot resolve")), "{e}");
	}
}
