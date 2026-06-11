import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { clearFileContentCache } from '../files/file-content.js';

import {
	BUILD_MANIFEST_VERSION,
	MISSING_FILE_HASH,
	createFileHasher,
	getBuildManifestPath,
	loadBuildManifest,
	saveBuildManifest,
} from './build-manifest.js';

vi.mock('node:fs/promises', () => {
	return {
		default: memfs.promises,
	};
});

beforeEach(() => {
	clearFileContentCache();
});

afterEach(() => {
	vol.reset();
	clearFileContentCache();
});

describe('build manifest persistence', () => {
	test('returns null when no manifest exists', async () => {
		expect(await loadBuildManifest('/project')).toBeNull();
	});

	test('returns null for corrupt JSON', async () => {
		vol.fromJSON({
			[getBuildManifestPath('/project')]: '{not json',
		});
		expect(await loadBuildManifest('/project')).toBeNull();
	});

	test('returns null for a different manifest version', async () => {
		vol.fromJSON({
			[getBuildManifestPath('/project')]: JSON.stringify({
				version: BUILD_MANIFEST_VERSION + 1,
				entries: {},
			}),
		});
		expect(await loadBuildManifest('/project')).toBeNull();
	});

	test('round-trips entries through save and load', async () => {
		const manifest = {
			version: BUILD_MANIFEST_VERSION,
			entries: {
				'/out/index.html': {
					inputPath: '/in/index.pug',
					deps: { '/in/index.pug': 'a'.repeat(64) },
					env: 'b'.repeat(64),
					outputSize: 123,
				},
			},
		};

		await saveBuildManifest('/project', manifest);
		expect(await loadBuildManifest('/project')).toStrictEqual(manifest);
	});
});

describe('createFileHasher', () => {
	test('hashes file contents and memoizes per path', async () => {
		vol.fromJSON({
			'/in/a.txt': 'alpha',
		});
		const hashFile = createFileHasher();

		const first = await hashFile('/in/a.txt');
		// echo -n 'alpha' | shasum -a 256
		expect(first).toBe(
			'8ed3f6ad685b959ead7022518e1af76cd816f8e8ec7ccdda1ed4018e8f2223f8',
		);

		// A later write is not observed by the same hasher — the hash is
		// memoized for the duration of one build
		await memfs.promises.writeFile('/in/a.txt', 'changed');
		expect(await hashFile('/in/a.txt')).toBe(first);
	});

	test('returns the missing sentinel for unreadable files', async () => {
		const hashFile = createFileHasher();
		expect(await hashFile('/nowhere.txt')).toBe(MISSING_FILE_HASH);
	});
});
