//! A CSS minifier for kamado, standing in for cssnano's default preset and for
//! the clean-css that html-minifier-terser runs on `<style>` elements and
//! `style` attributes.
//!
//! The layers, each usable on its own:
//! - [`token`]: a CSS Syntax Level 3 tokenizer whose tokens tile the input,
//! - [`parse`]: a forgiving parser to a small tree with source offsets,
//! - [`value`]: the value parser the rewrite rules are written against,
//! - [`selector`], [`params`], [`values`] and the modules under them: the
//!   rewrite rules, ported from cssnano's plugins,
//! - [`minify`](fn@minify), [`minify_declarations`] and
//!   [`minify_media_query`]: what the HTML minifier and the style compiler call.
//!
//! The contract is "equal to a browser": the output means what the input
//! meant, and where cssnano does something that could change what a browser
//! does, this crate does less. Output is kept within a few percent of
//! cssnano's size; `crates/kd_css/tests` and `scripts/check-css.mjs` measure
//! both. Not ported (a size cost, never a safety one): `calc()` constant
//! folding, merging of adjacent rules and of longhands, `reduce-initial`,
//! svgo on inline SVG, reordering of shorthand components.

mod color_table;
mod property_table;

pub mod calc;
pub mod color;
pub mod fonts;
mod merge;
mod minify;
pub mod numeric;
pub mod ordered;
pub mod params;
pub mod parse;
pub mod print;
pub mod selector;
pub mod strings;
pub mod token;
pub mod value;
pub mod values;

pub use minify::Error;

/// Minifies a whole style sheet: what a `.css` file or a `<style>` element
/// holds. `/*! ... */` comments are kept.
///
/// # Example
///
/// ```
/// let out = kd_css::minify("a { color : white }  /* x */  b { margin : 0px }").unwrap();
/// assert_eq!(out, "a{color:#fff}b{margin:0}");
/// ```
pub fn minify(source: &str) -> Result<String, Error> {
	minify::minify_stylesheet(source)
}

/// Like [`minify`], and also tells where every rule, at-rule and declaration
/// of the output started in `source` (byte offsets, in output order): the raw
/// material of a source map.
///
/// # Example
///
/// ```
/// let (css, marks) = kd_css::minify_with_marks("a { color : white }\nb { margin : 0px }").unwrap();
/// assert_eq!(css, "a{color:#fff}b{margin:0}");
/// assert_eq!((marks[0].out, marks[0].src), (0, 0));
/// assert_eq!((marks[2].out, marks[2].src), (13, 20));
/// ```
pub fn minify_with_marks(source: &str) -> Result<(String, Vec<print::Mark>), Error> {
	let mut marks = Vec::new();
	let css = minify::minify_stylesheet_marked(source, Some(&mut marks))?;
	Ok((css, marks))
}

/// Minifies the declarations of a `style` attribute (`color: red;  margin :
/// 0px`), which have no braces.
///
/// # Example
///
/// ```
/// let out = kd_css::minify_declarations("color: red;  margin : 0px").unwrap();
/// assert_eq!(out, "color:red;margin:0");
/// ```
pub fn minify_declarations(source: &str) -> Result<String, Error> {
	minify::minify_declaration_list(source)
}

/// Minifies a media query list as found in a `media` attribute.
///
/// # Example
///
/// ```
/// assert_eq!(kd_css::minify_media_query("screen  and (min-width: 100px)"), "screen and (min-width:100px)");
/// ```
pub fn minify_media_query(source: &str) -> String {
	params::minify_media_query_text(source)
}
