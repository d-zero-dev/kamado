import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import * as screen from '../../client/src/logic/kinds.js';
import * as layout from '../../client/src/logic/layout.js';

import { MAX_VALUES } from './app.js';
import {
	createSettingsStore,
	MAX_ENUM_OPTION_LENGTH,
	MAX_ENUM_OPTIONS,
	MAX_KINDS_BYTES,
	parsePatch,
	parseSettings,
} from './settings.js';

const KEY = '/home/u/site/kamado.config.jsonc';

let dir: string;
let file: string;

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'kamado-ui-kinds-'));
	file = path.join(dir, 'ui-settings.json');
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

const enumOf = (...options: unknown[]) => ({ type: 'enum', options });

describe('the screen and the server', () => {
	test('have the same limits (the screen cannot import this module, so it writes them again)', () => {
		expect([
			screen.MAX_ENUM_OPTIONS,
			screen.MAX_ENUM_OPTION_LENGTH,
			screen.MAX_KINDS_BYTES,
		]).toEqual([MAX_ENUM_OPTIONS, MAX_ENUM_OPTION_LENGTH, MAX_KINDS_BYTES]);
	});

	test('the dialog can read as many values as it keeps options (a request asks for no more than the server answers)', () => {
		expect(screen.MAX_ENUM_OPTIONS).toBeLessThanOrEqual(MAX_VALUES);
	});

	test('agree on which options can be kept', () => {
		const long = 'x'.repeat(MAX_ENUM_OPTION_LENGTH + 1);
		const cases: unknown[][] = [
			['a'],
			['a', 1, true, ''],
			[],
			['a', 'a'],
			[1, 1],
			[1, '1'],
			[long],
			['x'.repeat(MAX_ENUM_OPTION_LENGTH)],
			[Number.NaN],
			[Number.POSITIVE_INFINITY],
			[null],
			[{ a: 1 }],
			Array.from({ length: MAX_ENUM_OPTIONS }, (_, n) => n),
			Array.from({ length: MAX_ENUM_OPTIONS + 1 }, (_, n) => n),
			// Within the options' limits and over the bytes: 200 options of 100 characters.
			Array.from({ length: 200 }, (_, n) => `${'y'.repeat(100)}${n}`),
			Array.from({ length: 90 }, (_, n) => `${'あ'.repeat(49)}${n % 10}${n}`),
		];
		for (const options of cases) {
			const refused = screen.optionsProblem(options, 'meta:a', {}) !== null;
			let sent = true;
			try {
				parsePatch({ project: { kinds: { 'meta:a': { type: 'enum', options } } } });
			} catch {
				sent = false;
			}
			expect(!refused, JSON.stringify(options).slice(0, 60)).toBe(sent);
		}
	});

	test('the kinds of all the columns are counted together by both', () => {
		const other = screen.withKind(
			{},
			'meta:other',
			Array.from({ length: 100 }, (_, n) => `${'x'.repeat(100)}${n}`),
		);
		const options = Array.from({ length: 100 }, (_, n) => `${'y'.repeat(100)}${n}`);
		const kinds = screen.withKind(other, 'meta:a', options);
		expect(screen.optionsProblem(options, 'meta:a', other)).toBe('bytes');
		expect(() => parsePatch({ project: { kinds } })).toThrow('"kinds"');
	});

	test('a layout of the columns and kinds as large as each may be fit in the body of a change', () => {
		// Keys as long as a key may be, as many columns as the layout holds.
		const keys = Array.from({ length: 500 }, (_, n) => `${'k'.repeat(240)}${n}`);
		const known = layout.columnIds(keys);
		let state = layout.pinColumn(layout.emptyLayout(), known, known.at(-1) ?? 'url');
		state = layout.moveColumn(state, known, 'virtual', 1);
		// Kinds up to the budget: columns that each have a few long options.
		let kinds: screen.KindsSettings = {};
		for (let n = 0; ; n += 1) {
			const options = Array.from({ length: 5 }, (_, m) => `${'z'.repeat(150)}${n}-${m}`);
			if (screen.optionsProblem(options, `meta:${n}`, kinds) !== null) {
				break;
			}
			kinds = screen.withKind(kinds, `meta:${n}`, options);
		}
		expect(screen.kindsBytes(kinds)).toBeGreaterThan(MAX_KINDS_BYTES - 2000);
		const project = { columns: layout.settingsOf(state, known), kinds };
		// The layout is as large as it may be too, so that this is the worst case of the two.
		expect(JSON.stringify(project.columns).length).toBeGreaterThan(
			layout.MAX_COLUMNS_BYTES - 8000,
		);
		const body = JSON.stringify({
			global: { locale: 'ja' },
			project: {
				...project,
				pageSize: 5000,
				sort: { key: `meta:${'s'.repeat(250)}`, desc: true },
			},
		});
		expect(new TextEncoder().encode(body).length).toBeLessThan(64 * 1024);
		expect(() => parsePatch(JSON.parse(body))).not.toThrow();
	});
});

describe('the kinds in a patch', () => {
	test('are kept as they are sent, whatever the type of an option', () => {
		const kinds = {
			'meta:layout': enumOf('wide', 'narrow'),
			'meta:rank': enumOf(1, 2.5, -3),
			'meta:draft': enumOf(true, false),
			'meta:mixed': enumOf('1', 1, true, ''),
		};
		expect(parsePatch({ project: { kinds } })).toEqual({ project: { kinds } });
	});

	test('may be null or empty, which both take every column back to the kind of its value', () => {
		expect(parsePatch({ project: { kinds: null } })).toEqual({
			project: { kinds: null },
		});
		expect(parsePatch({ project: { kinds: {} } })).toEqual({ project: { kinds: {} } });
	});

	test('drop a field of a kind that is not known', () => {
		expect(
			parsePatch({
				project: { kinds: { 'meta:a': { type: 'enum', options: ['x'], label: 'A' } } },
			}),
		).toEqual({ project: { kinds: { 'meta:a': enumOf('x') } } });
	});

	test('are refused when they are not an object of kinds of metadata columns', () => {
		for (const kinds of [
			'enum',
			[],
			{ title: enumOf('a') },
			{ url: enumOf('a') },
			{ 'meta:': enumOf('a') },
			{ [`meta:${'k'.repeat(300)}`]: enumOf('a') },
			{ 'meta:a': 'enum' },
			{ 'meta:a': null },
			{ 'meta:a': { type: 'text', options: ['a'] } },
			{ 'meta:a': { options: ['a'] } },
			{ 'meta:a': { type: 'enum' } },
			{ 'meta:a': { type: 'enum', options: 'a' } },
		]) {
			expect(
				() => parsePatch({ project: { kinds } }),
				JSON.stringify(kinds).slice(0, 60),
			).toThrow('"kinds"');
		}
	});

	test('are refused when the options are none, are not text, numbers or booleans, or repeat', () => {
		for (const options of [
			[],
			[null],
			[{ a: 1 }],
			[['a']],
			[Number.NaN],
			[Number.POSITIVE_INFINITY],
			['a', 'a'],
			[1, 1],
			[true, true],
		]) {
			expect(
				() => parsePatch({ project: { kinds: { 'meta:a': { type: 'enum', options } } } }),
				JSON.stringify(options),
			).toThrow('"kinds"');
		}
		// The number 1 and the text "1" are two options.
		expect(() =>
			parsePatch({ project: { kinds: { 'meta:a': enumOf(1, '1') } } }),
		).not.toThrow();
	});

	test('are refused when an option, or all of them, are more than the limits', () => {
		const many = Array.from({ length: MAX_ENUM_OPTIONS + 1 }, (_, n) => `v${n}`);
		expect(() =>
			parsePatch({ project: { kinds: { 'meta:a': enumOf(...many) } } }),
		).toThrow('"kinds"');
		expect(() =>
			parsePatch({
				project: { kinds: { 'meta:a': enumOf(...many.slice(0, MAX_ENUM_OPTIONS)) } },
			}),
		).not.toThrow();
		expect(() =>
			parsePatch({
				project: { kinds: { 'meta:a': enumOf('x'.repeat(MAX_ENUM_OPTION_LENGTH + 1)) } },
			}),
		).toThrow('"kinds"');
		expect(() =>
			parsePatch({
				project: { kinds: { 'meta:a': enumOf('x'.repeat(MAX_ENUM_OPTION_LENGTH)) } },
			}),
		).not.toThrow();
		// Columns that are each within the limits, and together too many bytes.
		const wide = Object.fromEntries(
			Array.from({ length: 40 }, (_, n) => [
				`meta:key${n}`,
				enumOf(...Array.from({ length: 5 }, (__, m) => `${'x'.repeat(100)}${m}`)),
			]),
		);
		expect(
			new TextEncoder().encode(JSON.stringify(wide)).length,
			'the test is built to be over the budget',
		).toBeGreaterThan(MAX_KINDS_BYTES);
		expect(() => parsePatch({ project: { kinds: wide } })).toThrow('"kinds"');
	});

	test('count the bytes of the text, not its characters', () => {
		// Each character is 3 bytes in UTF-8: 90 options of about 50 characters are about 14,000
		// bytes, over the budget, but only about 5,000 characters, under it.
		const options = Array.from(
			{ length: 90 },
			(_, n) => `${'あ'.repeat(49)}${n % 10}${n}`,
		);
		const unique = [...new Set(options)];
		expect(unique.length).toBe(90);
		expect(JSON.stringify({ 'meta:a': enumOf(...unique) }).length).toBeLessThan(
			MAX_KINDS_BYTES,
		);
		expect(() =>
			parsePatch({ project: { kinds: { 'meta:a': enumOf(...unique) } } }),
		).toThrow('"kinds"');
	});

	test('keep a column called __proto__ as a column', () => {
		const text =
			'{"project":{"kinds":{"meta:__proto__":{"type":"enum","options":["a"]}}}}';
		const patch = parsePatch(JSON.parse(text));
		expect(Object.keys(patch.project?.kinds ?? {})).toEqual(['meta:__proto__']);
	});
});

describe('the kinds in the file', () => {
	const read = (kinds: unknown) => {
		const parsed = parseSettings(
			JSON.stringify({ version: 1, projects: { a: { pageSize: 100, kinds } } }),
		);
		expect(parsed.state).toBe('ok');
		return (parsed as Extract<typeof parsed, { state: 'ok' }>).settings.projects.a;
	};

	test('are read, and what is not allowed is dropped', () => {
		expect(
			read({
				'meta:layout': {
					type: 'enum',
					options: ['wide', 'wide', null, 1, { a: 1 }, true],
				},
				'meta:none': { type: 'enum', options: [null] },
				'meta:text': { type: 'text', options: ['a'] },
				title: enumOf('a'),
				'meta:bad': 'enum',
			})?.kinds,
		).toEqual({ 'meta:layout': enumOf('wide', 1, true) });
	});

	test('are cut to the limits of the options and of the bytes', () => {
		const many = Array.from({ length: MAX_ENUM_OPTIONS + 20 }, (_, n) => `v${n}`);
		const kinds = read({ 'meta:a': enumOf(...many) })?.kinds;
		expect(kinds?.['meta:a']?.options).toHaveLength(MAX_ENUM_OPTIONS);
		const wide = Object.fromEntries(
			Array.from({ length: 60 }, (_, n) => [
				`meta:key${n}`,
				enumOf(...Array.from({ length: 5 }, (__, m) => `${'x'.repeat(100)}${m}`)),
			]),
		);
		const kept = read(wide)?.kinds ?? {};
		expect(new TextEncoder().encode(JSON.stringify(kept)).length).toBeLessThanOrEqual(
			MAX_KINDS_BYTES,
		);
		expect(Object.keys(kept).length).toBeGreaterThan(0);
		expect(Object.keys(kept).length).toBeLessThan(60);
		// The columns kept are the first ones, as the file has them.
		expect(Object.keys(kept)[0]).toBe('meta:key0');
	});

	test('are left out when they are not an object, or hold nothing', () => {
		expect(read('enum')).not.toHaveProperty('kinds');
		expect(read({})).not.toHaveProperty('kinds');
		expect(read([enumOf('a')])).not.toHaveProperty('kinds');
	});
});

describe('saving the kinds', () => {
	test('are saved with the rest of the project, and null removes them', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({ project: { pageSize: 100 } });
		const kinds = {
			'meta:layout': { type: 'enum' as const, options: ['wide', 'narrow'] },
		};
		const view = await store.update({ project: { kinds } });
		expect(view.project).toMatchObject({ pageSize: 100, kinds });
		const written = JSON.parse(await readFile(file, 'utf8')) as {
			projects: Record<string, { kinds?: unknown }>;
		};
		expect(written.projects[KEY]?.kinds).toEqual(kinds);
		const cleared = await store.update({ project: { kinds: null } });
		expect(cleared.project).not.toHaveProperty('kinds');
		expect(cleared.project?.pageSize).toBe(100);
	});

	test('an empty object is the same as null: every column goes back to the kind of its value', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({
			project: { kinds: { 'meta:a': { type: 'enum', options: ['x'] } } },
		});
		const view = await store.update({ project: { kinds: {} } });
		expect(view.project).not.toHaveProperty('kinds');
	});

	test('a save of the layout, the sort or the page size leaves them as they were', async () => {
		const store = createSettingsStore(file, KEY);
		const kinds = { 'meta:a': { type: 'enum' as const, options: ['x', 'y'] } };
		await store.update({ project: { kinds } });
		const view = await store.update({
			project: {
				pageSize: 1000,
				sort: { key: 'url', desc: false },
				columns: { pinned: ['url'] },
			},
		});
		expect(view.project?.kinds).toEqual(kinds);
	});

	test('a save of the kinds leaves the layout as it was, and replaces every kind', async () => {
		const store = createSettingsStore(file, KEY);
		await store.update({
			project: {
				columns: { pinned: ['meta:a'] },
				kinds: { 'meta:a': { type: 'enum', options: ['x'] } },
			},
		});
		const view = await store.update({
			project: { kinds: { 'meta:b': { type: 'enum', options: ['y'] } } },
		});
		expect(view.project?.columns).toEqual({ pinned: ['meta:a'] });
		expect(view.project?.kinds).toEqual({ 'meta:b': { type: 'enum', options: ['y'] } });
	});
});
