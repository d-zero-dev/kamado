import { stat } from 'node:fs/promises';

/** A file and what it looked like when it was read. */
export interface FileStamp {
	/** The absolute path. */
	readonly path: string;
	/** `<size>:<mtime in nanoseconds>`, or `missing`. */
	readonly stamp: string;
}

/**
 * What a file looks like: its size and modification time, or `missing`.
 * Why not a hash of the bytes: the dev server asks for every request, and a stat costs
 * far less than a read; a file that is rewritten with the same size in the same
 * nanosecond is not a case worth the read.
 * @param file - Absolute path
 * @example
 * ```ts
 * const before = await stampOf('/site/data/rates.csv');
 * ```
 */
export async function stampOf(file: string): Promise<string> {
	try {
		const info = await stat(file, { bigint: true });
		return `${info.size}:${info.mtimeNs}`;
	} catch {
		return 'missing';
	}
}

/**
 * Whether every file still looks as it did.
 * @param files - Files and their stamps
 * @example
 * ```ts
 * if (await unchanged(entry.reads)) { … }
 * ```
 */
export async function unchanged(files: readonly FileStamp[]): Promise<boolean> {
	const now = await Promise.all(files.map((f) => stampOf(f.path)));
	return files.every((f, i) => now[i] === f.stamp);
}
