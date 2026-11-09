//! `kd_site::url_depth_and_parent` against the numbers the tree of the navigation
//! (`pathListToTree`) gives the same URLs: `tests/page_map_golden.tsv`, a line
//! `url<TAB>depth<TAB>parent` for each URL, made by `scripts/generate-page-map-golden.mjs`.
//! The map `kamado pages` writes and `nav()` must count the same way. What the file settles
//! is how deep a page is and which directory it hangs from; the parent is written as the
//! page's URL is, which the tree does not decide. File names with `?`, `#` or `\` are not in
//! it: the tree reads them as parts of a URL, the map as parts of a name.

use std::fs;
use std::path::PathBuf;

#[test]
fn every_url_has_the_depth_and_parent_the_navigation_tree_gives_it() {
	let file = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("page_map_golden.tsv");
	let text = fs::read_to_string(&file).unwrap();
	let mut checked = 0;
	for line in text.lines() {
		let f: Vec<&str> = line.split('\t').collect();
		assert_eq!(f.len(), 3, "a line is `url<TAB>depth<TAB>parent`: {line:?}");
		let depth: usize = f[1].parse().unwrap();
		let parent = (!f[2].is_empty()).then(|| f[2].to_string());
		assert_eq!(
			kd_site::url_depth_and_parent(f[0]),
			(depth, parent),
			"the depth and parent of {}",
			f[0]
		);
		checked += 1;
	}
	assert!(checked > 300, "the golden has only {checked} URLs");
}
