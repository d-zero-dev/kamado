import type { UserConfig } from './types.js';
import type { MetaData } from '../files/types.js';

/**
 * Helper function for type-safe configuration definition
 * @param config - User configuration object
 * @returns The same configuration object (identity function for type inference)
 */
export function defineConfig<M extends MetaData = MetaData>(
	config: UserConfig<M>,
): UserConfig<M> {
	return config;
}
