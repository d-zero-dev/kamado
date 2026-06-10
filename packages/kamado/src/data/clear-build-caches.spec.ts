import { describe, test, expect, vi } from 'vitest';

import { clearFileContentCache } from '../files/file-content.js';

import { clearBuildCaches } from './clear-build-caches.js';
import { clearAssetGroupCache } from './get-asset-group.js';
import { clearGlobalDataCache } from './get-global-data.js';

vi.mock('../files/file-content.js', () => ({
	clearFileContentCache: vi.fn(),
}));

vi.mock('./get-asset-group.js', () => ({
	clearAssetGroupCache: vi.fn(),
}));

vi.mock('./get-global-data.js', () => ({
	clearGlobalDataCache: vi.fn(),
}));

describe('clearBuildCaches', () => {
	// Wiring test: this function exists so that no module-level cache is
	// forgotten at build start. Removing any clear call must fail here.
	test('clears every registered module-level cache exactly once', () => {
		clearBuildCaches();

		expect(clearAssetGroupCache).toHaveBeenCalledTimes(1);
		expect(clearFileContentCache).toHaveBeenCalledTimes(1);
		expect(clearGlobalDataCache).toHaveBeenCalledTimes(1);
	});
});
