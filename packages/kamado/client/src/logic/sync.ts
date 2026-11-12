import type {
	SyncFunction,
	SyncKind,
	SyncLogLine,
	SyncState,
	SyncStatus,
} from '../types.js';

import { resolveLabel } from './labels.js';

/**
 * The name of an operation on the screen: its label in the language of the screen, then in
 * English, then its name (RFC §14.2: the same rule as the label of a key, with the name where a
 * key would be shown instead).
 * @param operation - An operation of `ui.syncFunctions`
 * @param language - The language of the screen
 * @example
 * ```ts
 * operationLabel({ name: 'import', label: { ja: '取り込む', en: 'Import' } }, 'ja'); // '取り込む'
 * operationLabel({ name: 'import', label: { fr: 'Importer' } }, 'ja'); // 'import'
 * ```
 */
export function operationLabel(operation: SyncFunction, language: string): string {
	return resolveLabel(operation.label, language) ?? operation.name;
}

/**
 * Whether a sync has ended: it will not change any more by itself.
 * @param status - How the sync stands
 */
export function isFinished(status: SyncStatus): boolean {
	return status !== 'running' && status !== 'writing';
}

/** The kinds of change that always have a tab, in the order they are shown. */
const ALWAYS: readonly SyncKind[] = ['deleted', 'movedUrl', 'added', 'meta'];

/** The kinds that have a tab only when there is a change of that kind. */
const WHEN_ANY: readonly SyncKind[] = ['movedFile', 'virtualized', 'materialized'];

/** A tab of the list of changes. */
export interface SyncTab {
	readonly kind: SyncKind;
	readonly count: number;
	/** No change of this kind: the tab is shown, faint, and cannot be chosen. */
	readonly disabled: boolean;
}

/**
 * The tabs of the list of changes: removed, URL moved, added and metadata changed always (a kind
 * with nothing is faint and cannot be chosen), and the other kinds only when there is one.
 * @param counts - How many changes of each kind
 * @example
 * ```ts
 * tabsOf({ deleted: 0, movedUrl: 2, added: 0, meta: 1, movedFile: 0, virtualized: 0, materialized: 0 });
 * // deleted (disabled), movedUrl 2, added (disabled), meta 1
 * ```
 */
export function tabsOf(counts: Readonly<Record<SyncKind, number>>): SyncTab[] {
	return [...ALWAYS, ...WHEN_ANY.filter((kind) => counts[kind] > 0)].map((kind) => ({
		kind,
		count: counts[kind],
		disabled: counts[kind] === 0,
	}));
}

/**
 * The tab to show first: the first that has a change.
 * @param tabs - The tabs
 * @returns The kind, or `null` when there is no change at all
 */
export function firstTab(tabs: readonly SyncTab[]): SyncKind | null {
	return tabs.find((tab) => !tab.disabled)?.kind ?? null;
}

/** The log the screen holds. */
export interface HeldLog {
	readonly lines: readonly SyncLogLine[];
	/** Ask the server for the log from here. */
	readonly next: number;
	/** How many lines were dropped from the start of the log (the server's count). */
	readonly dropped: number;
}

/** The most lines the screen holds; the same as the server keeps. */
export const MAX_HELD_LINES = 1000;

/**
 * Takes the lines an answer brought into the log held. The answer carries the lines from
 * the place that was asked for on; a line the server had already dropped is not there.
 * @param held - The log held
 * @param state - The answer
 */
export function mergeLog(
	held: HeldLog,
	state: Pick<SyncState, 'log' | 'next' | 'dropped'>,
): HeldLog {
	if (state.next <= held.next) {
		// An answer that is not newer (asked twice, or out of order) has nothing the log does not hold.
		return held;
	}
	const lines = [...held.lines, ...state.log];
	return {
		lines:
			lines.length > MAX_HELD_LINES ? lines.slice(lines.length - MAX_HELD_LINES) : lines,
		next: state.next,
		dropped: state.dropped,
	};
}

/** The empty log, before the first answer. */
export const NO_LOG: HeldLog = { lines: [], next: 0, dropped: 0 };

/**
 * How many lines are not shown: the server's count of dropped lines plus the lines the screen
 * dropped since it was handed more than it holds, so that the message is true whoever dropped.
 * @param held - The log held
 */
export function hiddenLines(held: HeldLog): number {
	return held.next - held.lines.length;
}
