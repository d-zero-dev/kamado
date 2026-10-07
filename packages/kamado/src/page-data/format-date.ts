/**
 * A small port of dayjs's `format` (English locale, local timezone) so the
 * Node layer needs no runtime dependency. Supported tokens: `YYYY YY M MM MMM
 * MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ X x`; `[...]`
 * escapes literal text. `X` (Unix seconds) and `x` (Unix milliseconds) come
 * from dayjs's `advancedFormat` plugin; plain dayjs leaves them as literal
 * characters.
 */

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];
const WEEKDAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
];

const INVALID_DATE_STRING = 'Invalid Date';
// dayjs's own pattern, kept verbatim so inputs split into the same groups.
/* eslint-disable regexp/no-misleading-capturing-group */
const REGEX_PARSE =
	/^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[T\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/i;
/* eslint-enable regexp/no-misleading-capturing-group */
const REGEX_FORMAT =
	/\[([^\]]+)\]|YYYY|YY|M{1,4}|D{1,2}|d{1,4}|H{1,2}|h{1,2}|[aAXx]|m{1,2}|s{1,2}|Z{1,2}|SSS/g;

/**
 * Left-pads like dayjs's `padStart` (including leaving longer values alone).
 * @param value - Value to pad.
 * @param length - Minimum length.
 * @param pad - Pad character.
 * @returns The padded string.
 */
function padStart(value: number | string, length: number, pad: string): string {
	const s = String(value);
	if (!s || s.length >= length) return s;
	return Array.from({ length: length + 1 - s.length }).join(pad) + s;
}

/**
 * Parses a value the way `dayjs(value)` does: strings that look like a date
 * (and do not end in `Z`) are read as local time, everything else goes through
 * `new Date(value)`.
 * @param value - String, epoch milliseconds, or Date.
 * @returns The Date (possibly invalid).
 */
function parseDate(value: string | number | Date): Date {
	if ((value as unknown) === null) return new Date(Number.NaN);
	if ((value as unknown) === undefined) return new Date();
	if (value instanceof Date) return new Date(value);
	if (typeof value === 'string' && !/Z$/i.test(value)) {
		const d = REGEX_PARSE.exec(value);
		if (d) {
			const m = Number(d[2]) - 1 || 0;
			const ms = (d[7] || '0').slice(0, 3);
			return new Date(
				Number(d[1]),
				m,
				Number(d[3] || 1),
				Number(d[4] || 0),
				Number(d[5] || 0),
				Number(d[6] || 0),
				Number(ms),
			);
		}
	}
	return new Date(value);
}

/**
 * Formats a date with dayjs-compatible tokens in the local timezone.
 * @param value - ISO-like string, epoch milliseconds, or Date.
 * @param format - Format string, for example `YYYY-MM-DD HH:mm`.
 * @returns The formatted string, or `Invalid Date` for an invalid input.
 * @example
 * ```ts
 * formatDate('2024-03-05', 'YYYY/MM/DD (ddd)'); // '2024/03/05 (Tue)'
 * formatDate(new Date(2024, 0, 2, 15, 4), 'h:mm A [JST]'); // '3:04 PM JST'
 * ```
 */
export function formatDate(value: string | number | Date, format: string): string {
	const date = parseDate(value);
	if (date.toString() === INVALID_DATE_STRING) return INVALID_DATE_STRING;

	const str = format || 'YYYY-MM-DDTHH:mm:ssZ';
	const year = date.getFullYear();
	const month = date.getMonth();
	const day = date.getDate();
	const weekday = date.getDay();
	const hours = date.getHours();
	const minutes = date.getMinutes();
	const seconds = date.getSeconds();
	const millis = date.getMilliseconds();

	// dayjs rounds the offset to 15 minutes to dodge a Firefox 24 bug.
	const negMinutes = Math.round(date.getTimezoneOffset() / 15) * 15;
	const offsetMinutes = Math.abs(negMinutes);
	const zoneStr = `${negMinutes <= 0 ? '+' : '-'}${padStart(Math.floor(offsetMinutes / 60), 2, '0')}:${padStart(offsetMinutes % 60, 2, '0')}`;

	const hour12 = (n: number) => padStart(hours % 12 || 12, n, '0');

	return str.replaceAll(REGEX_FORMAT, (match: string, escaped?: string) => {
		if (escaped) return escaped;
		switch (match) {
			case 'YY': {
				return String(year).slice(-2);
			}
			case 'YYYY': {
				return padStart(year, 4, '0');
			}
			case 'M': {
				return String(month + 1);
			}
			case 'MM': {
				return padStart(month + 1, 2, '0');
			}
			case 'MMM': {
				return MONTHS[month]!.slice(0, 3);
			}
			case 'MMMM': {
				return MONTHS[month]!;
			}
			case 'D': {
				return String(day);
			}
			case 'DD': {
				return padStart(day, 2, '0');
			}
			case 'd': {
				return String(weekday);
			}
			case 'dd': {
				return WEEKDAYS[weekday]!.slice(0, 2);
			}
			case 'ddd': {
				return WEEKDAYS[weekday]!.slice(0, 3);
			}
			case 'dddd': {
				return WEEKDAYS[weekday]!;
			}
			case 'H': {
				return String(hours);
			}
			case 'HH': {
				return padStart(hours, 2, '0');
			}
			case 'h': {
				return hour12(1);
			}
			case 'hh': {
				return hour12(2);
			}
			case 'a': {
				return hours < 12 ? 'am' : 'pm';
			}
			case 'A': {
				return hours < 12 ? 'AM' : 'PM';
			}
			case 'm': {
				return String(minutes);
			}
			case 'mm': {
				return padStart(minutes, 2, '0');
			}
			case 's': {
				return String(seconds);
			}
			case 'ss': {
				return padStart(seconds, 2, '0');
			}
			case 'SSS': {
				return padStart(millis, 3, '0');
			}
			case 'Z': {
				return zoneStr;
			}
			case 'X': {
				return String(Math.floor(date.getTime() / 1000));
			}
			case 'x': {
				return String(date.getTime());
			}
			default: {
				// 'ZZ'
				return zoneStr.replace(':', '');
			}
		}
	});
}
