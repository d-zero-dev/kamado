import type { Translate } from './i18n/translate.js';
import type { HeldLog, SyncTab } from './logic/sync.js';
import type { SyncChange, SyncKind, SyncState } from './types.js';

import { hiddenLines, tabsOf } from './logic/sync.js';
import { useCommands, type Commands } from './use-commands.js';

/** The `id` of the title that names the dialog of the sync: the dialog names it in `aria-labelledby`. */
export const SYNC_TITLE_ID = 'sync-title';

/** The `id` of the title that names the section of the log. */
const LOG_TITLE_ID = 'sync-log-title';

/** The `id` of the panel that the tabs control. */
const PANEL_ID = 'sync-panel';

/** The changes of one kind that the screen holds, and how many there are. */
export interface HeldChanges {
	readonly kind: SyncKind;
	readonly items: readonly SyncChange[];
	readonly total: number;
	/** A page of them is being read. */
	readonly loading: boolean;
}

interface SyncViewProps {
	/** The name of the operation, as the screen shows it. */
	readonly name: string;
	/** `null` before the server has said anything. */
	readonly state: SyncState | null;
	readonly log: HeldLog;
	readonly tab: SyncKind | null;
	readonly changes: HeldChanges | null;
	/** A message of the screen itself (the server could not be reached). */
	readonly problem: string | null;
	readonly t: Translate;
	readonly onTab: (kind: SyncKind) => void;
	readonly onMore: () => void;
}

/**
 * One line of what a sync changes.
 * @param props - The change
 * @param props.change - A change, as the server tells it
 * @param props.t - Says a message
 */
export function ChangeLine({ change, t }: { change: SyncChange; t: Translate }) {
	switch (change.kind) {
		case 'added': {
			return (
				<>
					<code>{change.url}</code>
					<span className="tag">
						{change.virtual
							? t('sync.virtual')
							: change.inputPath === null
								? t('sync.fileAtUrl')
								: change.inputPath}
					</span>
					{change.keys > 0 && (
						<span className="tag">{t('sync.keys', { count: change.keys })}</span>
					)}
				</>
			);
		}
		case 'deleted': {
			return (
				<>
					<code>{change.url}</code>
					{change.inputPath !== null && <span className="tag">{change.inputPath}</span>}
				</>
			);
		}
		case 'movedUrl': {
			return (
				<>
					<code>{change.from}</code>
					<span aria-hidden="true"> → </span>
					<code>{change.to}</code>
				</>
			);
		}
		case 'movedFile': {
			return (
				<>
					<code>{change.url}</code>
					<span className="tag">{change.from ?? t('sync.virtual')}</span>
					<span aria-hidden="true"> → </span>
					<span className="tag">{change.to}</span>
				</>
			);
		}
		case 'virtualized': {
			return (
				<>
					<code>{change.url}</code>
					<span className="tag">{change.inputPath}</span>
					<span aria-hidden="true"> → </span>
					<span className="tag">{t('sync.virtual')}</span>
				</>
			);
		}
		case 'materialized': {
			return (
				<>
					<code>{change.url}</code>
					<span className="tag">{t('sync.virtual')}</span>
					<span aria-hidden="true"> → </span>
					<span className="tag">{change.inputPath ?? t('sync.fileAtUrl')}</span>
				</>
			);
		}
		case 'meta': {
			return (
				<>
					<code>{change.url}</code> <strong>{change.key}</strong>
					<span className="values">
						{change.before === undefined ? (
							<span className="tag">{t('sync.valueNone')}</span>
						) : (
							<del>{change.before}</del>
						)}
						<span aria-hidden="true"> → </span>
						{change.after === undefined ? (
							<span className="tag">{t('sync.valueRemoved')}</span>
						) : (
							<ins>{change.after}</ins>
						)}
					</span>
				</>
			);
		}
	}
}

/**
 * The tabs of the kinds of difference, with the number of each.
 * @param props - The tabs
 * @param props.tabs - The tabs
 * @param props.tab - The tab that is shown
 * @param props.t - Says a message
 * @param props.run - Gives the attributes of a button that sends a command to the element that handles them
 */
function Tabs({
	tabs,
	tab,
	t,
	run,
}: {
	tabs: readonly SyncTab[];
	tab: SyncKind | null;
	t: Translate;
	run: Commands<HTMLElement, 'tab'>['run'];
}) {
	return (
		<div role="tablist" aria-label={t('sync.kinds')} className="sync-tabs">
			{tabs.map((entry) => (
				<button
					key={entry.kind}
					type="button"
					role="tab"
					id={`sync-tab-${entry.kind}`}
					aria-selected={entry.kind === tab}
					aria-controls={PANEL_ID}
					disabled={entry.disabled}
					data-kind={entry.kind}
					{...run('tab')}>
					<span className="count">{entry.count.toLocaleString('en-US')}</span>
					<span>{t(`sync.kind.${entry.kind}`)}</span>
				</button>
			))}
		</div>
	);
}

/**
 * What the dialog of a sync shows for the state the sync is in. It holds nothing and does
 * nothing by itself: the dialog around it asks, polls and applies. Every text of the script, the
 * files or the core is drawn as text (never as markup, and never as a link).
 * @param props - What is shown
 * @param props.name - The name of the operation
 * @param props.state - How the sync stands
 * @param props.log - The log held
 * @param props.tab - The tab that is shown
 * @param props.changes - The changes of that tab
 * @param props.problem - A message of the screen
 * @param props.t - Says a message
 * @param props.onTab - Called when a tab is chosen
 * @param props.onMore - Called when more changes are asked for
 */
export function SyncView({
	name,
	state,
	log,
	tab,
	changes,
	problem,
	t,
	onTab,
	onMore,
}: SyncViewProps) {
	// The tabs and the button that reads more are in the body of the review: it is where they send
	// their commands.
	const commands = useCommands({
		tab: (button) => onTab(button.dataset.kind as SyncKind),
		more: onMore,
	});
	const status = state?.status ?? 'running';
	const live = status === 'running' || status === 'writing';
	const exporting = state?.direction === 'export';
	const hidden = hiddenLines(log);
	const logBox = (
		<section aria-labelledby={LOG_TITLE_ID} className="sync-section">
			<h3 id={LOG_TITLE_ID}>{t('sync.log')}</h3>
			{hidden > 0 && <p className="hint">{t('sync.logHidden', { count: hidden })}</p>}
			{log.lines.length === 0 ? (
				<p className="hint">{live ? t('sync.logEmpty') : ''}</p>
			) : (
				<ol className="sync-log" aria-live={live ? 'polite' : 'off'}>
					{log.lines.map((line, i) => (
						<li key={`${log.next - log.lines.length + i}`} className={`log-${line.type}`}>
							<span className="log-type">{line.type}</span> {line.message}
						</li>
					))}
				</ol>
			)}
		</section>
	);

	if (problem !== null) {
		return (
			<>
				<h2 id={SYNC_TITLE_ID}>{name}</h2>
				<div className="sync-body">
					<p role="alert" className="sync-failure">
						{problem}
					</p>
					{logBox}
				</div>
			</>
		);
	}

	switch (status) {
		case 'writing': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.writing', { name })}</h2>
					<div className="sync-body">
						<p role="status" className="sync-running">
							<span className="spinner" aria-hidden="true" />
						</p>
						{logBox}
					</div>
				</>
			);
		}
		case 'running':
		case 'cancelled': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.running', { name })}</h2>
					<div className="sync-body">
						<p role="status" className="sync-running">
							<span className="spinner" aria-hidden="true" />
						</p>
						{logBox}
					</div>
				</>
			);
		}
		case 'failed': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.failedTitle')}</h2>
					<div className="sync-body">
						<p className="sync-op">{name}</p>
						<div role="alert" className="sync-failure">
							<p>{state?.failure?.message}</p>
							{state?.failure?.stack !== null && state?.failure?.stack !== undefined && (
								<details>
									<summary>{t('sync.stack')}</summary>
									<pre>{state.failure.stack}</pre>
								</details>
							)}
						</div>
						<p>
							{state?.phase === 'write'
								? t('sync.failedBodyWrite')
								: t(exporting ? 'sync.failedBodyExport' : 'sync.failedBody')}
						</p>
						{logBox}
					</div>
				</>
			);
		}
		case 'nochange': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.nochangeTitle')}</h2>
					<div className="sync-body">
						<p className="sync-op">{name}</p>
						<p className="sync-ok">
							<span className="check" aria-hidden="true">
								✓
							</span>
							{exporting ? t('sync.nochangeBodyExport') : t('sync.nochangeBody')}
						</p>
						{log.lines.length > 0 && logBox}
					</div>
				</>
			);
		}
		case 'invalid': {
			const problems = state?.problems;
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.invalidTitle')}</h2>
					<div className="sync-body">
						<p className="sync-op">{name}</p>
						<p>{t(exporting ? 'sync.invalidBodyExport' : 'sync.invalidBody')}</p>
						<div role="alert">
							<ul className="sync-problems">
								{problems?.listed.map((text, i) => (
									<li key={i}>{text}</li>
								))}
							</ul>
						</div>
						{problems !== undefined && problems.total > problems.listed.length && (
							<p className="hint">
								{t('sync.problemsMore', {
									count: problems.total - problems.listed.length,
								})}
							</p>
						)}
						{log.lines.length > 0 && logBox}
					</div>
				</>
			);
		}
		case 'conflict': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.conflictTitle')}</h2>
					<div className="sync-body">
						<p className="sync-op">{name}</p>
						<p role="alert">
							{t(exporting ? 'sync.conflictBodyExport' : 'sync.conflictBody')}
						</p>
						<Failures state={state} t={t} />
					</div>
				</>
			);
		}
		case 'refused': {
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.refusedTitle')}</h2>
					<div className="sync-body">
						<p className="sync-op">{name}</p>
						<p role="alert">{state?.refused?.message}</p>
						<p>{t(exporting ? 'sync.refusedBodyExport' : 'sync.refusedBody')}</p>
						<Failures state={state} t={t} />
					</div>
				</>
			);
		}
		case 'applied': {
			return <h2 id={SYNC_TITLE_ID}>{name}</h2>;
		}
		case 'review': {
			const summary = state?.summary;
			if (summary === undefined) {
				return <h2 id={SYNC_TITLE_ID}>{name}</h2>;
			}
			if (exporting && state?.diffed === false) {
				// The script has no `read`: nothing was compared, so there is no list to show.
				return (
					<>
						<h2 id={SYNC_TITLE_ID}>{t('sync.reviewTitleNoDiff')}</h2>
						<div className="sync-body">
							<p className="sync-op">{name}</p>
							<p>{t('sync.reviewBodyNoDiff', { count: state.targets ?? 0 })}</p>
							{log.lines.length > 0 && logBox}
						</div>
					</>
				);
			}
			const tabs = tabsOf(summary.counts);
			return (
				<>
					<h2 id={SYNC_TITLE_ID}>{t('sync.reviewTitle', { count: summary.total })}</h2>
					<div ref={commands.ref} id={commands.id} className="sync-body">
						<p className="sync-op">{name}</p>
						<p>{exporting ? t('sync.reviewBodyExport') : t('sync.reviewBody')}</p>
						{summary.gitUnavailable ? (
							<p role="alert" className="sync-warning">
								{t('sync.gitUnavailable')}
							</p>
						) : (
							summary.unsaved.total > 0 && (
								<div role="alert" className="sync-warning">
									<p>{t('sync.unsaved', { count: summary.unsaved.total })}</p>
									<ul>
										{summary.unsaved.listed.map((file) => (
											<li key={file}>
												<code>{file}</code>
											</li>
										))}
									</ul>
									{summary.unsaved.total > summary.unsaved.listed.length && (
										<p>
											{t('sync.unsavedMore', {
												count: summary.unsaved.total - summary.unsaved.listed.length,
											})}
										</p>
									)}
								</div>
							)
						)}
						<Tabs tabs={tabs} tab={tab} t={t} run={commands.run} />
						<div
							role="tabpanel"
							id={PANEL_ID}
							aria-label={t('sync.changes')}
							aria-labelledby={tab === null ? undefined : `sync-tab-${tab}`}
							className="sync-panel">
							{changes !== null && (
								<>
									<ul className="sync-changes">
										{changes.items.map((change, i) => (
											<li key={i}>
												<ChangeLine change={change} t={t} />
											</li>
										))}
									</ul>
									{changes.items.length < changes.total && (
										<button
											type="button"
											className="more"
											disabled={changes.loading}
											{...commands.run('more')}>
											{t('sync.more')} ({changes.items.length.toLocaleString('en-US')} /{' '}
											{changes.total.toLocaleString('en-US')})
										</button>
									)}
								</>
							)}
						</div>
					</div>
				</>
			);
		}
	}
}

/**
 * The edits the core refused, one on a line.
 * @param props - The state
 * @param props.state - How the sync stands
 * @param props.t - Says a message
 */
function Failures({ state, t }: { state: SyncState | null; t: Translate }) {
	const failures = state?.refused?.failures;
	if (failures === undefined || failures.listed.length === 0) {
		return null;
	}
	return (
		<>
			<ul className="sync-problems">
				{failures.listed.map((failure, i) => (
					<li key={i}>
						{failure.url !== null && <code>{failure.url}</code>}
						{failure.op !== null && <span className="tag">{failure.op}</span>}{' '}
						{failure.message}
					</li>
				))}
			</ul>
			{failures.total > failures.listed.length && (
				<p className="hint">
					{t('sync.failuresMore', { count: failures.total - failures.listed.length })}
				</p>
			)}
		</>
	);
}
