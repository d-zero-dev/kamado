import type { PageChoice, PageQuestion } from './logic/page-questions.js';

import { useEffect, useRef } from 'react';

import { useI18n } from './i18n/context.js';
import { holdsVirtualPages } from './logic/page-questions.js';
import { useCommands } from './use-commands.js';

interface PageDialogProps {
	/** What is asked; `null` while no dialog is open. */
	readonly question: PageQuestion | null;
	/** The `pages.overrides` file as the server names it; `null` when the site has none. */
	readonly overridesFile: string | null;
	/** Called with the choice when a button other than Cancel is pressed. */
	readonly onChoose: (choice: PageChoice) => void;
	/** Called when the dialog closes without a choice (Cancel, or Escape). */
	readonly onCancel: () => void;
}

/**
 * The dialog that asks before a page is added as a virtual one, made virtual, or deleted.
 * Deleting a file is not undone by anything the screen has (what the file held may be in no
 * commit), so the files that go are named, with the fact that the body of the page goes with
 * them, and the focus starts on Cancel. Adding a virtual page deletes nothing: the focus starts
 * on the button that adds it.
 * @param props - The dialog's props
 * @param props.question - What is asked, or `null`
 * @param props.overridesFile - The `pages.overrides` file, or `null`
 * @param props.onChoose - Called with the choice
 * @param props.onCancel - Called when the dialog closes without a choice
 * @example
 * ```tsx
 * <PageDialog
 * 	question={{ kind: 'addVirtual', url: '/service/' }}
 * 	overridesFile="pages.overrides.json"
 * 	onChoose={(choice) => console.log(choice)}
 * 	onCancel={() => console.log('cancelled')}
 * />
 * ```
 */
export function PageDialog({
	question,
	overridesFile,
	onChoose,
	onCancel,
}: PageDialogProps) {
	const { t } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	// Set when the dialog is closed by a choice, so that the `close` event it fires is not a Cancel.
	const chosen = useRef(false);
	const cancelButton = useRef<HTMLButtonElement>(null);
	const addButton = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) {
			return;
		}
		if (question !== null && !element.open) {
			chosen.current = false;
			element.showModal();
			// Where the focus starts is said here, not left to the order of the buttons: on
			// Cancel when something would be deleted, and on the button that adds when a virtual
			// page is added (that deletes nothing, and the person has just asked for the page:
			// Enter goes on).
			(addButton.current ?? cancelButton.current)?.focus();
		} else if (question === null && element.open) {
			element.close();
		}
	}, [question]);

	const choose = (choice: PageChoice) => {
		chosen.current = true;
		dialog.current?.close();
		onChoose(choice);
	};
	const file = overridesFile ?? 'pages.overrides';

	const commands = useCommands(
		{
			add: () => choose('add'),
			virtualize: () => choose('virtualize'),
			delete: () => choose('delete'),
		},
		dialog,
	);

	return (
		<dialog
			ref={commands.ref}
			id={commands.id}
			aria-labelledby="page-dialog-title"
			className="dialog wordy"
			onClose={() => {
				if (!chosen.current) {
					onCancel();
				}
			}}>
			{question !== null && (
				<form
					method="dialog"
					onSubmit={(event) => {
						event.preventDefault();
					}}>
					<h2 id="page-dialog-title">
						{t(`pageDialog.${question.kind}.title` as const, { url: question.url })}
					</h2>
					<p>
						{question.kind === 'emptyPath' && !holdsVirtualPages(overridesFile)
							? t('pageDialog.emptyPath.whatNoOverrides')
							: question.kind === 'delete'
								? t(
										question.virtual
											? 'pageDialog.delete.whatVirtual'
											: 'pageDialog.delete.what',
										{ file },
									)
								: t(`pageDialog.${question.kind}.what` as const, { file })}
					</p>
					{question.kind !== 'addVirtual' && question.files.length > 0 && (
						<p className="dialog-warning">
							{t('pageDialog.files', { files: question.files.join(', ') })}
						</p>
					)}
					<div className="actions">
						<button ref={cancelButton} type="button" {...commands.builtin('close')}>
							{t('dialog.cancel')}
						</button>
						{question.kind === 'addVirtual' && (
							<button ref={addButton} type="button" {...commands.run('add')}>
								{t('pageDialog.addVirtual.confirm')}
							</button>
						)}
						{(question.kind === 'emptyPath' || question.kind === 'virtualize') && (
							<button
								type="button"
								disabled={!holdsVirtualPages(overridesFile)}
								{...commands.run('virtualize')}>
								{t('pageDialog.virtualize')}
							</button>
						)}
						{(question.kind === 'emptyPath' || question.kind === 'delete') && (
							<button type="button" className="danger" {...commands.run('delete')}>
								{t('pageDialog.delete')}
							</button>
						)}
					</div>
				</form>
			)}
		</dialog>
	);
}
