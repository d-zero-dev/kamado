import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const css = readFileSync(new URL('../../client/src/style.css', import.meta.url), 'utf8');

/**
 * The custom properties of a block of the style sheet.
 * @param block - The text between the braces
 */
function tokens(block: string): Record<string, string> {
	return Object.fromEntries(
		[...block.matchAll(/(--[\w-]+):\s*(#[\da-f]{3,6})\s*;/giu)].map((m) => [m[1], m[2]]),
	);
}

const light = tokens(/:root\s*\{([^}]*)\}/u.exec(css)?.[1] ?? '');
const dark = tokens(
	/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/u.exec(css)?.[1] ??
		'',
);

/**
 * The relative luminance of a colour (WCAG 2.2).
 * @param color - The colour, `#rgb` or `#rrggbb`
 */
function luminance(color: string): number {
	const hex =
		color.length === 4
			? `#${[1, 2, 3].map((at) => color.charAt(at).repeat(2)).join('')}`
			: color;
	const [r = 0, g = 0, b = 0] = [1, 3, 5].map((at) => {
		const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
		return channel <= 0.039_28 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The contrast ratio of two colours (WCAG 2.2).
 * @param a - A colour, `#rrggbb`
 * @param b - Another
 */
function contrast(a: string, b: string): number {
	const [high, low] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return ((high ?? 0) + 0.05) / ((low ?? 0) + 0.05);
}

// What a cell is drawn on: the page, a read only cell, and the cell with the focus.
const BACKGROUNDS = ['--bg', '--readonly-bg', '--active-bg'] as const;
const KINDS = ['--diff-modified', '--diff-added', '--diff-deleted'] as const;

describe.each([
	['light', light],
	['dark', dark],
] as const)('the colours of the %s scheme', (_name, scheme) => {
	test.each(KINDS)('%s is a colour', (kind) => {
		expect(scheme[kind]).toMatch(/^#[\da-f]{6}$/iu);
	});

	// The bar of a difference is a mark that has to be seen (WCAG 2.2, 1.4.11: 3:1).
	test.each(KINDS.flatMap((kind) => BACKGROUNDS.map((bg) => [kind, bg] as const)))(
		'%s is at least 3:1 on %s',
		(kind, bg) => {
			expect(contrast(scheme[kind] ?? '', scheme[bg] ?? '')).toBeGreaterThanOrEqual(3);
		},
	);

	// The small text under a value (WCAG 2.2, 1.4.3: 4.5:1) is drawn in the colour of a note.
	test.each(BACKGROUNDS)('the colour of the notes is at least 4.5:1 on %s', (bg) => {
		expect(contrast(scheme['--muted'] ?? '', scheme[bg] ?? '')).toBeGreaterThanOrEqual(
			4.5,
		);
	});

	test('the three kinds are told apart', () => {
		const colours = KINDS.map((kind) => scheme[kind]);
		expect(new Set(colours).size).toBe(3);
	});
});

describe('the style sheet', () => {
	test('has the colours of the kinds of difference in both schemes', () => {
		expect(Object.keys(light)).toEqual(expect.arrayContaining([...KINDS]));
		expect(Object.keys(dark)).toEqual(expect.arrayContaining([...KINDS]));
	});
});
