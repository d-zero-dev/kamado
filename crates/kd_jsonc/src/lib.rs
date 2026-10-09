//! JSONC (JSON with comments) parser for `kamado.config.jsonc`.
//!
//! Accepts strict JSON plus `//` line comments, `/* */` block comments and
//! trailing commas in arrays and objects. Everything else that JSON5 allows
//! (single quotes, unquoted keys, `NaN`, hex numbers) is rejected: the file is
//! read by both this parser and editors' JSON Schema support, and editors
//! only understand the JSONC subset.
//!
//! Why duplicate keys are an error: the config drives a build, and a duplicated
//! key is almost always a typo that would otherwise be silently resolved by
//! "last one wins".
//!
//! Object key order is preserved so that serialization is deterministic and
//! can feed a content hash.

use std::collections::HashSet;
use std::fmt;

/// Objects with fewer keys than this are checked for a duplicate key by a scan of the
/// keys so far, which needs no set for the few keys of a config; from this many on the
/// keys go into a set, so that an object of N keys costs N, not N squared (`data.dir`
/// files can hold tens of thousands). The value is a round number, not a measurement:
/// below it either way costs next to nothing.
const LINEAR_KEYS: usize = 16;

/// A parsed JSON value. Objects keep their key order.
#[derive(Debug, Clone, PartialEq)]
pub enum Value {
	Null,
	Bool(bool),
	Number(f64),
	String(String),
	Array(Vec<Value>),
	Object(Vec<(String, Value)>),
}

impl Value {
	/// Looks up a key of an object. Returns `None` for other kinds of values.
	///
	/// # Example
	///
	/// ```
	/// let v = kd_jsonc::parse(r#"{ "dir": { "input": "src" } }"#).unwrap();
	/// assert_eq!(v.get("dir").and_then(|d| d.get("input")).and_then(|s| s.as_str()), Some("src"));
	/// ```
	#[must_use]
	pub fn get(&self, key: &str) -> Option<&Value> {
		match self {
			Value::Object(pairs) => pairs.iter().find(|(k, _)| k == key).map(|(_, v)| v),
			_ => None,
		}
	}

	#[must_use]
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Value::String(s) => Some(s),
			_ => None,
		}
	}

	#[must_use]
	pub fn as_bool(&self) -> Option<bool> {
		match self {
			Value::Bool(b) => Some(*b),
			_ => None,
		}
	}

	#[must_use]
	pub fn as_f64(&self) -> Option<f64> {
		match self {
			Value::Number(n) => Some(*n),
			_ => None,
		}
	}

	#[must_use]
	pub fn as_array(&self) -> Option<&[Value]> {
		match self {
			Value::Array(items) => Some(items),
			_ => None,
		}
	}

	#[must_use]
	pub fn as_object(&self) -> Option<&[(String, Value)]> {
		match self {
			Value::Object(pairs) => Some(pairs),
			_ => None,
		}
	}

	#[must_use]
	pub fn is_null(&self) -> bool {
		matches!(self, Value::Null)
	}

	/// Serializes to compact JSON (no comments, no trailing commas, no whitespace).
	///
	/// Numbers that are integers print without a fractional part.
	///
	/// # Example
	///
	/// ```
	/// let v = kd_jsonc::parse("{ /* c */ \"a\": [1, 2.5, true,], }").unwrap();
	/// assert_eq!(v.to_json(), r#"{"a":[1,2.5,true]}"#);
	/// ```
	#[must_use]
	pub fn to_json(&self) -> String {
		let mut out = String::new();
		self.write_json(&mut out);
		out
	}

	fn write_json(&self, out: &mut String) {
		match self {
			Value::Null => out.push_str("null"),
			Value::Bool(true) => out.push_str("true"),
			Value::Bool(false) => out.push_str("false"),
			Value::Number(n) => write_number(*n, out),
			Value::String(s) => write_string(s, out),
			Value::Array(items) => {
				out.push('[');
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						out.push(',');
					}
					item.write_json(out);
				}
				out.push(']');
			}
			Value::Object(pairs) => {
				out.push('{');
				for (i, (k, v)) in pairs.iter().enumerate() {
					if i > 0 {
						out.push(',');
					}
					write_string(k, out);
					out.push(':');
					v.write_json(out);
				}
				out.push('}');
			}
		}
	}
}

fn write_number(n: f64, out: &mut String) {
	if !n.is_finite() {
		// JSON has no NaN or Infinity (`.nan` of YAML gets here); `JSON.stringify` says null.
		out.push_str("null");
	} else if n.is_finite() && n.fract() == 0.0 && n.abs() < 1e15 {
		// Avoid "1.0" and "-0" for integral values.
		let i = n as i64;
		out.push_str(&i.to_string());
	} else if n.abs() >= 1e15 {
		// Rust's Display never uses an exponent; keep large values short and
		// in the same form JSON parsers everywhere accept.
		out.push_str(&format!("{n:e}"));
	} else {
		out.push_str(&n.to_string());
	}
}

fn write_string(s: &str, out: &mut String) {
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{08}' => out.push_str("\\b"),
			'\u{0C}' => out.push_str("\\f"),
			c if (c as u32) < 0x20 => {
				out.push_str(&format!("\\u{:04x}", c as u32));
			}
			c => out.push(c),
		}
	}
	out.push('"');
}

/// A parse error with a 1-based line and column.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error {
	pub line: usize,
	pub column: usize,
	pub message: String,
}

impl fmt::Display for Error {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{}:{}: {}", self.line, self.column, self.message)
	}
}

impl std::error::Error for Error {}

/// Parses a JSONC document. A leading UTF-8 BOM is accepted.
///
/// # Example
///
/// ```
/// let v = kd_jsonc::parse(r#"
///   // comment
///   { "port": 3000, /* inline */ "open": true, }
/// "#).unwrap();
/// assert_eq!(v.get("port").and_then(|p| p.as_f64()), Some(3000.0));
/// ```
pub fn parse(input: &str) -> Result<Value, Error> {
	let input = input.strip_prefix('\u{FEFF}').unwrap_or(input);
	let mut p = Parser {
		bytes: input.as_bytes(),
		pos: 0,
		depth: 0,
	};
	p.skip_trivia()?;
	let value = p.parse_value()?;
	p.skip_trivia()?;
	if p.pos < p.bytes.len() {
		return Err(p.error("unexpected content after the top-level value"));
	}
	Ok(value)
}

/// Maximum nesting of arrays and objects. Why: parsing recurses, user-authored
/// files (sidecars, overrides) are untrusted input, and the build runs inside
/// Node with `panic = "abort"`, so a stack overflow would kill the process.
const MAX_DEPTH: usize = 512;

struct Parser<'a> {
	bytes: &'a [u8],
	pos: usize,
	depth: usize,
}

impl Parser<'_> {
	fn error(&self, message: impl Into<String>) -> Error {
		self.error_at(self.pos, message)
	}

	fn error_at(&self, at: usize, message: impl Into<String>) -> Error {
		let at = at.min(self.bytes.len());
		let mut line = 1;
		let mut column = 1;
		for &b in &self.bytes[..at] {
			if b == b'\n' {
				line += 1;
				column = 1;
			} else if (b & 0xC0) != 0x80 {
				// Count characters, not UTF-8 continuation bytes.
				column += 1;
			}
		}
		Error {
			line,
			column,
			message: message.into(),
		}
	}

	fn peek(&self) -> Option<u8> {
		self.bytes.get(self.pos).copied()
	}

	/// Skips whitespace and comments.
	fn skip_trivia(&mut self) -> Result<(), Error> {
		loop {
			match self.peek() {
				Some(b' ' | b'\t' | b'\n' | b'\r') => self.pos += 1,
				Some(b'/') => match self.bytes.get(self.pos + 1) {
					Some(b'/') => {
						while let Some(b) = self.peek() {
							if b == b'\n' {
								break;
							}
							self.pos += 1;
						}
					}
					Some(b'*') => {
						let start = self.pos;
						self.pos += 2;
						loop {
							match self.peek() {
								None => {
									return Err(self.error_at(start, "unterminated block comment"));
								}
								Some(b'*') if self.bytes.get(self.pos + 1) == Some(&b'/') => {
									self.pos += 2;
									break;
								}
								Some(_) => self.pos += 1,
							}
						}
					}
					_ => return Err(self.error("unexpected '/'")),
				},
				_ => return Ok(()),
			}
		}
	}

	fn parse_value(&mut self) -> Result<Value, Error> {
		match self.peek() {
			None => Err(self.error("unexpected end of input")),
			Some(b'{' | b'[') if self.depth >= MAX_DEPTH => {
				Err(self.error(format!("nesting is deeper than {MAX_DEPTH} levels")))
			}
			Some(b'{') => {
				self.depth += 1;
				let r = self.parse_object();
				self.depth -= 1;
				r
			}
			Some(b'[') => {
				self.depth += 1;
				let r = self.parse_array();
				self.depth -= 1;
				r
			}
			Some(b'"') => Ok(Value::String(self.parse_string()?)),
			Some(b't') => self.parse_literal("true", Value::Bool(true)),
			Some(b'f') => self.parse_literal("false", Value::Bool(false)),
			Some(b'n') => self.parse_literal("null", Value::Null),
			Some(b'-' | b'0'..=b'9') => self.parse_number(),
			Some(b'\'') => {
				Err(self.error("single-quoted strings are not allowed; use double quotes"))
			}
			Some(_) => Err(self.error("unexpected character")),
		}
	}

	fn parse_literal(&mut self, word: &str, value: Value) -> Result<Value, Error> {
		if self.bytes[self.pos..].starts_with(word.as_bytes()) {
			self.pos += word.len();
			Ok(value)
		} else {
			Err(self.error(format!("expected '{word}'")))
		}
	}

	fn parse_number(&mut self) -> Result<Value, Error> {
		let start = self.pos;
		if self.peek() == Some(b'-') {
			self.pos += 1;
		}
		match self.peek() {
			Some(b'0') => {
				self.pos += 1;
				if matches!(self.peek(), Some(b'0'..=b'9')) {
					return Err(self.error_at(start, "numbers may not have leading zeros"));
				}
			}
			Some(b'1'..=b'9') => self.skip_digits(),
			_ => return Err(self.error("expected a digit")),
		}
		if self.peek() == Some(b'.') {
			self.pos += 1;
			if !matches!(self.peek(), Some(b'0'..=b'9')) {
				return Err(self.error("expected a digit after '.'"));
			}
			self.skip_digits();
		}
		if matches!(self.peek(), Some(b'e' | b'E')) {
			self.pos += 1;
			if matches!(self.peek(), Some(b'+' | b'-')) {
				self.pos += 1;
			}
			if !matches!(self.peek(), Some(b'0'..=b'9')) {
				return Err(self.error("expected a digit in the exponent"));
			}
			self.skip_digits();
		}
		// The slice is ASCII by construction.
		let text = std::str::from_utf8(&self.bytes[start..self.pos]).expect("ascii");
		match text.parse::<f64>() {
			// `1e999` parses to infinity, which JSON cannot represent.
			Ok(n) if n.is_finite() => Ok(Value::Number(n)),
			Ok(_) => Err(self.error_at(start, "number is out of range")),
			Err(_) => Err(self.error_at(start, "invalid number")),
		}
	}

	fn skip_digits(&mut self) {
		while matches!(self.peek(), Some(b'0'..=b'9')) {
			self.pos += 1;
		}
	}

	fn parse_string(&mut self) -> Result<String, Error> {
		let start = self.pos;
		self.pos += 1; // opening quote
		let mut out = String::new();
		loop {
			let Some(b) = self.peek() else {
				return Err(self.error_at(start, "unterminated string"));
			};
			match b {
				b'"' => {
					self.pos += 1;
					return Ok(out);
				}
				b'\\' => {
					self.pos += 1;
					let esc = self
						.peek()
						.ok_or_else(|| self.error_at(start, "unterminated string"))?;
					self.pos += 1;
					match esc {
						b'"' => out.push('"'),
						b'\\' => out.push('\\'),
						b'/' => out.push('/'),
						b'b' => out.push('\u{08}'),
						b'f' => out.push('\u{0C}'),
						b'n' => out.push('\n'),
						b'r' => out.push('\r'),
						b't' => out.push('\t'),
						b'u' => {
							let code = self.parse_hex4()?;
							let c = if (0xD800..0xDC00).contains(&code) {
								// High surrogate: a low surrogate escape must follow.
								if self.bytes[self.pos..].starts_with(b"\\u") {
									self.pos += 2;
									let low = self.parse_hex4()?;
									if !(0xDC00..0xE000).contains(&low) {
										return Err(
											self.error("invalid low surrogate in \\u escape")
										);
									}
									let combined =
										0x10000 + ((code - 0xD800) << 10) + (low - 0xDC00);
									char::from_u32(combined)
										.ok_or_else(|| self.error("invalid \\u escape"))?
								} else {
									return Err(self.error("lone high surrogate in \\u escape"));
								}
							} else if (0xDC00..0xE000).contains(&code) {
								return Err(self.error("lone low surrogate in \\u escape"));
							} else {
								char::from_u32(code)
									.ok_or_else(|| self.error("invalid \\u escape"))?
							};
							out.push(c);
						}
						_ => return Err(self.error_at(self.pos - 2, "invalid escape sequence")),
					}
				}
				0x00..=0x1F => {
					return Err(self.error("control characters must be escaped in strings"));
				}
				_ => {
					// Copy one UTF-8 character.
					let len = utf8_len(b);
					let end = self.pos + len;
					let s = std::str::from_utf8(self.bytes.get(self.pos..end).unwrap_or(&[]))
						.map_err(|_| self.error("invalid UTF-8"))?;
					out.push_str(s);
					self.pos = end;
				}
			}
		}
	}

	fn parse_hex4(&mut self) -> Result<u32, Error> {
		let digits = self
			.bytes
			.get(self.pos..self.pos + 4)
			.ok_or_else(|| self.error("expected 4 hex digits after \\u"))?;
		// `from_str_radix` alone would accept a leading `+` ("\u+041").
		if !digits.iter().all(u8::is_ascii_hexdigit) {
			return Err(self.error("expected 4 hex digits after \\u"));
		}
		let text = std::str::from_utf8(digits).expect("ascii hex digits");
		let code = u32::from_str_radix(text, 16)
			.map_err(|_| self.error("expected 4 hex digits after \\u"))?;
		self.pos += 4;
		Ok(code)
	}

	fn parse_array(&mut self) -> Result<Value, Error> {
		let start = self.pos;
		self.pos += 1;
		let mut items = Vec::new();
		loop {
			self.skip_trivia()?;
			match self.peek() {
				None => return Err(self.error_at(start, "unterminated array")),
				Some(b']') => {
					self.pos += 1;
					return Ok(Value::Array(items));
				}
				Some(b',') => return Err(self.error("unexpected ','")),
				Some(_) => {}
			}
			items.push(self.parse_value()?);
			self.skip_trivia()?;
			match self.peek() {
				Some(b',') => self.pos += 1, // a trailing comma falls through to the ']' check
				Some(b']') => {}
				None => return Err(self.error_at(start, "unterminated array")),
				Some(_) => return Err(self.error("expected ',' or ']'")),
			}
		}
	}

	fn parse_object(&mut self) -> Result<Value, Error> {
		let start = self.pos;
		self.pos += 1;
		let mut pairs: Vec<(String, Value)> = Vec::new();
		// The keys seen so far, for objects past `LINEAR_KEYS` keys (empty before that).
		let mut seen: HashSet<String> = HashSet::new();
		loop {
			self.skip_trivia()?;
			match self.peek() {
				None => return Err(self.error_at(start, "unterminated object")),
				Some(b'}') => {
					self.pos += 1;
					return Ok(Value::Object(pairs));
				}
				Some(b'"') => {}
				Some(b',') => return Err(self.error("unexpected ','")),
				Some(_) => return Err(self.error("expected a double-quoted key")),
			}
			let key_pos = self.pos;
			let key = self.parse_string()?;
			let duplicate = if pairs.len() < LINEAR_KEYS {
				pairs.iter().any(|(k, _)| *k == key)
			} else {
				// `pairs` grows by one key at a time, so this is true once: the set starts
				// with the keys of the scan, and every key after it is added below.
				if pairs.len() == LINEAR_KEYS {
					seen.extend(pairs.iter().map(|(k, _)| k.clone()));
				}
				!seen.insert(key.clone())
			};
			if duplicate {
				return Err(self.error_at(key_pos, format!("duplicate key \"{key}\"")));
			}
			self.skip_trivia()?;
			if self.peek() != Some(b':') {
				return Err(self.error("expected ':'"));
			}
			self.pos += 1;
			self.skip_trivia()?;
			let value = self.parse_value()?;
			pairs.push((key, value));
			self.skip_trivia()?;
			match self.peek() {
				Some(b',') => self.pos += 1,
				Some(b'}') => {}
				None => return Err(self.error_at(start, "unterminated object")),
				Some(_) => return Err(self.error("expected ',' or '}'")),
			}
		}
	}
}

fn utf8_len(first: u8) -> usize {
	match first {
		0x00..=0x7F => 1,
		0xC0..=0xDF => 2,
		0xE0..=0xEF => 3,
		_ => 4,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn s(v: &str) -> Value {
		Value::String(v.to_string())
	}

	#[test]
	fn numbers_that_json_cannot_hold_are_written_as_null() {
		let list = Value::Array(vec![
			Value::Number(f64::NAN),
			Value::Number(f64::INFINITY),
			Value::Number(f64::NEG_INFINITY),
			Value::Number(1.0),
		]);
		assert_eq!(list.to_json(), "[null,null,null,1]");
	}

	#[test]
	fn parses_strict_json_values() {
		assert_eq!(parse("null").unwrap(), Value::Null);
		assert_eq!(parse("true").unwrap(), Value::Bool(true));
		assert_eq!(parse("false").unwrap(), Value::Bool(false));
		assert_eq!(parse("0").unwrap(), Value::Number(0.0));
		assert_eq!(parse("-12.5e2").unwrap(), Value::Number(-1250.0));
		assert_eq!(parse(r#""a\"b""#).unwrap(), s("a\"b"));
		assert_eq!(parse("[]").unwrap(), Value::Array(vec![]));
		assert_eq!(parse("{}").unwrap(), Value::Object(vec![]));
	}

	#[test]
	fn keeps_object_key_order() {
		let v = parse(r#"{"z": 1, "a": 2, "m": 3}"#).unwrap();
		let keys: Vec<&str> = v
			.as_object()
			.unwrap()
			.iter()
			.map(|(k, _)| k.as_str())
			.collect();
		assert_eq!(keys, ["z", "a", "m"]);
	}

	#[test]
	fn allows_line_and_block_comments() {
		let v = parse(
			"// top\n{\n  \"a\": 1, // after value\n  /* block\n  spanning */ \"b\": [ /* in array */ 2 ]\n}\n// end",
		)
		.unwrap();
		assert_eq!(v.to_json(), r#"{"a":1,"b":[2]}"#);
	}

	#[test]
	fn allows_trailing_commas() {
		assert_eq!(parse("[1, 2, 3,]").unwrap().to_json(), "[1,2,3]");
		assert_eq!(parse(r#"{"a": 1,}"#).unwrap().to_json(), r#"{"a":1}"#);
		assert_eq!(parse("[1,\n// c\n]").unwrap().to_json(), "[1]");
	}

	#[test]
	fn comment_markers_inside_strings_are_text() {
		assert_eq!(
			parse(r#""http://example.com/* x */""#).unwrap(),
			s("http://example.com/* x */")
		);
	}

	#[test]
	fn accepts_a_leading_bom() {
		assert_eq!(parse("\u{FEFF}{\"a\":1}").unwrap().to_json(), r#"{"a":1}"#);
	}

	#[test]
	fn decodes_escapes_and_surrogate_pairs() {
		assert_eq!(parse(r#""é\n\t\/\\""#).unwrap(), s("é\n\t/\\"));
		assert_eq!(parse(r#""😀""#).unwrap(), s("😀"));
		assert_eq!(parse("\"日本語\"").unwrap(), s("日本語"));
	}

	#[test]
	fn roundtrips_through_to_json() {
		let src = r#"{"a":[1,2.5,-3,1e21,"x\"y\n",null,true,false],"o":{"k":"\u0001"}}"#;
		assert_eq!(parse(src).unwrap().to_json(), src);
	}

	#[test]
	fn rejects_json5_extensions() {
		assert!(parse("{a: 1}").is_err());
		assert!(parse("{'a': 1}").is_err());
		assert!(parse("[NaN]").is_err());
		assert!(parse("[0x10]").is_err());
		assert!(parse("[.5]").is_err());
		assert!(parse("[+1]").is_err());
	}

	#[test]
	fn rejects_duplicate_keys_with_position() {
		let err = parse("{\n  \"a\": 1,\n  \"a\": 2\n}").unwrap_err();
		assert_eq!((err.line, err.column), (3, 3));
		assert_eq!(err.message, "duplicate key \"a\"");
	}

	/// `{"k0": 0, "k1": 1, ..., "k{n-1}": n-1}` followed by `tail` (more members).
	fn object_of(n: usize, tail: &str) -> String {
		let members: Vec<String> = (0..n).map(|i| format!("\"k{i}\": {i}")).collect();
		format!("{{{}{tail}}}", members.join(", "))
	}

	#[test]
	fn a_duplicate_of_the_first_key_is_found_in_an_object_past_the_scan_limit() {
		// 20 keys, then `k0` again: the set is built from the 16 keys seen when the limit
		// is reached, so the first key has to be in it.
		let err = parse(&object_of(20, r#", "k0": 1"#)).unwrap_err();
		assert_eq!(err.message, "duplicate key \"k0\"");
	}

	#[test]
	fn a_duplicate_of_a_key_added_after_the_scan_limit_is_found() {
		let err = parse(&object_of(20, r#", "k19": 1"#)).unwrap_err();
		assert_eq!(err.message, "duplicate key \"k19\"");
	}

	#[test]
	fn a_duplicate_is_found_at_the_scan_limit_itself() {
		// 16 keys fill the scan; the 17th is the first one that goes through the set.
		let err = parse(&object_of(16, r#", "k15": 1"#)).unwrap_err();
		assert_eq!(err.message, "duplicate key \"k15\"");
		// 15 keys and a duplicate as the 16th: still the scan.
		let err = parse(&object_of(15, r#", "k14": 1"#)).unwrap_err();
		assert_eq!(err.message, "duplicate key \"k14\"");
	}

	#[test]
	fn an_object_of_distinct_keys_past_the_scan_limit_is_accepted() {
		let value = parse(&object_of(40, "")).unwrap();
		assert_eq!(value.get("k0"), Some(&Value::Number(0.0)));
		assert_eq!(value.get("k39"), Some(&Value::Number(39.0)));
		assert_eq!(value.as_object().map(<[_]>::len), Some(40));
	}

	#[test]
	fn the_same_key_in_two_objects_is_not_a_duplicate() {
		let value = parse(&format!("[{}, {}]", object_of(20, ""), object_of(20, ""))).unwrap();
		assert_eq!(value.as_array().map(<[_]>::len), Some(2));
	}

	#[test]
	fn an_object_of_a_hundred_thousand_keys_parses_in_linear_time() {
		let source = object_of(100_000, "");
		let started = std::time::Instant::now();
		let value = parse(&source).unwrap();
		// A scan of the keys so far takes about 40 seconds here (debug build), the set
		// about a tenth of a second: the bound is far from both.
		assert!(started.elapsed() < std::time::Duration::from_secs(10));
		assert_eq!(value.as_object().map(<[_]>::len), Some(100_000));
	}

	#[test]
	fn rejects_leading_zeros_lone_surrogates_and_control_chars() {
		assert!(parse("[01]").is_err());
		assert!(parse(r#""\ud83d""#).is_err());
		assert!(parse(r#""\ude00""#).is_err());
		assert!(parse("\"a\nb\"").is_err());
	}

	#[test]
	fn reports_positions_for_common_mistakes() {
		let err = parse("{\"a\": 1 \"b\": 2}").unwrap_err();
		assert_eq!((err.line, err.column), (1, 9));
		assert_eq!(err.message, "expected ',' or '}'");

		let err = parse("[1, 2").unwrap_err();
		assert_eq!(err.message, "unterminated array");

		let err = parse("{\"a\": 1} x").unwrap_err();
		assert_eq!(err.message, "unexpected content after the top-level value");

		let err = parse("/* never closed").unwrap_err();
		assert_eq!(err.message, "unterminated block comment");

		let err = parse("").unwrap_err();
		assert_eq!(err.message, "unexpected end of input");
	}

	#[test]
	fn column_counts_characters_not_bytes() {
		let err = parse("{\"日本\": 1 }}").unwrap_err();
		assert_eq!((err.line, err.column), (1, 11));
	}

	#[test]
	fn rejects_numbers_that_overflow_to_infinity() {
		let e = parse("[1e999]").unwrap_err();
		assert_eq!(
			(e.column, e.message.as_str()),
			(2, "number is out of range")
		);
		assert!(parse("-1e999").is_err());
		assert_eq!(parse("1e308").unwrap().to_json(), "1e308");
	}

	#[test]
	fn unicode_escapes_need_exactly_four_hex_digits() {
		assert!(parse(r#""\u+041""#).is_err());
		assert!(parse(r#""\u-041""#).is_err());
		assert!(parse(r#""\u00G1""#).is_err());
		assert!(parse(r#""\u041""#).is_err());
		assert_eq!(parse(r#""A""#).unwrap(), s("A"));
	}

	#[test]
	fn nesting_depth_is_limited_instead_of_overflowing_the_stack() {
		let ok = format!("{}1{}", "[".repeat(512), "]".repeat(512));
		assert!(parse(&ok).is_ok());
		let deep = format!("{}1{}", "[".repeat(513), "]".repeat(513));
		assert_eq!(
			parse(&deep).unwrap_err().message,
			"nesting is deeper than 512 levels"
		);
		let deep_obj = format!("{}1{}", "{\"a\":".repeat(600), "}".repeat(600));
		assert_eq!(
			parse(&deep_obj).unwrap_err().message,
			"nesting is deeper than 512 levels"
		);
		// 100k levels must be an error, not a crash.
		let huge = "[".repeat(100_000);
		assert!(parse(&huge).is_err());
	}

	#[test]
	fn accessors() {
		let v = parse(r#"{"s":"x","b":true,"n":1.5,"a":[1],"o":{},"z":null}"#).unwrap();
		assert_eq!(v.get("s").unwrap().as_str(), Some("x"));
		assert_eq!(v.get("b").unwrap().as_bool(), Some(true));
		assert_eq!(v.get("n").unwrap().as_f64(), Some(1.5));
		assert_eq!(v.get("a").unwrap().as_array().unwrap().len(), 1);
		assert_eq!(v.get("o").unwrap().as_object().unwrap().len(), 0);
		assert!(v.get("z").unwrap().is_null());
		assert!(v.get("missing").is_none());
		assert!(v.get("s").unwrap().get("x").is_none());
	}
}
