//! The banner comment at the top of built CSS and JavaScript files:
//! `{{date:FORMAT}}` (the tokens of `formatDate`), `{{year}}` and
//! `{{version}}` are filled in, and text that is not a comment yet is
//! wrapped in one, as v2 did.
//!
//! Local time: Rust's standard library has no time zones, so the host passes
//! the offset of the machine's zone (`Date.prototype.getTimezoneOffset`),
//! which is exact for "now".

const MONTHS: [&str; 12] = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];
const DAYS: [&str; 7] = [
	"Sunday",
	"Monday",
	"Tuesday",
	"Wednesday",
	"Thursday",
	"Friday",
	"Saturday",
];

/// A moment in local time.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalTime {
	/// Milliseconds since the epoch.
	pub epoch_ms: i64,
	/// Local time minus UTC, in minutes (Tokyo: 540).
	pub offset_minutes: i32,
}

struct Fields {
	year: i64,
	month: usize,
	day: i64,
	weekday: usize,
	hour: i64,
	minute: i64,
	second: i64,
	millisecond: i64,
}

fn fields(t: LocalTime) -> Fields {
	let local_ms = t.epoch_ms + i64::from(t.offset_minutes) * 60_000;
	let secs = local_ms.div_euclid(1000);
	let millisecond = local_ms.rem_euclid(1000);
	let days = secs.div_euclid(86_400);
	let rem = secs.rem_euclid(86_400);
	// Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
	let z = days + 719_468;
	let era = z.div_euclid(146_097);
	let doe = z.rem_euclid(146_097);
	let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
	let y = yoe + era * 400;
	let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
	let mp = (5 * doy + 2) / 153;
	let d = doy - (153 * mp + 2) / 5 + 1;
	let m = if mp < 10 { mp + 3 } else { mp - 9 };
	Fields {
		year: if m <= 2 { y + 1 } else { y },
		month: (m - 1) as usize,
		day: d,
		weekday: (days + 4).rem_euclid(7) as usize,
		hour: rem / 3600,
		minute: rem % 3600 / 60,
		second: rem % 60,
		millisecond,
	}
}

/// Formats `time` with the tokens of dayjs' default format: `YYYY YY M MM MMM
/// MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ X x`, with
/// `[text]` kept as it is.
///
/// # Example
///
/// ```
/// use kd_core::banner::{format, LocalTime};
/// let t = LocalTime { epoch_ms: 1_700_000_000_000, offset_minutes: 540 };
/// assert_eq!(format(t, "YYYY-MM-DD HH:mm [at] ddd"), "2023-11-15 07:13 at Wed");
/// ```
#[must_use]
pub fn format(time: LocalTime, pattern: &str) -> String {
	let f = fields(time);
	let mut out = String::new();
	let chars: Vec<char> = pattern.chars().collect();
	let mut i = 0;
	while i < chars.len() {
		if chars[i] == '['
			&& let Some(close) = chars[i + 1..].iter().position(|&c| c == ']')
		{
			out.extend(&chars[i + 1..i + 1 + close]);
			i += close + 2;
			continue;
		}
		let run = chars[i..].iter().take_while(|&&c| c == chars[i]).count();
		let token: String = chars[i..i + run].iter().collect();
		let replaced = match token.as_str() {
			"YYYY" => Some(format!("{:04}", f.year)),
			"YY" => Some(format!("{:02}", f.year.rem_euclid(100))),
			"MMMM" => Some(MONTHS[f.month].to_owned()),
			"MMM" => Some(MONTHS[f.month][..3].to_owned()),
			"MM" => Some(format!("{:02}", f.month + 1)),
			"M" => Some((f.month + 1).to_string()),
			"DD" => Some(format!("{:02}", f.day)),
			"D" => Some(f.day.to_string()),
			"dddd" => Some(DAYS[f.weekday].to_owned()),
			"ddd" => Some(DAYS[f.weekday][..3].to_owned()),
			"dd" => Some(DAYS[f.weekday][..2].to_owned()),
			"d" => Some(f.weekday.to_string()),
			"HH" => Some(format!("{:02}", f.hour)),
			"H" => Some(f.hour.to_string()),
			"hh" => Some(format!("{:02}", (f.hour + 11) % 12 + 1)),
			"h" => Some(((f.hour + 11) % 12 + 1).to_string()),
			"mm" => Some(format!("{:02}", f.minute)),
			"m" => Some(f.minute.to_string()),
			"ss" => Some(format!("{:02}", f.second)),
			"s" => Some(f.second.to_string()),
			"SSS" => Some(format!("{:03}", f.millisecond)),
			"A" => Some(if f.hour < 12 { "AM" } else { "PM" }.to_owned()),
			"a" => Some(if f.hour < 12 { "am" } else { "pm" }.to_owned()),
			"ZZ" | "Z" => {
				let o = time.offset_minutes;
				let sign = if o < 0 { '-' } else { '+' };
				let (h, m) = (o.abs() / 60, o.abs() % 60);
				Some(if token == "ZZ" {
					format!("{sign}{h:02}{m:02}")
				} else {
					format!("{sign}{h:02}:{m:02}")
				})
			}
			"X" => Some(time.epoch_ms.div_euclid(1000).to_string()),
			"x" => Some(time.epoch_ms.to_string()),
			_ => None,
		};
		match replaced {
			Some(r) => {
				out.push_str(&r);
				i += run;
			}
			None => {
				// Not a token (or a run longer than any token): the characters as
				// they are.
				out.push(chars[i]);
				i += 1;
			}
		}
	}
	out
}

/// Fills in the placeholders of a banner template.
///
/// # Example
///
/// ```
/// use kd_core::banner::{fill, LocalTime};
/// let t = LocalTime { epoch_ms: 1_700_000_000_000, offset_minutes: 0 };
/// assert_eq!(
///     fill("rev. {{date:YYYY-MM-DD}} v{{version}} © {{year}}", t, Some("1.2.3")),
///     "rev. 2023-11-14 v1.2.3 © 2023"
/// );
/// ```
#[must_use]
pub fn fill(template: &str, time: LocalTime, version: Option<&str>) -> String {
	let mut out = String::new();
	let mut rest = template;
	while let Some(open) = rest.find("{{") {
		out.push_str(&rest[..open]);
		let after = &rest[open + 2..];
		let Some(close) = after.find("}}") else {
			out.push_str(&rest[open..]);
			return out;
		};
		let name = after[..close].trim();
		let replacement = if let Some(pattern) = name.strip_prefix("date:") {
			Some(format(time, pattern))
		} else {
			match name {
				"year" => Some(fields(time).year.to_string()),
				"version" => Some(version.unwrap_or_default().to_owned()),
				_ => None,
			}
		};
		match replacement {
			Some(r) => out.push_str(&r),
			None => out.push_str(&rest[open..open + 2 + close + 2]),
		}
		rest = &after[close + 2..];
	}
	out.push_str(rest);
	out
}

/// The banner for a JavaScript file: a comment, as v2's `createBanner` made
/// it (`/*\n<text>\n*/`) unless the template already starts a comment (`/*`
/// or `//`). Why wrap: text that is not a comment would break the bundle.
#[must_use]
pub fn for_script(template: &str, time: LocalTime, version: Option<&str>) -> String {
	let text = fill(template, time, version);
	let head = text.trim_start();
	if head.starts_with("/*") || head.starts_with("//") {
		text
	} else {
		format!("/*\n{text}\n*/")
	}
}

/// The banner for a CSS file: an important comment (`/*! ... */`), which
/// survives minification. A comment becomes important, other text is
/// wrapped, and an embedded `*/` is split so it cannot close the comment.
#[must_use]
pub fn for_style(template: &str, time: LocalTime, version: Option<&str>) -> String {
	let text = fill(template, time, version);
	let trimmed = text.trim();
	if trimmed.is_empty() {
		return String::new();
	}
	if trimmed.starts_with("/*!") {
		return trimmed.to_owned();
	}
	if trimmed.starts_with("/*") && trimmed.ends_with("*/") {
		return format!("/*!{}", &trimmed[2..]);
	}
	format!("/*!\n{}\n*/", trimmed.replace("*/", "* /"))
}

/// The warning that replaces the banner while serving (v2's `devMode`).
pub const DEV_BANNER: &str =
	"🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧
🚧                                                                    🚧
🚧                      👷これは開発中のコードです。                       🚧
🚧                                                                    🚧
🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧

🈲 このファイルを直接編集しないでください。
⚠️ 正式公開の場合は正しい手順でリリースビルドを行なってファイルを最適化してください。";

#[cfg(test)]
mod tests {
	use super::*;

	const T: LocalTime = LocalTime {
		epoch_ms: 1_700_000_000_123,
		offset_minutes: 0,
	};

	#[test]
	fn the_tokens_of_dayjs_are_formatted() {
		assert_eq!(
			format(T, "YYYY YY M MM MMM MMMM"),
			"2023 23 11 11 Nov November"
		);
		assert_eq!(format(T, "D DD d dd ddd dddd"), "14 14 2 Tu Tue Tuesday");
		assert_eq!(
			format(T, "H HH h hh m mm s ss SSS A a"),
			"22 22 10 10 13 13 20 20 123 PM pm"
		);
		assert_eq!(
			format(T, "Z ZZ X x"),
			"+00:00 +0000 1700000000 1700000000123"
		);
		assert_eq!(format(T, "[YYYY] YYYY [a]b"), "YYYY 2023 ab");
	}

	#[test]
	fn the_zone_offset_moves_the_date_and_shows_in_z() {
		let tokyo = LocalTime {
			epoch_ms: 1_700_000_000_000,
			offset_minutes: 540,
		};
		assert_eq!(
			format(tokyo, "YYYY-MM-DD HH:mm Z"),
			"2023-11-15 07:13 +09:00"
		);
		let ny = LocalTime {
			epoch_ms: 1_700_000_000_000,
			offset_minutes: -300,
		};
		assert_eq!(format(ny, "YYYY-MM-DD HH:mm ZZ"), "2023-11-14 17:13 -0500");
		// Before the epoch.
		let old = LocalTime {
			epoch_ms: -86_400_000,
			offset_minutes: 0,
		};
		assert_eq!(format(old, "YYYY-MM-DD d"), "1969-12-31 3");
	}

	#[test]
	fn placeholders_are_filled_and_unknown_ones_stay() {
		assert_eq!(
			fill(
				"{{date:YYYY}} {{ year }} {{version}} {{nope}} {{date:",
				T,
				Some("2.0.0")
			),
			"2023 2023 2.0.0 {{nope}} {{date:"
		);
	}

	#[test]
	fn banners_are_comments_the_way_v2_made_them() {
		assert_eq!(
			for_script("rev. {{date:YYYY-MM-DD}}\ncopyright © {{year}}", T, None),
			"/*\nrev. 2023-11-14\ncopyright © 2023\n*/"
		);
		assert_eq!(
			for_script("/*! kept {{year}} */", T, None),
			"/*! kept 2023 */"
		);
		assert_eq!(for_script("// {{year}}", T, None), "// 2023");
		assert_eq!(
			for_style("rev. {{date:YYYY-MM-DD}}", T, None),
			"/*!\nrev. 2023-11-14\n*/"
		);
		assert_eq!(for_style("/* a */", T, None), "/*! a */");
		assert_eq!(for_style("/*! a */", T, None), "/*! a */");
		assert_eq!(for_style("a */ b", T, None), "/*!\na * / b\n*/");
		assert_eq!(for_style("  ", T, None), "");
	}
}
