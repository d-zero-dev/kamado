import type { JsxCompilerOptions } from './types.js';

import path from 'node:path';

/**
 * Always kept external so the bundled component resolves to the host
 * project's own React installation instead of being duplicated into the
 * bundle (React requires a single instance for hooks/context to work).
 */
const REACT_EXTERNALS = ['react', 'react-dom', 'react/*', 'react-dom/*'];

const ENTRY_BASENAME = '__kamado_jsx_entry__';

export interface BundleJsxContext {
	/** JSX/TSX source code (frontmatter already stripped) */
	readonly source: string;
	/** Absolute path of the file `source` originated from */
	readonly filePath: string;
	/** Directory relative imports inside `source` resolve against */
	readonly resolveDir: string;
}

export interface BundleJsxResult {
	/** Bundled ESM source, with a trailing `//# sourceURL=` annotation */
	readonly code: string;
	/** Absolute paths of every local file the bundle pulled in */
	readonly dependencies: string[];
}

/**
 * esbuild accepts only one loader per file; `.tsx` is used for anything
 * that isn't `.jsx` since it's a superset (handles plain JSX too).
 * @param filePath - Absolute path of the file being compiled
 */
function loaderForFilePath(filePath: string): 'jsx' | 'tsx' {
	return filePath.endsWith('.jsx') ? 'jsx' : 'tsx';
}

/**
 * Bundles a JSX/TSX source string into a self-contained ESM module.
 *
 * esbuild's `stdin` input (rather than `entryPoints`) is used because
 * `@kamado-io/page-compiler`'s `CompilerFunction` hands over already-read
 * file *content*, not a path — `resolveDir` stands in for the directory the
 * (possibly virtual) entry would have lived in, so relative imports still
 * resolve correctly. `react`/`react-dom` are external so the bundle shares
 * the host project's single React instance instead of duplicating it.
 * @param context - Source, origin file path, and import resolution base directory
 * @param options - Compiler options (jsxImportSource, alias, define, extra externals)
 */
export async function bundleJsx(
	context: BundleJsxContext,
	options: JsxCompilerOptions = {},
): Promise<BundleJsxResult> {
	// Dynamic import avoids a runtime error when kamado.config.ts is loaded
	// with --experimental-strip-types (mirrors `@kamado-io/script-compiler`).
	const esbuild = await import('esbuild');

	const loader = loaderForFilePath(context.filePath);
	const sourcefile = `${ENTRY_BASENAME}.${loader}`;

	const result = await esbuild.build({
		stdin: {
			contents: context.source,
			resolveDir: context.resolveDir,
			sourcefile,
			loader,
		},
		bundle: true,
		write: false,
		metafile: true,
		format: 'esm',
		platform: 'node',
		jsx: 'automatic',
		// Errors are surfaced via the thrown exception (esbuild rejects
		// build() on failure); the CLI-style stderr log would otherwise leak
		// into the host process's own output.
		logLevel: 'silent',
		jsxImportSource: options.jsxImportSource ?? 'react',
		alias: options.alias,
		define: options.define,
		external: [...REACT_EXTERNALS, ...(options.external ?? [])],
	});

	const [outputFile, ...extraOutputFiles] = result.outputFiles;
	if (!outputFile) {
		throw new Error(`esbuild produced no output for ${context.filePath}`);
	}
	for (const extra of extraOutputFiles) {
		// eslint-disable-next-line no-console
		console.warn(
			`Ignoring additional esbuild output '${extra.path}' for ${context.filePath}`,
		);
	}

	// The synthetic entry has no file of its own on disk, so it must be
	// excluded from the reported dependency list.
	const entryAbsolutePath = path.resolve(context.resolveDir, sourcefile);
	const dependencies = Object.keys(result.metafile.inputs)
		.map((input) => path.resolve(input))
		.filter((absolutePath) => absolutePath !== entryAbsolutePath);

	// Lets stack traces from a rendering error point at the real file
	// instead of the opaque virtual module URL used to import it.
	const code = `${outputFile.text}\n//# sourceURL=${context.filePath}\n`;

	return { code, dependencies };
}
