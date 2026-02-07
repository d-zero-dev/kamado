import type { MetaData } from 'kamado/files';

import path from 'node:path';

import cssnano from 'cssnano';
import { createCustomCompiler } from 'kamado/compiler';
import { createBanner, type CreateBanner } from 'kamado/compiler/banner';
import { getContentFromFile } from 'kamado/files';
import postcss from 'postcss';
import postcssImport from 'postcss-import';
// eslint-disable-next-line import-x/default
import postcssLoadConfig from 'postcss-load-config';

/**
 * Options for the style compiler
 */
export interface StyleCompilerOptions {
	/**
	 * Map of path aliases
	 * Key is alias name, value is actual path
	 */
	readonly alias?: Record<string, string>;
	/**
	 * Banner configuration
	 * Can specify CreateBanner function or string
	 */
	readonly banner?: CreateBanner | string;
}

/**
 * Style compiler
 * Processes CSS/SCSS/SASS files with PostCSS and adds a banner before compiling.
 * @example
 * ```typescript
 * const config = {
 *   compilers: (def) => [
 *     def(createStyleCompiler(), {
 *       alias: { '@': './src/styles' },
 *       banner: 'Generated file',
 *     }),
 *   ],
 * };
 * ```
 */
export function createStyleCompiler<M extends MetaData>() {
	return createCustomCompiler<StyleCompilerOptions, M>(() => ({
		defaultFiles: '**/*.css',
		defaultOutputExtension: '.css',
		compile: (options) => () => {
			return async (file, _, __, cache) => {
				// Configure plugins with alias resolver for postcss-import
				const plugins: postcss.AcceptedPlugin[] = [
					postcssImport({
						// Add postcss-import plugin with alias resolver
						resolve:
							// Create alias resolver for postcss-import
							(id: string, basedir: string) => {
								// Check if the import starts with an alias
								for (const [alias, aliasPath] of Object.entries(options?.alias ?? {})) {
									// Arias must be followed by a slash
									if (id.startsWith(alias + '/')) {
										const resolvedPath = id.replace(alias, aliasPath);
										return [path.resolve(basedir, resolvedPath)];
									}
								}
								// For non-alias imports, fallback to default postcss-import resolution
								return [id];
							},
					}),
					cssnano({
						preset: [
							'default',
							{
								// Preserve !important comments (license, copyright, etc.)
								discardComments: {
									removeAll: false,
									removeAllButFirst: false,
								},
								// Custom comment removal that preserves ! comments
								cssDeclarationSorter: false,
							},
						],
					}),
				];

				// Try to load PostCSS config from project root
				let config;
				try {
					config = await postcssLoadConfig();
				} catch {
					// Fallback to default config if no config found
					config = { plugins: [] };
				}

				// Add other plugins from config (excluding postcss-import if it exists)
				if (config.plugins) {
					for (const plugin of config.plugins) {
						// Skip postcss-import plugin to avoid duplicates
						if (
							typeof plugin === 'object' &&
							plugin &&
							'pluginName' in plugin &&
							plugin.pluginName === 'postcss-import'
						) {
							continue;
						}
						plugins.push(plugin);
					}
				}

				const css = await getContentFromFile(file, cache);

				// Process CSS with PostCSS
				const result = await postcss(plugins).process(css.content, {
					from: file.inputPath,
					to: undefined,
				});

				const banner =
					typeof options?.banner === 'string'
						? options.banner
						: createBanner(options?.banner?.());

				return banner + '\n' + result.css;
			};
		},
	}));
}
