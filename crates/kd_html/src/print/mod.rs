//! HTML formatting: a port of prettier's HTML printer (3.9) with the options
//! kamado v2 used (`parser: html`, `htmlWhitespaceSensitivity: css`), so that
//! formatted pages come out byte for byte as v2's did.
//!
//! The input is a string (what the serializer produced), because prettier
//! formats by re-parsing text with its own parser (angular-html-parser) and
//! reads positions from it. Re-parsing is not a shortcut that can be taken
//! away without changing output: line numbers of the *serialized* text decide
//! where blank lines are kept.
//!
//! What is deliberately not here: prettier formats the code inside `<script>`,
//! `<style>`, `style` attributes and event handler attributes with its CSS and
//! JavaScript printers. v2 minified all of that right afterwards, so what
//! reaches the output is the minifier's, never prettier's; those nodes are
//! printed as written here, and the minify stage replaces them.

pub mod angular;
pub mod ast;
pub mod doc;
mod entity_names;
mod json;
pub mod preprocess;
pub mod printer;
pub mod srcset;
pub mod tables;
pub mod util;

pub use angular::ParseError;
pub use preprocess::WhitespaceSensitivity;

/// Formatting options (prettier's, for HTML), without a print width: nothing
/// wraps for being long (see the module `doc`).
#[derive(Debug, Clone, Copy)]
pub struct Options {
	pub tab_width: usize,
	pub use_tabs: bool,
	pub bracket_same_line: bool,
	pub single_attribute_per_line: bool,
	pub whitespace_sensitivity: WhitespaceSensitivity,
}

impl Default for Options {
	/// What v2 formatted with when no prettier configuration said otherwise:
	/// two-space indentation. Nothing wraps, as it did not at v2's width.
	fn default() -> Self {
		Options {
			tab_width: 2,
			use_tabs: false,
			bracket_same_line: false,
			single_attribute_per_line: false,
			whitespace_sensitivity: WhitespaceSensitivity::Css,
		}
	}
}

/// v2's `doctype` transform: a document that starts with `<html` and has no
/// doctype gets `<!DOCTYPE html>` and a line break in front. An XML
/// declaration (`<?xml ... ?>`) at the start is looked past, as v2 never saw
/// it, and stays first: the doctype goes after it.
///
/// # Example
///
/// ```
/// use kd_html::print::add_doctype;
/// assert_eq!(add_doctype("<html><body></body></html>"), "<!DOCTYPE html>\n<html><body></body></html>");
/// assert_eq!(add_doctype("<!doctype html><html></html>"), "<!doctype html><html></html>");
/// assert_eq!(add_doctype("<p>x</p>"), "<p>x</p>");
/// assert_eq!(
///     add_doctype("<?xml version=\"1.0\"?><html></html>"),
///     "<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html></html>"
/// );
/// ```
#[must_use]
pub fn add_doctype(content: &str) -> String {
	if let Some((declaration, rest)) = crate::parser::split_xml_declaration(content) {
		let lead = &content[..content.len() - declaration.len() - rest.len()];
		let rest = rest.trim_start_matches(crate::parser::is_js_space);
		let added = add_doctype(rest);
		return if added == rest {
			content.to_owned()
		} else {
			format!("{lead}{declaration}\n{added}")
		};
	}
	let trimmed = content.trim_matches(crate::parser::is_js_space);
	let lower_prefix = |n: usize| trimmed.as_bytes().get(..n).map(|b| b.to_ascii_lowercase());
	let starts_html = lower_prefix(5).is_some_and(|b| b == b"<html")
		&& trimmed[5..]
			.chars()
			.next()
			.is_some_and(|c| c == '>' || crate::parser::is_js_space(c));
	let has_doctype = lower_prefix(15).is_some_and(|b| b == b"<!doctype html");
	if starts_html && !has_doctype {
		format!("<!DOCTYPE html>\n{content}")
	} else {
		content.to_owned()
	}
}

/// Formats `source` as prettier's HTML parser and printer would.
///
/// # Errors
///
/// The error prettier would throw for markup its parser rejects.
///
/// # Example
///
/// ```
/// use kd_html::print::{format, Options};
/// let out = format("<div><p>a</p><p>b</p></div>", &Options::default()).unwrap();
/// assert_eq!(out, "<div>\n  <p>a</p>\n  <p>b</p>\n</div>\n");
/// ```
pub fn format(source: &str, options: &Options) -> Result<String, ParseError> {
	const BOM: char = '\u{FEFF}';
	let (bom, body) = match source.strip_prefix(BOM) {
		Some(rest) => (true, rest),
		None => (false, source),
	};
	let text = if body.contains('\r') {
		body.replace("\r\n", "\n").replace('\r', "\n")
	} else {
		body.to_owned()
	};
	let mut tree = ast::build(&text)?;
	preprocess::run(&mut tree, options.whitespace_sensitivity);
	// Nothing but white space: prettier prints nothing at all.
	if tree.node(tree.root).children.is_empty() {
		return Ok(if bom { BOM.to_string() } else { String::new() });
	}
	let mut docs = doc::Docs::new();
	let root = printer::print_root(
		&tree,
		&mut docs,
		printer::Settings {
			tab_width: options.tab_width,
			bracket_same_line: options.bracket_same_line,
			single_attribute_per_line: options.single_attribute_per_line,
		},
	);
	let printed = doc::print(
		&mut docs,
		root,
		doc::PrintOptions {
			tab_width: options.tab_width,
			use_tabs: options.use_tabs,
		},
	);
	Ok(if bom {
		format!("{BOM}{printed}")
	} else {
		printed
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn fmt(src: &str) -> String {
		format(src, &Options::default()).unwrap()
	}

	#[test]
	fn the_doctype_goes_after_an_xml_declaration() {
		assert_eq!(
			add_doctype("<?xml version=\"1.0\"?>\n<html></html>"),
			"<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html></html>"
		);
	}

	#[test]
	fn what_stands_before_an_xml_declaration_is_kept() {
		assert_eq!(
			add_doctype("\u{FEFF}<?xml version=\"1.0\"?><html></html>"),
			"\u{FEFF}<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html></html>"
		);
	}

	#[test]
	fn a_document_with_an_xml_declaration_and_a_doctype_is_formatted() {
		assert_eq!(
			fmt("<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html><body><p>x</p></body></html>"),
			"<?xml version=\"1.0\"?>\n<!DOCTYPE html>\n<html>\n  <body>\n    <p>x</p>\n  </body>\n</html>\n"
		);
	}

	#[test]
	fn an_xml_declaration_in_front_of_a_doctype_or_other_content_changes_nothing() {
		for input in [
			"<?xml version=\"1.0\"?><!doctype html><html></html>",
			"<?xml version=\"1.0\"?><p>x</p>",
			"<?xml-stylesheet href=\"a.css\"?><html></html>",
		] {
			assert_eq!(add_doctype(input), input);
		}
	}

	// Expected values below were produced by prettier 3.9.9 with
	// `parser: "html"`, `printWidth: 100000`.

	#[test]
	fn block_children_go_on_their_own_lines_and_inline_ones_stay_together() {
		assert_eq!(
			fmt(
				"<h1 disabled src=\"x'y\"><article hidden> <ul data-x=\"a\nb\"><li><code>\n  &amp; x<img src=\"y\"> </code></li></ul>\n</article>  <link alt=\"z\"> <!-- c --> </h1>"
			),
			"<h1 disabled src=\"x'y\">\n  <article hidden>\n    <ul\n      data-x=\"a\nb\"\n    >\n      <li>\n        <code> &amp; x<img src=\"y\" /> </code>\n      </li>\n    </ul>\n  </article>\n  <link alt=\"z\" />\n  <!-- c -->\n</h1>\n"
		);
	}

	#[test]
	fn a_line_wider_than_prettiers_100000_is_not_wrapped() {
		// Past that width prettier fills a paragraph over several lines and puts
		// the attributes of a tag on lines of their own; here nothing wraps.
		let words = "word ".repeat(25_000);
		let value = "x".repeat(120_000);
		let out = fmt(&format!("<p>{words}</p><div data-a=\"{value}\">a</div>"));
		assert_eq!(
			out,
			format!(
				"<p>{}</p>\n<div data-a=\"{value}\">a</div>\n",
				words.trim_end()
			)
		);
	}

	#[test]
	fn nothing_but_white_space_prints_nothing() {
		assert_eq!(fmt(""), "");
		assert_eq!(fmt(" \n"), "");
		assert_eq!(fmt("<!-- -->"), "<!-- -->\n");
	}

	#[test]
	fn a_byte_order_mark_and_blank_lines_are_handled() {
		assert_eq!(fmt("\u{FEFF}<p>a</p>\n\n\n"), "\u{FEFF}<p>a</p>\n");
		assert_eq!(fmt("<p>a</p>\n\n\n<p>b</p>"), "<p>a</p>\n\n<p>b</p>\n");
	}

	#[test]
	fn markup_prettier_rejects_is_an_error() {
		assert!(format("<div></span>", &Options::default()).is_err());
		assert!(format("<p>&unknown;</p>", &Options::default()).is_err());
	}

	#[test]
	fn non_ascii_text_before_a_conditional_comment_does_not_shift_it() {
		let out = fmt(
			"<head><title>日本語</title><!--[if lt IE 9]><script src=\"/js/html5shiv.js\"></script><![endif]--></head>",
		);
		assert!(out.contains("<title>日本語</title>"));
		assert!(out.contains("<!--[if lt IE 9]>"));
		assert!(out.contains("<![endif]-->"));
		let out = fmt("<p>日本語</p><!--[if IE]><p>日本語</p><![endif]-->");
		assert!(out.contains("<p>日本語</p>"));
		assert!(out.contains("<!--[if IE]>"));
	}

	#[test]
	fn non_ascii_before_a_conditional_comment_keeps_its_leading_text() {
		let out = fmt("<p>日本語</p><!--[if IE]>please upgrade your browser<![endif]-->");
		assert!(out.contains("<!--[if IE]>please upgrade your browser<![endif]-->"));
	}

	#[test]
	fn non_ascii_before_a_conditional_comment_keeps_its_leading_whitespace_split() {
		let out = fmt(
			"<html lang=\"ja\"><head>\n<title>日本語</title>\n<!--[if lt IE 9]>\n<script src=\"/js/html5shiv.js\"></script>\n<![endif]-->\n</head></html>",
		);
		assert!(out.contains("<!--[if lt IE 9]>"));
		assert!(!out.contains("<!--[if lt IE 9\n"));
	}

	#[test]
	fn markup_nested_too_deep_is_an_error_not_a_stack_overflow() {
		let deep = format!("{}x{}", "<div>".repeat(5000), "</div>".repeat(5000));
		let error = format(&deep, &Options::default()).unwrap_err();
		assert!(error.message.contains("nested deeper than 256"));
		let fine = format!("{}x{}", "<div>".repeat(200), "</div>".repeat(200));
		assert!(format(&fine, &Options::default()).is_ok());
	}

	#[test]
	fn tabs_and_bracket_same_line() {
		let options = Options {
			use_tabs: true,
			bracket_same_line: true,
			..Options::default()
		};
		assert_eq!(
			format("<div><a href=\"x\" title=\"y\">t</a></div>", &options).unwrap(),
			"<div><a href=\"x\" title=\"y\">t</a></div>\n"
		);
		assert_eq!(
			format("<div><p>a</p><p>b</p></div>", &options).unwrap(),
			"<div>\n\t<p>a</p>\n\t<p>b</p>\n</div>\n"
		);
	}
}
