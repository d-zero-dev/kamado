import type { Editing } from './grid-row.js';
import type { LocaleSetting } from './i18n/translate.js';
import type { Position } from './logic/grid.js';
import type { PageChoice, PageQuestion } from './logic/page-questions.js';
import type { Reading } from './logic/session.js';
import type { FieldKind } from './logic/value.js';
import type { RevertRequest } from './revert-dialog.js';
import type {
	Change,
	Diffs,
	Expect,
	GitInfo,
	Rows,
	SettingsPatch,
	SettingsView,
	SyncFunction,
} from './types.js';

import {
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

import { ADD_PAGE_DIALOG_ID, AddPageDialog } from './add-page-dialog.js';
import {
	ApiError,
	createPage,
	editPage,
	fetchDiff,
	fetchGit,
	fetchRows,
	fetchSyncFunctions,
	refreshSite,
	removePage,
	revertCell,
	saveSettings,
} from './api.js';
import { ColumnMenu, type MenuItem } from './column-menu.js';
import { GridRow } from './grid-row.js';
import { I18nContext, useI18n } from './i18n/context.js';
import { resolveLanguage, translator } from './i18n/translate.js';
import { Legend } from './legend.js';
import {
	cellOf,
	columnHoldsArrays,
	editKindOf,
	expectOf,
	inferredKinds,
	sameKinds,
} from './logic/columns.js';
import { builtinCommand } from './logic/commands.js';
import {
	cellDiffOf,
	revertFailureOf,
	revertKeyOf,
	valueText,
	withPageDiff,
	writeNames,
} from './logic/diff.js';
import { isFixedBox } from './logic/fixed-cells.js';
import { gitLabel } from './logic/git-label.js';
import { nextCell, pageCount, rangeLabel } from './logic/grid.js';
import {
	choicesOf,
	enumKindOf,
	kindsPatch,
	optionsFromFiles,
	selectedOf,
	withKind,
	type KindsSettings,
} from './logic/kinds.js';
import { columnHeading } from './logic/labels.js';
import {
	MAX_COLUMN_WIDTH,
	MIN_COLUMN_WIDTH,
	columnIds,
	columnName,
	layoutOf,
	moveColumn,
	moveColumnTo,
	opensMenu,
	pinColumn,
	positionOf,
	resetWidth,
	resizeColumn,
	settingsOf,
	stateOf,
	unpinColumn,
	widthOf,
	type ColumnState,
} from './logic/layout.js';
import { movesPage, pageOfLocated } from './logic/order.js';
import {
	filesOf,
	pathEditOf,
	stillToMake,
	urlEditOf,
	virtualEditOf,
	withoutPage,
} from './logic/page-edits.js';
import { answerOf, holdsVirtualPages, saidAfterLoad } from './logic/page-questions.js';
import {
	applyEdited,
	createQueue,
	editBlockedReason,
	focusAfterLoad,
	pageToReadInstead,
	rowByUrl,
	shouldWrite,
} from './logic/session.js';
import { createSaver } from './logic/settings-save.js';
import {
	ariaSortOf,
	canSort,
	isColumnId,
	sameSort,
	sortAfterFailure,
	type SortState,
} from './logic/sort.js';
import { operationLabel } from './logic/sync.js';
import { FIELD_KINDS, defaultOf, draftOf, parseDraft } from './logic/value.js';
import { OptionsDialog } from './options-dialog.js';
import { PageDialog } from './page-dialog.js';
import { RevertDialog } from './revert-dialog.js';
import { SyncDialog, type SyncEnd } from './sync-dialog.js';
import { useCommands } from './use-commands.js';

/**
 * Rows put in the page at a time: the first paint is not held up by the rest. 500 rows drew
 * in about 130 ms on a laptop (5,000 take about ten times that), which keeps the first
 * paint of the screen well inside a second.
 */
const CHUNK = 500;
const PAGE_SIZES = [100, 500, 1000, 5000] as const;
/**
 * The screen is read again when it comes back to the front, if it has not been for this
 * long: switching between the editor and a browser tab of the site does not read the whole
 * list on each switch, and a file changed in the editor of the code is shown on the first
 * return after it.
 */
const STALE_MS = 2000;
/** Rows Page Up and Page Down move: about what a screen of 2.25rem rows shows. */
const SCREEN_ROWS = 10;
/** The type a dragged column header carries: it is dropped on another header, and on nothing else. */
const COLUMN_MIME = 'application/x-kamado-column';
/**
 * Pixels the menu entries "Wider" and "Narrower" change a column by: a step that can be seen,
 * and small enough to fit a column to its text in a few presses.
 */
const WIDTH_STEP = 32;
/** The columns that HEAD alone has, when nothing is known of HEAD: one list, so that memoised values do not change. */
const NO_COLUMNS: readonly string[] = [];

/**
 * The messages of the errors of the server, in words of the screen.
 * @param error - What was thrown
 */
function messageOf(error: unknown): string {
	if (error instanceof ApiError) {
		return error.message;
	}
	return error instanceof Error ? error.message : String(error);
}

/** What the screen starts with: the settings, and whether they could be read. */
export interface AppProps {
	readonly settings: SettingsView;
	/** Set when the settings could not be read: the defaults are in `settings`. */
	readonly settingsUnreadable: boolean;
}

/**
 * What is said about the settings file, kept as what it is and not as a sentence: the sentence
 * is made when it is drawn, so that it follows a change of language.
 */
type SettingsNote =
	| { readonly kind: 'warning'; readonly message: string }
	| { readonly kind: 'notSaved'; readonly message: string }
	| { readonly kind: 'unreadable' };

/**
 * The screen, in the language that is set (or that of the browser). The language is chosen
 * here and handed down, so that every message of the screen and of its logic is said in it.
 * @param props - The settings the screen starts with
 * @param props.settings - What was read from the server
 * @param props.settingsUnreadable - Whether there are only the defaults because they could not be read
 */
export function App({ settings, settingsUnreadable }: AppProps) {
	const [locale, setLocale] = useState<LocaleSetting>(settings.global.locale);
	const language = resolveLanguage(locale, navigator.languages);
	const i18n = useMemo(() => ({ language, t: translator(language) }), [language]);
	useEffect(() => {
		document.documentElement.lang = language;
	}, [language]);
	return (
		<I18nContext.Provider value={i18n}>
			<Screen
				settings={settings}
				settingsUnreadable={settingsUnreadable}
				locale={locale}
				onLocale={setLocale}
			/>
		</I18nContext.Provider>
	);
}

interface ScreenProps extends AppProps {
	readonly locale: LocaleSetting;
	readonly onLocale: (locale: LocaleSetting) => void;
}

/**
 * The grid of the pages, one row each, edited in place.
 * @param props - What the screen starts with, and the language setting
 * @param props.settings - What was read from the server
 * @param props.settingsUnreadable - Whether the settings could not be read
 * @param props.locale - The language setting
 * @param props.onLocale - Called with the language the person chose
 */
function Screen({ settings, settingsUnreadable, locale, onLocale }: ScreenProps) {
	const { t, language } = useI18n();
	// The effects and the queued edits say things too: they read the translator of the latest
	// render, so that a change of language does not read the list again.
	// Written in a layout effect and not while drawing: a ref is not written during a render
	// (a render that is thrown away would leave its value in it), and `useEffectEvent` cannot be
	// called from a queued edit. The layout effect runs before the browser can send an event.
	const tRef = useRef(t);
	useLayoutEffect(() => {
		tRef.current = t;
	}, [t]);
	const [rows, setRows] = useState<Rows | null>(null);
	// The names of the layouts: the `layout` column chooses among them when there are some.
	const layouts = rows?.layouts ?? null;
	// How the config presents the keys (`ui.keys`): the name a column is shown by, and what goes
	// with it on hover and in its menu.
	const keys = rows?.keys;
	const headingOf = (id: string) => columnHeading(id, keys, language, t);
	// The branch and the commit shown in the header; read with the first list and each time
	// the files are read again (the branch can be switched while the screen is open).
	const [git, setGit] = useState<GitInfo | null>(null);
	// Whether the header still has to be asked: it is until an answer came, and again when the
	// files are read again (a request dropped for the next list leaves it asked for).
	const gitDue = useRef(true);
	// How the rows on the screen differ from HEAD (`null` when nothing is known: no repository, or
	// not read yet), and the cell that is being asked about putting back.
	const [diffs, setDiffs] = useState<Diffs | null>(null);
	const diffsRef = useRef<Diffs | null>(null);
	// What was asked is kept as it was when the dialog opened, with the commit it showed and the
	// hashes of the files it showed: what is written is that and nothing that came after.
	const [reverting, setReverting] = useState<
		| (RevertRequest & {
				readonly column: string;
				readonly key: string | null;
				readonly head: string;
				readonly expect: {
					input: string | null;
					sidecar: string | null;
					overrides: string | null;
				};
		  })
		| null
	>(null);
	// What is being asked before a page is added as a virtual one, made virtual or deleted.
	const [asking, setAsking] = useState<PageQuestion | null>(null);
	// The form that adds a page keeps what was typed until the page is made (a page that is
	// refused is asked for again by changing a part); a new number then makes a new, empty form.
	const [addForm, setAddForm] = useState(0);
	// Counts the reads of the list: the marks asked for before a read that came later are not used.
	const diffGeneration = useRef(0);
	const rowsRef = useRef<Rows | null>(null);
	const [pageSize, setPageSize] = useState<number>(settings.project?.pageSize ?? 500);
	const [sort, setSort] = useState<SortState | null>(settings.project?.sort ?? null);
	// The sort the settings file holds. It is saved when the list was read in that order and not
	// when the header is clicked: a sort the server refuses would be kept, and asked for again
	// at every start.
	const savedSort = useRef<SortState | null>(settings.project?.sort ?? null);
	// The column whose header button is the stop of Tab of the row of headers.
	const [headerStop, setHeaderStop] = useState<string | null>(null);
	const [columnState, setColumnState] = useState<ColumnState>(() =>
		stateOf(settings.project?.columns),
	);
	// The width a column has while its edge is being dragged: kept apart from `columnState` so that
	// it is saved once, when the drag ends.
	const [liveWidth, setLiveWidth] = useState<{ id: string; width: number } | null>(null);
	const [menu, setMenu] = useState<{
		readonly id: string;
		readonly anchor: { readonly left: number; readonly bottom: number };
	} | null>(null);
	// Where the focus goes back to when the menu is closed by a key: the header button it was
	// opened from, or the grid.
	const menuRestore = useRef<HTMLElement | null>(null);
	// The operations of `ui.syncFunctions` (none: there is no sync button), the menu of them, and the
	// sync that is being run (a new request runs the operation again).
	const [syncFunctions, setSyncFunctions] = useState<readonly SyncFunction[]>([]);
	const [syncMenu, setSyncMenu] = useState<{
		readonly left: number;
		readonly bottom: number;
	} | null>(null);
	const [syncRequest, setSyncRequest] = useState<{
		readonly operation: SyncFunction;
		readonly nonce: number;
	} | null>(null);
	const syncButton = useRef<HTMLButtonElement>(null);
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropOn, setDropOn] = useState<string | null>(null);
	const resize = useRef<{
		id: string;
		startX: number;
		startWidth: number;
		width: number;
	} | null>(null);
	const [settingsNote, setSettingsNote] = useState<SettingsNote | null>(() => {
		if (settingsUnreadable) {
			return { kind: 'unreadable' };
		}
		return settings.warning === null
			? null
			: { kind: 'warning', message: settings.warning };
	});
	/**
	 * Keeps a setting for the next run. A failure is said and does not stop anything: the screen
	 * works the same, and keeps what was chosen until it is closed. A change that failed is sent
	 * again with the next one, so the note goes only when what failed is saved.
	 */
	const [saver] = useState(() =>
		createSaver(saveSettings, (failure) =>
			setSettingsNote(
				failure === null ? null : { kind: 'notSaved', message: messageOf(failure) },
			),
		),
	);
	const [page, setPage] = useState(0);
	const [typed, setTyped] = useState('');
	const [q, setQ] = useState('');
	const [tick, setTick] = useState(0);
	const [active, setActive] = useState<Position>({ row: 0, col: 0 });
	const [editing, setEditing] = useState<Editing | null>(null);
	const [added, setAdded] = useState<ReadonlyMap<string, FieldKind>>(new Map());
	// The columns that are a choice among options (an enum), and the column whose options are
	// being edited in the dialog.
	const [kinds, setKinds] = useState<KindsSettings>(() => settings.project?.kinds ?? {});
	const [optionsFor, setOptionsFor] = useState<string | null>(null);
	const [visible, setVisible] = useState(CHUNK);
	const [status, setStatus] = useState('');
	const [problem, setProblem] = useState('');
	const [loading, setLoading] = useState(true);

	const gridRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const addPageRef = useRef<HTMLDialogElement>(null);
	const needRefresh = useRef(false);
	// Whether the list on the screen can be edited. While it is being read again, the hashes it
	// holds may be those of before: an edit made then would be refused as a conflict, so it is
	// dropped (and said so) instead. `failed` stays until the list is read again.
	const reading = useRef<Reading>('busy');
	const qRef = useRef('');
	const pendingFocus = useRef<string | null>(null);
	// The page whose window the next reading of the list asks for (an edit of `order` may have
	// put it in another window), and the sort the rows are in now (`apply` runs from the queue,
	// where the state it was made with is old).
	const pendingLocate = useRef<string | null>(null);
	const sortNow = useRef(sort);
	sortNow.current = sort;
	// What was done to the page the focus is to go to, when it was not moved (it was added, made
	// virtual or given a file): said once the list was read again, in place of "Moved to".
	const pendingSaid = useRef<string | null>(null);
	const loadedAt = useRef(0);
	const queue = useRef(createQueue());

	const commitRows = useCallback((next: Rows | null) => {
		rowsRef.current = next;
		setRows(next);
	}, []);

	const commitDiffs = useCallback((next: Diffs | null) => {
		diffsRef.current = next;
		setDiffs(next);
	}, []);

	/**
	 * Reads how some pages differ from HEAD again, after they were edited. An answer for another
	 * commit than the one the rest was read for (the branch was switched) makes the whole window
	 * be read again. Not being able to read it leaves what is shown: the list is what matters.
	 * @param urls - The pages
	 */
	const refreshDiff = useCallback(
		async (urls: readonly string[]) => {
			const generation = diffGeneration.current;
			try {
				const answer = await fetchDiff(urls);
				let next = withPageDiff(diffsRef.current, urls, answer);
				if (next === null && answer !== null) {
					// Nothing was known of the rest of the window, or it was of another commit: all of it is read.
					const all = rowsRef.current?.pages.map((row) => row.url) ?? [];
					next = all.length === 0 ? null : await fetchDiff(all);
				}
				if (generation === diffGeneration.current) {
					commitDiffs(next);
				}
			} catch {
				// The marks stay as they were.
			}
		},
		[commitDiffs],
	);

	/** Reads the list again, from the files when `refresh` (otherwise from the core's memory). */
	const reload = useCallback((refresh: boolean) => {
		needRefresh.current ||= refresh;
		// At once, not when the effect runs after the next render: an edit that is next in
		// the queue must already see that the list is not the one it was made on.
		reading.current = 'busy';
		setTick((n) => n + 1);
	}, []);

	/**
	 * Reads the list from the files when the edits already asked for have been made: a read
	 * that began first would drop them, and the user would lose what they just typed. (A
	 * read that an edit asks for itself, a conflict or a move, is made inside the queue.)
	 */
	const reloadWhenIdle = useCallback(() => {
		void queue.current.idle().then(() => reload(true));
	}, [reload]);

	// The operations of the sync are told once: they come from the config, which is read when
	// `kamado ui` starts. A server that does not answer leaves the screen without the button.
	useEffect(() => {
		const controller = new AbortController();
		fetchSyncFunctions(controller.signal).then(
			(functions) => {
				if (!controller.signal.aborted) {
					setSyncFunctions(functions);
				}
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					// No button, and no hint why, would leave a person with a config that has operations
					// wondering where they are.
					setProblem(
						tRef.current('sync.lostContact', {
							message: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			},
		);
		return () => controller.abort();
	}, []);

	/**
	 * Says how a sync ended, and reads the list from the files again: the script may have touched
	 * them, and what was applied has changed them.
	 * @param end - How the dialog of the sync was left
	 */
	const syncEnded = (end: SyncEnd) => {
		setSyncRequest(null);
		switch (end.kind) {
			case 'applied': {
				setStatus(
					t(end.direction === 'export' ? 'sync.exported' : 'sync.applied', {
						name: end.name,
						count: end.count,
					}),
				);
				break;
			}
			case 'failed': {
				setStatus(t('sync.failedStatus', { name: end.name, message: end.message }));
				break;
			}
			case 'cancelled': {
				setStatus(
					t(end.phase === 'write' ? 'sync.cancelledWrite' : 'sync.cancelled', {
						name: end.name,
					}),
				);
				break;
			}
			case 'notStarted': {
				setStatus(t('sync.notStarted', { name: end.name, message: end.message }));
				return;
			}
			case 'closed': {
				break;
			}
		}
		reloadWhenIdle();
	};

	// The search waits for the typing to stop.
	useEffect(() => {
		const id = setTimeout(() => {
			if (qRef.current !== typed) {
				qRef.current = typed;
				setQ(typed);
				setPage(0);
				setActive({ row: 0, col: 0 });
				setVisible(CHUNK);
				setEditing(null);
			}
		}, 300);
		return () => clearTimeout(id);
	}, [typed]);

	useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			setLoading(true);
			reading.current = 'busy';
			diffGeneration.current += 1;
			try {
				if (needRefresh.current) {
					// Asked again with the files: a request dropped for the next list leaves it due.
					gitDue.current = true;
					needRefresh.current = false;
					await refreshSite();
				}
				const locate = pendingLocate.current;
				const result = await fetchRows(
					page * pageSize,
					pageSize,
					q,
					sort,
					controller.signal,
					locate ?? undefined,
				);
				if (controller.signal.aborted) {
					// Asked again before this answer came: the page is still to be found.
					return;
				}
				pendingLocate.current = null;
				// The page was found in another window of the list: that window is read (the
				// focus, still wanted, goes to the page there).
				const located =
					locate !== null && result.pages.some((row) => row.url === locate)
						? pageOfLocated(page * pageSize, result.offset, pageSize)
						: null;
				if (located !== null) {
					setPage(located);
					return;
				}
				const instead = pageToReadInstead(
					page,
					result.pages.length,
					result.total,
					pageSize,
				);
				if (instead !== null) {
					setPage(instead);
					return;
				}
				commitRows(result);
				reading.current = 'ok';
				loadedAt.current = Date.now();
				setProblem('');
				// Not part of reading the list either: a site that is not in a repository shows no
				// mark. An answer that was dropped (another list was asked for) is not used.
				// (An empty list asks for nothing, and keeps what is known: the legend would flicker.)
				if (result.pages.length > 0) {
					fetchDiff(
						result.pages.map((row) => row.url),
						controller.signal,
					).then(
						(answer) => {
							if (!controller.signal.aborted) {
								commitDiffs(answer);
							}
						},
						() => {
							// The marks stay as they were (and the columns that go with them): a read that
							// failed says nothing of the repository, and the list is what matters.
						},
					);
				}
				if (gitDue.current) {
					// Not part of reading the list: a repository that cannot be read shows nothing.
					fetchGit(controller.signal).then(
						(info) => {
							if (!controller.signal.aborted) {
								// Only an answer counts as read: a request that was dropped (another list was asked
								// for) or failed is made again with the next list.
								gitDue.current = false;
								setGit(info);
							}
						},
						() => {
							if (!controller.signal.aborted) {
								setGit(null);
							}
						},
					);
				}
				if (!sameSort(sort, savedSort.current)) {
					// The server took this sort (see `savedSort`).
					savedSort.current = sort;
					void saver({ project: { sort } });
				}
				const wanted = pendingFocus.current;
				pendingFocus.current = null;
				const done = pendingSaid.current;
				pendingSaid.current = null;
				const urls = result.pages.map((p) => p.url);
				setActive((prev) => ({
					row: focusAfterLoad(urls, prev.row, wanted).row,
					col: prev.col,
				}));
				const said = saidAfterLoad(urls, wanted, done, tRef.current);
				if (said !== null) {
					setStatus(said);
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					reading.current = 'failed';
					setProblem(tRef.current('app.listNotRead', { message: messageOf(error) }));
					if (error instanceof ApiError) {
						// A sort the server refuses is let go, and the list is read again.
						const kept = sortAfterFailure(sort, error.code);
						if (kept !== sort) {
							setSort(kept);
						}
					}
				}
			} finally {
				if (!controller.signal.aborted) {
					setLoading(false);
				}
			}
		})();
		return () => controller.abort();
	}, [page, pageSize, q, sort, tick, commitRows, commitDiffs, saver]);

	// The rest of the rows go into the page a chunk at a time, so that typing and scrolling
	// are not held up by the drawing of five thousand rows.
	const total = rows?.pages.length ?? 0;
	useEffect(() => {
		if (visible < total) {
			const id = requestAnimationFrame(() => {
				startTransition(() => setVisible((v) => Math.min(v + CHUNK, total)));
			});
			return () => cancelAnimationFrame(id);
		}
		return;
	}, [visible, total]);

	// Coming back to the screen after the files may have changed.
	useEffect(() => {
		const onVisible = () => {
			if (
				document.visibilityState === 'visible' &&
				Date.now() - loadedAt.current > STALE_MS &&
				editing === null
			) {
				reloadWhenIdle();
			}
		};
		document.addEventListener('visibilitychange', onVisible);
		return () => document.removeEventListener('visibilitychange', onVisible);
	}, [reloadWhenIdle, editing]);

	// The keys of the grid work as soon as the rows are in: the focus goes to the grid once.
	const focused = useRef(false);
	useEffect(() => {
		if (rows !== null && !focused.current) {
			focused.current = true;
			gridRef.current?.focus();
		}
	}, [rows]);

	// The keys that HEAD has and no page has now are columns too: a deleted value has a cell to be
	// put back from.
	const headColumns = diffs === null ? NO_COLUMNS : diffs.columns;
	const known = useMemo(
		() => columnIds([...(rows?.columns ?? []), ...added.keys(), ...headColumns]),
		[rows?.columns, added, headColumns],
	);
	// The kind of a key for a page that has no value to say it: the kind a key was added as, and
	// boolean for a key whose values on the screen are booleans (the page then shows an empty box,
	// and checking it writes `true`).
	const inferred = useMemo(
		() => inferredKinds(rows?.pages ?? [], rows?.columns ?? [], added),
		[rows, added],
	);
	// The same map while its content is the same: the rows are memoised on it, and a read that
	// changes nothing about the kinds must not draw them all again.
	const hintsRef = useRef(inferred);
	const hints = sameKinds(hintsRef.current, inferred) ? hintsRef.current : inferred;
	useLayoutEffect(() => {
		hintsRef.current = hints;
	}, [hints]);
	// Which columns are shown, in what order, and how many are pinned. Not a function of the
	// widths: the rows are drawn again only when this changes, not while a column is dragged.
	const { order, pinned } = columnState;
	const arrangement = useMemo(
		() => layoutOf(known, { order, pinned, widths: {} }),
		[known, order, pinned],
	);
	const columns = arrangement.shown;
	const pinnedCount = arrangement.pinnedCount;
	const colCount = columns.length;
	// The widths, and where the pinned columns stick, with the width being dragged in.
	const sized = layoutOf(
		known,
		liveWidth === null
			? columnState
			: resizeColumn(columnState, liveWidth.id, liveWidth.width),
	);

	// The cell with the focus stays in view (the grid keeps the focus itself, and names this
	// cell as the active one).
	useEffect(() => {
		document
			.getElementById(`c-${active.row}-${active.col}`)
			?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}, [active, visible]);

	/**
	 * Edits are made one after another: each is made on the hashes the one before returned.
	 * `asked` is given for an edit that a dialog asked about: the hashes of the files as they
	 * were when it opened, so that what is written (or removed) is what the dialog showed.
	 */
	const apply = useCallback(
		(url: string, change: Change, saved: string, asked?: Expect) => {
			// The page is named by its URL, not by its place in the list: the list may be read
			// again (and ordered differently) before this edit's turn comes.
			queue.current.enqueue(async () => {
				const current = rowsRef.current;
				const row = rowByUrl(current, url);
				if (current === null || row === undefined) {
					setProblem(tRef.current('app.notInList', { url }));
					return;
				}
				if (!stillToMake(row, change)) {
					// Asked twice (a box clicked twice): the first answer made it so.
					return;
				}
				const blocked = editBlockedReason(reading.current, tRef.current);
				if (blocked !== null) {
					setProblem(blocked);
					return;
				}
				try {
					const result = await editPage(
						row.url,
						asked ?? expectOf(row, current.overridesHash),
						change,
					);
					const latest = rowsRef.current;
					if (latest !== null) {
						commitRows(applyEdited(latest, row.url, result));
					}
					setProblem('');
					// An edit that was made and left a file behind says so with what it did.
					const said =
						result.warning === undefined
							? saved
							: tRef.current('app.leftBehind', { said: saved, warning: result.warning });
					setStatus(said);
					if (change.op === 'moveUrl' || change.op === 'movePath') {
						pendingFocus.current = result.page.url;
						// A move is said as a move: what was to be said of a page before it (one
						// whose list was never read) is not said of this one.
						pendingSaid.current = null;
						reload(true);
					} else if (movesPage(change, sortNow.current)) {
						// What `order` says places the page among its siblings: the list is read again
						// from the core (it has put the plan in order), at the window the page is in
						// now, and the focus follows the page.
						pendingFocus.current = result.page.url;
						pendingSaid.current = said;
						pendingLocate.current = result.page.url;
						reload(false);
					} else if (change.op === 'virtualize' || change.op === 'materialize') {
						// The page has other files (and the hashes of them), and a virtual page has no
						// input path: the list is read again, and the focus follows the page.
						pendingFocus.current = result.page.url;
						pendingSaid.current = said;
						reload(true);
					} else {
						await refreshDiff([row.url]);
					}
				} catch (error) {
					if (error instanceof ApiError && error.code === 'conflict') {
						setProblem(tRef.current('app.conflict', { message: error.message }));
						reload(true);
					} else {
						setProblem(messageOf(error));
					}
				}
			});
		},
		[commitRows, reload, refreshDiff],
	);

	const focusGrid = () => gridRef.current?.focus();

	/**
	 * Says why an edit that adds or removes a page was not made, and reads the files again when
	 * they are not what the screen had (a conflict).
	 * @param error - What was thrown
	 */
	const pageEditFailed = useCallback(
		(error: unknown) => {
			if (error instanceof ApiError && error.code === 'conflict') {
				setProblem(tRef.current('app.conflict', { message: error.message }));
				reload(true);
			} else {
				setProblem(messageOf(error));
			}
		},
		[reload],
	);

	/**
	 * Makes a page that is not there, in the queue of the edits: a page file at the path, or a
	 * virtual page when there is none. The list is read again (the page is a new row somewhere
	 * in it), and the focus goes to the page.
	 * @param url - The URL of the page; `null` for the URL the place of the file gives
	 * @param path - The path of the page file; `null` for a virtual page
	 */
	const addPage = useCallback(
		(url: string | null, path: string | null) => {
			queue.current.enqueue(async () => {
				const blocked = editBlockedReason(reading.current, tRef.current);
				if (blocked !== null) {
					setProblem(blocked);
					return;
				}
				try {
					const result = await createPage(
						url,
						path,
						rowsRef.current?.overridesHash ?? null,
					);
					setProblem('');
					pendingFocus.current = result.page.url;
					pendingSaid.current = tRef.current('app.pageAdded', { url: result.page.url });
					// The page is made: the form that asked for it is empty the next time.
					setAddForm((n) => n + 1);
					reload(true);
				} catch (error) {
					pageEditFailed(error);
				}
			});
		},
		[reload, pageEditFailed],
	);

	/**
	 * Removes a page, in the queue of the edits, on the hashes the dialog that asked had.
	 * @param url - The page
	 * @param expect - The hashes of its files as they were when the dialog opened
	 */
	const deletePage = useCallback(
		(url: string, expect: Expect) => {
			queue.current.enqueue(async () => {
				const blocked = editBlockedReason(reading.current, tRef.current);
				if (blocked !== null) {
					setProblem(blocked);
					return;
				}
				try {
					const result = await removePage(url, expect);
					const latest = rowsRef.current;
					if (latest !== null) {
						commitRows(withoutPage(latest, url, result));
					}
					setProblem('');
					const removed = tRef.current('app.pageRemoved', { url });
					setStatus(
						result.warning === undefined
							? removed
							: tRef.current('app.leftBehind', {
									said: removed,
									warning: result.warning,
								}),
					);
					// The rows after it move up, and their places in the plan change.
					reload(true);
				} catch (error) {
					pageEditFailed(error);
				}
			});
		},
		[commitRows, reload, pageEditFailed],
	);

	/**
	 * Asks before the file of a page, or the page, goes. The dialog is made when the edits
	 * already asked for have been made, from what is on the screen then: the files it names and
	 * the hashes that are sent are one and the same state.
	 * @param url - The page
	 * @param kind - What is asked: the `inputPath` was emptied, the box of `virtual` was checked,
	 * or the `url` was emptied
	 */
	const askAboutPage = (url: string, kind: 'delete' | 'emptyPath' | 'virtualize') => {
		setProblem('');
		void queue.current.idle().then(() => {
			const current = rowsRef.current;
			const row = rowByUrl(current, url);
			if (current === null || row === undefined) {
				setProblem(tRef.current('app.notInList', { url }));
				return;
			}
			if (kind === 'virtualize' && !holdsVirtualPages(current.overridesFile)) {
				// Nothing to choose: there is no file to write the page in.
				setProblem(tRef.current('app.noOverrides'));
				return;
			}
			setAsking({
				kind,
				url,
				files: filesOf(row),
				virtual: row.virtual,
				expect: expectOf(row, current.overridesHash),
			});
		});
	};

	/**
	 * Does what was chosen in the dialog.
	 * @param choice - The button that was pressed
	 */
	const answerPageQuestion = (choice: PageChoice) => {
		const question = asking;
		setAsking(null);
		focusGrid();
		const answer = question === null ? null : answerOf(question, choice);
		if (answer === null) {
			return;
		}
		if (answer.kind === 'create') {
			addPage(answer.url, null);
		} else if (answer.kind === 'virtualize') {
			apply(
				answer.url,
				{ op: 'virtualize' },
				t('app.pageVirtual', { url: answer.url }),
				answer.expect,
			);
		} else {
			deletePage(answer.url, answer.expect);
		}
	};

	/**
	 * Takes what the form that adds a page asks for: a page with a path is made, and a page
	 * without one is asked about first (it would be a virtual page).
	 * @param url - The URL that was typed, or `null`
	 * @param path - The path that was typed, or `null`
	 */
	const requestAddPage = (url: string | null, path: string | null) => {
		if (path !== null) {
			addPage(url, path);
			// The focus is to go to the row of the new page, which is in the grid: not back to the
			// button that opened the form, where a closed dialog puts it.
			focusGrid();
			return;
		}
		if (url === null) {
			return;
		}
		if (!holdsVirtualPages(rowsRef.current?.overridesFile)) {
			setProblem(t('app.noOverrides'));
			return;
		}
		setProblem('');
		setAsking({ kind: 'addVirtual', url });
	};

	const remember = (patch: SettingsPatch) => {
		void saver(patch);
	};

	/**
	 * Starts the edit of a cell, or makes it, for a checkbox (a toggle needs no input).
	 * @param at - The cell, by its place in what is shown
	 */
	const startEdit = (at: Position) => {
		const row = rows?.pages[at.row];
		if (row === undefined) {
			return;
		}
		const column = columns[at.col];
		if (column === undefined) {
			return;
		}
		if (column === 'url') {
			setEditing({
				url: row.url,
				column,
				kind: 'text',
				draft: row.url,
				label: t('app.urlLabel', { url: row.url }),
			});
			return;
		}
		if (column === 'inputPath') {
			// The file of a page is moved by naming where it goes, and taken away by naming
			// nothing; a virtual page has no file, and is given one by naming where it is.
			setProblem('');
			setEditing({
				url: row.url,
				column,
				kind: 'text',
				draft: row.inputPath ?? '',
				label: t('app.pathLabel', { url: row.url }),
			});
			return;
		}
		if (column === 'virtual') {
			// A box, turned over without an input: a virtual page gets a file where its URL says,
			// and a page with a file is made virtual once the person has said so.
			const edit = virtualEditOf(row);
			if (edit.kind === 'ask') {
				askAboutPage(row.url, 'virtualize');
			} else {
				apply(row.url, edit.change, t('app.pageFile', { url: row.url }));
			}
			return;
		}
		if (!column.startsWith('meta:')) {
			// A fixed column has no label (`ui.keys` is for metadata keys), so it is named by its id.
			setProblem(t('app.cannotEditHere', { name: column }));
			return;
		}
		const key = columnName(column);
		const name = headingOf(column).name;
		const enumKind = enumKindOf(kinds, column, layouts);
		const { cell, kind } = editKindOf(row, key, hints, enumKind);
		if (cell !== undefined && !cell.editable) {
			setProblem(
				t('app.cannotEdit', { key: name, reason: cell.reason ?? t('app.readOnly') }),
			);
			return;
		}
		if (kind === 'boolean') {
			const value = cell === undefined ? true : cell.value !== true;
			apply(row.url, { op: 'set', key, value }, t('app.saved', { key: name }));
			return;
		}
		setProblem('');
		const label = t('app.keyLabel', { key: name, url: row.url });
		if (kind === 'enum') {
			const value = cell?.value;
			setEditing({
				url: row.url,
				column,
				kind,
				draft: draftOf(value, kind),
				label,
				choices: choicesOf(enumKind?.options ?? [], value),
				selected: selectedOf(value),
				// Several can be chosen when the value is a list. A page with no value takes the way of
				// its column: several when some page on this screen holds a list under the key.
				multiple:
					Array.isArray(value) ||
					((value === null || value === undefined) &&
						columnHoldsArrays(rows?.pages ?? [], key)),
			});
			return;
		}
		setEditing({
			url: row.url,
			column,
			kind,
			draft: draftOf(cell === undefined ? defaultOf(kind) : cell.value, kind),
			label,
		});
	};

	/**
	 * Puts the kinds of the columns in a new state: the cells are drawn from it, and it is kept for
	 * the next run (all the kinds, whole).
	 * @param next - The new kinds
	 * @param said - What is said of the change, for screen readers
	 */
	const changeKinds = (next: KindsSettings, said: string) => {
		setEditing(null);
		setKinds(next);
		remember({ project: { kinds: kindsPatch(next) } });
		setStatus(said);
	};

	/**
	 * The kind of input that edits the cell at a place, or `undefined` when it is not a cell of
	 * metadata nor the box of `virtual`.
	 * @param at - The cell, by its place in what is shown
	 */
	const kindAt = (at: Position): FieldKind | undefined => {
		const row = rows?.pages[at.row];
		const column = columns[at.col];
		if (row !== undefined && column !== undefined && isFixedBox(column)) {
			return 'boolean';
		}
		if (row === undefined || column === undefined || !column.startsWith('meta:')) {
			return undefined;
		}
		return editKindOf(row, columnName(column), hints, enumKindOf(kinds, column, layouts))
			.kind;
	};

	/**
	 * Asks whether to put the value of a cell back as HEAD has it, when it can be. The dialog is
	 * made when the edits already asked for have been made, from what is on the screen then: what it
	 * shows, the commit it was compared with and the hashes of the files are one and the same state.
	 * @param at - The cell, by its place in what is shown
	 */
	const requestRevert = (at: Position) => {
		const row = rows?.pages[at.row];
		const column = columns[at.col];
		if (rows === null || row === undefined || column === undefined) {
			return;
		}
		const name = headingOf(column).name;
		const diff = cellDiffOf(diffs?.pages[row.url], column);
		if (diff === undefined) {
			setStatus(t('diff.noDifference', { name }));
			return;
		}
		const target = revertKeyOf(column);
		if (!diff.revertible || target === null) {
			setProblem(t('diff.cannotRevert', { name }));
			return;
		}
		setProblem('');
		const url = row.url;
		void queue.current.idle().then(() => {
			const current = rowsRef.current;
			const latest = rowByUrl(current, url);
			const known = diffsRef.current;
			const latestDiff = cellDiffOf(known?.pages[url], column);
			if (current === null || latest === undefined || known === null) {
				setProblem(tRef.current('app.notInList', { url }));
				return;
			}
			if (latestDiff?.revertible !== true) {
				setStatus(tRef.current('diff.noDifference', { name }));
				return;
			}
			const cell = target.key === null ? undefined : latest.meta[target.key];
			const none = tRef.current('revert.none');
			setReverting({
				url,
				column,
				key: target.key,
				name,
				now: target.key === null ? url : valueText(cell?.value, none),
				head: known.head.oid,
				headValue: valueText(
					latestDiff.kind === 'added' ? undefined : latestDiff.head,
					none,
				),
				where: writeNames(latestDiff.writes, current.overridesFile ?? null, tRef.current),
				expect: expectOf(latest, current.overridesHash),
			});
		});
	};

	/** Puts the value back, in the queue of the edits: each is made on the hashes the one before returned. */
	const confirmRevert = () => {
		const request = reverting;
		setReverting(null);
		focusGrid();
		if (request === null) {
			return;
		}
		queue.current.enqueue(async () => {
			const current = rowsRef.current;
			const row = rowByUrl(current, request.url);
			if (current === null || row === undefined) {
				setProblem(tRef.current('app.notInList', { url: request.url }));
				return;
			}
			const blocked = editBlockedReason(reading.current, tRef.current);
			if (blocked !== null) {
				setProblem(blocked);
				return;
			}
			try {
				const result = await revertCell(
					row.url,
					request.expect,
					request.key,
					request.head,
				);
				const latest = rowsRef.current;
				if (latest !== null) {
					commitRows(applyEdited(latest, row.url, result));
				}
				setProblem('');
				setStatus(tRef.current('diff.reverted', { name: request.name }));
				if (request.key === null) {
					// The URL is what the key says: the page has another URL now.
					pendingFocus.current = result.page.url;
					pendingSaid.current = null;
					reload(true);
				} else {
					await refreshDiff([row.url]);
				}
			} catch (error) {
				const failure = error instanceof ApiError ? revertFailureOf(error.code) : null;
				if (failure === null) {
					setProblem(messageOf(error));
					return;
				}
				if (failure.note !== null) {
					setProblem(tRef.current(failure.note));
				} else if (failure.rereadFiles) {
					setProblem(
						tRef.current('app.conflict', {
							message: error instanceof Error ? error.message : '',
						}),
					);
				} else {
					setProblem(messageOf(error));
				}
				if (failure.rereadFiles) {
					reload(true);
				} else if (failure.marks === 'read') {
					// The marks were of another commit: they are read again with the list.
					reload(false);
				} else if (failure.marks === 'drop') {
					commitDiffs(null);
				}
			}
		});
	};

	const onCommit = (draft: string) => {
		const at = editing;
		setEditing(null);
		focusGrid();
		// The page the cell was opened on, found by its URL: the list may have been read again
		// since, and the same place may now be another page.
		const row = at === null ? undefined : rowByUrl(rowsRef.current, at.url);
		if (at === null || row === undefined) {
			if (at !== null) {
				setProblem(t('app.notInList', { url: at.url }));
			}
			return;
		}
		if (at.column === 'url') {
			const edit = urlEditOf(row, draft);
			if (edit.kind === 'move') {
				apply(row.url, edit.change, t('app.moved', { url: draft }));
			} else if (edit.kind === 'ask') {
				// A page without a URL is no page.
				askAboutPage(row.url, 'delete');
			}
			return;
		}
		if (at.column === 'inputPath') {
			const edit = pathEditOf(row, draft);
			switch (edit.kind) {
				case 'move': {
					apply(row.url, edit.change, t('app.movedPath', { path: draft }));

					break;
				}
				case 'materialize': {
					apply(row.url, edit.change, t('app.pageFile', { url: row.url }));

					break;
				}
				case 'ask': {
					// Without its file the page would be gone: whether it stays as a virtual page
					// is the person's to say.
					askAboutPage(row.url, 'emptyPath');

					break;
				}
				// No default
			}
			return;
		}
		const key = columnName(at.column);
		const parsed = parseDraft(at.kind, draft);
		if (!parsed.ok) {
			return;
		}
		const { cell } = cellOf(row, key, added);
		if (!shouldWrite(cell ?? null, draft, at.draft, parsed.value)) {
			return;
		}
		apply(
			row.url,
			{ op: 'set', key, value: parsed.value },
			t('app.saved', { key: headingOf(at.column).name }),
		);
	};

	const onCancel = () => {
		setEditing(null);
		focusGrid();
	};

	// The rows get these two functions as props. They must be the same functions at every
	// render, or no row would be left alone by `memo` and typing in a cell would draw all
	// five thousand rows; they call the ones made by the latest committed render. The ref is
	// written in a layout effect and not while drawing (a render that is thrown away, in
	// StrictMode or a concurrent render, would leave its functions in it); it runs before the
	// browser can send the event that reads it.
	const latest = useRef({ onCommit, onCancel });
	useLayoutEffect(() => {
		latest.current = { onCommit, onCancel };
	});
	const commitStable = useCallback((draft: string) => latest.current.onCommit(draft), []);
	const cancelStable = useCallback(() => latest.current.onCancel(), []);

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget || rows === null) {
			return;
		}
		if (event.key === 'Enter' || event.key === 'F2') {
			event.preventDefault();
			startEdit(active);
			return;
		}
		if (opensMenu(event.key, event.altKey, event.shiftKey)) {
			const id = columns[active.col];
			if (id !== undefined) {
				event.preventDefault();
				openMenu(id, null);
			}
			return;
		}
		// Space turns a box of booleans over, as clicking on it does; on any other cell it is not ours.
		if (
			event.key === ' ' &&
			!event.ctrlKey &&
			!event.metaKey &&
			!event.altKey &&
			kindAt(active) === 'boolean'
		) {
			event.preventDefault();
			startEdit(active);
			return;
		}
		// Alt+Backspace puts the value of the cell back as HEAD has it (the bar of the cell does the
		// same for the pointer).
		if (event.key === 'Backspace' && event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			requestRevert(active);
			return;
		}
		if (event.key === 'Delete') {
			const row = rows.pages[active.row];
			const id = columns[active.col];
			const key = id?.startsWith('meta:') === true ? columnName(id) : undefined;
			if (row !== undefined && key !== undefined) {
				const { cell } = cellOf(row, key, added);
				if (cell === undefined) {
					return;
				}
				event.preventDefault();
				const name = headingOf(`meta:${key}`).name;
				if (cell.editable) {
					apply(row.url, { op: 'delete', key }, t('app.removed', { key: name }));
				} else {
					setProblem(
						t('app.cannotRemove', {
							key: name,
							reason: cell.reason ?? t('app.readOnly'),
						}),
					);
				}
			}
			return;
		}
		const next = nextCell(active, event.key, event.ctrlKey || event.metaKey, {
			rows: rows.pages.length,
			cols: colCount,
			screen: SCREEN_ROWS,
		});
		if (next !== active) {
			event.preventDefault();
			if (next.row >= visible) {
				setVisible(Math.min(rows.pages.length, next.row + CHUNK));
			}
			setActive(next);
		}
	};

	const cellAt = (target: EventTarget): Position | null => {
		const cell = (target as HTMLElement).closest<HTMLElement>('[role="gridcell"]');
		if (cell === null) {
			return null;
		}
		return { row: Number(cell.dataset.row), col: Number(cell.dataset.col) };
	};

	/**
	 * Gives the cell of a button of the grid the focus, unless a cell is being edited.
	 * @param button - The button that was pressed: the one that covers the cell, the bar of a
	 * difference, or the box of a boolean
	 * @returns The cell, or `null` when nothing was done
	 */
	const focusCellOf = (button: HTMLElement): Position | null => {
		const at = cellAt(button);
		if (at === null || editing !== null) {
			return null;
		}
		setActive(at);
		focusGrid();
		return at;
	};

	const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const at = cellAt(event.target);
		// The two clicks of a double click on the box have turned it over twice already.
		if (
			at !== null &&
			editing === null &&
			(event.target as HTMLElement).closest('[data-toggle], [data-revert]') === null
		) {
			setActive(at);
			startEdit(at);
		}
	};

	const go = (next: number) => {
		setPage(next);
		setActive({ row: 0, col: 0 });
		setVisible(CHUNK);
		setEditing(null);
	};

	/**
	 * The arrow keys, Home and End move the focus among the header buttons: the row of headers is
	 * a single stop of Tab (the one that had the focus last), however many columns there are.
	 * @param event - The key pressed in the row of headers
	 */
	const moveAmongHeaders = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
			return;
		}
		const buttons = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>(
				'button.menu-button:not(:disabled)',
			),
		];
		const at = buttons.indexOf(event.target as HTMLButtonElement);
		let next: HTMLButtonElement | undefined;
		if (event.key === 'Home') {
			next = buttons[0];
		} else if (event.key === 'End') {
			next = buttons.at(-1);
		} else {
			next = buttons[at + (event.key === 'ArrowRight' ? 1 : -1)];
		}
		if (at >= 0 && next !== undefined) {
			event.preventDefault();
			next.focus();
		}
	};

	/**
	 * Puts the layout in a new state: the grid is drawn from it, the person's place in the grid
	 * follows the column they were in, and it is kept for the next run (the three lists whole).
	 * @param next - The new state
	 * @param said - What is said of the change, for screen readers
	 */
	const changeLayout = (next: ColumnState, said: string | null) => {
		const here = columns[active.col];
		const after = layoutOf(known, next);
		setEditing(null);
		setColumnState(next);
		setActive((prev) => ({
			row: prev.row,
			col: Math.max(0, here === undefined ? 0 : after.shown.indexOf(here)),
		}));
		remember({ project: { columns: settingsOf(next, known) } });
		if (said !== null) {
			setStatus(said);
		}
	};

	/**
	 * Opens the menu of a column under its header.
	 * @param id - The identifier of the column
	 * @param restore - The element the focus goes back to when a key closes the menu; the grid when `null`
	 */
	const openMenu = (id: string, restore: HTMLElement | null) => {
		const header = [
			...(gridRef.current?.querySelectorAll<HTMLElement>('[role="columnheader"]') ?? []),
		].find((cell) => cell.dataset.column === id);
		if (header === undefined) {
			return;
		}
		const rect = header.getBoundingClientRect();
		menuRestore.current = restore;
		setMenu({ id, anchor: { left: rect.left, bottom: rect.bottom } });
	};

	const focusBack = useCallback(() => {
		const back = menuRestore.current;
		(back?.isConnected === true ? back : gridRef.current)?.focus();
	}, []);

	const closeMenu = useCallback(
		(restoreFocus: boolean) => {
			setMenu(null);
			if (restoreFocus) {
				focusBack();
			}
		},
		[focusBack],
	);

	/**
	 * What is said when a column was moved.
	 * @param next - The state after the move
	 * @param id - The column that was moved
	 */
	const movedSaid = (next: ColumnState, id: string) =>
		t('column.movedTo', {
			name: headingOf(id).name,
			position: positionOf(layoutOf(known, next), id) + 1,
			count: colCount,
		});

	/**
	 * What is said when a column was resized.
	 * @param next - The state after the resize
	 * @param id - The column that was resized
	 */
	const widthSaid = (next: ColumnState, id: string) =>
		t('column.width', {
			name: headingOf(id).name,
			width: widthOf(layoutOf(known, next), id),
		});

	/**
	 * The entries of the menu of a column.
	 * @param id - The identifier of the column
	 */
	const menuItems = (id: string): MenuItem[] => {
		const place = columns.indexOf(id);
		const isPinned = place < pinnedCount;
		const first = isPinned ? 0 : pinnedCount;
		const last = isPinned ? pinnedCount - 1 : colCount - 1;
		const width = widthOf(sized, id);
		return [
			{
				id: isPinned ? 'unpin' : 'pin',
				label: t(isPinned ? 'column.unpin' : 'column.pin'),
			},
			{ id: 'left', label: t('column.moveLeft'), disabled: place <= first },
			{ id: 'right', label: t('column.moveRight'), disabled: place >= last },
			{ id: 'sortAscending', label: t('column.sortAscending'), disabled: !canSort(id) },
			{ id: 'sortDescending', label: t('column.sortDescending'), disabled: !canSort(id) },
			{ id: 'sortClear', label: t('column.sortClear'), disabled: sort?.key !== id },
			{ id: 'wider', label: t('column.wider'), disabled: width >= MAX_COLUMN_WIDTH },
			{
				id: 'narrower',
				label: t('column.narrower'),
				disabled: width <= MIN_COLUMN_WIDTH,
			},
			{
				id: 'resetWidth',
				label: t('column.resetWidth'),
				disabled: !Object.hasOwn(columnState.widths, id),
			},
			// The value of the row with the focus, put back as HEAD has it.
			{
				id: 'revert',
				label: t('column.revert'),
				disabled:
					cellDiffOf(diffs?.pages[rows?.pages[active.row]?.url ?? ''], id)?.revertible !==
					true,
			},
			// Only a column of metadata has values to choose among.
			// (and one whose name the settings can keep: the same limit as a sort's column).
			// The options of the `layout` column are the files of the layouts directory.
			...(id.startsWith('meta:') && isColumnId(id) && !optionsFromFiles(id, layouts)
				? enumKindOf(kinds, id) === undefined
					? [{ id: 'kindEnum', label: t('column.kindChoose') }]
					: [
							{ id: 'kindEdit', label: t('column.kindEdit') },
							{ id: 'kindAuto', label: t('column.kindAuto') },
						]
				: []),
		];
	};

	/**
	 * Does what an entry of the menu says.
	 * @param id - The identifier of the column
	 * @param action - The id of the entry
	 */
	const runMenu = (id: string, action: string) => {
		const name = headingOf(id).name;
		switch (action) {
			case 'pin': {
				changeLayout(pinColumn(columnState, known, id), t('column.pinned', { name }));
				break;
			}
			case 'unpin': {
				changeLayout(unpinColumn(columnState, known, id), t('column.unpinned', { name }));
				break;
			}
			case 'left':
			case 'right': {
				const next = moveColumn(columnState, known, id, action === 'left' ? -1 : 1);
				changeLayout(next, movedSaid(next, id));
				break;
			}
			case 'sortAscending':
			case 'sortDescending': {
				setSort({ key: id, desc: action === 'sortDescending' });
				go(0);
				break;
			}
			case 'sortClear': {
				setSort(null);
				go(0);
				break;
			}
			case 'wider':
			case 'narrower': {
				const current = widthOf(sized, id);
				const next = resizeColumn(
					columnState,
					id,
					current + (action === 'wider' ? WIDTH_STEP : -WIDTH_STEP),
				);
				changeLayout(next, widthSaid(next, id));
				break;
			}
			case 'resetWidth': {
				changeLayout(resetWidth(columnState, id), t('column.widthReset', { name }));
				break;
			}
			case 'revert': {
				requestRevert({ row: active.row, col: columns.indexOf(id) });
				break;
			}
			case 'kindEnum':
			case 'kindEdit': {
				setOptionsFor(id);
				break;
			}
			case 'kindAuto': {
				changeKinds(withKind(kinds, id, null), t('column.kindCleared', { name }));
				break;
			}
			default: {
				break;
			}
		}
	};

	/**
	 * The keys of the row of headers: the arrows move among the buttons, and the keys that open a
	 * menu open the menu of the column.
	 * @param event - The key pressed in the row of headers
	 */
	const onHeaderKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (
			opensMenu(event.key, event.altKey, event.shiftKey) ||
			// In the row of headers the arrow down has no other use, so it opens the menu of the
			// column as it does on any button that has one.
			(event.key === 'ArrowDown' && !event.ctrlKey && !event.metaKey)
		) {
			const cell = (event.target as HTMLElement).closest<HTMLElement>(
				'[role="columnheader"]',
			);
			const id = cell?.dataset.column;
			if (id !== undefined) {
				event.preventDefault();
				openMenu(id, cell?.querySelector<HTMLElement>('button.menu-button') ?? null);
			}
			return;
		}
		moveAmongHeaders(event);
	};

	// The width of a column follows the pointer while its edge is dragged, and is kept when the
	// button is let go.
	const onResizeDown = (
		event: React.PointerEvent<HTMLElement>,
		id: string,
		width: number,
	) => {
		if (event.button !== 0) {
			return;
		}
		// The cell being edited is written first: this press does not move the focus (it is not a
		// click on anything that takes it), so the input would not be left, and the edit would
		// be dropped with the redraw. Only an input of a cell is left; the focus of the grid stays.
		const focused = document.activeElement as HTMLElement | null;
		if (focused?.matches('input.editor, textarea.editor') === true) {
			focused.blur();
		}
		event.preventDefault();
		event.stopPropagation();
		event.currentTarget.setPointerCapture(event.pointerId);
		resize.current = { id, startX: event.clientX, startWidth: width, width };
	};
	const onResizeMove = (event: React.PointerEvent<HTMLElement>) => {
		const drag = resize.current;
		if (drag !== null) {
			drag.width = Math.round(drag.startWidth + event.clientX - drag.startX);
			setLiveWidth({ id: drag.id, width: drag.width });
		}
	};
	const onResizeEnd = (event: React.PointerEvent<HTMLElement>) => {
		const drag = resize.current;
		resize.current = null;
		setLiveWidth(null);
		if (drag !== null && event.type === 'pointerup' && drag.width !== drag.startWidth) {
			const next = resizeColumn(columnState, drag.id, drag.width);
			// A width held to the range can be the width the column has: nothing changed, so nothing
			// is saved or said.
			if (
				widthOf(layoutOf(known, next), drag.id) !==
				widthOf(layoutOf(known, columnState), drag.id)
			) {
				changeLayout(next, widthSaid(next, drag.id));
			}
		}
	};

	const pages = rows === null ? 1 : pageCount(rows.total, pageSize);
	const gridStyle = {
		'--cols': sized.widths.map((width) => `${width}px`).join(' '),
		// The width the pinned columns take: what a cell that is moved into view must clear.
		'--pin-total': `${sized.widths.slice(0, pinnedCount).reduce((sum, width) => sum + width, 0)}px`,
		...Object.fromEntries(
			sized.lefts.map((left, place) => [`--pin-${place}`, `${left}px`]),
		),
	} as React.CSSProperties;

	// The buttons of the bar, of the headers and of the cells send their commands to the root.
	// A header, a cell and the revert bar are told apart by where the button is (`data-column`,
	// `role="gridcell"`).
	const commands = useCommands({
		previous: () => go(page - 1),
		next: () => go(page + 1),
		readAgain: reloadWhenIdle,
		syncMenu: (button) => {
			if (syncMenu !== null) {
				setSyncMenu(null);
				return;
			}
			const rect = button.getBoundingClientRect();
			setSyncMenu({ left: rect.left, bottom: rect.bottom });
		},
		columnMenu: (button) => {
			const id = button.closest<HTMLElement>('[data-column]')?.dataset.column;
			if (id !== undefined) {
				if (menu?.id === id) {
					closeMenu(true);
				} else {
					openMenu(id, button);
				}
			}
		},
		// The button over a cell gives the cell the focus.
		cell: (button) => void focusCellOf(button),
		// The bar of a difference asks whether to put the value back.
		revert: (button) => {
			const at = focusCellOf(button);
			if (at !== null) {
				requestRevert(at);
			}
		},
		// The box of a boolean turns it over (the box is the only part of the cell that does: the
		// rest of it only gives the cell the focus).
		toggle: (button) => {
			const at = focusCellOf(button);
			if (at !== null) {
				startEdit(at);
			}
		},
	});

	return (
		<div ref={commands.ref} id={commands.id} className="app">
			<header className="bar">
				<h1>kamado ui</h1>
				{git !== null && (
					<span className="git" title={gitLabel(git)}>
						<span className="sr-only">{t('app.git')}: </span>
						{gitLabel(git)}
					</span>
				)}
				<label>
					{t('app.search')}
					<input
						type="search"
						value={typed}
						onChange={(event) => setTyped(event.target.value)}
						placeholder={t('app.searchPlaceholder')}
					/>
				</label>
				<label>
					{t('app.pageSize')}
					<select
						value={pageSize}
						onChange={(event) => {
							const size = Number(event.target.value);
							setPageSize(size);
							go(0);
							remember({ project: { pageSize: size } });
						}}>
						{PAGE_SIZES.map((n) => (
							<option key={n} value={n}>
								{n.toLocaleString('en-US')}
							</option>
						))}
					</select>
				</label>
				<nav aria-label={t('app.pages')} className="pager">
					<button type="button" disabled={page === 0} {...commands.run('previous')}>
						{t('app.previous')}
					</button>
					<span>
						{rows === null
							? ''
							: rangeLabel(page * pageSize, rows.pages.length, rows.total)}
					</span>
					<button type="button" disabled={page >= pages - 1} {...commands.run('next')}>
						{t('app.next')}
					</button>
				</nav>
				<button type="button" {...builtinCommand(ADD_PAGE_DIALOG_ID, 'show-modal')}>
					{t('app.addPage')}
				</button>
				<button type="button" {...builtinCommand(ADD_KEY_DIALOG_ID, 'show-modal')}>
					{t('app.addKey')}
				</button>
				<button type="button" disabled={loading} {...commands.run('readAgain')}>
					{t('app.readAgain')}
				</button>
				{syncFunctions.length > 0 && (
					<button
						ref={syncButton}
						type="button"
						className="sync-button"
						aria-haspopup="menu"
						aria-expanded={syncMenu !== null}
						disabled={loading}
						{...commands.run('syncMenu')}>
						{t('sync.button')} ▾
					</button>
				)}
				<label>
					{t('app.language')}
					<select
						value={locale}
						onChange={(event) => {
							const next = event.target.value as LocaleSetting;
							onLocale(next);
							// What was said in the other language is not carried over in it.
							setStatus('');
							setProblem('');
							remember({ global: { locale: next } });
						}}>
						<option value="auto">{t('app.languageAuto')}</option>
						<option value="en">English</option>
						<option value="ja">日本語</option>
					</select>
				</label>
			</header>
			<p role="status" className="status">
				{loading ? t('app.loading') : status}
			</p>
			{settingsNote !== null && (
				<p
					role={settingsNote.kind === 'notSaved' ? 'alert' : 'status'}
					className="problem">
					{settingsNote.kind === 'unreadable'
						? t('app.settingsUnreadable')
						: t(
								settingsNote.kind === 'warning'
									? 'app.settingsWarning'
									: 'app.settingsNotSaved',
								{ message: settingsNote.message },
							)}
				</p>
			)}
			<p role="alert" className="problem">
				{problem}
			</p>
			{rows !== null && rows.warnings.length > 0 && (
				<details className="warnings">
					<summary>{t('app.warnings', { count: rows.warnings.length })}</summary>
					<ul>
						{rows.warnings.map((w, i) => (
							<li key={`${i}:${w}`}>{w}</li>
						))}
					</ul>
				</details>
			)}
			<div
				ref={gridRef}
				role="grid"
				aria-label={t('app.gridLabel')}
				aria-rowcount={rows === null ? undefined : rows.total + 1}
				aria-colcount={colCount}
				aria-activedescendant={
					rows === null || editing !== null ? undefined : `c-${active.row}-${active.col}`
				}
				aria-busy={loading}
				tabIndex={0}
				className="grid"
				style={gridStyle}
				onKeyDown={onKeyDown}
				onDoubleClick={onDoubleClick}>
				<div
					role="row"
					aria-rowindex={1}
					className="row head"
					onKeyDown={onHeaderKeyDown}>
					{columns.map((id, col) => {
						const { name, detail } = headingOf(id);
						const direction = ariaSortOf(sort, id);
						const isPinned = col < pinnedCount;
						// A column goes only to a place of its own group: the pinned ones among
						// themselves, the others among themselves.
						const droppable =
							dragging !== null &&
							dragging !== id &&
							columns.indexOf(dragging) < pinnedCount === isPinned;
						return (
							<div
								key={id}
								role="columnheader"
								title={detail}
								data-column={id}
								aria-colindex={col + 1}
								aria-sort={direction}
								draggable
								style={isPinned ? { left: `var(--pin-${col})` } : undefined}
								className={`cell${isPinned ? ' pinned' : ''}${col === pinnedCount - 1 ? ' pin-end' : ''}${dropOn === id ? ' drop-target' : ''}${dropOn === id && dragging !== null && columns.indexOf(dragging) < col ? ' drop-after' : ''}`}
								onDragStart={(event) => {
									// The edge of a column is for resizing, not for moving it.
									if (resize.current !== null) {
										event.preventDefault();
										return;
									}
									event.dataTransfer.setData(COLUMN_MIME, id);
									event.dataTransfer.effectAllowed = 'move';
									setDragging(id);
								}}
								onDragOver={(event) => {
									if (droppable) {
										event.preventDefault();
										event.dataTransfer.dropEffect = 'move';
										setDropOn(id);
									}
								}}
								onDragLeave={() => setDropOn((on) => (on === id ? null : on))}
								onDrop={(event) => {
									event.preventDefault();
									if (dragging !== null && droppable) {
										const next = moveColumnTo(columnState, known, dragging, id);
										changeLayout(next, movedSaid(next, dragging));
									}
									setDragging(null);
									setDropOn(null);
								}}
								onDragEnd={() => {
									setDragging(null);
									setDropOn(null);
								}}>
								<span className="name">
									{name}
									<span aria-hidden="true" className="sort-mark">
										{direction === 'ascending'
											? '▲'
											: direction === 'descending'
												? '▼'
												: ''}
									</span>
								</span>
								{/* The one button of a header is its menu: the name is for dragging the column, and a click on
								    it does nothing (the sort and the rest are chosen in the menu). The button is the single
								    stop of Tab of the row of headers (the one that had the focus last; the first if that
								    column is gone), and the arrows move among the buttons. */}
								<button
									type="button"
									className="menu-button"
									tabIndex={
										id ===
										(headerStop !== null && columns.includes(headerStop)
											? headerStop
											: columns[0])
											? 0
											: -1
									}
									onFocus={() => setHeaderStop(id)}
									aria-haspopup="menu"
									aria-expanded={menu?.id === id}
									aria-label={t('column.menu', { name })}
									{...commands.run('columnMenu')}>
									<span aria-hidden="true">⋮</span>
								</button>
								<span
									aria-hidden="true"
									className="resize-handle"
									onPointerDown={(event) =>
										onResizeDown(event, id, sized.widths[col] ?? 0)
									}
									onPointerMove={onResizeMove}
									onPointerUp={onResizeEnd}
									onPointerCancel={onResizeEnd}
									onDoubleClick={() =>
										changeLayout(
											resetWidth(columnState, id),
											t('column.widthReset', { name }),
										)
									}
								/>
							</div>
						);
					})}
				</div>
				{rows?.pages.slice(0, visible).map((row, index) => (
					<GridRow
						key={row.url}
						row={row}
						index={index}
						ariaIndex={page * pageSize + index + 2}
						columns={columns}
						pinnedCount={pinnedCount}
						addedKinds={hints}
						kinds={kinds}
						layouts={layouts}
						activeCol={active.row === index ? active.col : -1}
						editing={editing !== null && editing.url === row.url ? editing : null}
						diff={diffs?.pages[row.url]}
						overridesFile={rows.overridesFile ?? null}
						commandTarget={commands.id}
						onCommit={commitStable}
						onCancel={cancelStable}
						onInvalid={setProblem}
					/>
				))}
			</div>
			{/* What the marks of the table mean is under it: the tools are above, and the rows start
			    right below them. */}
			<footer className="foot" aria-label={t('app.legend')}>
				<Legend overridesFile={rows?.overridesFile} git={git} compared={diffs !== null} />
			</footer>
			{menu !== null && (
				<ColumnMenu
					label={t('column.menu', { name: headingOf(menu.id).name })}
					note={headingOf(menu.id).detail}
					anchor={menu.anchor}
					items={menuItems(menu.id)}
					onChoose={(action) => {
						closeMenu(true);
						runMenu(menu.id, action);
						// A column that was moved is moved in the page, and a node that is moved loses
						// the focus: it is given back once the page has been drawn again.
						queueMicrotask(focusBack);
					}}
					onClose={closeMenu}
				/>
			)}
			{syncMenu !== null && (
				<ColumnMenu
					label={t('sync.menu')}
					anchor={syncMenu}
					items={syncFunctions.map((operation) => ({
						id: operation.name,
						label: operationLabel(operation, language),
					}))}
					onChoose={(name) => {
						setSyncMenu(null);
						const operation = syncFunctions.find((candidate) => candidate.name === name);
						if (operation !== undefined) {
							// The edits that are being saved are made first: the pages the script is
							// given are the ones on disk.
							void queue.current.idle().then(() => {
								setSyncRequest((before) => ({
									operation,
									nonce: (before?.nonce ?? 0) + 1,
								}));
							});
						}
					}}
					onClose={(restoreFocus) => {
						setSyncMenu(null);
						if (restoreFocus) {
							syncButton.current?.focus();
						}
					}}
				/>
			)}
			<SyncDialog request={syncRequest} onEnd={syncEnded} />
			{optionsFor !== null && (
				<OptionsDialog
					key={optionsFor}
					column={optionsFor}
					name={headingOf(optionsFor).name}
					initial={enumKindOf(kinds, optionsFor)?.options ?? null}
					kinds={kinds}
					onSave={(options) =>
						changeKinds(
							withKind(kinds, optionsFor, options),
							t('column.kindSet', {
								name: headingOf(optionsFor).name,
								count: options.length,
							}),
						)
					}
					onClose={() => setOptionsFor(null)}
				/>
			)}
			<RevertDialog
				request={reverting}
				onConfirm={confirmRevert}
				onCancel={() => {
					setReverting(null);
					focusGrid();
				}}
			/>
			<PageDialog
				question={asking}
				overridesFile={rows?.overridesFile ?? null}
				onChoose={answerPageQuestion}
				onCancel={() => {
					setAsking(null);
					focusGrid();
				}}
			/>
			<AddPageDialog key={addForm} dialogRef={addPageRef} onAdd={requestAddPage} />
			<AddKeyDialog
				dialogRef={dialogRef}
				onAdd={(name, kind) => {
					if (columns.includes(`meta:${name}`)) {
						setStatus(t('app.alreadyColumn', { name: headingOf(`meta:${name}`).name }));
						return;
					}
					setAdded((prev) => new Map(prev).set(name, kind));
					setStatus(t('app.columnAdded', { name: headingOf(`meta:${name}`).name }));
				}}
			/>
		</div>
	);
}

/** The `id` of the dialog that adds a key: the button of the bar that opens it names it in `commandfor`. */
const ADD_KEY_DIALOG_ID = 'add-key-dialog';

interface AddKeyProps {
	readonly dialogRef: React.RefObject<HTMLDialogElement | null>;
	readonly onAdd: (name: string, kind: FieldKind) => void;
}

/**
 * The dialog that adds a key: its name, and the kind of input its values are edited with.
 * @param props - The ref of the `<dialog>`, which the button of the bar opens, and what is
 * done with the name and the kind that were chosen
 * @param props.dialogRef - The ref of the `<dialog>`
 * @param props.onAdd - Called with the name and the kind when the form is sent
 */
function AddKeyDialog({ dialogRef, onAdd }: AddKeyProps) {
	const { t } = useI18n();
	const [name, setName] = useState('');
	const [kind, setKind] = useState<FieldKind>('text');
	return (
		<dialog
			ref={dialogRef}
			id={ADD_KEY_DIALOG_ID}
			aria-labelledby="add-key-title"
			className="dialog">
			<form
				method="dialog"
				onSubmit={(event) => {
					event.preventDefault();
					const trimmed = name.trim();
					if (trimmed === '') {
						return;
					}
					onAdd(trimmed, kind);
					setName('');
					dialogRef.current?.close();
				}}>
				<h2 id="add-key-title">{t('app.addKey')}</h2>
				<label>
					{t('dialog.name')}
					<input
						required
						autoFocus
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</label>
				<label>
					{t('dialog.type')}
					<select
						value={kind}
						onChange={(event) => setKind(event.target.value as FieldKind)}>
						{FIELD_KINDS.map((k) => (
							<option key={k} value={k}>
								{t(`kind.${k}` as const)}
							</option>
						))}
					</select>
				</label>
				<div className="actions">
					<button type="button" {...builtinCommand(ADD_KEY_DIALOG_ID, 'close')}>
						{t('dialog.cancel')}
					</button>
					<button type="submit">{t('dialog.add')}</button>
				</div>
			</form>
		</dialog>
	);
}
