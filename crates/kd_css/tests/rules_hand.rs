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
