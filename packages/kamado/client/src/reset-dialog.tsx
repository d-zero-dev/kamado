import { useEffect, useRef } from 'react';

import { useI18n } from './i18n/context.js';

interface ResetDialogProps {
	/** Whether the question is asked. */
	readonly open: boolean;
	/** Called when "Reset" is chosen. */
	readonly onConfirm: () => void;
	/** Called when the dialog closes without it (Cancel, or Escape). */
	readonly onCancel: () => void;
}

/**
 * The dialog that asks before the settings of this project go back to the defaults: it names
 * what goes (the layout of the columns, the order of the rows, the rows per page, the columns
 * that choose among options), says what stays (the pages and the language), and that it is not
 * undone. What is kept is a person's own work (a layout of many columns, the options of a
 * column), which nothing in the project can make again, so it is asked, and the focus starts on
 * Cancel.
 * @param props - The dialog's props
 * @param props.open - Whether the question is asked
 * @param props.onConfirm - Called when "Reset" is chosen
 * @param props.onCancel - Called when the dialog closes without it
 */
export function ResetDialog({ open, onConfirm, onCancel }: ResetDialogProps) {
	const { t } = useI18n();
	const dialog = useRef<HTMLDialogElement>(null);
	// Set when the dialog is closed by the choice, so that the `close` event it fires is not a Cancel.
	const chosen = useRef(false);

	useEffect(() => {
		const element = dialog.current;
		if (element === null) {
			return;
		}
		if (open && !element.open) {
			chosen.current = false;
			element.showModal();
		} else if (!open && element.open) {
			element.close();
		}
	}, [open]);

	return (
		<dialog
			ref={dialog}
			aria-labelledby="reset-title"
			className="dialog"
			onClose={() => {
				if (!chosen.current) {
					onCancel();
				}
			}}>
			{open && (
				<form
					method="dialog"
					onSubmit={(event) => {
						event.preventDefault();
					}}>
					<h2 id="reset-title">{t('reset.title')}</h2>
					<p>{t('reset.what')}</p>
					<ul>
						<li>{t('reset.columns')}</li>
						<li>{t('reset.sort')}</li>
						<li>{t('reset.pageSize')}</li>
						<li>{t('reset.kinds')}</li>
					</ul>
					<p>{t('reset.note')}</p>
					<div className="actions">
						{/* The focus starts here: what is reset is not got back. */}
						<button
							type="button"
							autoFocus
							onClick={() => {
								dialog.current?.close();
							}}>
							{t('dialog.cancel')}
						</button>
						<button
							type="button"
							onClick={() => {
								chosen.current = true;
								dialog.current?.close();
								onConfirm();
							}}>
							{t('reset.confirm')}
						</button>
					</div>
				</form>
			)}
		</dialog>
	);
}
