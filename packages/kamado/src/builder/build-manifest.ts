import fs from 'node:fs/promises';
import path from 'node:path';

import { hashContent } from '../compiler/cache-digest.js';

/**
 * Bump when the manifest format or the meaning of recorded hashes changes;
 * a manifest with a different version is ignored (full rebuild).
 */
export const BUILD_MANIFEST_VERSION = 1;

/**
 * Sentinel recorded for a dependency that could not be read. A dependency on
 * a missing file is still a dependency — creating the file later must
 * invalidate the entry. SHA-256 digests are 64 hex chars, so this cannot
 * collide with a real hash.
 */
export const MISSING_FILE_HASH = 'missing';

/**
 * One output file's verifying trace.
 */
export interface BuildManifestEntry {
	/**
	 * Source file the output was compiled from.
	 */
	readonly inputPath: string;
	/**
	 * Every file the compilation read, mapped to its content hash
	 * (or {@link MISSING_FILE_HASH}). Includes the input file itself.
	 */
	readonly deps: Record<string, string>;
	/**
	 * Environment digest of the compiler entry that produced the output
	 * (context-level inputs: global data, options, config file).
	 */
	readonly env: string;
	/**
	 * Byte length of the written output, used to verify the output file
	 * still matches before skipping.
	 */
	readonly outputSize: number;
}

/**
 * Incremental-build manifest: verifying traces keyed by output path.
 */
export interface BuildManifest {
	readonly version: number;
	readonly entries: Record<string, BuildManifestEntry>;
}

/**
 * Resolves the manifest location for a project root.
 * @param rootDir - Project root directory
 * @returns Path of the manifest file
 */
export function getBuildManifestPath(rootDir: string): string {
	return path.join(rootDir, '.kamado', 'cache', 'build-manifest.json');
}

/**
 * Type guard for a single manifest entry. The skip path dereferences
 * `entry.deps` (Object.keys / Object.entries), so a version-matching but
 * malformed entry — hand-edited, merge-conflicted, or written by a future
 * tool — would otherwise throw inside the build instead of falling back to a
 * full rebuild.
 * @param value - Candidate entry
 */
function isValidEntry(value: unknown): value is BuildManifestEntry {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const entry = value as Record<string, unknown>;
	if (
		typeof entry.inputPath !== 'string' ||
		typeof entry.env !== 'string' ||
		typeof entry.outputSize !== 'number' ||
		typeof entry.deps !== 'object' ||
		entry.deps === null
	) {
		return false;
	}
	return Object.values(entry.deps as Record<string, unknown>).every(
		(hash) => typeof hash === 'string',
	);
}

/**
 * Loads the manifest for a project root.
 * @param rootDir - Project root directory
 * @returns The manifest, or `null` when missing, unreadable, corrupt, or of
 *   a different version — all of which simply mean "full rebuild". Any
 *   malformed entry invalidates the whole manifest rather than risking a
 *   throw or a bad skip mid-build.
 */
export async function loadBuildManifest(rootDir: string): Promise<BuildManifest | null> {
	try {
		const raw = await fs.readFile(getBuildManifestPath(rootDir), 'utf8');
		const parsed = JSON.parse(raw) as BuildManifest;
		if (
			parsed?.version !== BUILD_MANIFEST_VERSION ||
			typeof parsed.entries !== 'object' ||
			parsed.entries === null
		) {
			return null;
		}
		for (const entry of Object.values(parsed.entries)) {
			if (!isValidEntry(entry)) {
				return null;
			}
		}
		return parsed;
	} catch {
		return null;
	}
}

/**
 * Writes the manifest for a project root.
 * @param rootDir - Project root directory
 * @param manifest - Manifest to persist
 */
export async function saveBuildManifest(
	rootDir: string,
	manifest: BuildManifest,
): Promise<void> {
	const manifestPath = getBuildManifestPath(rootDir);
	await fs.mkdir(path.dirname(manifestPath), { recursive: true });
	await fs.writeFile(manifestPath, JSON.stringify(manifest));
}

/**
 * Creates a memoizing file hasher for one build. The hash is memoized per
 * path, so a dependency referenced by many outputs (a layout, a partial) is
 * read and hashed once per build.
 *
 * Reads the raw bytes directly rather than going through `getFileContent`:
 * hashing the bytes (not a UTF-8-decoded string) means byte-distinct binary
 * dependencies cannot collide, and not populating the file-content cache
 * keeps a no-change incremental rebuild — which hashes every dependency but
 * compiles nothing — from pinning every source file's content in memory.
 * @returns Hasher resolving to the file's content hash, or
 *   {@link MISSING_FILE_HASH} when the file cannot be read
 */
export function createFileHasher(): (filePath: string) => Promise<string> {
	const memo = new Map<string, Promise<string>>();
	return (filePath) => {
		let pending = memo.get(filePath);
		if (!pending) {
			pending = fs
				.readFile(filePath)
				.then((content) => hashContent(content))
				.catch(() => MISSING_FILE_HASH);
			memo.set(filePath, pending);
		}
		return pending;
	};
}
