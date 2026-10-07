//! YAML subset parser for front matter and `data/*.yml`.
//!
//! Supported: block and flow mappings and sequences (including compact
//! `- key: value` entries), plain / single-quoted / double-quoted scalars
//! (with folding across lines), block scalars `|` and `>` with chomping
//! (`-`, `+`) and an explicit indentation indicator, comments, anchors and
//! aliases, the `<<` merge key, and one document with optional `---` / `...`
//! markers. Plain scalars resolve with the YAML 1.2 core schema (null,
//! booleans, integers, floats). **Timestamps stay strings**: values cross into
//! JavaScript as JSON, where a `Date` cannot travel anyway, and the two YAML
//! libraries v2 used disagreed on this.
//!
//! Rejected with an error: tags (`!foo`, `!!str`), complex keys (`?`),
//! directives (`%YAML`), multiple documents, tabs in indentation and
//! duplicate keys. Why: none appear in site data, and silently accepting a
//! construct the parser does not implement would produce wrong data instead
//! of a message.
//!
//! The output is `kd_jsonc::Value` so that JSON and YAML data share one type
//! and one deterministic serialization.

use std::collections::HashMap;
use std::fmt;

pub use kd_jsonc::Value;

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

/// Parses one YAML document. An empty document is `Null`.
///
/// # Example
///
/// ```
/// let v = kd_yaml::parse("title: Hello\ntags: [a, b]\ndate: 2026-01-02\n").unwrap();
/// assert_eq!(v.to_json(), r#"{"title":"Hello","tags":["a","b"],"date":"2026-01-02"}"#);
/// ```
pub fn parse(input: &str) -> Result<Value, Error> {
	let input = input.strip_prefix('\u{FEFF}').unwrap_or(input);
	let mut p = Parser {
		chars: input.chars().collect(),
		pos: 0,
		anchors: HashMap::new(),
		depth: 0,
	};
	p.parse_document()
}

/// Splits gray-matter style front matter from a document.
///
/// The opening `---` must be the very first line (a UTF-8 BOM is allowed
/// before it); the closing line is `---`. One line break after the closing
/// fence is removed from the body. Empty front matter yields `{}`. A document
/// that does not start with `---` has no front matter and is returned as the
/// body unchanged.
///
/// # Example
///
/// ```
/// let (meta, body) = kd_yaml::split_front_matter("---\ntitle: T\n---\n<p>x</p>\n").unwrap();
/// assert_eq!(meta.unwrap().to_json(), r#"{"title":"T"}"#);
/// assert_eq!(body, "<p>x</p>\n");
/// ```
pub fn split_front_matter(input: &str) -> Result<(Option<Value>, &str), Error> {
	let content = input.strip_prefix('\u{FEFF}').unwrap_or(input);
	let Some(after_open) = content.strip_prefix("---") else {
		return Ok((None, input));
	};
	let after_open = match after_open
		.strip_prefix("\r\n")
		.or_else(|| after_open.strip_prefix('\n'))
	{
		Some(rest) => rest,
		None if after_open.is_empty() => after_open,
		// `---x` is not a fence.
		None => return Ok((None, input)),
	};
	// Find the closing fence: a line that is exactly `---`.
	let mut offset = 0;
	let mut yaml_end: Option<(usize, usize)> = None;
	for line in after_open.split_inclusive('\n') {
		let trimmed = line.strip_suffix('\n').unwrap_or(line);
		let trimmed = trimmed.strip_suffix('\r').unwrap_or(trimmed);
		if trimmed == "---" {
			yaml_end = Some((offset, offset + line.len()));
			break;
		}
		offset += line.len();
	}
	let Some((yaml_end, body_start)) = yaml_end else {
		return Err(Error {
			line: 1,
			column: 1,
			message: "front matter is not closed with a '---' line".to_string(),
		});
	};
	let yaml = &after_open[..yaml_end];
	let value = if yaml.trim().is_empty() {
		Value::Object(vec![])
	} else {
		parse(yaml).map_err(|e| Error {
			// Line 1 of the YAML is line 2 of the file.
			line: e.line + 1,
			..e
		})?
	};
	Ok((Some(value), &after_open[body_start..]))
}

/// Maximum nesting of collections. Why: parsing recurses, front matter and
/// data files are user-authored, and the build runs inside Node with
/// `panic = "abort"`, so a stack overflow would kill the whole process.
const MAX_DEPTH: usize = 256;

struct Parser {
	chars: Vec<char>,
	pos: usize,
	anchors: HashMap<String, Value>,
	depth: usize,
}

type PResult<T> = Result<T, Error>;

impl Parser {
	// ----- errors and positions -------------------------------------------------

	fn error_at(&self, at: usize, message: impl Into<String>) -> Error {
		let at = at.min(self.chars.len());
		let mut line = 1;
		let mut column = 1;
		for &c in &self.chars[..at] {
			if c == '\n' {
				line += 1;
				column = 1;
			} else {
				column += 1;
			}
		}
		Error {
			line,
			column,
			message: message.into(),
		}
	}

	fn error(&self, message: impl Into<String>) -> Error {
		self.error_at(self.pos, message)
	}

	// ----- low-level cursor -----------------------------------------------------

	fn peek(&self) -> Option<char> {
		self.chars.get(self.pos).copied()
	}

	fn peek_at(&self, offset: usize) -> Option<char> {
		self.chars.get(self.pos + offset).copied()
	}

	fn at_eof(&self) -> bool {
		self.pos >= self.chars.len()
	}

	fn at_eol(&self) -> bool {
		matches!(self.peek(), None | Some('\n' | '\r'))
	}

	fn is_space(c: Option<char>) -> bool {
		matches!(c, Some(' ' | '\t'))
	}

	fn skip_inline_space(&mut self) {
		while Self::is_space(self.peek()) {
			self.pos += 1;
		}
	}

	/// Skips spaces and an optional `# comment` up to (not including) the line break.
	fn skip_inline_trivia(&mut self) -> PResult<()> {
		self.skip_inline_space();
		if self.peek() == Some('#') {
			while !self.at_eol() {
				self.pos += 1;
			}
		}
		Ok(())
	}

	fn consume_eol(&mut self) {
		if self.peek() == Some('\r') {
			self.pos += 1;
		}
		if self.peek() == Some('\n') {
			self.pos += 1;
		}
	}

	/// After an inline node: only trivia may remain on the line.
	fn expect_end_of_line(&mut self) -> PResult<()> {
		self.skip_inline_trivia()?;
		if !self.at_eol() {
			return Err(self.error("unexpected content after value"));
		}
		Ok(())
	}

	fn column(&self) -> usize {
		let mut i = self.pos;
		while i > 0 && self.chars[i - 1] != '\n' {
			i -= 1;
		}
		self.pos - i
	}

	/// Moves to the first content character of the next line that has
	/// content (skipping blank and comment-only lines). Returns that line's
	/// indentation, or `None` at EOF. Tabs in indentation are an error.
	fn skip_to_content(&mut self) -> PResult<Option<usize>> {
		loop {
			// Start of the current line position may be mid-line; move to line start.
			let mut i = self.pos;
			while i > 0 && self.chars[i - 1] != '\n' {
				i -= 1;
			}
			let line_start = i;
			let mut j = line_start;
			while matches!(self.chars.get(j), Some(' ')) {
				j += 1;
			}
			if matches!(self.chars.get(j), Some('\t')) {
				return Err(self.error_at(j, "tabs are not allowed in indentation"));
			}
			match self.chars.get(j) {
				None => {
					self.pos = j;
					return Ok(None);
				}
				Some('\n' | '\r') | Some('#') => {
					// Blank or comment line: advance past it.
					let mut k = j;
					while !matches!(self.chars.get(k), None | Some('\n')) {
						k += 1;
					}
					if self.chars.get(k).is_none() {
						self.pos = k;
						return Ok(None);
					}
					self.pos = k + 1;
				}
				Some(_) => {
					if j < self.pos {
						// We are already past this line's content start (mid-line);
						// the caller wants the *next* content line.
						let mut k = self.pos;
						while !matches!(self.chars.get(k), None | Some('\n')) {
							k += 1;
						}
						if self.chars.get(k).is_none() {
							self.pos = k;
							return Ok(None);
						}
						self.pos = k + 1;
						continue;
					}
					self.pos = j;
					return Ok(Some(j - line_start));
				}
			}
		}
	}

	// ----- document ---------------------------------------------------------------

	fn parse_document(&mut self) -> PResult<Value> {
		// Directives.
		if self.starts_with_at_line_start("%") {
			return Err(self.error("YAML directives (%...) are not supported"));
		}
		let mut indent = self.skip_to_content()?;
		let mut inline_after_marker = false;
		if indent == Some(0) && self.starts_with("---") && self.marker_terminated(3) {
			self.pos += 3;
			self.skip_inline_trivia()?;
			if self.at_eol() {
				indent = self.skip_to_content()?;
			} else {
				// `--- value` on the marker line.
				indent = Some(self.column());
				inline_after_marker = true;
			}
		}
		let value = match indent {
			None => Value::Null,
			Some(col) if inline_after_marker => self.parse_node_at(col, None)?,
			Some(_) => {
				if self.at_document_end_marker() {
					Value::Null
				} else {
					self.parse_block_node(None)?
				}
			}
		};
		// Only trivia, an optional `...`, may follow.
		if let Some(0) = self.skip_to_content()? {
			if self.starts_with("...") && self.marker_terminated(3) {
				self.pos += 3;
				self.skip_inline_trivia()?;
				if self.skip_to_content()?.is_some() {
					return Err(self.error("multiple YAML documents are not supported"));
				}
			} else if self.starts_with("---") && self.marker_terminated(3) {
				return Err(self.error("multiple YAML documents are not supported"));
			} else {
				return Err(self.error("unexpected content after the document"));
			}
		} else if !self.at_eof() {
			return Err(self.error("unexpected content after the document"));
		}
		Ok(value)
	}

	fn starts_with(&self, s: &str) -> bool {
		s.chars()
			.enumerate()
			.all(|(i, c)| self.peek_at(i) == Some(c))
	}

	fn starts_with_at_line_start(&self, s: &str) -> bool {
		self.column() == 0 && self.starts_with(s)
	}

	fn marker_terminated(&self, len: usize) -> bool {
		matches!(self.peek_at(len), None | Some(' ' | '\t' | '\n' | '\r'))
	}

	fn at_document_end_marker(&self) -> bool {
		self.column() == 0 && self.starts_with("...") && self.marker_terminated(3)
	}

	// ----- block nodes --------------------------------------------------------------

	/// Parses the block node that starts at the current content position.
	/// `parent_indent` is the indentation of the enclosing collection; a node
	/// must be indented more than it (a less or equally indented line means
	/// the value is empty).
	fn parse_block_node(&mut self, parent_indent: Option<isize>) -> PResult<Value> {
		let Some(indent) = self.skip_to_content()? else {
			return Ok(Value::Null);
		};
		if let Some(p) = parent_indent
			&& (indent as isize) <= p
		{
			return Ok(Value::Null);
		}
		if self.at_document_end_marker()
			|| (self.column() == 0 && self.starts_with("---") && self.marker_terminated(3))
		{
			return Ok(Value::Null);
		}
		self.parse_node_at(indent, parent_indent)
	}

	/// Parses a node whose first character is at the cursor, where `indent`
	/// is the column of that character.
	fn parse_node_at(&mut self, indent: usize, parent_indent: Option<isize>) -> PResult<Value> {
		self.enter()?;
		let result = self.parse_node_at_inner(indent, parent_indent);
		self.depth -= 1;
		result
	}

	/// Counts one level of nesting; errors past [`MAX_DEPTH`].
	fn enter(&mut self) -> PResult<()> {
		if self.depth >= MAX_DEPTH {
			return Err(self.error(format!("nesting is deeper than {MAX_DEPTH} levels")));
		}
		self.depth += 1;
		Ok(())
	}

	fn parse_node_at_inner(
		&mut self,
		indent: usize,
		parent_indent: Option<isize>,
	) -> PResult<Value> {
		match self.peek() {
			Some('-') if matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r')) => {
				self.parse_block_sequence(indent)
			}
			Some('?') if matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r')) => {
				Err(self.error("complex mapping keys ('? key') are not supported"))
			}
			Some('!') => Err(self.error("tags ('!tag') are not supported")),
			Some('&') => {
				let name = self.parse_anchor_name()?;
				self.skip_inline_space();
				let value = if self.at_eol() || self.peek() == Some('#') {
					self.parse_block_node(Some(indent as isize - 1))?
				} else {
					let col = self.column();
					self.parse_node_at(col, parent_indent)?
				};
				self.anchors.insert(name, value.clone());
				Ok(value)
			}
			_ => {
				if self.is_mapping_key_here() {
					self.parse_block_mapping(indent)
				} else {
					let value = self.parse_inline_scalar_node(parent_indent, indent)?;
					self.expect_end_of_line()?;
					Ok(value)
				}
			}
		}
	}

	fn parse_anchor_name(&mut self) -> PResult<String> {
		debug_assert_eq!(self.peek(), Some('&'));
		self.pos += 1;
		let start = self.pos;
		while let Some(c) = self.peek() {
			if c.is_whitespace() || matches!(c, ',' | '[' | ']' | '{' | '}') {
				break;
			}
			self.pos += 1;
		}
		if self.pos == start {
			return Err(self.error("anchor name expected after '&'"));
		}
		Ok(self.chars[start..self.pos].iter().collect())
	}

	/// Looks ahead on the current line for `key:` (plain or quoted key).
	fn is_mapping_key_here(&self) -> bool {
		let mut i = self.pos;
		match self.chars.get(i) {
			Some('"') | Some('\'') => {
				let quote = self.chars[i];
				i += 1;
				loop {
					match self.chars.get(i) {
						None | Some('\n') => return false,
						Some(c) if *c == quote => {
							if quote == '\'' && self.chars.get(i + 1) == Some(&'\'') {
								i += 2;
								continue;
							}
							i += 1;
							break;
						}
						Some('\\') if quote == '"' => i += 2,
						Some(_) => i += 1,
					}
				}
				while matches!(self.chars.get(i), Some(' ' | '\t')) {
					i += 1;
				}
				self.chars.get(i) == Some(&':')
					&& matches!(self.chars.get(i + 1), None | Some(' ' | '\t' | '\n' | '\r'))
			}
			Some('[') | Some('{') | Some('*') | Some('|') | Some('>') => false,
			Some(_) => {
				// Plain key: scan to `: ` / `:`EOL before EOL or ` #`.
				while let Some(&c) = self.chars.get(i) {
					match c {
						'\n' | '\r' => return false,
						'#' if i > self.pos
							&& matches!(self.chars.get(i - 1), Some(' ' | '\t')) =>
						{
							return false;
						}
						':' if matches!(
							self.chars.get(i + 1),
							None | Some(' ' | '\t' | '\n' | '\r')
						) =>
						{
							return true;
						}
						_ => i += 1,
					}
				}
				false
			}
			None => false,
		}
	}

	fn parse_block_mapping(&mut self, indent: usize) -> PResult<Value> {
		let mut pairs: Vec<(String, Value)> = Vec::new();
		let mut merges: Vec<Value> = Vec::new();
		loop {
			let key_pos = self.pos;
			let key = self.parse_mapping_key()?;
			self.skip_inline_space();
			if self.peek() != Some(':') {
				return Err(self.error("expected ':' after mapping key"));
			}
			self.pos += 1;
			self.skip_inline_space();

			let value = if self.at_eol() || self.peek() == Some('#') {
				self.skip_inline_trivia()?;
				// Value on following lines. A sequence may sit at the same indent.
				let save = self.pos;
				match self.skip_to_content()? {
					Some(next)
						if next == indent
							&& self.peek() == Some('-')
							&& matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r')) =>
					{
						self.parse_block_sequence(indent)?
					}
					Some(next) if next > indent => {
						self.parse_node_at(next, Some(indent as isize))?
					}
					_ => {
						self.pos = save;
						Value::Null
					}
				}
			} else {
				self.parse_inline_value_after_key(indent)?
			};

			if key == "<<" {
				merges.push(value);
			} else {
				if pairs.iter().any(|(k, _)| *k == key) {
					return Err(self.error_at(key_pos, format!("duplicate key \"{key}\"")));
				}
				pairs.push((key, value));
			}

			// Next entry?
			let save = self.pos;
			match self.skip_to_content()? {
				None => break,
				Some(next) if next < indent => {
					self.pos = save;
					self.rewind_to_line_start_of_content();
					break;
				}
				Some(next) if next == indent => {
					if self.at_document_end_marker()
						|| (self.starts_with("---") && self.marker_terminated(3) && indent == 0)
					{
						break;
					}
					if self.peek() == Some('-')
						&& matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r'))
					{
						return Err(self.error("unexpected sequence entry inside a mapping"));
					}
					continue;
				}
				Some(_) => return Err(self.error("unexpected indentation")),
			}
		}
		apply_merges(&mut pairs, merges)?;
		Ok(Value::Object(pairs))
	}

	/// After `skip_to_content` moved onto a less-indented line that belongs
	/// to an enclosing collection, leave the cursor at the start of that line
	/// so the enclosing parser sees it again.
	fn rewind_to_line_start_of_content(&mut self) {
		// `self.pos` was restored to the end of the previous value by the
		// caller; `skip_to_content` from there will land on the same line.
	}

	fn parse_mapping_key(&mut self) -> PResult<String> {
		match self.peek() {
			Some('"') => self.parse_double_quoted(),
			Some('\'') => self.parse_single_quoted(),
			Some('?') => Err(self.error("complex mapping keys ('? key') are not supported")),
			Some('!') => Err(self.error("tags ('!tag') are not supported")),
			_ => {
				let start = self.pos;
				while let Some(c) = self.peek() {
					if c == ':' && matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r'))
					{
						break;
					}
					if matches!(c, '\n' | '\r') {
						break;
					}
					self.pos += 1;
				}
				let raw: String = self.chars[start..self.pos].iter().collect();
				let key = raw.trim_end().to_string();
				if key.is_empty() {
					return Err(self.error_at(start, "empty mapping key"));
				}
				Ok(key)
			}
		}
	}

	/// Parses an inline value that follows `key: ` on the same line.
	fn parse_inline_value_after_key(&mut self, indent: usize) -> PResult<Value> {
		match self.peek() {
			Some('&') => {
				let name = self.parse_anchor_name()?;
				self.skip_inline_space();
				let value = if self.at_eol() || self.peek() == Some('#') {
					self.skip_inline_trivia()?;
					let save = self.pos;
					match self.skip_to_content()? {
						Some(next) if next == indent && self.peek() == Some('-') => {
							self.parse_block_sequence(indent)?
						}
						Some(next) if next > indent => {
							self.parse_node_at(next, Some(indent as isize))?
						}
						_ => {
							self.pos = save;
							Value::Null
						}
					}
				} else {
					self.parse_inline_value_after_key(indent)?
				};
				self.anchors.insert(name, value.clone());
				Ok(value)
			}
			Some('|') | Some('>') => self.parse_block_scalar(indent as isize),
			_ => {
				let v = self.parse_inline_scalar_node(Some(indent as isize), indent)?;
				self.expect_end_of_line()?;
				Ok(v)
			}
		}
	}

	fn parse_block_sequence(&mut self, indent: usize) -> PResult<Value> {
		let mut items = Vec::new();
		loop {
			debug_assert_eq!(self.peek(), Some('-'));
			self.pos += 1;
			self.skip_inline_space();
			let item = if self.at_eol() || self.peek() == Some('#') {
				self.skip_inline_trivia()?;
				self.parse_block_node(Some(indent as isize))?
			} else {
				let col = self.column();
				match self.peek() {
					Some('|') | Some('>') => self.parse_block_scalar(indent as isize)?,
					Some('&') => {
						let name = self.parse_anchor_name()?;
						self.skip_inline_space();
						let value = if self.at_eol() || self.peek() == Some('#') {
							self.skip_inline_trivia()?;
							self.parse_block_node(Some(indent as isize))?
						} else {
							let c = self.column();
							self.parse_node_at(c, Some(indent as isize))?
						};
						self.anchors.insert(name, value.clone());
						value
					}
					_ => self.parse_node_at(col, Some(indent as isize))?,
				}
			};
			items.push(item);

			let save = self.pos;
			match self.skip_to_content()? {
				None => break,
				Some(next) if next < indent => {
					self.pos = save;
					break;
				}
				Some(next) if next == indent => {
					if self.peek() == Some('-')
						&& matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r'))
					{
						continue;
					}
					if indent == 0
						&& (self.at_document_end_marker()
							|| (self.starts_with("---") && self.marker_terminated(3)))
					{
						break;
					}
					// A mapping key at the same indent as the sequence that was
					// the value of a previous key: hand back to the mapping.
					self.pos = save;
					break;
				}
				Some(_) => return Err(self.error("unexpected indentation")),
			}
		}
		Ok(Value::Array(items))
	}

	// ----- scalars and flow ----------------------------------------------------------

	/// Parses a scalar, alias or flow collection starting at the cursor.
	/// Plain scalars may continue on following lines indented more than
	/// `parent_indent`.
	fn parse_inline_scalar_node(
		&mut self,
		parent_indent: Option<isize>,
		_indent: usize,
	) -> PResult<Value> {
		match self.peek() {
			Some('"') => Ok(Value::String(self.parse_double_quoted()?)),
			Some('\'') => Ok(Value::String(self.parse_single_quoted()?)),
			Some('[') => self.parse_flow_sequence(),
			Some('{') => self.parse_flow_mapping(),
			Some('*') => self.parse_alias(),
			Some('!') => Err(self.error("tags ('!tag') are not supported")),
			Some('@') | Some('`') => {
				Err(self.error("reserved indicator at the start of a plain scalar"))
			}
			_ => {
				let text = self.parse_plain_scalar(parent_indent, false)?;
				Ok(resolve_plain(&text))
			}
		}
	}

	fn parse_alias(&mut self) -> PResult<Value> {
		debug_assert_eq!(self.peek(), Some('*'));
		let start = self.pos;
		self.pos += 1;
		let name_start = self.pos;
		while let Some(c) = self.peek() {
			if c.is_whitespace() || matches!(c, ',' | '[' | ']' | '{' | '}') {
				break;
			}
			self.pos += 1;
		}
		let name: String = self.chars[name_start..self.pos].iter().collect();
		self.anchors
			.get(&name)
			.cloned()
			.ok_or_else(|| self.error_at(start, format!("unknown anchor \"{name}\"")))
	}

	/// Plain scalar. In flow context it also stops at `,` `]` `}`.
	fn parse_plain_scalar(&mut self, parent_indent: Option<isize>, flow: bool) -> PResult<String> {
		let mut lines: Vec<String> = Vec::new();
		let mut current = String::new();
		loop {
			// Read to the end of this line's scalar content.
			while let Some(c) = self.peek() {
				if matches!(c, '\n' | '\r') {
					break;
				}
				if c == ':' && matches!(self.peek_at(1), None | Some(' ' | '\t' | '\n' | '\r')) {
					break;
				}
				if flow
					&& (matches!(c, ',' | ']' | '}')
						|| (c == ':' && matches!(self.peek_at(1), Some(',' | ']' | '}'))))
				{
					break;
				}
				if c == '#'
					&& (current.is_empty() || current.ends_with(' ') || current.ends_with('\t'))
				{
					break;
				}
				current.push(c);
				self.pos += 1;
			}
			let trimmed = current.trim_end().to_string();
			if !trimmed.is_empty() || lines.is_empty() {
				lines.push(trimmed);
			}
			current.clear();

			// Stopped at ':' , flow char or comment: done.
			if !self.at_eol() {
				break;
			}
			// Possible continuation on the next line.
			let save = self.pos;
			let mut blank_lines = 0usize;
			let mut i = self.pos;
			let continuation;
			loop {
				// move past EOL
				if self.chars.get(i) == Some(&'\r') {
					i += 1;
				}
				if self.chars.get(i) == Some(&'\n') {
					i += 1;
				} else {
					continuation = None;
					break;
				}
				let line_start = i;
				while matches!(self.chars.get(i), Some(' ')) {
					i += 1;
				}
				match self.chars.get(i) {
					None => {
						continuation = None;
						break;
					}
					Some('\n' | '\r') => {
						blank_lines += 1;
						continue;
					}
					Some('#') => {
						continuation = None;
						break;
					}
					Some(c) => {
						let ind = i - line_start;
						let min = parent_indent.map(|p| p + 1).unwrap_or(0);
						let is_structural = (*c == '-'
							&& matches!(
								self.chars.get(i + 1),
								None | Some(' ' | '\t' | '\n' | '\r')
							)) || (ind == 0
							&& (self.slice_starts_with(i, "---")
								|| self.slice_starts_with(i, "...")));
						if (ind as isize) >= min
							&& !is_structural && !(flow && matches!(c, ']' | '}' | ','))
						{
							// Make sure the continuation line is not itself a mapping key.
							if !flow && self.line_is_mapping_key(i) {
								continuation = None;
							} else {
								continuation = Some(i);
							}
						} else {
							continuation = None;
						}
						break;
					}
				}
			}
			match continuation {
				Some(i) => {
					for _ in 0..blank_lines {
						lines.push(String::new());
					}
					self.pos = i;
				}
				None => {
					self.pos = save;
					break;
				}
			}
		}
		Ok(fold_lines(&lines))
	}

	fn slice_starts_with(&self, at: usize, s: &str) -> bool {
		s.chars()
			.enumerate()
			.all(|(k, c)| self.chars.get(at + k) == Some(&c))
			&& matches!(
				self.chars.get(at + s.chars().count()),
				None | Some(' ' | '\t' | '\n' | '\r')
			)
	}

	fn line_is_mapping_key(&self, at: usize) -> bool {
		let mut i = at;
		while let Some(&c) = self.chars.get(i) {
			match c {
				'\n' | '\r' => return false,
				'#' if i > at && matches!(self.chars.get(i - 1), Some(' ' | '\t')) => return false,
				':' if matches!(self.chars.get(i + 1), None | Some(' ' | '\t' | '\n' | '\r')) => {
					return true;
				}
				_ => i += 1,
			}
		}
		false
	}

	fn parse_single_quoted(&mut self) -> PResult<String> {
		let start = self.pos;
		self.pos += 1;
		let mut lines: Vec<String> = Vec::new();
		let mut current = String::new();
		loop {
			match self.peek() {
				None => return Err(self.error_at(start, "unterminated single-quoted string")),
				Some('\'') => {
					if self.peek_at(1) == Some('\'') {
						current.push('\'');
						self.pos += 2;
					} else {
						self.pos += 1;
						lines.push(current);
						return Ok(fold_quoted_lines(&lines));
					}
				}
				Some('\n' | '\r') => {
					lines.push(std::mem::take(&mut current));
					self.consume_eol();
					self.skip_inline_space();
				}
				Some(c) => {
					current.push(c);
					self.pos += 1;
				}
			}
		}
	}

	fn parse_double_quoted(&mut self) -> PResult<String> {
		let start = self.pos;
		self.pos += 1;
		let mut lines: Vec<String> = Vec::new();
		let mut current = String::new();
		loop {
			match self.peek() {
				None => return Err(self.error_at(start, "unterminated double-quoted string")),
				Some('"') => {
					self.pos += 1;
					lines.push(current);
					return Ok(fold_quoted_lines(&lines));
				}
				Some('\\') => {
					self.pos += 1;
					let esc = self
						.peek()
						.ok_or_else(|| self.error_at(start, "unterminated double-quoted string"))?;
					self.pos += 1;
					match esc {
						'0' => current.push('\0'),
						'a' => current.push('\u{07}'),
						'b' => current.push('\u{08}'),
						't' | '\t' => current.push('\t'),
						'n' => current.push('\n'),
						'v' => current.push('\u{0B}'),
						'f' => current.push('\u{0C}'),
						'r' => current.push('\r'),
						'e' => current.push('\u{1B}'),
						' ' => current.push(' '),
						'"' => current.push('"'),
						'/' => current.push('/'),
						'\\' => current.push('\\'),
						'N' => current.push('\u{85}'),
						'_' => current.push('\u{A0}'),
						'L' => current.push('\u{2028}'),
						'P' => current.push('\u{2029}'),
						'x' => current.push(self.parse_hex_escape(2)?),
						'u' => current.push(self.parse_hex_escape(4)?),
						'U' => current.push(self.parse_hex_escape(8)?),
						'\n' | '\r' => {
							// Escaped line break: join without a space.
							if esc == '\r' && self.peek() == Some('\n') {
								self.pos += 1;
							}
							self.skip_inline_space();
							lines.push(std::mem::take(&mut current));
							lines.push(JOIN_MARKER.to_string());
						}
						other => {
							return Err(
								self.error_at(self.pos - 2, format!("unknown escape '\\{other}'"))
							);
						}
					}
				}
				Some('\n' | '\r') => {
					lines.push(std::mem::take(&mut current));
					self.consume_eol();
					self.skip_inline_space();
				}
				Some(c) => {
					current.push(c);
					self.pos += 1;
				}
			}
		}
	}

	fn parse_hex_escape(&mut self, len: usize) -> PResult<char> {
		let digits: String = (0..len)
			.map(|k| self.peek_at(k))
			.collect::<Option<String>>()
			.ok_or_else(|| self.error(format!("expected {len} hex digits")))?;
		let code = u32::from_str_radix(&digits, 16)
			.map_err(|_| self.error(format!("expected {len} hex digits")))?;
		self.pos += len;
		char::from_u32(code).ok_or_else(|| self.error("invalid unicode escape"))
	}

	fn parse_block_scalar(&mut self, parent_indent: isize) -> PResult<Value> {
		let header_pos = self.pos;
		let literal = self.peek() == Some('|');
		self.pos += 1;
		let mut chomp = Chomp::Clip;
		let mut explicit_indent: Option<usize> = None;
		for _ in 0..2 {
			match self.peek() {
				Some('-') => {
					chomp = Chomp::Strip;
					self.pos += 1;
				}
				Some('+') => {
					chomp = Chomp::Keep;
					self.pos += 1;
				}
				Some(d @ '1'..='9') => {
					explicit_indent = Some(d as usize - '0' as usize);
					self.pos += 1;
				}
				_ => {}
			}
		}
		self.skip_inline_trivia()?;
		if !self.at_eol() {
			return Err(self.error("unexpected content after block scalar header"));
		}
		self.consume_eol();

		// Collect lines.
		let mut raw_lines: Vec<(usize, String)> = Vec::new(); // (indent, text without indent)
		let mut content_indent: Option<usize> =
			explicit_indent.map(|n| (parent_indent + n as isize).max(0) as usize);
		let mut end_pos = self.pos;
		loop {
			if self.at_eof() {
				end_pos = self.pos;
				break;
			}
			let line_start = self.pos;
			let mut i = self.pos;
			while matches!(self.chars.get(i), Some(' ')) {
				i += 1;
			}
			let ind = i - line_start;
			let mut j = i;
			while !matches!(self.chars.get(j), None | Some('\n' | '\r')) {
				j += 1;
			}
			let text: String = self.chars[i..j].iter().collect();
			let is_blank = text.is_empty();
			if !is_blank {
				match content_indent {
					None => {
						if (ind as isize) <= parent_indent {
							break;
						}
						content_indent = Some(ind);
					}
					Some(ci) => {
						if ind < ci {
							break;
						}
					}
				}
			} else if let Some(ci) = content_indent {
				// Blank lines may be shorter than the content indent.
				let _ = ci;
			}
			raw_lines.push((ind, text));
			// Advance past EOL.
			self.pos = j;
			self.consume_eol();
			end_pos = self.pos;
			if is_blank && content_indent.is_none() {
				// Leading blank lines before content: keep counting.
			}
		}
		// Leave the cursor at the start of the first line that is not part of
		// the scalar, so the enclosing parser continues there.
		self.pos = end_pos;
		// Rewind to the beginning of that line (we consumed the EOL of the last scalar line).
		let content_indent = content_indent.unwrap_or(((parent_indent + 1).max(0)) as usize);
		for (ind, text) in &raw_lines {
			if !text.is_empty() && *ind < content_indent {
				return Err(self.error_at(
					header_pos,
					"block scalar line is less indented than the content",
				));
			}
		}
		let lines: Vec<String> = raw_lines
			.into_iter()
			.map(|(ind, text)| {
				if text.is_empty() {
					String::new()
				} else {
					let extra = " ".repeat(ind - content_indent);
					format!("{extra}{text}")
				}
			})
			.collect();
		let blank_lines = lines.len();
		let body = if literal {
			lines.join("\n")
		} else {
			fold_block(&lines)
		};
		// Chomping: split trailing newlines.
		let trimmed = body.trim_end_matches('\n');
		let trailing = body.len() - trimmed.len();
		let result = match chomp {
			Chomp::Strip => trimmed.to_string(),
			Chomp::Clip => {
				if trimmed.is_empty() {
					String::new()
				} else {
					format!("{trimmed}\n")
				}
			}
			Chomp::Keep => {
				if trimmed.is_empty() {
					// Nothing but blank lines: each of them is a newline.
					"\n".repeat(blank_lines)
				} else {
					// Every content line ends with a newline, plus the kept blanks.
					format!("{trimmed}\n{}", "\n".repeat(trailing))
				}
			}
		};
		Ok(Value::String(result))
	}

	fn parse_flow_sequence(&mut self) -> PResult<Value> {
		let start = self.pos;
		self.pos += 1;
		let mut items = Vec::new();
		loop {
			self.skip_flow_trivia();
			match self.peek() {
				Some(']') => {
					self.pos += 1;
					return Ok(Value::Array(items));
				}
				Some(',') => return Err(self.error("unexpected ','")),
				None => return Err(self.error_at(start, "unterminated flow sequence")),
				_ => {}
			}
			// A flow sequence entry may be a single-pair mapping `a: b`.
			let item = if self.flow_entry_is_pair() {
				let key = self.parse_flow_key()?;
				self.skip_inline_space();
				self.pos += 1; // ':'
				self.skip_flow_trivia();
				let value = if matches!(self.peek(), Some(',' | ']')) {
					Value::Null
				} else {
					self.parse_flow_value()?
				};
				Value::Object(vec![(key, value)])
			} else {
				self.parse_flow_value()?
			};
			items.push(item);
			self.skip_flow_trivia();
			match self.peek() {
				Some(',') => self.pos += 1,
				Some(']') => {}
				None => return Err(self.error_at(start, "unterminated flow sequence")),
				Some(_) => return Err(self.error("expected ',' or ']'")),
			}
		}
	}

	fn parse_flow_mapping(&mut self) -> PResult<Value> {
		let start = self.pos;
		self.pos += 1;
		let mut pairs: Vec<(String, Value)> = Vec::new();
		let mut merges = Vec::new();
		loop {
			self.skip_flow_trivia();
			match self.peek() {
				Some('}') => {
					self.pos += 1;
					apply_merges(&mut pairs, merges)?;
					return Ok(Value::Object(pairs));
				}
				Some(',') => return Err(self.error("unexpected ','")),
				None => return Err(self.error_at(start, "unterminated flow mapping")),
				_ => {}
			}
			let key_pos = self.pos;
			let key = self.parse_flow_key()?;
			self.skip_inline_space();
			let value = if self.peek() == Some(':') {
				self.pos += 1;
				self.skip_flow_trivia();
				if matches!(self.peek(), Some(',' | '}')) {
					Value::Null
				} else {
					self.parse_flow_value()?
				}
			} else {
				Value::Null
			};
			if key == "<<" {
				merges.push(value);
			} else {
				if pairs.iter().any(|(k, _)| *k == key) {
					return Err(self.error_at(key_pos, format!("duplicate key \"{key}\"")));
				}
				pairs.push((key, value));
			}
			self.skip_flow_trivia();
			match self.peek() {
				Some(',') => self.pos += 1,
				Some('}') => {}
				None => return Err(self.error_at(start, "unterminated flow mapping")),
				Some(_) => return Err(self.error("expected ',' or '}'")),
			}
		}
	}

	fn flow_entry_is_pair(&self) -> bool {
		let mut i = self.pos;
		match self.chars.get(i) {
			Some('"') | Some('\'') => {
				let quote = self.chars[i];
				i += 1;
				loop {
					match self.chars.get(i) {
						None => return false,
						Some(c) if *c == quote => {
							if quote == '\'' && self.chars.get(i + 1) == Some(&'\'') {
								i += 2;
								continue;
							}
							i += 1;
							break;
						}
						Some('\\') if quote == '"' => i += 2,
						Some(_) => i += 1,
					}
				}
				while matches!(self.chars.get(i), Some(' ' | '\t')) {
					i += 1;
				}
				self.chars.get(i) == Some(&':')
			}
			Some('[') | Some('{') | Some('*') => false,
			Some(_) => {
				while let Some(&c) = self.chars.get(i) {
					match c {
						',' | ']' | '}' | '\n' | '\r' => return false,
						':' if matches!(
							self.chars.get(i + 1),
							None | Some(' ' | '\t' | '\n' | '\r' | ',' | ']' | '}')
						) =>
						{
							return true;
						}
						_ => i += 1,
					}
				}
				false
			}
			None => false,
		}
	}

	fn parse_flow_key(&mut self) -> PResult<String> {
		match self.peek() {
			Some('"') => self.parse_double_quoted(),
			Some('\'') => self.parse_single_quoted(),
			Some('!') => Err(self.error("tags ('!tag') are not supported")),
			Some('?') if matches!(self.peek_at(1), Some(' ')) => {
				Err(self.error("complex mapping keys ('? key') are not supported"))
			}
			_ => {
				let start = self.pos;
				while let Some(c) = self.peek() {
					if matches!(c, ',' | ']' | '}' | '\n' | '\r') {
						break;
					}
					if c == ':'
						&& matches!(
							self.peek_at(1),
							None | Some(' ' | '\t' | '\n' | '\r' | ',' | ']' | '}')
						) {
						break;
					}
					self.pos += 1;
				}
				let key: String = self.chars[start..self.pos]
					.iter()
					.collect::<String>()
					.trim_end()
					.to_string();
				if key.is_empty() {
					return Err(self.error_at(start, "empty mapping key"));
				}
				Ok(key)
			}
		}
	}

	fn parse_flow_value(&mut self) -> PResult<Value> {
		self.enter()?;
		let result = self.parse_flow_value_inner();
		self.depth -= 1;
		result
	}

	fn parse_flow_value_inner(&mut self) -> PResult<Value> {
		match self.peek() {
			Some('"') => Ok(Value::String(self.parse_double_quoted()?)),
			Some('\'') => Ok(Value::String(self.parse_single_quoted()?)),
			Some('[') => self.parse_flow_sequence(),
			Some('{') => self.parse_flow_mapping(),
			Some('*') => self.parse_alias(),
			Some('&') => {
				let name = self.parse_anchor_name()?;
				self.skip_inline_space();
				let v = self.parse_flow_value()?;
				self.anchors.insert(name, v.clone());
				Ok(v)
			}
			Some('!') => Err(self.error("tags ('!tag') are not supported")),
			Some('|') | Some('>') => {
				Err(self.error("block scalars are not allowed inside flow collections"))
			}
			_ => {
				let text = self.parse_plain_scalar(None, true)?;
				Ok(resolve_plain(&text))
			}
		}
	}

	/// Inside flow collections, whitespace, line breaks and comments are
	/// insignificant. Stops at EOF; the caller reports which bracket is open.
	fn skip_flow_trivia(&mut self) {
		loop {
			match self.peek() {
				Some(' ' | '\t' | '\n' | '\r') => self.pos += 1,
				Some('#') => {
					while !self.at_eol() {
						self.pos += 1;
					}
				}
				None | Some(_) => return,
			}
		}
	}
}

#[derive(Clone, Copy)]
enum Chomp {
	Strip,
	Clip,
	Keep,
}

const JOIN_MARKER: &str = "\u{0}JOIN\u{0}";

/// Folds plain-scalar lines: a single line break becomes a space, blank
/// lines become newlines.
fn fold_lines(lines: &[String]) -> String {
	let mut out = String::new();
	let mut pending_newlines = 0usize;
	let mut first = true;
	for line in lines {
		if line.is_empty() {
			pending_newlines += 1;
			continue;
		}
		if !first {
			if pending_newlines > 0 {
				out.push_str(&"\n".repeat(pending_newlines));
			} else {
				out.push(' ');
			}
		}
		pending_newlines = 0;
		out.push_str(line);
		first = false;
	}
	out
}

/// Folds quoted-scalar lines (same rule as plain, with surrounding spaces
/// of continuation lines trimmed). An escaped line break joins directly.
fn fold_quoted_lines(lines: &[String]) -> String {
	let mut out = String::new();
	let mut pending_newlines = 0usize;
	let mut first = true;
	let mut join_next = false;
	let n = lines.len();
	for (idx, line) in lines.iter().enumerate() {
		if line == JOIN_MARKER {
			join_next = true;
			continue;
		}
		let text = if idx == 0 {
			if n == 1 {
				line.as_str()
			} else {
				line.trim_end()
			}
		} else if idx == n - 1 {
			line.trim_start()
		} else {
			line.trim()
		};
		if text.is_empty() && idx != 0 && idx != n - 1 {
			pending_newlines += 1;
			continue;
		}
		if !first {
			if join_next {
				// nothing
			} else if pending_newlines > 0 {
				out.push_str(&"\n".repeat(pending_newlines));
			} else {
				out.push(' ');
			}
		}
		join_next = false;
		pending_newlines = 0;
		out.push_str(text);
		first = false;
	}
	out
}

/// Folding for `>` block scalars: lines at the content indent are joined
/// with spaces; blank lines and more-indented lines keep their newlines.
fn fold_block(lines: &[String]) -> String {
	// Between two text lines with k blank lines in between (YAML 1.2 §8.1.3):
	// - if either text line is more-indented, the break is kept: "\n" + "\n"*k
	// - otherwise k == 0 folds to a space and k > 0 becomes "\n"*k
	//   (the first break is trimmed, the blank lines remain).
	let mut out = String::new();
	let mut prev_more_indented = false;
	let mut seen_text = false;
	let mut blank_run = 0usize;
	let mut leading_blanks = 0usize;
	for line in lines {
		if line.is_empty() {
			if seen_text {
				blank_run += 1;
			} else {
				leading_blanks += 1;
			}
			continue;
		}
		let more_indented = line.starts_with(' ') || line.starts_with('\t');
		if seen_text {
			if prev_more_indented || more_indented {
				out.push('\n');
				out.push_str(&"\n".repeat(blank_run));
			} else if blank_run == 0 {
				out.push(' ');
			} else {
				out.push_str(&"\n".repeat(blank_run));
			}
		} else {
			out.push_str(&"\n".repeat(leading_blanks));
		}
		out.push_str(line);
		seen_text = true;
		prev_more_indented = more_indented;
		blank_run = 0;
	}
	// Trailing blank lines become newlines after the last line (which has none yet, like
	// the join of a literal scalar); chomping decides how many survive.
	format!("{out}{}", "\n".repeat(blank_run))
}

fn apply_merges(pairs: &mut Vec<(String, Value)>, merges: Vec<Value>) -> Result<(), Error> {
	let mut sources: Vec<Vec<(String, Value)>> = Vec::new();
	for m in merges {
		match m {
			Value::Object(p) => sources.push(p),
			Value::Array(items) => {
				for item in items {
					match item {
						Value::Object(p) => sources.push(p),
						_ => {
							return Err(Error {
								line: 0,
								column: 0,
								message: "'<<' merge value must be a mapping or a list of mappings"
									.to_string(),
							});
						}
					}
				}
			}
			Value::Null => {}
			_ => {
				return Err(Error {
					line: 0,
					column: 0,
					message: "'<<' merge value must be a mapping or a list of mappings".to_string(),
				});
			}
		}
	}
	// Explicit keys win; among merge sources, earlier ones win.
	for source in sources {
		for (k, v) in source {
			if !pairs.iter().any(|(existing, _)| *existing == k) {
				pairs.push((k, v));
			}
		}
	}
	Ok(())
}

/// YAML 1.2 core schema resolution for plain scalars.
fn resolve_plain(text: &str) -> Value {
	match text {
		"" | "~" | "null" | "Null" | "NULL" => return Value::Null,
		"true" | "True" | "TRUE" => return Value::Bool(true),
		"false" | "False" | "FALSE" => return Value::Bool(false),
		".inf" | ".Inf" | ".INF" | "+.inf" | "+.Inf" | "+.INF" => {
			return Value::Number(f64::INFINITY);
		}
		"-.inf" | "-.Inf" | "-.INF" => return Value::Number(f64::NEG_INFINITY),
		".nan" | ".NaN" | ".NAN" => return Value::Number(f64::NAN),
		_ => {}
	}
	if let Some(n) = parse_core_int(text) {
		return Value::Number(n);
	}
	if let Some(f) = parse_core_float(text) {
		return Value::Number(f);
	}
	Value::String(text.to_string())
}

fn parse_core_int(text: &str) -> Option<f64> {
	let (neg, body) = match text.strip_prefix('-') {
		Some(rest) => (true, rest),
		None => (false, text.strip_prefix('+').unwrap_or(text)),
	};
	if body.is_empty() {
		return None;
	}
	let value: i128 = if let Some(hex) = body.strip_prefix("0x") {
		if hex.is_empty() || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
			return None;
		}
		i128::from_str_radix(hex, 16).ok()?
	} else if let Some(oct) = body.strip_prefix("0o") {
		if oct.is_empty() || !oct.chars().all(|c| matches!(c, '0'..='7')) {
			return None;
		}
		i128::from_str_radix(oct, 8).ok()?
	} else {
		if !body.chars().all(|c| c.is_ascii_digit()) {
			return None;
		}
		body.parse::<i128>().ok()?
	};
	let v = if neg { -value } else { value };
	Some(v as f64)
}

fn parse_core_float(text: &str) -> Option<f64> {
	// [-+]? ( \. [0-9]+ | [0-9]+ ( \. [0-9]* )? ) ( [eE] [-+]? [0-9]+ )?
	let bytes = text.as_bytes();
	let mut i = 0;
	if matches!(bytes.first(), Some(b'+' | b'-')) {
		i += 1;
	}
	let digits_before = count_digits(bytes, i);
	i += digits_before;
	let mut digits_after = 0;
	let mut has_dot = false;
	if bytes.get(i) == Some(&b'.') {
		has_dot = true;
		i += 1;
		digits_after = count_digits(bytes, i);
		i += digits_after;
	}
	if digits_before == 0 && digits_after == 0 {
		return None;
	}
	if !has_dot && digits_before == 0 {
		return None;
	}
	let mut has_exp = false;
	if matches!(bytes.get(i), Some(b'e' | b'E')) {
		has_exp = true;
		i += 1;
		if matches!(bytes.get(i), Some(b'+' | b'-')) {
			i += 1;
		}
		let exp_digits = count_digits(bytes, i);
		if exp_digits == 0 {
			return None;
		}
		i += exp_digits;
	}
	if i != bytes.len() {
		return None;
	}
	if !has_dot && !has_exp {
		// Pure integer: handled by parse_core_int (which also rejects leading '+' edge cases consistently).
		return None;
	}
	// Rust's parser does not accept "1." or ".5"? It accepts "1." and ".5". Keep as is.
	text.parse::<f64>().ok()
}

fn count_digits(bytes: &[u8], from: usize) -> usize {
	bytes[from..]
		.iter()
		.take_while(|b| b.is_ascii_digit())
		.count()
}

#[cfg(test)]
mod tests {
	use super::*;

	fn json(src: &str) -> String {
		parse(src).unwrap().to_json()
	}

	fn err(src: &str) -> Error {
		parse(src).unwrap_err()
	}

	#[test]
	fn empty_document_is_null() {
		assert_eq!(parse("").unwrap(), Value::Null);
		assert_eq!(parse("\n# only a comment\n").unwrap(), Value::Null);
		assert_eq!(parse("---\n").unwrap(), Value::Null);
	}

	#[test]
	fn block_mapping_with_core_schema_scalars() {
		assert_eq!(
			json(
				"title: Hello world\ncount: 42\nratio: 0.5\nok: true\nnothing: ~\nalso: null\nempty:\n"
			),
			r#"{"title":"Hello world","count":42,"ratio":0.5,"ok":true,"nothing":null,"also":null,"empty":null}"#
		);
	}

	#[test]
	fn timestamps_and_other_plain_text_stay_strings() {
		assert_eq!(
			json("ver: 1.2.3\ndate: 2026-01-02\nat: 2026-01-02T03:04:05+09:00\nzip: 012-3456"),
			r#"{"ver":"1.2.3","date":"2026-01-02","at":"2026-01-02T03:04:05+09:00","zip":"012-3456"}"#
		);
	}

	#[test]
	fn integers_and_floats() {
		assert_eq!(
			json("[1, -2, +3, 0x1F, 0o17, 1.5, -.5, 1., 1e3, 2E-2, .inf, -.inf]"),
			"[1,-2,3,31,15,1.5,-0.5,1,1000,0.02,null,null]"
		);
		assert_eq!(
			// YAML 1.2 core: "08" is the decimal integer 8 (YAML 1.1 treated it as a
			// failed octal and kept a string). Underscores are not digit separators.
			json("[1_000, 08, 1.2.3, 0x, 1e]"),
			r#"["1_000",8,"1.2.3","0x","1e"]"#
		);
	}

	#[test]
	fn booleans_only_in_three_casings() {
		assert_eq!(
			json("[true, True, TRUE, false, yes, on, y]"),
			r#"[true,true,true,false,"yes","on","y"]"#
		);
	}

	#[test]
	fn block_sequences_nested_and_compact() {
		assert_eq!(
			json("- a\n- b\n- - c\n  - d\n- e: 1\n  f: 2\n"),
			r#"["a","b",["c","d"],{"e":1,"f":2}]"#
		);
		assert_eq!(
			json("items:\n  - a\n  - b\nnext: 1\n"),
			r#"{"items":["a","b"],"next":1}"#
		);
	}

	#[test]
	fn sequence_at_same_indent_as_its_key() {
		assert_eq!(
			json("tags:\n- a\n- b\nmore: x\n"),
			r#"{"tags":["a","b"],"more":"x"}"#
		);
	}

	#[test]
	fn nested_mappings_and_empty_values() {
		assert_eq!(
			json("a:\n  b:\n    c: 1\n  d: 2\ne:\nf: 3\n"),
			r#"{"a":{"b":{"c":1},"d":2},"e":null,"f":3}"#
		);
	}

	#[test]
	fn flow_collections() {
		assert_eq!(
			json("list: [a, 'b c', \"d\", [1, 2], {k: v}]"),
			r#"{"list":["a","b c","d",[1,2],{"k":"v"}]}"#
		);
		assert_eq!(
			json("{a: 1, b: [x, y], c: {d: e}, f, g: }"),
			r#"{"a":1,"b":["x","y"],"c":{"d":"e"},"f":null,"g":null}"#
		);
		assert_eq!(json("[a: 1, b]"), r#"[{"a":1},"b"]"#);
		assert_eq!(json("[\n  a,\n  b, # comment\n]"), r#"["a","b"]"#);
		assert_eq!(json("{\"a\":1,\"b\":2}"), r#"{"a":1,"b":2}"#);
		assert_eq!(json("[]"), "[]");
		assert_eq!(json("{}"), "{}");
	}

	#[test]
	fn quoted_scalars_and_escapes() {
		assert_eq!(
			json(r#"a: "tab\there \u00e9 \x41 \U0001F600 \" \\""#),
			"{\"a\":\"tab\\there é A 😀 \\\" \\\\\"}"
		);
		assert_eq!(json("a: 'it''s'"), r#"{"a":"it's"}"#);
		assert_eq!(json("a: '# not a comment'"), r##"{"a":"# not a comment"}"##);
		assert_eq!(json("a: \"x: y\""), r#"{"a":"x: y"}"#);
	}

	#[test]
	fn multi_line_scalars_fold() {
		assert_eq!(
			json("a: one\n  two\n  three\nb: 1"),
			r#"{"a":"one two three","b":1}"#
		);
		assert_eq!(json("a: one\n\n  two\n"), "{\"a\":\"one\\ntwo\"}");
		assert_eq!(json("a: \"one\n  two\"\n"), r#"{"a":"one two"}"#);
		assert_eq!(json("a: \"one\\\n  two\"\n"), r#"{"a":"onetwo"}"#);
		assert_eq!(json("a: 'one\n  two'\n"), r#"{"a":"one two"}"#);
	}

	#[test]
	fn keep_chomping_keeps_exactly_the_line_breaks_that_are_written() {
		// Literal and folded alike: the last line's own break, plus one per blank line.
		assert_eq!(json("a: |+\n  x\n"), "{\"a\":\"x\\n\"}");
		assert_eq!(json("a: >+\n  x\n"), "{\"a\":\"x\\n\"}");
		assert_eq!(json("a: |+\n  x\n\n"), "{\"a\":\"x\\n\\n\"}");
		assert_eq!(json("a: >+\n  x\n\n"), "{\"a\":\"x\\n\\n\"}");
		assert_eq!(
			json("a: >+\n  x\n  y\n\n\nb: 1"),
			"{\"a\":\"x y\\n\\n\\n\",\"b\":1}"
		);
		// Nothing but blank lines: one newline for each.
		assert_eq!(json("a: |+\n\nb: 1"), "{\"a\":\"\\n\",\"b\":1}");
		assert_eq!(json("a: >+\n\n\nb: 1"), "{\"a\":\"\\n\\n\",\"b\":1}");
	}

	#[test]
	fn literal_block_scalars_with_chomping() {
		assert_eq!(
			json("a: |\n  line 1\n  line 2\nb: 1"),
			"{\"a\":\"line 1\\nline 2\\n\",\"b\":1}"
		);
		assert_eq!(
			json("a: |-\n  line 1\n  line 2\n\n"),
			"{\"a\":\"line 1\\nline 2\"}"
		);
		assert_eq!(
			json("a: |+\n  line 1\n\n\nb: 1"),
			"{\"a\":\"line 1\\n\\n\\n\",\"b\":1}"
		);
		assert_eq!(
			// Content indentation is auto-detected from the first line, so a
			// less-indented line needs an explicit indentation indicator.
			json("a: |2\n    indented\n  less\n"),
			"{\"a\":\"  indented\\nless\\n\"}"
		);
		assert_eq!(
			json("a: |2\n   one space kept\n"),
			"{\"a\":\" one space kept\\n\"}"
		);
		assert_eq!(json("- |\n  in seq\n- x"), "[\"in seq\\n\",\"x\"]");
	}

	#[test]
	fn folded_block_scalars() {
		assert_eq!(
			json("a: >\n  one\n  two\n\n  three\n"),
			"{\"a\":\"one two\\nthree\\n\"}"
		);
		assert_eq!(json("a: >-\n  one\n  two\n"), r#"{"a":"one two"}"#);
		assert_eq!(
			json("a: >\n  one\n    more\n  two\n"),
			"{\"a\":\"one\\n  more\\ntwo\\n\"}"
		);
	}

	#[test]
	fn comments_are_ignored() {
		assert_eq!(
			json("# head\na: 1 # trailing\n# middle\nb: 2\n"),
			r#"{"a":1,"b":2}"#
		);
		assert_eq!(json("a: x#y"), r#"{"a":"x#y"}"#);
		assert_eq!(
			json("url: http://example.com/a#b"),
			r#"{"url":"http://example.com/a#b"}"#
		);
	}

	#[test]
	fn colons_inside_values() {
		assert_eq!(
			json("time: 12:30\nurl: https://example.com/x"),
			r#"{"time":"12:30","url":"https://example.com/x"}"#
		);
	}

	#[test]
	fn anchors_aliases_and_merge_keys() {
		assert_eq!(
			json("base: &b\n  x: 1\n  y: 2\nref: *b\n"),
			r#"{"base":{"x":1,"y":2},"ref":{"x":1,"y":2}}"#
		);
		assert_eq!(
			json("base: &b {x: 1, y: 2}\nover:\n  <<: *b\n  y: 3\n"),
			r#"{"base":{"x":1,"y":2},"over":{"y":3,"x":1}}"#
		);
		assert_eq!(
			json("a: &a {x: 1}\nb: &b {x: 2, z: 9}\nc:\n  <<: [*a, *b]\n"),
			r#"{"a":{"x":1},"b":{"x":2,"z":9},"c":{"x":1,"z":9}}"#
		);
		assert_eq!(json("- &s scalar\n- *s"), r#"["scalar","scalar"]"#);
	}

	#[test]
	fn document_markers() {
		assert_eq!(json("---\na: 1\n...\n"), r#"{"a":1}"#);
		assert_eq!(json("--- a\n"), r#""a""#);
		assert_eq!(
			err("a: 1\n---\nb: 2\n").message,
			"multiple YAML documents are not supported"
		);
		assert_eq!(
			err("%YAML 1.2\n---\na: 1").message,
			"YAML directives (%...) are not supported"
		);
	}

	#[test]
	fn nesting_depth_is_limited_instead_of_overflowing_the_stack() {
		// Flow collections.
		let flow = format!("{}1{}", "[".repeat(100_000), "]".repeat(100_000));
		assert_eq!(err(&flow).message, "nesting is deeper than 256 levels");
		// Block collections: 300 nested mappings.
		let mut block = String::new();
		for level in 0..300 {
			block.push_str(&" ".repeat(level));
			block.push_str("k:\n");
		}
		assert_eq!(err(&block).message, "nesting is deeper than 256 levels");
		// Block sequences: 300 nested "- ".
		let seq = "- ".repeat(300) + "x";
		assert_eq!(err(&seq).message, "nesting is deeper than 256 levels");
		// Moderate nesting still parses.
		let ok = format!("{}1{}", "[".repeat(100), "]".repeat(100));
		assert!(parse(&ok).is_ok());
	}

	#[test]
	fn rejects_unsupported_constructs_with_positions() {
		assert_eq!(err("a: !!str 1").message, "tags ('!tag') are not supported");
		assert_eq!(
			err("? complex\n: key").message,
			"complex mapping keys ('? key') are not supported"
		);
		let e = err("a: 1\na: 2");
		assert_eq!(
			(e.line, e.column, e.message.as_str()),
			(2, 1, "duplicate key \"a\"")
		);
		assert_eq!(
			err("a:\n\tb: 1").message,
			"tabs are not allowed in indentation"
		);
		assert_eq!(err("a: *missing").message, "unknown anchor \"missing\"");
		assert_eq!(err("a: [1, 2").message, "unterminated flow sequence");
		assert_eq!(
			err("a: \"open").message,
			"unterminated double-quoted string"
		);
		assert_eq!(err("a: 1\n  b: 2").message, "unexpected indentation");
		assert_eq!(
			err("a: 1\n- b").message,
			"unexpected sequence entry inside a mapping"
		);
	}

	#[test]
	fn front_matter_is_split_like_gray_matter() {
		let (meta, body) =
			split_front_matter("---\ntitle: T\nlayout: sub\n---\n<p>x</p>\n").unwrap();
		assert_eq!(meta.unwrap().to_json(), r#"{"title":"T","layout":"sub"}"#);
		assert_eq!(body, "<p>x</p>\n");

		let (meta, body) = split_front_matter("---\r\ntitle: T\r\n---\r\nbody").unwrap();
		assert_eq!(meta.unwrap().to_json(), r#"{"title":"T"}"#);
		assert_eq!(body, "body");

		let (meta, body) = split_front_matter("---\n---\nbody").unwrap();
		assert_eq!(meta.unwrap(), Value::Object(vec![]));
		assert_eq!(body, "body");

		let (meta, body) = split_front_matter("\u{FEFF}---\na: 1\n---\nb").unwrap();
		assert_eq!(meta.unwrap().to_json(), r#"{"a":1}"#);
		assert_eq!(body, "b");

		assert_eq!(
			split_front_matter("<p>no fm</p>").unwrap(),
			(None, "<p>no fm</p>")
		);
		assert_eq!(split_front_matter("\n---\na: 1\n---\n").unwrap().0, None);
		assert_eq!(split_front_matter("---x\n").unwrap().0, None);
		assert_eq!(
			split_front_matter("---\na: 1\n").unwrap_err().message,
			"front matter is not closed with a '---' line"
		);
		let e = split_front_matter("---\na: 1\na: 2\n---\n").unwrap_err();
		assert_eq!((e.line, e.message.as_str()), (3, "duplicate key \"a\""));
	}

	#[test]
	fn realistic_front_matter_from_a_site() {
		let src = "id: 100001\npath: \"/en/library/season/2016_summer.html\"\ntitle: \"Sample Page Title\"\nkeywords: \"\"\nog:\n  title: \"T\"\n  image: \"https://example.com/img/ogp.png\"\n  type: \"website\"\nbreadCrumb:\n  - { path: /, title: Home }\n  - { title: Current }\nhasContact: false\n";
		assert_eq!(
			json(src),
			r#"{"id":100001,"path":"/en/library/season/2016_summer.html","title":"Sample Page Title","keywords":"","og":{"title":"T","image":"https://example.com/img/ogp.png","type":"website"},"breadCrumb":[{"path":"/","title":"Home"},{"title":"Current"}],"hasContact":false}"#
		);
	}
}
