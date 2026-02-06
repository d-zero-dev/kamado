import type { GetNavTreeOptions } from './features/nav.js';
import type { TitleListOptions } from './features/title-list.js';
import type { CompileData, PageCompilerOptions } from './types.js';
import type { Context, Transform, TransformContext } from 'kamado/config';

import path from 'node:path';

import c from 'ansi-colors';
import { createCustomCompiler } from 'kamado/compiler';
import { getGlobalData } from 'kamado/data';
import { getContentFromFile, getContentFromFileObject } from 'kamado/files';

import { getBreadcrumbs } from './features/breadcrumbs.js';
import { getNavTree } from './features/nav.js';
import { titleList } from './features/title-list.js';
import { getLayouts } from './layouts.js';
import { defaultPageTransforms } from './page-transform.js';
import { transpileLayout } from './transpile-layout.js';
import { transpileMainContent } from './transpile-main.js';

/**
 * Page compiler
 * A generic container compiler that applies layouts and formats the output.
 * Template compilation is handled via `compileHooks`.
 * @example
 * ```typescript
 * const config = {
 *   compilers: [
 *     pageCompiler({
 *       layouts: { dir: './layouts' },
 *       globalData: { dir: './data' },
 *       imageSizes: true,
 *     }),
 *   ],
 * };
 * ```
 * @throws {Error} if page compilation fails or layout is not found
 */
export const pageCompiler = createCustomCompiler<PageCompilerOptions>(() => ({
	defaultFiles: '**/*.html',
	defaultOutputExtension: '.html',
	compile: (options) => async (context: Context) => {
		const layoutsFromDir = await getLayouts({
			dir: options?.layouts?.dir,
		});
		const layouts = {
			...layoutsFromDir,
			...options?.layouts?.files,
		};

		const globalDataFromDir = options?.globalData?.dir
			? await getGlobalData(options?.globalData?.dir, context)
			: undefined;
		const globalData = {
			...globalDataFromDir,
			...options?.globalData?.data,
		};

		return async (file, compile, log, cache) => {
			log?.(c.blue('Building...'));
			const pageContent = await getContentFromFile(file, cache);
			const { metaData, content: pageMainContent } = pageContent;

			const breadcrumbs = getBreadcrumbs(
				{ page: file, pageList: globalData?.pageList ?? [] },
				{
					baseURL: context.pkg.production?.baseURL,
					transformItem: options?.transformBreadcrumbItem,
				},
			);

			const compileData: CompileData = {
				...globalData,
				...metaData,
				page: file,
				nav: (navOptions: GetNavTreeOptions) =>
					getNavTree(
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
			if (metaData?.layout) {
				const layout = layouts[metaData.layout as string];
				if (!layout) {
					throw new Error(`Layout not found: ${metaData.layout}`);
				}

				const { content: layoutContent } = await getContentFromFileObject(layout, cache);
				const contentVariableName = options?.layouts?.contentVariableName ?? 'content';
				const layoutCompileData: CompileData = {
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
			const transformContext: TransformContext = {
				path: relativePath,
				filePath: relativePath,
				inputPath: file.inputPath,
				outputPath: file.outputPath,
				outputDir: context.dir.output,
				isServe: context.mode === 'serve',
				context, // Kamado Context (Config + mode)
				compile,
			};

			// Use provided transforms or default
			const transforms: Transform[] =
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
