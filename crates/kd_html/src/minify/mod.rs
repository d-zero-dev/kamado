//! A port of html-minifier-terser (7.2) restricted to the way kamado v2 called
//! it: whitespace is never collapsed, comments and optional tags are kept,
//! no attribute quotes are removed, entities are not decoded, and the six
//! options that remain are `collapseBooleanAttributes`,
//! `removeRedundantAttributes`, `removeScriptTypeAttributes`,
//! `removeStyleLinkTypeAttributes`, `minifyCSS` and `minifyJS`.
//!
//! Why a port of the minifier's own HTML parser and not a pass over the
//! tree: its parser is regex based and its output is the product of that
//! parser's quirks (a `<c>` inside `<title>` is a tag to it, a bare `<col>`
//! gets a `<colgroup>`, `<br />` loses its slash, unclosed elements are
//! closed). Matching v2's bytes means matching those.
//!
//! Code minification is not done here: the caller supplies a [`Hooks`] value
//! that minifies CSS and JavaScript (the identity until the minifiers exist).

mod tables;

use std::fmt;

use crate::parser::is_js_space;

/// Options. Everything not listed is fixed at what v2 used.
#[derive(Debug, Clone, Copy)]
pub struct Options {
	pub collapse_boolean_attributes: bool,
	pub remove_redundant_attributes: bool,
	pub remove_script_type_attributes: bool,
	pub remove_style_link_type_attributes: bool,
	pub minify_css: bool,
	pub minify_js: bool,
}

impl Default for Options {
	/// v2's defaults.
	fn default() -> Self {
		Options {
			collapse_boolean_attributes: true,
			remove_redundant_attributes: true,
			remove_script_type_attributes: true,
			remove_style_link_type_attributes: true,
			minify_css: true,
			minify_js: true,
		}
	}
}

/// What a CSS minification is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CssKind {
	/// The text of a `<style>` element.
	Block,
	/// The declarations of a `style` attribute.
	Inline,
	/// The value of a `media` attribute.
	Media,
}

/// The code minifiers.
pub trait Hooks {
	/// Minifies CSS.
	fn css(&self, text: &str, kind: CssKind) -> String;
	/// Minifies JavaScript; `inline` for an event handler attribute.
	fn js(&self, text: &str, inline: bool) -> String;
}

/// Hooks that change nothing.
pub struct NoMinification;

impl Hooks for NoMinification {
	fn css(&self, text: &str, _kind: CssKind) -> String {
		text.to_owned()
	}

	fn js(&self, text: &str, _inline: bool) -> String {
		text.to_owned()
	}
}

/// The minifier gave up on its input (its parser cannot make progress).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MinifyError(pub String);

impl fmt::Display for MinifyError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "Parse Error: {}", self.0)
	}
}

impl std::error::Error for MinifyError {}

// ----- small string helpers -----

fn is_ws(c: char) -> bool {
	matches!(c, ' ' | '\n' | '\r' | '\t' | '\u{0C}')
}

fn trim_whitespace(s: &str) -> &str {
	s.trim_matches(is_ws)
}

/// `collapseWhitespaceAll`: each run of white space (and no-break spaces)
/// becomes one space, except a lone tab, and no-break spaces stay.
fn collapse_whitespace_all(s: &str) -> String {
	let mut out = String::with_capacity(s.len());
	let chars: Vec<char> = s.chars().collect();
	let mut i = 0;
	while i < chars.len() {
		if is_ws(chars[i]) || chars[i] == '\u{A0}' {
			let start = i;
			while i < chars.len() && (is_ws(chars[i]) || chars[i] == '\u{A0}') {
				i += 1;
			}
			let run = &chars[start..i];
			if run == ['\t'] {
				out.push('\t');
				continue;
			}
			let mut in_chunk = false;
			for &c in run {
				if c == '\u{A0}' {
					out.push(c);
					in_chunk = false;
				} else if !in_chunk {
					out.push(' ');
					in_chunk = true;
				}
			}
		} else {
			out.push(chars[i]);
			i += 1;
		}
	}
	out
}

fn js_number_to_string(v: f64) -> String {
	if v.fract() == 0.0 && v.abs() < 1e21 {
		format!("{}", v as i64)
	} else {
		format!("{v}")
	}
}

// ----- the parser's tokens -----

#[derive(Debug, Clone)]
struct Attr {
	name: String,
	/// `None` for a bare attribute that is not a "fill" attribute.
	value: Option<String>,
}

struct StartTag {
	name: String,
	attrs: Vec<Attr>,
	unary_slash: bool,
	/// Bytes consumed.
	len: usize,
}

fn ncname_len(s: &str) -> usize {
	let mut chars = s.char_indices();
	match chars.next() {
		Some((_, c)) if tables::is_name_start(c) => {}
		_ => return 0,
	}
	let mut end = s.chars().next().map_or(0, char::len_utf8);
	for (i, c) in chars {
		if tables::is_name_char(c) {
			end = i + c.len_utf8();
		} else {
			break;
		}
	}
	end
}

/// `((?:ncname:)?ncname)` at the start of `s`.
fn qname_len(s: &str) -> usize {
	let first = ncname_len(s);
	if first == 0 {
		return 0;
	}
	if s[first..].starts_with(':') {
		let second = ncname_len(&s[first + 1..]);
		if second > 0 {
			return first + 1 + second;
		}
	}
	first
}

fn skip_js_ws(s: &str) -> &str {
	s.trim_start_matches(is_js_space)
}

/// One attribute at the start of `input` (`^\s*name(?:\s*=\s*value)?`), as
/// `(bytes consumed, attribute)`.
fn match_attribute(input: &str, fill_attrs: &dyn Fn(&str) -> bool) -> Option<(usize, Attr)> {
	let rest = skip_js_ws(input);
	let lead = input.len() - rest.len();
	let name_end = rest
		.char_indices()
		.find(|&(_, c)| is_js_space(c) || matches!(c, '"' | '\'' | '<' | '>' | '/' | '='))
		.map_or(rest.len(), |(i, _)| i);
	if name_end == 0 {
		return None;
	}
	let name = &rest[..name_end];
	let after_name = &rest[name_end..];
	// optional `\s*=[ \t\n\f\r]*value`
	let after_ws = skip_js_ws(after_name);
	if let Some(after_eq) = after_ws.strip_prefix('=') {
		let value_start = after_eq.trim_start_matches(is_ws);
		let eq_ws = after_eq.len() - value_start.len();
		let consumed_before_value =
			lead + name_end + (after_name.len() - after_ws.len()) + 1 + eq_ws;
		if let Some(rest_q) = value_start.strip_prefix('"')
			&& let Some(close) = rest_q.find('"')
		{
			let value = &rest_q[..close];
			let mut end = 1 + close + 1;
			while value_start[end..].starts_with('"') {
				end += 1;
			}
			return Some((
				consumed_before_value + end,
				Attr {
					name: name.to_owned(),
					value: Some(value.to_owned()),
				},
			));
		}
		if let Some(rest_q) = value_start.strip_prefix('\'')
			&& let Some(close) = rest_q.find('\'')
		{
			let value = &rest_q[..close];
			let mut end = 1 + close + 1;
			while value_start[end..].starts_with('\'') {
				end += 1;
			}
			return Some((
				consumed_before_value + end,
				Attr {
					name: name.to_owned(),
					value: Some(value.to_owned()),
				},
			));
		}
		let unquoted_end = value_start
			.char_indices()
			.find(|&(_, c)| {
				matches!(
					c,
					' ' | '\t' | '\n' | '\u{0C}' | '\r' | '"' | '\'' | '`' | '=' | '<' | '>'
				)
			})
			.map_or(value_start.len(), |(i, _)| i);
		if unquoted_end > 0 {
			return Some((
				consumed_before_value + unquoted_end,
				Attr {
					name: name.to_owned(),
					value: Some(value_start[..unquoted_end].to_owned()),
				},
			));
		}
	}
	// no value (the optional group did not match)
	let value = fill_attrs(name).then(|| name.to_owned());
	Some((
		lead + name_end,
		Attr {
			name: name.to_owned(),
			value,
		},
	))
}

fn parse_start_tag(input: &str, fill_attrs: &dyn Fn(&str) -> bool) -> Option<StartTag> {
	let after_lt = input.strip_prefix('<')?;
	let n = qname_len(after_lt);
	if n == 0 {
		return None;
	}
	let name = after_lt[..n].to_owned();
	let mut consumed = 1 + n;
	let mut attrs = Vec::new();
	loop {
		let rest = &input[consumed..];
		let trimmed = skip_js_ws(rest);
		let slash = trimmed.starts_with('/');
		let after_slash = if slash { &trimmed[1..] } else { trimmed };
		if after_slash.starts_with('>') {
			let end = consumed + (rest.len() - trimmed.len()) + usize::from(slash) + 1;
			return Some(StartTag {
				name,
				attrs,
				unary_slash: slash,
				len: end,
			});
		}
		let (len, attr) = match_attribute(rest, fill_attrs)?;
		consumed += len;
		attrs.push(attr);
	}
}

/// `^</qname[^>]*>` : `(bytes consumed, tag name)`.
fn match_end_tag(input: &str) -> Option<(usize, &str)> {
	let after = input.strip_prefix("</")?;
	let n = qname_len(after);
	if n == 0 {
		return None;
	}
	let close = after[n..].find('>')?;
	Some((2 + n + close + 1, &after[..n]))
}

/// `^<!DOCTYPE\s?[^>]+>` (case-insensitive).
fn match_doctype(input: &str) -> Option<usize> {
	let head = input.get(..9)?;
	if !head.eq_ignore_ascii_case("<!doctype") {
		return None;
	}
	let rest = &input[9..];
	// `\s?` then at least one non-`>`; backtracking lets `\s?` match nothing
	// when the white space is needed by `[^>]+`.
	let close = rest.find('>')?;
	if close == 0 {
		return None;
	}
	Some(9 + close + 1)
}

// ----- the minifier -----

struct Open {
	tag: String,
}

const EMPTY: &[&str] = &[
	"area", "base", "basefont", "br", "col", "embed", "frame", "hr", "img", "input", "isindex",
	"keygen", "link", "meta", "param", "source", "track", "wbr",
];
const CLOSE_SELF: &[&str] = &[
	"colgroup", "dd", "dt", "li", "option", "p", "td", "tfoot", "th", "thead", "tr", "source",
];
const FILL_ATTRS: &[&str] = &[
	"checked", "compact", "declare", "defer", "disabled", "ismap", "multiple", "nohref",
	"noresize", "noshade", "nowrap", "readonly", "selected",
];
const NON_PHRASING: &[&str] = &[
	"address",
	"article",
	"aside",
	"base",
	"blockquote",
	"body",
	"caption",
	"col",
	"colgroup",
	"dd",
	"details",
	"dialog",
	"div",
	"dl",
	"dt",
	"fieldset",
	"figcaption",
	"figure",
	"footer",
	"form",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"head",
	"header",
	"hgroup",
	"hr",
	"html",
	"legend",
	"li",
	"menuitem",
	"meta",
	"ol",
	"optgroup",
	"option",
	"param",
	"rp",
	"rt",
	"source",
	"style",
	"summary",
	"tbody",
	"td",
	"tfoot",
	"th",
	"thead",
	"title",
	"tr",
	"track",
	"ul",
];
const SIMPLE_BOOLEAN: &[&str] = &[
	"allowfullscreen",
	"async",
	"autofocus",
	"autoplay",
	"checked",
	"compact",
	"controls",
	"declare",
	"default",
	"defaultchecked",
	"defaultmuted",
	"defaultselected",
	"defer",
	"disabled",
	"enabled",
	"formnovalidate",
	"hidden",
	"indeterminate",
	"inert",
	"ismap",
	"itemscope",
	"loop",
	"multiple",
	"muted",
	"nohref",
	"noresize",
	"noshade",
	"novalidate",
	"nowrap",
	"open",
	"pauseonexit",
	"readonly",
	"required",
	"reversed",
	"scoped",
	"seamless",
	"selected",
	"sortable",
	"truespeed",
	"typemustmatch",
	"visible",
];
const EXECUTABLE_SCRIPTS: &[&str] = &[
	"text/javascript",
	"text/ecmascript",
	"text/jscript",
	"application/javascript",
	"application/x-javascript",
	"application/ecmascript",
	"module",
];

fn in_ci(set: &[&str], name: &str) -> bool {
	set.contains(&name.to_ascii_lowercase().as_str())
}

fn is_script_type_attribute(value: &str) -> bool {
	let first = value.split(';').next().unwrap_or("");
	let t = trim_whitespace(first).to_lowercase();
	t.is_empty() || EXECUTABLE_SCRIPTS.contains(&t.as_str())
}

fn keep_script_type_attribute(value: &str) -> bool {
	let first = value.split(';').next().unwrap_or("");
	trim_whitespace(first).to_lowercase() == "module"
}

fn is_style_link_type_attribute(value: &str) -> bool {
	let t = trim_whitespace(value).to_lowercase();
	t.is_empty() || t == "text/css"
}

fn attribute_value<'a>(attrs: &'a [Attr], name: &str) -> Option<&'a str> {
	attrs
		.iter()
		.find(|a| a.name.eq_ignore_ascii_case(name))
		.map(|a| a.value.as_deref().unwrap_or(""))
}

fn attributes_include(attrs: &[Attr], name: &str) -> bool {
	attrs.iter().any(|a| a.name.to_lowercase() == name)
}

fn is_executable_script(tag: &str, attrs: &[Attr]) -> bool {
	if tag != "script" {
		return false;
	}
	match attribute_value(attrs, "type") {
		Some(v) => is_script_type_attribute(v),
		None => true,
	}
}

fn is_style_sheet(tag: &str, attrs: &[Attr]) -> bool {
	if tag != "style" {
		return false;
	}
	match attribute_value(attrs, "type") {
		Some(v) => is_style_link_type_attribute(v),
		None => true,
	}
}

fn is_attribute_redundant(tag: &str, name: &str, value: Option<&str>, attrs: &[Attr]) -> bool {
	let v = value.map_or(String::new(), |v| {
		trim_whitespace(&v.to_lowercase()).to_owned()
	});
	(tag == "script" && name == "language" && v == "javascript")
		|| (tag == "form" && name == "method" && v == "get")
		|| (tag == "input" && name == "type" && v == "text")
		|| (tag == "script" && name == "charset" && !attributes_include(attrs, "src"))
		|| (tag == "a" && name == "name" && attributes_include(attrs, "id"))
		|| (tag == "area" && name == "shape" && v == "rect")
}

fn is_boolean_attribute(name: &str, value: &str) -> bool {
	SIMPLE_BOOLEAN.contains(&name) || (name == "draggable" && !matches!(value, "true" | "false"))
}

fn is_event_attribute(name: &str) -> bool {
	name.len() >= 5 && name.starts_with("on") && name[2..].bytes().all(|b| b.is_ascii_lowercase())
}

fn is_uri_type_attribute(name: &str, tag: &str) -> bool {
	(matches!(tag, "a" | "area" | "link" | "base") && name == "href")
		|| (tag == "img" && matches!(name, "src" | "longdesc" | "usemap"))
		|| (tag == "object" && matches!(name, "classid" | "codebase" | "data" | "usemap"))
		|| (tag == "q" && name == "cite")
		|| (tag == "blockquote" && name == "cite")
		|| (matches!(tag, "ins" | "del") && name == "cite")
		|| (tag == "form" && name == "action")
		|| (tag == "input" && matches!(name, "src" | "usemap"))
		|| (tag == "head" && name == "profile")
		|| (tag == "script" && matches!(name, "src" | "for"))
}

fn is_number_type_attribute(name: &str, tag: &str) -> bool {
	(matches!(tag, "a" | "area" | "object" | "button") && name == "tabindex")
		|| (tag == "input" && matches!(name, "maxlength" | "tabindex"))
		|| (tag == "select" && matches!(name, "size" | "tabindex"))
		|| (tag == "textarea" && matches!(name, "rows" | "cols" | "tabindex"))
		|| (matches!(tag, "colgroup" | "col") && name == "span")
		|| (matches!(tag, "th" | "td") && matches!(name, "rowspan" | "colspan"))
}

fn is_link_type(tag: &str, attrs: &[Attr], value: &str) -> bool {
	tag == "link"
		&& attrs
			.iter()
			.any(|a| a.name == "rel" && a.value.as_deref() == Some(value))
}

fn is_meta_viewport(tag: &str, attrs: &[Attr]) -> bool {
	tag == "meta"
		&& attrs
			.iter()
			.any(|a| a.name == "name" && a.value.as_deref() == Some("viewport"))
}

/// `Err` where html-minifier-terser throws: an `http-equiv` without a value
/// on a `<meta>` (it calls `toLowerCase()` on `undefined`) that is reached
/// before an `http-equiv` that matches.
fn is_content_security_policy(tag: &str, attrs: &[Attr]) -> Result<bool, MinifyError> {
	if tag != "meta" {
		return Ok(false);
	}
	for a in attrs {
		if a.name.to_lowercase() == "http-equiv" {
			let Some(v) = a.value.as_deref() else {
				return Err(MinifyError(
					"Cannot read properties of undefined (reading 'toLowerCase')".to_owned(),
				));
			};
			if v.to_lowercase() == "content-security-policy" {
				return Ok(true);
			}
		}
	}
	Ok(false)
}

/// `value.replace(/\s*;\s*/g, ';')`
fn tighten_semicolons(value: &str) -> String {
	let mut out = String::with_capacity(value.len());
	let chars: Vec<char> = value.chars().collect();
	let mut i = 0;
	while i < chars.len() {
		if is_js_space(chars[i]) || chars[i] == ';' {
			let start = i;
			let mut j = i;
			while j < chars.len() && is_js_space(chars[j]) {
				j += 1;
			}
			if j < chars.len() && chars[j] == ';' {
				j += 1;
				while j < chars.len() && is_js_space(chars[j]) {
					j += 1;
				}
				out.push(';');
				i = j;
				continue;
			}
			out.extend(&chars[start..=start]);
			i = start + 1;
		} else {
			out.push(chars[i]);
			i += 1;
		}
	}
	out
}

fn clean_srcset(value: &str) -> String {
	let value = trim_whitespace(value);
	// split(/\s+,\s*|\s*,\s+/)
	let chars: Vec<char> = value.chars().collect();
	let mut candidates: Vec<String> = Vec::new();
	let mut start = 0;
	let mut i = 0;
	while i < chars.len() {
		if chars[i] == ',' {
			let mut l = i;
			while l > start && is_js_space(chars[l - 1]) {
				l -= 1;
			}
			let mut t = i + 1;
			while t < chars.len() && is_js_space(chars[t]) {
				t += 1;
			}
			if l < i || t > i + 1 {
				candidates.push(chars[start..l].iter().collect());
				start = t;
				i = t;
				continue;
			}
		}
		i += 1;
	}
	candidates.push(chars[start..].iter().collect());
	candidates
		.iter()
		.map(|candidate| {
			// /\s+([1-9][0-9]*w|[0-9]+(?:\.[0-9]+)?x)$/
			let mut url = candidate.as_str();
			let mut descriptor = String::new();
			if let Some(ws_at) = candidate.rfind(is_js_space) {
				let after_ws = candidate[ws_at..].trim_start_matches(is_js_space);
				let ws_start = candidate[..ws_at].trim_end_matches(is_js_space).len();
				if let Some(last) = after_ws.chars().last()
					&& (last == 'w' || last == 'x')
				{
					let digits = &after_ws[..after_ws.len() - 1];
					let valid = if last == 'w' {
						digits.starts_with(|c: char| ('1'..='9').contains(&c))
							&& digits.bytes().all(|b| b.is_ascii_digit())
					} else {
						let (int, frac) = digits
							.split_once('.')
							.map_or((digits, None), |(a, b)| (a, Some(b)));
						!int.is_empty()
							&& int.bytes().all(|b| b.is_ascii_digit())
							&& frac.is_none_or(|f| {
								!f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())
							})
					};
					if valid {
						url = &candidate[..ws_start];
						let num: f64 = digits.parse().unwrap_or(0.0);
						if num != 1.0 || last != 'x' {
							descriptor = format!(" {}{}", js_number_to_string(num), last);
						}
					}
				}
			}
			format!("{url}{descriptor}")
		})
		.collect::<Vec<_>>()
		.join(", ")
}

/// `value.replace(/\s+/g, '').replace(/[0-9]+\.[0-9]+/g, n => (+n).toString())`
fn clean_meta_viewport(value: &str) -> String {
	let squeezed: String = value.chars().filter(|c| !is_js_space(*c)).collect();
	let chars: Vec<char> = squeezed.chars().collect();
	let mut out = String::new();
	let mut i = 0;
	while i < chars.len() {
		if chars[i].is_ascii_digit() {
			let start = i;
			while i < chars.len() && chars[i].is_ascii_digit() {
				i += 1;
			}
			if i + 1 < chars.len() && chars[i] == '.' && chars[i + 1].is_ascii_digit() {
				let mut j = i + 1;
				while j < chars.len() && chars[j].is_ascii_digit() {
					j += 1;
				}
				let text: String = chars[start..j].iter().collect();
				out.push_str(&js_number_to_string(text.parse().unwrap_or(0.0)));
				i = j;
			} else {
				out.extend(&chars[start..i]);
			}
		} else {
			out.push(chars[i]);
			i += 1;
		}
	}
	out
}

struct Normalized {
	name: String,
	value: Option<String>,
}

struct Minifier<'a> {
	options: &'a Options,
	hooks: &'a dyn Hooks,
	buffer: Vec<String>,
	current_tag: String,
	current_attrs: Vec<Attr>,
	svg_depth: usize,
	stack: Vec<Open>,
	last_tag: String,
	/// Where html-minifier-terser throws, the first such failure.
	failure: std::cell::RefCell<Option<MinifyError>>,
	/// The custom fragments taken out of the page and the id of their tokens.
	fragments: &'a [String],
	fragment_uid: &'a str,
}

impl Minifier<'_> {
	/// What a code minifier is given: the placeholder of each custom fragment
	/// (`<?php ... ?>`) that sits in the code gets back the white space that
	/// surrounded the fragment, in place of the tabs that marked it. Without
	/// that a string literal around a fragment would contain tabs.
	fn with_fragment_whitespace(&self, text: &str) -> String {
		if self.fragments.is_empty() {
			return text.to_owned();
		}
		let uid = self.fragment_uid;
		let mut out = String::with_capacity(text.len());
		let mut rest = text;
		while let Some(at) = rest.find(uid) {
			let after = &rest[at + uid.len()..];
			let digits = after.bytes().take_while(u8::is_ascii_digit).count();
			let chunk = after[..digits]
				.parse::<usize>()
				.ok()
				.and_then(|i| self.fragments.get(i));
			match chunk {
				Some(chunk) if digits > 0 && after[digits..].starts_with(uid) => {
					out.push_str(rest[..at].trim_end_matches(is_js_space));
					let body = chunk.trim_start_matches(is_js_space);
					out.push_str(&chunk[..chunk.len() - body.len()]);
					out.push_str(uid);
					out.push_str(&after[..digits]);
					out.push_str(uid);
					out.push_str(&chunk[chunk.trim_end_matches(is_js_space).len()..]);
					rest = after[digits + uid.len()..].trim_start_matches(is_js_space);
				}
				_ => {
					out.push_str(&rest[..at + uid.len()]);
					rest = after;
				}
			}
		}
		out.push_str(rest);
		out
	}

	fn name(&self, name: &str) -> String {
		if self.svg_depth > 0 {
			name.to_owned()
		} else {
			name.to_lowercase()
		}
	}

	fn clean_attribute_value(&self, tag: &str, name: &str, value: &str, attrs: &[Attr]) -> String {
		if is_event_attribute(name) {
			let trimmed = trim_whitespace(value);
			let stripped = strip_javascript_prefix(trimmed);
			return if self.options.minify_js {
				self.hooks
					.js(&self.with_fragment_whitespace(stripped), true)
			} else {
				stripped.to_owned()
			};
		}
		if name == "class" {
			return collapse_whitespace_all(trim_whitespace(value));
		}
		if is_uri_type_attribute(name, tag) {
			// `minifyURLs` is off in v2, so a canonical link needs no care.
			return trim_whitespace(value).to_owned();
		}
		if is_number_type_attribute(name, tag) {
			return trim_whitespace(value).to_owned();
		}
		if name == "style" {
			let mut v = trim_whitespace(value).to_owned();
			if !v.is_empty() {
				if v.ends_with(';') && !ends_with_entity(&v) {
					let without = v[..v.len() - 1].trim_end_matches(is_js_space).to_owned();
					v = format!("{without};");
				}
				if self.options.minify_css {
					v = self
						.hooks
						.css(&self.with_fragment_whitespace(&v), CssKind::Inline);
				}
			}
			return v;
		}
		if name == "srcset" && matches!(tag, "img" | "source") {
			return clean_srcset(value);
		}
		if is_meta_viewport(tag, attrs) && name == "content" {
			return clean_meta_viewport(value);
		}
		match is_content_security_policy(tag, attrs) {
			Ok(true) if name == "content" => return collapse_whitespace_all(value),
			Ok(_) => {}
			Err(e) => {
				self.failure.borrow_mut().get_or_insert(e);
			}
		}
		if tag == "script" && name == "type" {
			return trim_whitespace(&tighten_semicolons(value)).to_owned();
		}
		if name == "media" && (is_link_type(tag, attrs, "stylesheet") || is_style_sheet(tag, attrs))
		{
			let v = trim_whitespace(value);
			return if self.options.minify_css {
				self.hooks
					.css(&self.with_fragment_whitespace(v), CssKind::Media)
			} else {
				v.to_owned()
			};
		}
		value.to_owned()
	}

	fn normalize_attr(&self, attr: &Attr, attrs: &[Attr], tag: &str) -> Option<Normalized> {
		let name = self.name(&attr.name);
		let value = attr.value.clone();
		if (self.options.remove_redundant_attributes
			&& is_attribute_redundant(tag, &name, value.as_deref(), attrs))
			|| (self.options.remove_script_type_attributes
				&& tag == "script"
				&& name == "type"
				&& is_script_type_attribute(value.as_deref().unwrap_or(""))
				&& !keep_script_type_attribute(value.as_deref().unwrap_or("")))
			|| (self.options.remove_style_link_type_attributes
				&& (tag == "style" || tag == "link")
				&& name == "type"
				&& is_style_link_type_attribute(value.as_deref().unwrap_or("")))
		{
			return None;
		}
		let value = match value {
			Some(v) if !v.is_empty() => Some(self.clean_attribute_value(tag, &name, &v, attrs)),
			other => other,
		};
		Some(Normalized { name, value })
	}

	fn build_attr(&self, n: &Normalized, is_last: bool) -> String {
		let emitted = match &n.value {
			Some(v) => {
				let apos = v.matches('\'').count();
				let quot = v.matches('"').count();
				let quote = if apos < quot { '\'' } else { '"' };
				let escaped = if quote == '"' {
					v.replace('"', "&#34;")
				} else {
					v.replace('\'', "&#39;")
				};
				let mut e = format!("{quote}{escaped}{quote}");
				if !is_last {
					e.push(' ');
				}
				e
			}
			None => String::new(),
		};
		let boolean = match &n.value {
			None => true,
			Some(v) => {
				self.options.collapse_boolean_attributes
					&& is_boolean_attribute(&n.name.to_lowercase(), &v.to_lowercase())
			}
		};
		if boolean {
			let mut f = n.name.clone();
			if !is_last {
				f.push(' ');
			}
			f
		} else {
			format!("{}={emitted}", n.name)
		}
	}

	fn handle_start(&mut self, tag: &str, attrs: Vec<Attr>, unary_slash: bool) {
		if tag.eq_ignore_ascii_case("svg") {
			self.svg_depth += 1;
		}
		let tag = self.name(tag);
		self.current_tag = tag.clone();
		self.current_attrs = attrs.clone();
		let has_unary_slash = unary_slash && self.svg_depth > 0;
		self.buffer.push(format!("<{tag}"));
		let mut parts: Vec<String> = Vec::new();
		let mut is_last = true;
		for i in (0..attrs.len()).rev() {
			if let Some(n) = self.normalize_attr(&attrs[i], &attrs, &tag) {
				parts.insert(0, self.build_attr(&n, is_last));
				is_last = false;
			}
		}
		if !parts.is_empty() {
			self.buffer.push(" ".to_owned());
			self.buffer.extend(parts);
		}
		let last = self.buffer.pop().unwrap_or_default();
		self.buffer
			.push(format!("{last}{}>", if has_unary_slash { "/" } else { "" }));
	}

	fn handle_end(&mut self, tag: &str) {
		if tag.eq_ignore_ascii_case("svg") {
			self.svg_depth = self.svg_depth.saturating_sub(1);
		}
		let tag = self.name(tag);
		if tag == self.current_tag {
			self.current_tag.clear();
		}
		self.buffer.push(format!("</{tag}>"));
	}

	fn handle_chars(&mut self, text: &str) {
		let mut text = text.to_owned();
		if is_executable_script(&self.current_tag, &self.current_attrs) && self.options.minify_js {
			text = self.hooks.js(&self.with_fragment_whitespace(&text), false);
		}
		if is_style_sheet(&self.current_tag, &self.current_attrs) && self.options.minify_css {
			text = self
				.hooks
				.css(&self.with_fragment_whitespace(&text), CssKind::Block);
		}
		self.buffer.push(text);
	}

	fn find_tag(&self, tag_name: &str) -> Option<usize> {
		let needle = tag_name.to_lowercase();
		(0..self.stack.len())
			.rev()
			.find(|&i| self.stack[i].tag.to_lowercase() == needle)
	}

	/// `parseEndTag`: closes `tag_name` and what is open above it, or every
	/// open element for `None`. (Whether the end tag was written only matters
	/// to `removeOptionalTags`, which v2 does not use.)
	fn parse_end_tag(&mut self, tag_name: Option<&str>) {
		let pos = match tag_name {
			Some(name) => self.find_tag(name),
			None => Some(0),
		};
		if let Some(pos) = pos {
			for i in (pos..self.stack.len()).rev() {
				let t = self.stack[i].tag.clone();
				self.handle_end(&t);
			}
			self.stack.truncate(pos);
			self.last_tag = if pos > 0 {
				self.stack[pos - 1].tag.clone()
			} else {
				String::new()
			};
		} else if let Some(name) = tag_name {
			let lower = name.to_lowercase();
			if lower == "br" {
				self.handle_start(name, Vec::new(), false);
			} else if lower == "p" {
				self.handle_start(name, Vec::new(), false);
				self.handle_end(name);
			}
		}
	}

	fn close_if_found(&mut self, tag_name: &str) -> bool {
		if self.find_tag(tag_name).is_some() {
			self.parse_end_tag(Some(tag_name));
			return true;
		}
		false
	}

	fn handle_start_tag(&mut self, m: StartTag) {
		let tag_name = m.name.clone();
		let mut unary_slash = m.unary_slash;
		if self.last_tag == "p" && in_ci(NON_PHRASING, &tag_name) {
			let last = self.last_tag.clone();
			self.parse_end_tag(Some(&last));
		} else if tag_name == "tbody" || (tag_name == "tfoot" && !self.close_if_found("tbody")) {
			self.close_if_found("thead");
		}
		if tag_name == "col" && self.find_tag("colgroup").is_none() {
			self.last_tag = "colgroup".to_owned();
			self.stack.push(Open {
				tag: self.last_tag.clone(),
			});
			self.handle_start("colgroup", Vec::new(), false);
		}
		if in_ci(CLOSE_SELF, &tag_name) && self.last_tag == tag_name {
			self.parse_end_tag(Some(&tag_name));
		}
		let unary = in_ci(EMPTY, &tag_name)
			|| (tag_name == "html" && self.last_tag == "head")
			|| unary_slash;
		if !unary {
			self.stack.push(Open {
				tag: tag_name.clone(),
			});
			self.last_tag = tag_name.clone();
			unary_slash = false;
		}
		self.handle_start(&tag_name, m.attrs, unary_slash);
	}
}

fn strip_javascript_prefix(s: &str) -> &str {
	if s.len() >= 11 && s.as_bytes()[..11].eq_ignore_ascii_case(b"javascript:") {
		s[11..].trim_start_matches(is_js_space)
	} else {
		s
	}
}

/// `/&#?[0-9a-zA-Z]+;$/`
fn ends_with_entity(s: &str) -> bool {
	let Some(body) = s.strip_suffix(';') else {
		return false;
	};
	let alnum = body
		.bytes()
		.rev()
		.take_while(u8::is_ascii_alphanumeric)
		.count();
	alnum > 0 && body[..body.len() - alnum].ends_with('&')
		|| (alnum > 0 && body[..body.len() - alnum].ends_with("&#"))
}

// ----- custom fragments and ignored chunks -----

fn unique_id(value: &str, base: &str) -> String {
	let mut n = 0;
	loop {
		let id = format!("{base}{}", "x".repeat(n));
		if !value.contains(&id) {
			return id;
		}
		n += 1;
	}
}

/// Replaces `<!-- htmlmin:ignore -->…<!-- htmlmin:ignore -->` by placeholder
/// comments.
fn extract_ignored(value: &str) -> (String, Vec<String>, String) {
	const MARK: &str = "<!-- htmlmin:ignore -->";
	let mut out = String::new();
	let mut chunks: Vec<String> = Vec::new();
	let uid = unique_id(value, "kdignore");
	let mut rest = value;
	while let Some(a) = rest.find(MARK) {
		let after = &rest[a + MARK.len()..];
		let Some(b) = after.find(MARK) else { break };
		out.push_str(&rest[..a]);
		out.push_str(&format!("<!--{uid}{}-->", chunks.len()));
		chunks.push(after[..b].to_owned());
		rest = &after[b + MARK.len()..];
	}
	out.push_str(rest);
	(out, chunks, uid)
}

/// Finds the next custom fragment (`<%…%>` or `<?…?>`) at or after `from`:
/// `(start, end)` of the fragment itself.
fn next_fragment(s: &str, from: usize) -> Option<(usize, usize)> {
	let mut i = from;
	while i < s.len() {
		let rest = &s[i..];
		let lt = rest.find('<')? + i;
		let tail = &s[lt..];
		if let Some(after) = tail.strip_prefix("<%")
			&& let Some(e) = after.find("%>")
		{
			return Some((lt, lt + 2 + e + 2));
		}
		if let Some(after) = tail.strip_prefix("<?")
			&& let Some(e) = after.find("?>")
		{
			return Some((lt, lt + 2 + e + 2));
		}
		i = lt + 1;
	}
	None
}

/// Replaces runs of custom fragments (with their surrounding white space) by
/// `\t<uid><n><uid>\t` tokens.
fn extract_fragments(value: &str) -> (String, Vec<String>, String) {
	let uid = unique_id(value, "kdfrag");
	let mut out = String::new();
	let mut chunks = Vec::new();
	let mut pos = 0;
	while let Some((f_start, mut f_end)) = next_fragment(value, pos) {
		// leading white space not yet consumed
		let lead_start = {
			let before = &value[pos..f_start];
			f_start - (before.len() - before.trim_end_matches(is_js_space).len())
		};
		// adjacent fragments
		while let Some((s2, e2)) = next_fragment(value, f_end) {
			if s2 == f_end {
				f_end = e2;
			} else {
				break;
			}
		}
		let tail = &value[f_end..];
		let end = f_end + (tail.len() - tail.trim_start_matches(is_js_space).len());
		out.push_str(&value[pos..lead_start]);
		out.push_str(&format!("\t{uid}{}{uid}\t", chunks.len()));
		chunks.push(value[lead_start..end].to_owned());
		pos = end;
	}
	out.push_str(&value[pos..]);
	(out, chunks, uid)
}

fn restore_fragments(s: &str, chunks: &[String], uid: &str) -> String {
	let mut out = String::new();
	let mut rest = s;
	while let Some(a) = rest.find(uid) {
		let after = &rest[a + uid.len()..];
		let digits = after.bytes().take_while(u8::is_ascii_digit).count();
		if digits > 0 && after[digits..].starts_with(uid) {
			let index: usize = after[..digits].parse().unwrap_or(usize::MAX);
			let mut tail = &after[digits + uid.len()..];
			tail = tail.trim_start_matches(is_js_space);
			out.push_str(&rest[..a]);
			let kept = out.trim_end_matches(is_js_space).len();
			out.truncate(kept);
			if let Some(chunk) = chunks.get(index) {
				out.push_str(chunk);
			}
			rest = tail;
		} else {
			out.push_str(&rest[..a + uid.len()]);
			rest = after;
		}
	}
	out.push_str(rest);
	out
}

fn restore_ignored(s: &str, chunks: &[String], uid: &str) -> String {
	let mut out = String::new();
	let marker = format!("<!--{uid}");
	let mut rest = s;
	while let Some(a) = rest.find(&marker) {
		let after = &rest[a + marker.len()..];
		let digits = after.bytes().take_while(u8::is_ascii_digit).count();
		if digits > 0 && after[digits..].starts_with("-->") {
			let index: usize = after[..digits].parse().unwrap_or(usize::MAX);
			out.push_str(&rest[..a]);
			if let Some(chunk) = chunks.get(index) {
				out.push_str(chunk);
			}
			rest = &after[digits + 3..];
		} else {
			out.push_str(&rest[..a + marker.len()]);
			rest = after;
		}
	}
	out.push_str(rest);
	out
}

// ----- the driver -----

/// Minifies `html` as html-minifier-terser does with v2's options.
///
/// # Errors
///
/// [`MinifyError`] where the minifier's parser stops making progress (a `<`
/// that starts nothing, an unclosed `<script>` or `<style>`).
///
/// # Example
///
/// ```
/// use kd_html::minify::{minify, NoMinification, Options};
/// let out = minify("<input disabled=\"disabled\" type=\"text\" />\n", &Options::default(), &NoMinification).unwrap();
/// assert_eq!(out, "<input disabled>\n");
/// ```
pub fn minify(html: &str, options: &Options, hooks: &dyn Hooks) -> Result<String, MinifyError> {
	let (value, ignored, uid_ignore) = extract_ignored(html);
	let (value, fragments, uid_attr) = extract_fragments(&value);
	let mut m = Minifier {
		options,
		hooks,
		buffer: Vec::new(),
		current_tag: String::new(),
		current_attrs: Vec::new(),
		svg_depth: 0,
		stack: Vec::new(),
		last_tag: String::new(),
		failure: std::cell::RefCell::new(None),
		fragments: &fragments,
		fragment_uid: &uid_attr,
	};
	let fill = |name: &str| in_ci(FILL_ATTRS, name);
	let mut rest: &str = &value;
	while !rest.is_empty() {
		let last = rest;
		let special = !m.last_tag.is_empty() && in_ci(&["script", "style"], &m.last_tag);
		if !special {
			let text_end = rest.find('<');
			if text_end == Some(0) {
				if rest.starts_with("<!--")
					&& let Some(ce) = rest.find("-->")
				{
					let (a, b) = (4.min(ce), 4.max(ce));
					m.buffer.push(format!("<!--{}-->", &rest[a..b]));
					rest = &rest[ce + 3..];
					continue;
				}
				if rest.starts_with("<![")
					&& let Some(ce) = rest.find("]>")
				{
					m.buffer.push(format!("<!{}>", &rest[2..=ce]));
					rest = &rest[ce + 2..];
					continue;
				}
				if let Some(len) = match_doctype(rest) {
					m.buffer.push(collapse_whitespace_all(&rest[..len]));
					rest = &rest[len..];
					continue;
				}
				if let Some((len, name)) = match_end_tag(rest) {
					let name = name.to_owned();
					rest = &rest[len..];
					m.parse_end_tag(Some(&name));
					continue;
				}
				if let Some(st) = parse_start_tag(rest, &fill) {
					rest = &rest[st.len..];
					m.handle_start_tag(st);
					continue;
				}
			}
			let (text, remaining) = match text_end {
				Some(i) => (&rest[..i], &rest[i..]),
				None => (rest, ""),
			};
			m.handle_chars(text);
			rest = remaining;
		} else {
			let stacked = m.last_tag.to_ascii_lowercase();
			let closing = format!("</{stacked}");
			// `([\s\S]*?)</stacked[^>]*>` (case-insensitive)
			let mut found = None;
			let lower = rest.to_ascii_lowercase();
			let mut from = 0;
			while let Some(i) = lower[from..].find(&closing) {
				let at = from + i;
				if let Some(gt) = lower[at..].find('>') {
					found = Some((at, at + gt + 1));
					break;
				}
				from = at + 1;
			}
			if let Some((at, end)) = found {
				m.handle_chars(&rest[..at]);
				rest = &rest[end..];
			}
			m.parse_end_tag(Some(&stacked));
		}
		if std::ptr::eq(rest.as_ptr(), last.as_ptr()) && rest.len() == last.len() {
			return Err(MinifyError(rest.to_owned()));
		}
	}
	m.parse_end_tag(None);
	if let Some(e) = m.failure.take() {
		return Err(e);
	}
	let joined = m.buffer.concat();
	let joined = restore_fragments(&joined, &fragments, &uid_attr);
	Ok(restore_ignored(&joined, &ignored, &uid_ignore))
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Marks what it was asked to minify so that a test can see which hook ran.
	struct Marking;

	impl Hooks for Marking {
		fn css(&self, text: &str, kind: CssKind) -> String {
			format!("css-{kind:?}({text})")
		}

		fn js(&self, text: &str, inline: bool) -> String {
			format!("js-{}({text})", if inline { "inline" } else { "block" })
		}
	}

	fn run(html: &str) -> String {
		minify(html, &Options::default(), &Marking).unwrap()
	}

	#[test]
	fn the_code_hooks_receive_the_text_of_each_kind_of_code() {
		assert_eq!(
			run("<style>a{}</style><script>b()</script>"),
			"<style>css-Block(a{})</style><script>js-block(b())</script>"
		);
		assert_eq!(
			run(r#"<p style="color: red;" onclick="javascript: x()">y</p>"#),
			r#"<p style="css-Inline(color: red;)" onclick="js-inline(x())">y</p>"#
		);
		assert_eq!(
			run(r#"<link rel="stylesheet" media=" print " href="a.css">"#),
			r#"<link rel="stylesheet" media="css-Media(print)" href="a.css">"#
		);
	}

	#[test]
	fn code_that_is_not_css_or_javascript_is_not_given_to_the_hooks() {
		assert_eq!(
			run(r#"<script type="application/ld+json">{"a":1}</script>"#),
			r#"<script type="application/ld+json">{"a":1}</script>"#
		);
		assert_eq!(
			run(r#"<style type="text/less">a{}</style>"#),
			r#"<style type="text/less">a{}</style>"#
		);
	}

	#[test]
	fn the_code_hooks_are_not_called_when_the_options_turn_them_off() {
		let options = Options {
			minify_css: false,
			minify_js: false,
			..Options::default()
		};
		assert_eq!(
			minify("<style>a{}</style><script>b()</script>", &options, &Marking).unwrap(),
			"<style>a{}</style><script>b()</script>"
		);
	}

	/// Reports what the hooks were given, to see the fragment placeholders.
	struct Echo;

	impl Hooks for Echo {
		fn css(&self, text: &str, _kind: CssKind) -> String {
			text.replace('\t', "<TAB>")
		}

		fn js(&self, text: &str, _inline: bool) -> String {
			text.replace('\t', "<TAB>")
		}
	}

	#[test]
	fn a_custom_fragment_in_code_reaches_the_hooks_as_a_token_without_the_marker_tabs() {
		let out = minify(
			"<script>var a = <?php echo 1 ?>;\nvar b = '<?= $x ?>';</script>",
			&Options::default(),
			&Echo,
		)
		.unwrap();
		assert_eq!(
			out,
			"<script>var a = <?php echo 1 ?>;\nvar b = '<?= $x ?>';</script>"
		);
		let handler = minify(
			r#"<p onclick="f('<?= $x ?>')" style="color:<?= $c ?>">y</p>"#,
			&Options::default(),
			&Echo,
		)
		.unwrap();
		assert_eq!(
			handler,
			r#"<p onclick="f('<?= $x ?>')" style="color:<?= $c ?>">y</p>"#
		);
	}

	#[test]
	fn a_multibyte_space_before_a_srcset_descriptor_is_handled() {
		assert_eq!(
			run("<img srcset=\"a.jpg\u{3000}2x, b.jpg\u{A0}1x\">"),
			"<img srcset=\"a.jpg 2x, b.jpg\">"
		);
	}

	#[test]
	fn characters_that_change_length_when_lowercased_do_not_move_the_end_of_a_script() {
		let html = "<script>var a=1; // \u{130}\u{212A}\n</script><p>x</p>";
		assert_eq!(
			run(html),
			"<script>js-block(var a=1; // \u{130}\u{212A}\n)</script><p>x</p>"
		);
	}

	#[test]
	fn a_meta_http_equiv_without_a_value_is_rejected_like_html_minifier_terser_does() {
		let err = minify(
			r#"<meta http-equiv content="x">"#,
			&Options::default(),
			&NoMinification,
		)
		.unwrap_err();
		assert!(err.to_string().starts_with("Parse Error: "));
	}
}
