import dayjs from 'dayjs';
import { afterAll, describe, expect, test } from 'vitest';

import { formatDate } from './format-date.js';
import { createRng } from './random.test-util.js';

const TOKENS = [
	'YYYY',
	'YY',
	'M',
	'MM',
	'MMM',
	'MMMM',
	'D',
	'DD',
	'd',
	'dd',
	'ddd',
	'dddd',
	'H',
	'HH',
	'h',
	'hh',
	'm',
	'mm',
	's',
	'ss',
	'SSS',
	'A',
	'a',
	'Z',
	'ZZ',
];
const LITERALS = [
	'-',
	'/',
	' ',
	':',
	'T',
	'[at]',
	'[YYYY]',
	'[Z h]',
	'年',
	'.',
	'o',
	'Q',
	'SS',
];
/** Tokens that plain dayjs does not know (see the deviation test). */
const EXTRA_TOKENS = ['X', 'x'];

const FIXED_FORMATS = [
	'',
	'YYYY-MM-DD',
	'YYYY-MM-DDTHH:mm:ssZ',
	'YYYY/M/D (ddd) h:mm A',
	'dddd, MMMM D, YYYY',
	'YYYYMMDDHHmmss.SSS ZZ',
	'[Today is] dddd',
	'MMMMM DDD YYY ZZZ',
	'hh:mm a',
	'YY年M月D日',
];

const ZONES = [
	'UTC',
	'Asia/Tokyo',
	'America/New_York',
	'Europe/London',
	'Australia/Lord_Howe',
	'Asia/Kolkata',
	'Asia/Kathmandu',
	'Pacific/Chatham',
	'America/St_Johns',
	'Pacific/Apia',
];

/**
 * Builds a random format string from tokens and literals.
 * @param rng - Random source.
 * @param tokens - Token pool.
 * @returns The format string.
 */
function randomFormat(
	rng: ReturnType<typeof createRng>,
	tokens: readonly string[],
): string {
	let format = '';
	for (let i = rng.int(1, 8); i > 0; i--) {
		format += rng.chance(0.7) ? rng.pick(tokens) : rng.pick(LITERALS);
	}
	return format;
}

/**
 * Builds a random string input in the shapes dayjs's own regex or `Date` parses.
 * @param rng - Random source.
 * @returns The input string.
 */
function randomDateString(rng: ReturnType<typeof createRng>): string {
	const y = rng.pick(['1970', '1999', '2000', '2024', '2038', '0099', '0001', '9999']);
	const mo = rng.pick(['1', '01', '02', '12', '13', '00']);
	const d = rng.pick(['1', '05', '28', '29', '31', '32', '00', '']);
	const h = rng.pick(['0', '00', '09', '12', '23', '24']);
	const mi = rng.pick(['0', '07', '59', '60']);
	const s = rng.pick(['0', '05', '59']);
	const ms = rng.pick(['5', '05', '123', '123456', '999']);
	const zone = rng.pick(['', '', 'Z', 'z', '+09:00', '-0500', '+05:45']);
	return rng.pick([
		() => y,
		() => `${y}-${mo}`,
		() => `${y}-${mo}-${d}`,
		() => `${y}/${mo}/${d}`,
		() => `${y}${mo.padStart(2, '0')}${d.padStart(2, '0')}`,
		() => `${y}-${mo}-${d}T${h}:${mi}`,
		() => `${y}-${mo}-${d}T${h}:${mi}:${s}`,
		() => `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}${zone}`,
		() => `${y}-${mo}-${d} ${h}:${mi}:${s}`,
		() => `${y}/${mo}/${d} ${h}:${mi}:${s}.${ms}`,
		() => `${y}-${mo}-${d}t${h}:${mi}${zone}`,
		() => `${y}-${mo}-${d}T${h}:${mi}:${s}${zone}`,
		() => `${y}-${mo}-${d}T${h}:${mi}:${s}:${ms}`,
		() => `${y}-${mo}-${d}  `,
		() => `${y}-${mo}-${d}T`,
		() => 'invalid',
		() => '',
		() => 'Mar 5 2024',
		() => 'Tue, 05 Mar 2024 10:00:00 GMT',
		() => '2024-03-05T10:00:00+0900',
	])();
}

/**
 * Instants around the DST transitions of the current local zone, found by scanning each
 * year and refining every offset change down to the minute.
 * @returns Epoch milliseconds a few minutes either side of each transition.
 */
function transitionInstants(): number[] {
	const instants: number[] = [];
	const hour = 3_600_000;
	for (const year of [1999, 2000, 2024, 2025, 2038]) {
		let previous = new Date(Date.UTC(year, 0, 1)).getTimezoneOffset();
		for (let t = Date.UTC(year, 0, 1); t < Date.UTC(year + 1, 0, 1); t += hour) {
			const offset = new Date(t).getTimezoneOffset();
			if (offset !== previous) {
				for (let delta = -2 * hour; delta <= 2 * hour; delta += 15 * 60_000) {
					instants.push(t + delta, t + delta + 59_999);
				}
				previous = offset;
			}
		}
	}
	return instants;
}

const originalTZ = process.env.TZ;

afterAll(() => {
	if (originalTZ === undefined) delete process.env.TZ;
	else process.env.TZ = originalTZ;
});

describe('formatDate', () => {
	test('known outputs', () => {
		process.env.TZ = 'Asia/Tokyo';
		expect(formatDate('2024-03-05', 'YYYY/MM/DD (ddd)')).toBe('2024/03/05 (Tue)');
		expect(formatDate('2024-03-05T15:04:09.5', 'h:mm:ss.SSS A')).toBe('3:04:09.005 PM');
		expect(formatDate(new Date(2024, 0, 2, 0, 4), "hh [o'clock] a Z ZZ")).toBe(
			"12 o'clock am +09:00 +0900",
		);
		expect(formatDate('2024-03-05T00:00:00Z', 'YYYY-MM-DD HH:mm')).toBe(
			'2024-03-05 09:00',
		);
		expect(formatDate(0, 'YYYY-MM-DD HH:mm')).toBe('1970-01-01 09:00');
		expect(formatDate('nope', 'YYYY')).toBe('Invalid Date');
	});

	for (const zone of ZONES) {
		describe(`TZ=${zone}`, () => {
			test('matches dayjs for random instants and formats', () => {
				process.env.TZ = zone;
				// Guard: the zone switch must take effect at runtime.
				if (zone === 'Asia/Tokyo') {
					expect(new Date(2024, 0, 1).getTimezoneOffset()).toBe(-540);
				}
				if (zone === 'America/New_York') {
					expect(new Date(2024, 0, 1).getTimezoneOffset()).toBe(300);
				}
				const rng = createRng(30);
				for (let i = 0; i < 1500; i++) {
					const ms = rng.chance(0.2)
						? rng.int(-62_135_596_800_000, 253_402_300_799_999)
						: rng.int(0, 4_102_444_800_000);
					const value = rng.pick([ms, new Date(ms)]);
					const format = rng.chance(0.3)
						? rng.pick(FIXED_FORMATS)
						: randomFormat(rng, TOKENS);
					expect(formatDate(value, format), `${ms} ${format}`).toBe(
						dayjs(value).format(format),
					);
				}
			});

			test('matches dayjs around DST transitions', () => {
				process.env.TZ = zone;
				const instants = transitionInstants();
				const format = 'YYYY-MM-DD HH:mm:ss.SSS Z ZZ h A';
				for (const ms of instants) {
					expect(formatDate(ms, format), String(ms)).toBe(dayjs(ms).format(format));
				}
				// Local strings in the skipped hour / repeated hour parse like dayjs.
				for (const ms of instants) {
					const local = dayjs(ms).format('YYYY-MM-DD HH:mm:ss');
					expect(formatDate(local, format), local).toBe(dayjs(local).format(format));
				}
			});

			test('parses string inputs like dayjs', () => {
				process.env.TZ = zone;
				const rng = createRng(31);
				for (let i = 0; i < 1500; i++) {
					const value = randomDateString(rng);
					const format = rng.pick(FIXED_FORMATS.slice(1));
					expect(formatDate(value, format), `${value} | ${format}`).toBe(
						dayjs(value).format(format),
					);
				}
			});
		});
	}

	test('handles odd numbers and values like dayjs', () => {
		process.env.TZ = 'Asia/Tokyo';
		const values: (number | Date)[] = [
			Number.NaN,
			Number.POSITIVE_INFINITY,
			8.64e15,
			8.64e15 + 1,
			-8.64e15,
			-1,
			1.5,
			new Date(Number.NaN),
		];
		for (const value of values) {
			for (const format of FIXED_FORMATS) {
				expect(formatDate(value, format), `${value} ${format}`).toBe(
					dayjs(value).format(format),
				);
			}
		}
		expect(formatDate(null as never, 'YYYY')).toBe(dayjs(null).format('YYYY'));
		expect(formatDate('2024-01-01', '')).toBe('2024-01-01T00:00:00+09:00');
	});

	// Intentional deviation from v2 (`filters.date` = plain `dayjs(date).format`):
	// `X` (Unix seconds) and `x` (Unix milliseconds) are tokens here, as in dayjs's
	// `advancedFormat` plugin, whereas plain dayjs prints them as literal letters.
	test('X and x are tokens (v2 printed the letters)', () => {
		process.env.TZ = 'Asia/Tokyo';
		const ms = 1_709_600_000_123;
		expect(dayjs(ms).format('X x')).toBe('X x');
		expect(formatDate(ms, 'X x')).toBe('1709600000 1709600000123');
		expect(formatDate(ms, '[X] [x]')).toBe('X x');
		expect(formatDate(-1500, 'X')).toBe('-2');
		const rng = createRng(32);
		for (let i = 0; i < 300; i++) {
			const value = rng.int(-4_000_000_000_000, 4_102_444_800_000);
			const format = randomFormat(rng, [...TOKENS, ...EXTRA_TOKENS]);
			// Every other token still matches plain dayjs once X / x are substituted.
			const substituted = format.replaceAll(/\[[^\]]+\]|X|x/g, (m) =>
				m === 'X' ? `[${Math.floor(value / 1000)}]` : m === 'x' ? `[${value}]` : m,
			);
			expect(formatDate(value, format), format).toBe(dayjs(value).format(substituted));
		}
	});
});
