//! What reading the source files of the pages gave last time, kept so that
//! an incremental build need not read them again.
//!
//! Planning a site means reading every page, hashing it and extracting its
//! metadata (a TSX page is parsed for `export const meta`). When nothing
//! changed that is all wasted: for each page the cache remembers the
//! fingerprints of the file and its sidecar, and the metadata found in them.
//! A file whose size and modification time are as recorded is taken to be
//! what it was (the same rule the manifest uses), so it costs two `stat`s
//! instead of a read, a hash and a parse. A page whose body is needed anyway
//! (it has to be built) is read again then.
//!
//! The file is binary and every string is written once; see
//! `kd_build::binary` for the encoding helpers. A file that does not decode,
//! or that was written by another version, is ignored.

use std::collections::HashMap;

use kd_build::Dep;
use kd_build::binary::{Reader, put, put_dep};
use kd_jsonc::Value;
use kd_site::meta::Meta;

use crate::PageKind;

const MAGIC: &[u8; 3] = b"KDP";
const FILE_NAME: &str = "plan-cache.bin";

/// What was read from one page.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CachedPage {
	pub kind: PageKind,
	pub in_file: Meta,
	pub input_dep: Dep,
	pub side: Meta,
	pub sidecar: String,
	pub sidecar_dep: Dep,
}

/// The cache: pages by input path.
#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct PlanCache {
	pub pages: HashMap<String, CachedPage>,
}

/// Where the cache lives inside a cache directory.
pub(crate) fn path(cache_dir: &str) -> String {
	format!("{}/{FILE_NAME}", cache_dir.trim_end_matches('/'))
}

#[derive(Default)]
struct Strings<'a> {
	ids: HashMap<&'a str, u64>,
	order: Vec<&'a str>,
}

impl<'a> Strings<'a> {
	fn id(&mut self, s: &'a str) -> u64 {
		if let Some(&id) = self.ids.get(s) {
			return id;
		}
		let id = self.order.len() as u64;
		self.ids.insert(s, id);
		self.order.push(s);
		id
	}
}

/// Interns every string of a value (keys and string values), so that the
/// strings table can be written before the pages that refer to it.
fn collect<'a>(strings: &mut Strings<'a>, value: &'a Value) {
	match value {
		Value::String(s) => {
			strings.id(s);
		}
		Value::Array(items) => items.iter().for_each(|v| collect(strings, v)),
		Value::Object(members) => {
			for (k, v) in members {
				strings.id(k);
				collect(strings, v);
			}
		}
		Value::Null | Value::Bool(_) | Value::Number(_) => {}
	}
}

/// How deep a value may nest: what `decode` reads, so that `encode` never writes
/// a cache that every later build would throw away.
const MAX_DEPTH: usize = 64;

/// Bumped when what the cache holds or means changes without the version of
/// the crate changing (metadata extraction, the fields kept).
const FORMAT: u32 = 1;

/// What identifies the writer: a cache from another version or format is
/// ignored.
fn stamp() -> String {
	format!("{}/{FORMAT}", crate::VERSION)
}

fn too_deep(value: &Value, depth: usize) -> bool {
	if depth > MAX_DEPTH {
		return true;
	}
	match value {
		Value::Array(items) => items.iter().any(|v| too_deep(v, depth + 1)),
		Value::Object(members) => members.iter().any(|(_, v)| too_deep(v, depth + 1)),
		_ => false,
	}
}

fn put_value(out: &mut Vec<u8>, strings: &Strings<'_>, value: &Value) {
	match value {
		Value::Null => out.push(0),
		Value::Bool(false) => out.push(1),
		Value::Bool(true) => out.push(2),
		Value::Number(n) => {
			out.push(3);
			out.extend_from_slice(&n.to_le_bytes());
		}
		Value::String(s) => {
			out.push(4);
			put(out, strings.ids[s.as_str()]);
		}
		Value::Array(items) => {
			out.push(5);
			put(out, items.len() as u64);
			for v in items {
				put_value(out, strings, v);
			}
		}
		Value::Object(members) => {
			out.push(6);
			put(out, members.len() as u64);
			for (k, v) in members {
				put(out, strings.ids[k.as_str()]);
				put_value(out, strings, v);
			}
		}
	}
}

fn put_meta(out: &mut Vec<u8>, strings: &Strings<'_>, meta: &Meta) {
	put(out, meta.len() as u64);
	for (k, v) in meta {
		put(out, strings.ids[k.as_str()]);
		put_value(out, strings, v);
	}
}

/// The bytes of a cache, or `None` for a fingerprint that is not a hash.
#[must_use]
pub(crate) fn encode(cache: &PlanCache) -> Option<Vec<u8>> {
	// Sorted: the same cache always gives the same bytes.
	let mut pages: Vec<(&String, &CachedPage)> = cache.pages.iter().collect();
	pages.sort_by(|a, b| a.0.cmp(b.0));
	let mut strings = Strings::default();
	for (path, page) in &pages {
		if page
			.in_file
			.iter()
			.chain(&page.side)
			.any(|(_, v)| too_deep(v, 0))
		{
			return None;
		}
		strings.id(path);
		strings.id(&page.sidecar);
		for (k, v) in page.in_file.iter().chain(&page.side) {
			strings.id(k);
			collect(&mut strings, v);
		}
	}
	let mut out = Vec::with_capacity(1 << 16);
	out.extend_from_slice(MAGIC);
	let version = stamp();
	put(&mut out, version.len() as u64);
	out.extend_from_slice(version.as_bytes());
	put(&mut out, strings.order.len() as u64);
	for s in &strings.order {
		put(&mut out, s.len() as u64);
		out.extend_from_slice(s.as_bytes());
	}
	put(&mut out, pages.len() as u64);
	for (path, page) in &pages {
		put(&mut out, strings.ids[path.as_str()]);
		out.push(match page.kind {
			PageKind::Html => 0,
			PageKind::Tsx => 1,
		});
		put_dep(&mut out, &page.input_dep)?;
		put(&mut out, strings.ids[page.sidecar.as_str()]);
		put_dep(&mut out, &page.sidecar_dep)?;
		put_meta(&mut out, &strings, &page.in_file);
		put_meta(&mut out, &strings, &page.side);
	}
	let digest = kd_hash::sha256(&out);
	out.extend_from_slice(&digest);
	Some(out)
}

fn read_value(r: &mut Reader<'_>, strings: &[&str], depth: usize) -> Option<Value> {
	if depth > MAX_DEPTH {
		return None;
	}
	let string = |id: u64| {
		strings
			.get(usize::try_from(id).ok()?)
			.map(|s| (*s).to_owned())
	};
	Some(match r.take(1)?[0] {
		0 => Value::Null,
		1 => Value::Bool(false),
		2 => Value::Bool(true),
		3 => Value::Number(f64::from_le_bytes(r.take(8)?.try_into().ok()?)),
		4 => Value::String(string(r.varint()?)?),
		5 => {
			let n = r.count()?;
			let mut items = Vec::with_capacity(n);
			for _ in 0..n {
				items.push(read_value(r, strings, depth + 1)?);
			}
			Value::Array(items)
		}
		6 => {
			let n = r.count()?;
			let mut members = Vec::with_capacity(n);
			for _ in 0..n {
				let key = string(r.varint()?)?;
				members.push((key, read_value(r, strings, depth + 1)?));
			}
			Value::Object(members)
		}
		_ => return None,
	})
}

fn read_meta(r: &mut Reader<'_>, strings: &[&str]) -> Option<Meta> {
	let n = r.count()?;
	let mut meta = Vec::with_capacity(n);
	for _ in 0..n {
		let key = strings.get(usize::try_from(r.varint()?).ok()?)?;
		meta.push(((*key).to_owned(), read_value(r, strings, 0)?));
	}
	Some(meta)
}

/// Decodes a cache; `None` for anything this version did not write.
#[must_use]
pub(crate) fn decode(bytes: &[u8]) -> Option<PlanCache> {
	let body_len = bytes.len().checked_sub(32)?;
	let (body, digest) = bytes.split_at(body_len);
	if kd_hash::sha256(body)[..] != *digest {
		return None;
	}
	let mut r = Reader { bytes: body, at: 0 };
	if r.take(3)? != MAGIC {
		return None;
	}
	let version_len = usize::try_from(r.varint()?).ok()?;
	if r.take(version_len)? != stamp().as_bytes() {
		return None;
	}
	let count = r.count()?;
	let mut strings: Vec<&str> = Vec::with_capacity(count);
	for _ in 0..count {
		let len = usize::try_from(r.varint()?).ok()?;
		strings.push(std::str::from_utf8(r.take(len)?).ok()?);
	}
	let string = |id: u64| strings.get(usize::try_from(id).ok()?).copied();
	let count = r.count()?;
	let mut pages = HashMap::with_capacity(count);
	for _ in 0..count {
		let path = string(r.varint()?)?.to_owned();
		let kind = match r.take(1)?[0] {
			0 => PageKind::Html,
			1 => PageKind::Tsx,
			_ => return None,
		};
		let input_dep = r.dep()?;
		let sidecar = string(r.varint()?)?.to_owned();
		let sidecar_dep = r.dep()?;
		let in_file = read_meta(&mut r, &strings)?;
		let side = read_meta(&mut r, &strings)?;
		pages.insert(
			path,
			CachedPage {
				kind,
				in_file,
				input_dep,
				side,
				sidecar,
				sidecar_dep,
			},
		);
	}
	(r.at == body.len()).then_some(PlanCache { pages })
}

/// Loads the cache of a cache directory (`None`: there is none to use).
#[must_use]
pub(crate) fn load(cache_dir: &str) -> Option<PlanCache> {
	decode(&std::fs::read(path(cache_dir)).ok()?)
}

/// Writes the cache atomically.
///
/// # Errors
///
/// An I/O message; a cache that cannot be written only costs the next build
/// its speed.
pub(crate) fn save(cache_dir: &str, cache: &PlanCache) -> Result<(), String> {
	let target = path(cache_dir);
	let bytes = encode(cache).ok_or("a fingerprint is not a SHA-256")?;
	std::fs::create_dir_all(cache_dir).map_err(|e| format!("cannot create {cache_dir}: {e}"))?;
	let temp = format!("{target}.tmp-{}", std::process::id());
	std::fs::write(&temp, bytes).map_err(|e| format!("cannot write {temp}: {e}"))?;
	std::fs::rename(&temp, &target).map_err(|e| format!("cannot write {target}: {e}"))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dep(n: u64) -> Dep {
		Dep {
			size: n,
			mtime_sec: 1_700_000_000,
			mtime_nsec: 7,
			hash: format!("{n:064x}"),
		}
	}

	fn page(n: u64) -> CachedPage {
		CachedPage {
			kind: if n.is_multiple_of(2) {
				PageKind::Html
			} else {
				PageKind::Tsx
			},
			in_file: vec![
				("title".to_owned(), Value::String(format!("Page {n}"))),
				(
					"nested".to_owned(),
					Value::Object(vec![
						("n".to_owned(), Value::Number(n as f64 + 0.5)),
						(
							"flags".to_owned(),
							Value::Array(vec![Value::Bool(true), Value::Null]),
						),
					]),
				),
			],
			input_dep: dep(n),
			side: vec![("layout".to_owned(), Value::String("main".to_owned()))],
			sidecar: format!("/in/page-{n}.json"),
			sidecar_dep: Dep::missing(),
		}
	}

	fn cache(pages: u64) -> PlanCache {
		PlanCache {
			pages: (0..pages)
				.map(|n| (format!("/in/page-{n}.tsx"), page(n)))
				.collect(),
		}
	}

	#[test]
	fn a_cache_round_trips_and_is_deterministic() {
		let c = cache(20);
		let bytes = encode(&c).unwrap();
		assert_eq!(decode(&bytes), Some(c.clone()));
		assert_eq!(encode(&c).unwrap(), bytes);
		assert_eq!(
			decode(&encode(&PlanCache::default()).unwrap()),
			Some(PlanCache::default())
		);
	}

	#[test]
	fn a_cache_that_decode_would_refuse_for_its_depth_is_not_written() {
		let mut deep = Value::Null;
		for _ in 0..=MAX_DEPTH + 1 {
			deep = Value::Array(vec![deep]);
		}
		let mut c = cache(3);
		c.pages
			.get_mut("/in/page-1.tsx")
			.unwrap()
			.in_file
			.push(("deep".to_owned(), deep));
		assert_eq!(encode(&c), None);
		// The allowed depth round-trips.
		let mut ok = Value::Null;
		for _ in 0..MAX_DEPTH - 1 {
			ok = Value::Array(vec![ok]);
		}
		let mut c = cache(3);
		c.pages
			.get_mut("/in/page-1.tsx")
			.unwrap()
			.in_file
			.push(("deep".to_owned(), ok));
		assert_eq!(decode(&encode(&c).unwrap()), Some(c));
	}

	#[test]
	fn what_this_version_did_not_write_is_ignored() {
		let bytes = encode(&cache(3)).unwrap();
		assert_eq!(decode(&[]), None);
		assert_eq!(decode(&bytes[..bytes.len() - 5]), None);
		let mut flipped = bytes.clone();
		flipped[20] ^= 0x10;
		assert_eq!(decode(&flipped), None);
		// Another kamado version, with a valid digest.
		let mut other = bytes[..bytes.len() - 32].to_vec();
		other[4] ^= 1; // the first byte of the version string
		let digest = kd_hash::sha256(&other);
		other.extend_from_slice(&digest);
		assert_eq!(decode(&other), None);
	}

	#[test]
	fn the_file_is_saved_and_loaded_from_a_cache_directory() {
		let dir = format!(
			"{}/kd_plan_cache_{}",
			std::env::temp_dir().display(),
			std::process::id()
		)
		.replace("//", "/");
		let _ = std::fs::remove_dir_all(&dir);
		assert_eq!(load(&dir), None);
		save(&dir, &cache(4)).unwrap();
		assert_eq!(load(&dir), Some(cache(4)));
		let _ = std::fs::remove_dir_all(&dir);
	}
}
