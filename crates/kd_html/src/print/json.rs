//! JSON inside `<script type="application/ld+json">` (and `importmap`,
//! `speculationrules`, anything whose type ends in `json`): prettier formats
//! it with its JavaScript printer in `json` mode, and v2 left that
//! formatting in the output (the minifier only minifies JavaScript).
//!
//! The rules are those of prettier's object and array printers: an object
//! stays on one line (`{ "a": 1 }`) unless the source had a line break
//! between `{` and its first key, an array of two or more objects (or arrays)
//! that each have two or more members always breaks, an array of numbers
//! fills, blank lines between members are kept, numbers are normalised
//! (`1.50` becomes `1.5`), strings get double quotes, unquoted keys are
//! quoted, and there is no trailing comma.
//!
//! Input that prettier cannot parse is left as it was written, which is what
//! this returns `None` for. So does input this port does not cover (comments,
//! identifiers as values, template literals): those are not formatted here,
//! and the difference to prettier is limited to them.

use super::doc::{DocId, Docs, HARDLINE, LINE, SOFTLINE};

#[derive(Debug)]
enum Node {
	Object {
		start: usize,
		/// Start of the first key, if any.
		first_key: Option<usize>,
		members: Vec<Member>,
	},
	Array {
		elements: Vec<Element>,
	},
	Str(String),
	/// The raw text of a number, sign excluded.
	Num(String),
	Signed(char, Box<Node>),
	Lit(&'static str),
}

#[derive(Debug)]
struct Member {
	key: Key,
	value: Node,
	/// Where the member ends in the source.
	end: usize,
}

#[derive(Debug)]
struct Element {
	value: Node,
	end: usize,
}

#[derive(Debug)]
enum Key {
	Str(String),
	Name(String),
	Num(String),
}

struct Parser<'a> {
	src: &'a str,
	pos: usize,
}

impl Parser<'_> {
	fn skip_ws(&mut self) {
		while self.src[self.pos..]
			.chars()
			.next()
			.is_some_and(|c| c.is_whitespace() || c == '\u{FEFF}')
		{
			self.pos += self.src[self.pos..]
				.chars()
				.next()
				.map_or(0, char::len_utf8);
		}
	}

	fn peek(&self) -> Option<char> {
		self.src[self.pos..].chars().next()
	}

	fn eat(&mut self, c: char) -> bool {
		if self.peek() == Some(c) {
			self.pos += c.len_utf8();
			true
		} else {
			false
		}
	}

	fn value(&mut self, depth: usize) -> Option<Node> {
		if depth > 200 {
			return None;
		}
		self.skip_ws();
		let c = self.peek()?;
		match c {
			'{' => self.object(depth),
			'[' => self.array(depth),
			'"' | '\'' => Some(Node::Str(self.string()?)),
			'-' | '+' => {
				self.pos += 1;
				self.skip_ws();
				let inner = self.value(depth + 1)?;
				matches!(inner, Node::Num(_)).then(|| Node::Signed(c, Box::new(inner)))
			}
			'0'..='9' | '.' => Some(Node::Num(self.number()?)),
			_ => {
				let word = self.word();
				match word.as_str() {
					"true" => Some(Node::Lit("true")),
					"false" => Some(Node::Lit("false")),
					"null" => Some(Node::Lit("null")),
					_ => None,
				}
			}
		}
	}

	fn word(&mut self) -> String {
		let start = self.pos;
		while self
			.peek()
			.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
		{
			self.pos += self.peek().map_or(0, char::len_utf8);
		}
		self.src[start..self.pos].to_owned()
	}

	fn number(&mut self) -> Option<String> {
		let start = self.pos;
		while self
			.peek()
			.is_some_and(|c| c.is_ascii_alphanumeric() || c == '.')
		{
			self.pos += 1;
			// An exponent sign belongs to the number.
			if matches!(self.src.as_bytes()[self.pos - 1], b'e' | b'E')
				&& matches!(self.peek(), Some('+' | '-'))
				&& !self.src[start..self.pos].starts_with("0x")
			{
				self.pos += 1;
			}
		}
		let raw = &self.src[start..self.pos];
		// Only decimal numbers: hex, octal, binary, separators and BigInt
		// literals are not JSON and are left to prettier's own handling.
		let ok = raw
			.bytes()
			.next()
			.is_some_and(|b| b.is_ascii_digit() || b == b'.')
			&& raw
				.bytes()
				.all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
			&& raw.parse::<f64>().is_ok();
		ok.then(|| raw.to_owned())
	}

	/// A string literal, returned as written (quotes included).
	fn string(&mut self) -> Option<String> {
		let start = self.pos;
		let quote = self.peek()?;
		self.pos += 1;
		loop {
			let c = self.peek()?;
			self.pos += c.len_utf8();
			match c {
				'\\' => {
					let next = self.peek()?;
					self.pos += next.len_utf8();
				}
				'\n' | '\r' | '\u{2028}' | '\u{2029}' => return None,
				c if c == quote => break,
				_ => {}
			}
		}
		Some(self.src[start..self.pos].to_owned())
	}

	fn key(&mut self) -> Option<Key> {
		self.skip_ws();
		match self.peek()? {
			'"' | '\'' => Some(Key::Str(self.string()?)),
			'0'..='9' | '.' => Some(Key::Num(self.number()?)),
			c if c.is_alphabetic() || c == '_' || c == '$' => Some(Key::Name(self.word())),
			_ => None,
		}
	}

	fn object(&mut self, depth: usize) -> Option<Node> {
		let start = self.pos;
		self.pos += 1;
		let mut members = Vec::new();
		let mut first_key = None;
		loop {
			self.skip_ws();
			if self.eat('}') {
				break;
			}
			if !members.is_empty() {
				// A comma separates members (a trailing one is allowed).
				if !self.eat(',') {
					return None;
				}
				self.skip_ws();
				if self.eat('}') {
					break;
				}
			}
			self.skip_ws();
			let key_start = self.pos;
			let key = self.key()?;
			first_key.get_or_insert(key_start);
			self.skip_ws();
			if !self.eat(':') {
				return None;
			}
			let value = self.value(depth + 1)?;
			members.push(Member {
				key,
				value,
				end: self.pos,
			});
		}
		Some(Node::Object {
			start,
			first_key,
			members,
		})
	}

	fn array(&mut self, depth: usize) -> Option<Node> {
		self.pos += 1;
		let mut elements = Vec::new();
		loop {
			self.skip_ws();
			if self.eat(']') {
				break;
			}
			if !elements.is_empty() {
				if !self.eat(',') {
					return None;
				}
				self.skip_ws();
				if self.eat(']') {
					break;
				}
			}
			let value = self.value(depth + 1)?;
			elements.push(Element {
				value,
				end: self.pos,
			});
		}
		Some(Node::Array { elements })
	}
}

/// prettier's `printNumber` for a raw numeric literal.
fn print_number(raw: &str) -> String {
	if raw.len() == 1 {
		return raw.to_owned();
	}
	let lower = raw.to_ascii_lowercase();
	let (mut mantissa, exponent) = match lower.find('e') {
		Some(e) => (lower[..e].to_owned(), Some(lower[e + 1..].to_owned())),
		None => (lower, None),
	};
	// The exponent: no `+`, no leading zeros, and `e0` disappears.
	let exponent = exponent.and_then(|exp| {
		let (sign, digits) = match exp.strip_prefix('-') {
			Some(d) => ("-", d),
			None => ("", exp.strip_prefix('+').unwrap_or(&exp)),
		};
		let mut digits = digits;
		while digits.len() > 1 && digits.starts_with('0') {
			digits = &digits[1..];
		}
		if digits.bytes().all(|b| b == b'0') {
			None
		} else {
			Some(format!("{sign}{digits}"))
		}
	});
	// A digit before the decimal point.
	if mantissa.starts_with('.') {
		mantissa.insert(0, '0');
	}
	// Trailing zeroes of the fraction go, but the first digit stays
	// (`1.50` -> `1.5`, `1.00` -> `1.0`, `1.0` is left alone).
	if let Some(dot) = mantissa.find('.') {
		let frac = &mantissa[dot + 1..];
		if frac.len() >= 2 && frac.ends_with('0') {
			let trimmed = frac.trim_end_matches('0');
			let kept = if trimmed.is_empty() { "0" } else { trimmed };
			mantissa = format!("{}.{kept}", &mantissa[..dot]);
		}
	}
	// A trailing dot goes.
	if mantissa.ends_with('.') {
		mantissa.pop();
	}
	match exponent {
		Some(e) => format!("{mantissa}e{e}"),
		None => mantissa,
	}
}

/// prettier's `makeString` with the enclosing quote `"`, as it runs when the
/// code is embedded in HTML: the enclosing quote gets a backslash, an escaped
/// other quote loses its backslash, and every other escape stays as written
/// (outside HTML prettier drops backslashes that escape nothing).
fn print_string(raw: &str) -> String {
	let inner = &raw[1..raw.len() - 1];
	let mut out = String::with_capacity(raw.len());
	out.push('"');
	let mut chars = inner.chars();
	while let Some(c) = chars.next() {
		match c {
			'\\' => match chars.next() {
				Some('\'') => out.push('\''),
				Some(e) => {
					out.push('\\');
					out.push(e);
				}
				None => out.push('\\'),
			},
			'"' => out.push_str("\\\""),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// Whether the line after the one `end` is on is blank (prettier's
/// `isNextLineEmpty`, without comments).
fn next_line_is_empty(src: &str, end: usize) -> bool {
	let rest = &src[end..];
	// Skip spaces and a comma on the member's own line.
	let mut i = 0;
	let bytes = rest.as_bytes();
	while i < bytes.len() && matches!(bytes[i], b' ' | b'\t' | b',') {
		i += 1;
	}
	// The line must end here.
	match bytes.get(i) {
		Some(b'\r') if bytes.get(i + 1) == Some(&b'\n') => i += 2,
		Some(b'\n' | b'\r') => i += 1,
		_ => return false,
	}
	while i < bytes.len() && matches!(bytes[i], b' ' | b'\t') {
		i += 1;
	}
	matches!(bytes.get(i), Some(b'\n' | b'\r'))
}

struct Printer<'a> {
	docs: &'a mut Docs,
	src: &'a str,
}

impl Printer<'_> {
	fn text(&mut self, s: impl Into<String>) -> DocId {
		self.docs.text(s)
	}

	fn concat(&mut self, parts: Vec<DocId>) -> DocId {
		self.docs.concat(parts)
	}

	fn node(&mut self, node: &Node) -> DocId {
		match node {
			Node::Str(raw) => {
				let printed = print_string(raw);
				self.text(printed)
			}
			Node::Num(raw) => {
				let printed = print_number(raw);
				self.text(printed)
			}
			Node::Signed(sign, inner) => {
				let prefix = if *sign == '-' { "-" } else { "" };
				let inner = self.node(inner);
				let prefix = self.text(prefix);
				self.concat(vec![prefix, inner])
			}
			Node::Lit(s) => self.text(*s),
			Node::Array { elements } => self.array(elements),
			Node::Object {
				start,
				first_key,
				members,
			} => self.object(*start, *first_key, members),
		}
	}

	fn key(&mut self, key: &Key) -> DocId {
		let printed = match key {
			Key::Str(raw) => print_string(raw),
			Key::Name(name) => format!("\"{name}\""),
			Key::Num(raw) => {
				let printed = print_number(raw);
				// A simple number key (digits, one optional fractional part) is
				// quoted when it prints as itself.
				let simple = printed
					.split('.')
					.all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
					&& printed.matches('.').count() <= 1;
				if simple && raw.parse::<f64>().is_ok_and(|n| n.to_string() == printed) {
					format!("\"{printed}\"")
				} else {
					printed
				}
			}
		};
		self.text(printed)
	}

	fn object(&mut self, start: usize, first_key: Option<usize>, members: &[Member]) -> DocId {
		if members.is_empty() {
			return self.text("{}");
		}
		let should_break = first_key.is_some_and(|k| self.src[start..k].contains('\n'));
		let mut inner = vec![LINE];
		for (i, member) in members.iter().enumerate() {
			let key = self.key(&member.key);
			let colon = self.text(": ");
			let value = self.node(&member.value);
			let prop = self.concat(vec![key, colon, value]);
			let prop = self.docs.group(prop);
			inner.push(prop);
			if i + 1 < members.len() {
				let comma = self.text(",");
				inner.push(comma);
				inner.push(LINE);
				if next_line_is_empty(self.src, member.end) {
					inner.push(HARDLINE);
				}
			}
		}
		let inner = self.concat(inner);
		let indented = self.docs.indent(inner);
		let open = self.text("{");
		let close = self.text("}");
		let all = self.concat(vec![open, indented, LINE, close]);
		self.docs.group_with(all, should_break, None)
	}

	fn array(&mut self, elements: &[Element]) -> DocId {
		if elements.is_empty() {
			return self.text("[]");
		}
		let should_break = elements.len() > 1
			&& elements.iter().enumerate().all(|(i, e)| {
				let size = match &e.value {
					Node::Object { members, .. } => Some((true, members.len())),
					Node::Array { elements } => Some((false, elements.len())),
					_ => None,
				};
				let next_kind = elements
					.get(i + 1)
					.map(|n| matches!(n.value, Node::Object { .. }));
				size.is_some_and(|(is_object, n)| {
					n > 1 && next_kind.is_none_or(|next| next == is_object)
				})
			});
		let concise = elements.len() > 1
			&& elements.iter().all(|e| match &e.value {
				Node::Num(_) => true,
				Node::Signed(_, inner) => matches!(**inner, Node::Num(_)),
				_ => false,
			});
		let body = if concise {
			// A fill: numbers are packed on lines as they fit.
			let mut parts = Vec::new();
			for (i, e) in elements.iter().enumerate() {
				let value = self.node(&e.value);
				if i + 1 < elements.len() {
					let comma = self.text(",");
					let item = self.concat(vec![value, comma]);
					parts.push(item);
					if next_line_is_empty(self.src, e.end) {
						let blank = self.concat(vec![HARDLINE, HARDLINE]);
						parts.push(blank);
					} else {
						parts.push(LINE);
					}
				} else {
					parts.push(value);
				}
			}
			self.docs.fill(parts)
		} else {
			let mut parts = Vec::new();
			for (i, e) in elements.iter().enumerate() {
				let value = self.node(&e.value);
				parts.push(value);
				if i + 1 < elements.len() {
					let comma = self.text(",");
					parts.push(comma);
					parts.push(LINE);
					if next_line_is_empty(self.src, e.end) {
						parts.push(SOFTLINE);
					}
				}
			}
			self.concat(parts)
		};
		let inner = self.concat(vec![SOFTLINE, body]);
		let indented = self.docs.indent(inner);
		let open = self.text("[");
		let close = self.text("]");
		let all = self.concat(vec![open, indented, SOFTLINE, close]);
		self.docs.group_with(all, should_break, None)
	}
}

/// The doc of the JSON document `text`, or `None` if it is not one this port
/// formats (the caller then keeps the text as written).
pub(crate) fn format(docs: &mut Docs, text: &str) -> Option<DocId> {
	let mut parser = Parser { src: text, pos: 0 };
	let node = parser.value(0)?;
	parser.skip_ws();
	if parser.pos != text.len() {
		return None;
	}
	let mut printer = Printer { docs, src: text };
	Some(printer.node(&node))
}

#[cfg(test)]
mod tests {
	use crate::print::{Options, format};

	fn script(json: &str) -> String {
		let options = Options {
			use_tabs: true,
			bracket_same_line: true,
			..Options::default()
		};
		format(
			&format!("<script type=\"application/ld+json\">{json}</script>"),
			&options,
		)
		.unwrap()
	}

	/// The expected strings are what prettier 3.9.9 printed for the same input.
	#[test]
	fn objects_and_arrays_stay_flat_unless_the_source_broke_them() {
		assert_eq!(
			script("{\"a\":1,\"b\":[1,2,{\"c\":null}],\"d\":\"x\"}"),
			"<script type=\"application/ld+json\">\n\t{ \"a\": 1, \"b\": [1, 2, { \"c\": null }], \"d\": \"x\" }\n</script>\n"
		);
		assert_eq!(
			script("{\n\"a\":1,\n\"b\":2}"),
			"<script type=\"application/ld+json\">\n\t{\n\t\t\"a\": 1,\n\t\t\"b\": 2\n\t}\n</script>\n"
		);
		// Only a break before the first key counts.
		assert_eq!(
			script("{\"a\":{\n\"b\":1}}"),
			"<script type=\"application/ld+json\">\n\t{\n\t\t\"a\": {\n\t\t\t\"b\": 1\n\t\t}\n\t}\n</script>\n"
		);
	}

	#[test]
	fn arrays_of_several_objects_break_and_blank_lines_between_members_stay() {
		assert_eq!(
			script("[{\"a\":1,\"b\":2},{\"c\":3,\"d\":4}]"),
			"<script type=\"application/ld+json\">\n\t[\n\t\t{ \"a\": 1, \"b\": 2 },\n\t\t{ \"c\": 3, \"d\": 4 }\n\t]\n</script>\n"
		);
		assert_eq!(
			script("{\n\t\"a\": 1,\n\n\t\"b\": 2\n}"),
			"<script type=\"application/ld+json\">\n\t{\n\t\t\"a\": 1,\n\n\t\t\"b\": 2\n\t}\n</script>\n"
		);
	}

	#[test]
	fn numbers_strings_and_keys_are_normalised() {
		assert_eq!(
			script("{'a':-1.50,b:1e3,\"c\":\"\\/\\u00e9\",1:'it\\'s',}"),
			"<script type=\"application/ld+json\">\n\t{ \"a\": -1.5, \"b\": 1e3, \"c\": \"\\/\\u00e9\", \"1\": \"it's\" }\n</script>\n"
		);
		assert_eq!(
			script("[1.0,1.00,10.010,.5,1E+3,1e0]"),
			"<script type=\"application/ld+json\">\n\t[1.0, 1.0, 10.01, 0.5, 1e3, 1]\n</script>\n"
		);
	}

	#[test]
	fn json_that_cannot_be_parsed_stays_as_written() {
		assert_eq!(
			script("{\"a\":\"b\"},"),
			"<script type=\"application/ld+json\">\n\t{\"a\":\"b\"},\n</script>\n"
		);
		assert_eq!(
			script("{\"a\":1}{\"b\":2}"),
			"<script type=\"application/ld+json\">\n\t{\"a\":1}{\"b\":2}\n</script>\n"
		);
	}
}
