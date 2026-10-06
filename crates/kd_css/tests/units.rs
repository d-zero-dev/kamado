//! Unit tests of the layers below the minifier: the tokenizer, the parser, the
//! value parser, and the public entry points. What the rules do to values is
//! tested against cssnano in `rules.rs` and `golden.rs`.

use kd_css::parse::{Body, Node, line_col, parse_declaration_list, parse_stylesheet};
use kd_css::token::{Kind, tokenize};
use kd_css::value::{parse, stringify};

fn kinds(src: &str) -> Vec<Kind> {
	tokenize(src).iter().map(|t| t.kind).collect()
}

const TRICKY: &[&str] = &[
	"",
	" ",
	"a{b:c}",
	"a { b : c ; } /* x */ d { e : f }",
	"/* unterminated",
	"a{b:\"unterminated",
	"a{b:'a\\\nb'}",
	"a{b:\"a\nb\"}",
	"a{b:url(x}",
	"a{b:url( \"x\" )}",
	"a{b:url(a b)}",
	"a{b:url(a\\)b)}",
	"a{b:url(a(b)}",
	"@media screen{a{b:c}",
	"<!-- a{b:c} -->",
	"a{b:1e3 -.5E-2 +.5 1.5.5 1e+ 1e}",
	".\\31 0{}",
	"#\\31 0{}",
	"a\\",
	"\\\n",
	"a{b:\u{e9}\u{3042}\u{1f600}}",
	"\u{feff}a{}",
	"a\u{0}b{c:d}",
	"a{b:c\r\n;\r\n}",
	"-->",
	"--a:b",
	"@-webkit-keyframes x{}",
	"U+26 u+0-7F U+4??",
	"\\0 a",
	"a{b:\\",
];

#[test]
fn the_tokens_tile_the_input_and_rebuild_it() {
	for src in TRICKY {
		let tokens = tokenize(src);
		let mut at = 0;
		for t in &tokens {
			assert_eq!(t.start, at, "gap before {t:?} in {src:?}");
			assert!(t.end > t.start, "empty token {t:?} in {src:?}");
			at = t.end;
		}
		assert_eq!(at, src.len(), "the tokens stop early in {src:?}");
		let rebuilt: String = tokens.iter().map(|t| t.text(src)).collect();
		assert_eq!(&rebuilt, src);
	}
}

#[test]
fn token_kinds_follow_css_syntax() {
	use Kind::*;
	assert_eq!(
		kinds("a{b:c}"),
		[Ident, LBrace, Ident, Colon, Ident, RBrace]
	);
	assert_eq!(kinds("@media"), [AtKeyword]);
	assert_eq!(kinds("#fff"), [Hash]);
	assert_eq!(
		kinds("12px 50% 1.5e3 -.5"),
		[
			Dimension, Whitespace, Percentage, Whitespace, Number, Whitespace, Number
		]
	);
	assert_eq!(kinds("rgb(0)"), [Function, Number, RParen]);
	assert_eq!(kinds("url(a.png)"), [Url]);
	assert_eq!(kinds("URL( a.png )"), [Url]);
	assert_eq!(kinds("url(\"a.png\")"), [Function, String, RParen]);
	assert_eq!(kinds("url(a b)"), [BadUrl]);
	assert_eq!(kinds("\"a\nb\""), [BadString, Whitespace, Ident, String]);
	assert_eq!(kinds("<!-- -->"), [Cdo, Whitespace, Cdc]);
	assert_eq!(kinds("/**/"), [Comment]);
	assert_eq!(
		kinds("a,b;c[d]"),
		[
			Ident, Comma, Ident, Semicolon, Ident, LBracket, Ident, RBracket
		]
	);
	assert_eq!(kinds("--x"), [Ident]);
	assert_eq!(kinds("-1"), [Number]);
	assert_eq!(kinds("- 1"), [Delim, Whitespace, Number]);
	assert_eq!(kinds("\\31 0"), [Ident]);
	assert_eq!(kinds("a\\\nb"), [Ident, Delim, Whitespace, Ident]);
}

#[test]
fn an_unterminated_string_comment_or_block_is_closed_at_the_end() {
	assert_eq!(kd_css::minify("a{b:\"c").unwrap(), "a{b:\"c\"}");
	assert_eq!(kd_css::minify("a{b:c").unwrap(), "a{b:c}");
	assert_eq!(kd_css::minify("a{b:c}/* x").unwrap(), "a{b:c}");
	assert_eq!(
		kd_css::minify("@media screen{a{b:c}").unwrap(),
		"@media screen{a{b:c}}"
	);
	assert_eq!(kd_css::minify("a{b:url(x").unwrap(), "a{b:url(x)}");
	assert_eq!(kd_css::minify("a{b:(c").unwrap(), "a{b:(c)}");
}

#[test]
fn a_qualified_rule_cut_short_is_dropped_and_an_at_rule_is_kept() {
	assert_eq!(kd_css::minify("a{b:c}d").unwrap(), "a{b:c}");
	assert_eq!(
		kd_css::minify("a{b:c}@import \"x\"").unwrap(),
		"a{b:c}@import \"x\""
	);
	// A prelude runs across `;` to the next `{`, as in a browser.
	assert_eq!(kd_css::minify("a{b:c};d{e:f}").unwrap(), "a{b:c};d{e:f}");
}

#[test]
fn nesting_keeps_rules_declarations_and_at_rules_in_order() {
	let out =
		kd_css::minify(".a{color:red;&:hover{color:blue}@media (width>=1px){color:green}margin:0}")
			.unwrap();
	assert_eq!(
		out,
		".a{color:red;&:hover{color:blue}@media (width>=1px){color:green}margin:0}"
	);
}

#[test]
fn the_tree_has_offsets_that_map_to_lines_and_columns() {
	let src = "a{b:c}\n  @media x{\n    d{e:f}\n  }";
	let sheet = parse_stylesheet(src);
	assert_eq!(sheet.nodes.len(), 2);
	let Node::Rule(rule) = &sheet.nodes[0] else {
		panic!("a rule")
	};
	assert_eq!(line_col(src, rule.offset), (1, 1));
	let Node::Declaration(d) = &rule.nodes[0] else {
		panic!("a declaration")
	};
	assert_eq!(line_col(src, d.offset), (1, 3));
	let Node::AtRule(at) = &sheet.nodes[1] else {
		panic!("an at-rule")
	};
	assert_eq!(line_col(src, at.offset), (2, 3));
	let Body::Nodes(inner) = &at.body else {
		panic!("a block")
	};
	let Node::Rule(inner_rule) = &inner[0] else {
		panic!("a rule")
	};
	assert_eq!(line_col(src, inner_rule.offset), (3, 5));
}

#[test]
fn the_parser_keeps_unknown_at_rules_and_custom_properties_as_written() {
	let sheet =
		parse_stylesheet("@unknown  x { a : b ; { c } }\n:root{--x:  1px /* c */  2px ;--y:{a:b}}");
	let Node::AtRule(at) = &sheet.nodes[0] else {
		panic!("an at-rule")
	};
	assert_eq!(at.name, "unknown");
	assert_eq!(at.prelude, "x");
	assert!(matches!(&at.body, Body::Raw(raw) if raw == "a : b ; { c }"));
	let Node::Rule(rule) = &sheet.nodes[1] else {
		panic!("a rule")
	};
	let values: Vec<&str> = rule
		.nodes
		.iter()
		.filter_map(|n| match n {
			Node::Declaration(d) => Some(d.value.as_str()),
			_ => None,
		})
		.collect();
	assert_eq!(values, ["1px /* c */  2px", "{a:b}"]);
}

#[test]
fn important_is_a_flag_and_not_part_of_the_value() {
	for src in [
		"a:b!important",
		"a:b ! important",
		"a:b !IMPORTANT",
		"a:b/* c */!important/* d */",
	] {
		let decls = parse_declaration_list(src);
		assert_eq!(decls.len(), 1, "{src}");
		assert!(decls[0].important, "{src}");
		assert_eq!(decls[0].value, "b", "{src}");
	}
	assert!(!parse_declaration_list("a:b!ie")[0].important);
}

#[test]
fn a_style_attribute_keeps_only_declarations() {
	let decls = parse_declaration_list("color:red;a{b:c};@media x{d:e};margin:0;nonsense;");
	let names: Vec<&str> = decls.iter().map(|d| d.property.as_str()).collect();
	assert_eq!(names, ["color", "margin"]);
	assert_eq!(
		kd_css::minify_declarations("color : #FF0000 ;  margin : 0px  0px ").unwrap(),
		"color:red;margin:0"
	);
	assert_eq!(kd_css::minify_declarations("").unwrap(), "");
	assert_eq!(
		kd_css::minify_declarations("color:red;color:red").unwrap(),
		"color:red"
	);
}

#[test]
fn a_media_attribute_is_minified_like_an_at_media_prelude() {
	assert_eq!(
		kd_css::minify_media_query("  screen  and ( min-width : 100px ) "),
		"screen and (min-width:100px)"
	);
	assert_eq!(kd_css::minify_media_query("print , screen"), "print,screen");
	assert_eq!(kd_css::minify_media_query("all"), "");
	assert_eq!(kd_css::minify_media_query(""), "");
	assert_eq!(
		kd_css::minify_media_query("(min-aspect-ratio: 32/18)"),
		"(min-aspect-ratio:16/9)"
	);
}

#[test]
fn the_value_parser_prints_back_what_it_read() {
	for src in [
		"1px solid red",
		"a , b / c : d",
		"rgb( 0 , 0 , 0 )",
		"url( a b.png )",
		"url(\"a\")",
		"calc(1px+2px) calc( 1px  *  2 )",
		"\"a\" 'b' \"unterminated",
		"/* c */ a /* d */",
		"U+0025-00FF, u+4??",
		"a(b(c(d)))",
		"(unclosed",
		"a\\ b \\\" c",
		"f(,)",
		"",
	] {
		assert_eq!(stringify(&parse(src)), src, "{src:?}");
	}
}

#[test]
fn the_colour_name_table_is_sorted_for_the_binary_search() {
	let names: Vec<&str> = {
		let mut v = Vec::new();
		for n in [
			"aliceblue",
			"yellowgreen",
			"rebeccapurple",
			"lightgoldenrodyellow",
			"darkslategray",
		] {
			assert!(kd_css::color::is_color(n), "{n}");
			v.push(n);
		}
		v
	};
	assert_eq!(names.len(), 5);
	assert!(!kd_css::color::is_color("grey"));
	assert!(!kd_css::color::is_color("transparent"));
}

#[test]
fn nothing_is_lost_in_a_large_minified_output_and_it_is_stable() {
	let mut css = String::new();
	for i in 0..2000 {
		css.push_str(&format!(
			".c{i} > a:hover, .d{i}::before {{ margin: 0px {i}px; color: #FF{:02X}00 }}\n",
			i % 256
		));
	}
	let once = kd_css::minify(&css).unwrap();
	assert_eq!(kd_css::minify(&once).unwrap(), once);
	assert!(
		once.starts_with(
			".c0>a:hover,.d0:before{margin:0;color:red}.c1>a:hover,.d1:before{margin:0 1px;color:#ff0100}"
		),
		"{}",
		&once[..120]
	);
}

#[test]
fn pathological_nesting_neither_overflows_the_stack_nor_takes_long() {
	let started = std::time::Instant::now();
	// Blocks nested too deep are refused.
	let deep = "a{".repeat(1000);
	let err = kd_css::minify(&deep).unwrap_err();
	assert!(err.message.contains("nested"), "{err}");
	assert_eq!((err.line, err.column > 0), (1, true));
	assert!(kd_css::minify(&"@media a{".repeat(1000)).is_err());
	// Everything else is walked without recursion, or with a limit.
	let parens = format!("a{{b:{}1{}}}", "f(".repeat(50_000), ")".repeat(50_000));
	assert!(kd_css::minify(&parens).unwrap().starts_with("a{b:f(f("));
	let calc = format!("a{{b:calc({}1px)}}", "- ".repeat(50_000));
	assert!(kd_css::minify(&calc).is_ok());
	let groups = format!(
		"a{{b:calc({}1px{})}}",
		"(".repeat(50_000),
		")".repeat(50_000)
	);
	assert!(kd_css::minify(&groups).is_ok());
	let nots = format!("a{}b{}{{x:y}}", ":not(".repeat(20_000), ")".repeat(20_000));
	assert!(kd_css::minify(&nots).is_ok());
	let list = format!("a{}{{x:y}}", ",a".repeat(50_000));
	assert_eq!(kd_css::minify(&list).unwrap(), "a{x:y}");
	assert_eq!(kd_css::minify(&"a{x:1}".repeat(20_000)).unwrap(), "a{x:1}");
	assert!(kd_css::minify(&"(".repeat(200_000)).is_ok());
	assert!(kd_css::minify(&format!("a{{b:{}", "(".repeat(200_000))).is_ok());
	assert!(
		started.elapsed().as_secs() < 30,
		"took {:?}",
		started.elapsed()
	);
}

#[test]
fn a_long_run_of_rules_with_the_same_declarations_is_merged_in_linear_time() {
	// With the selector list minified again at every step this took seconds
	// (24 s for 20000 rules in a release build).
	let count = 20_000;
	let source: String = (0..count).map(|i| format!(".c{i}{{color:red}}")).collect();
	let started = std::time::Instant::now();
	let out = kd_css::minify(&source).unwrap();
	assert!(started.elapsed().as_secs() < 5, "{:?}", started.elapsed());
	// One rule, its selectors sorted like cssnano sorts them.
	assert!(out.starts_with(".c0,.c1,.c10,.c100,"), "{}", &out[..40]);
	assert!(out.ends_with("{color:red}"));
	assert_eq!(out.matches("color:red").count(), 1);
	assert_eq!(out.matches(',').count(), count - 1);
}
