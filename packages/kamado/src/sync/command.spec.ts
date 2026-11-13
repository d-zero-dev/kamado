import type { SyncSummary } from './types.js';

import { describe, expect, test, vi } from 'vitest';

import { summaryText, syncCommand, type SyncCommandContext } from './command.js';
import { SyncError, type SyncReport, type SyncRun } from './sync.js';

const COUNTS = {
	added: 0,
	deleted: 0,
	movedUrl: 0,
	movedFile: 0,
	virtualized: 0,
	materialized: 0,
	meta: 0,
};

/**
 *
 * @param over
 */
function summary(over: Partial<SyncSummary> = {}): SyncSummary {
	return {
		counts: { ...COUNTS, deleted: 1 },
		changes: [{ kind: 'deleted', url: '/a/', inputPath: 'a/index.html' }],
		unsaved: [],
		...over,
	};
}

type Run = NonNullable<SyncCommandContext['run']>;

/**
 *
 * @param over
 */
function context(over: Partial<SyncCommandContext> & { run?: Run } = {}) {
	const out: string[] = [];
	const ctx: SyncCommandContext = {
		cwd: '/work',
		resolveConfig: () => '/site/kamado.config.jsonc',
		write: (text) => out.push(text),
		interactive: true,
		ask: vi.fn(async () => 'y'),
		run: vi.fn<Run>(async (_c, _t, options) => {
			if (await options.confirm?.(summary())) {
				return { kind: 'applied', direction: 'import', summary: summary(), count: 1 };
			}
			return { kind: 'declined', direction: 'import', summary: summary() };
		}),
		...over,
	};
	return { ctx, out };
}

describe('summaryText', () => {
	test('lists each change on a line, a kind to a mark', () => {
		expect(
			summaryText({
				counts: COUNTS,
				unsaved: [],
				changes: [
					{ kind: 'deleted', url: '/d/', inputPath: 'd.html' },
					{ kind: 'movedUrl', from: '/a/', to: '/b/' },
					{ kind: 'movedFile', url: '/m/', from: 'm.html', to: 'n.html' },
					{ kind: 'virtualized', url: '/v/', inputPath: 'v.html' },
					{ kind: 'materialized', url: '/w/', inputPath: null },
					{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 0 },
					{ kind: 'added', url: '/f/', virtual: false, inputPath: 'f.html', keys: 2 },
					{ kind: 'meta', url: '/p/', key: 'title', before: 'A', after: 'B' },
					{ kind: 'meta', url: '/p/', key: 'new', after: 1 },
					{ kind: 'meta', url: '/p/', key: 'gone', before: 1 },
				],
			}),
		).toBe(
			[
				'10 changes:',
				'- /d/ (d.html)',
				'~ /a/ -> /b/',
				'~ /m/: m.html -> n.html',
				'~ /v/: v.html -> virtual',
				'~ /w/: virtual -> a file at its URL',
				'+ /n/ (virtual)',
				'+ /f/ (f.html, 2 keys)',
				'* /p/ title: "A" -> "B"',
				'* /p/ new: 1',
				'* /p/ gone: 1 -> (removed)',
				'',
			].join('\n'),
		);
	});

	test('says change for one', () => {
		expect(summaryText(summary())).toBe('1 change:\n- /a/ (a/index.html)\n');
	});

	test('says key and file for one, keys and files for more', () => {
		const one = summaryText(
			summary({
				changes: [{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 1 }],
				unsaved: ['a.html'],
			}),
		);
		expect(one).toContain('+ /n/ (virtual, 1 key)');
		expect(one).toContain('warning: 1 file has changes that git cannot bring back');
		const many = summaryText(
			summary({
				changes: [{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 2 }],
				unsaved: ['a.html', 'b.html'],
			}),
		);
		expect(many).toContain('+ /n/ (virtual, 2 keys)');
		expect(many).toContain('warning: 2 files have changes that git cannot bring back');
	});

	test('cuts a long list and says how many more there are', () => {
		const changes = Array.from({ length: 205 }, (_, i) => ({
			kind: 'deleted' as const,
			url: `/p${i}/`,
			inputPath: null,
		}));
		const lines = summaryText({ counts: COUNTS, changes, unsaved: [] }).split('\n');
		expect(lines[0]).toBe('205 changes:');
		expect(lines).toHaveLength(1 + 200 + 1 + 1);
		expect(lines[201]).toBe('... and 5 more');
	});

	test('warns of the files git cannot bring back, or that git cannot tell', () => {
		expect(summaryText(summary({ unsaved: ['a.html', 'b.html'] }))).toContain(
			'warning: 2 files have changes that git cannot bring back (not committed, or ignored): a.html, b.html',
		);
		expect(summaryText(summary({ gitUnavailable: true }))).toContain(
			'warning: git cannot bring these changes back',
		);
		expect(summaryText(summary())).not.toContain('warning');
	});

	test('names no more than twenty files of the warning', () => {
		const unsaved = Array.from({ length: 25 }, (_, i) => `f${i}.html`);
		const text = summaryText(summary({ unsaved }));
		expect(text).toContain('f19.html, and 5 more');
		expect(text).not.toContain('f20.html');
	});

	test('spells out what a terminal would obey in what it shows', () => {
		const esc = String.fromCodePoint(27);
		const text = summaryText(
			summary({
				changes: [{ kind: 'deleted', url: `/a/${esc}[2J`, inputPath: null }],
				unsaved: [`x${esc}.html`],
			}),
		);
		expect(text).not.toContain(esc);
		expect(text).toContain(String.raw`/a/\x1B[2J`);
		expect(text).toContain(String.raw`x\x1B.html`);
	});
});

describe('syncCommand', () => {
	test('takes one argument', async () => {
		const { ctx } = context();
		await expect(syncCommand([], {}, ctx)).rejects.toThrow('sync takes one argument');
		await expect(syncCommand(['a', 'b'], {}, ctx)).rejects.toThrow(
			'sync takes one argument',
		);
	});

	test('runs the target against the config, with the flags', async () => {
		const { ctx } = context();
		await syncCommand(['import'], { yes: true, 'cache-dir': '/cache' }, ctx);
		const [config, target, options] = vi.mocked(ctx.run!).mock.calls[0]!;
		expect(config).toBe('/site/kamado.config.jsonc');
		expect(target).toBe('import');
		expect(options).toMatchObject({ yes: true, cacheDir: '/cache', cwd: '/work' });
	});

	test('shows the changes, asks, and applies on a yes', async () => {
		const { ctx, out } = context();
		expect(await syncCommand(['import'], {}, ctx)).toBe(0);
		expect(out.join('')).toContain('1 change:');
		expect(ctx.ask).toHaveBeenCalledWith('Apply these changes? [y/N] ');
		expect(out.join('')).toContain('Applied 1 change.');
		expect(out.join('')).toContain('git reset');
	});

	test.each(['y', 'Y', 'yes', ' YES '])('takes %j as a yes', async (answer) => {
		const { ctx, out } = context({ ask: vi.fn(async () => answer) });
		await syncCommand(['import'], {}, ctx);
		expect(out.join('')).toContain('Applied');
	});

	test.each(['', 'n', 'no', 'maybe', 'yes please'])(
		'takes %j as a no, and applies nothing',
		async (answer) => {
			const { ctx, out } = context({ ask: vi.fn(async () => answer) });
			expect(await syncCommand(['import'], {}, ctx)).toBe(0);
			expect(out.join('')).toContain('Nothing was applied.');
			expect(out.join('')).not.toContain('Applied');
		},
	);

	test('does not ask on what is not a terminal: it shows the changes and fails', async () => {
		const { ctx, out } = context({ interactive: false });
		await expect(syncCommand(['import'], {}, ctx)).rejects.toThrow(
			'this is not a terminal to confirm them on (pass --yes to apply them)',
		);
		expect(out.join('')).toContain('1 change:');
		expect(ctx.ask).not.toHaveBeenCalled();
	});

	test('does not ask with --yes: the run is told yes', async () => {
		const { ctx } = context({ interactive: false });
		const run = vi.fn<Run>(async () => ({
			kind: 'applied',
			summary: summary(),
			count: 1,
		}));
		await syncCommand(['import'], { yes: true }, { ...ctx, run });
		expect(run.mock.calls[0]![2].yes).toBe(true);
		expect(ctx.ask).not.toHaveBeenCalled();
	});

	test('says that nothing changed', async () => {
		const report: SyncReport = {
			kind: 'nochange',
			direction: 'import',
			summary: summary(),
		};
		const { ctx, out } = context({ run: vi.fn<Run>(async () => report) });
		expect(await syncCommand(['import'], {}, ctx)).toBe(0);
		expect(out.join('')).toContain('No changes');
	});

	test('a script that failed is told with its stack, and the code is 1', async () => {
		const { ctx, out } = context({
			run: vi.fn<Run>(async () => {
				throw new SyncError('failed', 'the script failed: no sheet', {
					scriptStack: 'Error: no sheet\n    at f (s.mjs:1:1)',
				});
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(1);
		const text = out.join('');
		expect(text).toContain('the script failed: no sheet');
		expect(text).toContain('at f (s.mjs:1:1)');
		expect(text).toContain('Nothing was changed.');
	});

	test('what cannot be applied is told in every problem, and the code is 1', async () => {
		const { ctx, out } = context({
			run: vi.fn<Run>(async () => {
				throw new SyncError('invalid', 'x', {
					problems: [
						{ row: 1, url: null, message: 'row 1: one' },
						{ row: 2, url: null, message: 'row 2: two' },
					],
				});
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(1);
		expect(out.join('')).toContain('  row 1: one\n  row 2: two\n');
	});

	test('what the core refused is told by the page and the operation, and the code is 1', async () => {
		const { ctx, out } = context({
			run: vi.fn<Run>(async () => {
				throw new SyncError('refused', 'nothing was applied: changed', {
					failures: [
						{ url: '/a/', op: 'moveUrl', code: 'conflict', message: 'changed' },
						{ url: null, op: null, code: 'io', message: 'cannot write' },
					],
				});
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(1);
		const text = out.join('');
		expect(text).toContain('nothing was applied: changed');
		expect(text).toContain('  /a/ moveUrl: changed');
		expect(text).toContain(': cannot write');
	});

	test('a cancelled run is 130', async () => {
		const { ctx } = context({
			run: vi.fn<Run>(async () => {
				throw new SyncError('cancelled', 'the sync was cancelled');
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(130);
	});

	test('Ctrl-C at the question is a cancel too: nothing is applied and the code is 130', async () => {
		const { ctx, out } = context({
			ask: vi.fn(async () => {
				throw new Error('aborted');
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(130);
		expect(out.join('')).toContain('Cancelled.');
	});

	test('Ctrl-C while the script runs cancels it, and the code is 130', async () => {
		let cancelled = false;
		const { ctx, out } = context({
			run: vi.fn<Run>(async (_c, _t, options: SyncRun) => {
				options.onRun?.({
					done: new Promise(() => {}),
					cancel: () => {
						cancelled = true;
					},
				});
				process.emit('SIGINT');
				throw new SyncError('cancelled', 'the sync was cancelled');
			}),
		});
		expect(await syncCommand(['import'], {}, ctx)).toBe(130);
		expect(cancelled).toBe(true);
		expect(out.join('')).toContain('Cancelled.');
		// the handler is taken off again
		expect(process.listenerCount('SIGINT')).toBe(listenersBefore);
	});

	test('an error that is not of the sync is left for the command line to say', async () => {
		const { ctx } = context({
			run: vi.fn<Run>(async () => {
				throw new Error('config file not found');
			}),
		});
		await expect(syncCommand(['import'], {}, ctx)).rejects.toThrow(
			'config file not found',
		);
	});
});

const listenersBefore = process.listenerCount('SIGINT');
