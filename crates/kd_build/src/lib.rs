//! Incremental build manifest: verifying traces with stat-first fingerprints.
//!
//! Each output records the input it came from, an environment digest, its
//! own byte size and, for every file the compilation read, a fingerprint
//! `(size, mtime, sha256)`. On the next build an output is skipped when the
//! environment matches, the output file is still there with the same size
//! and every dependency still has the same content.
//!
//! Why stat first: hashing 100k inputs on every run reads gigabytes. A file
//! whose size and mtime are unchanged is accepted without reading it; only a
//! file whose stat changed is hashed, and a hash that still matches (a
//! `touch`, a checkout) counts as unchanged and the stored mtime is refreshed.
//!
//! Why a missing dependency is still recorded: a template that probes for an
//! optional file depends on its absence. Creating the file later must
//! invalidate the output, so the sentinel `missing` is stored as its hash.
//!
//! The manifest lives outside the project tree by default (OS temp dir,
//! namespaced by the project root) so nothing has to be git-ignored; a
//! different version, corrupt JSON or any malformed entry means "full
//! rebuild" rather than a bad skip.

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use kd_jsonc::Value;

/// Bump when the format or the meaning of recorded data changes.
pub const MANIFEST_VERSION: u64 = 2;

/// Recorded as the hash of a dependency that could not be read.
pub const MISSING_FILE_HASH: &str = "missing";

const FILE_NAME: &str = "build-manifest.json";

/// Fingerprint of one dependency at the time the output was built.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Dep {
	pub size: u64,
	pub mtime_sec: i64,
	pub mtime_nsec: u32,
	/// 64 lowercase hex characters, or [`MISSING_FILE_HASH`].
	pub hash: String,
}

impl Dep {
	fn missing() -> Dep {
		Dep {
			size: 0,
			mtime_sec: 0,
			mtime_nsec: 0,
			hash: MISSING_FILE_HASH.to_string(),
		}
	}

	fn is_missing(&self) -> bool {
		self.hash == MISSING_FILE_HASH
	}
}

/// One output's verifying trace.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
	pub input_path: String,
	pub env: String,
	pub output_size: u64,
	/// Every file the compilation read, including the input itself.
	pub deps: BTreeMap<String, Dep>,
}

/// Verifying traces keyed by output path.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Manifest {
	pub entries: BTreeMap<String, Entry>,
}

/// `<basename>-<16 hex of sha256(root)>`: readable and unique per project.
fn cache_namespace(root_dir: &str) -> String {
	let base = root_dir
		.trim_end_matches('/')
		.rsplit('/')
		.next()
		.unwrap_or("");
	let base = if base.is_empty() { "root" } else { base };
	let sanitized: String = base
		.chars()
		.map(|c| {
			if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
				c
			} else {
				'_'
			}
		})
		.collect();
	let hash = kd_hash::to_hex(&kd_hash::sha256(root_dir.as_bytes()));
	format!("{sanitized}-{}", &hash[..16])
}

/// Resolves the cache directory: `cache_dir` (relative to the root when not
/// absolute) or `<temp_dir>/kamado/<namespace>`.
///
/// # Example
///
/// ```
/// assert_eq!(kd_build::cache_dir_in("/tmp", "/proj", Some("/abs/cache")), "/abs/cache");
/// assert_eq!(kd_build::cache_dir_in("/tmp", "/proj", Some(".cache")), "/proj/.cache");
/// assert!(kd_build::cache_dir_in("/tmp", "/proj", None).starts_with("/tmp/kamado/proj-"));
/// ```
#[must_use]
pub fn cache_dir_in(temp_dir: &str, root_dir: &str, cache_dir: Option<&str>) -> String {
	match cache_dir {
		Some(dir) if dir.starts_with('/') => dir.to_string(),
		Some(dir) => format!("{}/{dir}", root_dir.trim_end_matches('/')),
		None => format!(
			"{}/kamado/{}",
			temp_dir.trim_end_matches('/'),
			cache_namespace(root_dir)
		),
	}
}

/// [`cache_dir_in`] with the OS temp directory.
#[must_use]
pub fn cache_dir(root_dir: &str, cache_dir: Option<&str>) -> String {
	let temp = std::env::temp_dir();
	cache_dir_in(&temp.to_string_lossy(), root_dir, cache_dir)
}

/// Path of the manifest file inside a cache directory.
#[must_use]
pub fn manifest_path(cache_dir: &str) -> String {
	format!("{}/{FILE_NAME}", cache_dir.trim_end_matches('/'))
}

impl Manifest {
	/// Loads a manifest. `None` when the file is missing, unreadable, corrupt,
	/// of another version, or has any malformed entry: all mean "full rebuild".
	#[must_use]
	pub fn load(path: &str) -> Option<Manifest> {
		let raw = fs::read_to_string(path).ok()?;
		let value = kd_jsonc::parse(&raw).ok()?;
		if value.get("version")?.as_f64()? != MANIFEST_VERSION as f64 {
			return None;
		}
		let mut entries = BTreeMap::new();
		for (output, entry) in value.get("entries")?.as_object()? {
			entries.insert(output.clone(), parse_entry(entry)?);
		}
		Some(Manifest { entries })
	}

	/// Writes the manifest atomically (temp file, then rename).
	pub fn save(&self, path: &str) -> io::Result<()> {
		let target = Path::new(path);
		if let Some(parent) = target.parent() {
			fs::create_dir_all(parent)?;
		}
		let tmp: PathBuf = target.with_extension(format!("json.tmp-{}", std::process::id()));
		fs::write(&tmp, self.to_json())?;
		fs::rename(&tmp, target)
	}

	/// Compact JSON. Numbers that do not fit a double exactly (mtime in
	/// nanoseconds) are split into seconds and nanoseconds.
	#[must_use]
	pub fn to_json(&self) -> String {
		let entries = self
			.entries
			.iter()
			.map(|(output, e)| {
				let deps = e
					.deps
					.iter()
					.map(|(p, d)| {
						(
							p.clone(),
							Value::Array(vec![
								Value::Number(d.size as f64),
								Value::Number(d.mtime_sec as f64),
								Value::Number(f64::from(d.mtime_nsec)),
								Value::String(d.hash.clone()),
							]),
						)
					})
					.collect();
				(
					output.clone(),
					Value::Object(vec![
						("inputPath".to_string(), Value::String(e.input_path.clone())),
						("env".to_string(), Value::String(e.env.clone())),
						(
							"outputSize".to_string(),
							Value::Number(e.output_size as f64),
						),
						("deps".to_string(), Value::Object(deps)),
					]),
				)
			})
			.collect();
		Value::Object(vec![
			(
				"version".to_string(),
				Value::Number(MANIFEST_VERSION as f64),
			),
			("entries".to_string(), Value::Object(entries)),
		])
		.to_json()
	}
}

fn parse_entry(value: &Value) -> Option<Entry> {
	let input_path = value.get("inputPath")?.as_str()?.to_string();
	let env = value.get("env")?.as_str()?.to_string();
	let output_size = value.get("outputSize")?.as_f64()?;
	if output_size < 0.0 || output_size.fract() != 0.0 {
		return None;
	}
	let mut deps = BTreeMap::new();
	for (path, dep) in value.get("deps")?.as_object()? {
		let items = dep.as_array()?;
		if items.len() != 4 {
			return None;
		}
		let size = items[0].as_f64()?;
		let sec = items[1].as_f64()?;
		let nsec = items[2].as_f64()?;
		let hash = items[3].as_str()?;
		if size.fract() != 0.0 || sec.fract() != 0.0 || nsec.fract() != 0.0 || nsec < 0.0 {
			return None;
		}
		deps.insert(
			path.clone(),
			Dep {
				size: size as u64,
				mtime_sec: sec as i64,
				mtime_nsec: nsec as u32,
				hash: hash.to_string(),
			},
		);
	}
	Some(Entry {
		input_path,
		env,
		output_size: output_size as u64,
		deps,
	})
}

/// `(size, mtime_sec, mtime_nsec)` of a file, or `None` when it cannot be stat'ed.
fn stat(path: &str) -> Option<(u64, i64, u32)> {
	let meta = fs::metadata(path).ok()?;
	if !meta.is_file() {
		return None;
	}
	let mtime = meta.modified().ok()?;
	let (sec, nsec) = match mtime.duration_since(UNIX_EPOCH) {
		Ok(d) => (d.as_secs() as i64, d.subsec_nanos()),
		Err(e) => {
			let d = e.duration();
			(-(d.as_secs() as i64), d.subsec_nanos())
		}
	};
	Some((meta.len(), sec, nsec))
}

/// Memoizing fingerprinter for one build: a file referenced by many outputs
/// (a layout, a component) is stat'ed and hashed once. Safe to share across
/// pool threads.
#[derive(Default)]
pub struct Fingerprinter {
	memo: Mutex<HashMap<String, Dep>>,
}

impl Fingerprinter {
	#[must_use]
	pub fn new() -> Fingerprinter {
		Fingerprinter::default()
	}

	/// Current fingerprint of `path` (stat + content hash), memoized.
	pub fn fingerprint(&self, path: &str) -> Dep {
		if let Some(d) = self
			.memo
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.get(path)
		{
			return d.clone();
		}
		let dep = match (stat(path), fs::read(path)) {
			(Some((size, sec, nsec)), Ok(bytes)) => Dep {
				size,
				mtime_sec: sec,
				mtime_nsec: nsec,
				hash: kd_hash::to_hex(&kd_hash::sha256(&bytes)),
			},
			_ => Dep::missing(),
		};
		self.memo
			.lock()
			.unwrap_or_else(|e| e.into_inner())
			.insert(path.to_string(), dep.clone());
		dep
	}

	/// Checks a recorded dependency against the file system, reading the
	/// file only when its stat changed. Returns the fingerprint to record
	/// when the content is unchanged, `None` when it changed.
	fn verify(&self, path: &str, recorded: &Dep) -> Option<Dep> {
		match stat(path) {
			None => recorded.is_missing().then(|| recorded.clone()),
			Some((size, sec, nsec)) => {
				if recorded.is_missing() {
					return None;
				}
				if size == recorded.size && sec == recorded.mtime_sec && nsec == recorded.mtime_nsec
				{
					return Some(recorded.clone());
				}
				let current = self.fingerprint(path);
				(current.hash == recorded.hash && !current.is_missing()).then_some(current)
			}
		}
	}
}

/// Outcome of checking one recorded output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
	/// Nothing changed. The entry carries refreshed fingerprints (an mtime
	/// may have moved while the content did not) and should be stored again.
	UpToDate(Entry),
	/// Something changed (or nothing can be verified): compile again.
	Stale,
}

/// Decides whether `output_path` can be skipped.
///
/// Stale when: the environment digest differs, the input path differs, no
/// dependency was recorded (nothing to verify — safe side), the output file
/// is missing or has another size, or any dependency's content changed.
///
/// # Example
///
/// ```no_run
/// let manifest = kd_build::Manifest::load("/tmp/kamado/x/build-manifest.json").unwrap_or_default();
/// let fp = kd_build::Fingerprinter::new();
/// if let Some(entry) = manifest.entries.get("/site/htdocs/index.html") {
///     match kd_build::check(entry, "/site/htdocs/index.html", "/site/src/index.tsx", "env-digest", &fp) {
///         kd_build::Verdict::UpToDate(_) => println!("cached"),
///         kd_build::Verdict::Stale => println!("rebuild"),
///     }
/// }
/// ```
#[must_use]
pub fn check(
	entry: &Entry,
	output_path: &str,
	input_path: &str,
	env: &str,
	fingerprinter: &Fingerprinter,
) -> Verdict {
	if entry.env != env || entry.input_path != input_path || entry.deps.is_empty() {
		return Verdict::Stale;
	}
	match stat(output_path) {
		Some((size, _, _)) if size == entry.output_size => {}
		_ => return Verdict::Stale,
	}
	let mut refreshed = BTreeMap::new();
	for (path, recorded) in &entry.deps {
		match fingerprinter.verify(path, recorded) {
			Some(dep) => {
				refreshed.insert(path.clone(), dep);
			}
			None => return Verdict::Stale,
		}
	}
	Verdict::UpToDate(Entry {
		input_path: entry.input_path.clone(),
		env: entry.env.clone(),
		output_size: entry.output_size,
		deps: refreshed,
	})
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::thread;
	use std::time::Duration;

	fn temp_root(name: &str) -> String {
		let dir = std::env::temp_dir().join(format!("kd_build_{name}_{}", std::process::id()));
		let _ = fs::remove_dir_all(&dir);
		fs::create_dir_all(&dir).unwrap();
		dir.to_string_lossy().to_string()
	}

	fn write(root: &str, rel: &str, content: &[u8]) -> String {
		let p = format!("{root}/{rel}");
		fs::create_dir_all(Path::new(&p).parent().unwrap()).unwrap();
		fs::write(&p, content).unwrap();
		p
	}

	#[test]
	fn cache_dir_namespacing() {
		let a = cache_dir_in("/tmp", "/work/project-a", None);
		let b = cache_dir_in("/tmp", "/work/project-b", None);
		assert!(a.starts_with("/tmp/kamado/project-a-"));
		assert_ne!(a, b);
		assert_eq!(a, cache_dir_in("/tmp", "/work/project-a", None));
		assert_eq!(a.len(), "/tmp/kamado/project-a-".len() + 16);
		// Unsafe characters in the basename are replaced; the hash keeps it unique.
		assert!(
			cache_dir_in("/tmp", "/work/my site (2026)", None)
				.starts_with("/tmp/kamado/my_site__2026_-")
		);
		assert!(cache_dir_in("/tmp", "/", None).starts_with("/tmp/kamado/root-"));
		assert_eq!(cache_dir_in("/tmp/", "/p", Some("/abs")), "/abs");
		assert_eq!(
			cache_dir_in("/tmp", "/p/", Some(".kamado/cache")),
			"/p/.kamado/cache"
		);
		assert_eq!(manifest_path("/abs/"), "/abs/build-manifest.json");
	}

	fn sample() -> Manifest {
		let mut deps = BTreeMap::new();
		deps.insert(
			"/in/index.tsx".to_string(),
			Dep {
				size: 123,
				mtime_sec: 1_700_000_000,
				mtime_nsec: 123_456_789,
				hash: "a".repeat(64),
			},
		);
		deps.insert("/in/optional.json".to_string(), Dep::missing());
		let mut entries = BTreeMap::new();
		entries.insert(
			"/out/index.html".to_string(),
			Entry {
				input_path: "/in/index.tsx".to_string(),
				env: "b".repeat(64),
				output_size: 456,
				deps,
			},
		);
		Manifest { entries }
	}

	#[test]
	fn json_format_is_stable_and_roundtrips() {
		let m = sample();
		assert_eq!(
			m.to_json(),
			r#"{"version":2,"entries":{"/out/index.html":{"inputPath":"/in/index.tsx","env":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","outputSize":456,"deps":{"/in/index.tsx":[123,1700000000,123456789,"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],"/in/optional.json":[0,0,0,"missing"]}}}}"#
		);
		let root = temp_root("roundtrip");
		let path = manifest_path(&format!("{root}/nested/cache"));
		m.save(&path).unwrap();
		assert_eq!(Manifest::load(&path), Some(m));
		assert!(!Path::new(&format!("{path}.tmp-{}", std::process::id())).exists());
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn load_returns_none_for_missing_corrupt_or_foreign_manifests() {
		let root = temp_root("load");
		assert_eq!(Manifest::load(&format!("{root}/nope.json")), None);
		let p = write(&root, "corrupt.json", b"{not json");
		assert_eq!(Manifest::load(&p), None);
		let p = write(&root, "v1.json", br#"{"version":1,"entries":{}}"#);
		assert_eq!(Manifest::load(&p), None);
		let p = write(
			&root,
			"nodeps.json",
			br#"{"version":2,"entries":{"/o":{"inputPath":"/i","env":"raw","outputSize":5}}}"#,
		);
		assert_eq!(Manifest::load(&p), None);
		let p = write(&root, "baddep.json", br#"{"version":2,"entries":{"/o":{"inputPath":"/i","env":"raw","outputSize":5,"deps":{"/i":[1,2,3]}}}}"#);
		assert_eq!(Manifest::load(&p), None);
		let p = write(&root, "badhash.json", br#"{"version":2,"entries":{"/o":{"inputPath":"/i","env":"raw","outputSize":5,"deps":{"/i":[1,2,3,4]}}}}"#);
		assert_eq!(Manifest::load(&p), None);
		let p = write(
			&root,
			"no-input.json",
			br#"{"version":2,"entries":{"/o":{"env":"raw","outputSize":5,"deps":{}}}}"#,
		);
		assert_eq!(Manifest::load(&p), None);
		let p = write(&root, "empty.json", br#"{"version":2,"entries":{}}"#);
		assert_eq!(Manifest::load(&p), Some(Manifest::default()));
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn fingerprinter_hashes_bytes_and_memoizes() {
		let root = temp_root("fp");
		let a = write(&root, "a.txt", b"alpha");
		let fp = Fingerprinter::new();
		let first = fp.fingerprint(&a);
		// echo -n 'alpha' | shasum -a 256
		assert_eq!(
			first.hash,
			"8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8"
		);
		assert_eq!(first.size, 5);
		fs::write(&a, b"changed").unwrap();
		assert_eq!(
			fp.fingerprint(&a),
			first,
			"memoized for the duration of one build"
		);
		assert_eq!(fp.fingerprint(&format!("{root}/nowhere")), Dep::missing());
		// Byte-distinct invalid UTF-8 must not collide.
		let b1 = write(&root, "b1", &[0xC3, 0x28]);
		let b2 = write(&root, "b2", &[0xC4, 0x28]);
		assert_ne!(fp.fingerprint(&b1).hash, fp.fingerprint(&b2).hash);
		let _ = fs::remove_dir_all(&root);
	}

	fn build_entry(input: &str, deps: &[&str], output: &str, env: &str) -> Entry {
		let fp = Fingerprinter::new();
		let mut map = BTreeMap::new();
		for d in deps {
			map.insert(d.to_string(), fp.fingerprint(d));
		}
		Entry {
			input_path: input.to_string(),
			env: env.to_string(),
			output_size: fs::metadata(output).map(|m| m.len()).unwrap_or(0),
			deps: map,
		}
	}

	#[test]
	fn check_accepts_unchanged_and_detects_every_kind_of_change() {
		let root = temp_root("check");
		let input = write(&root, "in/page.tsx", b"<p>page</p>");
		let layout = write(&root, "in/layout.tsx", b"<html/>");
		let optional = format!("{root}/in/optional.json");
		let output = write(&root, "out/page.html", b"<html><p>page</p></html>");
		let entry = build_entry(&input, &[&input, &layout, &optional], &output, "env1");
		assert!(entry.deps[&optional].is_missing());

		// Unchanged.
		let fp = Fingerprinter::new();
		assert!(matches!(
			check(&entry, &output, &input, "env1", &fp),
			Verdict::UpToDate(_)
		));

		// Different env / input path / no deps.
		assert_eq!(check(&entry, &output, &input, "env2", &fp), Verdict::Stale);
		assert_eq!(
			check(&entry, &output, "/elsewhere.tsx", "env1", &fp),
			Verdict::Stale
		);
		let mut nodeps = entry.clone();
		nodeps.deps.clear();
		assert_eq!(check(&nodeps, &output, &input, "env1", &fp), Verdict::Stale);

		// Output missing or resized.
		assert_eq!(
			check(
				&entry,
				&format!("{root}/out/gone.html"),
				&input,
				"env1",
				&fp
			),
			Verdict::Stale
		);
		fs::write(&output, b"<html></html>").unwrap();
		assert_eq!(
			check(&entry, &output, &input, "env1", &Fingerprinter::new()),
			Verdict::Stale
		);
		fs::write(&output, b"<html><p>page</p></html>").unwrap();

		// A dependency that was missing now exists.
		fs::write(&optional, b"{}").unwrap();
		assert_eq!(
			check(&entry, &output, &input, "env1", &Fingerprinter::new()),
			Verdict::Stale
		);
		fs::remove_file(&optional).unwrap();

		// A dependency's content changed (same size).
		fs::write(&layout, b"<body/>").unwrap();
		assert_eq!(
			check(&entry, &output, &input, "env1", &Fingerprinter::new()),
			Verdict::Stale
		);
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn check_rehashes_when_only_the_mtime_moved_and_refreshes_it() {
		let root = temp_root("touch");
		let input = write(&root, "in/page.tsx", b"same content");
		let output = write(&root, "out/page.html", b"out");
		let entry = build_entry(&input, &[&input], &output, "env");
		let before = entry.deps[&input].clone();

		// Rewrite identical bytes after a pause so the mtime differs.
		thread::sleep(Duration::from_millis(20));
		fs::write(&input, b"same content").unwrap();
		let now = stat(&input).unwrap();
		assert!(
			(now.1, now.2) != (before.mtime_sec, before.mtime_nsec),
			"mtime must have moved for this test"
		);

		match check(&entry, &output, &input, "env", &Fingerprinter::new()) {
			Verdict::UpToDate(refreshed) => {
				let dep = &refreshed.deps[&input];
				assert_eq!(dep.hash, before.hash);
				assert_eq!(
					(dep.mtime_sec, dep.mtime_nsec),
					(now.1, now.2),
					"stored mtime is refreshed"
				);
			}
			Verdict::Stale => panic!("identical content must not be stale"),
		}
		let _ = fs::remove_dir_all(&root);
	}

	#[test]
	fn check_skips_hashing_when_stat_is_unchanged() {
		let root = temp_root("stat_only");
		let input = write(&root, "in/a.tsx", b"abc");
		let output = write(&root, "out/a.html", b"x");
		let mut entry = build_entry(&input, &[&input], &output, "env");
		// Corrupt the recorded hash: if `check` hashed the file it would see a mismatch.
		entry.deps.get_mut(&input).unwrap().hash = "0".repeat(64);
		assert!(matches!(
			check(&entry, &output, &input, "env", &Fingerprinter::new()),
			Verdict::UpToDate(_)
		));
		let _ = fs::remove_dir_all(&root);
	}
}
