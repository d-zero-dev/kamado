//! The `srcset` parser prettier uses to format `img` and `source` attributes:
//! the HTML specification's algorithm for image candidate strings, plus the
//! checks that make prettier give up (and print the attribute as written):
//! an invalid descriptor, more than one kind of descriptor, no candidate.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Descriptor {
	Width,
	Height,
	Density,
}

impl Descriptor {
	#[must_use]
	pub fn unit(self) -> &'static str {
		match self {
			Descriptor::Width => "w",
			Descriptor::Height => "h",
			Descriptor::Density => "x",
		}
	}
}

#[derive(Debug, Clone, Default)]
pub struct Candidate {
	pub url: String,
	pub width: Option<u64>,
	pub height: Option<u64>,
	pub density: Option<f64>,
}

impl Candidate {
	/// The value of the descriptor of `kind`, as JavaScript's `String(value)`
	/// writes it; empty when the candidate has none.
	#[must_use]
	pub fn value_of(&self, kind: Descriptor) -> String {
		match kind {
			Descriptor::Width => self.width.map(|v| v.to_string()),
			Descriptor::Height => self.height.map(|v| v.to_string()),
			Descriptor::Density => self.density.map(js_number_to_string),
		}
		.unwrap_or_default()
	}
}

fn js_number_to_string(v: f64) -> String {
	if v.fract() == 0.0 && v.abs() < 1e21 {
		format!("{}", v as i64)
	} else {
		format!("{v}")
	}
}

fn is_ws(c: char) -> bool {
	matches!(c, ' ' | '\t' | '\n' | '\r' | '\u{0C}')
}

fn is_digits(s: &str) -> bool {
	!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `/^-?(?:[0-9]+|[0-9]*\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/`
fn is_float(s: &str) -> bool {
	let s = s.strip_prefix('-').unwrap_or(s);
	let (mantissa, exponent) = match s.find(['e', 'E']) {
		Some(i) => (&s[..i], Some(&s[i + 1..])),
		None => (s, None),
	};
	if let Some(exp) = exponent {
		let exp = exp.strip_prefix(['+', '-']).unwrap_or(exp);
		if !is_digits(exp) {
			return false;
		}
	}
	match mantissa.split_once('.') {
		None => is_digits(mantissa),
		Some((int, frac)) => (int.is_empty() || is_digits(int)) && is_digits(frac),
	}
}

/// Parses the descriptors collected for one candidate (`_()`).
fn finish_candidate(url: &str, descriptors: &[String]) -> Result<Candidate, String> {
	let mut invalid = false;
	let (mut width, mut density, mut height) = (None, None, None);
	for d in descriptors {
		let Some(last) = d.chars().last() else {
			invalid = true;
			continue;
		};
		let number = &d[..d.len() - last.len_utf8()];
		if is_digits(number) && last == 'w' {
			if width.is_some() || density.is_some() {
				invalid = true;
			}
			match number.parse::<u64>() {
				Ok(0) | Err(_) => invalid = true,
				Ok(v) => width = Some(v),
			}
		} else if is_float(number) && last == 'x' {
			if width.is_some() || density.is_some() || height.is_some() {
				invalid = true;
			}
			match number.parse::<f64>() {
				Ok(v) if v < 0.0 => invalid = true,
				Ok(v) => density = Some(v),
				Err(_) => invalid = true,
			}
		} else if is_digits(number) && last == 'h' {
			if height.is_some() || density.is_some() {
				invalid = true;
			}
			match number.parse::<u64>() {
				Ok(0) | Err(_) => invalid = true,
				Ok(v) => height = Some(v),
			}
		} else {
			invalid = true;
		}
	}
	if invalid {
		return Err(format!(
			"Invalid srcset descriptor found in \"{}\"",
			descriptors.join(" ")
		));
	}
	Ok(Candidate {
		url: url.to_owned(),
		// A zero is falsy in prettier: `f && …`; widths/heights of 0 are
		// invalid above, a density of 0 is kept out as well.
		width,
		height,
		density: density.filter(|d| *d != 0.0),
	})
}

/// Parses a `srcset` value.
///
/// # Errors
///
/// An invalid descriptor, or no candidate at all.
pub fn parse(input: &str) -> Result<Vec<Candidate>, String> {
	let chars: Vec<char> = input.chars().collect();
	let len = chars.len();
	let mut pos = 0;
	let mut candidates = Vec::new();
	loop {
		while pos < len && (chars[pos] == ',' || is_ws(chars[pos])) {
			pos += 1;
		}
		if pos >= len {
			if candidates.is_empty() {
				return Err("Must contain one or more image candidate strings.".to_owned());
			}
			return Ok(candidates);
		}
		let start = pos;
		while pos < len && !is_ws(chars[pos]) {
			pos += 1;
		}
		let mut url: String = chars[start..pos].iter().collect();
		let mut descriptors: Vec<String> = Vec::new();
		if url.ends_with(',') {
			url = url.trim_end_matches(',').to_owned();
		} else {
			while pos < len && is_ws(chars[pos]) {
				pos += 1;
			}
			let mut current = String::new();
			#[derive(PartialEq)]
			enum State {
				InDescriptor,
				InParens,
				AfterDescriptor,
			}
			let mut state = State::InDescriptor;
			loop {
				let c = chars.get(pos).copied();
				match state {
					State::InDescriptor => match c {
						Some(c) if is_ws(c) => {
							if !current.is_empty() {
								descriptors.push(std::mem::take(&mut current));
								state = State::AfterDescriptor;
							}
						}
						Some(',') => {
							pos += 1;
							if !current.is_empty() {
								descriptors.push(std::mem::take(&mut current));
							}
							break;
						}
						Some('(') => {
							current.push('(');
							state = State::InParens;
						}
						None => {
							if !current.is_empty() {
								descriptors.push(std::mem::take(&mut current));
							}
							break;
						}
						Some(c) => current.push(c),
					},
					State::InParens => match c {
						Some(')') => {
							current.push(')');
							state = State::InDescriptor;
						}
						None => {
							descriptors.push(std::mem::take(&mut current));
							break;
						}
						Some(c) => current.push(c),
					},
					State::AfterDescriptor => {
						if let Some(c) = c
							&& !is_ws(c)
						{
							state = State::InDescriptor;
							pos -= 1;
						} else if c.is_none() {
							break;
						}
					}
				}
				pos += 1;
			}
		}
		candidates.push(finish_candidate(&url, &descriptors)?);
	}
}

/// The one kind of descriptor the candidates use, if any.
///
/// # Errors
///
/// Prettier does not support mixing kinds.
pub fn used_descriptor(candidates: &[Candidate]) -> Result<Option<Descriptor>, String> {
	let mut kinds = Vec::new();
	if candidates.iter().any(|c| c.width.is_some()) {
		kinds.push(Descriptor::Width);
	}
	if candidates.iter().any(|c| c.height.is_some()) {
		kinds.push(Descriptor::Height);
	}
	if candidates.iter().any(|c| c.density.is_some()) {
		kinds.push(Descriptor::Density);
	}
	if kinds.len() > 1 {
		return Err("Mixed descriptor in srcset is not supported".to_owned());
	}
	Ok(kinds.first().copied())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn urls(input: &str) -> Vec<String> {
		parse(input).unwrap().into_iter().map(|c| c.url).collect()
	}

	#[test]
	fn candidates_with_densities_and_widths() {
		let c = parse("a.jpg 1x, b.jpg 2x").unwrap();
		assert_eq!(c[0].url, "a.jpg");
		assert_eq!(c[0].density, Some(1.0));
		assert_eq!(c[1].density, Some(2.0));
		let c = parse("a.jpg 480w, b.jpg 800w").unwrap();
		assert_eq!((c[0].width, c[1].width), (Some(480), Some(800)));
		assert_eq!(parse("a.jpg").unwrap()[0].width, None);
	}

	#[test]
	fn urls_keep_their_commas_and_trailing_commas_separate_candidates() {
		assert_eq!(
			urls("data:image/png;base64,AAA 1x"),
			["data:image/png;base64,AAA"]
		);
		assert_eq!(urls("a.jpg, b.jpg,c.jpg"), ["a.jpg", "b.jpg,c.jpg"]);
		assert_eq!(urls("  a.jpg 1x ,  "), ["a.jpg"]);
	}

	#[test]
	fn invalid_input_is_an_error() {
		for bad in [
			"",
			" , ",
			"a.jpg 0w",
			"a.jpg 1q",
			"a.jpg 1x 2x",
			"a.jpg 1w 2h 3x",
			"a.jpg -1x",
		] {
			assert!(parse(bad).is_err(), "`{bad}` should not parse");
		}
	}

	#[test]
	fn mixed_descriptor_kinds_are_reported() {
		let c = parse("a.jpg 1x, b.jpg 100w").unwrap();
		assert!(used_descriptor(&c).is_err());
		let c = parse("a.jpg 100w, b.jpg 200w").unwrap();
		assert_eq!(used_descriptor(&c).unwrap(), Some(Descriptor::Width));
	}

	#[test]
	fn fractional_densities_are_printed_like_javascript() {
		let c = parse("a.jpg 1.5x, b.jpg 2x").unwrap();
		assert_eq!(c[0].value_of(Descriptor::Density), "1.5");
		assert_eq!(c[1].value_of(Descriptor::Density), "2");
	}
}
