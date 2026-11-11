import type { DiffKind, GitInfo } from './types.js';

import { useI18n } from './i18n/context.js';
import { gitLabel } from './logic/git-label.js';

interface LegendProps {
	/** The `pages.overrides` file as the server names it; `null` or absent when the site has none. */
	readonly overridesFile: string | null | undefined;
	/** The branch and the commit; the marks of HEAD are explained only when there are some. */
	readonly git: GitInfo | null;
	/** Whether the differences from HEAD were read (there is a commit to compare with). */
	readonly compared: boolean;
}

const KINDS: readonly DiffKind[] = ['modified', 'added', 'deleted'];

/**
 * The line under the table (in the footer of the screen) that says what the small labels under
 * the values and the bars at the left edge of the cells mean. It is a paragraph, so that a screen
 * reader reads it as a sentence, and it has no button to close it: it is always there. Why not
 * above the table: a line of it comes and goes with what is known of HEAD, and under the table
 * that does not move the rows.
 * @param props - What the screen knows
 * @param props.overridesFile - The `pages.overrides` file, or `null`
 * @param props.git - The branch and the commit, or `null`
 * @param props.compared - Whether the differences from HEAD were read
 */
export function Legend({ overridesFile, git, compared }: LegendProps) {
	const { t } = useI18n();
	return (
		<p className="legend">
			<span>{t('legend.where')}</span>
			<span>{t('legend.inFile')}</span>
			<span>{t('legend.sidecar')}</span>
			{overridesFile !== null && overridesFile !== undefined && (
				<span>{t('legend.overrides', { file: overridesFile })}</span>
			)}
			{compared && (
				<span className="legend-kinds">
					<span>{t('legend.head', { git: git === null ? 'HEAD' : gitLabel(git) })}</span>
					{KINDS.map((kind) => (
						<span key={kind}>
							{/* The sample has the class of the bar of a cell: it looks as the bar does. */}
							<span aria-hidden="true" className="legend-sample">
								<span className="diff-mark" data-kind={kind} />
							</span>
							{t(`legend.${kind}` as const)}
						</span>
					))}
					<span>{t('legend.revert')}</span>
				</span>
			)}
		</p>
	);
}
