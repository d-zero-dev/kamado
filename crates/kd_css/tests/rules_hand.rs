//! Tests of the rule families that are written by hand: the generator of
//! `rules.rs` (`scripts/generate-css-rule-tests.mjs`) overwrites that file, so
//! a test written by hand lives here. Some of its cases are also among the
//! generated `adjacent_blocks`; these two keep the explanations of the cases.
//! Every case is a style sheet and what cssnano makes of it; `kd_css` must give
//! the same, unless the case is listed in `common::DECISIONS` with both
//! answers.

mod common;

#[test]
fn adjacent_media_blocks_with_the_same_condition_become_one() {
	common::check_all(&[
		(
			"@media a{.a{x:1}}@media a{.b{y:2}}",
			"@media a{.a{x:1}.b{y:2}}",
		),
		(
			"@media a{.a{x:1}}.c{z:3}@media a{.d{w:4}}",
			"@media a{.a{x:1}}.c{z:3}@media a{.d{w:4}}",
		),
	]);
}

#[test]
fn adjacent_blocks_take_the_rules_of_the_next_one_when_the_rules_are_neighbours() {
	common::check_all(&[
		// A named layer is joined like a conditional group rule.
		(
			"@layer y{.a{x:1}}@layer y{.b{y:2}}",
			"@layer y{.a{x:1}.b{y:2}}",
		),
		(
			"@layer y.p{.a{x:1}}@layer y.p{.b{y:2}}",
			"@layer y.p{.a{x:1}.b{y:2}}",
		),
		// Another name, or a name in another case, is another layer.
		(
			"@layer y{.a{x:1}}@layer z{.b{y:2}}",
			"@layer y{.a{x:1}}@layer z{.b{y:2}}",
		),
		(
			"@layer Y{.a{x:1}}@layer y{.b{y:2}}",
			"@layer Y{.a{x:1}}@layer y{.b{y:2}}",
		),
		// Only the rules move: what else the block holds stays where it is.
		(
			"@layer y{.a{x:1}}@layer y{.b{y:2}@layer p, q}",
			"@layer y{.a{x:1}.b{y:2}}@layer y{@layer p, q}",
		),
		(
			"@layer y{.a{x:1}}@layer y{@font-face{font-family:a}.b{y:2}}",
			"@layer y{.a{x:1}.b{y:2}}@layer y{@font-face{font-family:a}}",
		),
		(
			"@layer y{@layer p, q}@layer y{.c{x:1}}@layer y{.b{y:2}}",
			"@layer y{@layer p, q}@layer y{.c{x:1}.b{y:2}}",
		),
		// A rule of a nested block is not next to a rule of the block before.
		(
			"@layer y{.a{x:1}@layer p{.z{x:1}}}@layer y{.b{y:2}}",
			"@layer y{.a{x:1}@layer p{.z{x:1}}}@layer y{.b{y:2}}",
		),
		(
			"@media screen{@media print{.c{x:1}}}@media screen{.b{y:2}}",
			"@media screen{@media print{.c{x:1}}}@media screen{.b{y:2}}",
		),
		(
			"@media a{.a{x:1}}@media a{@media b{.b{y:2}}}",
			"@media a{.a{x:1}}@media a{@media b{.b{y:2}}}",
		),
		(
			"@media screen{@layer a{@media print{@layer b{.c{x:1}}}}}@media screen{@layer a{.b{y:2}}}",
			"@media screen{@layer a{@media print{@layer b{.c{x:1}}}}}@media screen{@layer a{.b{y:2}}}",
		),
		// `@supports` and `@container` are joined like `@media`.
		(
			"@supports (display:grid){.a{x:1}}@supports (display:grid){.b{y:2}}",
			"@supports (display:grid){.a{x:1}.b{y:2}}",
		),
		(
			"@container (min-width:1px){.a{x:1}}@container (min-width:1px){.b{y:2}}",
			"@container (min-width:1px){.a{x:1}.b{y:2}}",
		),
		// The rules go up to the first nested block that holds a rule.
		(
			"@media a{.a{x:1}}@media a{.b{y:2}@media b{.c{z:3}}.d{w:4}}",
			"@media a{.a{x:1}.b{y:2}}@media a{@media b{.c{z:3}}.d{w:4}}",
		),
		// Each anonymous layer is a layer of its own.
		(
			"@layer{.a{x:1}}@layer{.b{y:2}}",
			"@layer{.a{x:1}}@layer{.b{y:2}}",
		),
	]);
}

#[test]
fn a_decision_does_not_apply_to_a_longer_property_or_value() {
	// The input has the fragment of a decision, the output only a longer
	// property or value that contains it.
	for (input, output) in [
		("a{height:0%;max-height:0%}", "a{height:0;max-height:0%}"),
		("a{width:0%;min-width:0%}", "a{width:0;min-width:0%}"),
		("a{width:0%;border-width:0%}", "a{width:0;border-width:0%}"),
		("a{top:0%}b{padding-top:0%}", "a{top:0}b{padding-top:0%}"),
		(
			"a{opacity:initial}b{fill-opacity:initial}",
			"a{opacity:1}b{fill-opacity:initial}",
		),
		(
			"a{animation-name:RED}b{animation-name:REDS}",
			"a{animation-name:red}b{animation-name:REDS}",
		),
		(
			"a{animation-name:RED}b{--my-animation-name:RED}",
			"a{animation-name:red}b{--my-animation-name:RED}",
		),
		(
			"a{border-width:0px 0% 0em}b{mask-border-width:0px 0% 0em}",
			"a{border-width:0}b{mask-border-width:0 0 0}",
		),
	] {
		let (undone, used) = common::undo_decisions(input, output);
		assert_eq!((undone.as_str(), used), (output, Vec::new()), "{input}");
	}
}

#[test]
fn the_properties_of_mdn_data_have_their_values_rewritten() {
	common::check_all(&[
		("a{stroke-color:RED}", "a{stroke-color:red}"),
		(
			"a{corner-shape:superellipse(2.0)}",
			"a{corner-shape:superellipse(2)}",
		),
		("a{text-box-edge:0px}", "a{text-box-edge:0}"),
	]);
}

#[test]
fn a_property_that_mdn_data_no_longer_lists_keeps_having_its_value_rewritten() {
	// cssnano rewrites the value of every property, so dropping a name would
	// widen the difference from it.
	common::check_all(&[
		("a{azimuth:0px}", "a{azimuth:0}"),
		("a{image-region:0px}", "a{image-region:0}"),
		("a{input-security:RED}", "a{input-security:red}"),
	]);
}
