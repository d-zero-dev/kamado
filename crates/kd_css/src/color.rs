//! Colour minification, a port of what postcss-colormin does through
//! `@colordx/core`: a colour written as hex, a name, `rgb()`/`rgba()` or
//! `hsl()`/`hsla()` becomes the shortest of its equivalent spellings.
//!
//! What it does not do, as colormin does not: parse `hwb()`, `lab()`,
//! `oklch()` or `color()` (those are left as written), or write eight digit
//! hex (`#rrggbbaa`), which colormin only does when every browser it targets
//! supports it; a translucent colour is spelled `rgba()` or `hsla()`.

use crate::color_table::COLOR_NAMES;

#[derive(Clone, Copy)]
struct Rgba {
	r: f64,
	g: f64,
	b: f64,
	a: f64,
}

/// JavaScript's `Math.round`: halves go up.
fn js_round(x: f64) -> f64 {
	(x + 0.5).floor()
}

fn round_to(x: f64, digits: i32) -> f64 {
	let f = 10f64.powi(digits);
	js_round(f * x) / f
}

fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
	x.max(lo).min(hi)
}

fn norm_alpha(a: f64) -> f64 {
	if a > 0.0 {
		if a < 1.0 {
			js_round(a * 1000.0) / 1000.0
		} else {
			1.0
		}
	} else {
		0.0
	}
}

fn channel(x: f64) -> f64 {
	if x > 0.0 {
		if x < 255.0 { js_round(x) } else { 255.0 }
	} else {
		0.0
	}
}

fn byte(x: f64) -> u8 {
	clamp(js_round(x), 0.0, 255.0) as u8
}

fn is_js_space(c: char) -> bool {
	c.is_whitespace() || c == '\u{feff}'
}

fn hex_value(b: u8) -> Option<u32> {
	(b as char).to_digit(16)
}

fn parse_hex(input: &str) -> Option<Rgba> {
	let s = input.trim_matches(is_js_space);
	let b = s.as_bytes();
	if b.first() != Some(&b'#') || !matches!(b.len(), 4 | 5 | 7 | 9) {
		return None;
	}
	let mut d = Vec::with_capacity(8);
	for &c in &b[1..] {
		d.push(hex_value(c)?);
	}
	let (r, g, bl, a) = match b.len() {
		4 | 5 => {
			let a = if b.len() == 5 {
				let l = d[3] | d[3] << 4;
				if l == 255 {
					1.0
				} else {
					round_to(f64::from(l) / 255.0, 3)
				}
			} else {
				1.0
			};
			(d[0] | d[0] << 4, d[1] | d[1] << 4, d[2] | d[2] << 4, a)
		}
		_ => {
			let a = if b.len() == 9 {
				round_to(f64::from(d[6] << 4 | d[7]) / 255.0, 3)
			} else {
				1.0
			};
			(d[0] << 4 | d[1], d[2] << 4 | d[3], d[4] << 4 | d[5], a)
		}
	};
	Some(Rgba {
		r: f64::from(r),
		g: f64::from(g),
		b: f64::from(bl),
		a,
	})
}

fn parse_name(input: &str) -> Option<Rgba> {
	let s = input.trim();
	if s.len() < 3 || s.len() > 20 {
		return None;
	}
	let mut buf = [0u8; 20];
	for (d, c) in buf.iter_mut().zip(s.bytes()) {
		*d = c.to_ascii_lowercase();
	}
	let key = &buf[..s.len()];
	let i = COLOR_NAMES
		.binary_search_by(|(n, _)| n.as_bytes().cmp(key))
		.ok()?;
	let v = COLOR_NAMES[i].1;
	Some(Rgba {
		r: f64::from(v >> 16 & 255),
		g: f64::from(v >> 8 & 255),
		b: f64::from(v & 255),
		a: 1.0,
	})
}

/// Whether `word` is one of the colour names colormin knows (`red`, not
/// `grey`).
///
/// # Example
///
/// ```
/// assert!(kd_css::color::is_color_name("Red"));
/// assert!(!kd_css::color::is_color_name("transparent"));
/// ```
pub fn is_color_name(word: &str) -> bool {
	parse_name(word).is_some()
}

/// Whether colormin understands `input` as a colour (hex, name, `rgb()` or
/// `hsl()`).
///
/// # Example
///
/// ```
/// assert!(kd_css::color::is_color("#fff"));
/// assert!(kd_css::color::is_color("Red"));
/// assert!(!kd_css::color::is_color("1px"));
/// ```
pub fn is_color(input: &str) -> bool {
	parse_color(input).is_some()
}

/// A number as colordx reads it: `none`, or an optionally signed number with
/// digits on at least one side of the point and no exponent. Returns the
/// value, the end position, and whether it was `none`.
fn number(b: &[u8], mut i: usize) -> Option<(f64, usize, bool)> {
	if b.len() >= i + 4 && b[i..i + 4].eq_ignore_ascii_case(b"none") {
		return Some((0.0, i + 4, true));
	}
	let start = i;
	if matches!(b.get(i), Some(b'+' | b'-')) {
		i += 1;
	}
	let int_start = i;
	while b.get(i).is_some_and(u8::is_ascii_digit) {
		i += 1;
	}
	let int_digits = i - int_start;
	if b.get(i) == Some(&b'.') {
		i += 1;
		let frac_start = i;
		while b.get(i).is_some_and(u8::is_ascii_digit) {
			i += 1;
		}
		if i == frac_start {
			return None;
		}
	} else if int_digits == 0 {
		return None;
	}
	let text = std::str::from_utf8(&b[start..i]).ok()?;
	let v: f64 = text.parse().ok()?;
	Some((v, i, false))
}

/// A number, then an optional `%`; returns (value, end, percent, none).
fn number_pct(b: &[u8], i: usize) -> Option<(f64, usize, bool, bool)> {
	let (v, mut e, none) = number(b, i)?;
	let mut pct = false;
	if b.get(e) == Some(&b'%') {
		pct = true;
		e += 1;
	}
	Some((v, e, pct, none))
}

fn skip_ws(b: &[u8], mut i: usize) -> usize {
	while b
		.get(i)
		.is_some_and(|&c| matches!(c, b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c))
	{
		i += 1;
	}
	i
}

fn parse_rgb(input: &str) -> Option<Rgba> {
	let b = input.as_bytes();
	let mut t = skip_ws(b, 0);
	if b.len() < t + 3 || !b[t..t + 3].eq_ignore_ascii_case(b"rgb") {
		return None;
	}
	t += 3;
	if b.get(t).is_some_and(|c| c | 32 == b'a') {
		t += 1;
	}
	if b.get(t) != Some(&b'(') {
		return None;
	}
	t = skip_ws(b, t + 1);
	let (l, e1, c, s) = number_pct(b, t)?;
	t = e1;
	let mut o = skip_ws(b, t);
	let comma = b.get(o) == Some(&b',');
	if comma {
		if s {
			return None;
		}
		o = skip_ws(b, o + 1);
	} else if o == t {
		return None;
	}
	let (h, e2, a2, i2) = number_pct(b, o)?;
	o = e2;
	let mut bp = skip_ws(b, o);
	if comma {
		if b.get(bp) != Some(&b',') || i2 {
			return None;
		}
		bp = skip_ws(b, bp + 1);
	} else if bp == o {
		return None;
	}
	let (k, e3, y, v) = number_pct(b, bp)?;
	bp = e3;
	if comma && (c != a2 || a2 != y || v) {
		return None;
	}
	let mut p = skip_ws(b, bp);
	let mut alpha = 1.0;
	let j = b.get(p).copied();
	if (comma && j == Some(b',')) || (!comma && j == Some(b'/')) {
		p = skip_ws(b, p + 1);
		let (w, e4, wp, wn) = number_pct(b, p)?;
		if comma && wn {
			return None;
		}
		alpha = if wp { w / 100.0 } else { w };
		p = skip_ws(b, e4);
	}
	if b.get(p) != Some(&b')') || skip_ws(b, p + 1) != b.len() {
		return None;
	}
	let ch = |v: f64, pct: bool| clamp(if pct { v / 100.0 * 255.0 } else { v }, 0.0, 255.0);
	Some(Rgba {
		r: ch(l, c),
		g: ch(h, a2),
		b: ch(k, y),
		a: clamp(round_to(alpha, 3), 0.0, 1.0),
	})
}

fn hsl_to_rgb(h: f64, s: f64, l: f64, a: f64) -> Rgba {
	let sat = s / 100.0;
	let light = l / 100.0;
	let q = if light < 0.5 {
		light * (1.0 + sat)
	} else {
		light + sat - light * sat
	};
	let p = 2.0 * light - q;
	let hue = (h % 360.0 + 360.0) % 360.0 / 360.0;
	let f = |mut t: f64| {
		if t < 0.0 {
			t += 1.0;
		}
		if t > 1.0 {
			t -= 1.0;
		}
		let v = if t < 1.0 / 6.0 {
			p + (q - p) * 6.0 * t
		} else if t < 0.5 {
			q
		} else if t < 2.0 / 3.0 {
			p + (q - p) * (2.0 / 3.0 - t) * 6.0
		} else {
			p
		};
		v * 255.0
	};
	Rgba {
		r: f(hue + 1.0 / 3.0),
		g: f(hue),
		b: f(hue - 1.0 / 3.0),
		a,
	}
}

fn norm_hue(h: f64) -> f64 {
	if (0.0..360.0).contains(&h) {
		h
	} else {
		(h % 360.0 + 360.0) % 360.0
	}
}

fn parse_hsl(input: &str) -> Option<Rgba> {
	let b = input.trim_matches(is_js_space).as_bytes();
	if b.len() < 4 || !b[..3].eq_ignore_ascii_case(b"hsl") {
		return None;
	}
	let mut i = 3;
	if b.get(i).is_some_and(|c| c | 32 == b'a') {
		i += 1;
	}
	if b.get(i) != Some(&b'(') {
		return None;
	}
	i = skip_ws(b, i + 1);
	let (hv, e, hnone) = number(b, i)?;
	i = e;
	let mut factor = 1.0;
	for (unit, f) in [
		("deg", 1.0),
		("rad", 360.0 / (2.0 * std::f64::consts::PI)),
		("grad", 0.9),
		("turn", 360.0),
	] {
		let ub = unit.as_bytes();
		if b.len() >= i + ub.len() && b[i..i + ub.len()].eq_ignore_ascii_case(ub) {
			// `grad` must win over `rad` only by position, they never overlap here.
			factor = f;
			i += ub.len();
			break;
		}
	}
	let after_hue = i;
	i = skip_ws(b, i);
	let (s, l, alpha);
	if b.get(i) == Some(&b',') {
		if hnone {
			return None;
		}
		i = skip_ws(b, i + 1);
		let (sv, e, none) = number(b, i)?;
		if none || b.get(e) != Some(&b'%') {
			return None;
		}
		i = skip_ws(b, e + 1);
		if b.get(i) != Some(&b',') {
			return None;
		}
		i = skip_ws(b, i + 1);
		let (lv, e, none) = number(b, i)?;
		if none || b.get(e) != Some(&b'%') {
			return None;
		}
		i = e + 1;
		s = sv;
		l = lv;
		let mut al = 1.0;
		let save = skip_ws(b, i);
		if b.get(save) == Some(&b',') {
			let st = skip_ws(b, save + 1);
			let (av, e, none) = number(b, st)?;
			if none {
				return None;
			}
			let mut e = e;
			let mut pct = false;
			if b.get(e) == Some(&b'%') {
				pct = true;
				e += 1;
			}
			al = av / if pct { 100.0 } else { 1.0 };
			i = skip_ws(b, e);
		}
		alpha = al;
	} else {
		if i == after_hue {
			return None;
		}
		let (sv, e, _, _) = number_pct(b, i)?;
		let j = skip_ws(b, e);
		if j == e {
			return None;
		}
		let (lv, e2, _, _) = number_pct(b, j)?;
		i = e2;
		s = sv;
		l = lv;
		let mut al = 1.0;
		let save = skip_ws(b, i);
		if b.get(save) == Some(&b'/') {
			let st = skip_ws(b, save + 1);
			let (av, e, _) = number(b, st)?;
			let mut e = e;
			let mut pct = false;
			if b.get(e) == Some(&b'%') {
				pct = true;
				e += 1;
			}
			al = av / if pct { 100.0 } else { 1.0 };
			i = skip_ws(b, e);
		}
		alpha = al;
	}
	if b.get(i) != Some(&b')') || i + 1 != b.len() {
		return None;
	}
	let h = norm_hue(hv * factor);
	let a = clamp(round_to(alpha, 3), 0.0, 1.0);
	Some(hsl_to_rgb(h, clamp(s, 0.0, 100.0), clamp(l, 0.0, 100.0), a))
}

fn parse_color(input: &str) -> Option<Rgba> {
	let first = *input.as_bytes().first()?;
	let mut c = if first == b'#' {
		parse_hex(input)
	} else if input.ends_with(')') {
		match first | 32 {
			b'r' => parse_rgb(input),
			b'h' => parse_hsl(input),
			_ => None,
		}
	} else {
		parse_name(input)
	}?;
	c.a = norm_alpha(c.a);
	Some(c)
}

fn hex_string(c: &Rgba) -> String {
	let mut s = format!("#{:02x}{:02x}{:02x}", byte(c.r), byte(c.g), byte(c.b));
	if c.a < 1.0 {
		s.push_str(&format!("{:02x}", byte(c.a * 255.0)));
	}
	s
}

fn shorten_hex(hex: &str) -> String {
	let b = hex.as_bytes();
	if b.len() == 7 && b[1] == b[2] && b[3] == b[4] && b[5] == b[6] {
		format!("#{}{}{}", b[1] as char, b[3] as char, b[5] as char)
	} else {
		hex.to_owned()
	}
}

/// `n.toString().replace("0.", ".")` for a number between 0 and 1, else the
/// number as is.
fn short_number(n: f64) -> String {
	let s = if n == 0.0 {
		"0".to_owned()
	} else {
		format!("{n}")
	};
	if n > 0.0 && n < 1.0 {
		s.replacen("0.", ".", 1)
	} else {
		s
	}
}

fn to_hsl(c: &Rgba) -> (f64, f64, f64) {
	let r = c.r / 255.0;
	let g = c.g / 255.0;
	let b = c.b / 255.0;
	let max = r.max(g).max(b);
	let min = r.min(g).min(b);
	let m = (max + min) / 2.0;
	let mut h = 0.0;
	let mut s = 0.0;
	if max != min {
		let d = max - min;
		s = if m > 0.5 {
			d / (2.0 - max - min)
		} else {
			d / (max + min)
		};
		h = if max == r {
			((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
		} else if max == g {
			((b - r) / d + 2.0) / 6.0
		} else {
			((r - g) / d + 4.0) / 6.0
		};
	}
	let hd = h * 360.0;
	(
		norm_hue(hd),
		clamp(s * 100.0, 0.0, 100.0),
		clamp(m * 100.0, 0.0, 100.0),
	)
}

/// The shortest `hsl()` or `hsla()` spelling of the colour that reads back
/// as the same 8-bit channels, with 0, 1 or 2 decimals.
fn hsl_candidate(c: &Rgba) -> Option<String> {
	let (h, s, l) = to_hsl(c);
	for p in 0..=2 {
		let h2 = {
			let v = round_to(h, p);
			if v >= 360.0 { 0.0 } else { v }
		};
		let s2 = round_to(s, p);
		let l2 = round_to(l, p);
		let back = hsl_to_rgb(
			norm_hue(h2),
			clamp(s2, 0.0, 100.0),
			clamp(l2, 0.0, 100.0),
			c.a,
		);
		if byte(back.r) == byte(c.r) && byte(back.g) == byte(c.g) && byte(back.b) == byte(c.b) {
			return Some(if c.a == 1.0 {
				format!(
					"hsl({},{}%,{}%)",
					short_number(h2),
					short_number(s2),
					short_number(l2)
				)
			} else {
				format!(
					"hsla({},{}%,{}%,{})",
					short_number(h2),
					short_number(s2),
					short_number(l2),
					short_number(c.a)
				)
			});
		}
	}
	None
}

/// Minifies one colour: a word (`#FF0000`, `Red`) or a whole `rgb()` /
/// `hsl()` function as text. Text that is not a colour colormin understands
/// comes back unchanged.
///
/// # Example
///
/// ```
/// use kd_css::color::minify_color;
///
/// assert_eq!(minify_color("#FF0000"), "red");
/// assert_eq!(minify_color("rgb(255, 255, 255)"), "#fff");
/// assert_eq!(minify_color("rgba(0,0,0,0)"), "transparent");
/// assert_eq!(minify_color("lab(50% 20 30)"), "lab(50% 20 30)");
/// ```
pub fn minify_color(input: &str) -> String {
	let Some(c) = parse_color(input) else {
		return input.to_owned();
	};
	let full = hex_string(&c);
	let (ri, gi, bi) = (channel(c.r), channel(c.g), channel(c.b));
	let mut cands: Vec<String> = Vec::new();
	if c.a == 1.0 {
		cands.push(shorten_hex(&full));
	}
	if c.a == 1.0 {
		cands.push(format!("rgb({ri},{gi},{bi})"));
	} else {
		cands.push(format!("rgba({ri},{gi},{bi},{})", short_number(c.a)));
	}
	// colordx derives the hsl() candidate from the unrounded channels of
	// the input, so `hsla(294,1%,6%,.5)` stays `rgba(15,15,15,.5)` and that
	// minifies to `hsla(0,0%,6%,.5)` the next time. Here the candidate from
	// the rounded channels competes too, and the first answer is the last.
	let ints = Rgba {
		r: ri,
		g: gi,
		b: bi,
		a: c.a,
	};
	let from_raw = hsl_candidate(&c);
	let from_ints = hsl_candidate(&ints);
	if let Some(t) = &from_raw {
		cands.push(t.clone());
	}
	if let Some(t) = from_ints
		&& from_raw.as_ref() != Some(&t)
	{
		cands.push(t);
	}
	if ri == 0.0 && gi == 0.0 && bi == 0.0 && c.a == 0.0 {
		cands.push("transparent".to_owned());
	} else if c.a == 1.0 {
		let value = u32::from(byte(c.r)) << 16 | u32::from(byte(c.g)) << 8 | u32::from(byte(c.b));
		if let Some((name, _)) = COLOR_NAMES.iter().find(|(_, v)| *v == value) {
			cands.push((*name).to_owned());
		}
	}
	let mut best = cands[0].clone();
	for cand in &cands[1..] {
		if cand.len() < best.len() {
			best = cand.clone();
		}
	}
	if best.len() < input.len() {
		best
	} else {
		input.to_ascii_lowercase()
	}
}
