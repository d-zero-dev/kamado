//! Image dimensions for `html.imageSizes`: PNG, JPEG, WebP, AVIF/HEIF and SVG.
//!
//! The readers follow the header layouts and the quirks of the `image-size`
//! package v2 used (2.0.4), so a page gets the same `width` and `height`
//! from both:
//! - JPEG: the first SOF0/SOF1/SOF2 marker found by walking segments; EXIF
//!   orientation is not applied (the stored size is reported).
//! - AVIF/HEIF: the largest `ispe` of the first `ipco`; a `clap` box shrinks
//!   the width by its right-crop field.
//! - SVG: `width` and `height` (units converted to pixels, `%` ignored), else
//!   the `viewBox`, scaled by whichever of the two lengths is present. A
//!   `viewBox` is split on single spaces only, so a comma-separated one gives
//!   no size.
//!
//! Why not a general image library: only dimensions are needed, and each
//! reader looks at a few dozen bytes of the file header.

/// Pixel dimensions, both greater than zero.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
	pub width: u32,
	pub height: u32,
}

/// The input is not a supported image, or is cut off.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImageError(pub String);

impl std::fmt::Display for ImageError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		write!(f, "{}", self.0)
	}
}

impl std::error::Error for ImageError {}

fn err<T>(message: &str) -> Result<T, ImageError> {
	Err(ImageError(message.to_owned()))
}

fn u16_be(b: &[u8], at: usize) -> Result<u32, ImageError> {
	match b.get(at..at + 2) {
		Some(s) => Ok(u32::from(u16::from_be_bytes([s[0], s[1]]))),
		None => err("the image is cut off"),
	}
}

fn u32_be(b: &[u8], at: usize) -> Result<u32, ImageError> {
	match b.get(at..at + 4) {
		Some(s) => Ok(u32::from_be_bytes([s[0], s[1], s[2], s[3]])),
		None => err("the image is cut off"),
	}
}

fn u32_le(b: &[u8], at: usize) -> Result<u32, ImageError> {
	match b.get(at..at + 4) {
		Some(s) => Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]])),
		None => err("the image is cut off"),
	}
}

fn u16_le(b: &[u8], at: usize) -> Result<u32, ImageError> {
	match b.get(at..at + 2) {
		Some(s) => Ok(u32::from(u16::from_le_bytes([s[0], s[1]]))),
		None => err("the image is cut off"),
	}
}

fn byte(b: &[u8], at: usize) -> Result<u8, ImageError> {
	b.get(at)
		.copied()
		.ok_or_else(|| ImageError("the image is cut off".to_owned()))
}

fn size(width: u64, height: u64) -> Option<Size> {
	let w = u32::try_from(width).ok().filter(|&w| w > 0)?;
	let h = u32::try_from(height).ok().filter(|&h| h > 0)?;
	Some(Size {
		width: w,
		height: h,
	})
}

// ----- GIF and BMP -----
// Not on the list of extensions `imageSizes` measures, but a file named
// `.png` that holds one of these was measured by v2, and failing the page
// for it would be a regression.

fn is_gif(b: &[u8]) -> bool {
	matches!(b.get(0..6), Some(b"GIF87a" | b"GIF89a"))
}

fn gif(b: &[u8]) -> Result<Option<Size>, ImageError> {
	Ok(size(u64::from(u16_le(b, 6)?), u64::from(u16_le(b, 8)?)))
}

fn is_bmp(b: &[u8]) -> bool {
	b.get(0..2) == Some(b"BM")
}

fn bmp(b: &[u8]) -> Result<Option<Size>, ImageError> {
	let width = u64::from(u32_le(b, 18)?);
	let height = i64::from(u32_le(b, 22)? as i32).unsigned_abs();
	Ok(size(width, height))
}

// ----- PNG -----

fn is_png(b: &[u8]) -> bool {
	b.get(1..8) == Some(b"PNG\r\n\x1a\n")
}

fn png(b: &[u8]) -> Result<Option<Size>, ImageError> {
	let mut chunk = b.get(12..16);
	if chunk == Some(b"CgBI") {
		chunk = b.get(28..32);
	}
	if chunk != Some(b"IHDR") {
		return err("Invalid PNG");
	}
	let at = if b.get(12..16) == Some(b"CgBI") {
		32
	} else {
		16
	};
	Ok(size(
		u64::from(u32_be(b, at)?),
		u64::from(u32_be(b, at + 4)?),
	))
}

// ----- JPEG -----

fn jpeg(b: &[u8]) -> Result<Option<Size>, ImageError> {
	let mut input = b.get(4..).unwrap_or(&[]);
	while !input.is_empty() {
		let i = u16_be(input, 0)? as usize;
		if i > input.len() {
			return err("Corrupt JPG, exceeded buffer limits");
		}
		if input.get(i) != Some(&0xff) {
			input = &input[1..];
			continue;
		}
		if matches!(input.get(i + 1), Some(0xc0..=0xc2)) {
			let height = u16_be(input, i + 5)?;
			let width = u16_be(input, i + 7)?;
			return Ok(size(u64::from(width), u64::from(height)));
		}
		input = input.get(i + 2..).unwrap_or(&[]);
	}
	err("Invalid JPG, no size found")
}

// ----- WebP -----

fn webp(b: &[u8]) -> Result<Option<Size>, ImageError> {
	let chunk = b.get(12..16).unwrap_or(&[]);
	let head = b.get(20..30.min(b.len())).unwrap_or(&[]);
	if chunk == b"VP8X" {
		let flags = byte(head, 0)?;
		if flags & 0xc0 == 0 && flags & 0x01 == 0 {
			let u24 = |at: usize| -> Result<u64, ImageError> {
				Ok(u64::from(u16_le(head, at)?) + (u64::from(byte(head, at + 2)?) << 16))
			};
			return Ok(size(1 + u24(4)?, 1 + u24(7)?));
		}
		return err("Invalid WebP");
	}
	if chunk == b"VP8 " && byte(head, 0)? != 0x2f {
		let width = u16_le(head, 6)? & 0x3fff;
		let height = u16_le(head, 8)? & 0x3fff;
		return Ok(size(u64::from(width), u64::from(height)));
	}
	if chunk == b"VP8L" && head.get(3..6) != Some(&[0x9d, 0x01, 0x2a]) {
		let (b1, b2, b3, b4) = (
			u64::from(byte(head, 1)?),
			u64::from(byte(head, 2)?),
			u64::from(byte(head, 3)?),
			u64::from(byte(head, 4)?),
		);
		let width = 1 + (((b2 & 0x3f) << 8) | b1);
		let height = 1 + (((b4 & 0xf) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6));
		return Ok(size(width, height));
	}
	err("Invalid WebP")
}

fn is_webp(b: &[u8]) -> bool {
	b.get(0..4) == Some(b"RIFF") && b.get(8..12) == Some(b"WEBP") && b.get(12..15) == Some(b"VP8")
}

// ----- HEIF / AVIF -----

struct BoxAt {
	offset: usize,
	size: usize,
}

/// The first box named `name` at or after `start`, walking sibling boxes.
fn find_box(b: &[u8], name: &[u8; 4], start: usize) -> Option<BoxAt> {
	let mut offset = start;
	while offset < b.len() {
		if b.len() - offset < 4 {
			break;
		}
		let box_size = u32_be(b, offset).ok()? as usize;
		if box_size < 8 {
			offset += 8;
			continue;
		}
		if b.len() - offset < 8 || b.len() - offset < box_size {
			return None;
		}
		if b.get(offset + 4..offset + 8) == Some(name) {
			return Some(BoxAt {
				offset,
				size: box_size,
			});
		}
		offset += box_size;
	}
	None
}

fn is_heif(b: &[u8]) -> bool {
	if b.get(4..8) != Some(b"ftyp") {
		return false;
	}
	let Some(ftyp) = find_box(b, b"ftyp", 0) else {
		return false;
	};
	matches!(
		b.get(ftyp.offset + 8..ftyp.offset + 12),
		Some(b"avif" | b"mif1" | b"msf1" | b"heic" | b"heix" | b"hevc" | b"hevx")
	)
}

fn heif(b: &[u8]) -> Result<Option<Size>, ImageError> {
	let ipco = find_box(b, b"meta", 0)
		.and_then(|meta| find_box(b, b"iprp", meta.offset + 12))
		.and_then(|iprp| find_box(b, b"ipco", iprp.offset + 8));
	let Some(ipco) = ipco else {
		return err("Invalid HEIF, no ipco box found");
	};
	let end = ipco.offset + ipco.size;
	let mut images: Vec<(i64, i64)> = Vec::new();
	let mut current = ipco.offset + 8;
	while current < end {
		let Some(ispe) = find_box(b, b"ispe", current) else {
			break;
		};
		if ispe.size < 20 {
			return err("Invalid HEIF");
		}
		let raw_width = i64::from(u32_be(b, ispe.offset + 12)?);
		let height = i64::from(u32_be(b, ispe.offset + 16)?);
		let mut width = raw_width;
		if let Some(clap) = find_box(b, b"clap", current)
			&& clap.size >= 16
			&& clap.offset < end
		{
			width = raw_width - i64::from(u32_be(b, clap.offset + 12)?);
		}
		images.push((width, height));
		let next = ispe.offset + ispe.size;
		if next <= current {
			return err("Invalid HEIF");
		}
		current = next;
	}
	let Some(&first) = images.first() else {
		return err("Invalid HEIF, no sizes found");
	};
	let mut largest = first;
	for &(w, h) in &images[1..] {
		if i128::from(w) * i128::from(h) > i128::from(largest.0) * i128::from(largest.1) {
			largest = (w, h);
		}
	}
	let (width, height) = largest;
	if width <= 0 || height <= 0 {
		return Ok(None);
	}
	Ok(size(width as u64, height as u64))
}

// ----- SVG -----

/// `<svg\s([^>"']|"[^"]*"|'[^']*')*>`: the first such opening tag.
fn svg_root(text: &str) -> Option<&str> {
	let mut from = 0;
	while let Some(found) = text[from..].find("<svg") {
		let start = from + found;
		let after = start + 4;
		from = after;
		if !text[after..].starts_with(|c: char| c.is_whitespace()) {
			continue;
		}
		let mut chars = text[after..].char_indices();
		let mut ok = None;
		while let Some((i, c)) = chars.next() {
			match c {
				'>' => {
					ok = Some(after + i + 1);
					break;
				}
				// An unterminated quote makes this `<svg` not an opening tag.
				'"' | '\'' if !chars.by_ref().any(|(_, d)| d == c) => break,
				_ => {}
			}
		}
		if let Some(end) = ok {
			return Some(&text[start..end]);
		}
	}
	None
}

/// The value of attribute `name` on the root tag by `\sNAME=(['"])(…)\1`,
/// the content being non-empty and free of `%` (or of newlines, for the
/// viewBox).
fn svg_attr<'a>(
	root: &'a str,
	name: &str,
	ignore_case: bool,
	allow_percent: bool,
) -> Option<&'a str> {
	let bytes = root.as_bytes();
	let needle_len = name.len() + 1;
	let mut i = 0;
	while i + 1 + needle_len < bytes.len() {
		if bytes[i].is_ascii_whitespace() {
			let candidate = root.get(i + 1..i + 1 + name.len());
			let name_ok = candidate.is_some_and(|c| {
				if ignore_case {
					c.eq_ignore_ascii_case(name)
				} else {
					c == name
				}
			});
			if name_ok && bytes[i + 1 + name.len()] == b'=' {
				let quote_at = i + 1 + needle_len;
				if let Some(&q) = bytes.get(quote_at)
					&& (q == b'"' || q == b'\'')
				{
					let rest = &root[quote_at + 1..];
					if let Some(close) = rest.find(q as char) {
						let value = &rest[..close];
						let bad = value.is_empty()
							|| (!allow_percent && value.contains('%'))
							|| (allow_percent && value.contains('\n'));
						if !bad {
							return Some(value);
						}
					}
				}
			}
		}
		i += 1;
	}
	None
}

const UNITS: [(&str, f64); 9] = [
	("in", 96.0),
	("cm", 96.0 / 2.54),
	("em", 16.0),
	("ex", 8.0),
	("m", (96.0 / 2.54) * 100.0),
	("mm", 96.0 / 2.54 / 10.0),
	("pc", 96.0 / 72.0 / 12.0),
	("pt", 96.0 / 72.0),
	("px", 1.0),
];

/// `^([0-9.]+(?:e\d+)?)(unit)?$` → rounded pixels; `None` for NaN or no match.
fn parse_length(len: &str) -> Option<f64> {
	let digits_end = len
		.find(|c: char| !(c.is_ascii_digit() || c == '.'))
		.unwrap_or(len.len());
	if digits_end == 0 {
		return None;
	}
	let mut number_end = digits_end;
	let rest = &len[digits_end..];
	if let Some(exp) = rest.strip_prefix('e') {
		let exp_digits = exp.find(|c: char| !c.is_ascii_digit()).unwrap_or(exp.len());
		if exp_digits > 0 {
			number_end = digits_end + 1 + exp_digits;
		}
	}
	let unit = &len[number_end..];
	let factor = if unit.is_empty() {
		1.0
	} else {
		UNITS.iter().find(|(u, _)| *u == unit)?.1
	};
	let value: f64 = len[..number_end].parse().ok()?;
	let px = (value * factor + 0.5).floor();
	px.is_finite().then_some(px)
}

fn truthy(v: Option<f64>) -> Option<f64> {
	v.filter(|x| *x != 0.0 && x.is_finite())
}

fn svg(bytes: &[u8]) -> Result<Option<Size>, ImageError> {
	let text = String::from_utf8_lossy(bytes);
	let Some(root) = svg_root(&text) else {
		return err("Invalid SVG");
	};
	let width = truthy(svg_attr(root, "width", false, false).and_then(parse_length));
	let height = truthy(svg_attr(root, "height", false, false).and_then(parse_length));
	let view_box = svg_attr(root, "viewBox", true, true).map(|v| {
		let parts: Vec<&str> = v.split(' ').collect();
		(
			parts.get(2).and_then(|p| parse_length(p)),
			parts.get(3).and_then(|p| parse_length(p)),
		)
	});
	let (w, h) = if let (Some(w), Some(h)) = (width, height) {
		(Some(w), Some(h))
	} else if let Some((vw, vh)) = view_box {
		let ratio = match (vw, vh) {
			(Some(vw), Some(vh)) => vw / vh,
			_ => f64::NAN,
		};
		if let Some(w) = width {
			(Some(w), Some((w / ratio).floor()))
		} else if let Some(h) = height {
			(Some((h * ratio).floor()), Some(h))
		} else {
			(vw, vh)
		}
	} else {
		return err("Invalid SVG");
	};
	match (truthy(w), truthy(h)) {
		(Some(w), Some(h)) if w >= 0.0 && h >= 0.0 => Ok(size(w as u64, h as u64)),
		_ => Ok(None),
	}
}

fn is_svg(b: &[u8]) -> bool {
	let head = String::from_utf8_lossy(&b[..b.len().min(1000)]);
	svg_root(&head).is_some()
}

/// The dimensions of the image in `bytes`.
///
/// `Ok(None)` means a recognized image that carries no usable size (an SVG
/// with neither lengths nor a usable `viewBox`, or a zero dimension): the
/// caller leaves the element alone.
///
/// # Errors
///
/// An [`ImageError`] for an unsupported format or a damaged header.
///
/// # Example
///
/// ```
/// let svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"10\"></svg>";
/// let size = kd_image::size_of(svg).unwrap().unwrap();
/// assert_eq!((size.width, size.height), (20, 10));
/// ```
pub fn size_of(bytes: &[u8]) -> Result<Option<Size>, ImageError> {
	match bytes.first() {
		Some(0x00) if is_heif(bytes) => return heif(bytes),
		Some(0x52) if is_webp(bytes) => return webp(bytes),
		Some(0x89) if is_png(bytes) => return png(bytes),
		Some(0xff) if bytes.get(0..2) == Some(&[0xff, 0xd8]) => return jpeg(bytes),
		_ => {}
	}
	if is_png(bytes) {
		return png(bytes);
	}
	if is_webp(bytes) {
		return webp(bytes);
	}
	if bytes.get(0..2) == Some(&[0xff, 0xd8]) {
		return jpeg(bytes);
	}
	if is_heif(bytes) {
		return heif(bytes);
	}
	if is_gif(bytes) {
		return gif(bytes);
	}
	if is_bmp(bytes) {
		return bmp(bytes);
	}
	if is_svg(bytes) {
		return svg(bytes);
	}
	err("unsupported image type")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn dims(bytes: &[u8]) -> Option<(u32, u32)> {
		size_of(bytes).unwrap().map(|s| (s.width, s.height))
	}

	fn png_bytes(w: u32, h: u32) -> Vec<u8> {
		let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13];
		v.extend_from_slice(b"IHDR");
		v.extend_from_slice(&w.to_be_bytes());
		v.extend_from_slice(&h.to_be_bytes());
		v.extend_from_slice(&[8, 6, 0, 0, 0]);
		v
	}

	#[test]
	fn png_sizes() {
		assert_eq!(dims(&png_bytes(640, 480)), Some((640, 480)));
		assert_eq!(dims(&png_bytes(1, 1)), Some((1, 1)));
		assert_eq!(dims(&png_bytes(0, 5)), None);
	}

	#[test]
	fn an_apple_fried_png_reads_the_size_after_cgbi() {
		let mut v = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 4];
		v.extend_from_slice(b"CgBI");
		v.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 13]);
		v.extend_from_slice(b"IHDR");
		v.extend_from_slice(&30u32.to_be_bytes());
		v.extend_from_slice(&20u32.to_be_bytes());
		assert_eq!(dims(&v), Some((30, 20)));
	}

	#[test]
	fn a_png_without_ihdr_is_an_error() {
		let mut v = png_bytes(2, 2);
		v[12..16].copy_from_slice(b"IDAT");
		assert!(size_of(&v).is_err());
	}

	fn jpeg_bytes(w: u16, h: u16, marker: u8) -> Vec<u8> {
		let mut v = vec![0xff, 0xd8];
		// APP0 / JFIF segment: length 16
		v.extend_from_slice(&[0xff, 0xe0, 0x00, 0x10]);
		v.extend_from_slice(b"JFIF\0");
		v.extend_from_slice(&[1, 1, 0, 0, 1, 0, 1, 0, 0]);
		// SOF
		v.extend_from_slice(&[0xff, marker, 0x00, 0x11, 8]);
		v.extend_from_slice(&h.to_be_bytes());
		v.extend_from_slice(&w.to_be_bytes());
		v.extend_from_slice(&[3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
		v
	}

	#[test]
	fn jpeg_sizes_from_sof0_sof1_and_sof2() {
		assert_eq!(dims(&jpeg_bytes(300, 200, 0xc0)), Some((300, 200)));
		assert_eq!(dims(&jpeg_bytes(300, 200, 0xc1)), Some((300, 200)));
		assert_eq!(dims(&jpeg_bytes(300, 200, 0xc2)), Some((300, 200)));
	}

	#[test]
	fn a_jpeg_without_a_frame_header_is_an_error() {
		assert!(size_of(&jpeg_bytes(300, 200, 0xc4)).is_err());
		assert!(size_of(&[0xff, 0xd8, 0xff]).is_err());
	}

	#[test]
	fn webp_lossy_lossless_and_extended() {
		let mut lossy = b"RIFF\0\0\0\0WEBPVP8 \0\0\0\0".to_vec();
		lossy.extend_from_slice(&[0x10, 0x02, 0x00, 0x9d, 0x01, 0x2a]);
		lossy.extend_from_slice(&(640u16).to_le_bytes());
		lossy.extend_from_slice(&(480u16).to_le_bytes());
		// the lossy reader looks at head[6..10] and rejects the 9d012a start code
		// only for VP8L, so a plain VP8 header is read as is
		assert_eq!(dims(&lossy), Some((640, 480)));

		let mut lossless = b"RIFF\0\0\0\0WEBPVP8L\0\0\0\0".to_vec();
		// signature 0x2f, then 14 bits width-1, 14 bits height-1
		let (w, h) = (100u32 - 1, 50u32 - 1);
		let bits = w | (h << 14);
		lossless.push(0x2f);
		lossless.extend_from_slice(&bits.to_le_bytes());
		assert_eq!(dims(&lossless), Some((100, 50)));

		let mut extended = b"RIFF\0\0\0\0WEBPVP8X\0\0\0\0".to_vec();
		extended.extend_from_slice(&[0, 0, 0, 0]);
		extended.extend_from_slice(&[(800 - 1) as u8, ((800 - 1) >> 8) as u8, 0]);
		extended.extend_from_slice(&[(600 - 1) as u8, ((600 - 1) >> 8) as u8, 0]);
		assert_eq!(dims(&extended), Some((800, 600)));
	}

	fn bx(name: &[u8; 4], body: &[u8]) -> Vec<u8> {
		let mut v = ((body.len() + 8) as u32).to_be_bytes().to_vec();
		v.extend_from_slice(name);
		v.extend_from_slice(body);
		v
	}

	fn avif_bytes(sizes: &[(u32, u32)]) -> Vec<u8> {
		let mut ftyp_body = b"avif".to_vec();
		ftyp_body.extend_from_slice(&[0, 0, 0, 0]);
		ftyp_body.extend_from_slice(b"avifmif1");
		let mut ipco_body = Vec::new();
		for &(w, h) in sizes {
			let mut ispe = vec![0, 0, 0, 0];
			ispe.extend_from_slice(&w.to_be_bytes());
			ispe.extend_from_slice(&h.to_be_bytes());
			ipco_body.extend(bx(b"ispe", &ispe));
		}
		let ipco = bx(b"ipco", &ipco_body);
		let iprp = bx(b"iprp", &ipco);
		let mut meta_body = vec![0, 0, 0, 0];
		meta_body.extend(iprp);
		let mut out = bx(b"ftyp", &ftyp_body);
		out.extend(bx(b"meta", &meta_body));
		out
	}

	#[test]
	fn avif_takes_the_largest_image_of_the_first_ipco() {
		assert_eq!(dims(&avif_bytes(&[(400, 300)])), Some((400, 300)));
		assert_eq!(
			dims(&avif_bytes(&[(40, 30), (400, 300), (100, 100)])),
			Some((400, 300))
		);
		assert!(size_of(&avif_bytes(&[])).is_err());
	}

	#[test]
	fn svg_with_width_and_height() {
		assert_eq!(
			dims(b"<svg width=\"20\" height=\"10\"></svg>"),
			Some((20, 10))
		);
		assert_eq!(dims(b"<svg width='1in' height='1pt'></svg>"), Some((96, 1)));
		assert_eq!(
			dims(
				b"<?xml version=\"1.0\"?>\n<!-- c -->\n<svg xmlns=\"x\" width=\"5\" height=\"7\"/>"
			),
			Some((5, 7))
		);
	}

	#[test]
	fn svg_with_a_view_box() {
		assert_eq!(dims(b"<svg viewBox=\"0 0 24 12\"></svg>"), Some((24, 12)));
		assert_eq!(
			dims(b"<svg width=\"48\" viewBox=\"0 0 24 12\"></svg>"),
			Some((48, 24))
		);
		assert_eq!(
			dims(b"<svg height=\"6\" viewBox=\"0 0 24 12\"></svg>"),
			Some((12, 6))
		);
		assert_eq!(dims(b"<svg VIEWBOX=\"0 0 10 10\"></svg>"), Some((10, 10)));
		assert_eq!(
			dims(b"<svg width=\"100%\" viewBox=\"0 0 30 20\"></svg>"),
			Some((30, 20))
		);
	}

	#[test]
	fn svg_view_boxes_with_commas_have_no_size_but_are_not_errors() {
		assert_eq!(dims(b"<svg viewBox=\"0,0,24,12\"></svg>"), None);
		assert_eq!(dims(b"<svg viewBox=\"0 0 0 0\"></svg>"), None);
	}

	#[test]
	fn svg_without_any_size_information_is_an_error() {
		assert!(size_of(b"<svg xmlns=\"x\"></svg>").is_err());
		assert!(size_of(b"<svg width=\"10\"></svg>").is_err());
		assert!(size_of(b"<svgx width=\"10\" height=\"1\"></svgx>").is_err());
	}

	#[test]
	fn svg_lengths_follow_the_unit_table() {
		assert_eq!(parse_length("10"), Some(10.0));
		assert_eq!(parse_length("10px"), Some(10.0));
		assert_eq!(parse_length("1.5em"), Some(24.0));
		assert_eq!(parse_length("2.54cm"), Some(96.0));
		assert_eq!(parse_length("10mm"), Some(38.0));
		assert_eq!(parse_length("1e2"), Some(100.0));
		assert_eq!(parse_length("10rem"), None);
		assert_eq!(parse_length("1.2.3"), None);
		assert_eq!(parse_length(""), None);
		assert_eq!(parse_length("-5"), None);
	}

	#[test]
	fn unsupported_and_empty_inputs_are_errors() {
		assert!(size_of(b"").is_err());
		assert!(size_of(b"GIF89a").is_err());
		assert!(size_of(b"plain text").is_err());
		assert!(size_of(&png_bytes(1, 1)[..10]).is_err());
	}

	#[test]
	fn gif_and_bmp_sizes() {
		let mut g = b"GIF89a".to_vec();
		g.extend_from_slice(&(120u16).to_le_bytes());
		g.extend_from_slice(&(80u16).to_le_bytes());
		assert_eq!(dims(&g), Some((120, 80)));
		let mut b = vec![b'B', b'M'];
		b.extend_from_slice(&[0; 16]);
		b.extend_from_slice(&(64u32).to_le_bytes());
		b.extend_from_slice(&(-48i32).to_le_bytes());
		assert_eq!(
			dims(&b),
			Some((64, 48)),
			"a bottom-up BMP stores its height negated"
		);
		assert!(size_of(b"GIF89").is_err());
	}

	#[test]
	fn avif_with_huge_dimensions_does_not_overflow() {
		assert_eq!(
			dims(&avif_bytes(&[(u32::MAX, u32::MAX), (1, 1)])),
			Some((u32::MAX, u32::MAX))
		);
	}

	#[test]
	fn jpeg_segments_that_run_past_the_input_are_corrupt() {
		assert!(size_of(&[0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0]).is_err());
	}

	#[test]
	fn svg_detection_looks_at_the_first_kilobyte_only() {
		let mut late = b"<!--".to_vec();
		late.extend_from_slice(&[b'x'; 1100]);
		late.extend_from_slice(b"--><svg width=\"2\" height=\"3\"></svg>");
		assert!(size_of(&late).is_err());
		let mut bom = vec![0xef, 0xbb, 0xbf];
		bom.extend_from_slice(b"<svg width=\"2\" height=\"3\"></svg>");
		assert_eq!(dims(&bom), Some((2, 3)));
	}
}
