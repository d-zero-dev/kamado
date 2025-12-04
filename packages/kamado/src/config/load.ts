import type { Config, UserConfig } from './types.js';

import path from 'node:path';

import { cosmiconfig } from 'cosmiconfig';

import { mergeConfig } from './merge.js';

const explorer = cosmiconfig('kamado');

/**
 *
 */
export async function getConfig(): Promise<Config> {
	const res = await explorer.search();
	const config: UserConfig = res?.config ?? {};

	return mergeConfig(config, path.dirname(res?.filepath ?? ''));
}
