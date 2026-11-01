/**
 * File-by-file comparison of two build output trees (the v2 vs v3 parity harness).
 *
 * Verdicts per file:
 * - `identical`: byte-equal
 * - `smaller` / `larger`: only for `.css` / `.js` / `.map`. Their minified form
 *   may legitimately differ between implementations, so the size must not
 *   grow instead of the bytes being equal. Every other file is byte-compared.
 * - `different`: anything else that differs
 * - `missing` / `extra`: present in only one tree
 *
 * With `semantic` (checking a migration from v2, where the formatting of the pages is
 * expected to change):
 * - `equivalent`: an `.html` / `.htm` file whose bytes differ but whose markup is the
 *   same after `normalizeHtml`. `differs` lists what was set aside and does differ: the
 *   inline scripts, the inline CSS, or the number of empty `class` attributes. Such a
 *   file is left for a person to check and does not count as ok
 * - a `.css` file that differs also lists the prefixed declarations that only one side
 *   has (`prefixes`), because v3 neither adds nor removes vendor prefixes. One that only
 *   the baseline has (`removed`) may be needed by the target browsers and is left to
 *   check (not ok); one that only the candidate has is a known difference (MIGRATION
 *   §11) and is only listed
 *
 * Without `semantic` the verdicts and `ok` are the byte comparison above, which is what
 * the development of v3 checks parity with.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { prefixDifference } from './css-declarations.ts';
import { normalizeHtml, type NormalizedHtml } from './html-normalize.ts';

export type Verdict =
	'identical' | 'equivalent' | 'smaller' | 'larger' | 'different' | 'missing' | 'extra';

/**
 * What an `equivalent` page sets aside and still differs in.
 * @example
 * const differs: Difference[] = ['inline-script'];
 */
export type Difference = 'inline-script' | 'inline-style' | 'empty-class';

export type FileResult = {
	readonly file: string;
	readonly verdict: Verdict;
	readonly baselineSize?: number;
	readonly candidateSize?: number;
	/** `equivalent` only: what was set aside from the comparison and differs. */
	readonly differs?: readonly Difference[];
	/** `semantic` only: prefixed declarations that only one stylesheet has. */
	readonly prefixes?: {
		readonly removed: readonly string[];
		readonly added: readonly string[];
	};
};

export type Comparison = {
	/** Files per verdict. `equivalent` is there only with `semantic`. */
	readonly counts: Readonly<Partial<Record<Verdict, number>>>;
	readonly results: readonly FileResult[];
	/**
	 * True when no file is different, missing, extra or grown, no equivalent file has
	 * anything left to check, and no stylesheet lost a prefix.
	 */
	readonly ok: boolean;
};

/**
 * Options of `compareTrees`.
 * @example
 * compareTrees('out-v2', 'out-v3', { semantic: true } satisfies CompareOptions);
 */
export type CompareOptions = {
	/** Compare pages after `normalizeHtml` and list the prefix changes of stylesheets. */
	readonly semantic?: boolean;
};

const SIZE_ONLY = new Set(['.css', '.js', '.map']);

/**
 * The extensions that `semantic` compares as pages.
 * @example
 * PAGE.has(path.extname('a/index.html')); // true
 */
export const PAGE = new Set(['.html', '.htm']);

const same = (a: readonly (string | number)[], b: readonly (string | number)[]) =>
	a.length === b.length && a.every((s, i) => s === b[i]);

// `ignoreBOM` keeps a byte order mark as U+FEFF, so one that only a side has is a
// difference, as it is when the bytes are read one per character.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Decodes two files for comparing their text. Both are read as UTF-8 when both are
 * valid UTF-8. Otherwise (a Shift_JIS page, say) both are read one byte per character,
 * so that bytes that differ stay different; UTF-8 would turn them all into U+FFFD.
 * @param a - The baseline file's bytes
 * @param b - The candidate file's bytes
 * @example
 * const [x, y] = decodePair(readFileSync('a.html'), readFileSync('b.html'));
 */
export function decodePair(a: Uint8Array, b: Uint8Array): [string, string] {
	try {
		return [utf8.decode(a), utf8.decode(b)];
	} catch {
		return [Buffer.from(a).toString('latin1'), Buffer.from(b).toString('latin1')];
	}
}

/**
 * Compares two pages after normalizing them: whether the markup is the same, and what
 * that the markup leaves out differs. `compareTrees` and `compare-outputs.ts --diff`
 * both judge a page with this.
 * @param a - The baseline page as text
 * @param b - The candidate page as text
 * @example
 * const { sameMarkup, differs } = comparePages('<p>x</p>', '<p>\nx\n</p>');
 * // sameMarkup: true, differs: []
 */
export function comparePages(
	a: string,
	b: string,
): {
	readonly baseline: NormalizedHtml;
	readonly candidate: NormalizedHtml;
	readonly sameMarkup: boolean;
	readonly differs: readonly Difference[];
} {
	const x = normalizeHtml(a);
	const y = normalizeHtml(b);
	const differs: Difference[] = [];
	if (!same(x.inline.scripts, y.inline.scripts)) {
		differs.push('inline-script');
	}
	if (!same(x.inline.styles, y.inline.styles)) {
		differs.push('inline-style');
	}
	if (!same(x.emptyClass, y.emptyClass)) {
		differs.push('empty-class');
	}
	return { baseline: x, candidate: y, sameMarkup: x.markup === y.markup, differs };
}

// The files under a directory, as sorted paths relative to it.
/**
 *
 * @param root
 */
function walk(root: string): string[] {
	const out: string[] = [];
	const visit = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				visit(full);
			} else if (entry.isFile()) {
				out.push(path.relative(root, full));
			}
		}
	};
	visit(root);
	return out.toSorted();
}

/**
 * Compares two output trees.
 * @param baselineDir - The reference output (v2)
 * @param candidateDir - The output under test (v3)
 * @param options - `semantic` to compare pages by their normalized markup
 * @example
 * const { counts, ok } = compareTrees('out-v2', 'out-v3');
 * const migration = compareTrees('out-v2', 'out-v3', { semantic: true });
 */
export function compareTrees(
	baselineDir: string,
	candidateDir: string,
	options: CompareOptions = {},
): Comparison {
	const baselineRoot = path.resolve(baselineDir);
	const candidateRoot = path.resolve(candidateDir);
	const baselineFiles = new Set(walk(baselineRoot));
	const candidateFiles = new Set(walk(candidateRoot));
	const results: FileResult[] = [];

	for (const file of baselineFiles) {
		if (!candidateFiles.has(file)) {
			results.push({ file, verdict: 'missing' });
			continue;
		}
		const pathA = path.join(baselineRoot, file);
		const pathB = path.join(candidateRoot, file);
		const baselineSize = statSync(pathA).size;
		const candidateSize = statSync(pathB).size;
		const sizes = { baselineSize, candidateSize };
		const ext = path.extname(file);
		// Files are read only when their bytes are needed, and then once.
		let bytes: [Buffer, Buffer] | undefined;
		const read = () => (bytes ??= [readFileSync(pathA), readFileSync(pathB)]);
		const text = () => decodePair(...read());
		if (baselineSize === candidateSize && read()[0].equals(read()[1])) {
			results.push({ file, verdict: 'identical', ...sizes });
		} else if (SIZE_ONLY.has(ext)) {
			const prefixes =
				options.semantic && ext === '.css' ? prefixDifference(...text()) : undefined;
			results.push({
				file,
				verdict: candidateSize <= baselineSize ? 'smaller' : 'larger',
				...sizes,
				...(prefixes && prefixes.removed.length + prefixes.added.length > 0
					? { prefixes }
					: {}),
			});
		} else {
			const page =
				options.semantic && PAGE.has(ext) ? comparePages(...text()) : undefined;
			results.push(
				page?.sameMarkup
					? {
							file,
							verdict: 'equivalent',
							...sizes,
							...(page.differs.length > 0 ? { differs: page.differs } : {}),
						}
					: { file, verdict: 'different', ...sizes },
			);
		}
	}
	for (const file of candidateFiles) {
		if (!baselineFiles.has(file)) {
			results.push({ file, verdict: 'extra' });
		}
	}

	// `equivalent` is counted only with `semantic`; the byte comparison has no such verdict.
	const counts: Partial<Record<Verdict, number>> = {
		identical: 0,
		...(options.semantic ? { equivalent: 0 } : {}),
		smaller: 0,
		larger: 0,
		different: 0,
		missing: 0,
		extra: 0,
	};
	for (const r of results) {
		counts[r.verdict] = (counts[r.verdict] ?? 0) + 1;
	}
	const failed = (['different', 'missing', 'extra', 'larger'] as const).some(
		(verdict) => (counts[verdict] ?? 0) > 0,
	);
	return {
		counts,
		results,
		// Two empty trees agree on nothing: that is a failed comparison, not a pass.
		ok:
			results.length > 0 &&
			!failed &&
			results.every((r) => r.differs === undefined && !r.prefixes?.removed.length),
	};
}
