import { useEffect, useRef } from 'react';

import { useI18n } from './i18n/context.js';
import { useCommands } from './use-commands.js';

/** The `id` of the title that names the dialog. */
const TITLE_ID = 'revert-title';

/** What the dialog asks about: the cell that is to be put back as HEAD has it. */
export interface RevertRequest {
	/** The page, by its URL. */
	readonly url: string;
	/** The name of the column. */
	readonly name: string;
	/** What the cell holds now, as it is written for a person. */
	readonly now: string;
	/** What HEAD holds, as it is written for a person. */
	readonly headValue: string;
	/** The files putting it back writes, by their names; `null` when they are not known. */
	readonly where: string | null;
}

interface RevertDialogProps {
	/** What is asked; `null` while no dialog is open. */
	readonly request: RevertRequest | null;
	/** Called when "Put back" is chosen. */
	readonly onConfirm: () => void;
	/** Called when the dialog closes without it (Cancel, or Escape). */
	readonly onCancel: () => void;
}

/**
 * The dialog that asks before a value is put back as HEAD has it: what it holds now and what HEAD
 * holds, and the file it is written in. Putting back is not undone by anything (what was there
 * is in no commit), so it is asked, and the focus is on Cancel.
 * @param props - The dialog's props
 * @param props.request - What is asked, or `null`
 * @param props.onConfirm - Called when "Put back" is chosen
 * @param props.onCancel - Called when the dialog closes without it
 */
export function RevertDialog({ request, onConfirm, onCancel }: RevertDialogProps) {
	const { t } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	// Set when the dialog is closed by the choice, so that the `close` event it fires is not a Cancel.
	const chosen = useRef(false);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) {
			return;
		}
		if (request !== null && !element.open) {
			chosen.current = false;
			element.showModal();
		} else if (request === null && element.open) {
			element.close();
		}
	}, [request]);

	const commands = useCommands(
		{
			confirm: () => {
				chosen.current = true;
				dialog.current?.close();
				onConfirm();
			},
		},
		dialog,
	);

	return (
		<dialog
			ref={commands.ref}
			id={commands.id}
			aria-labelledby={TITLE_ID}
			className="dialog"
			onClose={() => {
				if (!chosen.current) {
					onCancel();
				}
			}}>
			{request !== null && (
				<form
					method="dialog"
					onSubmit={(event) => {
						event.preventDefault();
					}}>
					<h2 id={TITLE_ID}>{t('revert.title')}</h2>
					<p>{t('revert.what', { name: request.name, url: request.url })}</p>
					<dl className="revert-values">
						<dt>{t('revert.now')}</dt>
						<dd>
							<code>{request.now}</code>
						</dd>
						<dt>{t('revert.head')}</dt>
						<dd>
							<code>{request.headValue}</code>
						</dd>
					</dl>
					{request.where !== null && <p>{t('revert.where', { where: request.where })}</p>}
					<div className="actions">
						{/* The focus starts here: putting back loses what is there now. */}
						<button type="button" autoFocus {...commands.builtin('close')}>
							{t('dialog.cancel')}
						</button>
						<button type="button" {...commands.run('confirm')}>
							{t('revert.confirm')}
						</button>
					</div>
				</form>
			)}
		</dialog>
	);
}
