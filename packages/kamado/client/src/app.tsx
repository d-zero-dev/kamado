import type { Editing } from './grid-row.js';
import type { LocaleSetting } from './i18n/translate.js';
import type { Position } from './logic/grid.js';
import type { Reading } from './logic/session.js';
import type { FieldKind } from './logic/value.js';
import type { Change, Rows, SettingsPatch, SettingsView } from './types.js';

import {
	startTransition,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from 'react';

import { ApiError, editPage, fetchRows, refreshSite, saveSettings } from './api.js';
import { ColumnMenu, type MenuItem } from './column-menu.js';
import { GridRow } from './grid-row.js';
import { I18nContext, useI18n } from './i18n/context.js';
import { resolveLanguage, translator } from './i18n/translate.js';
import { cellOf, expectOf } from './logic/columns.js';
import { nextCell, pageCount, rangeLabel } from './logic/grid.js';
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
	sameSort,
	sortAfterFailure,
	type SortState,
} from './logic/sort.js';
import { FIELD_KINDS, defaultOf, draftOf, parseDraft } from './logic/value.js';

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
	const { t } = useI18n();
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
	const [visible, setVisible] = useState(CHUNK);
	const [status, setStatus] = useState('');
	const [problem, setProblem] = useState('');
	const [loading, setLoading] = useState(true);

	const gridRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLDialogElement>(null);
	const needRefresh = useRef(false);
	// Whether the list on the screen can be edited. While it is being read again, the hashes it
	// holds may be those of before: an edit made then would be refused as a conflict, so it is
	// dropped (and said so) instead. `failed` stays until the list is read again.
	const reading = useRef<Reading>('busy');
	const qRef = useRef('');
	const pendingFocus = useRef<string | null>(null);
	const loadedAt = useRef(0);
	const queue = useRef(createQueue());

	const commitRows = useCallback((next: Rows | null) => {
		rowsRef.current = next;
		setRows(next);
	}, []);

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
			try {
				if (needRefresh.current) {
					needRefresh.current = false;
					await refreshSite();
				}
				const result = await fetchRows(
					page * pageSize,
					pageSize,
					q,
					sort,
					controller.signal,
				);
				if (controller.signal.aborted) {
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
				if (!sameSort(sort, savedSort.current)) {
					// The server took this sort (see `savedSort`).
					savedSort.current = sort;
					void saver({ project: { sort } });
				}
				const wanted = pendingFocus.current;
				pendingFocus.current = null;
				const urls = result.pages.map((p) => p.url);
				setActive((prev) => ({
					row: focusAfterLoad(urls, prev.row, wanted).row,
					col: prev.col,
				}));
				const said = focusAfterLoad(urls, 0, wanted, tRef.current).said;
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
	}, [page, pageSize, q, sort, tick, commitRows, saver]);

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

	const known = useMemo(
		() => columnIds([...(rows?.columns ?? []), ...added.keys()]),
		[rows?.columns, added],
	);
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

	/** Edits are made one after another: each is made on the hashes the one before returned. */
	const apply = useCallback(
		(url: string, change: Change, saved: string) => {
			// The page is named by its URL, not by its place in the list: the list may be read
			// again (and ordered differently) before this edit's turn comes.
			queue.current.enqueue(async () => {
				const current = rowsRef.current;
				const row = rowByUrl(current, url);
				if (current === null || row === undefined) {
					setProblem(tRef.current('app.notInList', { url }));
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
						expectOf(row, current.overridesHash),
						change,
					);
					const latest = rowsRef.current;
					if (latest !== null) {
						commitRows(applyEdited(latest, row.url, result));
					}
					setProblem('');
					setStatus(saved);
					if (change.op === 'moveUrl') {
						pendingFocus.current = result.page.url;
						reload(true);
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
		[commitRows, reload],
	);

	const focusGrid = () => gridRef.current?.focus();

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
		if (!column.startsWith('meta:')) {
			setProblem(t('app.cannotEditHere', { name: column }));
			return;
		}
		const key = columnName(column);
		const { cell, kind } = cellOf(row, key, added);
		if (cell !== undefined && !cell.editable) {
			setProblem(t('app.cannotEdit', { key, reason: cell.reason ?? t('app.readOnly') }));
			return;
		}
		if (kind === 'boolean') {
			const value = cell === undefined ? true : cell.value !== true;
			apply(row.url, { op: 'set', key, value }, t('app.saved', { key }));
			return;
		}
		setProblem('');
		setEditing({
			url: row.url,
			column,
			kind,
			draft: draftOf(cell === undefined ? defaultOf(kind) : cell.value, kind),
			label: t('app.keyLabel', { key, url: row.url }),
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
			if (draft !== row.url) {
				apply(row.url, { op: 'moveUrl', url: draft }, t('app.moved', { url: draft }));
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
		apply(row.url, { op: 'set', key, value: parsed.value }, t('app.saved', { key }));
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
				if (cell.editable) {
					apply(row.url, { op: 'delete', key }, t('app.removed', { key }));
				} else {
					setProblem(
						t('app.cannotRemove', { key, reason: cell.reason ?? t('app.readOnly') }),
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

	const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const at = cellAt(event.target);
		if (at !== null && editing === null) {
			setActive(at);
			focusGrid();
		}
	};

	const onDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const at = cellAt(event.target);
		if (at !== null && editing === null) {
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
			name: columnName(id),
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
			name: columnName(id),
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
		];
	};

	/**
	 * Does what an entry of the menu says.
	 * @param id - The identifier of the column
	 * @param action - The id of the entry
	 */
	const runMenu = (id: string, action: string) => {
		const name = columnName(id);
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

	return (
		<div className="app">
			<header className="bar">
				<h1>kamado ui</h1>
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
					<button type="button" disabled={page === 0} onClick={() => go(page - 1)}>
						{t('app.previous')}
					</button>
					<span>
						{rows === null
							? ''
							: rangeLabel(page * pageSize, rows.pages.length, rows.total)}
					</span>
					<button type="button" disabled={page >= pages - 1} onClick={() => go(page + 1)}>
						{t('app.next')}
					</button>
				</nav>
				<button type="button" onClick={() => dialogRef.current?.showModal()}>
					{t('app.addKey')}
				</button>
				<button type="button" onClick={reloadWhenIdle} disabled={loading}>
					{t('app.readAgain')}
				</button>
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
				onClick={onClick}
				onDoubleClick={onDoubleClick}>
				<div
					role="row"
					aria-rowindex={1}
					className="row head"
					onKeyDown={onHeaderKeyDown}>
					{columns.map((id, col) => {
						const name = columnName(id);
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
									onClick={(event) =>
										menu?.id === id ? closeMenu(true) : openMenu(id, event.currentTarget)
									}>
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
						addedKinds={added}
						activeCol={active.row === index ? active.col : -1}
						editing={editing !== null && editing.url === row.url ? editing : null}
						onCommit={commitStable}
						onCancel={cancelStable}
						onInvalid={setProblem}
					/>
				))}
			</div>
			{menu !== null && (
				<ColumnMenu
					label={t('column.menu', { name: columnName(menu.id) })}
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
			<AddKeyDialog
				dialogRef={dialogRef}
				onAdd={(name, kind) => {
					if (columns.includes(`meta:${name}`)) {
						setStatus(t('app.alreadyColumn', { name }));
						return;
					}
					setAdded((prev) => new Map(prev).set(name, kind));
					setStatus(t('app.columnAdded', { name }));
				}}
			/>
		</div>
	);
}

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
			id="add-key-dialog"
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
					<button type="button" onClick={() => dialogRef.current?.close()}>
						{t('dialog.cancel')}
					</button>
					<button type="submit">{t('dialog.add')}</button>
				</div>
			</form>
		</dialog>
	);
}
