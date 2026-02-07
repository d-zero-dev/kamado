import type { Config, UserConfig } from './types.js';
import type { MetaData } from '../files/types.js';

import path from 'node:path';

import { cosmiconfig } from 'cosmiconfig';

import { mergeConfig } from './merge-config.js';

const explorer = cosmiconfig('kamado');

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
	const res = configPath
		? await explorer.load(configPath).catch((error: NodeJS.ErrnoException) => {
				if (error.code === 'ENOENT') {
					throw new Error(`Config file not found: ${configPath}`);
				}
				throw error;
			})
		: await explorer.search();
	const config: UserConfig<M> = res?.config ?? {};

	return mergeConfig<M>(config, path.dirname(res?.filepath ?? ''));
}
