//! Page metadata: the four sources and how they merge.
//!
//! Sources, lowest priority first:
//! 1. in-file metadata (`export const meta = {...}` in a `.tsx` page, or
//!    YAML front matter in an `.html` page),
//! 2. a sidecar `.json` next to the page (`page.tsx` → `page.json`),
//! 3. `pages.overrides` (an external JSON file keyed by URL).
//!
//! Higher priority replaces a key wholesale: objects are not merged
//! recursively, so an override of `og` replaces the whole `og` object. Why:
//! deep merging makes "remove this key" impossible to express and hides
//! where a value came from.
//!
//! Overrides also declare virtual pages (`virtual: true`): entries that exist
//! in the page index for navigation without an input file.

use std::collections::BTreeMap;

use kd_jsonc::Value;

/// A key/value metadata object with insertion order.
pub type Meta = Vec<(String, Value)>;

/// Merges metadata layers; later layers win per key.
///
/// # Example
///
/// ```
/// use kd_jsonc::Value;
/// let base = vec![("title".to_string(), Value::String("A".into())), ("layout".to_string(), Value::String("sub".into()))];
/// let side = vec![("title".to_string(), Value::String("B".into()))];
/// let merged = kd_site::meta::merge(&[&base, &side]);
/// assert_eq!(Value::Object(merged).to_json(), r#"{"title":"B","layout":"sub"}"#);
/// ```
#[must_use]
pub fn merge(layers: &[&Meta]) -> Meta {
	let mut out: Meta = Vec::new();
	for layer in layers {
		for (k, v) in layer.iter() {
			match out.iter_mut().find(|(ek, _)| ek == k) {
				Some(slot) => slot.1 = v.clone(),
				None => out.push((k.clone(), v.clone())),
			}
		}
	}
	out
}

/// Returns the object pairs of a value, or an empty list for `null`.
/// Anything else is an error, because metadata must be an object.
pub fn as_meta(value: &Value, what: &str) -> Result<Meta, String> {
	match value {
		Value::Object(pairs) => Ok(pairs.clone()),
		Value::Null => Ok(Vec::new()),
		_ => Err(format!("{what}: metadata must be an object")),
	}
}

/// One entry of the `pages.overrides` file.
#[derive(Debug, Clone, PartialEq)]
pub struct Override {
	pub url: String,
	pub is_virtual: bool,
	pub meta: Meta,
	pub lastmod: Option<String>,
}

/// Parsed `pages.overrides` file.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Overrides {
	/// Keyed by URL; insertion order of the file is kept for virtual pages.
	pub by_url: BTreeMap<String, Override>,
	pub order: Vec<String>,
}

impl Overrides {
	/// Parses the overrides JSON (`{"version": 1, "pages": [...]}`).
	///
	/// # Example
	///
	/// ```
	/// let o = kd_site::meta::Overrides::parse(r#"{"version":1,"pages":[{"url":"/service/","virtual":true,"meta":{"title":"S"}}]}"#).unwrap();
	/// assert!(o.by_url["/service/"].is_virtual);
	/// ```
	pub fn parse(text: &str) -> Result<Overrides, String> {
		let value = kd_jsonc::parse(text).map_err(|e| {
			format!(
				"pages.overrides: invalid JSON at {}:{}: {}",
				e.line, e.column, e.message
			)
		})?;
		let version = value
			.get("version")
			.and_then(|v| v.as_f64())
			.ok_or("pages.overrides: \"version\" is required")?;
		if version != 1.0 {
			return Err(format!("pages.overrides: unsupported version {version}"));
		}
		let pages = value
			.get("pages")
			.and_then(|v| v.as_array())
			.ok_or("pages.overrides: \"pages\" must be an array")?;
		let mut out = Overrides::default();
		for (i, page) in pages.iter().enumerate() {
			let at = format!("pages.overrides: pages[{i}]");
			let Value::Object(pairs) = page else {
				return Err(format!("{at}: expected an object"));
			};
			for (k, _) in pairs {
				if !matches!(k.as_str(), "url" | "virtual" | "meta" | "lastmod") {
					return Err(format!(
						"{at}: unknown key {k:?} (allowed: url, virtual, meta, lastmod)"
					));
				}
			}
			let url = page
				.get("url")
				.and_then(|v| v.as_str())
				.ok_or_else(|| format!("{at}: \"url\" (string) is required"))?;
			if !url.starts_with('/') {
				return Err(format!("{at}: \"url\" must start with '/': {url:?}"));
			}
			let is_virtual = match page.get("virtual") {
				None => false,
				Some(Value::Bool(b)) => *b,
				Some(_) => return Err(format!("{at}: \"virtual\" must be a boolean")),
			};
			let meta = match page.get("meta") {
				None => Vec::new(),
				Some(v) => as_meta(v, &format!("{at}.meta"))?,
			};
			let lastmod = match page.get("lastmod") {
				None | Some(Value::Null) => None,
				Some(Value::String(s)) => Some(s.clone()),
				Some(_) => return Err(format!("{at}: \"lastmod\" must be a string")),
			};
			if out.by_url.contains_key(url) {
				return Err(format!("{at}: duplicate url {url:?}"));
			}
			out.order.push(url.to_string());
			out.by_url.insert(
				url.to_string(),
				Override {
					url: url.to_string(),
					is_virtual,
					meta,
					lastmod,
				},
			);
		}
		Ok(out)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn obj(json: &str) -> Meta {
		match kd_jsonc::parse(json).unwrap() {
			Value::Object(p) => p,
			_ => panic!("object"),
		}
	}

	#[test]
	fn later_layers_replace_keys_wholesale_and_keep_first_seen_order() {
		let file = obj(r#"{"title":"File","og":{"title":"F","image":"f.png"},"layout":"sub"}"#);
		let sidecar = obj(r#"{"og":{"title":"S"},"extra":1}"#);
		let overrides = obj(r#"{"title":"O"}"#);
		let merged = merge(&[&file, &sidecar, &overrides]);
		assert_eq!(
			Value::Object(merged).to_json(),
			r#"{"title":"O","og":{"title":"S"},"layout":"sub","extra":1}"#
		);
	}

	#[test]
	fn empty_layers_are_fine() {
		assert_eq!(merge(&[]), Vec::new());
		assert_eq!(merge(&[&Vec::new(), &obj(r#"{"a":1}"#)]), obj(r#"{"a":1}"#));
	}

	#[test]
	fn as_meta_accepts_objects_and_null_only() {
		assert_eq!(as_meta(&Value::Null, "x").unwrap(), Vec::new());
		assert_eq!(as_meta(&Value::Object(vec![]), "x").unwrap(), Vec::new());
		assert_eq!(
			as_meta(&Value::Array(vec![]), "page.json").unwrap_err(),
			"page.json: metadata must be an object"
		);
	}

	#[test]
	fn overrides_parse_virtual_pages_meta_and_lastmod() {
		let o = Overrides::parse(
			r#"{"version":1,"pages":[
				{"url":"/service/","virtual":true,"meta":{"title":"Service","navHidden":true},"lastmod":"2026-01-02"},
				{"url":"/about/","meta":{"realHref":"https://example.com/about/"}}
			]}"#,
		)
		.unwrap();
		assert_eq!(o.order, ["/service/", "/about/"]);
		let s = &o.by_url["/service/"];
		assert!(s.is_virtual);
		assert_eq!(
			Value::Object(s.meta.clone()).to_json(),
			r#"{"title":"Service","navHidden":true}"#
		);
		assert_eq!(s.lastmod.as_deref(), Some("2026-01-02"));
		let a = &o.by_url["/about/"];
		assert!(!a.is_virtual);
		assert_eq!(a.lastmod, None);
	}

	#[test]
	fn overrides_reject_bad_shapes_with_a_clear_message() {
		assert!(
			Overrides::parse("{")
				.unwrap_err()
				.starts_with("pages.overrides: invalid JSON")
		);
		assert_eq!(
			Overrides::parse(r#"{"pages":[]}"#).unwrap_err(),
			"pages.overrides: \"version\" is required"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":2,"pages":[]}"#).unwrap_err(),
			"pages.overrides: unsupported version 2"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1}"#).unwrap_err(),
			"pages.overrides: \"pages\" must be an array"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[1]}"#).unwrap_err(),
			"pages.overrides: pages[0]: expected an object"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"meta":{}}]}"#).unwrap_err(),
			"pages.overrides: pages[0]: \"url\" (string) is required"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"url":"about/"}]}"#).unwrap_err(),
			"pages.overrides: pages[0]: \"url\" must start with '/': \"about/\""
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"url":"/a/","virtual":"yes"}]}"#)
				.unwrap_err(),
			"pages.overrides: pages[0]: \"virtual\" must be a boolean"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"url":"/a/","meta":[]}]}"#).unwrap_err(),
			"pages.overrides: pages[0].meta: metadata must be an object"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"url":"/a/","title":"x"}]}"#).unwrap_err(),
			"pages.overrides: pages[0]: unknown key \"title\" (allowed: url, virtual, meta, lastmod)"
		);
		assert_eq!(
			Overrides::parse(r#"{"version":1,"pages":[{"url":"/a/"},{"url":"/a/"}]}"#).unwrap_err(),
			"pages.overrides: pages[1]: duplicate url \"/a/\""
		);
	}
}
