import os from 'node:os';
import path from 'node:path';

import { vol, fs as memfs } from 'memfs';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { clearFileContentCache } from '../files/file-content.js';

import {
	BUILD_MANIFEST_VERSION,
	MISSING_FILE_HASH,
	createFileHasher,
	getBuildManifestPath,
	getCacheDir,
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

describe('getCacheDir', () => {
	test('defaults to a project-specific folder under the OS temp directory', () => {
		const dir = getCacheDir('/project');
		expect(dir.startsWith(path.join(os.tmpdir(), 'kamado'))).toBe(true);
		// Not inside the project tree
		expect(dir.startsWith('/project')).toBe(false);
	});

	test('namespaces different project roots into different cache dirs', () => {
		expect(getCacheDir('/project-a')).not.toBe(getCacheDir('/project-b'));
		// Stable for the same root
		expect(getCacheDir('/project-a')).toBe(getCacheDir('/project-a'));
	});

	test('uses an explicit cacheDir, resolving a relative path against the root', () => {
		expect(getCacheDir('/project', '/abs/cache')).toBe('/abs/cache');
		expect(getCacheDir('/project', '.cache')).toBe(path.join('/project', '.cache'));
	});

	test('getBuildManifestPath places the manifest inside the resolved cache dir', () => {
		expect(getBuildManifestPath('/project', '/abs/cache')).toBe(
			path.join('/abs/cache', 'build-manifest.json'),
		);
	});
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

	test('returns null when a version-matching entry is missing deps', async () => {
		// A malformed entry must invalidate the whole manifest (full rebuild)
		// rather than throw on Object.keys(entry.deps) inside the build
		vol.fromJSON({
			[getBuildManifestPath('/project')]: JSON.stringify({
				version: BUILD_MANIFEST_VERSION,
				entries: {
					'/out/a.html': { inputPath: '/in/a.html', env: 'raw', outputSize: 5 },
				},
			}),
		});
		expect(await loadBuildManifest('/project')).toBeNull();
	});

	test('returns null when an entry has a non-string dep hash', async () => {
		vol.fromJSON({
			[getBuildManifestPath('/project')]: JSON.stringify({
				version: BUILD_MANIFEST_VERSION,
				entries: {
					'/out/a.html': {
						inputPath: '/in/a.html',
						deps: { '/in/a.html': 123 },
						env: 'raw',
						outputSize: 5,
					},
				},
			}),
		});
		expect(await loadBuildManifest('/project')).toBeNull();
	});

	test('returns null when an entry is missing inputPath or outputSize', async () => {
		vol.fromJSON({
			[getBuildManifestPath('/project')]: JSON.stringify({
				version: BUILD_MANIFEST_VERSION,
				entries: {
					'/out/a.html': { deps: { '/in/a.html': 'a'.repeat(64) }, env: 'raw' },
				},
			}),
		});
		expect(await loadBuildManifest('/project')).toBeNull();
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

	test('hashes raw bytes so byte-distinct binary files do not collide', async () => {
		// Two different invalid UTF-8 byte sequences both decode to the
		// replacement character under utf8, so a string-based hash would
		// collide; the byte-based hasher must keep them distinct
		await memfs.promises.mkdir('/bin', { recursive: true });
		await memfs.promises.writeFile('/bin/a', Buffer.from([0xc3, 0x28]));
		await memfs.promises.writeFile('/bin/b', Buffer.from([0xc4, 0x28]));
		const hashFile = createFileHasher();

		const hashA = await hashFile('/bin/a');
		const hashB = await hashFile('/bin/b');
		expect(hashA).not.toBe(hashB);
		expect(hashA).not.toBe(MISSING_FILE_HASH);
	});
});
