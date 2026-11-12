//! The natural order of the plan (RFC §6) and of `kamado ui`'s sort (RFC §14.2): a port of
//! `numericalComparator` and `pathComparator` of `@d-zero/shared` (`src/sort/`), so that the
//! order of the screen is the one the team's other tools give.
//!
//! What is ported is what a kamado page can reach. A kamado URL has no host, query or hash of
//! its own (RFC §6), so the host and protocol steps of `pathComparator` compare equal for
//! every page and are left out; the path, the basename, the extension, the search, the hash and
//! the `href` are kept, with the parts of `new URL(path, 'file://')` they read. A value is
//! taken to start with a single `/` (a URL, or an input path written as `/dir/file`): what
//! `new URL` reads as a scheme (`http://`), a host (`//host`) or a drive letter (`/c:/`) is not
//! ported, because no kamado page has such a value.
//!
//! Strings compare as JavaScript does, by UTF-16 code unit (`a < b`), not by code point.
//!
//! The comparison is not a total order: it drops the common prefix of each *pair* before it
//! reads a number (`2a < 10b`, `10b < 1c`, `1c < 2a`), so a cycle can exist. [`sort_stable`] is
//! a merge sort of our own that ends, without a panic, whatever the comparison says; Rust's
//! `sort_by` is allowed to panic on a comparison that is not a total order, and a panic here
//! would take the native addon (and the process) down. The order of the items in a cycle is
//! settled (the same input and the same direction give the same output; a descending sort
//! reverses the comparison, it does not reverse the result) but is not promised to be the one
//! V8 gives.
//! The result of the comparison of two values is the same as `@d-zero/shared`'s: the golden of
//! `tests/natural_golden.tsv` checks that.

use std::cell::OnceCell;
use std::cmp::Ordering;

/// A string made ready for the comparisons: what `numericalComparator` reads of it is made
/// once, not for every pair.
pub struct Key {
	/// `toLowerCase()`.
	lower: String,
	/// `decodeURISafely(toLowerCase())`, the text `alphabeticalComparator` compares.
	decoded: String,
	/// `.length` of the original in UTF-16 code units: how many steps `removeMatches` takes.
	units: usize,
}

impl Key {
	pub fn new(text: &str) -> Key {
		let lower = text.to_lowercase();
		let decoded = decode_uri(&lower).unwrap_or_else(|| lower.clone());
		Key {
			lower,
			decoded,
			units: text.encode_utf16().count(),
		}
	}
}

fn utf16_cmp(a: &str, b: &str) -> Ordering {
	a.encode_utf16().cmp(b.encode_utf16())
}

/// `alphabeticalComparator`.
pub fn alphabetical(a: &Key, b: &Key) -> Ordering {
	utf16_cmp(&a.decoded, &b.decoded)
}

/// `decodeURI`, or `None` where it throws.
fn decode_uri(s: &str) -> Option<String> {
	if !s.contains('%') {
		return Some(s.to_owned());
	}
	let b = s.as_bytes();
	let hex = |i: usize| -> Option<u8> {
		let h = *b.get(i + 1)?;
		let l = *b.get(i + 2)?;
		let d = |c: u8| (c as char).to_digit(16).map(|v| v as u8);
		Some(d(h)? * 16 + d(l)?)
	};
	let mut out: Vec<u8> = Vec::with_capacity(b.len());
	let mut i = 0;
	while i < b.len() {
		if b[i] != b'%' {
			out.push(b[i]);
			i += 1;
			continue;
		}
		let first = hex(i)?;
		if first < 0x80 {
			// The reserved characters stay as they were written.
			if b";/?:@&=+$,#".contains(&first) {
				out.extend_from_slice(&b[i..i + 3]);
			} else {
				out.push(first);
			}
			i += 3;
			continue;
		}
		let n = match first {
			0xC0..=0xDF => 2,
			0xE0..=0xEF => 3,
			0xF0..=0xF7 => 4,
			_ => return None,
		};
		let mut seq = vec![first];
		for k in 1..n {
			let at = i + 3 * k;
			if b.get(at) != Some(&b'%') {
				return None;
			}
			let next = hex(at)?;
			if next & 0xC0 != 0x80 {
				return None;
			}
			seq.push(next);
		}
		out.extend_from_slice(std::str::from_utf8(&seq).ok()?.as_bytes());
		i += 3 * n;
	}
	String::from_utf8(out).ok()
}

/// `Number.parseFloat(text)` when the result is finite.
fn parse_float(text: &str) -> Option<f64> {
	let t = text.trim_start_matches(|c: char| {
		matches!(
			c,
			'\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
				..='\u{200A}'
					| '\u{2028}' | '\u{2029}'
					| '\u{202F}' | '\u{205F}'
					| '\u{3000}' | '\u{FEFF}'
		)
	});
	let b = t.as_bytes();
	let mut i = 0;
	if matches!(b.first(), Some(b'+' | b'-')) {
		i = 1;
	}
	let digits = |from: usize| b[from..].iter().take_while(|c| c.is_ascii_digit()).count();
	let int = digits(i);
	let mut end = i + int;
	let mut seen = int > 0;
	if b.get(end) == Some(&b'.') {
		let frac = digits(end + 1);
		if int > 0 || frac > 0 {
			end += 1 + frac;
			seen = true;
		}
	}
	if !seen {
		// `Infinity` and anything that is not a number are not finite.
		return None;
	}
	if matches!(b.get(end), Some(b'e' | b'E')) {
		let mut at = end + 1;
		if matches!(b.get(at), Some(b'+' | b'-')) {
			at += 1;
		}
		let exp = digits(at);
		if exp > 0 {
			end = at + exp;
		}
	}
	let n: f64 = t[..end].parse().ok()?;
	n.is_finite().then_some(n)
}

/// `removeMatches` on two keys: what is left after the common prefix (in code points, for as
/// many steps as the longer original has UTF-16 units).
fn remove_matches<'a>(a: &'a Key, b: &'a Key) -> (&'a str, &'a str) {
	let mut i1 = a.lower.char_indices();
	let mut i2 = b.lower.char_indices();
	for _ in 0..a.units.max(b.units) {
		let c1 = i1.clone().next();
		let c2 = i2.clone().next();
		match (c1, c2) {
			(None, None) => break,
			(Some((_, x)), Some((_, y))) if x == y => {
				i1.next();
				i2.next();
			}
			_ => {
				let o1 = c1.map_or(a.lower.len(), |(o, _)| o);
				let o2 = c2.map_or(b.lower.len(), |(o, _)| o);
				return (&a.lower[o1..], &b.lower[o2..]);
			}
		}
	}
	("", "")
}

/// `numericalComparator` for two strings that are there.
pub fn numerical(a: &Key, b: &Key) -> Ordering {
	let (m1, m2) = remove_matches(a, b);
	if let (Some(n1), Some(n2)) = (parse_float(m1), parse_float(m2)) {
		// Finite numbers always compare; `-0` and `0` are equal.
		return n1.partial_cmp(&n2).unwrap_or(Ordering::Equal);
	}
	alphabetical(a, b)
}

/// `numericalComparator` on two plain strings (for the tests and the golden).
#[cfg(test)]
fn numerical_str(a: &str, b: &str) -> Ordering {
	numerical(&Key::new(a), &Key::new(b))
}

/// One path segment of a [`Path`].
struct Segment {
	raw: String,
	/// `Key` of the lower-cased segment, which is what `dirComparator` hands to the numerical one.
	key: Key,
	starts_with_index: bool,
}

/// A URL (or an input path written like one) made ready for `pathComparator`.
pub struct Path {
	original: String,
	/// `Key` of `original` and of `href`, made the first time a comparison needs it (only pages
	/// that tie on every step before reach them).
	original_key: OnceCell<Key>,
	href_key: OnceCell<Key>,
	href: String,
	segments: Vec<Segment>,
	basename: String,
	basename_key: Key,
	is_index: bool,
	ext: Key,
	search: Key,
	hash: Key,
}

/// Percent-encodes what the URL parser would for the part of the URL: `extra` is the part's own
/// set besides the C0 controls, space, `"`, `<`, `>` and what is not ASCII.
fn encode_part(s: &str, extra: &[u8]) -> String {
	let mut out = String::with_capacity(s.len());
	for &c in s.as_bytes() {
		if c <= 0x20 || c >= 0x7F || matches!(c, b'"' | b'<' | b'>') || extra.contains(&c) {
			out.push_str(&format!("%{c:02X}"));
		} else {
			out.push(c as char);
		}
	}
	out
}

/// Whether the segment is a `.` or `..` of the URL parser (a `%2e` is a dot too), and which.
fn dot_segment(s: &str) -> Option<bool> {
	match s.to_ascii_lowercase().as_str() {
		"." | "%2e" => Some(false),
		".." | ".%2e" | "%2e." | "%2e%2e" => Some(true),
		_ => None,
	}
}

/// `path.extname` of Node (POSIX).
fn extname(s: &str) -> &str {
	let b = s.as_bytes();
	if b.is_empty() {
		return "";
	}
	let end = b.len();
	let mut start_dot: Option<usize> = None;
	let mut pre_dot_state = 0i8;
	for (i, &c) in b.iter().enumerate().rev() {
		if c == b'.' {
			if start_dot.is_none() {
				start_dot = Some(i);
			} else if pre_dot_state != 1 {
				pre_dot_state = 1;
			}
		} else if start_dot.is_some() {
			pre_dot_state = -1;
		}
	}
	match start_dot {
		None => "",
		Some(d) if pre_dot_state == 0 || (pre_dot_state == 1 && d == end - 1 && d == 1) => "",
		Some(d) => &s[d..end],
	}
}

impl Path {
	/// What `toURLParts` makes of `text`, read as `new URL(text, 'file://')` reads it.
	pub fn new(text: &str) -> Path {
		// The special-scheme parser reads `\` as `/`.
		let cleaned: String = text
			.chars()
			.filter(|c| !matches!(c, '\t' | '\n' | '\r'))
			.collect();
		let text_slashes = cleaned.trim_matches(|c: char| c <= ' ').replace('\\', "/");
		let (rest, hash) = match text_slashes.split_once('#') {
			Some((r, h)) => (r.to_owned(), Some(h.to_owned())),
			None => (text_slashes.clone(), None),
		};
		let (path_in, search) = match rest.split_once('?') {
			Some((p, q)) => (p.to_owned(), Some(q.to_owned())),
			None => (rest.clone(), None),
		};
		let mut parts: Vec<String> = Vec::new();
		let absolute = path_in.strip_prefix('/').unwrap_or(&path_in);
		let pieces: Vec<&str> = absolute.split('/').collect();
		for (n, piece) in pieces.iter().enumerate() {
			let last = n + 1 == pieces.len();
			match dot_segment(piece) {
				Some(up) => {
					if up {
						parts.pop();
					}
					if last {
						parts.push(String::new());
					}
				}
				None => parts.push(encode_part(piece, b"`{}^")),
			}
		}
		let pathname = format!("/{}", parts.join("/"));
		// `URL.search` and `URL.hash` are empty for a `?` or a `#` with nothing after it, while
		// the `href` keeps the mark: the two are told apart as `new URL` tells them.
		let search_text = search.as_deref().map(|s| encode_part(s, b"#'"));
		let hash_text = hash.as_deref().map(|h| encode_part(h, b"`"));
		let href = format!(
			"file://{pathname}{}{}",
			search_text
				.as_deref()
				.map_or(String::new(), |s| format!("?{s}")),
			hash_text
				.as_deref()
				.map_or(String::new(), |h| format!("#{h}")),
		);
		let search = match search_text.as_deref() {
			None | Some("") => String::new(),
			Some(s) => format!("?{s}"),
		};
		let hash = match hash_text.as_deref() {
			None | Some("") => String::new(),
			Some(h) => format!("#{h}"),
		};
		let raw_segments: Vec<&str> = pathname.split('/').collect();
		let basename = raw_segments.last().copied().unwrap_or("").to_owned();
		let is_index = basename.to_lowercase() == "index" || basename.is_empty();
		let ext = extname(&basename).to_owned();
		let segments = raw_segments
			.iter()
			.map(|s| {
				let lower = s.to_lowercase();
				Segment {
					raw: (*s).to_owned(),
					starts_with_index: lower.starts_with("index") || lower.is_empty(),
					key: Key::new(&lower),
				}
			})
			.collect();
		Path {
			original: text.to_owned(),
			original_key: OnceCell::new(),
			href_key: OnceCell::new(),
			href,
			segments,
			basename_key: Key::new(&basename),
			basename,
			is_index,
			ext: Key::new(&ext),
			search: Key::new(&search),
			hash: Key::new(&hash),
		}
	}
}

/// `dirComparator`.
fn dir(a: &[Segment], b: &[Segment]) -> Ordering {
	let mut i = 0;
	loop {
		let s1 = a.get(i);
		let s2 = b.get(i);
		let is_dir1 = a.get(i + 1).is_some();
		let is_dir2 = b.get(i + 1).is_some();
		i += 1;
		let (s1, s2) = match (s1, s2) {
			(None, None) => return Ordering::Equal,
			(None, Some(_)) => return Ordering::Less,
			(Some(_), None) => return Ordering::Greater,
			(Some(x), Some(y)) => (x, y),
		};
		if s1.raw == s2.raw {
			continue;
		}
		if s1.raw.is_empty() {
			return Ordering::Less;
		}
		if s2.raw.is_empty() {
			return Ordering::Greater;
		}
		if !is_dir1 && !is_dir2 && s1.starts_with_index && s2.starts_with_index {
			return Ordering::Equal;
		}
		if !is_dir1 && s1.starts_with_index {
			return Ordering::Less;
		}
		if !is_dir2 && s2.starts_with_index {
			return Ordering::Greater;
		}
		let r = numerical(&s1.key, &s2.key);
		if r != Ordering::Equal {
			return r;
		}
	}
}

/// `pathComparator` (the steps a kamado URL can reach).
pub fn path(a: &Path, b: &Path) -> Ordering {
	if a.href == b.href {
		// The same page written twice (the `href` is the same); the keys are made here, once.
		return alphabetical(
			a.original_key.get_or_init(|| Key::new(&a.original)),
			b.original_key.get_or_init(|| Key::new(&b.original)),
		);
	}
	let r = dir(&a.segments, &b.segments);
	if r != Ordering::Equal {
		return r;
	}
	if a.basename != b.basename {
		if a.is_index {
			return Ordering::Less;
		}
		if b.is_index {
			return Ordering::Greater;
		}
		let r = numerical(&a.basename_key, &b.basename_key);
		if r != Ordering::Equal {
			return r;
		}
	}
	for (x, y) in [(&a.ext, &b.ext), (&a.search, &b.search), (&a.hash, &b.hash)] {
		let r = numerical(x, y);
		if r != Ordering::Equal {
			return r;
		}
	}
	numerical(
		a.href_key.get_or_init(|| Key::new(&a.href)),
		b.href_key.get_or_init(|| Key::new(&b.href)),
	)
}

/// `pathComparator` on two plain strings (for the tests and the golden).
#[cfg(test)]
fn path_str(a: &str, b: &str) -> Ordering {
	path(&Path::new(a), &Path::new(b))
}

/// Sorts `items` stably with `cmp`, and ends whatever `cmp` says: a merge sort that never
/// asks for a total order (see the module's comment). Equal items keep their order.
pub fn sort_stable<T: Clone>(items: &mut [T], mut cmp: impl FnMut(&T, &T) -> Ordering) {
	let n = items.len();
	if n < 2 {
		return;
	}
	let mut from: Vec<T> = items.to_vec();
	let mut to: Vec<T> = items.to_vec();
	let mut width = 1;
	while width < n {
		let mut start = 0;
		while start < n {
			let mid = (start + width).min(n);
			let end = (start + 2 * width).min(n);
			let (mut l, mut r, mut k) = (start, mid, start);
			while l < mid && r < end {
				// The right item goes first only when it is strictly smaller: stable.
				if cmp(&from[r], &from[l]) == Ordering::Less {
					to[k] = from[r].clone();
					r += 1;
				} else {
					to[k] = from[l].clone();
					l += 1;
				}
				k += 1;
			}
			while l < mid {
				to[k] = from[l].clone();
				l += 1;
				k += 1;
			}
			while r < end {
				to[k] = from[r].clone();
				r += 1;
				k += 1;
			}
			start = end;
		}
		std::mem::swap(&mut from, &mut to);
		width *= 2;
	}
	items.clone_from_slice(&from);
}

#[cfg(test)]
mod tests {
	use super::*;
	use Ordering::{Equal, Greater, Less};

	#[test]
	fn numbers_compare_as_numbers_after_the_common_prefix() {
		assert_eq!(numerical_str("page2", "page10"), Less);
		assert_eq!(numerical_str("page10", "page2"), Greater);
		assert_eq!(numerical_str("a", "a"), Equal);
		// The common prefix `1.` goes first: `5` and `25`.
		assert_eq!(numerical_str("1.5", "1.25"), Less);
		assert_eq!(numerical_str("1.25", "1.5"), Greater);
		// Not numbers after the prefix: the letters decide.
		assert_eq!(numerical_str("apple", "banana"), Less);
	}

	#[test]
	fn the_comparison_has_a_cycle_and_the_sort_still_ends() {
		assert_eq!(numerical_str("2a", "10b"), Less);
		assert_eq!(numerical_str("10b", "1c"), Less);
		assert_eq!(numerical_str("1c", "2a"), Less);
		// Many items with the cycle in them: it ends, keeps every item, and gives the same
		// answer when asked again.
		let items: Vec<(usize, &str)> = (0..60)
			.map(|n| (n, ["2a", "10b", "1c", "3d", "2a"][n % 5]))
			.collect();
		let run = || {
			let mut v = items.clone();
			sort_stable(&mut v, |a, b| numerical_str(a.1, b.1));
			v
		};
		let first = run();
		assert_eq!(first, run());
		let mut tags: Vec<usize> = first.iter().map(|(n, _)| *n).collect();
		tags.sort_unstable();
		assert_eq!(tags, (0..60).collect::<Vec<usize>>());
	}

	#[test]
	fn the_sort_orders_what_has_an_order() {
		let mut v = vec!["p10", "p2", "p1", "p30", "p3", "p2"];
		sort_stable(&mut v, |a, b| numerical_str(a, b));
		assert_eq!(v, ["p1", "p2", "p2", "p3", "p10", "p30"]);
	}

	#[test]
	fn strings_compare_by_utf16_unit() {
		// U+FF5E (a BMP character) is above the surrogates D83D of U+1F600 in code points
		// order, and below them in UTF-16 order.
		assert_eq!(utf16_cmp("\u{FF5E}", "\u{1F600}"), Greater);
		assert_eq!("\u{FF5E}".cmp("\u{1F600}"), Less);
	}

	#[test]
	fn decode_uri_keeps_the_reserved_and_gives_up_on_bad_input() {
		assert_eq!(decode_uri("a%20b").as_deref(), Some("a b"));
		assert_eq!(decode_uri("a%2Fb").as_deref(), Some("a%2Fb"));
		assert_eq!(decode_uri("%E3%81%82").as_deref(), Some("\u{3042}"));
		assert_eq!(decode_uri("%E3%81"), None);
		assert_eq!(decode_uri("%zz"), None);
		assert_eq!(decode_uri("%C0%80"), None);
	}

	#[test]
	fn parse_float_reads_the_prefix() {
		assert_eq!(parse_float("12abc"), Some(12.0));
		assert_eq!(parse_float("  -3.5e2x"), Some(-350.0));
		assert_eq!(parse_float(".5"), Some(0.5));
		assert_eq!(parse_float("5."), Some(5.0));
		assert_eq!(parse_float("1e"), Some(1.0));
		assert_eq!(parse_float("abc"), None);
		assert_eq!(parse_float("Infinity"), None);
		assert_eq!(parse_float("1e999"), None);
		assert_eq!(parse_float(""), None);
	}

	#[test]
	fn the_index_of_a_directory_comes_first() {
		assert_eq!(path_str("/a/", "/a/b.html"), Less);
		assert_eq!(path_str("/a/index.html", "/a/b.html"), Less);
		assert_eq!(path_str("/a/b.html", "/a/index.html"), Greater);
		assert_eq!(path_str("/a/2/", "/a/10/"), Less);
		assert_eq!(path_str("/a/b.html", "/a/b.html"), Equal);
	}

	#[test]
	fn extname_is_nodes() {
		assert_eq!(extname("a.html"), ".html");
		assert_eq!(extname("a.b.c"), ".c");
		assert_eq!(extname(".bashrc"), "");
		assert_eq!(extname("a."), ".");
		assert_eq!(extname(".."), "");
		assert_eq!(extname("a"), "");
	}

	#[test]
	fn sort_is_stable_and_total_on_a_total_order() {
		let mut v: Vec<(u8, usize)> = vec![(2, 0), (1, 1), (2, 2), (1, 3), (0, 4)];
		sort_stable(&mut v, |a, b| a.0.cmp(&b.0));
		assert_eq!(v, vec![(0, 4), (1, 1), (1, 3), (2, 0), (2, 2)]);
	}

	/// `tests/natural_golden.tsv`: a line `kind<TAB>a<TAB>b<TAB>result` per pair, made by
	/// `scripts/generate-natural-golden.mjs` from `@d-zero/shared`.
	#[test]
	fn pairs_compare_as_the_shared_package_does() {
		let text = include_str!("../tests/natural_golden.tsv");
		let mut checked = 0;
		for line in text.lines() {
			let f: Vec<&str> = line.split('\t').collect();
			assert_eq!(
				f.len(),
				4,
				"a line is `kind<TAB>a<TAB>b<TAB>result`: {line:?}"
			);
			let (a, b) = (unescape(f[1]), unescape(f[2]));
			let want = match f[3] {
				"-1" => Less,
				"0" => Equal,
				"1" => Greater,
				other => panic!("a result is -1, 0 or 1: {other:?}"),
			};
			let got = match f[0] {
				"path" => path_str(&a, &b),
				"num" => numerical_str(&a, &b),
				other => panic!("a kind is path or num: {other:?}"),
			};
			assert_eq!(got, want, "{} of {a:?} and {b:?}", f[0]);
			checked += 1;
		}
		assert!(checked > 1000, "the golden has only {checked} pairs");
	}

	/// The golden writes `\\`, `\t` and `\n` escaped.
	fn unescape(s: &str) -> String {
		let mut out = String::new();
		let mut it = s.chars();
		while let Some(c) = it.next() {
			if c != '\\' {
				out.push(c);
				continue;
			}
			match it.next() {
				Some('t') => out.push('\t'),
				Some('n') => out.push('\n'),
				Some(o) => out.push(o),
				None => out.push('\\'),
			}
		}
		out
	}
}
