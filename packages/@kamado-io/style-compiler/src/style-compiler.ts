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
	/**
	 * Emit an inline source map (`/*# sourceMappingURL=data:... *\/` appended to the output).
	 *
	 * - `true` / `false`: always emit / never emit.
	 * - `'onServer'`: emit only when kamado runs in serve mode (`context.mode === 'serve'`).
	 *
	 * Default: false.
	 */
	readonly sourcemap?: boolean | 'onServer';
}

/**
 * Coerces a banner string into a `/*! ... *\/` important comment so it can be
 * safely prepended to PostCSS input and survive cssnano minification.
 *
 * - `/*! ... *\/` → returned as-is.
 * - `/* ... *\/` → leading `/*` rewritten to `/*!`.
 * - anything else (including plain strings without comment markers) → wrapped
 *   in `/*! ... *\/`. Any embedded `*\/` is split with a space so it cannot
 *   prematurely close the surrounding comment.
 * @param raw
 */
function normalizeBanner(raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed) {
		return '';
	}
	if (trimmed.startsWith('/*!')) {
		return trimmed;
	}
	if (trimmed.startsWith('/*') && trimmed.endsWith('*/')) {
		return '/*!' + trimmed.slice(2);
	}
	const safe = trimmed.replaceAll('*/', '* /');
	return `/*!\n${safe}\n*/`;
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
		compile: (options) => (context) => {
			// `context.mode` is fixed for the lifetime of a command, so evaluate
			// the sourcemap flag once here rather than per-file.
			const enableSourcemap =
				options?.sourcemap === 'onServer'
					? context.mode === 'serve'
					: !!options?.sourcemap;

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

				const rawBanner =
					typeof options?.banner === 'string'
						? options.banner
						: createBanner(options?.banner?.());
				// Normalize to a `/*! ... */` important comment so that:
				// 1) cssnano preserves it through minification (the `!` flag),
				// 2) it can be safely prepended to the PostCSS input — which
				//    keeps inline source map line offsets correct and ensures
				//    the output is identical regardless of the sourcemap flag.
				const banner = normalizeBanner(rawBanner);

				const result = await postcss(plugins).process(banner + '\n' + css.content, {
					from: file.inputPath,
					to: undefined,
					...(enableSourcemap ? { map: { inline: true } } : {}),
				});
				return result.css;
			};
		},
	}));
}
