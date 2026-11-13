import type { HeldChanges } from './sync-view.js';
import type { SyncFunction, SyncKind, SyncState } from './types.js';

import { useCallback, useEffect, useRef, useState } from 'react';

import {
	ApiError,
	applySync,
	cancelSync,
	fetchSyncChanges,
	fetchSyncState,
	startSync,
} from './api.js';
import { focusOnMount } from './focus-on-mount.js';
import { useI18n } from './i18n/context.js';
import { followSync } from './logic/sync-run.js';
import { firstTab, NO_LOG, operationLabel, tabsOf, type HeldLog } from './logic/sync.js';
import { SYNC_TITLE_ID, SyncView } from './sync-view.js';
import { useCommands } from './use-commands.js';

/** How a sync ended when its dialog was closed. */
export type SyncEnd =
	/** The changes were applied (an import), or written out (an export). */
	| {
			readonly kind: 'applied';
			readonly name: string;
			readonly count: number;
			readonly direction?: 'import' | 'export';
	  }
	/** The script failed. */
	| { readonly kind: 'failed'; readonly name: string; readonly message: string }
	/** Cancelled; `phase: 'write'` when an export was writing, so that what is outside may be half written. */
	| { readonly kind: 'cancelled'; readonly name: string; readonly phase?: 'write' }
	/** The sync could not be started (another is running, the config has no such operation). */
	| { readonly kind: 'notStarted'; readonly name: string; readonly message: string }
	/** Closed with nothing more to say: nothing to apply, a result that cannot be applied, a refusal, or not applied. */
	| { readonly kind: 'closed'; readonly name: string };

interface SyncDialogProps {
	/**
	 * The operation to run. A new object runs it (again); `null` while no dialog is open. `nonce`
	 * tells a run from the one before it, for the same operation.
	 */
	readonly request: { readonly operation: SyncFunction; readonly nonce: number } | null;
	/** Called once, when the dialog is closed. */
	readonly onEnd: (end: SyncEnd) => void;
}

/** How many changes a page of the list holds. */
const PAGE = 100;

/**
 * Waits, and stops waiting when the signal says so.
 * @param ms - How long
 * @param signal - To stop waiting
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/**
 * The dialog of a sync (RFC §14.2, "同期"): it runs the operation, shows the log of the script
 * while it runs, and then what the sync found: that nothing is to be done, why it cannot be, or the
 * differences to apply with a button. It is modal, so the table behind it cannot be edited while
 * a sync is going on.
 * @param props - The dialog's props
 * @param props.request - The operation to run
 * @param props.onEnd - Called when the dialog is closed, with how the sync ended
 */
export function SyncDialog({ request, onEnd }: SyncDialogProps) {
	const { t, language } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	const [state, setState] = useState<SyncState | null>(null);
	const [log, setLog] = useState<HeldLog>(NO_LOG);
	const [tab, setTab] = useState<SyncKind | null>(null);
	const [changes, setChanges] = useState<HeldChanges | null>(null);
	const [problem, setProblem] = useState<string | null>(null);
	const [applying, setApplying] = useState(false);
	const [cancelling, setCancelling] = useState(false);
	// Whether the person is asked to confirm the cancel of a sync that is going on: a cancel stops
	// the script, and what an export had written is left as it is.
	const [asking, setAsking] = useState(false);
	// The sync this dialog is running, kept apart from the state so that a handler reads the
	// current one and not the one of the render it was made in.
	const current = useRef<{
		id: string | null;
		controller: AbortController;
		name: string;
		status: string;
		/** Whether the export of this sync has been writing: closing the dialog does not stop that. */
		writing?: boolean;
		operation: SyncFunction;
		nonce: number;
	} | null>(null);
	const ended = useRef(true);
	// Counts the lists of changes asked for: an answer for a list that was left (another tab, another
	// sync) is not used.
	const generation = useRef(0);
	const applyingRef = useRef(false);
	const stateRef = useRef<SyncState | null>(null);
	stateRef.current = state;
	const onEndRef = useRef(onEnd);
	onEndRef.current = onEnd;

	const name = request === null ? '' : operationLabel(request.operation, language);

	/** Says how the sync ended, once. */
	const finish = useCallback((end: SyncEnd) => {
		if (ended.current) {
			return;
		}
		ended.current = true;
		current.current?.controller.abort();
		const element = dialog.current;
		if (element?.open === true) {
			element.close();
		}
		onEndRef.current(end);
	}, []);

	/**
	 * Follows the sync `id` by asking for its state until it has ended (the script ran, or the
	 * export wrote), and says how it ended when that is the end of the dialog.
	 */
	const follow = useCallback(
		async (
			mine: {
				controller: AbortController;
				name: string;
				status: string;
				writing?: boolean;
			},
			id: string,
		) => {
			const followed = await followSync({
				fetchState: (after, signal) => fetchSyncState(id, after, signal),
				// An answer that the sync is not there (or a request that is not one) is not asked again;
				// a server that does not answer, or answers with an error of its own, is.
				isFatal: (error) =>
					error instanceof ApiError && error.status >= 400 && error.status < 500,
				sleep,
				onState: (next, held) => {
					setLog(held);
					setState(next);
					mine.status = next.status;
					if (next.status === 'writing') {
						mine.writing = true;
					}
				},
				signal: mine.controller.signal,
			});
			if (followed.kind === 'lost') {
				setProblem(
					t('sync.lostContact', {
						message:
							followed.error instanceof Error
								? followed.error.message
								: String(followed.error),
					}),
				);
				mine.status = 'lost';
			} else if (followed.kind === 'ended') {
				const { state: last } = followed;
				if (last.status === 'cancelled') {
					finish({
						kind: 'cancelled',
						name: mine.name,
						...(last.phase === 'write' ? { phase: 'write' as const } : {}),
					});
				} else if (last.status === 'applied') {
					finish({
						kind: 'applied',
						name: mine.name,
						count: last.applied?.count ?? 0,
						direction: last.direction,
					});
				}
			}
		},
		[finish, t],
	);

	/** Starts the operation and follows it until it has ended. */
	const begin = useCallback(
		async (operation: SyncFunction, nonce: number) => {
			current.current?.controller.abort();
			const controller = new AbortController();
			const label = operationLabel(operation, language);
			const mine = {
				id: null as string | null,
				controller,
				name: label,
				status: 'running',
				operation,
				nonce,
			};
			current.current = mine;
			ended.current = false;
			setState(null);
			setLog(NO_LOG);
			setTab(null);
			setChanges(null);
			setProblem(null);
			setApplying(false);
			setCancelling(false);
			setAsking(false);
			let id: string;
			try {
				id = await startSync(operation.name);
			} catch (error) {
				if (!controller.signal.aborted) {
					finish({
						kind: 'notStarted',
						name: label,
						message: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			mine.id = id;
			await follow(mine, id);
		},
		[finish, follow, language],
	);

	// A new request runs the operation and opens the dialog.
	useEffect(() => {
		const element = dialog.current;
		if (element === null) {
			return;
		}
		if (request === null) {
			current.current?.controller.abort();
			if (element.open) {
				element.close();
			}
			return;
		}
		if (!element.open) {
			element.showModal();
		}
		void begin(request.operation, request.nonce);
		// `begin` is made for the language of the moment; a change of language does not run it again.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, [request]);

	// The dialog goes with the screen.
	useEffect(
		() => () => {
			current.current?.controller.abort();
		},
		[],
	);

	// The first tab that has a change is shown when the differences are.
	useEffect(() => {
		if (state?.status === 'review' && state.summary !== undefined) {
			setTab((chosen) => chosen ?? firstTab(tabsOf(state.summary!.counts)));
		}
	}, [state]);

	// The changes of the tab shown are read a page at a time.
	useEffect(() => {
		const id = current.current?.id;
		if (state?.status !== 'review' || tab === null || id === null || id === undefined) {
			return;
		}
		const controller = new AbortController();
		generation.current += 1;
		setChanges({ kind: tab, items: [], total: 0, loading: true });
		fetchSyncChanges(id, tab, 0, PAGE, controller.signal).then(
			(answer) => {
				if (!controller.signal.aborted) {
					setChanges({
						kind: tab,
						items: answer.changes,
						total: answer.total,
						loading: false,
					});
				}
			},
			(error: unknown) => {
				if (!controller.signal.aborted) {
					setProblem(
						t('sync.lostContact', {
							message: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			},
		);
		return () => controller.abort();
	}, [state?.status, tab, t]);

	const more = useCallback(() => {
		const id = current.current?.id;
		if (changes === null || changes.loading || id === null || id === undefined) {
			return;
		}
		const held = changes;
		const mine = generation.current;
		setChanges({ ...held, loading: true });
		fetchSyncChanges(id, held.kind, held.items.length, PAGE).then(
			(answer) => {
				if (mine !== generation.current) {
					return;
				}
				setChanges({
					kind: held.kind,
					items: [...held.items, ...answer.changes],
					total: answer.total,
					loading: false,
				});
			},
			(error: unknown) => {
				if (mine !== generation.current) {
					return;
				}
				setChanges({ ...held, loading: false });
				setProblem(
					t('sync.lostContact', {
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			},
		);
	}, [changes, t]);

	const cancel = useCallback(() => {
		const mine = current.current;
		if (mine?.id === null || mine === null || cancelling) {
			return;
		}
		setCancelling(true);
		cancelSync(mine.id).catch((error: unknown) => {
			// The next answer of the server says how the sync stands; the person is told that the
			// cancel did not get through.
			setCancelling(false);
			setProblem(
				t('sync.lostContact', {
					message: error instanceof Error ? error.message : String(error),
				}),
			);
		});
	}, [cancelling, t]);

	const apply = useCallback(async () => {
		const mine = current.current;
		if (mine === null || mine.id === null || applyingRef.current) {
			return;
		}
		applyingRef.current = true;
		setApplying(true);
		try {
			const after = await applySync(mine.id);
			setState(after);
			mine.status = after.status;
			if (after.status === 'applied') {
				finish({
					kind: 'applied',
					name: mine.name,
					count: after.applied?.count ?? 0,
					direction: after.direction,
				});
			} else if (after.status === 'writing') {
				// An export writes in the process of the script: the end is asked for, as the run was.
				await follow(mine, mine.id);
			}
		} catch (error) {
			if (error instanceof ApiError && error.code === 'notReady') {
				// The sync is not waiting any more. The screen stops asking for its state at the
				// confirmation, so a script of an export that died meanwhile is learnt here: the state
				// says why, and it is shown instead of a bare "not ready".
				const now = await fetchSyncState(mine.id, 0).catch(() => null);
				if (now !== null && now.status !== 'review') {
					setState(now);
					mine.status = now.status;
					return;
				}
				setProblem(t('sync.notReady'));
			} else {
				setProblem(
					t('sync.lostContact', {
						message: error instanceof Error ? error.message : String(error),
					}),
				);
			}
		} finally {
			applyingRef.current = false;
			setApplying(false);
		}
	}, [finish, follow, t]);

	/** Closes the dialog by a button: how it ended is what the state says. */
	const close = useCallback(() => {
		const mine = current.current;
		const label = mine?.name ?? name;
		if (
			mine?.id !== null &&
			mine !== null &&
			// A write that `apply` has begun is not stopped by closing, as a write that is going on is not.
			!applyingRef.current &&
			(mine.status === 'running' ||
				mine.status === 'review' ||
				(mine.status === 'lost' && mine.writing !== true))
		) {
			// Closing a dialog whose script still runs (the screen lost the server, or the answer
			// had not come), or whose script of an export waits for the confirmation, must not leave
			// the script running behind it. A write that is going on is not stopped by closing: what
			// is outside would be left half written without the question that a cancel asks.
			cancelSync(mine.id).catch(() => {});
		}
		if (mine?.status === 'failed') {
			finish({
				kind: 'failed',
				name: label,
				message: stateRef.current?.failure?.message ?? '',
			});
		} else {
			finish({ kind: 'closed', name: label });
		}
	}, [finish, name]);
	const status = state?.status ?? 'running';
	// The script runs, or an export writes: what a cancel stops.
	const running = (status === 'running' || status === 'writing') && problem === null;
	// Asked only while there is something to cancel: a script that ended meanwhile has nothing left.
	const askingCancel = asking && running;

	const commands = useCommands(
		{
			ask: () => setAsking(true),
			keep: () => setAsking(false),
			cancel,
			close,
			apply: () => void apply(),
			again: () => {
				if (request !== null) {
					const nonce = current.current?.nonce ?? request.nonce;
					void begin(request.operation, nonce);
				}
			},
		},
		dialog,
	);

	return (
		<dialog
			ref={commands.ref}
			id={commands.id}
			aria-labelledby={SYNC_TITLE_ID}
			className="dialog sync-dialog"
			onCancel={(event) => {
				// Escape while the script runs asks whether to cancel the sync (a second Escape answers
				// "keep going"): it is not a way to leave a script running behind a closed dialog, and
				// it does not stop one, and what an export wrote, without asking.
				if (running) {
					event.preventDefault();
					if (!cancelling) {
						setAsking((was) => !was);
					}
				}
			}}
			onClose={() => {
				// Closed by the keyboard or by the browser: how it ended is what the state says.
				if (ended.current) {
					return;
				}
				if (applyingRef.current) {
					// What `apply` has begun to write is not left without the answer of the server.
					dialog.current?.showModal();
					return;
				}
				if (running) {
					// A browser can close a modal dialog that a handler of `cancel` refused to close (the
					// second Escape in a row). A sync that is going on is not stopped without the
					// question: the dialog is shown again, with the question.
					dialog.current?.showModal();
					setAsking(true);
					return;
				}
				close();
			}}>
			{request !== null && (
				<div className="sync-shell">
					<SyncView
						name={name}
						state={state}
						log={log}
						tab={tab}
						changes={changes}
						problem={problem}
						t={t}
						onTab={setTab}
						onMore={more}
					/>
					{askingCancel && (
						<p role="alert" className="sync-warning">
							{status === 'writing' ? t('sync.cancelAskWriting') : t('sync.cancelAsk')}
						</p>
					)}
					<div className="actions">
						{running && !askingCancel && (
							<button type="button" ref={focusOnMount} {...commands.run('ask')}>
								{t('sync.cancel')}
							</button>
						)}
						{askingCancel && (
							<>
								{/* The focus starts on keeping the sync: a cancel is not one keystroke away. */}
								<button
									type="button"
									ref={focusOnMount}
									disabled={cancelling}
									{...commands.run('keep')}>
									{t('sync.cancelKeep')}
								</button>
								<button type="button" disabled={cancelling} {...commands.run('cancel')}>
									{cancelling ? t('sync.cancelling') : t('sync.cancelYes')}
								</button>
							</>
						)}
						{!running && status === 'review' && problem === null && (
							<>
								{/* The focus starts here: what is applied removes and moves files. */}
								<button
									type="button"
									ref={focusOnMount}
									disabled={applying}
									{...commands.run('close')}>
									{t('dialog.cancel')}
								</button>
								<button
									type="button"
									className="primary"
									disabled={applying}
									{...commands.run('apply')}>
									{state?.direction === 'export' ? t('sync.export') : t('sync.apply')}
								</button>
							</>
						)}
						{!running && !(status === 'review' && problem === null) && (
							<>
								<button type="button" ref={focusOnMount} {...commands.run('close')}>
									{t('sync.close')}
								</button>
								{(status === 'failed' ||
									status === 'invalid' ||
									status === 'conflict' ||
									status === 'refused' ||
									problem !== null) &&
									request !== null && (
										<button type="button" {...commands.run('again')}>
											{t('sync.again')}
										</button>
									)}
							</>
						)}
					</div>
				</div>
			)}
		</dialog>
	);
}
