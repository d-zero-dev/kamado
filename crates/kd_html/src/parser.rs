//! HTML parser: a port of htmlparser2's tokenizer and tree-building rules in
//! the configuration kamado v2 used (htmlMode, lower-cased tags, attribute
//! case kept, entities decoded), producing the tree linkedom built from it.
//!
//! Why this and not the WHATWG tree builder: authored markup must come out as
//! v2 produced it. The WHATWG algorithm adds `<tbody>`, `<html>`, `<body>`,
//! moves misnested content and drops what it cannot place; this parser does
//! none of that, it only applies a small table of "an opening tag closes the
//! element on top of the stack" rules. The tokenizer is a byte-level state
//! machine, so a state here has the same name and meaning as in htmlparser2.
//!
//! Deliberate departures from v2 (each one fixes lost or corrupted content):
//! - `<?...?>` is kept as a processing-instruction node, verbatim. v2 dropped
//!   it, which silently deleted server-side includes from migrated pages.
//! - Text inside `<title>` is raw, like `<textarea>` and `<script>`: v2
//!   decoded references there and then wrote them back unescaped, turning
//!   `&lt;` into a literal `<`.
//!
//! Everything else, including the quirks that look wrong (`<a href=x/>` has
//! the value `x/`, a stray `</p>` creates an empty `<p>`, tables get no
//! implied `<tbody>`), is kept on purpose: it is what the existing sites'
//! output was generated with.

use crate::dom::{Attr, Doctype, Document, Element, NodeId, ROOT};
use crate::entities::{self, Context};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum State {
	Text,
	BeforeTagName,
	InTagName,
	InSelfClosingTag,
	BeforeClosingTagName,
	InClosingTagName,
	AfterClosingTagName,
	BeforeAttributeName,
	InAttributeName,
	AfterAttributeName,
	BeforeAttributeValue,
	InAttributeValueDq,
	InAttributeValueSq,
	InAttributeValueNq,
	BeforeDeclaration,
	InDeclaration,
	InProcessingInstruction,
	BeforeComment,
	CdataSequence,
	InSpecialComment,
	InCommentLike,
	BeforeSpecialS,
	BeforeSpecialT,
	SpecialStartSequence,
	InSpecialTag,
}

const CDATA: &[u8] = b"CDATA[";
const CDATA_END: &[u8] = b"]]>";
const COMMENT_END: &[u8] = b"-->";
const SCRIPT_END: &[u8] = b"</script";
const STYLE_END: &[u8] = b"</style";
const TITLE_END: &[u8] = b"</title";
const TEXTAREA_END: &[u8] = b"</textarea";
const XMP_END: &[u8] = b"</xmp";

fn is_whitespace(c: u8) -> bool {
	matches!(c, b' ' | b'\n' | b'\t' | 0x0C | b'\r')
}

fn is_end_of_tag_section(c: u8) -> bool {
	c == b'/' || c == b'>' || is_whitespace(c)
}

fn is_ascii_alpha(c: u8) -> bool {
	c.is_ascii_alphabetic()
}

/// Void elements for the parser (closed as soon as they open).
fn is_void(name: &str) -> bool {
	matches!(
		name,
		"area"
			| "base" | "basefont"
			| "br" | "col"
			| "command"
			| "embed" | "frame"
			| "hr" | "img"
			| "input" | "isindex"
			| "keygen"
			| "link" | "meta"
			| "param" | "source"
			| "track" | "wbr"
	)
}

/// The elements an opening `name` closes while one of them is on top of the
/// stack (htmlparser2's `openImpliesClose`). Only the top is checked, so
/// `<table><tr><td><b>x<tr>` does not close the `td` hidden under the `b`.
fn implies_close(name: &str, top: &str) -> bool {
	const FORM: [&str; 7] = [
		"input", "option", "optgroup", "select", "button", "datalist", "textarea",
	];
	match name {
		"tr" => matches!(top, "tr" | "th" | "td"),
		"th" => top == "th",
		"td" => matches!(top, "thead" | "th" | "td"),
		"body" => matches!(top, "head" | "link" | "script"),
		"li" => top == "li",
		"p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => top == "p",
		"select" | "input" | "output" | "button" | "datalist" | "textarea" => FORM.contains(&top),
		"option" => top == "option",
		"optgroup" => matches!(top, "optgroup" | "option"),
		"dd" | "dt" => matches!(top, "dd" | "dt"),
		"address" | "article" | "aside" | "blockquote" | "details" | "div" | "dl" | "fieldset"
		| "figcaption" | "figure" | "footer" | "form" | "header" | "hr" | "main" | "nav" | "ol"
		| "pre" | "section" | "table" | "ul" => top == "p",
		"rt" | "rp" => matches!(top, "rt" | "rp"),
		"tbody" | "tfoot" => matches!(top, "thead" | "tbody"),
		_ => false,
	}
}

fn is_foreign_context_element(name: &str) -> bool {
	matches!(name, "math" | "svg")
}

fn is_html_integration_element(name: &str) -> bool {
	matches!(
		name,
		"mi" | "mo" | "mn" | "ms" | "mtext" | "annotation-xml" | "foreignobject" | "desc" | "title"
	)
}

/// JavaScript's `\s`: used by `classList`, which normalizes `class` values.
fn is_js_space(c: char) -> bool {
	matches!(
		c,
		'\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
			..='\u{200A}'
				| '\u{2028}' | '\u{2029}'
				| '\u{202F}' | '\u{205F}'
				| '\u{3000}' | '\u{FEFF}'
	)
}

/// What linkedom does to a `class` value on parse: split on whitespace, drop
/// empty tokens and duplicates (first one wins), join with one space.
///
/// # Example
///
/// ```
/// assert_eq!(kd_html::parser::normalize_class("a  b\nc a"), "a b c");
/// assert_eq!(kd_html::parser::normalize_class("  "), "");
/// ```
#[must_use]
pub fn normalize_class(value: &str) -> String {
	let mut seen: Vec<&str> = Vec::new();
	for token in value.split(is_js_space) {
		if !token.is_empty() && !seen.contains(&token) {
			seen.push(token);
		}
	}
	seen.join(" ")
}

/// JavaScript object key order: canonical array indices ascending first, then
/// the rest in insertion order. linkedom iterates a plain object of
/// attributes, so `<p b=1 2=x>` prints `2` before `b`.
fn is_array_index(name: &str) -> Option<u32> {
	if name.is_empty() || name.len() > 10 {
		return None;
	}
	if name.len() > 1 && name.starts_with('0') {
		return None;
	}
	if !name.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	name.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

struct Machine<'a> {
	src: &'a str,
	buf: &'a [u8],

	// tokenizer
	state: State,
	section_start: isize,
	index: isize,
	is_special: bool,
	current_sequence: &'static [u8],
	sequence_index: usize,

	// parser
	stack: Vec<String>,
	foreign_context: Vec<bool>,
	tagname: String,
	attribname: String,
	attribvalue: String,
	attribs: Vec<(String, String)>,
	open_tag_pending: bool,

	// tree builder (linkedom)
	doc: Document,
	node: NodeId,
	owner_svg: Option<NodeId>,
	pending_doctype: Vec<Doctype>,
}

impl<'a> Machine<'a> {
	fn new(src: &'a str) -> Machine<'a> {
		Machine {
			src,
			buf: src.as_bytes(),
			state: State::Text,
			section_start: 0,
			index: 0,
			is_special: false,
			current_sequence: SCRIPT_END,
			sequence_index: 0,
			stack: Vec::new(),
			foreign_context: vec![false],
			tagname: String::new(),
			attribname: String::new(),
			attribvalue: String::new(),
			attribs: Vec::new(),
			open_tag_pending: false,
			doc: Document::new(),
			node: ROOT,
			owner_svg: None,
			pending_doctype: Vec::new(),
		}
	}

	fn len(&self) -> isize {
		self.buf.len() as isize
	}

	fn slice(&self, start: isize, end: isize) -> &'a str {
		if start < 0 || end < start || end > self.len() {
			return "";
		}
		let (s, e) = (start as usize, end as usize);
		debug_assert!(self.src.is_char_boundary(s) && self.src.is_char_boundary(e));
		self.src.get(s..e).unwrap_or("")
	}

	// ---- tokenizer ---------------------------------------------------------

	fn run(mut self) -> Document {
		while self.index < self.len() {
			let c = self.buf[self.index as usize];
			match self.state {
				State::Text => self.state_text(c),
				State::SpecialStartSequence => self.state_special_start_sequence(c),
				State::InSpecialTag => self.state_in_special_tag(c),
				State::CdataSequence => self.state_cdata_sequence(c),
				State::InAttributeValueDq => self.handle_in_attribute_value(c, b'"'),
				State::InAttributeName => self.state_in_attribute_name(c),
				State::InCommentLike => self.state_in_comment_like(c),
				State::InSpecialComment => self.state_in_special_comment(c),
				State::BeforeAttributeName => self.state_before_attribute_name(c),
				State::InTagName => self.state_in_tag_name(c),
				State::InClosingTagName => self.state_in_closing_tag_name(c),
				State::BeforeTagName => self.state_before_tag_name(c),
				State::AfterAttributeName => self.state_after_attribute_name(c),
				State::InAttributeValueSq => self.handle_in_attribute_value(c, b'\''),
				State::BeforeAttributeValue => self.state_before_attribute_value(c),
				State::BeforeClosingTagName => self.state_before_closing_tag_name(c),
				State::AfterClosingTagName => self.state_after_closing_tag_name(c),
				State::BeforeSpecialS => self.state_before_special_s(c),
				State::BeforeSpecialT => self.state_before_special_t(c),
				State::InAttributeValueNq => self.state_in_attribute_value_no_quotes(c),
				State::InSelfClosingTag => self.state_in_self_closing_tag(c),
				State::InDeclaration => self.state_in_declaration(c),
				State::BeforeDeclaration => self.state_before_declaration(c),
				State::BeforeComment => self.state_before_comment(c),
				State::InProcessingInstruction => self.state_in_processing_instruction(c),
			}
			self.index += 1;
		}
		self.finish();
		self.insert_doctypes();
		self.doc
	}

	/// The tokenizer's `fastForwardTo`: moves `index` to the next `c`.
	fn fast_forward_to(&mut self, c: u8) -> bool {
		loop {
			self.index += 1;
			if self.index >= self.len() {
				break;
			}
			if self.buf[self.index as usize] == c {
				return true;
			}
		}
		self.index = self.len() - 1;
		false
	}

	fn state_text(&mut self, c: u8) {
		if c == b'<' {
			if self.index > self.section_start {
				self.ontext(self.section_start, self.index);
			}
			self.state = State::BeforeTagName;
			self.section_start = self.index;
		} else if c == b'&' {
			self.start_entity(Context::Text);
		} else {
			// Nothing else matters in text: jump to the next `<` or `&`.
			let from = self.index as usize + 1;
			let next = self.buf[from..]
				.iter()
				.position(|&b| b == b'<' || b == b'&')
				.map_or(self.buf.len(), |p| from + p);
			self.index = next as isize - 1;
		}
	}

	/// Decodes the character reference at `index`, if there is one.
	fn start_entity(&mut self, context: Context) {
		let entity_start = self.index;
		let rest = &self.src[entity_start as usize..];
		let Some((text, consumed)) = entities::decode_one(rest, context) else {
			return;
		};
		if context == Context::Text {
			if self.section_start < entity_start {
				self.ontext(self.section_start, entity_start);
			}
			self.section_start = entity_start + consumed as isize;
			self.index = self.section_start - 1;
			self.append_text(&text);
		} else {
			if self.section_start < entity_start {
				let data = self.slice(self.section_start, entity_start);
				self.attribvalue.push_str(data);
			}
			self.section_start = entity_start + consumed as isize;
			self.index = self.section_start - 1;
			self.attribvalue.push_str(&text);
		}
	}

	fn state_special_start_sequence(&mut self, c: u8) {
		let is_end = self.sequence_index == self.current_sequence.len();
		let is_match = if is_end {
			is_end_of_tag_section(c)
		} else {
			(c | 0x20) == self.current_sequence[self.sequence_index]
		};
		if !is_match {
			self.is_special = false;
		} else if !is_end {
			self.sequence_index += 1;
			return;
		}
		self.sequence_index = 0;
		self.state = State::InTagName;
		self.state_in_tag_name(c);
	}

	fn state_in_special_tag(&mut self, c: u8) {
		if self.sequence_index == self.current_sequence.len() {
			if c == b'>' || is_whitespace(c) {
				let end_of_text = self.index - self.current_sequence.len() as isize;
				if self.section_start < end_of_text {
					self.ontext(self.section_start, end_of_text);
				}
				self.is_special = false;
				self.section_start = end_of_text + 2; // skip `</`
				self.state_in_closing_tag_name(c);
				return;
			}
			self.sequence_index = 0;
		}
		if (c | 0x20) == self.current_sequence[self.sequence_index] {
			self.sequence_index += 1;
		} else if self.sequence_index == 0 {
			if self.fast_forward_to(b'<') {
				self.sequence_index = 1;
			}
		} else {
			// A `<` restarts the match, which makes `<</script>` work.
			self.sequence_index = usize::from(c == b'<');
		}
	}

	fn state_cdata_sequence(&mut self, c: u8) {
		if c == CDATA[self.sequence_index] {
			self.sequence_index += 1;
			if self.sequence_index == CDATA.len() {
				self.state = State::InCommentLike;
				self.current_sequence = CDATA_END;
				self.sequence_index = 0;
				self.section_start = self.index + 1;
			}
		} else {
			self.sequence_index = 0;
			self.state = State::InDeclaration;
			self.state_in_declaration(c);
		}
	}

	fn state_in_comment_like(&mut self, c: u8) {
		if c == self.current_sequence[self.sequence_index] {
			self.sequence_index += 1;
			if self.sequence_index == self.current_sequence.len() {
				if self.current_sequence == CDATA_END {
					self.oncdata(self.section_start, self.index, 2);
				} else {
					self.oncomment(self.section_start, self.index, 2);
				}
				self.sequence_index = 0;
				self.section_start = self.index + 1;
				self.state = State::Text;
			}
		} else if self.sequence_index == 0 {
			if self.fast_forward_to(self.current_sequence[0]) {
				self.sequence_index = 1;
			}
		} else if c != self.current_sequence[self.sequence_index - 1] {
			// Allow long sequences, e.g. `--->` and `]]]>`.
			self.sequence_index = 0;
		}
	}

	fn start_special(&mut self, sequence: &'static [u8], offset: usize) {
		self.is_special = true;
		self.current_sequence = sequence;
		self.sequence_index = offset;
		self.state = State::SpecialStartSequence;
	}

	fn state_before_tag_name(&mut self, c: u8) {
		if c == b'!' {
			self.state = State::BeforeDeclaration;
			self.section_start = self.index + 1;
		} else if c == b'?' {
			self.state = State::InProcessingInstruction;
			self.section_start = self.index + 1;
		} else if is_ascii_alpha(c) {
			let lower = c | 0x20;
			self.section_start = self.index;
			if lower == SCRIPT_END[2] {
				self.state = State::BeforeSpecialS;
			} else if lower == TITLE_END[2] || lower == XMP_END[2] {
				self.state = State::BeforeSpecialT;
			} else {
				self.state = State::InTagName;
			}
		} else if c == b'/' {
			self.state = State::BeforeClosingTagName;
		} else {
			self.state = State::Text;
			self.state_text(c);
		}
	}

	fn state_in_tag_name(&mut self, c: u8) {
		if is_end_of_tag_section(c) {
			self.onopentagname(self.section_start, self.index);
			self.section_start = -1;
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c);
		}
	}

	fn state_before_closing_tag_name(&mut self, c: u8) {
		if is_whitespace(c) {
			// ignore
		} else if c == b'>' {
			self.state = State::Text;
		} else {
			self.state = if is_ascii_alpha(c) {
				State::InClosingTagName
			} else {
				State::InSpecialComment
			};
			self.section_start = self.index;
		}
	}

	fn state_in_closing_tag_name(&mut self, c: u8) {
		if c == b'>' || is_whitespace(c) {
			self.onclosetag(self.section_start, self.index);
			self.section_start = -1;
			self.state = State::AfterClosingTagName;
			self.state_after_closing_tag_name(c);
		}
	}

	fn state_after_closing_tag_name(&mut self, c: u8) {
		// Skip everything until `>`.
		if c == b'>' || self.fast_forward_to(b'>') {
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	fn state_before_attribute_name(&mut self, c: u8) {
		if c == b'>' {
			self.onopentagend();
			if self.is_special {
				self.state = State::InSpecialTag;
				self.sequence_index = 0;
			} else {
				self.state = State::Text;
			}
			self.section_start = self.index + 1;
		} else if c == b'/' {
			self.state = State::InSelfClosingTag;
		} else if !is_whitespace(c) {
			self.state = State::InAttributeName;
			self.section_start = self.index;
		}
	}

	fn state_in_self_closing_tag(&mut self, c: u8) {
		if c == b'>' {
			self.onselfclosingtag();
			self.state = State::Text;
			self.section_start = self.index + 1;
			// Reset the special state, in case of a self-closing special tag.
			self.is_special = false;
		} else if !is_whitespace(c) {
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c);
		}
	}

	fn state_in_attribute_name(&mut self, c: u8) {
		if c == b'=' || is_end_of_tag_section(c) {
			self.onattribname(self.section_start, self.index);
			self.section_start = self.index;
			self.state = State::AfterAttributeName;
			self.state_after_attribute_name(c);
		}
	}

	fn state_after_attribute_name(&mut self, c: u8) {
		if c == b'=' {
			self.state = State::BeforeAttributeValue;
		} else if c == b'/' || c == b'>' {
			self.onattribend();
			self.section_start = -1;
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c);
		} else if !is_whitespace(c) {
			self.onattribend();
			self.state = State::InAttributeName;
			self.section_start = self.index;
		}
	}

	fn state_before_attribute_value(&mut self, c: u8) {
		if c == b'"' {
			self.state = State::InAttributeValueDq;
			self.section_start = self.index + 1;
		} else if c == b'\'' {
			self.state = State::InAttributeValueSq;
			self.section_start = self.index + 1;
		} else if !is_whitespace(c) {
			self.section_start = self.index;
			self.state = State::InAttributeValueNq;
			self.state_in_attribute_value_no_quotes(c);
		}
	}

	fn handle_in_attribute_value(&mut self, c: u8, quote: u8) {
		if c == quote {
			let data = self.slice(self.section_start, self.index);
			self.attribvalue.push_str(data);
			self.section_start = -1;
			self.onattribend();
			self.state = State::BeforeAttributeName;
		} else if c == b'&' {
			self.start_entity(Context::Attribute);
		}
	}

	fn state_in_attribute_value_no_quotes(&mut self, c: u8) {
		if is_whitespace(c) || c == b'>' {
			let data = self.slice(self.section_start, self.index);
			self.attribvalue.push_str(data);
			self.section_start = -1;
			self.onattribend();
			self.state = State::BeforeAttributeName;
			self.state_before_attribute_name(c);
		} else if c == b'&' {
			self.start_entity(Context::Attribute);
		}
	}

	fn state_before_declaration(&mut self, c: u8) {
		if c == b'[' {
			self.state = State::CdataSequence;
			self.sequence_index = 0;
		} else {
			self.state = if c == b'-' {
				State::BeforeComment
			} else {
				State::InDeclaration
			};
		}
	}

	fn state_in_declaration(&mut self, c: u8) {
		if c == b'>' || self.fast_forward_to(b'>') {
			self.ondeclaration(self.section_start, self.index);
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	/// `<?...?>`. Departure from htmlparser2: the instruction ends at `?>`
	/// (PHP code contains `>` in `->` and `=>`), and it is kept, not dropped.
	/// Without a `?>` it ends at the first `>` like any declaration.
	fn state_in_processing_instruction(&mut self, c: u8) {
		let _ = c;
		let start = self.index; // first byte after `<?`
		let rest = &self.buf[start as usize..];
		let end = find_subslice(rest, b"?>")
			.map(|p| start + p as isize + 2) // exclusive end after `?>`
			.or_else(|| {
				rest.iter()
					.position(|&b| b == b'>')
					.map(|p| start + p as isize + 1)
			});
		match end {
			Some(end) => {
				// section_start is just after `<?`, so the node starts two bytes before.
				let raw = self.slice(self.section_start - 2, end);
				self.append_processing_instruction(raw);
				self.index = end - 1;
				self.state = State::Text;
				self.section_start = end;
			}
			None => {
				// Unterminated: leave it for the trailing-data rule (text).
				self.index = self.len() - 1;
			}
		}
	}

	fn state_before_comment(&mut self, c: u8) {
		if c == b'-' {
			self.state = State::InCommentLike;
			self.current_sequence = COMMENT_END;
			// Allow short comments, e.g. `<!-->`.
			self.sequence_index = 2;
			self.section_start = self.index + 1;
		} else {
			self.state = State::InDeclaration;
		}
	}

	fn state_in_special_comment(&mut self, c: u8) {
		if c == b'>' || self.fast_forward_to(b'>') {
			self.oncomment(self.section_start, self.index, 0);
			self.state = State::Text;
			self.section_start = self.index + 1;
		}
	}

	fn state_before_special_s(&mut self, c: u8) {
		let lower = c | 0x20;
		if lower == SCRIPT_END[3] {
			self.start_special(SCRIPT_END, 4);
		} else if lower == STYLE_END[3] {
			self.start_special(STYLE_END, 4);
		} else {
			self.state = State::InTagName;
			self.state_in_tag_name(c);
		}
	}

	fn state_before_special_t(&mut self, c: u8) {
		let lower = c | 0x20;
		if lower == TITLE_END[3] {
			self.start_special(TITLE_END, 4);
		} else if lower == TEXTAREA_END[3] {
			self.start_special(TEXTAREA_END, 4);
		} else if lower == XMP_END[3] {
			self.start_special(XMP_END, 4);
		} else {
			self.state = State::InTagName;
			self.state_in_tag_name(c);
		}
	}

	fn finish(&mut self) {
		let end = self.len();
		if self.section_start >= end {
			return;
		}
		match self.state {
			State::InCommentLike if self.section_start >= 0 => {
				if self.current_sequence == CDATA_END {
					self.oncdata(self.section_start, end, 0);
				} else {
					self.oncomment(self.section_start, end, 0);
				}
			}
			// An unfinished tag is dropped.
			State::InTagName
			| State::BeforeAttributeName
			| State::BeforeAttributeValue
			| State::AfterAttributeName
			| State::InAttributeName
			| State::InAttributeValueSq
			| State::InAttributeValueDq
			| State::InAttributeValueNq
			| State::InClosingTagName => {}
			// A tag that ends in `/` or runs on after its name without a `>`
			// leaves the section start at -1, and htmlparser2 then slices the
			// buffer from -1: the last character becomes a text node.
			// Reproduced because the output has to match v2 byte for byte.
			_ if self.section_start < 0 => {
				if let Some(last) = self.src.chars().next_back() {
					self.append_text(&self.src[self.src.len() - last.len_utf8()..]);
				}
			}
			_ => self.ontext(self.section_start, end),
		}
		self.close_open_elements();
	}

	/// Closes what is still open at the end of the input.
	fn close_open_elements(&mut self) {
		while !self.stack.is_empty() {
			self.stack.pop();
			self.b_close();
		}
	}

	// ---- parser (htmlparser2 Parser) ---------------------------------------

	fn ontext(&mut self, start: isize, end: isize) {
		let text = self.slice(start, end);
		self.append_text(text);
	}

	fn onopentagname(&mut self, start: isize, end: isize) {
		let name = self.slice(start, end).to_lowercase();
		self.emit_open_tag(&name);
	}

	fn emit_open_tag(&mut self, name: &str) {
		self.tagname = name.to_string();
		while let Some(top) = self.stack.last() {
			if implies_close(name, top) {
				self.stack.pop();
				self.b_close();
			} else {
				break;
			}
		}
		if !is_void(name) {
			self.stack.push(name.to_string());
			if is_foreign_context_element(name) {
				self.foreign_context.push(true);
			} else if is_html_integration_element(name) {
				self.foreign_context.push(false);
			}
		}
		self.attribs.clear();
		self.open_tag_pending = true;
	}

	fn end_open_tag(&mut self) {
		if self.open_tag_pending {
			let name = self.tagname.clone();
			let attribs = std::mem::take(&mut self.attribs);
			self.b_open(&name, attribs);
			self.open_tag_pending = false;
		}
		if is_void(&self.tagname) {
			let name = std::mem::take(&mut self.tagname);
			let _ = name;
			self.b_close();
		}
		self.tagname.clear();
	}

	fn onopentagend(&mut self) {
		self.end_open_tag();
	}

	fn onclosetag(&mut self, start: isize, end: isize) {
		let name = self.slice(start, end).to_lowercase();
		if is_foreign_context_element(&name) || is_html_integration_element(&name) {
			self.foreign_context.pop();
		}
		if !is_void(&name) {
			if let Some(pos) = self.stack.iter().rposition(|n| *n == name) {
				// Close everything above it, then it.
				while self.stack.len() > pos {
					self.stack.pop();
					self.b_close();
				}
			} else if name == "p" {
				// A stray `</p>` creates an empty paragraph.
				self.emit_open_tag("p");
				self.close_current_tag();
			}
		} else if name == "br" {
			// A stray `</br>` creates a line break (not via emit_open_tag,
			// which would close it again).
			self.b_open("br", Vec::new());
			self.b_close();
		}
	}

	fn onselfclosingtag(&mut self) {
		if self.foreign_context.last().copied().unwrap_or(false) {
			self.close_current_tag();
		} else {
			// Ignore the fact that the tag is self-closing.
			self.onopentagend();
		}
	}

	fn close_current_tag(&mut self) {
		let name = self.tagname.clone();
		self.end_open_tag();
		// Self-closing tags are on the top of the stack.
		if self.stack.last() == Some(&name) {
			self.stack.pop();
			self.b_close();
		}
	}

	fn onattribname(&mut self, start: isize, end: isize) {
		self.attribname = self.slice(start, end).to_string();
	}

	fn onattribend(&mut self) {
		let name = std::mem::take(&mut self.attribname);
		let value = std::mem::take(&mut self.attribvalue);
		// The first attribute with a given (case-sensitive) name wins.
		if self.open_tag_pending && !self.attribs.iter().any(|(n, _)| *n == name) {
			self.attribs.push((name, value));
		}
	}

	fn ondeclaration(&mut self, start: isize, end: isize) {
		let value = self.slice(start, end);
		let name_end = value
			.find(|c: char| c.is_whitespace() || c == '/')
			.unwrap_or(value.len());
		// htmlparser2 hands linkedom the name as `!name`; the `!` is not part of
		// `value` (the slice starts after `<!`).
		let name = format!("!{}", value[..name_end].to_lowercase());
		if name == "!doctype" {
			let rest = value[name_end..].trim();
			if let Some(doctype) = parse_doctype(rest) {
				self.pending_doctype.push(doctype);
			}
		}
		// Other declarations (`<!ELEMENT ...>`) are dropped, as in v2.
	}

	fn oncomment(&mut self, start: isize, end: isize, offset: isize) {
		let data = self.slice(start, end - offset).to_string();
		let id = self.doc.create_comment(&data);
		self.doc.append_child(self.node, id);
	}

	/// CDATA is a comment in HTML mode: `<!--[CDATA[...]]-->`.
	fn oncdata(&mut self, start: isize, end: isize, offset: isize) {
		let value = self.slice(start, end - offset);
		let data = format!("[CDATA[{value}]]");
		let id = self.doc.create_comment(&data);
		self.doc.append_child(self.node, id);
	}

	fn append_text(&mut self, text: &str) {
		if !text.is_empty() {
			self.doc.append_text(self.node, text);
		}
	}

	fn append_processing_instruction(&mut self, raw: &str) {
		let id = self.doc.create_processing_instruction(raw);
		self.doc.append_child(self.node, id);
	}

	// ---- tree builder (linkedom parse-from-string) ---------------------------

	fn b_open(&mut self, name: &str, attribs: Vec<(String, String)>) {
		let in_svg = self.owner_svg.is_some();
		let is_svg_root = !in_svg && name == "svg";
		let mut attrs: Vec<Attr> = attribs
			.into_iter()
			.map(|(n, v)| {
				let value = if n == "class" { normalize_class(&v) } else { v };
				Attr { name: n, value }
			})
			.collect();
		// Integer-like names first, ascending: JavaScript object key order.
		if attrs.iter().any(|a| is_array_index(&a.name).is_some()) {
			attrs.sort_by_key(|a| is_array_index(&a.name).map_or((1, 0), |n| (0, n)));
		}
		let id = self.doc.create_element_with(Element {
			name: name.to_string(),
			attrs,
			svg: in_svg || is_svg_root,
		});
		self.doc.append_child(self.node, id);
		if is_svg_root {
			self.owner_svg = Some(id);
		}
		self.node = id;
	}

	fn b_close(&mut self) {
		if self.owner_svg == Some(self.node) {
			self.owner_svg = None;
		}
		if let Some(parent) = self.doc.parent(self.node) {
			self.node = parent;
		}
	}

	/// linkedom puts each parsed doctype at the start of the document, so the
	/// last one parsed ends up first.
	fn insert_doctypes(&mut self) {
		for doctype in std::mem::take(&mut self.pending_doctype) {
			let id = self.doc.create_doctype(doctype);
			self.doc.prepend_child(ROOT, id);
		}
	}
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	haystack.windows(needle.len()).position(|w| w == needle)
}

/// linkedom's doctype setter:
/// `/^([a-z:]+)(\s+system|\s+public(\s+"([^"]+)")?)?(\s+"([^"]+)")?/i`
fn parse_doctype(text: &str) -> Option<Doctype> {
	let bytes = text.as_bytes();
	let name_len = bytes
		.iter()
		.take_while(|b| b.is_ascii_alphabetic() || **b == b':')
		.count();
	if name_len == 0 {
		return None;
	}
	let name = &text[..name_len];
	let mut rest = &text[name_len..];
	let mut public_id = String::new();

	let skip_ws = |s: &str| -> usize { s.len() - s.trim_start_matches(js_ws).len() };
	let quoted = |s: &str| -> Option<(String, usize)> {
		let ws = skip_ws(s);
		if ws == 0 {
			return None;
		}
		let after = &s[ws..];
		let inner = after.strip_prefix('"')?;
		let close = inner.find('"')?;
		if close == 0 {
			return None;
		}
		Some((inner[..close].to_string(), ws + 1 + close + 1))
	};

	let ws = skip_ws(rest);
	if ws > 0 {
		let after = &rest[ws..];
		let lower = after.to_ascii_lowercase();
		if lower.starts_with("system") {
			rest = &after[6..];
		} else if lower.starts_with("public") {
			rest = &after[6..];
			if let Some((value, used)) = quoted(rest) {
				public_id = value;
				rest = &rest[used..];
			}
		}
	}
	let system_id = quoted(rest).map(|(v, _)| v).unwrap_or_default();
	Some(Doctype {
		name: name.to_string(),
		public_id,
		system_id,
	})
}

fn js_ws(c: char) -> bool {
	is_js_space(c)
}

/// Parses markup the way kamado v2's DOM layer did for one piece of HTML.
/// The result has no implied `html`, `head` or `body`.
///
/// # Example
///
/// ```
/// use kd_html::dom::NodeKind;
/// let doc = kd_html::parser::parse("<p>a<p>b");
/// let tags: Vec<String> = doc
///     .children(kd_html::dom::ROOT)
///     .filter_map(|c| doc.element(c).map(|e| e.name.clone()))
///     .collect();
/// assert_eq!(tags, ["p", "p"]);
/// ```
#[must_use]
pub fn parse(src: &str) -> Document {
	Machine::new(src).run()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::dom::NodeKind;

	/// A compact, structure-only rendering for assertions: `p(#a,em(#b))`.
	fn shape(doc: &Document, parent: NodeId) -> String {
		doc.children(parent)
			.map(|c| match doc.kind(c) {
				NodeKind::Element(e) => {
					let kids = shape(doc, c);
					let attrs: String = e
						.attrs
						.iter()
						.map(|a| format!(" {}={:?}", a.name, a.value))
						.collect();
					if kids.is_empty() {
						format!("{}{attrs}", e.name)
					} else {
						format!("{}{attrs}({kids})", e.name)
					}
				}
				NodeKind::Text(t) => format!("#{t:?}"),
				NodeKind::Comment(c) => format!("<!{c:?}>"),
				NodeKind::Doctype(d) => format!("doctype({})", d.name),
				NodeKind::ProcessingInstruction(p) => format!("pi({p})"),
				NodeKind::Document => String::new(),
			})
			.collect::<Vec<_>>()
			.join(",")
	}

	fn s(src: &str) -> String {
		let doc = parse(src);
		shape(&doc, ROOT)
	}

	#[test]
	fn plain_nesting_and_text() {
		assert_eq!(s("<div><p>a</p><p>b</p></div>"), "div(p(#\"a\"),p(#\"b\"))");
		assert_eq!(s("hello"), "#\"hello\"");
		assert_eq!(s(""), "");
	}

	#[test]
	fn tag_names_are_lowercased_and_attribute_names_keep_their_case() {
		assert_eq!(
			s("<DIV CLASS=\"A\" Data-X=1 onClick=f()>t</DIV>"),
			"div CLASS=\"A\" Data-X=\"1\" onClick=\"f()\"(#\"t\")"
		);
	}

	#[test]
	fn an_opening_tag_closes_the_element_on_top_of_the_stack() {
		assert_eq!(s("<p>a<p>b"), "p(#\"a\"),p(#\"b\")");
		assert_eq!(s("<ul><li>a<li>b</ul>"), "ul(li(#\"a\"),li(#\"b\"))");
		assert_eq!(s("<p>a<div>b</div>c</p>"), "p(#\"a\"),div(#\"b\"),#\"c\",p");
		assert_eq!(s("<p><b>x<div>y</div></b></p>"), "p(b(#\"x\",div(#\"y\")))");
		assert_eq!(
			s("<select><option>a<option>b</select>"),
			"select(option(#\"a\"),option(#\"b\"))"
		);
		assert_eq!(s("<h1>a<h2>b"), "h1(#\"a\",h2(#\"b\"))");
	}

	#[test]
	fn tables_get_no_implied_tbody_and_close_rows_only_from_the_top() {
		assert_eq!(
			s("<table><tr><td>a<td>b<tr><td>c</table>"),
			"table(tr(td(#\"a\"),td(#\"b\")),tr(td(#\"c\")))"
		);
		assert_eq!(
			s("<table><tr><td><b>x<tr><td>y</table>"),
			"table(tr(td(b(#\"x\",tr(td(#\"y\"))))))"
		);
	}

	#[test]
	fn void_elements_close_themselves_and_stray_closers_follow_the_rules() {
		assert_eq!(
			s("<br><br/><img src=a.png alt=x>"),
			"br,br,img src=\"a.png\" alt=\"x\""
		);
		assert_eq!(s("<input>x</input>"), "input,#\"x\"");
		assert_eq!(s("<br></br>x</br>y"), "br,br,#\"x\",br,#\"y\"");
		assert_eq!(s("</p>x</div>y"), "p,#\"xy\"");
		assert_eq!(s("<p>a</p></p>b"), "p(#\"a\"),p,#\"b\"");
	}

	#[test]
	fn self_closing_syntax_is_ignored_in_html_but_honoured_in_svg() {
		assert_eq!(s("<div/>x<span/>y"), "div(#\"x\",span(#\"y\"))");
		assert_eq!(s("<my-el><x-y/>z</my-el>"), "my-el(x-y(#\"z\"))");
		assert_eq!(
			s("<svg><path d=\"M0\"/><circle r=1></circle></svg>"),
			"svg(path d=\"M0\",circle r=\"1\")"
		);
	}

	#[test]
	fn attributes_quoting_duplicates_and_order() {
		assert_eq!(s("<a href=x/>"), "a href=\"x/\"");
		assert_eq!(s("<div a=1 a=2 b>x</div>"), "div a=\"1\" b=\"\"(#\"x\")");
		assert_eq!(s("<p A=1 a=2>"), "p A=\"1\" a=\"2\"");
		assert_eq!(s("<p a= b=c>x</p>"), "p a=\"b=c\"(#\"x\")");
		assert_eq!(s("<div =x>y</div>"), "div =x=\"\"(#\"y\")");
		assert_eq!(s("<img/ src=a>"), "img src=\"a\"");
		assert_eq!(s("<a b = \"c\">"), "a b=\"c\"");
		assert_eq!(s("<a b='1'c=\"2\">"), "a b=\"1\" c=\"2\"");
		assert_eq!(
			s("<p b=1 2=x a=y>t</p>"),
			"p 2=\"x\" b=\"1\" a=\"y\"(#\"t\")"
		);
		assert_eq!(s("<p 10=a 2=b>"), "p 2=\"b\" 10=\"a\"");
	}

	#[test]
	fn class_values_are_normalized() {
		assert_eq!(s("<p class=\"a  b\nc\">"), "p class=\"a b c\"");
		assert_eq!(s("<p class=\"  \">"), "p class=\"\"");
		assert_eq!(s("<p class=\"a a b\">"), "p class=\"a b\"");
		assert_eq!(s("<p CLASS=\"a  b\">"), "p CLASS=\"a  b\"");
	}

	#[test]
	fn entities_are_decoded_in_text_and_attributes() {
		assert_eq!(s("a &amp; b &lt;c&gt; &copy; &#65;"), "#\"a & b <c> © A\"");
		assert_eq!(
			s("<a href=\"?a=1&b=2&amp;c=3\">"),
			"a href=\"?a=1&b=2&c=3\""
		);
		assert_eq!(
			s("<a href=\"a&amp=1&ampb=2\">"),
			"a href=\"a&amp=1&ampb=2\""
		);
		assert_eq!(s("&hearts &foo; &amp"), "#\"&hearts &foo; &\"");
	}

	#[test]
	fn raw_text_elements_keep_their_content_verbatim() {
		assert_eq!(
			s("<script>if(a<b&&c>d){x=\"</div>\"}</script>"),
			"script(#\"if(a<b&&c>d){x=\\\"</div>\\\"}\")"
		);
		assert_eq!(s("<style>a>b{}&amp;</style>"), "style(#\"a>b{}&amp;\")");
		assert_eq!(
			s("<textarea>&lt;b&gt; &amp;</textarea>"),
			"textarea(#\"&lt;b&gt; &amp;\")"
		);
		assert_eq!(
			s("<title>a &amp; b &lt;c&gt;</title>"),
			"title(#\"a &amp; b &lt;c&gt;\")"
		);
		assert_eq!(s("<xmp><b>&amp;</xmp>"), "xmp(#\"<b>&amp;\")");
		assert_eq!(s("<script>unclosed <b>"), "script(#\"unclosed <b>\")");
		assert_eq!(s("<SCRIPT>x</SCRIPT >y"), "script(#\"x\"),#\"y\"");
		assert_eq!(s("<script><</script>a"), "script(#\"<\"),#\"a\"");
	}

	#[test]
	fn a_self_closed_special_tag_leaves_raw_mode_but_stays_open() {
		assert_eq!(s("<script/>x"), "script(#\"x\")");
		assert_eq!(s("<textarea/>x<b>y</b>"), "textarea(#\"x\",b(#\"y\"))");
	}

	#[test]
	fn comments_cdata_declarations_and_doctype() {
		assert_eq!(
			s("<!-- c --><!----><!-->x"),
			"<!\" c \">,<!\"\">,<!\"\">,#\"x\""
		);
		assert_eq!(s("<!-- unclosed"), "<!\" unclosed\">");
		assert_eq!(s("<![CDATA[x<y]]>"), "<!\"[CDATA[x<y]]\">");
		assert_eq!(s("<!ELEMENT a>y"), "#\"y\"");
		assert_eq!(s("<!doctype html>x"), "doctype(html),#\"x\"");
		assert_eq!(s("a<!DOCTYPE html>b"), "doctype(html),#\"ab\"");
		assert_eq!(s("</3 x>y"), "<!\"3 x\">,#\"y\"");
	}

	#[test]
	fn doctype_ids_follow_the_setter_regex() {
		let doc = parse(
			"<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0//EN\" \"http://www.w3.org/x.dtd\">",
		);
		let NodeKind::Doctype(d) = doc.kind(doc.first_child(ROOT).unwrap()) else {
			panic!("doctype");
		};
		assert_eq!(
			(d.name.as_str(), d.public_id.as_str(), d.system_id.as_str()),
			(
				"html",
				"-//W3C//DTD XHTML 1.0//EN",
				"http://www.w3.org/x.dtd"
			)
		);
		let doc = parse("<!DOCTYPE note SYSTEM \"note.dtd\">");
		let NodeKind::Doctype(d) = doc.kind(doc.first_child(ROOT).unwrap()) else {
			panic!("doctype");
		};
		assert_eq!(
			(d.name.as_str(), d.public_id.as_str(), d.system_id.as_str()),
			("note", "", "note.dtd")
		);
		// A declaration the regex does not match produces no doctype.
		assert_eq!(s("<!DOCTYPE>x"), "#\"x\"");
		assert_eq!(s("<!DOCTYPE 1>x"), "#\"x\"");
	}

	#[test]
	fn broken_and_unfinished_markup() {
		assert_eq!(s("<div class=\"a"), "");
		assert_eq!(s("<p>text<"), "p(#\"text<\")");
		assert_eq!(s("<>x</>y</ z>w"), "#\"<>x</>yw\"");
		assert_eq!(s("a < b"), "#\"a < b\"");
		assert_eq!(s("x <1> y"), "#\"x <1> y\"");
		assert_eq!(s("<a<b>c"), "a<b(#\"c\")");
		assert_eq!(s("<div></span>x</div>"), "div(#\"x\")");
	}

	#[test]
	fn processing_instructions_are_kept_verbatim() {
		assert_eq!(
			s("<?php echo $a->b; ?>text"),
			"pi(<?php echo $a->b; ?>),#\"text\""
		);
		assert_eq!(
			s("<div><?php if ($x): ?><p>a</p><?php endif; ?></div>"),
			"div(pi(<?php if ($x): ?>),p(#\"a\"),pi(<?php endif; ?>))"
		);
		assert_eq!(s("<?xml version=\"1.0\"?>"), "pi(<?xml version=\"1.0\"?>)");
		assert_eq!(s("<? no end >x"), "pi(<? no end >),#\"x\"");
		// Inside an attribute value it is just text.
		assert_eq!(
			s("<a class=\"<?php echo $c; ?>\">"),
			"a class=\"<?php echo $c; ?>\""
		);
	}

	#[test]
	fn foreign_content_case() {
		assert_eq!(
			s(
				"<svg viewBox=\"0 0 1 1\"><linearGradient id=a/><foreignObject><p>x</p></foreignObject></svg>"
			),
			"svg viewBox=\"0 0 1 1\"(lineargradient id=\"a/\"(foreignobject(p(#\"x\"))))"
		);
	}

	#[test]
	fn svg_elements_are_marked() {
		let doc = parse("<p><svg><path/></svg><b></b></p>");
		let p = doc.first_child(ROOT).unwrap();
		let svg = doc.first_child(p).unwrap();
		let path = doc.first_child(svg).unwrap();
		let b = doc.next_sibling(svg).unwrap();
		assert!(doc.element(svg).unwrap().svg);
		assert!(doc.element(path).unwrap().svg);
		assert!(!doc.element(b).unwrap().svg);
		assert!(!doc.element(p).unwrap().svg);
	}

	#[test]
	fn multibyte_text_and_attributes_survive() {
		assert_eq!(
			s("<p title=\"日本語\">こんにちは &amp; é</p>"),
			"p title=\"日本語\"(#\"こんにちは & é\")"
		);
	}

	#[test]
	fn class_normalization_uses_javascript_whitespace() {
		assert_eq!(normalize_class("a\u{A0}b\u{3000}c"), "a b c");
		assert_eq!(
			normalize_class("a\u{85}b"),
			"a\u{85}b",
			"U+0085 is not JS whitespace"
		);
	}
}
