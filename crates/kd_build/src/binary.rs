//! The manifest on disk: a compact binary form.
//!
//! Why not JSON: the entries of a site repeat themselves. Every page lists
//! the files of the layout and the components it was built with, each with a
//! path and a fingerprint, so the manifest of a hundred thousand pages is
//! hundreds of megabytes of JSON and reading it costs more than checking
//! whether anything changed. Here every string and every distinct
//! (path, fingerprint) pair is written once and entries refer to them by
//! number, and numbers are varints.
//!
//! Layout (all integers are LEB128 varints, `sec` zigzag encoded):
//!
//! ```text
//! "KDM" version(1 byte)
//! strings:  count, then per string: length, UTF-8 bytes
//! files:    count, then per file: path(string id), size, sec, nsec,
//!           kind(0 = missing, 1 = hash follows) [32 hash bytes]
//! entries:  count, then per entry: output(string id), input(string id),
//!           env(string id), output size, dep count, dep file ids
//! sha-256 of everything before it (32 bytes)
//! ```
//!
//! A manifest that does not decode (truncated, flipped bytes, another
//! version) is `None`, which means "build everything".

use std::collections::{BTreeMap, HashMap};

use crate::{Dep, Entry, MANIFEST_VERSION, MISSING_FILE_HASH, Manifest};

const MAGIC: &[u8; 3] = b"KDM";

/// Appends a LEB128 varint.
pub fn put(out: &mut Vec<u8>, mut value: u64) {
	loop {
		let byte = (value & 0x7f) as u8;
		value >>= 7;
		if value == 0 {
			out.push(byte);
			return;
		}
		out.push(byte | 0x80);
	}
}

/// Zigzag encoding, for signed numbers that are mostly small.
#[must_use]
pub fn zigzag(value: i64) -> u64 {
	((value << 1) ^ (value >> 63)) as u64
}

/// The inverse of [`zigzag`].
#[must_use]
pub fn unzigzag(value: u64) -> i64 {
	((value >> 1) as i64) ^ -((value & 1) as i64)
}

/// Interns strings as consecutive ids.
#[derive(Default)]
struct Table<'a> {
	ids: HashMap<&'a str, u64>,
	order: Vec<&'a str>,
}

impl<'a> Table<'a> {
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

/// The bytes of a manifest, or `None` for a fingerprint that is neither a
/// SHA-256 in hex nor the marker of a missing file (a manifest holds nothing
/// else; the caller then writes none).
///
/// # Example
///
/// ```
/// let manifest = kd_build::Manifest::default();
/// let bytes = kd_build::binary::encode(&manifest).unwrap();
/// assert_eq!(kd_build::binary::decode(&bytes), Some(manifest));
/// ```
#[must_use]
pub fn encode(manifest: &Manifest) -> Option<Vec<u8>> {
	let mut strings = Table::default();
	// Distinct (path id, fingerprint) pairs, in first-use order.
	let mut file_ids: HashMap<(u64, &Dep), u64> = HashMap::new();
	let mut files: Vec<(u64, &Dep)> = Vec::new();
	let mut entries: Vec<(u64, u64, u64, u64, Vec<u64>)> =
		Vec::with_capacity(manifest.entries.len());
	for (output, e) in &manifest.entries {
		let mut deps = Vec::with_capacity(e.deps.len());
		for (path, dep) in &e.deps {
			let key = (strings.id(path), dep);
			let id = *file_ids.entry(key).or_insert_with(|| {
				files.push(key);
				(files.len() - 1) as u64
			});
			deps.push(id);
		}
		entries.push((
			strings.id(output),
			strings.id(&e.input_path),
			strings.id(&e.env),
			e.output_size,
			deps,
		));
	}

	let mut out = Vec::with_capacity(1 << 16);
	out.extend_from_slice(MAGIC);
	out.push(MANIFEST_VERSION as u8);
	put(&mut out, strings.order.len() as u64);
	for s in &strings.order {
		put(&mut out, s.len() as u64);
		out.extend_from_slice(s.as_bytes());
	}
	put(&mut out, files.len() as u64);
	for (path, dep) in &files {
		put(&mut out, *path);
		put(&mut out, dep.size);
		put(&mut out, zigzag(dep.mtime_sec));
		put(&mut out, u64::from(dep.mtime_nsec));
		if dep.hash == MISSING_FILE_HASH {
			out.push(0);
		} else {
			out.push(1);
			out.extend_from_slice(&from_hex(&dep.hash)?);
		}
	}
	put(&mut out, entries.len() as u64);
	for (output, input, env, size, deps) in &entries {
		put(&mut out, *output);
		put(&mut out, *input);
		put(&mut out, *env);
		put(&mut out, *size);
		put(&mut out, deps.len() as u64);
		for id in deps {
			put(&mut out, *id);
		}
	}
	let digest = kd_hash::sha256(&out);
	out.extend_from_slice(&digest);
	Some(out)
}

/// Appends a fingerprint: size, time and the hash as 32 raw bytes (or a marker
/// for a missing file). `None` when the hash is neither.
///
/// # Example
///
/// ```
/// let mut bytes = Vec::new();
/// kd_build::binary::put_dep(&mut bytes, &kd_build::Dep::missing()).unwrap();
/// let mut reader = kd_build::binary::Reader { bytes: &bytes, at: 0 };
/// assert_eq!(reader.dep(), Some(kd_build::Dep::missing()));
/// ```
#[must_use]
pub fn put_dep(out: &mut Vec<u8>, dep: &Dep) -> Option<()> {
	put(out, dep.size);
	put(out, zigzag(dep.mtime_sec));
	put(out, u64::from(dep.mtime_nsec));
	if dep.hash == MISSING_FILE_HASH {
		out.push(0);
	} else {
		out.push(1);
		out.extend_from_slice(&from_hex(&dep.hash)?);
	}
	Some(())
}

fn from_hex(hex: &str) -> Option<[u8; 32]> {
	let bytes = hex.as_bytes();
	if bytes.len() != 64 {
		return None;
	}
	let nibble = |c: u8| match c {
		b'0'..=b'9' => Some(c - b'0'),
		b'a'..=b'f' => Some(c - b'a' + 10),
		_ => None,
	};
	let mut out = [0u8; 32];
	for (i, pair) in bytes.chunks(2).enumerate() {
		out[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
	}
	Some(out)
}

/// A cursor over the bytes that fails with `None` instead of panicking.
pub struct Reader<'a> {
	pub bytes: &'a [u8],
	pub at: usize,
}

impl<'a> Reader<'a> {
	/// The next `n` bytes.
	pub fn take(&mut self, n: usize) -> Option<&'a [u8]> {
		let end = self.at.checked_add(n)?;
		let slice = self.bytes.get(self.at..end)?;
		self.at = end;
		Some(slice)
	}

	/// The next varint.
	pub fn varint(&mut self) -> Option<u64> {
		let mut value = 0u64;
		for shift in (0..64).step_by(7) {
			let byte = *self.bytes.get(self.at)?;
			self.at += 1;
			value |= u64::from(byte & 0x7f) << shift;
			if byte & 0x80 == 0 {
				return Some(value);
			}
		}
		None
	}

	/// A fingerprint written by [`put_dep`].
	pub fn dep(&mut self) -> Option<Dep> {
		let size = self.varint()?;
		let sec = unzigzag(self.varint()?);
		let nsec = u32::try_from(self.varint()?).ok()?;
		let hash = match self.take(1)?[0] {
			0 => MISSING_FILE_HASH.to_owned(),
			1 => kd_hash::to_hex(&<[u8; 32]>::try_from(self.take(32)?).ok()?),
			_ => return None,
		};
		Some(Dep {
			size,
			mtime_sec: sec,
			mtime_nsec: nsec,
			hash,
		})
	}

	/// A count that can be believed: no larger than the bytes left, since
	/// every item takes at least one.
	pub fn count(&mut self) -> Option<usize> {
		let n = usize::try_from(self.varint()?).ok()?;
		(n <= self.bytes.len() - self.at).then_some(n)
	}
}

/// Decodes a manifest; `None` for anything that is not exactly what
/// [`encode`] wrote for this version.
#[must_use]
pub fn decode(bytes: &[u8]) -> Option<Manifest> {
	let body_len = bytes.len().checked_sub(32)?;
	let (body, digest) = bytes.split_at(body_len);
	if kd_hash::sha256(body)[..] != *digest {
		return None;
	}
	let mut r = Reader { bytes: body, at: 0 };
	if r.take(3)? != MAGIC || r.take(1)?[0] != MANIFEST_VERSION as u8 {
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
	let mut files: Vec<(&str, Dep)> = Vec::with_capacity(count);
	for _ in 0..count {
		let path = string(r.varint()?)?;
		let size = r.varint()?;
		let sec = unzigzag(r.varint()?);
		let nsec = u32::try_from(r.varint()?).ok()?;
		let hash = match r.take(1)?[0] {
			0 => MISSING_FILE_HASH.to_owned(),
			1 => kd_hash::to_hex(&<[u8; 32]>::try_from(r.take(32)?).ok()?),
			_ => return None,
		};
		files.push((
			path,
			Dep {
				size,
				mtime_sec: sec,
				mtime_nsec: nsec,
				hash,
			},
		));
	}

	let count = r.count()?;
	let mut entries = BTreeMap::new();
	for _ in 0..count {
		let output = string(r.varint()?)?;
		let input_path = string(r.varint()?)?.to_owned();
		let env = string(r.varint()?)?.to_owned();
		let output_size = r.varint()?;
		let dep_count = r.count()?;
		let mut deps = BTreeMap::new();
		for _ in 0..dep_count {
			let (path, dep) = files.get(usize::try_from(r.varint()?).ok()?)?;
			deps.insert((*path).to_owned(), dep.clone());
		}
		entries.insert(
			output.to_owned(),
			Entry {
				input_path,
				env,
				output_size,
				deps,
			},
		);
	}
	(r.at == body.len()).then_some(Manifest { entries })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dep(n: u64) -> Dep {
		Dep {
			size: n,
			mtime_sec: 1_700_000_000 + n as i64,
			mtime_nsec: 123_456_789,
			hash: format!("{n:064x}"),
		}
	}

	fn sample(pages: u64) -> Manifest {
		let mut entries = BTreeMap::new();
		for p in 0..pages {
			let mut deps = BTreeMap::new();
			deps.insert(format!("/in/page-{p}.tsx"), dep(p));
			deps.insert(format!("/in/page-{p}.json"), Dep::missing());
			// Shared by every page: written once.
			deps.insert("/in/layout.tsx".to_owned(), dep(1_000_000));
			deps.insert("/in/box.tsx".to_owned(), dep(1_000_001));
			entries.insert(
				format!("/out/page-{p}.html"),
				Entry {
					input_path: format!("/in/page-{p}.tsx"),
					env: "e".repeat(64),
					output_size: p * 10,
					deps,
				},
			);
		}
		Manifest { entries }
	}

	#[test]
	fn a_manifest_round_trips_with_negative_times_and_missing_files() {
		let mut m = sample(5);
		m.entries.get_mut("/out/page-1.html").unwrap().deps.insert(
			"/in/before-epoch".to_owned(),
			Dep {
				size: 0,
				mtime_sec: -86_400,
				mtime_nsec: 5,
				hash: "ab".repeat(32),
			},
		);
		let bytes = encode(&m).unwrap();
		assert_eq!(decode(&bytes), Some(m));
		assert_eq!(
			decode(&encode(&Manifest::default()).unwrap()),
			Some(Manifest::default())
		);
	}

	#[test]
	fn shared_files_and_strings_are_written_once() {
		let one = encode(&sample(1)).unwrap().len();
		let thousand = encode(&sample(1000)).unwrap().len();
		// A page costs its own path, fingerprint and entry, not the layout and
		// the components again: well under 300 bytes where JSON took 700.
		assert!(
			thousand < one + 999 * 300,
			"{thousand} bytes for 1000 pages"
		);
	}

	#[test]
	fn anything_but_what_was_written_is_refused() {
		let bytes = encode(&sample(3)).unwrap();
		assert_eq!(decode(&[]), None);
		assert_eq!(decode(&bytes[..bytes.len() - 1]), None, "truncated");
		let mut flipped = bytes.clone();
		flipped[10] ^= 1;
		assert_eq!(decode(&flipped), None, "a flipped byte fails the digest");
		// Another version, with a digest that matches its content.
		let mut other = bytes[..bytes.len() - 32].to_vec();
		other[3] = other[3].wrapping_add(1);
		let digest = kd_hash::sha256(&other);
		other.extend_from_slice(&digest);
		assert_eq!(decode(&other), None, "foreign version");
		// Garbage with a valid digest: counts larger than the data.
		let mut garbage = b"KDM".to_vec();
		garbage.push(MANIFEST_VERSION as u8);
		garbage.extend_from_slice(&[0xff, 0xff, 0xff, 0x7f]);
		let digest = kd_hash::sha256(&garbage);
		garbage.extend_from_slice(&digest);
		assert_eq!(decode(&garbage), None);
	}

	#[test]
	fn a_fingerprint_that_is_not_a_hash_is_not_written() {
		let mut m = sample(1);
		m.entries.values_mut().next().unwrap().deps.insert(
			"/in/odd".to_owned(),
			Dep {
				size: 1,
				mtime_sec: 1,
				mtime_nsec: 1,
				hash: "not hex".to_owned(),
			},
		);
		assert_eq!(encode(&m), None);
	}
}
