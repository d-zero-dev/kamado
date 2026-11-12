//! The order of the pages of a plan (RFC §6, "並び順"): the order of `pages` and `nav()`.
//!
//! The pages are the nodes of a tree, as `nav()` reads them (a page and the directory it is the
//! index of are one node; a directory with no index page is a node of its own, with no page).
//! The children of a node are put in the order of their `order` (the meta key, read as
//! [`order_of`] reads it), and a child with the same `order` as another goes by the natural order
//! of its URL ([`crate::natural`]). The plan lists the tree depth first: a node, then its
//! children, each with its own.
//!
//! Why the order of `pages.overrides` is not used: it is a list of what the file declares, which
//! is not a place a person can put a page in (a page file has no entry, and turning a page
//! virtual or giving it a file would move it).
//!
//! Why the pages are sorted by URL first: the natural order is not a total order (RFC §14.2), so
//! what a stable sort makes of a cycle depends on the order it was given. Given the pages by
//! their URLs, the result is the same whatever order the files were found in.

use std::cmp::Ordering;
use std::collections::HashMap;

use kd_jsonc::Value;
use kd_site::meta::Meta;

use crate::Page;
use crate::natural;

/// The meta key that places a page among its siblings (RFC §6).
pub(crate) const ORDER_KEY: &str = "order";

/// The value of the meta key `order` as the number that places the page, `0` for a page that
/// has none (RFC §6).
///
/// A number is its own value, and a string is read as JavaScript's `parseFloat` reads it. Any
/// other value, a missing key, and a number that is not finite (`NaN` and the infinities, which
/// `Number.isFinite` refuses) is `0`.
pub(crate) fn order_of(meta: &Meta) -> f64 {
	let value = meta.iter().find(|(k, _)| k == ORDER_KEY).map(|(_, v)| v);
	let number = match value {
		Some(Value::Number(n)) => *n,
		Some(Value::String(s)) => parse_float(s),
		_ => 0.0,
	};
	if number.is_finite() { number } else { 0.0 }
}

/// Whether `c` is skipped before a number by JavaScript's `parseFloat` (`WhiteSpace` and
/// `LineTerminator` of ECMA-262: not the same set as Rust's `char::is_whitespace`, which has
/// U+0085 and lacks U+FEFF).
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

/// JavaScript's `parseFloat` of a string: the longest prefix, after the spaces, that is a
/// decimal number (a sign, digits with a `.`, and an `e` exponent when digits follow it); `NaN`
/// when there is none. `Infinity` is not read (a caller that wants a finite number makes the
/// result `0`).
pub(crate) fn parse_float(text: &str) -> f64 {
	let s = text.trim_start_matches(is_js_space);
	let bytes = s.as_bytes();
	let digits = |from: usize| {
		bytes[from..]
			.iter()
			.take_while(|b| b.is_ascii_digit())
			.count()
	};
	let mut i = 0;
	if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
		i += 1;
	}
	let whole = digits(i);
	i += whole;
	let mut fraction = 0;
	if i < bytes.len() && bytes[i] == b'.' {
		fraction = digits(i + 1);
		// A `.` with no digit on either side is no number.
		if whole > 0 || fraction > 0 {
			i += 1 + fraction;
		}
	}
	if whole == 0 && fraction == 0 {
		return f64::NAN;
	}
	if i < bytes.len() && (bytes[i] == b'e' || bytes[i] == b'E') {
		let mut j = i + 1;
		if j < bytes.len() && (bytes[j] == b'+' || bytes[j] == b'-') {
			j += 1;
		}
		let exponent = digits(j);
		if exponent > 0 {
			i = j + exponent;
		}
	}
	s[..i].parse::<f64>().unwrap_or(f64::NAN)
}

/// A node of the tree: a page (or several, when their URLs name the same node) or a directory
/// that has none.
struct Node {
	/// The pages that are the node (indices of the pages), by URL.
	pages: Vec<usize>,
	/// The children, by name until they are put in their order.
	children: Vec<usize>,
	/// The place of the node among its siblings.
	order: f64,
	/// The name of the node (`kd_site::url_stem`).
	stem: String,
}

/// Puts `pages` in the order of the plan (see the module's comment): the order of `pages` and
/// `nav()`.
pub(crate) fn arrange(pages: Vec<Page>) -> Vec<Page> {
	if pages.len() < 2 {
		return pages;
	}
	// By URL first, so that the result does not depend on the order the pages were found in.
	let mut by_url: Vec<usize> = (0..pages.len()).collect();
	by_url.sort_by(|&a, &b| pages[a].file.url.cmp(&pages[b].file.url));

	let mut nodes: Vec<Node> = Vec::new();
	let mut at: HashMap<String, usize> = HashMap::new();
	for &i in &by_url {
		let stem = kd_site::url_stem(&pages[i].file.url);
		let node = *at.entry(stem.clone()).or_insert_with(|| {
			nodes.push(Node {
				pages: Vec::new(),
				children: Vec::new(),
				order: 0.0,
				stem,
			});
			nodes.len() - 1
		});
		nodes[node].pages.push(i);
	}
	// The place of a node is the one of its first page (by URL).
	for node in &mut nodes {
		node.order = order_of(&pages[node.pages[0]].meta);
	}
	// A node hangs from the node above it, which, for a directory with no index page, is made
	// here (and looked at in its turn, up to the root).
	let mut parent_of: Vec<Option<usize>> = Vec::new();
	let mut k = 0;
	while k < nodes.len() {
		let above = kd_site::url_depth_and_parent(&nodes[k].stem).1;
		// The root has no node above it.
		let parent = above.map(|stem| {
			*at.entry(stem.clone()).or_insert_with(|| {
				nodes.push(Node {
					pages: Vec::new(),
					children: Vec::new(),
					order: 0.0,
					stem,
				});
				nodes.len() - 1
			})
		});
		parent_of.push(parent);
		k += 1;
	}
	debug_assert_eq!(parent_of.len(), nodes.len());

	// By name, so that what is put in its order next starts from the same order whatever the
	// order the pages came in.
	let mut by_stem: Vec<usize> = (0..nodes.len()).collect();
	by_stem.sort_by(|&a, &b| nodes[a].stem.cmp(&nodes[b].stem));
	let mut roots: Vec<usize> = Vec::new();
	for &node in &by_stem {
		match parent_of[node] {
			Some(parent) => nodes[parent].children.push(node),
			None => roots.push(node),
		}
	}

	let keys: Vec<natural::Path> = nodes.iter().map(|n| natural::Path::new(&n.stem)).collect();
	let compare = |a: &usize, b: &usize| -> Ordering {
		nodes[*a]
			.order
			.partial_cmp(&nodes[*b].order)
			.unwrap_or(Ordering::Equal)
			.then_with(|| natural::path(&keys[*a], &keys[*b]))
	};
	// The children of each node are put in their order (`sort_stable` ends whatever the
	// comparison says; Rust's `sort_by` may panic on one that is not a total order).
	let mut sorted_children: Vec<Vec<usize>> = Vec::with_capacity(nodes.len());
	for node in &nodes {
		let mut children = node.children.clone();
		natural::sort_stable(&mut children, compare);
		sorted_children.push(children);
	}
	natural::sort_stable(&mut roots, compare);

	// Depth first: a node, then each of its children with their own.
	let mut listed: Vec<usize> = Vec::with_capacity(pages.len());
	let mut stack: Vec<usize> = roots.into_iter().rev().collect();
	while let Some(node) = stack.pop() {
		listed.extend(nodes[node].pages.iter().copied());
		stack.extend(sorted_children[node].iter().rev().copied());
	}
	debug_assert_eq!(listed.len(), pages.len());
	let mut taken: Vec<Option<Page>> = pages.into_iter().map(Some).collect();
	listed.into_iter().filter_map(|i| taken[i].take()).collect()
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::collections::BTreeMap;

	fn page(url: &str, order: Option<Value>, is_virtual: bool) -> Page {
		let meta: Meta = order.map_or_else(Vec::new, |v| vec![("order".to_string(), v)]);
		Page {
			file: kd_site::PageFile {
				input_path: format!("/in{url}"),
				output_path: format!("/out{url}"),
				file_slug: String::new(),
				file_path_stem: String::new(),
				url: url.to_string(),
				extension: ".html".to_string(),
			},
			kind: crate::PageKind::Html,
			meta,
			body: None,
			body_pending: false,
			deps: BTreeMap::new(),
			is_virtual,
			lastmod: None,
		}
	}

	fn n(v: f64) -> Option<Value> {
		Some(Value::Number(v))
	}

	fn arranged(pages: Vec<Page>) -> Vec<String> {
		arrange(pages).iter().map(|p| p.file.url.clone()).collect()
	}

	#[test]
	fn a_site_with_no_order_is_listed_depth_first_in_the_natural_order() {
		let pages = vec![
			page("/a/b.html", None, false),
			page("/a/", None, false),
			page("/10.html", None, false),
			page("/", None, false),
			page("/2.html", None, false),
			page("/a/c/", None, false),
		];
		assert_eq!(
			arranged(pages),
			["/", "/2.html", "/10.html", "/a/", "/a/b.html", "/a/c/"]
		);
	}

	#[test]
	fn order_places_the_children_of_a_node_and_only_those() {
		let pages = vec![
			page("/", None, false),
			page("/a.html", n(3.0), false),
			page("/b.html", n(1.0), false),
			page("/c/", n(2.0), false),
			page("/c/x.html", n(9.0), false),
			page("/c/y.html", n(5.0), false),
		];
		assert_eq!(
			arranged(pages),
			["/", "/b.html", "/c/", "/c/y.html", "/c/x.html", "/a.html"]
		);
	}

	#[test]
	fn a_page_with_no_order_is_zero_so_negative_goes_before_and_positive_after() {
		let pages = vec![
			page("/", None, false),
			page("/a.html", n(1.0), false),
			page("/b.html", None, false),
			page("/c.html", n(-1.0), false),
			page("/d.html", n(0.0), false),
		];
		assert_eq!(
			arranged(pages),
			["/", "/c.html", "/b.html", "/d.html", "/a.html"]
		);
	}

	#[test]
	fn the_same_order_goes_by_the_natural_order_of_the_url() {
		let pages = vec![
			page("/", None, false),
			page("/10.html", n(1.0), false),
			page("/2.html", n(1.0), false),
			page("/a/", n(1.0), false),
		];
		assert_eq!(arranged(pages), ["/", "/2.html", "/10.html", "/a/"]);
	}

	#[test]
	fn a_directory_is_placed_by_its_index_page_and_one_without_is_zero() {
		let pages = vec![
			page("/", None, false),
			page("/a/", n(5.0), true),
			page("/a/x.html", n(-9.0), false),
			page("/b/y.html", n(-9.0), false),
			page("/c.html", n(1.0), false),
		];
		// `/b/` has no page, so it is 0 whatever the page in it says; `/a/` is 5 whatever the
		// page in it says.
		assert_eq!(
			arranged(pages),
			["/", "/b/y.html", "/c.html", "/a/", "/a/x.html"]
		);
	}

	#[test]
	fn the_order_the_pages_are_given_in_does_not_matter() {
		let make = || {
			vec![
				page("/", None, false),
				page("/a/", n(2.0), false),
				page("/a/b.html", None, false),
				page("/a/c.html", None, false),
				page("/z.html", n(1.0), false),
				page("/y/", None, true),
				page("/y/k.html", None, false),
			]
		};
		let want = arranged(make());
		let mut reversed = make();
		reversed.reverse();
		assert_eq!(arranged(reversed), want);
		let mut rotated = make();
		rotated.rotate_left(3);
		assert_eq!(arranged(rotated), want);
	}

	#[test]
	fn the_root_has_no_siblings_so_its_order_changes_nothing() {
		let pages = vec![page("/a.html", None, false), page("/", n(99.0), false)];
		assert_eq!(arranged(pages), ["/", "/a.html"]);
	}

	#[test]
	fn a_site_with_no_root_page_still_lists_its_pages() {
		let pages = vec![page("/b/", None, false), page("/a.html", None, false)];
		assert_eq!(arranged(pages), ["/a.html", "/b/"]);
	}

	#[test]
	fn two_pages_that_name_one_node_are_both_listed_before_what_hangs_from_it() {
		let pages = vec![
			page("/a/index.php", None, false),
			page("/a/", None, false),
			page("/a/x.html", None, false),
			page("/", None, false),
		];
		let out = arranged(pages);
		assert_eq!(out.len(), 4);
		assert_eq!(out[0], "/");
		assert_eq!(out[3], "/a/x.html");
	}

	#[test]
	fn virtual_and_real_pages_are_placed_alike() {
		let pages = vec![
			page("/", None, false),
			page("/v/", n(1.0), true),
			page("/r/", n(2.0), false),
			page("/w/", None, true),
		];
		assert_eq!(arranged(pages), ["/", "/w/", "/v/", "/r/"]);
	}

	#[test]
	fn order_is_read_as_a_number_the_way_parse_float_reads() {
		let read = |v: Value| order_of(&vec![("order".to_string(), v)]);
		assert_eq!(read(Value::Number(2.5)), 2.5);
		assert_eq!(read(Value::String("03".into())), 3.0);
		assert_eq!(read(Value::String(" 2.5 ".into())), 2.5);
		assert_eq!(read(Value::String("1e3".into())), 1000.0);
		assert_eq!(read(Value::String("-4abc".into())), -4.0);
		assert_eq!(read(Value::String(".5".into())), 0.5);
		assert_eq!(read(Value::String("5.".into())), 5.0);
		assert_eq!(read(Value::String("1e".into())), 1.0);
		assert_eq!(read(Value::String("0x10".into())), 0.0);
		assert_eq!(read(Value::String("abc".into())), 0.0);
		assert_eq!(read(Value::String(String::new())), 0.0);
		assert_eq!(read(Value::String("Infinity".into())), 0.0);
		assert_eq!(read(Value::String("1e999".into())), 0.0);
		assert_eq!(read(Value::String("３".into())), 0.0);
		assert_eq!(read(Value::Bool(true)), 0.0);
		assert_eq!(read(Value::Null), 0.0);
		assert_eq!(read(Value::Array(vec![Value::Number(1.0)])), 0.0);
		assert_eq!(order_of(&Vec::new()), 0.0);
	}

	/// `tests/order_golden.tsv`: a line `string<TAB>number` per value, made by
	/// `scripts/generate-order-golden.mjs` from the engine's own
	/// `Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0` (the string is JSON).
	#[test]
	fn strings_are_read_as_the_engine_reads_them() {
		let text = include_str!("../tests/order_golden.tsv");
		let mut checked = 0;
		for line in text.lines() {
			let (json, want) = line
				.split_once('\t')
				.expect("a line is `string<TAB>number`");
			let Ok(Value::String(s)) = kd_jsonc::parse(json) else {
				panic!("the first field is a JSON string: {line:?}");
			};
			let want: f64 = want.parse().expect("the second field is a number");
			let got = order_of(&vec![("order".to_string(), Value::String(s.clone()))]);
			assert_eq!(got, want, "{s:?}");
			checked += 1;
		}
		assert!(checked > 100, "the golden has only {checked} values");
	}

	#[test]
	fn the_pages_of_one_directory_take_the_order_of_the_first_by_url() {
		// `/a/` comes before `/a/index.php` by the bytes of the URL: its order is the node's.
		let pages = vec![
			page("/z.html", n(3.0), false),
			page("/a/index.php", n(1.0), false),
			page("/a/", n(5.0), false),
			page("/a/x.html", None, false),
			page("/", None, false),
		];
		assert_eq!(
			arranged(pages),
			["/", "/z.html", "/a/", "/a/index.php", "/a/x.html"]
		);
		// and the other way round when the page with the smaller URL has the smaller number
		let pages = vec![
			page("/z.html", n(3.0), false),
			page("/a/index.php", n(9.0), false),
			page("/a/", n(1.0), false),
			page("/", None, false),
		];
		assert_eq!(arranged(pages), ["/", "/a/", "/a/index.php", "/z.html"]);
	}

	#[test]
	fn directories_with_no_page_above_a_page_are_nodes_of_their_own_all_the_way_up() {
		let pages = vec![
			page("/", None, false),
			page("/x/y/z.html", None, false),
			page("/x/w.html", n(-1.0), false),
			page("/b.html", n(1.0), false),
			page("/x/y/v/u.html", None, false),
		];
		// `/x/` and `/x/y/` have no page, so they are 0: `/x/` goes before `/b.html` (1), and in it
		// `/x/w.html` (-1) goes before `/x/y/`; in `/x/y/` the directory `v` and the file `z.html`
		// are two of the same order, so they go by the natural order of their URLs.
		assert_eq!(
			arranged(pages),
			["/", "/x/w.html", "/x/y/v/u.html", "/x/y/z.html", "/b.html"]
		);
	}

	#[test]
	fn siblings_in_a_cycle_of_the_natural_order_are_listed_the_same_whatever_came_first() {
		// `2a` < `10b` < `1c` < `2a` for the natural comparison of a pair.
		let urls = ["/2a.html", "/10b.html", "/1c.html", "/x.html"];
		let make = |order: &[usize]| -> Vec<Page> {
			let mut pages = vec![page("/", None, false)];
			pages.extend(order.iter().map(|&i| page(urls[i], None, false)));
			pages
		};
		let want = arranged(make(&[0, 1, 2, 3]));
		for order in [[3, 2, 1, 0], [1, 2, 3, 0], [2, 0, 3, 1], [1, 0, 2, 3]] {
			assert_eq!(arranged(make(&order)), want, "{order:?}");
		}
	}

	#[test]
	fn a_number_that_is_not_finite_is_zero_and_minus_zero_is_the_place_of_zero() {
		let read = |v: f64| order_of(&vec![("order".to_string(), Value::Number(v))]);
		assert_eq!(read(f64::NAN), 0.0);
		assert_eq!(read(f64::INFINITY), 0.0);
		assert_eq!(read(f64::NEG_INFINITY), 0.0);
		let pages = vec![
			page("/", None, false),
			page("/b.html", n(-0.0), false),
			page("/a.html", None, false),
			page("/c.html", n(0.0), false),
		];
		assert_eq!(arranged(pages), ["/", "/a.html", "/b.html", "/c.html"]);
	}
}
