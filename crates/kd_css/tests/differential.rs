//! Differential test of the minifier against cssnano. Ignored by default: it
//! needs the corpus that `scripts/fuzz-css.mjs` writes and the cssnano outputs
//! of `scripts/generate-css-oracle.mjs` (see `fuzz-css.mjs` for the commands).
//!
//! What it checks, over every `<n>.in` in `KD_CSS_DIR`:
//! - the size: the total, and every file, is at most 3 % larger than
//!   cssnano's output (with 8 bytes of slack for the very small files, whose
//!   3 % is less than a byte); a summary table is printed. A file whose
//!   difference from cssnano is entirely made of the decisions listed in
//!   `common::DECISIONS` (a custom property kept as written, a `0%` kept) is
//!   reported but not held to the bound: those decisions cost size on purpose;
//! - idempotence: minifying the output changes nothing;
//! - robustness: the corpus and 20000 byte-level mutations of it (truncation,
//!   flipped bytes, inserted `{`, `}`, `"`, `/*` and friends) are minified
//!   without a panic, and the tokenizer stays lossless on all of them.
//!
//! Equivalence (that the output means what the input meant) cannot be checked
//! here, as it needs cssnano and postcss: `scripts/check-css.mjs` does that.

#[allow(dead_code)]
mod common;

use std::fs;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

fn corpus() -> (PathBuf, Vec<String>) {
	let dir = PathBuf::from(std::env::var("KD_CSS_DIR").expect("set KD_CSS_DIR"));
	let mut names: Vec<String> = fs::read_dir(&dir)
		.unwrap()
		.map(|e| e.unwrap().file_name().into_string().unwrap())
		.filter_map(|n| n.strip_suffix(".in").map(str::to_owned))
		.collect();
	names.sort_by_key(|n| n.parse::<u64>().unwrap_or(u64::MAX));
	assert!(!names.is_empty(), "the corpus is empty");
	(dir, names)
}

#[test]
#[ignore = "needs KD_CSS_DIR, a corpus written by scripts/fuzz-css.mjs"]
fn sizes_are_close_to_cssnano_and_minifying_twice_changes_nothing() {
	let (dir, names) = corpus();
	let mut total_mine = 0usize;
	let mut total_theirs = 0usize;
	let mut total_original = 0usize;
	let mut rows: Vec<(f64, String, usize, usize, usize)> = Vec::new();
	let mut too_big = Vec::new();
	let mut deliberate = Vec::new();
	let mut not_idempotent = Vec::new();
	for name in &names {
		let input = fs::read_to_string(dir.join(format!("{name}.in"))).unwrap();
		let theirs = fs::read_to_string(dir.join(format!("{name}.out"))).unwrap();
		let mine = kd_css::minify(&input).expect("minify never fails on text of this size");
		let again = kd_css::minify(&mine).unwrap();
		if again != mine {
			not_idempotent.push(format!("{name}:\n  once:  {mine}\n  twice: {again}"));
		}
		if theirs == "__ERROR__" {
			continue;
		}
		total_mine += mine.len();
		total_theirs += theirs.len();
		total_original += input.len();
		let ratio = if theirs.is_empty() {
			1.0
		} else {
			mine.len() as f64 / theirs.len() as f64
		};
		rows.push((ratio, name.clone(), input.len(), theirs.len(), mine.len()));
		if mine.len() as f64 > theirs.len() as f64 * 1.03 + 8.0 {
			// Entirely explained by listed decisions?
			if mine != theirs && common::check(&input, &theirs).is_ok_and(|used| !used.is_empty()) {
				deliberate.push(name.clone());
				continue;
			}
			too_big.push(format!(
				"{name}: {} bytes against cssnano's {} ({ratio:.3})",
				mine.len(),
				theirs.len()
			));
		}
	}
	if !deliberate.is_empty() {
		println!(
			"larger than the bound by listed decisions only: {}",
			deliberate.join(", ")
		);
	}
	rows.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
	let median = rows[rows.len() / 2].0;
	println!("case      original   cssnano      mine   ratio (the 12 largest ratios)");
	for (ratio, name, original, theirs, mine) in rows.iter().rev().take(12) {
		println!("{name:<8} {original:>9} {theirs:>9} {mine:>9}   {ratio:.4}");
	}
	println!(
		"total    {total_original:>9} {total_theirs:>9} {total_mine:>9}   {:.4} (median per file {median:.4}; mine is {:.2} % of the original)",
		total_mine as f64 / total_theirs as f64,
		total_mine as f64 / total_original as f64 * 100.0
	);
	assert!(
		not_idempotent.is_empty(),
		"{} outputs change when minified again:\n{}",
		not_idempotent.len(),
		not_idempotent
			.iter()
			.take(5)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
	assert!(
		total_mine as f64 <= total_theirs as f64 * 1.03,
		"the total is {total_mine} bytes against cssnano's {total_theirs}"
	);
	assert!(
		too_big.is_empty(),
		"{} files are more than 3 % larger than cssnano's:\n{}",
		too_big.len(),
		too_big
			.iter()
			.take(20)
			.cloned()
			.collect::<Vec<_>>()
			.join("\n")
	);
}

#[test]
#[ignore = "needs KD_CSS_DIR and a release build: cargo test --release"]
fn throughput_of_the_tokenizer_and_the_minifier() {
	let (dir, names) = corpus();
	let mut all = String::new();
	'fill: loop {
		for name in &names {
			let input = fs::read_to_string(dir.join(format!("{name}.in"))).unwrap();
			// Only the style sheets that stand on their own: not the recovery
			// cases, which would swallow what follows them.
			let opens = input.matches('{').count();
			let closes = input.matches('}').count();
			if opens == closes && !input.contains(['\u{0}', '<']) {
				all.push_str(&input);
				all.push('\n');
			}
			if all.len() >= 24 << 20 {
				break 'fill;
			}
		}
	}
	let mb = all.len() as f64 / (1 << 20) as f64;
	let start = std::time::Instant::now();
	let tokens = kd_css::token::tokenize(&all);
	let tokenize = start.elapsed().as_secs_f64();
	let start = std::time::Instant::now();
	let sheet = kd_css::parse::parse_stylesheet(&all);
	let parse = start.elapsed().as_secs_f64();
	let start = std::time::Instant::now();
	let out = kd_css::minify(&all).unwrap();
	let minify = start.elapsed().as_secs_f64();
	println!(
		"{mb:.1} MiB: tokenizer {:.0} MiB/s ({} tokens), parser {:.0} MiB/s ({} top-level nodes), minify {:.1} MiB/s (to {:.1} MiB)",
		mb / tokenize,
		tokens.len(),
		mb / parse,
		sheet.nodes.len(),
		mb / minify,
		out.len() as f64 / (1 << 20) as f64
	);
	assert!(mb / tokenize >= 50.0, "tokenizer under 50 MiB/s");
}

/// A tiny deterministic generator.
struct Lcg(u64);

impl Lcg {
	fn next(&mut self) -> u64 {
		self.0 = self
			.0
			.wrapping_mul(6364136223846793005)
			.wrapping_add(1442695040888963407);
		self.0 >> 33
	}

	fn below(&mut self, n: usize) -> usize {
		(self.next() % n as u64) as usize
	}
}

fn mutate(rng: &mut Lcg, source: &[u8]) -> Vec<u8> {
	let mut b = source.to_vec();
	if b.is_empty() {
		return b;
	}
	for _ in 0..=rng.below(3) {
		match rng.below(5) {
			0 => {
				let at = rng.below(b.len());
				b.truncate(at);
			}
			1 => {
				let at = rng.below(b.len().max(1));
				if at < b.len() {
					b[at] ^= 1 << rng.below(8);
				}
			}
			2 => {
				let at = rng.below(b.len() + 1);
				let pieces: [&[u8]; 14] = [
					b"{", b"}", b"\"", b"'", b"/*", b"*/", b"(", b")", b";", b"\\", b"@", b"[",
					b"<!--", b"url(",
				];
				let p = pieces[rng.below(pieces.len())];
				b.splice(at..at, p.iter().copied());
			}
			3 => {
				let at = rng.below(b.len());
				let len = rng.below(8).min(b.len() - at);
				b.drain(at..at + len);
			}
			_ => {
				let at = rng.below(b.len());
				let len = rng.below(20).min(b.len() - at);
				let chunk: Vec<u8> = b[at..at + len].to_vec();
				let to = rng.below(b.len() + 1);
				b.splice(to..to, chunk);
			}
		}
		if b.is_empty() {
			break;
		}
	}
	b
}

fn exercise(text: &str) -> Result<(), String> {
	let tokens = kd_css::token::tokenize(text);
	let rebuilt: String = tokens.iter().map(|t| t.text(text)).collect();
	if rebuilt != text {
		return Err("the tokens do not rebuild the input".to_owned());
	}
	let mut expected_start = 0;
	for t in &tokens {
		if t.start != expected_start || t.end <= t.start {
			return Err("the tokens do not tile the input".to_owned());
		}
		expected_start = t.end;
	}
	let _ = kd_css::minify(text);
	let _ = kd_css::minify_declarations(text);
	let _ = kd_css::minify_media_query(text);
	Ok(())
}

#[test]
#[ignore = "needs KD_CSS_DIR, a corpus written by scripts/fuzz-css.mjs"]
fn nothing_panics_on_the_corpus_or_on_mutations_of_it() {
	let (dir, names) = corpus();
	let inputs: Vec<String> = names
		.iter()
		.map(|n| fs::read_to_string(dir.join(format!("{n}.in"))).unwrap())
		.collect();
	let mut failures = Vec::new();
	for (name, input) in names.iter().zip(&inputs) {
		let r = catch_unwind(AssertUnwindSafe(|| exercise(input)));
		match r {
			Ok(Ok(())) => {}
			Ok(Err(e)) => failures.push(format!("{name}: {e}")),
			Err(_) => failures.push(format!("{name}: panic")),
		}
	}
	let mut rng = Lcg(0x5eed);
	for i in 0..20000 {
		let source = &inputs[rng.below(inputs.len())];
		let mutated = mutate(&mut rng, source.as_bytes());
		let text = String::from_utf8_lossy(&mutated).into_owned();
		let r = catch_unwind(AssertUnwindSafe(|| exercise(&text)));
		match r {
			Ok(Ok(())) => {}
			Ok(Err(e)) => failures.push(format!("mutation {i}: {e}: {text:?}")),
			Err(_) => failures.push(format!("mutation {i}: panic on {text:?}")),
		}
		if failures.len() > 10 {
			break;
		}
	}
	assert!(
		failures.is_empty(),
		"{} failures:\n{}",
		failures.len(),
		failures.join("\n")
	);
}
