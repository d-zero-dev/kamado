import type { Config } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import path from 'node:path';

import dayjs from 'dayjs';
import fg from 'fast-glob';
import yaml from 'yaml';

import { getTitle } from '../features/title.js';
import { getFileContent } from '../files/file-content.js';

import { getAssetGroup } from './assets.js';

export interface GlobalData {
	readonly pkg: {
		readonly name?: string;
		readonly version?: string;
		readonly production?: {
			readonly host?: string;
			readonly baseURL?: string;
			readonly siteName?: string;
			readonly siteNameEn?: string;
		};
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		readonly [key: string]: any;
	};
	readonly allPages: CompilableFile[];
	readonly pageList: (CompilableFile & { title: string })[];
	readonly filters: {
		readonly date: (date: dayjs.ConfigType, format: string) => string;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly [key: string]: any;
}

/**
 *
 * @param dir
 * @param config
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

	const allPages = await getAssetGroup('page', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
	});

	const pageList = await Promise.all(
		allPages.map(async (page) => ({
			...page,
			title: (await getTitle(page)) || '__NO_TITLE__',
		})),
	);

	return {
		pkg: config.pkg as unknown as GlobalData['pkg'],
		...data,
		allPages,
		pageList,
		filters: {
			date: (date: dayjs.ConfigType, format: string) => dayjs(date).format(format),
		},
	};
}

const dataCache = new Map<string, Record<string, unknown>>();

/**
 *
 * @param filePath
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
