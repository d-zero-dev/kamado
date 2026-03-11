import type { GlobalData } from './types.js';
import type { Config } from '../config/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import path from 'node:path';

import dayjs from 'dayjs';
import fg from 'fast-glob';
import yaml from 'yaml';

import { createCompileFunctions } from '../compiler/compile-functions.js';
import { getFileContent } from '../files/file-content.js';

import { getAssetGroup } from './get-asset-group.js';

/**
 * Gets global data
 * @param dir - Directory path where global data files are stored (if empty, no data files are loaded)
 * @param config - Configuration object
 * @returns Global data object containing package info, all pages, page list with titles, and date filter
 */
export async function getGlobalData<M extends MetaData>(
	dir: string,
	config: Config<M>,
): Promise<GlobalData<M>> {
	let data: Record<string, unknown> = {};
	if (dir) {
		const dataFileGlob = path.resolve(dir, '*');
		const dataFilePaths = await fg(dataFileGlob);
		for (const dataFilePath of dataFilePaths) {
			data = {
				...data,
				...(await getGlobalDataFromDataFile(dataFilePath)),
			};
		}
	}

	const compilers = createCompileFunctions(config);

	// Find page compiler entry (outputExtension is .html)
	const pageCompilerEntry = compilers.find((entry) => entry.outputExtension === '.html');

	const pageAssetFiles = pageCompilerEntry
		? await getAssetGroup({
				inputDir: config.dir.input,
				outputDir: config.dir.output,
				compilerEntry: pageCompilerEntry,
			})
		: [];

	const pageList: (CompilableFile & { title?: string })[] = config.pageList
		? await config.pageList(pageAssetFiles, config)
		: pageAssetFiles;

	return {
		pkg: config.pkg as unknown as GlobalData<M>['pkg'],
		...data,
		pageAssetFiles,
		pageList,
		filters: {
			date: (date: dayjs.ConfigType, format: string) => dayjs(date).format(format),
		},
	};
}

const dataCache = new Map<string, Record<string, unknown>>();

/**
 * Clears the global data cache
 * Useful for ensuring fresh data in dev server mode
 */
export function clearGlobalDataCache(): void {
	dataCache.clear();
}

/**
 * Gets global data from a data file (JS, JSON, or YAML) with caching
 * @param filePath - Path to the data file
 * @returns Record containing the data (keyed by filename without extension)
 */
async function getGlobalDataFromDataFile(
	filePath: string,
): Promise<Record<string, unknown>> {
	if (dataCache.has(filePath)) {
		return dataCache.get(filePath)!;
	}

	// Ensure the file path is absolute to prevent unexpected imports
	if (!path.isAbsolute(filePath)) {
		throw new Error(`Data file path must be absolute: ${filePath}`);
	}

	const ext = path.extname(filePath).toLowerCase();
	const name = path.basename(filePath, ext);
	switch (ext) {
		case '.js': {
			// NOTE: Dynamic import is intentional here - data files are loaded from
			// a user-configured directory resolved via fast-glob, not from user input.
			const scripts = await import(filePath);
			const mainScript =
				typeof scripts.default === 'function'
					? await scripts.default()
					: (scripts.default ?? (() => {}));
			for (const [key, value] of Object.entries(scripts)) {
				if (key === 'default') {
					continue;
				}
				mainScript[key] = value;
			}
			const fragment = { [name]: mainScript };
			dataCache.set(filePath, fragment);
			return fragment;
		}
		case '.json': {
			const content = await getFileContent(filePath);
			return { [name]: JSON.parse(content) };
		}
		case '.yml': {
			const content = await getFileContent(filePath);
			return { [name]: yaml.parse(content) };
		}
	}
	return {};
}
