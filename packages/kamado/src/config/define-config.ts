import type { UserConfig } from './types.js';
import type { MetaData } from '../files/types.js';

/**
 *
 * @param config
 */
export function defineConfig<M extends MetaData = MetaData>(
	config: UserConfig<M>,
): UserConfig<M> {
	return config;
}
