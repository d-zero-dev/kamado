//! Source maps (revision 3) for generated text, and their inline form.
//!
//! A map is a list of points: "this offset of the generated text came from
//! that offset of that source". Offsets are bytes; the map stores lines and
//! columns (columns in UTF-16 code units, as the format says).

use kd_jsonc::Value;

/// A source file as the map names it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Source {
	/// How the map spells the file: a path relative to the generated file.
	pub path: String,
	pub text: String,
}

/// One mapping.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Point {
	/// Byte offset in the generated text.
	pub generated: usize,
	/// Index into the sources.
	pub source: usize,
	/// Byte offset in that source.
	pub offset: usize,
}

const BASE64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding.
///
/// # Example
///
/// ```
/// assert_eq!(kd_core::sourcemap::base64(b"Man"), "TWFu");
/// assert_eq!(kd_core::sourcemap::base64(b"Ma"), "TWE=");
/// ```
#[must_use]
pub fn base64(bytes: &[u8]) -> String {
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for chunk in bytes.chunks(3) {
		let n = (u32::from(chunk[0]) << 16)
			| (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
			| u32::from(*chunk.get(2).unwrap_or(&0));
		out.push(BASE64[(n >> 18) as usize & 63] as char);
		out.push(BASE64[(n >> 12) as usize & 63] as char);
		out.push(if chunk.len() > 1 {
			BASE64[(n >> 6) as usize & 63] as char
		} else {
			'='
		});
		out.push(if chunk.len() > 2 {
			BASE64[n as usize & 63] as char
		} else {
			'='
		});
	}
	out
}

/// Appends the base64 variable-length quantity of `value`.
fn vlq(out: &mut String, value: i64) {
	let mut v = if value < 0 {
		((-value) << 1) | 1
	} else {
		value << 1
	};
	loop {
		let mut digit = (v & 31) as usize;
		v >>= 5;
		if v > 0 {
			digit |= 32;
		}
		out.push(BASE64[digit] as char);
		if v == 0 {
			break;
		}
	}
}

/// Byte offsets at which each line of `text` starts.
fn line_starts(text: &str) -> Vec<usize> {
	std::iter::once(0)
		.chain(text.match_indices('\n').map(|(i, _)| i + 1))
		.collect()
}

/// Zero-based line and UTF-16 column of a byte offset.
fn position(text: &str, starts: &[usize], offset: usize) -> (usize, usize) {
	let offset = offset.min(text.len());
	let line = starts.partition_point(|&s| s <= offset) - 1;
	let mut start = starts[line];
	// `offset` may fall inside a character the caller cut: back up to one.
	let mut end = offset;
	while !text.is_char_boundary(end) {
		end -= 1;
	}
	while !text.is_char_boundary(start) {
		start += 1;
	}
	(line, text[start..end].encode_utf16().count())
}

/// The map as JSON. `points` must be in the order of the generated text.
///
/// # Example
///
/// ```
/// use kd_core::sourcemap::{build, Point, Source};
///
/// let json = build(
///     "main.css",
///     "a{}",
///     &[Source { path: "../a.css".to_owned(), text: "a {}".to_owned() }],
///     &[Point { generated: 0, source: 0, offset: 0 }],
/// );
/// assert_eq!(
///     json,
///     r#"{"version":3,"file":"main.css","sources":["../a.css"],"sourcesContent":["a {}"],"names":[],"mappings":"AAAA"}"#
/// );
/// ```
#[must_use]
pub fn build(file: &str, generated: &str, sources: &[Source], points: &[Point]) -> String {
	let generated_starts = line_starts(generated);
	let source_starts: Vec<Vec<usize>> = sources.iter().map(|s| line_starts(&s.text)).collect();
	let mut mappings = String::new();
	let (mut line, mut prev_col) = (0usize, 0i64);
	let (mut prev_source, mut prev_line, mut prev_src_col) = (0i64, 0i64, 0i64);
	let mut first_in_line = true;
	for p in points {
		let (gen_line, gen_col) = position(generated, &generated_starts, p.generated);
		while line < gen_line {
			mappings.push(';');
			line += 1;
			prev_col = 0;
			first_in_line = true;
		}
		let source = &sources[p.source];
		let (src_line, src_col) = position(&source.text, &source_starts[p.source], p.offset);
		if !first_in_line {
			mappings.push(',');
		}
		first_in_line = false;
		vlq(&mut mappings, gen_col as i64 - prev_col);
		vlq(&mut mappings, p.source as i64 - prev_source);
		vlq(&mut mappings, src_line as i64 - prev_line);
		vlq(&mut mappings, src_col as i64 - prev_src_col);
		prev_col = gen_col as i64;
		prev_source = p.source as i64;
		prev_line = src_line as i64;
		prev_src_col = src_col as i64;
	}
	let strings = |items: Vec<&str>| {
		Value::Array(
			items
				.into_iter()
				.map(|s| Value::String(s.to_owned()))
				.collect(),
		)
	};
	Value::Object(vec![
		("version".to_owned(), Value::Number(3.0)),
		("file".to_owned(), Value::String(file.to_owned())),
		(
			"sources".to_owned(),
			strings(sources.iter().map(|s| s.path.as_str()).collect()),
		),
		(
			"sourcesContent".to_owned(),
			strings(sources.iter().map(|s| s.text.as_str()).collect()),
		),
		("names".to_owned(), Value::Array(Vec::new())),
		("mappings".to_owned(), Value::String(mappings)),
	])
	.to_json()
}

/// The comment that carries a map inside a stylesheet.
///
/// # Example
///
/// ```
/// assert_eq!(
///     kd_core::sourcemap::inline_css_comment("{}"),
///     "/*# sourceMappingURL=data:application/json;base64,e30= */"
/// );
/// ```
#[must_use]
pub fn inline_css_comment(map_json: &str) -> String {
	format!(
		"/*# sourceMappingURL=data:application/json;base64,{} */",
		base64(map_json.as_bytes())
	)
}

/// Reads the mappings of a map built here back into `(generated line,
/// generated column, source index, source line, source column)`, all zero
/// based. For tests of what is built on top of this module.
#[cfg(test)]
pub(crate) fn decode(map_json: &str) -> Vec<(usize, usize, usize, usize, usize)> {
	let value = kd_jsonc::parse(map_json).unwrap();
	let mappings = value.get("mappings").and_then(|m| m.as_str()).unwrap();
	let digit = |c: char| BASE64.iter().position(|&b| b as char == c).unwrap() as i64;
	let mut out = Vec::new();
	let (mut source, mut src_line, mut src_col) = (0i64, 0i64, 0i64);
	for (line, text) in mappings.split(';').enumerate() {
		let mut col = 0i64;
		for segment in text.split(',').filter(|s| !s.is_empty()) {
			let mut numbers = Vec::new();
			let (mut value, mut shift) = (0i64, 0);
			for c in segment.chars() {
				let d = digit(c);
				value |= (d & 31) << shift;
				if d & 32 == 0 {
					numbers.push(if value & 1 == 1 {
						-(value >> 1)
					} else {
						value >> 1
					});
					(value, shift) = (0, 0);
				} else {
					shift += 5;
				}
			}
			col += numbers[0];
			source += numbers[1];
			src_line += numbers[2];
			src_col += numbers[3];
			out.push((
				line,
				col as usize,
				source as usize,
				src_line as usize,
				src_col as usize,
			));
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	fn src(path: &str, text: &str) -> Source {
		Source {
			path: path.to_owned(),
			text: text.to_owned(),
		}
	}

	#[test]
	fn base64_pads_like_the_standard() {
		assert_eq!(base64(b""), "");
		assert_eq!(base64(b"f"), "Zg==");
		assert_eq!(base64(b"fo"), "Zm8=");
		assert_eq!(base64(b"foobar"), "Zm9vYmFy");
	}

	#[test]
	fn vlq_encodes_signed_numbers() {
		let enc = |n| {
			let mut s = String::new();
			vlq(&mut s, n);
			s
		};
		assert_eq!(enc(0), "A");
		assert_eq!(enc(1), "C");
		assert_eq!(enc(-1), "D");
		assert_eq!(enc(15), "e");
		assert_eq!(enc(16), "gB");
		assert_eq!(enc(-16), "hB");
		assert_eq!(enc(1000), "w+B");
	}

	#[test]
	fn points_become_deltas_per_line_and_lines_are_separated() {
		// Generated: line 0 = `a{b:c}`, line 1 = `d{}`.
		let sources = [src("a.css", "a {\n  b: c\n}\n"), src("d.css", "d {}")];
		let points = [
			Point {
				generated: 0,
				source: 0,
				offset: 0,
			},
			Point {
				generated: 2,
				source: 0,
				offset: 6,
			},
			Point {
				generated: 7,
				source: 1,
				offset: 0,
			},
		];
		let json = build("o.css", "a{b:c}\nd{}", &sources, &points);
		let value = kd_jsonc::parse(&json).unwrap();
		// (0,0)->(0,0): AAAA; (0,2)->(1,2): "EACE" (col +2, src +0, line +1, col +2);
		// next line: column 0, source +1, line -1, column -2 => ACDF
		assert_eq!(
			value.get("mappings").and_then(|m| m.as_str()),
			Some("AAAA,EACE;ACDF")
		);
	}

	#[test]
	fn columns_count_utf16_units() {
		let sources = [src("a.css", "/* あ😀 */ a {}")];
		let offset = "/* あ😀 */ ".len();
		let json = build(
			"o.css",
			"a{}",
			&sources,
			&[Point {
				generated: 0,
				source: 0,
				offset,
			}],
		);
		// "/* " 3 + あ 1 + 😀 2 (a surrogate pair) + " */ " 4 = 10 -> `U` (10 << 1 = 20 -> 'U').
		assert!(json.contains(r#""mappings":"AAAU""#), "{json}");
	}

	#[test]
	fn the_comment_holds_the_map_in_base64() {
		assert_eq!(
			inline_css_comment(r#"{"version":3}"#),
			"/*# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ== */"
		);
	}
}
