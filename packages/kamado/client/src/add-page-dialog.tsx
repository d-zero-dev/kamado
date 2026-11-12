import { useState } from 'react';

import { useI18n } from './i18n/context.js';
import { builtinCommand } from './logic/commands.js';
import { newPageOf } from './logic/page-edits.js';

/** The `id` of the dialog: the button of the bar that opens it names it in `commandfor`. */
export const ADD_PAGE_DIALOG_ID = 'add-page-dialog';

interface AddPageProps {
	readonly dialogRef: React.RefObject<HTMLDialogElement | null>;
	/**
	 * Called with what the form asks for when it is sent: the URL (`null` for the URL the place
	 * of the file gives) and the path of the page file (`null` for a virtual page).
	 */
	readonly onAdd: (url: string | null, path: string | null) => void;
}

/**
 * The dialog that adds a page: its URL and the path of its file. Either can be left empty,
 * not both: the place of a file gives a URL, and a URL without a file is a virtual page (which
 * the screen asks about before it is added).
 * @param props - The ref of the `<dialog>`, which the button of the bar opens, and what is
 * done with the URL and the path that were typed
 * @param props.dialogRef - The ref of the `<dialog>`
 * @param props.onAdd - Called with the URL and the path when the form is sent
 * @example
 * ```tsx
 * const dialogRef = useRef<HTMLDialogElement>(null);
 * <AddPageDialog dialogRef={dialogRef} onAdd={(url, path) => console.log(url, path)} />;
 * dialogRef.current?.showModal();
 * ```
 */
export function AddPageDialog({ dialogRef, onAdd }: AddPageProps) {
	const { t } = useI18n();
	const [url, setUrl] = useState('');
	const [path, setPath] = useState('');
	const [problem, setProblem] = useState('');
	return (
		<dialog
			ref={dialogRef}
			id={ADD_PAGE_DIALOG_ID}
			aria-labelledby="add-page-title"
			className="dialog wordy"
			onClose={() => setProblem('')}>
			<form
				method="dialog"
				onSubmit={(event) => {
					event.preventDefault();
					const page = newPageOf(url, path);
					if (!page.ok) {
						setProblem(t('addPage.empty'));
						return;
					}
					// What was typed stays: a page that is refused (a file is in the way, the URL is
					// not the one of the place) is asked for again by opening the form and changing a
					// part. The screen gives the form a new `key` once the page is made, which
					// empties it.
					dialogRef.current?.close();
					onAdd(page.url, page.path);
				}}>
				<h2 id="add-page-title">{t('app.addPage')}</h2>
				<label>
					{t('addPage.url')}
					<input
						autoFocus
						value={url}
						placeholder="/about/"
						onChange={(event) => setUrl(event.target.value)}
					/>
				</label>
				<label>
					{t('addPage.path')}
					<input
						value={path}
						placeholder="about/index.html"
						aria-describedby="add-page-hint"
						onChange={(event) => setPath(event.target.value)}
					/>
				</label>
				<p id="add-page-hint" className="dialog-hint">
					{t('addPage.hint')}
				</p>
				<p role="alert" className="problem">
					{problem}
				</p>
				<div className="actions">
					<button type="button" {...builtinCommand(ADD_PAGE_DIALOG_ID, 'close')}>
						{t('dialog.cancel')}
					</button>
					<button type="submit">{t('dialog.add')}</button>
				</div>
			</form>
		</dialog>
	);
}
