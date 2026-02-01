import type { CompileData, PageCompilerOptions } from './types.js';
import type { Context } from 'kamado/config';

import path from 'node:path';

import c from 'ansi-colors';
import { createCustomCompiler } from 'kamado/compiler';
import { getGlobalData } from 'kamado/data';

import { getBreadcrumbs } from './features/breadcrumbs.js';
import { type GetNavTreeOptions, getNavTree } from './features/nav.js';
import { type TitleListOptions, titleList } from './features/title-list.js';
import { getLayouts } from './layouts.js';
import { pageTransform } from './page-transform.js';
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
			const pageContent = await file.get(cache);
			const { metaData, content: pageMainContent } = pageContent;

			const breadcrumbs = getBreadcrumbs(
				{ page: file, pageList: globalData?.pageList ?? [] },
				{
					baseURL: context.pkg.production?.baseURL,
					optimizeTitle: options?.optimizeTitle,
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
							optimizeTitle: options?.optimizeTitle,
							...navOptions,
							transformNode: options?.transformNavNode,
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

				const { content: layoutContent } = await layout.get(cache);
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

			// Determine URL for JSDOM
			const isServe = context.mode === 'serve';
			const url =
				options?.host ??
				(isServe
					? `http://${context.devServer.host}:${context.devServer.port}`
					: (context.pkg.production?.baseURL ??
						(context.pkg.production?.host
							? `http://${context.pkg.production.host}`
							: undefined)));

			const formattedHtml = await pageTransform(
				{
					content: html,
					inputPath: file.inputPath,
					outputPath: file.outputPath,
					outputDir: context.dir.output,
					context,
					compile,
				},
				{
					url,
					beforeSerialize: options?.beforeSerialize,
					afterSerialize: options?.afterSerialize,
					imageSizes: options?.imageSizes,
					characterEntities: options?.characterEntities,
					prettier: options?.prettier,
					minifier: options?.minifier,
					lineBreak: options?.lineBreak,
					replace: options?.replace,
					isServe,
				},
			);

			return formattedHtml;
		};
	},
}));

// Re-export types
export type * from './types.js';

// Re-export for backward compatibility
export { getLayouts, type GetLayoutsOptions } from './layouts.js';
export { getTitle } from './features/get-title.js';
export { getTitleFromStaticFile } from './features/get-title-from-static-file.js';
