import type { EnumOption, KindsSettings } from './logic/kinds.js';

import { useEffect, useRef, useState } from 'react';

import { fetchValues } from './api.js';
import { useI18n } from './i18n/context.js';
import {
	MAX_ENUM_OPTION_LENGTH,
	MAX_ENUM_OPTIONS,
	optionKey,
	optionOf,
	mergeOptions,
	optionsProblem,
} from './logic/kinds.js';
import { useCommands } from './use-commands.js';

/** The `id` of the title that names the dialog. */
const TITLE_ID = 'options-title';

interface OptionsDialogProps {
	/** The identifier of the column (`meta:<key>`). */
	readonly column: string;
	/** The name the column is shown by (its label when the config gives one, see `columnHeading`). */
	readonly name: string;
	/**
	 * The options the column has, or `null` when it is not an enum yet: the options are then made
	 * from the values the pages hold under the key.
	 */
	readonly initial: readonly EnumOption[] | null;
	/** The kinds of all the columns now, to count the bytes the options of the others take. */
	readonly kinds: KindsSettings;
	/** Called with the options when they are saved. */
	readonly onSave: (options: EnumOption[]) => void;
	/** Called when the dialog has closed, saved or not. */
	readonly onClose: () => void;
}

type NewKind = 'text' | 'number' | 'boolean';
const NEW_KINDS: readonly NewKind[] = ['text', 'number', 'boolean'];

/**
 * The name of the kind of an option, as the dialog names the kind of a new one.
 * @param option - An option
 */
function kindNameOf(option: EnumOption): NewKind {
	return typeof option === 'string'
		? 'text'
		: typeof option === 'number'
			? 'number'
			: 'boolean';
}

/**
 * The dialog that sets the options of a column that is a choice: the list of options (take one
 * away, add one of a kind and a text), and the values the pages hold, which are the options a
 * column starts with. It is opened for the column when it is made an enum, and again to edit them.
 * @param props - The dialog's props
 * @param props.column - The identifier of the column
 * @param props.name - The name the column is shown by
 * @param props.initial - The options now, or `null` for a column that is not an enum yet
 * @param props.kinds - The kinds of all the columns now
 * @param props.onSave - Called with the options when they are saved
 * @param props.onClose - Called when the dialog has closed
 */
export function OptionsDialog({
	column,
	name,
	initial,
	kinds,
	onSave,
	onClose,
}: OptionsDialogProps) {
	const { t } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	const [options, setOptions] = useState<EnumOption[]>(() => [...(initial ?? [])]);
	const [loading, setLoading] = useState(initial === null);
	const [loadFailed, setLoadFailed] = useState('');
	const [more, setMore] = useState<{ total: number; shown: number } | null>(null);
	const [text, setText] = useState('');
	const [kind, setKind] = useState<NewKind>('text');
	const [problem, setProblem] = useState('');
	// Whether the values of the pages are being added to the options (not the first read).
	const [adding, setAdding] = useState(false);

	useEffect(() => {
		dialog.current?.showModal();
	}, []);

	/**
	 * Reads the values the pages hold under the key, and puts them with the options.
	 * @param signal - To drop the answer when the dialog is gone
	 * @param keep - What the options are before the values are added
	 */
	const readValues = async (signal: AbortSignal, keep: readonly EnumOption[]) => {
		try {
			const answer = await fetchValues(column, MAX_ENUM_OPTIONS, signal);
			if (signal.aborted) {
				return;
			}
			const merged = mergeOptions(keep, answer.values, answer.total);
			setOptions(merged.options);
			setMore(merged.more);
			setLoadFailed('');
		} catch (error) {
			if (!signal.aborted) {
				setLoadFailed(error instanceof Error ? error.message : String(error));
			}
		} finally {
			if (!signal.aborted) {
				setLoading(false);
				setAdding(false);
			}
		}
	};

	// The read that is under way: dropped when another begins and when the dialog is gone.
	const reading = useRef<AbortController | null>(null);
	/**
	 * Begins a read of the values, dropping the one that was under way.
	 * @param keep - What the options are before the values are added
	 */
	const readNow = (keep: readonly EnumOption[]) => {
		reading.current?.abort();
		const controller = new AbortController();
		reading.current = controller;
		void readValues(controller.signal, keep);
	};

	useEffect(() => {
		if (initial === null) {
			readNow([]);
		}
		return () => reading.current?.abort();
		// Read once, when the dialog opens for a column that is not an enum yet.
		// oxlint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const addTyped = () => {
		const made = optionOf(text, kind);
		if (!made.ok) {
			setProblem(t(`options.problem.${made.reason}` as const));
			return;
		}
		if (options.some((option) => optionKey(option) === optionKey(made.value))) {
			setProblem(t('options.problem.duplicate'));
			return;
		}
		const next = [...options, made.value];
		const why = optionsProblem(next, column, kinds);
		if (why !== null) {
			setProblem(
				t(`options.problem.${why}` as const, {
					max: why === 'tooLong' ? MAX_ENUM_OPTION_LENGTH : MAX_ENUM_OPTIONS,
				}),
			);
			return;
		}
		setOptions(next);
		setText('');
		setProblem('');
	};

	const save = () => {
		const why = optionsProblem(options, column, kinds);
		if (why !== null) {
			setProblem(
				t(`options.problem.${why}` as const, {
					max: why === 'tooLong' ? MAX_ENUM_OPTION_LENGTH : MAX_ENUM_OPTIONS,
				}),
			);
			return;
		}
		onSave(options);
		dialog.current?.close();
	};

	const commands = useCommands(
		{
			remove: (source) =>
				setOptions(options.filter((o) => optionKey(o) !== source.dataset.option)),
			add: addTyped,
			fromPages: () => {
				setAdding(true);
				readNow(options);
			},
		},
		dialog,
	);

	return (
		<dialog
			ref={commands.ref}
			id={commands.id}
			aria-labelledby={TITLE_ID}
			className="dialog options-dialog"
			onClose={onClose}>
			<form
				method="dialog"
				onSubmit={(event) => {
					event.preventDefault();
					save();
				}}>
				<h2 id={TITLE_ID}>{t('options.title', { name })}</h2>
				{loading ? (
					<p role="status">{t('options.loading')}</p>
				) : (
					<>
						{loadFailed !== '' && (
							<p role="alert" className="problem">
								{t('options.loadFailed', { message: loadFailed })}
							</p>
						)}
						{more !== null && <p className="muted">{t('options.more', more)}</p>}
						{options.length === 0 ? (
							<p className="muted">{t('options.none')}</p>
						) : (
							<ul aria-label={t('options.list')} className="options">
								{options.map((option) => (
									<li key={optionKey(option)}>
										<span className="option-kind" aria-hidden="true">
											{t(`kind.${kindNameOf(option)}` as const)}
										</span>
										<span className="option-text">{String(option)}</span>
										<button
											type="button"
											aria-label={t('options.remove', { option: String(option) })}
											data-option={optionKey(option)}
											{...commands.run('remove')}>
											<span>✕</span>
										</button>
									</li>
								))}
							</ul>
						)}
						<div className="new-option">
							<input
								autoFocus
								aria-label={t('options.newLabel')}
								value={text}
								onChange={(event) => {
									setText(event.target.value);
									setProblem('');
								}}
								onKeyDown={(event) => {
									// Enter adds the option; it is not the save of the dialog.
									if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
										event.preventDefault();
										addTyped();
									}
								}}
							/>
							<select
								aria-label={t('options.newType')}
								value={kind}
								onChange={(event) => setKind(event.target.value as NewKind)}>
								{NEW_KINDS.map((k) => (
									<option key={k} value={k}>
										{t(`kind.${k}` as const)}
									</option>
								))}
							</select>
							<button type="button" {...commands.run('add')}>
								{t('dialog.add')}
							</button>
						</div>
						{initial !== null && (
							<button type="button" disabled={adding} {...commands.run('fromPages')}>
								{t('options.fromPages')}
							</button>
						)}
					</>
				)}
				{problem !== '' && (
					<p role="alert" className="problem">
						{problem}
					</p>
				)}
				<div className="actions">
					<button type="button" {...commands.builtin('close')}>
						{t('dialog.cancel')}
					</button>
					<button type="submit" disabled={loading}>
						{t('options.save')}
					</button>
				</div>
			</form>
		</dialog>
	);
}
