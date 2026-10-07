//! POSIX path string helpers with the semantics of Node's `path.posix`,
//! which the mapping rules were written against.

/// Collapses `.` and `..` segments and repeated slashes. A relative path
/// stays relative; `..` that climbs above a relative root is kept.
///
/// # Example
///
/// ```
/// assert_eq!(kd_site::path::normalize("/a/./b/../c//d/"), "/a/c/d");
/// assert_eq!(kd_site::path::normalize("../x"), "../x");
/// ```
#[must_use]
pub fn normalize(p: &str) -> String {
	let absolute = p.starts_with('/');
	let mut out: Vec<&str> = Vec::new();
	for seg in p.split('/') {
		match seg {
			"" | "." => {}
			".." => {
				if matches!(out.last(), Some(&last) if last != "..") {
					out.pop();
				} else if !absolute {
					out.push("..");
				}
			}
			s => out.push(s),
		}
	}
	let body = out.join("/");
	if absolute {
		format!("/{body}")
	} else if body.is_empty() {
		".".to_string()
	} else {
		body
	}
}

/// Joins and normalizes. An absolute `b` replaces `a`.
#[must_use]
pub fn join(a: &str, b: &str) -> String {
	if b.starts_with('/') {
		return normalize(b);
	}
	if a.is_empty() {
		return normalize(b);
	}
	normalize(&format!("{a}/{b}"))
}

/// Last segment (`path.posix.basename`).
#[must_use]
pub fn basename(p: &str) -> &str {
	let trimmed = p.trim_end_matches('/');
	match trimmed.rfind('/') {
		Some(i) => &trimmed[i + 1..],
		None => trimmed,
	}
}

/// Parent directory (`path.posix.dirname`): `.` for a bare name, `/` for a root child.
#[must_use]
pub fn dirname(p: &str) -> String {
	let trimmed = p.trim_end_matches('/');
	match trimmed.rfind('/') {
		Some(0) => "/".to_string(),
		Some(i) => trimmed[..i].to_string(),
		None => ".".to_string(),
	}
}

/// Extension including the dot (`path.posix.extname`): empty for dotfiles
/// and names without a dot.
#[must_use]
pub fn extname(p: &str) -> &str {
	let base = basename(p);
	match base.rfind('.') {
		Some(0) | None => "",
		Some(i) => &base[i..],
	}
}

/// `to` relative to `from` (`path.posix.relative`), both treated as
/// normalized absolute paths. Equal paths give an empty string.
///
/// # Example
///
/// ```
/// assert_eq!(kd_site::path::relative("/a/b", "/a/b/c/d"), "c/d");
/// assert_eq!(kd_site::path::relative("/a/b", "/a/x"), "../x");
/// assert_eq!(kd_site::path::relative("/a", "/a"), "");
/// ```
#[must_use]
pub fn relative(from: &str, to: &str) -> String {
	let from = normalize(from);
	let to = normalize(to);
	let f: Vec<&str> = from.split('/').filter(|s| !s.is_empty()).collect();
	let t: Vec<&str> = to.split('/').filter(|s| !s.is_empty()).collect();
	let common = f.iter().zip(t.iter()).take_while(|(a, b)| a == b).count();
	let mut parts: Vec<&str> = vec![".."; f.len() - common];
	parts.extend_from_slice(&t[common..]);
	parts.join("/")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn normalize_cases() {
		assert_eq!(normalize("/a/b/c"), "/a/b/c");
		assert_eq!(normalize("/a/b/../c"), "/a/c");
		assert_eq!(normalize("/a/./b"), "/a/b");
		assert_eq!(normalize("/a//b/"), "/a/b");
		assert_eq!(normalize("/"), "/");
		assert_eq!(normalize("/.."), "/");
		assert_eq!(normalize("a/../.."), "..");
		assert_eq!(normalize("a/.."), ".");
		assert_eq!(normalize(""), ".");
	}

	#[test]
	fn join_cases() {
		assert_eq!(join("/a", "b/c"), "/a/b/c");
		assert_eq!(join("/a/", "/b"), "/b");
		assert_eq!(join("", "x"), "x");
		assert_eq!(join("/a", ""), "/a");
	}

	#[test]
	fn basename_dirname_extname_cases() {
		assert_eq!(basename("/a/b/c.txt"), "c.txt");
		assert_eq!(basename("/a/b/"), "b");
		assert_eq!(basename("c.txt"), "c.txt");
		assert_eq!(dirname("/a/b/c.txt"), "/a/b");
		assert_eq!(dirname("/a"), "/");
		assert_eq!(dirname("a"), ".");
		assert_eq!(dirname("a/b/"), "a");
		assert_eq!(extname("a/b.tar.gz"), ".gz");
		assert_eq!(extname(".env"), "");
		assert_eq!(extname("plain"), "");
		assert_eq!(extname("a.b/c"), "");
	}

	#[test]
	fn relative_cases() {
		assert_eq!(relative("/a/b", "/a/b/c/d"), "c/d");
		assert_eq!(relative("/a/b", "/a/x"), "../x");
		assert_eq!(relative("/a", "/a"), "");
		assert_eq!(relative("/a/b/c", "/"), "../../..");
	}
}
