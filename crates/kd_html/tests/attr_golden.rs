//! Differential test against v2: every `tests/attr_golden/<case>.in` goes
//! through the operations of `<case>.ops` (`html.rules` and `html.imageSizes`)
//! and must come out as the bytes v2's DOM produced for them in `<case>.out`.
//! The corpus is made by `scripts/generate-html-attr-golden.mjs`.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;

use kd_html::image_sizes::{self, ImageSource};
use kd_html::page::Page;
use kd_html::rules::{self, Context, Rule};

const HOST: &str = "example.com";

fn golden_dir() -> PathBuf {
	PathBuf::from(env!("CARGO_MANIFEST_DIR"))
		.join("tests")
		.join("attr_golden")
}

/// Every `.svg` is `width` by `height`.
struct Svgs {
	width: String,
	height: String,
}

impl ImageSource for Svgs {
	fn read(&self, path: &str) -> Result<Option<Arc<[u8]>>, String> {
		Ok(path.ends_with(".svg").then(|| {
			Arc::from(
				format!(
					"<svg width=\"{}\" height=\"{}\"></svg>",
					self.width, self.height
				)
				.as_bytes(),
			)
		}))
	}
}

fn run(input: &str, ops: &str) -> String {
	let mut page = Page::parse(input);
	let ctx = Context {
		url: "/a/b/",
		base_url: "https://example.com/",
		host: HOST,
	};
	for line in ops.lines() {
		let f: Vec<&str> = line.split('\t').collect();
		assert!(f.len() >= 2, "malformed operation: {line:?}");
		match f[0] {
			"imageSizes" => {
				let source = Svgs {
					width: f[1].to_owned(),
					height: f[2].to_owned(),
				};
				let options = image_sizes::Options {
					root_dir: "/out",
					keep_authored: false,
					extensions: &image_sizes::DEFAULT_EXTENSIONS,
				};
				image_sizes::apply(&mut page, &options, &source).unwrap();
			}
			action => {
				let rule = match action {
					"setAttr" => Rule::set_attr(f[1], HOST, f[2], f[3]),
					"removeAttr" => Rule::remove_attr(f[1], HOST, f[2]),
					"addClass" => Rule::add_class(f[1], HOST, f[2]),
					"removeClass" => Rule::remove_class(f[1], HOST, f[2]),
					other => panic!("unknown operation {other}"),
				}
				.unwrap();
				rules::apply(&mut page, &[rule], &ctx).unwrap();
			}
		}
	}
	page.serialize()
}

#[test]
fn every_case_edits_attributes_as_v2_did() {
	let mut names: Vec<String> = fs::read_dir(golden_dir())
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort();
	assert!(!names.is_empty(), "the corpus is missing");

	let mut failures = Vec::new();
	for name in &names {
		let read =
			|ext: &str| fs::read_to_string(golden_dir().join(format!("{name}.{ext}"))).unwrap();
		let (input, ops, expected) = (read("in"), read("ops"), read("out"));
		let actual = run(&input, &ops);
		if actual != expected {
			failures.push(format!(
				"{name}\n  input:    {input:?}\n  ops:      {ops:?}\n  expected: {expected:?}\n  actual:   {actual:?}"
			));
		}
	}
	assert!(
		failures.is_empty(),
		"{} of {} cases differ from v2:\n{}",
		failures.len(),
		names.len(),
		failures.join("\n")
	);
}
