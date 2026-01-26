import type { Config, UserConfig } from './types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { toAbsolutePath } from '../path/absolute-path.js';

/**
 *
 * @param config
 * @param dir
 */
export async function mergeConfig(
	config: UserConfig | Config,
	dir?: string,
): Promise<Config> {
	const rootDir = dir ?? process.cwd();

	const pkg =
		(config as Config).pkg ??
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
			...config.devServer,
		},
		pageList: config.pageList,
		compilers: config.compilers ?? [],
		onBeforeBuild: config.onBeforeBuild,
		onAfterBuild: config.onAfterBuild,
	};
}
