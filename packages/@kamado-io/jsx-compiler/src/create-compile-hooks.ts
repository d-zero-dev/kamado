import type { JsxCompilerOptions } from './types.js';
import type {
	CompileHooksObject,
	CompilerFunction as PageCompilerFunction,
	PageCompilerOptions,
} from '@kamado-io/page-compiler';
import type { MetaData } from 'kamado/files';

import path from 'node:path';

import { compileJsx } from './compile-jsx.js';

const JSX_EXTENSIONS = new Set(['.jsx', '.tsx']);

/**
 * A JSX layout component always receives its main content under a fixed
 * `content` prop, regardless of the page compiler's `layouts.contentVariableName`
 * option (used by string-templating compilers like pug for `!{content}`
 * interpolation). This renames the configured key back to `content` so the
 * component's prop shape never depends on that option.
 * @param data - Layout compile data, as handed to the compile hook
 * @param contentVariableName - The page compiler's `layouts.contentVariableName` setting
 * @throws {Error} if `data` already has an unrelated `content` field (e.g.
 *   frontmatter or global data), since renaming would silently clobber it
 */
function normalizeContentProp(
	data: Record<string, unknown>,
	contentVariableName: string,
): Record<string, unknown> {
	if (contentVariableName === 'content') {
		return data;
	}
	if ('content' in data) {
		throw new Error(
			"@kamado-io/jsx-compiler: layout data already has a 'content' key, which would collide with the compiled main content " +
				`(layouts.contentVariableName is set to '${contentVariableName}'). Rename the conflicting 'content' field in your frontmatter/global data.`,
		);
	}
	const { [contentVariableName]: content, ...rest } = data;
	return { ...rest, content };
}

/**
 * Creates compile hooks for page-compiler.
 *
 * Unlike `@kamado-io/pug-compiler`, `main` and `layout` get *separate*
 * `compileJsx()` instances (and therefore separate caches). page-compiler's
 * `CompilerFunction<M>` never receives a file path, so resolving relative
 * imports needs a `resolveDir` computed differently for each: the main
 * content's compile data carries its own file (`data.page.inputPath`), but
 * a layout's compile data still carries the *page's* file, not the
 * layout's own. Layout files, however, are always read directly from
 * `layouts.dir` (`getLayouts()` globs it non-recursively — layouts never
 * live in subdirectories), so that directory is always the correct
 * `resolveDir` for a layout's relative imports.
 *
 * One consequence: a layout's true file path isn't available either, so
 * error messages/`//# sourceURL=` for layout compilation use a placeholder
 * path under `layouts.dir` — actual compile failures are still reported
 * with the real layout path, since page-compiler's `transpileLayout()`
 * wraps them in an outer error that does know it.
 * @param jsxOptions - JSX compiler options
 * @returns Factory that receives the page-compiler's own options (to read
 *   `layouts.dir`/`layouts.contentVariableName`) and returns a compile
 *   hooks object with `main` and `layout` compilers
 * @example
 * ```typescript
 * import { createPageCompiler } from '@kamado-io/page-compiler';
 * import { createCompileHooks } from '@kamado-io/jsx-compiler';
 *
 * export const config = {
 *   compilers: (def) => [
 *     def(createPageCompiler(), {
 *       files: '**\/*.{jsx,tsx}',
 *       layouts: { dir: './layouts' },
 *       compileHooks: createCompileHooks(),
 *     }),
 *   ],
 * };
 * ```
 */
export function createCompileHooks<M extends MetaData>(
	jsxOptions?: JsxCompilerOptions,
): (pageCompilerOptions: PageCompilerOptions<M>) => CompileHooksObject<M> {
	return (pageCompilerOptions) => {
		// Created inside the factory so each resolution (once per
		// build/serve context) gets fresh, independent compiler instances —
		// and with them, fresh caches.
		const mainCompiler = compileJsx(jsxOptions);
		const layoutCompiler = compileJsx(jsxOptions);
		const layoutsDir = pageCompilerOptions.layouts?.dir;
		const contentVariableName =
			pageCompilerOptions.layouts?.contentVariableName ?? 'content';

		const main: PageCompilerFunction<M> = async (content, data, extension, cache) => {
			if (!JSX_EXTENSIONS.has(extension)) {
				return content;
			}
			return mainCompiler(
				content,
				data,
				path.dirname(data.page.inputPath),
				data.page.inputPath,
				cache,
			);
		};

		const layout: PageCompilerFunction<M> = async (content, data, extension, cache) => {
			if (!JSX_EXTENSIONS.has(extension)) {
				return content;
			}
			if (!layoutsDir) {
				throw new Error(
					'@kamado-io/jsx-compiler: `layouts.dir` must be set on the page compiler to compile JSX/TSX layouts',
				);
			}
			const props = normalizeContentProp(data, contentVariableName);
			const filePath = path.join(layoutsDir, `<layout>${extension}`);
			return layoutCompiler(content, props, layoutsDir, filePath, cache);
		};

		// Wrapping mainCompiler/layoutCompiler in the closures above drops
		// their cacheDigest unless copied explicitly onto the wrapper (see
		// CompilerFunction<M>.cacheDigest's JSDoc in page-compiler's types.ts).
		main.cacheDigest = mainCompiler.cacheDigest;
		layout.cacheDigest = layoutCompiler.cacheDigest;

		return {
			main: { compiler: main },
			layout: { compiler: layout },
		};
	};
}
