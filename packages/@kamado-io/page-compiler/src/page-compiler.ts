import type { GetNavTreeOptions } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { CompileData, PageCompilerOptions } from './types.js';
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
 * Page compiler
 * A generic container compiler that applies layouts and formats the output.
 * Template compilation is handled via `compileHooks`.
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

				// Resolve compileHooks (can be object or function)
				const compileHooks =
					typeof options?.compileHooks === 'function'
						? await options.compileHooks(options)
						: options?.compileHooks;

				// Transpile main content
				const mainContentHtml = await transpileMainContent(
					{ content: pageMainContent, compileData, file },
					{ compileHook: compileHooks?.main, log },
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
						{ compileHook: compileHooks?.layout, log },
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

				const defaultPageTransforms = createDefaultPageTransforms<M>();

				// Use provided transforms or default
				const transforms: Transform<M>[] =
					typeof options?.transforms === 'function'
						? options.transforms(defaultPageTransforms)
						: (options?.transforms ?? defaultPageTransforms);

				// Apply transforms sequentially
				let result: string | ArrayBuffer = html;
				for (const transform of transforms) {
					result = await transform.transform(result, transformContext);
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
