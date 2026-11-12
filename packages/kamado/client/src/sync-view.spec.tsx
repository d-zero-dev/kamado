import type { HeldChanges } from './sync-view.js';
import type { SyncChange, SyncState } from './types.js';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { translator } from './i18n/translate.js';
import { NO_LOG, type HeldLog } from './logic/sync.js';
import { ChangeLine, SyncView } from './sync-view.js';

const COUNTS = {
	deleted: 0,
	movedUrl: 0,
	added: 0,
	meta: 0,
	movedFile: 0,
	virtualized: 0,
	materialized: 0,
};

/**
 *
 * @param over
 */
function state(over: Partial<SyncState>): SyncState {
	return {
		id: 'id-1',
		name: 'import',
		status: 'running',
		log: [],
		next: 0,
		dropped: 0,
		...over,
	};
}

/**
 *
 * @param over
 * @param over.state
 * @param over.log
 * @param over.tab
 * @param over.changes
 * @param over.problem
 * @param over.language
 */
function view(
	over: {
		state?: SyncState | null;
		log?: HeldLog;
		tab?: Parameters<typeof SyncView>[0]['tab'];
		changes?: HeldChanges | null;
		problem?: string | null;
		language?: 'en' | 'ja';
	} = {},
) {
	return renderToStaticMarkup(
		<SyncView
			name="Import from the sheet"
			state={over.state ?? null}
			log={over.log ?? NO_LOG}
			tab={over.tab ?? null}
			changes={over.changes ?? null}
			problem={over.problem ?? null}
			t={translator(over.language ?? 'en')}
			onTab={() => {}}
			onMore={() => {}}
		/>,
	);
}

describe('while the script runs', () => {
	test('shows that it runs, its log as it comes, and has no way to apply', () => {
		const html = view({
			log: {
				lines: [
					{ type: 'info', message: 'reading the sheet' },
					{ type: 'warn', message: 'two rows have no url' },
				],
				next: 2,
				dropped: 0,
			},
		});
		expect(html).toContain('Running “Import from the sheet”…');
		expect(html).toContain('class="spinner"');
		expect(html).toContain('role="status"');
		expect(html).toContain('aria-live="polite"');
		expect(html).toContain('class="log-warn"');
		expect(html).toContain('reading the sheet');
		expect(html).not.toContain('Apply');
	});

	test('says that there is no log yet, and how many old lines are not shown', () => {
		expect(view()).toContain('The script has not written anything yet');
		const html = view({
			log: { lines: [{ type: 'info', message: 'x' }], next: 1001, dropped: 1000 },
		});
		expect(html).toContain('1000 older line(s) are not shown');
	});

	test('is the same for a sync that was just cancelled', () => {
		expect(view({ state: state({ status: 'cancelled' }) })).toContain('class="spinner"');
	});
});

describe('when the script fails', () => {
	const failed = state({
		status: 'failed',
		failure: {
			message: 'no network',
			stack: 'Error: no network\n    at fetchRows (s.mjs:3:9)',
		},
	});

	test('tells it in an alert, with the details folded, and says nothing was applied', () => {
		const html = view({ state: failed });
		expect(html).toContain('The sync failed');
		expect(html).toContain('role="alert"');
		expect(html).toContain('no network');
		expect(html).toContain('<details><summary>Details</summary><pre>');
		expect(html).toContain('at fetchRows (s.mjs:3:9)');
		expect(html).toContain('Nothing was applied.');
		expect(html).toContain('Import from the sheet');
	});

	test('keeps the log that came before', () => {
		const html = view({
			state: failed,
			log: { lines: [{ type: 'error', message: 'row 3 is bad' }], next: 1, dropped: 0 },
		});
		expect(html).toContain('row 3 is bad');
		expect(html).toContain('aria-live="off"');
	});

	test('has no details for a failure that has no stack', () => {
		const html = view({
			state: state({
				status: 'failed',
				failure: { message: 'the script ended', stack: null },
			}),
		});
		expect(html).not.toContain('<details');
	});

	test('says it in Japanese', () => {
		const html = view({ state: failed, language: 'ja' });
		expect(html).toContain('同期に失敗しました');
		expect(html).toContain('何も適用していません。');
		expect(html).toContain('詳細');
	});
});

describe('when there is nothing to apply', () => {
	test('a script that returned nothing', () => {
		const html = view({ state: state({ status: 'nothing' }) });
		expect(html).toContain('The script returned nothing');
		expect(html).toContain('Nothing was applied.');
	});

	test('a result that is what the files are', () => {
		const html = view({ state: state({ status: 'nochange' }) });
		expect(html).toContain('No changes');
		expect(html).toContain('✓');
		expect(html).toContain(
			'The files of the local repository match what the script returned.',
		);
		expect(view({ state: state({ status: 'nochange' }), language: 'ja' })).toContain(
			'ローカルリポジトリのファイルは、スクリプトが返した内容と一致しています。',
		);
	});
});

describe('a result that cannot be applied', () => {
	test('lists every problem it was told, and how many more there are', () => {
		const html = view({
			state: state({
				status: 'invalid',
				problems: {
					total: 5,
					listed: [
						'row 1 (no): url must be a string that starts with /',
						'row 2: must be an object',
					],
				},
			}),
		});
		expect(html).toContain('The result cannot be applied');
		expect(html).toContain(
			'<li>row 1 (no): url must be a string that starts with /</li>',
		);
		expect(html).toContain('<li>row 2: must be an object</li>');
		expect(html).toContain('3 more problem(s) are not listed');
		expect(html).toContain('role="alert"');
	});
});

describe('the differences to apply', () => {
	const review = state({
		status: 'review',
		summary: {
			counts: { ...COUNTS, deleted: 2, meta: 5 },
			total: 7,
			unsaved: { total: 0, listed: [] },
			gitUnavailable: false,
		},
	});

	test('says how many, and what applying does, in the words of the screen', () => {
		const html = view({ state: review, tab: 'deleted' });
		expect(html).toContain('There are 7 difference(s).');
		expect(html).toContain('Applying changes the files of the local repository.');
		const ja = view({ state: review, tab: 'deleted', language: 'ja' });
		expect(ja).toContain('7 件の差分があります。');
		expect(ja).toContain('適用すると、ローカルリポジトリのファイルが変わります。');
		expect(html).not.toContain('site');
	});

	test('has a tab for four kinds always, faint when empty, and the one shown is selected', () => {
		const html = view({ state: review, tab: 'deleted' });
		expect(html).toContain('role="tablist"');
		const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
		expect(tabs).toHaveLength(4);
		const disabled = tabs.filter((tab) => tab.includes('disabled'));
		expect(disabled).toHaveLength(2);
		expect(tabs.find((tab) => tab.includes('sync-tab-deleted'))).toContain(
			'aria-selected="true"',
		);
		expect(tabs.find((tab) => tab.includes('sync-tab-meta'))).toContain(
			'aria-selected="false"',
		);
		expect(html).toContain('role="tabpanel"');
		expect(html).toContain('aria-labelledby="sync-tab-deleted"');
	});

	test('adds a tab only for the other kinds that have a change', () => {
		const html = view({
			state: state({
				...review,
				summary: {
					...review.summary!,
					counts: { ...COUNTS, movedFile: 1, virtualized: 1 },
				},
			}),
			tab: 'movedFile',
		});
		const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
		expect(tabs).toHaveLength(6);
		expect(html).toContain('File moved');
		expect(html).toContain('Made virtual');
		expect(html).not.toContain('Given a file');
	});

	test('lists the changes of the tab and offers more when there are more', () => {
		const html = view({
			state: review,
			tab: 'deleted',
			changes: {
				kind: 'deleted',
				items: [{ kind: 'deleted', url: '/a/', inputPath: 'a/index.html' }],
				total: 150,
				loading: false,
			},
		});
		expect(html).toContain('<code>/a/</code>');
		expect(html).toContain('a/index.html');
		expect(html).toContain('Show more (1 / 150)');
		const all = view({
			state: review,
			tab: 'deleted',
			changes: {
				kind: 'deleted',
				items: [{ kind: 'deleted', url: '/a/', inputPath: null }],
				total: 1,
				loading: false,
			},
		});
		expect(all).not.toContain('Show more');
	});

	test('warns of the files git cannot bring back, by name, and of those it does not name', () => {
		const html = view({
			state: state({
				...review,
				summary: {
					...review.summary!,
					unsaved: { total: 3, listed: ['a.html', 'b/c.html'] },
				},
			}),
			tab: 'deleted',
		});
		expect(html).toContain('3 file(s) have changes that git cannot bring back');
		expect(html).toContain('<code>a.html</code>');
		expect(html).toContain('and 1 more');
		expect(html).toContain('role="alert"');
	});

	test('warns when git cannot tell, and says that once', () => {
		const html = view({
			state: state({
				...review,
				summary: { ...review.summary!, gitUnavailable: true },
			}),
			tab: 'deleted',
		});
		expect(html).toContain(
			'git cannot bring these changes back (this is not a repository',
		);
		expect(html).not.toContain('have changes that git cannot bring back');
	});
});

describe('how a change is written', () => {
	const t = translator('en');
	const line = (change: SyncChange) =>
		renderToStaticMarkup(<ChangeLine change={change} t={t} />);

	test.each<[SyncChange, string[]]>([
		[
			{ kind: 'added', url: '/n/', virtual: true, inputPath: null, keys: 2 },
			['<code>/n/</code>', 'virtual', '2 key(s)'],
		],
		[
			{ kind: 'added', url: '/n/', virtual: false, inputPath: 'n/index.html', keys: 0 },
			['n/index.html'],
		],
		[
			{ kind: 'added', url: '/n/', virtual: false, inputPath: null, keys: 0 },
			['file at its URL'],
		],
		[
			{ kind: 'movedUrl', from: '/a/', to: '/b/' },
			['<code>/a/</code>', '<code>/b/</code>', '→'],
		],
		[
			{ kind: 'movedFile', url: '/a/', from: 'a.html', to: 'b.html' },
			['a.html', 'b.html', '→'],
		],
		[{ kind: 'virtualized', url: '/v/', inputPath: 'v.html' }, ['v.html', 'virtual']],
		[
			{ kind: 'materialized', url: '/m/', inputPath: null },
			['virtual', 'file at its URL'],
		],
		[
			{ kind: 'meta', url: '/p/', key: 'title', before: '"A"', after: '"B"' },
			['<strong>title</strong>', '<del>&quot;A&quot;</del>', '<ins>&quot;B&quot;</ins>'],
		],
		[{ kind: 'meta', url: '/p/', key: 'new', after: '1' }, ['(none)', '<ins>1</ins>']],
		[
			{ kind: 'meta', url: '/p/', key: 'gone', before: '1' },
			['<del>1</del>', '(removed)'],
		],
	])('%j', (change, expected) => {
		const html = line(change);
		for (const text of expected) {
			expect(html).toContain(text);
		}
	});

	test('draws what came from a file or a script as text, and makes no link of it', () => {
		const hostile = '<img src=x onerror=alert(1)> <a href="javascript:alert(1)">x</a>';
		const html = [
			line({ kind: 'meta', url: hostile, key: hostile, before: hostile, after: hostile }),
			line({ kind: 'deleted', url: hostile, inputPath: hostile }),
			line({ kind: 'added', url: hostile, virtual: false, inputPath: hostile, keys: 1 }),
		].join('');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('<a ');
		expect(html).not.toMatch(/<[^>]*href=/);
		expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
	});
});

describe('a sync that went wrong in the end', () => {
	test('a file that changed meanwhile: told, with nothing applied, and the edits that were refused', () => {
		const html = view({
			state: state({
				status: 'conflict',
				refused: {
					code: 'conflict',
					message: 'a.html was changed after it was read',
					failures: {
						total: 3,
						listed: [{ url: '/a/', op: 'moveUrl', message: 'a.html was changed' }],
					},
				},
			}),
		});
		expect(html).toContain('The files changed meanwhile');
		expect(html).toContain('Nothing was applied. Run the sync again.');
		expect(html).toContain('<code>/a/</code>');
		expect(html).toContain('moveUrl');
		expect(html).toContain('2 more not listed');
	});

	test('another refusal of the core: its message and the edits', () => {
		const html = view({
			state: state({
				status: 'refused',
				refused: {
					code: 'collision',
					message: 'a page is already at /b/',
					failures: {
						total: 1,
						listed: [{ url: null, op: null, message: 'a page is already at /b/' }],
					},
				},
			}),
		});
		expect(html).toContain('The differences could not be applied');
		expect(html).toContain('a page is already at /b/');
		expect(html).toContain('Nothing was applied.');
	});

	test('a screen that lost the server says so, and keeps the log', () => {
		const html = view({
			problem: 'Lost contact with the server: the server did not answer',
			log: { lines: [{ type: 'info', message: 'still here' }], next: 1, dropped: 0 },
		});
		expect(html).toContain('role="alert"');
		expect(html).toContain('Lost contact with the server');
		expect(html).toContain('still here');
	});
});
