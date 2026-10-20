//! Times the stages of the HTML chain on a directory of pages, one thread:
//! `cargo run --release -p kd_html --example stage_bench -- <dir> [limit]`.
//!
//! A development aid for finding where the per-page time goes; the numbers
//! are per page, averaged over the files read. Three lines come out: the
//! formatting with its steps, the minifier, and the DOM stage with the
//! encoding.

use std::fs;
use std::time::Instant;

// The allocator of the addon: with the system's, `malloc` and `free` are about
// half of what a profile shows, which is not what a build sees.
#[path = "../../kd_napi/src/alloc.rs"]
mod alloc;

#[global_allocator]
static ALLOCATOR: alloc::PoolAlloc = alloc::PoolAlloc;

use kd_html::encode::{self, Encoding};
use kd_html::minify::{self, NoMinification};
use kd_html::print;

fn collect(dir: &std::path::Path, out: &mut Vec<std::path::PathBuf>, limit: usize) {
	let Ok(entries) = fs::read_dir(dir) else {
		return;
	};
	let mut entries: Vec<_> = entries.filter_map(Result::ok).collect();
	entries.sort_by_key(|e| e.file_name());
	for e in entries {
		if out.len() >= limit {
			return;
		}
		let path = e.path();
		if path.is_dir() {
			collect(&path, out, limit);
		} else if path.extension().is_some_and(|x| x == "html") {
			out.push(path);
		}
	}
}

fn main() {
	let mut args = std::env::args().skip(1);
	let dir = args.next().expect("a directory of .html files");
	let limit: usize = args.next().and_then(|n| n.parse().ok()).unwrap_or(2000);
	let mut files = Vec::new();
	collect(std::path::Path::new(&dir), &mut files, limit);
	let (names, pages): (Vec<&std::path::PathBuf>, Vec<String>) = files
		.iter()
		.filter_map(|p| fs::read_to_string(p).ok().map(|s| (p, s)))
		.unzip();
	assert!(!pages.is_empty(), "no .html files under {dir}");
	let bytes: usize = pages.iter().map(String::len).sum();
	println!("{} pages, {} bytes", pages.len(), bytes);

	let options = print::Options {
		tab_width: 2,
		use_tabs: true,
		bracket_same_line: true,
		..print::Options::default()
	};
	let min = minify::Options {
		collapse_boolean_attributes: true,
		remove_redundant_attributes: true,
		remove_script_type_attributes: true,
		remove_style_link_type_attributes: true,
		minify_css: false,
		minify_js: false,
	};
	let per_page = |nanos: u128, pages: usize| nanos as f64 / 1000.0 / pages.max(1) as f64;

	// `REPEAT=n` runs the formatting n times, long enough for a sampling
	// profiler to look at it. The other measurements run once, after it, so
	// they see the allocator warmed up the way a build does.
	let repeat: usize = std::env::var("REPEAT")
		.ok()
		.and_then(|n| n.parse().ok())
		.unwrap_or(1);
	let t = Instant::now();
	let mut formatted = Vec::with_capacity(pages.len());
	let mut did_not_format = Vec::with_capacity(pages.len());
	for _ in 0..repeat {
		formatted.clear();
		did_not_format.clear();
		for p in &pages {
			let out = print::format(p, &options);
			did_not_format.push(out.is_err());
			formatted.push(out.unwrap_or_default());
		}
	}
	let failed = did_not_format.iter().filter(|&&f| f).count();
	if failed > 0 {
		// Their output is an empty string below (and in the files `DUMP` writes).
		println!("{failed} pages did not format");
	}
	let format_us = per_page(t.elapsed().as_nanos(), pages.len() * repeat);

	// `DUMP=<dir>` keeps the output of `format` so that two builds can be compared byte for
	// byte; `index.txt` says which page each `<n>.html` is, for when they differ.
	if let Ok(dump) = std::env::var("DUMP") {
		let dump = std::path::Path::new(&dump);
		fs::create_dir_all(dump).expect("create the DUMP directory");
		let mut index = String::new();
		for (n, out) in formatted.iter().enumerate() {
			fs::write(dump.join(format!("{n}.html")), out).expect("write a formatted page");
			let mark = if did_not_format[n] {
				"\t(did not format)"
			} else {
				""
			};
			index.push_str(&format!("{n}\t{}{mark}\n", names[n].display()));
		}
		fs::write(dump.join("index.txt"), index).expect("write the index");
	}

	// Inside `format`: its steps timed one by one (parse into the tree,
	// white-space preprocessing, building the printer's document, printing it,
	// dropping what was built). They repeat what `print::format` calls, minus
	// its byte order mark and line-end handling, so they have to follow it by
	// hand; `steps` is the sum, to be read next to `format`.
	let mut parts = [0u128; 5];
	let mut timed = 0usize;
	for p in &pages {
		let t = Instant::now();
		let Ok(mut tree) = print::ast::build(p) else {
			continue;
		};
		timed += 1;
		parts[0] += t.elapsed().as_nanos();
		let t = Instant::now();
		print::preprocess::run(&mut tree, options.whitespace_sensitivity);
		parts[1] += t.elapsed().as_nanos();
		let t = Instant::now();
		let mut docs =
			print::doc::Docs::with_capacity(tree.node_count().saturating_mul(print::DOCS_PER_NODE));
		let root = print::printer::print_root(
			&tree,
			&mut docs,
			print::printer::Settings {
				tab_width: options.tab_width,
				bracket_same_line: options.bracket_same_line,
				single_attribute_per_line: options.single_attribute_per_line,
				hug_script: options.hug_script,
				hug_style: options.hug_style,
				compact_tags: options.compact_tags,
			},
		);
		parts[2] += t.elapsed().as_nanos();
		let t = Instant::now();
		let out = print::doc::print(
			&mut docs,
			root,
			print::doc::PrintOptions {
				tab_width: options.tab_width,
				use_tabs: options.use_tabs,
				glue_markers: options.compact_tags,
				capacity: print::output_capacity(p.len()),
			},
		);
		parts[3] += t.elapsed().as_nanos();
		let t = Instant::now();
		drop(tree);
		drop(docs);
		drop(std::hint::black_box(out));
		parts[4] += t.elapsed().as_nanos();
	}
	let steps: u128 = parts.iter().sum();
	println!(
		"format {format_us:.0}µs/page = parse {:.0} + preprocess {:.0} + build doc {:.0} + print doc {:.0} + drop {:.0} (steps sum {:.0}µs, {timed} pages timed)",
		per_page(parts[0], timed),
		per_page(parts[1], timed),
		per_page(parts[2], timed),
		per_page(parts[3], timed),
		per_page(parts[4], timed),
		per_page(steps, timed),
	);

	let t = Instant::now();
	let mut total = 0;
	for p in &formatted {
		total += minify::minify(p, &min, &NoMinification)
			.map(|s| s.len())
			.unwrap_or(0);
	}
	let minify_us = per_page(t.elapsed().as_nanos(), pages.len());
	println!("minify {minify_us:.0}µs/page ({total} bytes out)");

	// The DOM stage without includes, rules and the like: parse into the tree,
	// serialize it and drop the tree. Then the encoding of what came out: a
	// copy for UTF-8, a conversion for Shift_JIS (characters it lacks are
	// reported, not failed).
	let serialize_options = kd_html::serialize::Options::default();
	let t = Instant::now();
	let mut serialized = Vec::with_capacity(pages.len());
	for p in &pages {
		serialized.push(kd_html::page::Page::parse(p).serialize_with(&serialize_options));
	}
	let dom_us = per_page(t.elapsed().as_nanos(), pages.len());
	let mut encoded = [0.0; 2];
	for (slot, encoding) in [Encoding::Utf8, Encoding::ShiftJis].into_iter().enumerate() {
		let t = Instant::now();
		for s in &serialized {
			drop(std::hint::black_box(encode::encode_reporting(s, encoding)));
		}
		encoded[slot] = per_page(t.elapsed().as_nanos(), pages.len());
	}
	println!(
		"dom (parse + serialize + drop) {dom_us:.0}µs/page, encode utf8 {:.0}µs, shift_jis {:.0}µs",
		encoded[0], encoded[1]
	);

	// The two ways of doing the HTML stages with the minifier on, one after the
	// other for each page so that the load of the machine falls on both: the
	// minifier on the formatted text (parse, serialize, format, minify), and on
	// the tree (parse, minify the tree, serialize, format with compact tags).
	let compact_options = print::Options {
		hug_script: true,
		hug_style: true,
		compact_tags: true,
		..options
	};
	let on_tree_options = kd_html::serialize::Options {
		bare_booleans: true,
		..kd_html::serialize::Options::default()
	};
	let (mut on_text, mut on_tree) = (0u128, 0u128);
	let mut same = 0usize;
	for p in &pages {
		let t = Instant::now();
		let html = kd_html::page::Page::parse(p).serialize_with(&serialize_options);
		let formatted = print::format(&html, &options).unwrap_or_default();
		let a = minify::minify(&formatted, &min, &NoMinification).unwrap_or_default();
		on_text += t.elapsed().as_nanos();

		let t = Instant::now();
		let mut page = kd_html::page::Page::parse(p);
		let _ = minify::apply_to_dom(&mut page.doc, &min, &NoMinification);
		let html = page.serialize_with(&on_tree_options);
		let b = print::format(&html, &compact_options).unwrap_or_default();
		on_tree += t.elapsed().as_nanos();
		same += usize::from(a == b);
	}
	println!(
		"minifier on text {:.0}µs/page, on the tree {:.0}µs/page ({same} of {} pages give the same bytes)",
		per_page(on_text, pages.len()),
		per_page(on_tree, pages.len()),
		pages.len()
	);
}
