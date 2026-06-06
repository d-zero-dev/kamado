import type { GetNavTreeOptions } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { CompileData, PageCompilerOptions, ParseErrorMode } from './types.js';
import type { Transform, TransformContext } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import path from 'node:path';

import c from 'ansi-colors';
import { createCustomCompiler } from 'kamado/compiler';
import { getGlobalData } from 'kamado/data';
import { getContentFromFile, getContentFromFileObject } from 'kamado/files';

import { getBreadcrumbs } from './features/breadcrumbs.js';
import { getNavTree } from './features/nav.js';
import { titleList } from './features/title-list.js';
import { getLayouts } from './layouts.js';
import { createDefaultPageTransforms } from './page-transform.js';
import { transpileLayout } from './transpile-layout.js';
import { transpileMainContent } from './transpile-main.js';

/**
 * Page compiler factory
 *
 * A generic container compiler that applies layouts and formats the output.
 * Template compilation is handled via `compileHooks`.
 * @template M - Custom metadata type extending MetaData
 * @returns Custom compiler definition that accepts {@link PageCompilerOptions}
 * @example
 * ```typescript
 * const config = {
 *   compilers: (def) => [
 *     def(createPageCompiler(), {
 *       layouts: { dir: './layouts' },
 *       globalData: { dir: './data' },
 *     }),
 *   ],
 * };
 * ```
 * @throws {Error} if page compilation fails or layout is not found
 */
export function createPageCompiler<M extends MetaData>() {
	return createCustomCompiler<PageCompilerOptions<M>, M>(() => ({
		defaultFiles: '**/*.html',
		defaultOutputExtension: '.html',
		compile: (options) => async (context) => {
			const layoutsFromDir = await getLayouts({
				dir: options?.layouts?.dir,
			});
			const layouts = {
				...layoutsFromDir,
				...options?.layouts?.files,
			};

			const globalDataFromDir = options?.globalData?.dir
				? await getGlobalData<M>(options?.globalData?.dir, context)
				: undefined;
			const globalData = {
				...globalDataFromDir,
				...options?.globalData?.data,
			};

			// Resolve compileHooks (can be object or function) once per context,
			// not per file — hook factories take only `options` and are file-independent
			const compileHooks =
				typeof options?.compileHooks === 'function'
					? await options.compileHooks(options)
					: options?.compileHooks;

			// Resolve transforms once per context — they receive file info at
			// transform time, not at creation time
			const defaultPageTransforms = createDefaultPageTransforms<M>();
			const transforms: Transform<M>[] =
				typeof options?.transforms === 'function'
					? options.transforms(defaultPageTransforms)
					: (options?.transforms ?? defaultPageTransforms);

			const parseErrorMode: ParseErrorMode =
				options?.formatOptions?.parseError ?? 'silent';

			return async (file, compile, log, cache) => {
				log?.(c.blue('Building...'));
				const pageContent = await getContentFromFile(file, cache);
				const { metaData, content: pageMainContent } = pageContent;

				const breadcrumbs = getBreadcrumbs<M>(
					{ page: file, pageList: globalData?.pageList ?? [] },
					{
						baseURL: context.pkg.production?.baseURL,
						transformItem: options?.transformBreadcrumbItem,
					},
				);

				const compileData: CompileData<M> = {
					...globalData,
					...metaData,
					page: file,
					nav: (navOptions: GetNavTreeOptions<M>) =>
						getNavTree<M>(
							{ currentPage: file, pages: globalData?.pageList ?? [] },
							{
								...navOptions,
								comparator:
									'comparator' in navOptions
										? navOptions.comparator
										: options?.navigationComparator,
								filter: options?.filterNavigationNode,
							},
						),
					titleList: (options: TitleListOptions) =>
						titleList(breadcrumbs, {
							siteName: context.pkg.production?.siteName,
							...options,
						}),
					breadcrumbs,
				};

				// Transpile main content
				const mainContentHtml = await transpileMainContent(
					{ content: pageMainContent, compileData, file },
					{ compileHook: compileHooks?.main, log, cache },
				);

				let html = mainContentHtml;

				// Apply layout if specified
				const layoutName = (metaData as Record<string, unknown>)?.layout as
					| string
					| undefined;
				if (layoutName) {
					const layout = layouts[layoutName];
					if (!layout) {
						throw new Error(`Layout not found: ${layoutName}`);
					}

					const { content: layoutContent } = await getContentFromFileObject(
						layout,
						cache,
					);
					const contentVariableName = options?.layouts?.contentVariableName ?? 'content';
					const layoutCompileData: CompileData<M> = {
						...compileData,
						[contentVariableName]: mainContentHtml,
					};
					const layoutExtension = path.extname(layout.inputPath).toLowerCase();

					// Transpile layout
					html = await transpileLayout(
						{
							layoutContent,
							layoutCompileData,
							layoutExtension,
							layout,
							file,
						},
						{ compileHook: compileHooks?.layout, log, cache },
					);
				}

				log?.(c.cyanBright('Formatting...'));

				// Create TransformContext
				const relativePath = path.relative(context.dir.output, file.outputPath);
				const transformContext: TransformContext<M> = {
					path: relativePath,
					filePath: relativePath,
					inputPath: file.inputPath,
					outputPath: file.outputPath,
					outputDir: context.dir.output,
					isServe: context.mode === 'serve',
					context, // Kamado Context (Config + mode)
					compile,
				};

				// Apply transforms sequentially. Any transform failure is routed through
				// the formatOptions.parseError policy: on silent/warning the failing
				// transform is skipped and the previous step's output flows through.
				let result: string | ArrayBuffer = html;
				for (const transform of transforms) {
					try {
						result = await transform.transform(result, transformContext);
					} catch (error) {
						const source = transformContext.inputPath ?? transformContext.outputPath;
						const original = error instanceof Error ? error.message : String(error);
						const message = `Transform '${transform.name}' failed on ${source}: ${original}`;

						if (parseErrorMode === 'error') {
							throw new Error(message, { cause: error });
						}
						if (parseErrorMode === 'warning') {
							// eslint-disable-next-line no-console
							console.warn(message);
						}
						// silent / warning: keep `result` as-is and continue
					}
				}

				// Ensure result is string
				if (typeof result !== 'string') {
					const decoder = new TextDecoder('utf-8');
					result = decoder.decode(result);
				}

				return result;
			};
		},
	}));
}

// Re-export types
export type * from './types.js';
export type { PrettierOptions } from './transform/prettier.js';

// Re-export page transforms
export { createDefaultPageTransforms } from './page-transform.js';
export { manipulateDOM } from './transform/manipulate-dom.js';
export { characterEntities } from './transform/character-entities.js';
export { doctype } from './transform/doctype.js';
export { prettier } from './transform/prettier.js';
export { minifier } from './transform/minifier.js';
export { lineBreak } from './transform/line-break.js';

// Re-export for backward compatibility
export { getLayouts, type GetLayoutsOptions } from './layouts.js';
export { getTitleFromHtmlString } from './features/title-utils.js';
