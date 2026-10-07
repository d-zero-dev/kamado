//! Cases where minifying must not change what the browser does, written by hand (the
//! generated cases compare with cssnano, which does change some of these).

#[test]
fn a_rule_that_declares_a_layer_is_not_removed_as_a_duplicate() {
	// Dropping the first `@supports` would move the first mention of layer `a` after
	// `b`, and the order of the layers decides which of the two paragraphs colours wins.
	let css = "@supports (display:block){@layer a;} @layer b; @supports (display:block){@layer a;} \
	           @layer a{p{color:red}} @layer b{p{color:blue}}";

	let out = kd_css::minify(css).unwrap();

	assert_eq!(
		out.matches("@supports (display:block){@layer a}").count(),
		2,
		"{out}"
	);
	assert!(
		out.find("@layer a}").unwrap() < out.find("@layer b;").unwrap(),
		"{out}"
	);
}

#[test]
fn a_duplicate_without_a_layer_is_still_removed() {
	let css = "@media (min-width:1px){a{color:red}} @media (min-width:1px){a{color:red}}";

	assert_eq!(
		kd_css::minify(css).unwrap(),
		"@media (min-width:1px){a{color:red}}"
	);
}
