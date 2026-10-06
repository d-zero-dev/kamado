//! Times the stages of the HTML chain on a directory of pages, one thread:
//! `cargo run --release -p kd_html --example stage_bench -- <dir> [limit]`.
//!
//! A development aid for finding where the per-page time goes; the numbers
//! are per page, averaged over the files read.

use std::fs;
use std::time::Instant;

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
	let pages: Vec<String> = files
		.iter()
		.filter_map(|p| fs::read_to_string(p).ok())
		.collect();
	let bytes: usize = pages.iter().map(String::len).sum();
	println!("{} pages, {} bytes", pages.len(), bytes);

	let options = print::Options {
		print_width: 100_000,
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

	// `REPEAT=n` runs the formatting n times, long enough for a sampling
	// profiler to look at it.
	let repeat: usize = std::env::var("REPEAT")
		.ok()
		.and_then(|n| n.parse().ok())
		.unwrap_or(1);
	let t = Instant::now();
	let mut formatted = Vec::with_capacity(pages.len());
	for _ in 0..repeat {
		formatted.clear();
		for p in &pages {
			formatted.push(print::format(p, &options).unwrap_or_default());
		}
	}
	let format_us = t.elapsed().as_micros() as f64 / (pages.len() * repeat) as f64;

	let t = Instant::now();
	let mut total = 0;
	for p in &formatted {
		total += minify::minify(p, &min, &NoMinification)
			.map(|s| s.len())
			.unwrap_or(0);
	}
	let minify_us = t.elapsed().as_micros() as f64 / pages.len() as f64;
	println!("format {format_us:.0}µs/page, minify {minify_us:.0}µs/page ({total} bytes out)");
}
