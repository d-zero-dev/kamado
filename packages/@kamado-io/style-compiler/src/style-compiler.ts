import type { CustomCompileFunction, SourcemapOption } from 'kamado/compiler';
import type { MetaData } from 'kamado/files';

import { createRequire } from 'node:module';
import path from 'node:path';

import cssnano from 'cssnano';
import {
	createBannerResolver,
	createCacheDigest,
	createCustomCompiler,
	resolveSourcemapFlag,
} from 'kamado/compiler';
import { type CreateBanner } from 'kamado/compiler/banner';
import { getContentFromFile, trackDependency } from 'kamado/files';
import postcss from 'postcss';
import postcssImport from 'postcss-import';
// eslint-disable-next-line import-x/default
import postcssLoadConfig from 'postcss-load-config';

const require = createRequire(import.meta.url);

/**
 * Versions of the PostCSS toolchain, folded into the cache digest so a
 * dependency upgrade that changes CSS output (notably cssnano minification)
 * invalidates the incremental cache. cssnano exposes no runtime version, so
 * its package.json is read once at module load; failures fall back to '' so
 * the digest is merely less precise, never throwing.
 */
const TOOLCHAIN_VERSIONS = {
	postcss: postcss([]).version,
	cssnano: ((): string => {
		try {
			return (require('cssnano/package.json') as { version: string }).version;
		} catch {
			return '';
		}
	})(),
};

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
	 * Default: `'onServer'`.
	 */
	readonly sourcemap?: SourcemapOption;
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
			const enableSourcemap = resolveSourcemapFlag(options?.sourcemap, context.mode);

			// Configure plugins once per context — plugin instances and the
			// loaded PostCSS config are file-independent
			const basePlugins: postcss.AcceptedPlugin[] = [
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

			const createProcessor = async (): Promise<{
				processor: postcss.Processor;
				configFile: string | undefined;
			}> => {
				// Try to load PostCSS config from project root
				let config;
				let configFile: string | undefined;
				try {
					const loaded = await postcssLoadConfig();
					config = loaded;
					// The resolved config file shapes every output but is loaded
					// outside kamado's file APIs; surface its path so the compile
					// function can report it as a per-file dependency
					configFile = loaded.file;
				} catch (error) {
					// Fallback to default config if no config found.
					// A missing config is expected; anything else (e.g. a syntax
					// error in postcss.config.js) is surfaced so plugin loss is
					// not silent.
					if (
						error instanceof Error &&
						!error.message.includes('No PostCSS Config found')
					) {
						// eslint-disable-next-line no-console
						console.warn(`Failed to load PostCSS config: ${error.message}`);
					}
					config = { plugins: [] };
				}

				const plugins = [...basePlugins];
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
				return { processor: postcss(plugins), configFile };
			};

			// Normalize to a `/*! ... */` important comment so that:
			// 1) cssnano preserves it through minification (the `!` flag),
			// 2) it can be safely prepended to the PostCSS input — which
			//    keeps inline source map line offsets correct and ensures
			//    the output is identical regardless of the sourcemap flag.
			const resolveBanner = createBannerResolver(options?.banner, normalizeBanner);

			// Lazily build the processor once and reuse it across files. A failed
			// processor build is NOT cached, so the next file retries instead of
			// replaying the same rejection forever.
			let processorPromise:
				| Promise<{ processor: postcss.Processor; configFile: string | undefined }>
				| undefined;

			const compileFunction: CustomCompileFunction = async (file, _, __, cache) => {
				// cache === false (serve mode): rebuild per compilation so that
				// postcss.config.js edits are picked up without a restart
				const { processor, configFile } =
					cache === false
						? await createProcessor()
						: await (processorPromise ??= createProcessor().catch((error) => {
								processorPromise = undefined;
								throw error;
							}));

				// Report the resolved postcss config as a dependency of THIS file's
				// output. The processor is built once and shared, so tracking must
				// happen here in each file's collection scope, not inside the lazy
				// createProcessor (which only runs in the first file's scope).
				if (configFile) {
					trackDependency(configFile);
				}

				const css = await getContentFromFile(file, cache);

				const banner = resolveBanner(cache);

				const result = await processor.process(banner + '\n' + css.content, {
					from: file.inputPath,
					to: undefined,
					...(enableSourcemap ? { map: { inline: true } } : {}),
				});

				// postcss-import inlines files outside kamado's file APIs, so
				// report them for the incremental-build manifest. Plugins emit
				// `dependency` messages for each inlined file
				for (const message of result.messages) {
					if (message.type === 'dependency' && typeof message.file === 'string') {
						trackDependency(message.file);
					}
				}

				return result.css;
			};

			// Context-level inputs for the incremental-build manifest: when any
			// of these change, every stylesheet must be rebuilt (functions in
			// options are omitted from the digest — banner is captured as its
			// resolved string instead). The toolchain versions are folded in so a
			// postcss/cssnano upgrade that changes output invalidates the cache;
			// the loaded postcss.config.js is now tracked per file as a
			// dependency (see the compile function above).
			compileFunction.cacheDigest = () =>
				createCacheDigest({
					compiler: '@kamado-io/style-compiler',
					toolchainVersions: TOOLCHAIN_VERSIONS,
					options,
					banner: resolveBanner(),
					enableSourcemap,
				});

			return compileFunction;
		},
	}));
}
