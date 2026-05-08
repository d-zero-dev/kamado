import type { CustomCompilerWithMetadata } from '../compiler/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import path from 'node:path';

import fg from 'fast-glob';
import picomatch from 'picomatch';

import { getContentFromFile } from '../files/get-content-from-file.js';
import { getFile } from '../files/get-file.js';
import { resolveMetaPath } from '../path/resolve-meta-path.js';

/**
 * Required context for getting asset files
 */
export interface GetAssetGroupContext<M extends MetaData> {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly compilerEntry: CustomCompilerWithMetadata<M>;
}

/**
 * Optional options for getting asset files
 */
export interface GetAssetGroupOptions {
	readonly glob?: string;
}

/**
 * Gets asset files for the specified compiler entry.
 *
 * When `compilerEntry.outputPathField` is set, each matched file's frontmatter
 * (and same-name JSON sidecar) is read eagerly. If the named field holds a
 * non-empty string, the file's `outputPath`, `url`, `filePathStem`, and
 * `fileSlug` are recomputed from that override via {@link resolveMetaPath}.
 * Two source files resolving to the same `outputPath` raise a collision error.
 * @param context - Required context (inputDir, outputDir, compilerEntry).
 * @param options - Optional filtering options (glob).
 * @returns The list of matched files as `CompilableFile` objects, in the order
 *   returned by the underlying glob.
 * @throws {Error} on output-path collision, on invalid override path, or when
 *   frontmatter parsing fails for a matched file.
 * @template M - Metadata type carried by the compiler entry.
 */
export async function getAssetGroup<M extends MetaData>(
	context: GetAssetGroupContext<M>,
	options?: GetAssetGroupOptions,
): Promise<CompilableFile[]> {
	const { inputDir, outputDir, compilerEntry } = context;
	const baseGlob = path.resolve(inputDir, compilerEntry.files);

	const fgOptions: {
		cwd: string;
		ignore?: string[];
	} = {
		cwd: inputDir,
	};
	if (compilerEntry.ignore) {
		fgOptions.ignore = [compilerEntry.ignore];
	}

	let filePaths = await fg(baseGlob, fgOptions);

	if (options?.glob) {
		const isMatch = picomatch(options.glob);
		filePaths = filePaths.filter((filePath) => isMatch(filePath));
	}

	const results: CompilableFile[] = [];
	const seen = new Map<string, string>();

	for (const filePath of filePaths) {
		let file = getFile(filePath, {
			inputDir,
			outputDir,
			outputExtension: compilerEntry.outputExtension,
		});

		const overrideField = compilerEntry.outputPathField;
		if (overrideField) {
			let metaData: Record<string, unknown>;
			try {
				({ metaData } = await getContentFromFile<Record<string, unknown>>(file, true));
			} catch (error) {
				throw new Error(
					`Failed to read frontmatter from ${filePath}: ${(error as Error).message}`,
				);
			}
			const metaPath = metaData?.[overrideField];
			if (typeof metaPath === 'string' && metaPath.length > 0) {
				try {
					file = applyMetaPathOverride(file, metaPath, {
						outputDir,
						outputExtension: compilerEntry.outputExtension,
					});
				} catch (error) {
					throw new Error(
						`Invalid frontmatter '${overrideField}' in ${filePath}: ${(error as Error).message}`,
					);
				}
			}
		}

		const previousInput = seen.get(file.outputPath);
		if (previousInput) {
			throw new Error(
				`Output path collision: '${file.outputPath}' is produced by both '${previousInput}' and '${filePath}'`,
			);
		}
		seen.set(file.outputPath, filePath);

		results.push(file);
	}

	return results;
}

/**
 * Rebuilds a CompilableFile using a frontmatter override path.
 * Internal helper invoked when {@link CustomCompilerWithMetadata.outputPathField}
 * is configured and the named field holds a non-empty string.
 * @param file
 * @param metaPath
 * @param context
 * @param context.outputDir
 * @param context.outputExtension
 */
function applyMetaPathOverride(
	file: CompilableFile,
	metaPath: string,
	context: { readonly outputDir: string; readonly outputExtension: string },
): CompilableFile {
	const { outputPath, rootRelPathWithExt } = resolveMetaPath({
		metaPath,
		outputDir: context.outputDir,
		outputExtension: context.outputExtension,
	});

	const finalExt = path.posix.extname(rootRelPathWithExt);
	const baseName = path.posix.basename(rootRelPathWithExt, finalExt);
	// path.posix.dirname always returns at least '.', so '.' is the only "no parent" sentinel.
	const parentDir = path.posix.dirname(rootRelPathWithExt);
	const filePathStem =
		'/' + (finalExt ? rootRelPathWithExt.slice(0, -finalExt.length) : rootRelPathWithExt);
	const url = '/' + rootRelPathWithExt.replace(/(?<=\/|^)index(?:\.[a-z]+)?$/, '');
	const fileSlug =
		baseName === 'index'
			? parentDir === '.'
				? ''
				: path.posix.basename(parentDir)
			: baseName;

	return {
		inputPath: file.inputPath,
		outputPath,
		fileSlug,
		filePathStem,
		extension: file.extension,
		date: file.date,
		url,
	};
}
