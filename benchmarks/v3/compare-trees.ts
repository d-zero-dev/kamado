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
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type Verdict =
	'identical' | 'smaller' | 'larger' | 'different' | 'missing' | 'extra';

export type FileResult = {
	readonly file: string;
	readonly verdict: Verdict;
	readonly baselineSize?: number;
	readonly candidateSize?: number;
};

export type Comparison = {
	readonly counts: Readonly<Record<Verdict, number>>;
	readonly results: readonly FileResult[];
	/** True when no file is different, missing, extra or grown. */
	readonly ok: boolean;
};

const SIZE_ONLY = new Set(['.css', '.js', '.map']);

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

const hash = (file: string) =>
	createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * Compares two output trees.
 * @param baselineDir - The reference output (v2)
 * @param candidateDir - The output under test (v3)
 * @example
 * const { counts, ok } = compareTrees('out-v2', 'out-v3');
 */
export function compareTrees(baselineDir: string, candidateDir: string): Comparison {
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
		const a = path.join(baselineRoot, file);
		const b = path.join(candidateRoot, file);
		const baselineSize = statSync(a).size;
		const candidateSize = statSync(b).size;
		const sizes = { baselineSize, candidateSize };
		if (baselineSize === candidateSize && hash(a) === hash(b)) {
			results.push({ file, verdict: 'identical', ...sizes });
		} else if (SIZE_ONLY.has(path.extname(file))) {
			results.push({
				file,
				verdict: candidateSize <= baselineSize ? 'smaller' : 'larger',
				...sizes,
			});
		} else {
			results.push({ file, verdict: 'different', ...sizes });
		}
	}
	for (const file of candidateFiles) {
		if (!baselineFiles.has(file)) {
			results.push({ file, verdict: 'extra' });
		}
	}

	const counts: Record<Verdict, number> = {
		identical: 0,
		smaller: 0,
		larger: 0,
		different: 0,
		missing: 0,
		extra: 0,
	};
	for (const r of results) {
		counts[r.verdict]++;
	}
	return {
		counts,
		results,
		ok: counts.different + counts.missing + counts.extra + counts.larger === 0,
	};
}
