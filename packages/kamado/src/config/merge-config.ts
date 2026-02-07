import type { Config, UserConfig } from './types.js';
import type { MetaData } from '../files/types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { toAbsolutePath } from '../path/absolute-path.js';

/**
 * Merges user configuration with default values to produce a complete Config
 * @param config - User configuration or existing full configuration
 * @param dir - Project root directory (defaults to process.cwd())
 * @returns Complete configuration with all defaults applied
 */
export async function mergeConfig<M extends MetaData>(
	config: UserConfig<M> | Config<M>,
	dir?: string,
): Promise<Config<M>> {
	const rootDir = dir ?? process.cwd();

	const pkg =
		(config as Config<M>).pkg ??
		JSON.parse(await fs.readFile(path.resolve(rootDir, 'package.json'), 'utf8'));

	return {
		pkg,
		dir: {
			root: rootDir,
			input: toAbsolutePath(config.dir?.input, rootDir) ?? rootDir,
			output: toAbsolutePath(config.dir?.output, rootDir) ?? rootDir,
		},
		devServer: {
			open: false,
			port: 3000,
			host: 'localhost',
			startPath: undefined,
			transforms: [],
			...config.devServer,
		},
		pageList: config.pageList,
		compilers: config.compilers ?? (() => []),
		onBeforeBuild: config.onBeforeBuild,
		onAfterBuild: config.onAfterBuild,
	};
}
