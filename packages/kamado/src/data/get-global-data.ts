import type { GlobalData } from './types.js';
import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import dayjs from 'dayjs';
import fg from 'fast-glob';
import yaml from 'yaml';

import { getFileContent } from '../files/file-content.js';

import { getAssetGroup } from './get-asset-group.js';

/**
 * Gets global data
 * @param dir - Directory path where global data files are stored (if empty, no data files are loaded)
 * @param config - Configuration object
 * @returns Global data object containing package info, all pages, page list with titles, and date filter
 */
export async function getGlobalData(dir: string, config: Config): Promise<GlobalData> {
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

	// Find page compiler entry (outputExtension is .html)
	const pageCompilerEntry = config.compilers.find(
		(entry) => entry.outputExtension === '.html',
	);

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
		pkg: config.pkg as unknown as GlobalData['pkg'],
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
	const ext = path.extname(filePath).toLowerCase();
	const name = path.basename(filePath, ext);
	switch (ext) {
		case '.js': {
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
