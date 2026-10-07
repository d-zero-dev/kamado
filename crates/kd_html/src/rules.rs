//! Declarative DOM rules (`html.rules`): a selector plus one action, applied
//! in order to a parsed page.
//!
//! Why declarative: a rule is data, so it is validated before the build
//! starts (a bad selector or pattern is a configuration error, not a
//! half-written site), it takes part in the build's environment hash, and a
//! page never has to cross back into JavaScript to be post-processed.
//!
//! Each rule first collects every element its selector matches, then acts on
//! them, so an action's own changes do not influence which elements the rule
//! visits. Rules see the result of the rules before them.
//!
//! Text templates (`setAttr` values, `insert` and `wrap` markup) may use
//! `{{attr:NAME}}` (the element's own attribute, empty when missing),
//! `{{url}}` (the page's output URL), `{{baseURL}}` and `{{host}}`. `wrap`
//! markup must contain `{{content}}` exactly once. An unknown placeholder is
//! an error when the rule is built.

use crate::dom::{Document, NodeId, NodeKind, ROOT};
use crate::page::Page;
use crate::parser::parse;
use crate::pattern::Pattern;
use crate::selector::Selector;

/// A rule that is invalid, or cannot be applied to a page.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuleError(pub String);

impl std::fmt::Display for RuleError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

impl std::error::Error for RuleError {}

/// What a rule knows about the page and the site.
#[derive(Debug, Clone, Copy)]
pub struct Context<'a> {
	/// The page's output URL, e.g. `/a/b/` or `/a/b.html`.
	pub url: &'a str,
	/// The site's base URL, e.g. `https://example.com/`.
	pub base_url: &'a str,
	/// The site's host, e.g. `example.com`.
	pub host: &'a str,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Part {
	Text(String),
	Attr(String),
	Url,
	BaseUrl,
	Host,
	Content,
}

/// A text with `{{…}}` placeholders, parsed once.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Template {
	parts: Vec<Part>,
}

impl Template {
	fn parse(source: &str, allow_content: bool) -> Result<Template, RuleError> {
		let mut parts = Vec::new();
		let mut rest = source;
		while let Some(open) = rest.find("{{") {
			if open > 0 {
				parts.push(Part::Text(rest[..open].to_owned()));
			}
			let after = &rest[open + 2..];
			let Some(close) = after.find("}}") else {
				return Err(RuleError(format!("`{{{{` is not closed in `{source}`")));
			};
			let name = after[..close].trim();
			parts.push(match name {
				"url" => Part::Url,
				"baseURL" => Part::BaseUrl,
				"host" => Part::Host,
				"content" if allow_content => Part::Content,
				_ => match name.strip_prefix("attr:") {
					Some(attr) if !attr.is_empty() => Part::Attr(attr.to_owned()),
					_ => {
						return Err(RuleError(format!(
							"unknown placeholder `{{{{{name}}}}}` in `{source}`"
						)));
					}
				},
			});
			rest = &after[close + 2..];
		}
		if !rest.is_empty() {
			parts.push(Part::Text(rest.to_owned()));
		}
		Ok(Template { parts })
	}

	fn content_count(&self) -> usize {
		self.parts
			.iter()
			.filter(|p| matches!(p, Part::Content))
			.count()
	}

	/// Fills the placeholders. With `escape_html` the substituted values
	/// (never the template's own text) are HTML-escaped: that is for markup
	/// templates (`wrap`, `insert`), which are parsed after rendering, where an
	/// attribute value containing `"` or `<` would otherwise break out into
	/// new attributes or elements. `setAttr` values go straight into an
	/// attribute and are not escaped.
	fn render(
		&self,
		doc: &Document,
		node: NodeId,
		ctx: &Context<'_>,
		content: &str,
		escape_html: bool,
	) -> String {
		let mut out = String::new();
		let push_value = |out: &mut String, value: &str| {
			if escape_html {
				for c in value.chars() {
					match c {
						'&' => out.push_str("&amp;"),
						'<' => out.push_str("&lt;"),
						'>' => out.push_str("&gt;"),
						'"' => out.push_str("&quot;"),
						'\'' => out.push_str("&#39;"),
						other => out.push(other),
					}
				}
			} else {
				out.push_str(value);
			}
		};
		for part in &self.parts {
			match part {
				Part::Text(t) => out.push_str(t),
				Part::Attr(name) => {
					if let Some(v) = attr_ignore_case(doc, node, name) {
						push_value(&mut out, v);
					}
				}
				Part::Url => push_value(&mut out, ctx.url),
				Part::BaseUrl => push_value(&mut out, ctx.base_url),
				Part::Host => push_value(&mut out, ctx.host),
				Part::Content => out.push_str(content),
			}
		}
		out
	}
}

fn attr_ignore_case<'a>(doc: &'a Document, node: NodeId, name: &str) -> Option<&'a str> {
	doc.element(node)?
		.attrs
		.iter()
		.find(|a| a.name.eq_ignore_ascii_case(name))
		.map(|a| a.value.as_str())
}

/// Where `insert` puts its markup relative to the element.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Position {
	Before,
	After,
	Prepend,
	Append,
}

/// How `rewriteUrl` rewrites.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UrlTarget {
	/// Root-relative and relative URLs become `origin + path`.
	Absolute,
	/// URLs starting with the origin lose it.
	RootRelative,
}

/// The name an `removeAttr` removes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NameMatcher {
	Exact(String),
	Pattern(Pattern),
}

/// An action, built through the [`Rule`] constructors.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
	Remove,
	Unwrap,
	Wrap(Template),
	SetAttr {
		name: String,
		value: Template,
	},
	RemoveAttr(NameMatcher),
	AddClass(String),
	RemoveClass(String),
	Insert {
		position: Position,
		html: Template,
	},
	RewriteUrl {
		to: UrlTarget,
		origin: String,
		attrs: Vec<String>,
	},
}

/// A selector and its action.
///
/// # Example
///
/// ```
/// use kd_html::{page::Page, rules::{apply, Context, Rule}};
/// let rules = [Rule::set_attr("a[href^='http']", "example.com", "rel", "noopener").unwrap()];
/// let mut page = Page::parse("<a href=\"https://x.test/\">x</a>");
/// let ctx = Context { url: "/", base_url: "https://example.com/", host: "example.com" };
/// apply(&mut page, &rules, &ctx).unwrap();
/// assert_eq!(page.serialize(), "<a href=\"https://x.test/\" rel=\"noopener\">x</a>");
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Rule {
	selector: Selector,
	action: Action,
}

fn selector(source: &str, host: &str) -> Result<Selector, RuleError> {
	Selector::parse(&source.replace("{{host}}", host)).map_err(|e| RuleError(e.to_string()))
}

impl Rule {
	/// `selector` may use `{{host}}`, which is replaced by `host`.
	///
	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector.
	pub fn remove(sel: &str, host: &str) -> Result<Rule, RuleError> {
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::Remove,
		})
	}

	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector.
	pub fn unwrap(sel: &str, host: &str) -> Result<Rule, RuleError> {
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::Unwrap,
		})
	}

	/// `html` must contain `{{content}}` exactly once.
	///
	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or template.
	pub fn wrap(sel: &str, host: &str, html: &str) -> Result<Rule, RuleError> {
		let template = Template::parse(html, true)?;
		if template.content_count() != 1 {
			return Err(RuleError(format!(
				"wrap markup must contain {{{{content}}}} exactly once: `{html}`"
			)));
		}
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::Wrap(template),
		})
	}

	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector, name or template.
	pub fn set_attr(sel: &str, host: &str, name: &str, value: &str) -> Result<Rule, RuleError> {
		check_attr_name(name)?;
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::SetAttr {
				name: name.to_owned(),
				value: Template::parse(value, false)?,
			},
		})
	}

	/// `name` is an attribute name, or `/regex/` for a pattern.
	///
	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or pattern.
	pub fn remove_attr(sel: &str, host: &str, name: &str) -> Result<Rule, RuleError> {
		let matcher = if name.len() >= 2 && name.starts_with('/') && name.ends_with('/') {
			NameMatcher::Pattern(
				Pattern::new(&name[1..name.len() - 1]).map_err(|e| RuleError(e.to_string()))?,
			)
		} else {
			check_attr_name(name)?;
			NameMatcher::Exact(name.to_owned())
		};
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::RemoveAttr(matcher),
		})
	}

	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or an empty class.
	pub fn add_class(sel: &str, host: &str, class: &str) -> Result<Rule, RuleError> {
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::AddClass(check_class(class)?),
		})
	}

	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or an empty class.
	pub fn remove_class(sel: &str, host: &str, class: &str) -> Result<Rule, RuleError> {
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::RemoveClass(check_class(class)?),
		})
	}

	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or template.
	pub fn insert(
		sel: &str,
		host: &str,
		position: Position,
		html: &str,
	) -> Result<Rule, RuleError> {
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::Insert {
				position,
				html: Template::parse(html, false)?,
			},
		})
	}

	/// `origin` is `https://example.com` (no path, no credentials). `attrs`
	/// empty means the defaults: `href`, `src`, `srcset`, `poster`, `action`.
	///
	/// # Errors
	///
	/// A [`RuleError`] for an invalid selector or origin.
	pub fn rewrite_url(
		sel: &str,
		host: &str,
		to: UrlTarget,
		origin: &str,
		attrs: &[&str],
	) -> Result<Rule, RuleError> {
		let origin = check_origin(origin)?;
		let attrs = if attrs.is_empty() {
			["href", "src", "srcset", "poster", "action"]
				.map(str::to_owned)
				.to_vec()
		} else {
			for a in attrs {
				check_attr_name(a)?;
			}
			attrs.iter().map(|a| a.to_ascii_lowercase()).collect()
		};
		Ok(Rule {
			selector: selector(sel, host)?,
			action: Action::RewriteUrl { to, origin, attrs },
		})
	}
}

fn check_attr_name(name: &str) -> Result<(), RuleError> {
	let ok = !name.is_empty()
		&& name.chars().all(|c| {
			!c.is_whitespace() && !c.is_control() && !matches!(c, '"' | '\'' | '>' | '/' | '=')
		});
	if ok {
		Ok(())
	} else {
		Err(RuleError(format!("`{name}` is not a valid attribute name")))
	}
}

fn check_class(class: &str) -> Result<String, RuleError> {
	let class = class.trim();
	if class.is_empty() || class.split_ascii_whitespace().count() != 1 {
		return Err(RuleError(format!(
			"`{class}` must be exactly one class name"
		)));
	}
	Ok(class.to_owned())
}

fn check_origin(origin: &str) -> Result<String, RuleError> {
	let trimmed = origin.trim_end_matches('/');
	let Some(authority) = trimmed
		.strip_prefix("https://")
		.or_else(|| trimmed.strip_prefix("http://"))
	else {
		return Err(RuleError(format!(
			"the origin `{origin}` must start with http:// or https://"
		)));
	};
	if authority.is_empty() || authority.contains(['/', '?', '#', '@', ' ']) {
		return Err(RuleError(format!(
			"the origin `{origin}` must be a scheme and a host only, without credentials"
		)));
	}
	Ok(trimmed.to_owned())
}

// ----- URL rewriting -----

/// Whether `value` starts with a URL scheme (`https:`, `mailto:`, `javascript:`).
fn has_scheme(value: &str) -> bool {
	let Some(colon) = value.find(':') else {
		return false;
	};
	let scheme = &value[..colon];
	!scheme.is_empty()
		&& scheme.starts_with(|c: char| c.is_ascii_alphabetic())
		&& scheme
			.chars()
			.all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
}

/// Resolves a relative reference against the page's output URL, normalizing
/// dot segments. The query and fragment are carried over unchanged.
fn resolve_relative(value: &str, page_url: &str) -> String {
	let split = value.find(['?', '#']).unwrap_or(value.len());
	let (path, tail) = value.split_at(split);
	let page_path = &page_url[..page_url.find(['?', '#']).unwrap_or(page_url.len())];
	// Everything up to and including the last `/`; a page URL without one
	// (never produced by the build) is taken to sit at the root.
	let directory = page_path.rfind('/').map_or("/", |i| &page_path[..=i]);
	let mut segments: Vec<&str> = Vec::new();
	let combined = if path.is_empty() {
		page_path.to_owned()
	} else {
		format!("{directory}{path}")
	};
	// A reference that ends in `.` or `..` names a directory: it keeps a
	// trailing slash, as RFC 3986 resolution does.
	let names_directory =
		combined.ends_with('/') || combined.ends_with("/.") || combined.ends_with("/..");
	for segment in combined.split('/') {
		match segment {
			"" | "." => {}
			".." => {
				segments.pop();
			}
			s => segments.push(s),
		}
	}
	let mut out = String::from("/");
	out.push_str(&segments.join("/"));
	if names_directory && !segments.is_empty() {
		out.push('/');
	}
	out.push_str(tail);
	out
}

fn rewrite_one(value: &str, to: UrlTarget, origin: &str, page_url: &str) -> Option<String> {
	let trimmed = value.trim();
	if trimmed.is_empty() || trimmed.starts_with("//") {
		return None;
	}
	match to {
		UrlTarget::Absolute => {
			if has_scheme(trimmed) {
				return None;
			}
			if trimmed.starts_with('/') {
				return Some(format!("{origin}{trimmed}"));
			}
			if trimmed.starts_with('#') {
				return None;
			}
			Some(format!("{origin}{}", resolve_relative(trimmed, page_url)))
		}
		UrlTarget::RootRelative => {
			let rest = trimmed.strip_prefix(origin)?;
			match rest.chars().next() {
				None => Some("/".to_owned()),
				Some('/') => Some(rest.to_owned()),
				Some('?' | '#') => Some(format!("/{rest}")),
				Some(_) => None,
			}
		}
	}
}

/// The `srcset` candidates of `value` as `(url_start, url_end)` byte ranges,
/// found the way the HTML specification's parser does: a URL is a run of
/// non-white-space; a URL that ends in commas is a candidate without
/// descriptors, and the commas are separators, not part of the URL; otherwise
/// the descriptors run to the next comma outside parentheses. This is what
/// keeps `data:` URIs and `w_100,h_100` style paths whole.
fn srcset_urls(value: &str) -> Vec<(usize, usize)> {
	let bytes = value.as_bytes();
	let is_space = |b: u8| matches!(b, b' ' | b'\t' | b'\n' | b'\r' | 0x0c);
	let mut out = Vec::new();
	let mut i = 0;
	while i < bytes.len() {
		while i < bytes.len() && (is_space(bytes[i]) || bytes[i] == b',') {
			i += 1;
		}
		if i >= bytes.len() {
			break;
		}
		let start = i;
		while i < bytes.len() && !is_space(bytes[i]) {
			i += 1;
		}
		let mut end = i;
		let trailing_commas = bytes[start..end]
			.iter()
			.rev()
			.take_while(|&&b| b == b',')
			.count();
		if trailing_commas > 0 {
			end -= trailing_commas;
		} else {
			// descriptors: up to a comma that is not inside parentheses
			let mut depth = 0_i32;
			while i < bytes.len() {
				match bytes[i] {
					b'(' => depth += 1,
					b')' if depth > 0 => depth -= 1,
					b',' if depth == 0 => break,
					_ => {}
				}
				i += 1;
			}
		}
		if end > start {
			out.push((start, end));
		}
	}
	out
}

fn rewrite_attribute(
	name: &str,
	value: &str,
	to: UrlTarget,
	origin: &str,
	page_url: &str,
) -> Option<String> {
	if name != "srcset" {
		return rewrite_one(value, to, origin, page_url);
	}
	let mut out = String::with_capacity(value.len());
	let mut copied = 0;
	let mut changed = false;
	for (start, end) in srcset_urls(value) {
		if let Some(new) = rewrite_one(&value[start..end], to, origin, page_url) {
			out.push_str(&value[copied..start]);
			out.push_str(&new);
			copied = end;
			changed = true;
		}
	}
	out.push_str(&value[copied..]);
	changed.then_some(out)
}

// ----- applying -----

fn root_error(action: &str) -> RuleError {
	RuleError(format!(
		"`{action}` cannot be applied to the root element of a document"
	))
}

pub(crate) fn fragment(doc: &mut Document, html: &str) -> Vec<NodeId> {
	let parsed = parse(html);
	let holder = doc.import_subtree(&parsed, ROOT);
	let children: Vec<NodeId> = doc.children(holder).collect();
	for &c in &children {
		doc.detach(c);
	}
	children
}

fn class_tokens(doc: &Document, node: NodeId) -> Vec<String> {
	attr_ignore_case(doc, node, "class")
		.map(|v| v.split_ascii_whitespace().map(str::to_owned).collect())
		.unwrap_or_default()
}

fn set_attribute(doc: &mut Document, node: NodeId, name: &str, value: &str) {
	if let Some(element) = doc.element_mut(node) {
		match element
			.attrs
			.iter_mut()
			.find(|a| a.name.eq_ignore_ascii_case(name))
		{
			Some(existing) => existing.value = value.to_owned(),
			None => element.set_attr(name, value),
		}
	}
}

fn apply_to(
	page: &mut Page,
	node: NodeId,
	action: &Action,
	ctx: &Context<'_>,
) -> Result<(), RuleError> {
	let is_root = page.root == Some(node);
	match action {
		Action::Remove => {
			if is_root {
				return Err(root_error("remove"));
			}
			page.doc.detach(node);
		}
		Action::Unwrap => {
			if is_root {
				return Err(root_error("unwrap"));
			}
			let children: Vec<NodeId> = page.doc.children(node).collect();
			for child in children {
				page.doc.insert_before(node, child);
			}
			page.doc.detach(node);
		}
		Action::Wrap(template) => {
			if is_root {
				return Err(root_error("wrap"));
			}
			const MARKER: &str = "<kd-content-marker></kd-content-marker>";
			let html = template.render(&page.doc, node, ctx, MARKER, true);
			let nodes = fragment(&mut page.doc, &html);
			let marker = nodes
				.iter()
				.copied()
				.flat_map(|n| subtree(&page.doc, n))
				.find(|&n| {
					page.doc
						.element(n)
						.is_some_and(|e| e.name == "kd-content-marker")
				})
				.ok_or_else(|| {
					RuleError(
						"the wrap markup lost its {{content}} position while parsing".to_owned(),
					)
				})?;
			for &n in &nodes {
				page.doc.insert_before(node, n);
			}
			page.doc.insert_before(marker, node);
			page.doc.detach(marker);
		}
		Action::SetAttr { name, value } => {
			let rendered = value.render(&page.doc, node, ctx, "", false);
			set_attribute(&mut page.doc, node, name, &rendered);
		}
		Action::RemoveAttr(matcher) => {
			let names: Vec<String> = page
				.doc
				.element(node)
				.map(|e| e.attrs.iter().map(|a| a.name.clone()).collect())
				.unwrap_or_default();
			for name in names {
				let hit = match matcher {
					NameMatcher::Exact(exact) => name.eq_ignore_ascii_case(exact),
					NameMatcher::Pattern(p) => {
						p.is_match(&name).map_err(|e| RuleError(e.to_string()))?
					}
				};
				if hit && let Some(e) = page.doc.element_mut(node) {
					e.remove_attr(&name);
				}
			}
		}
		Action::AddClass(class) => {
			let mut tokens = class_tokens(&page.doc, node);
			if !tokens.contains(class) {
				tokens.push(class.clone());
			}
			set_attribute(&mut page.doc, node, "class", &tokens.join(" "));
		}
		Action::RemoveClass(class) => {
			let tokens: Vec<String> = class_tokens(&page.doc, node)
				.into_iter()
				.filter(|t| t != class)
				.collect();
			if attr_ignore_case(&page.doc, node, "class").is_some() {
				set_attribute(&mut page.doc, node, "class", &tokens.join(" "));
			}
		}
		Action::Insert { position, html } => {
			let rendered = html.render(&page.doc, node, ctx, "", true);
			let nodes = fragment(&mut page.doc, &rendered);
			match position {
				Position::Before | Position::After if is_root => return Err(root_error("insert")),
				Position::Before => {
					for n in nodes {
						page.doc.insert_before(node, n);
					}
				}
				Position::After => {
					let mut anchor = node;
					for n in nodes {
						page.doc.insert_after(anchor, n);
						anchor = n;
					}
				}
				Position::Prepend => {
					for n in nodes.into_iter().rev() {
						page.doc.prepend_child(node, n);
					}
				}
				Position::Append => {
					for n in nodes {
						page.doc.append_child(node, n);
					}
				}
			}
		}
		Action::RewriteUrl { to, origin, attrs } => {
			for attr in attrs {
				let Some(value) = attr_ignore_case(&page.doc, node, attr).map(str::to_owned) else {
					continue;
				};
				if let Some(new) = rewrite_attribute(attr, &value, *to, origin, ctx.url) {
					set_attribute(&mut page.doc, node, attr, &new);
				}
			}
		}
	}
	Ok(())
}

/// `node` and everything below it.
fn subtree(doc: &Document, node: NodeId) -> Vec<NodeId> {
	let mut out = vec![node];
	let mut i = 0;
	while i < out.len() {
		let current = out[i];
		out.extend(doc.children(current));
		i += 1;
	}
	out
}

/// Applies `rules` to `page`, in order.
///
/// # Errors
///
/// A [`RuleError`] when an action cannot be applied (e.g. removing the root
/// element, or a pattern that ran out of budget).
pub fn apply<'r>(
	page: &mut Page,
	rules: impl IntoIterator<Item = &'r Rule>,
	ctx: &Context<'_>,
) -> Result<(), RuleError> {
	for rule in rules {
		let matched = rule.selector.select_all(&page.doc);
		for node in matched {
			// An earlier match may have detached this node's ancestor; its
			// subtree is then outside the page and acting on it is harmless.
			apply_to(page, node, &rule.action, ctx)?;
		}
	}
	Ok(())
}

/// Whether a node is a text node with only whitespace; used by callers that
/// decide whether a container is empty.
#[must_use]
pub fn is_blank_text(doc: &Document, node: NodeId) -> bool {
	matches!(doc.kind(node), NodeKind::Text(t) if t.trim().is_empty())
}

#[cfg(test)]
mod tests {
	use super::*;

	const HOST: &str = "example.com";

	fn ctx() -> Context<'static> {
		Context {
			url: "/a/b/",
			base_url: "https://example.com/",
			host: HOST,
		}
	}

	fn run(html: &str, rules: &[Rule]) -> String {
		let mut page = Page::parse(html);
		apply(&mut page, rules, &ctx()).unwrap();
		page.serialize()
	}

	#[test]
	fn remove_and_unwrap() {
		let r = [Rule::remove("script[src*='ads']", HOST).unwrap()];
		assert_eq!(
			run(
				"<p>a</p><script src=ads.js></script><script src=app.js></script>",
				&r
			),
			"<p>a</p><script src=\"app.js\"></script>"
		);
		let r = [Rule::unwrap("span.x", HOST).unwrap()];
		assert_eq!(
			run("<p>a<span class=x>b<i>c</i></span>d</p>", &r),
			"<p>ab<i>c</i>d</p>"
		);
		let r = [Rule::remove("p", HOST).unwrap()];
		assert_eq!(run("<div><p>a<p>b</div>", &r), "<div></div>");
	}

	#[test]
	fn wrap_puts_the_element_where_content_is() {
		let r = [Rule::wrap("table", HOST, "<div class=\"scroll\">{{content}}</div>").unwrap()];
		assert_eq!(
			run("<p>a</p><table><tr><td>x</td></tr></table>", &r),
			"<p>a</p><div class=\"scroll\"><table><tr><td>x</td></tr></table></div>"
		);
		let r = [Rule::wrap(
			"img",
			HOST,
			"<a href=\"{{attr:src}}\"><span>{{content}}</span></a>",
		)
		.unwrap()];
		assert_eq!(
			run("<img src=\"/x.png\">", &r),
			"<a href=\"/x.png\"><span><img src=\"/x.png\"></span></a>"
		);
		assert!(Rule::wrap("p", HOST, "<div></div>").is_err());
		assert!(Rule::wrap("p", HOST, "{{content}}{{content}}").is_err());
	}

	#[test]
	fn set_attr_replaces_in_place_or_appends_and_expands_templates() {
		let r = [Rule::set_attr("a", HOST, "rel", "noopener").unwrap()];
		assert_eq!(
			run("<a href=x rel=old>t</a><a href=y>u</a>", &r),
			"<a href=\"x\" rel=\"noopener\">t</a><a href=\"y\" rel=\"noopener\">u</a>"
		);
		let r = [Rule::set_attr(
			"a",
			HOST,
			"data-p",
			"{{url}}|{{baseURL}}|{{host}}|{{attr:href}}|{{attr:none}}",
		)
		.unwrap()];
		assert_eq!(
			run("<a href=x>t</a>", &r),
			"<a href=\"x\" data-p=\"/a/b/|https://example.com/|example.com|x|\">t</a>"
		);
		assert!(Rule::set_attr("a", HOST, "rel", "{{nope}}").is_err());
		assert!(Rule::set_attr("a", HOST, "rel", "{{content}}").is_err());
		assert!(Rule::set_attr("a", HOST, "bad name", "x").is_err());
	}

	#[test]
	fn host_in_a_selector_picks_external_links() {
		let r = [Rule::set_attr(
			"a[href^='http']:not([href*='{{host}}'])",
			HOST,
			"target",
			"_blank",
		)
		.unwrap()];
		assert_eq!(
			run(
				"<a href=\"https://example.com/x\">in</a><a href=\"https://other.test/\">out</a>",
				&r
			),
			"<a href=\"https://example.com/x\">in</a><a href=\"https://other.test/\" target=\"_blank\">out</a>"
		);
	}

	#[test]
	fn remove_attr_by_name_or_pattern() {
		let r = [Rule::remove_attr("p", HOST, "style").unwrap()];
		assert_eq!(run("<p style=\"a\" id=k>x</p>", &r), "<p id=\"k\">x</p>");
		let r = [Rule::remove_attr("*", HOST, "/^(data-|on)/").unwrap()];
		assert_eq!(
			run("<p data-a=1 onclick=f() id=k>x</p>", &r),
			"<p id=\"k\">x</p>"
		);
		assert!(Rule::remove_attr("p", HOST, "/(/").is_err());
	}

	#[test]
	fn classes_are_added_once_and_removed_by_token() {
		let r = [Rule::add_class("p", HOST, "lead").unwrap()];
		assert_eq!(
			run("<p class=\"a\">x</p><p>y</p><p class=\"lead b\">z</p>", &r),
			"<p class=\"a lead\">x</p><p class=\"lead\">y</p><p class=\"lead b\">z</p>"
		);
		let r = [Rule::remove_class("p", HOST, "a").unwrap()];
		assert_eq!(
			run("<p class=\"a b a\">x</p><p class=\"ab\">y</p><p>z</p>", &r),
			"<p class=\"b\">x</p><p class=\"ab\">y</p><p>z</p>"
		);
		assert!(Rule::add_class("p", HOST, "a b").is_err());
		assert!(Rule::add_class("p", HOST, " ").is_err());
	}

	#[test]
	fn insert_in_each_position() {
		let cases = [
			(Position::Before, "<i>x</i><p>a</p>"),
			(Position::After, "<p>a</p><i>x</i>"),
			(Position::Prepend, "<p><i>x</i>a</p>"),
			(Position::Append, "<p>a<i>x</i></p>"),
		];
		for (position, expected) in cases {
			let r = [Rule::insert("p", HOST, position, "<i>x</i>").unwrap()];
			assert_eq!(run("<p>a</p>", &r), expected, "{position:?}");
		}
		let r = [Rule::insert("p", HOST, Position::After, "<i>1</i><b>2</b>").unwrap()];
		assert_eq!(run("<p>a</p>", &r), "<p>a</p><i>1</i><b>2</b>");
		let r = [Rule::insert("p", HOST, Position::Prepend, "<i>1</i><b>2</b>").unwrap()];
		assert_eq!(run("<p>a</p>", &r), "<p><i>1</i><b>2</b>a</p>");
	}

	#[test]
	fn insert_into_a_document_reaches_head_and_body() {
		let r = [Rule::insert("head", HOST, Position::Append, "<link rel=\"x\">").unwrap()];
		assert_eq!(
			run(
				"<!doctype html><html><head><title>t</title></head><body></body></html>",
				&r
			),
			"<html><head><title>t</title><link rel=\"x\"></head><body></body></html>"
		);
		let r = [Rule::insert("html", HOST, Position::After, "<i></i>").unwrap()];
		let mut page = Page::parse("<html><body></body></html>");
		assert!(
			apply(&mut page, &r, &ctx()).is_err(),
			"the root element has no siblings to write to"
		);
		let r = [Rule::remove("html", HOST).unwrap()];
		assert!(apply(&mut page, &r, &ctx()).is_err());
	}

	#[test]
	fn rewrite_url_to_absolute() {
		let r = [Rule::rewrite_url(
			"a, img",
			HOST,
			UrlTarget::Absolute,
			"https://example.com/",
			&[],
		)
		.unwrap()];
		assert_eq!(
			run(
				"<a href=\"/x\">1</a><a href=\"y.html?q=1#h\">2</a><a href=\"../z\">3</a><a href=\"//cdn.test/a\">4</a><a href=\"https://o.test/\">5</a><a href=\"#top\">6</a><a href=\"mailto:a@b.test\">7</a><a href=\"javascript:void(0)\">8</a><img src=\"i.png\" srcset=\"a.png 1x, /b.png 2x\">",
				&r
			),
			"<a href=\"https://example.com/x\">1</a><a href=\"https://example.com/a/b/y.html?q=1#h\">2</a><a href=\"https://example.com/a/z\">3</a><a href=\"//cdn.test/a\">4</a><a href=\"https://o.test/\">5</a><a href=\"#top\">6</a><a href=\"mailto:a@b.test\">7</a><a href=\"javascript:void(0)\">8</a><img src=\"https://example.com/a/b/i.png\" srcset=\"https://example.com/a/b/a.png 1x, https://example.com/b.png 2x\">"
		);
	}

	#[test]
	fn rewrite_url_to_root_relative() {
		let r = [Rule::rewrite_url(
			"a",
			HOST,
			UrlTarget::RootRelative,
			"https://example.com",
			&["href"],
		)
		.unwrap()];
		assert_eq!(
			run(
				"<a href=\"https://example.com/x?y=1\">1</a><a href=\"https://example.com\">2</a><a href=\"https://example.com?q\">3</a><a href=\"https://example.com.test/\">4</a><a href=\"https://other.test/\">5</a><a href=\"/rel\">6</a>",
				&r
			),
			"<a href=\"/x?y=1\">1</a><a href=\"/\">2</a><a href=\"/?q\">3</a><a href=\"https://example.com.test/\">4</a><a href=\"https://other.test/\">5</a><a href=\"/rel\">6</a>"
		);
	}

	#[test]
	fn rewrite_url_origins_are_validated() {
		for bad in [
			"",
			"example.com",
			"ftp://example.com",
			"https://user:pw@example.com",
			"https://example.com/path",
			"https://",
		] {
			assert!(
				Rule::rewrite_url("a", HOST, UrlTarget::Absolute, bad, &[]).is_err(),
				"`{bad}` should be refused"
			);
		}
	}

	#[test]
	fn rules_apply_in_order_and_see_earlier_results() {
		let r = [
			Rule::add_class("p", HOST, "x").unwrap(),
			Rule::set_attr("p.x", HOST, "data-seen", "1").unwrap(),
		];
		assert_eq!(run("<p>a</p>", &r), "<p class=\"x\" data-seen=\"1\">a</p>");
	}

	#[test]
	fn nested_matches_do_not_break_the_tree() {
		let r = [Rule::unwrap("div", HOST).unwrap()];
		assert_eq!(run("<div>a<div>b<div>c</div></div></div>", &r), "abc");
		let r = [Rule::wrap("div", HOST, "<section>{{content}}</section>").unwrap()];
		assert_eq!(
			run("<div><div></div></div>", &r),
			"<section><div><section><div></div></section></div></section>"
		);
	}

	#[test]
	fn php_in_attributes_and_nodes_survives_untouched_rules() {
		let r = [Rule::set_attr("p", HOST, "data-x", "1").unwrap()];
		assert_eq!(
			run("<p class=\"<?php echo $c; ?>\"><?php echo $t; ?></p>", &r),
			"<p class=\"<?php echo $c; ?>\" data-x=\"1\"><?php echo $t; ?></p>"
		);
	}

	#[test]
	fn invalid_selectors_are_rejected_when_the_rule_is_built() {
		assert!(Rule::remove("p:hover", HOST).is_err());
		assert!(Rule::remove("", HOST).is_err());
	}

	#[test]
	fn srcset_keeps_data_uris_and_comma_paths_whole() {
		let r = [
			Rule::rewrite_url("img", HOST, UrlTarget::Absolute, "https://example.com", &[])
				.unwrap(),
		];
		assert_eq!(
			run(
				"<img srcset=\"data:image/png;base64,AAA 1x, b.png 2x\">",
				&r
			),
			"<img srcset=\"data:image/png;base64,AAA 1x, https://example.com/a/b/b.png 2x\">"
		);
		assert_eq!(
			run("<img srcset=\"/img/w_100,h_100/a.jpg 1x\">", &r),
			"<img srcset=\"https://example.com/img/w_100,h_100/a.jpg 1x\">"
		);
		assert_eq!(
			run("<img srcset=\"a.png 1x,\">", &r),
			"<img srcset=\"https://example.com/a/b/a.png 1x,\">"
		);
		assert_eq!(
			run("<img srcset=\" a.png,  b.png 2x ,c.png\">", &r),
			"<img srcset=\" https://example.com/a/b/a.png,  https://example.com/a/b/b.png 2x ,https://example.com/a/b/c.png\">"
		);
	}

	#[test]
	fn relative_urls_resolve_even_for_odd_page_urls() {
		let r = [Rule::rewrite_url(
			"a",
			HOST,
			UrlTarget::Absolute,
			"https://example.com",
			&["href"],
		)
		.unwrap()];
		for url in ["", "page.html", "日本", "?q", "#h"] {
			let mut page = Page::parse("<a href=\"x.html\">t</a>");
			let context = Context {
				url,
				base_url: "https://example.com/",
				host: HOST,
			};
			apply(&mut page, &r, &context).unwrap();
			assert_eq!(
				page.serialize(),
				"<a href=\"https://example.com/x.html\">t</a>",
				"url `{url}`"
			);
		}
		let mut page =
			Page::parse("<a href=\"a/..\">1</a><a href=\"a/.\">2</a><a href=\"..\">3</a>");
		let context = Context {
			url: "/a/b.html",
			base_url: "https://example.com/",
			host: HOST,
		};
		apply(&mut page, &r, &context).unwrap();
		assert_eq!(
			page.serialize(),
			"<a href=\"https://example.com/a/\">1</a><a href=\"https://example.com/a/a/\">2</a><a href=\"https://example.com/\">3</a>"
		);
	}

	#[test]
	fn attribute_values_do_not_break_out_of_markup_templates() {
		let r = [Rule::wrap("img", HOST, "<a href=\"{{attr:src}}\">{{content}}</a>").unwrap()];
		assert_eq!(
			run("<img src='a\"b onerror=x'>", &r),
			"<a href=\"a&quot;b onerror=x\"><img src=\"a&quot;b onerror=x\"></a>"
		);
		// A template that quotes the attribute with `'` is safe as well.
		let r = [Rule::wrap("img", HOST, "<a href='{{attr:src}}'>{{content}}</a>").unwrap()];
		assert_eq!(
			run("<img src=\"a'b onerror=x\">", &r),
			"<a href=\"a'b onerror=x\"><img src=\"a'b onerror=x\"></a>"
		);
		let r = [Rule::insert("p", HOST, Position::After, "<i>{{attr:title}}</i>").unwrap()];
		assert_eq!(
			run("<p title='&lt;b&gt;x'>t</p>", &r),
			"<p title=\"<b>x\">t</p><i>&lt;b&gt;x</i>"
		);
		// setAttr writes the value as it is: it is not parsed as markup.
		let r = [Rule::set_attr("p", HOST, "data-t", "{{attr:title}}").unwrap()];
		assert_eq!(
			run("<p title='a&amp;b'>t</p>", &r),
			"<p title=\"a&b\" data-t=\"a&b\">t</p>"
		);
	}

	#[test]
	fn insert_reaches_the_body_of_a_document_too() {
		let r = [Rule::insert("body", HOST, Position::Prepend, "<i></i>").unwrap()];
		assert_eq!(
			run("<html><head></head><body><p>x</p></body></html>", &r),
			"<html><head></head><body><i></i><p>x</p></body></html>"
		);
	}

	#[test]
	fn the_root_element_cannot_be_unwrapped_wrapped_or_given_siblings() {
		let page_html = "<html><body>x</body></html>";
		let cases = [
			Rule::unwrap("html", HOST).unwrap(),
			Rule::wrap("html", HOST, "<div>{{content}}</div>").unwrap(),
			Rule::insert("html", HOST, Position::Before, "<i></i>").unwrap(),
		];
		for rule in cases {
			let mut page = Page::parse(page_html);
			assert!(apply(&mut page, &[rule], &ctx()).is_err());
		}
	}

	#[test]
	fn template_syntax_errors_are_reported_when_the_rule_is_built() {
		assert!(Rule::set_attr("a", HOST, "x", "{{url").is_err());
		assert!(Rule::set_attr("a", HOST, "x", "{{attr:}}").is_err());
		assert!(Rule::insert("a", HOST, Position::After, "{{content}}").is_err());
		assert!(
			Rule::set_attr("a", HOST, "x", "{{ url }}").is_ok(),
			"white space inside the braces is trimmed"
		);
	}

	#[test]
	fn a_wrap_whose_content_position_is_swallowed_by_the_parser_is_an_error() {
		let r = [Rule::wrap("p", HOST, "<textarea>{{content}}</textarea>").unwrap()];
		let mut page = Page::parse("<p>x</p>");
		assert!(apply(&mut page, &r, &ctx()).is_err());
	}
}
