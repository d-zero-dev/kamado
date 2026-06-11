import type { Config, UserConfig } from './types.js';
import type { MetaData } from '../files/types.js';

import path from 'node:path';

import { cosmiconfig } from 'cosmiconfig';

import { mergeConfig } from './merge-config.js';

const explorer = cosmiconfig('kamado');

/**
 * Configuration with the path of the file it was loaded from
 */
export interface ConfigWithPath<M extends MetaData = MetaData> {
	/**
	 * Configuration object (merged with defaults)
	 */
	readonly config: Config<M>;
	/**
	 * Path of the loaded config file, or `undefined` when no config file was
	 * found and defaults were used
	 */
	readonly filepath: string | undefined;
}

/**
 * Gets configuration from config file along with the resolved file path
 * The path lets callers observe config-file changes (e.g. the incremental
 * build mixes its content hash into the cache's environment digest)
 * @param configPath - Optional path to a specific config file. If provided, loads from this path instead of searching.
 * @returns Configuration object and the path it was loaded from
 * @throws {Error} If the specified config file does not exist
 */
export async function getConfigWithPath<M extends MetaData>(
	configPath?: string,
): Promise<ConfigWithPath<M>> {
	const res = configPath
		? await explorer.load(configPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					throw new Error(`Config file not found: ${configPath}`);
				}
				throw error;
			})
		: await explorer.search();
	const config: UserConfig<M> = res?.config ?? {};

	return {
		config: await mergeConfig<M>(config, path.dirname(res?.filepath ?? '')),
		filepath: res?.filepath ?? undefined,
	};
}

/**
 * Gets configuration from config file
 * Searches for kamado config file (kamado.config.js, kamado.config.json, etc.) and merges with defaults
 * @param configPath - Optional path to a specific config file. If provided, loads from this path instead of searching.
 * @returns Configuration object
 * @throws {Error} If the specified config file does not exist
 */
export async function getConfig<M extends MetaData>(
	configPath?: string,
): Promise<Config<M>> {
	const { config } = await getConfigWithPath<M>(configPath);
	return config;
}
