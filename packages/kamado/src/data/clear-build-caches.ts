import { clearFileContentCache } from '../files/file-content.js';

import { clearAssetGroupCache } from './get-asset-group.js';
import { clearGlobalDataCache } from './get-global-data.js';

/**
 * Clears every module-level cache that a build relies on: the asset group
 * memoization, file contents, and global data.
 *
 * This is the single entry point for "start from a clean slate" — when a new
 * module-level cache is added, register its clear function here so that
 * consecutive builds in the same process never see stale data.
 */
export function clearBuildCaches(): void {
	clearAssetGroupCache();
	clearFileContentCache();
	clearGlobalDataCache();
}
