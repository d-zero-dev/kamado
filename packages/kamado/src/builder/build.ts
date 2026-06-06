import type { UserConfig, Context } from '../config/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { deal } from '@d-zero/dealer';
import c from 'ansi-colors';

import { createCompileFunctions } from '../compiler/compile-functions.js';
import { createCompiler } from '../compiler/create-compiler.js';
import { createCompileFunctionMap } from '../compiler/function-map.js';
import { mergeConfig } from '../config/merge-config.js';
import { clearAssetGroupCache, getAssetGroup } from '../data/get-asset-group.js';
import { clearGlobalDataCache } from '../data/get-global-data.js';
import { clearFileContentCache } from '../files/file-content.js';
import { filePathColorizer } from '../stdout/color.js';

/**
 * Build configuration options
 */
interface BuildConfig {
	/**
	 * Project root directory
	 */
	readonly rootDir?: string;
	/**
	 * Glob pattern for build targets
	 */
	readonly targetGlob?: string;
	/**
	 * Whether to enable verbose logging
	 */
	readonly verbose?: boolean;
	/**
	 * Whether to skip writing output files whose content is unchanged.
	 * Compares the new content against the existing output file; when equal,
	 * the write is skipped and the existing file's mtime is preserved
	 * (useful for mtime-based deployment diffing).
	 * @default false
	 */
	readonly skipUnchanged?: boolean;
}

/**
 * Builds the project
 * @param buildConfig - Build configuration (merge of UserConfig and BuildConfig)
 * @param buildConfig.rootDir - Project root directory
 * @param buildConfig.targetGlob - Glob pattern for build targets
 * @param buildConfig.verbose - Whether to enable verbose logging
 */
export async function build<M extends MetaData>(
	buildConfig: UserConfig<M> & BuildConfig,
) {
	// Each build starts from a clean slate: re-enumerate files and re-read
	// file contents and global data so that source edits between consecutive
	// builds in the same process are always reflected
	clearAssetGroupCache();
	clearFileContentCache();
	clearGlobalDataCache();

	const config = await mergeConfig(buildConfig, buildConfig.rootDir);

	// Create execution context
	const context: Context<M> = {
		...config,
		mode: 'build',
	};

	const startTime = Date.now();

	if (context.onBeforeBuild && buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('Before build...');
	}
	await context.onBeforeBuild?.(context);

	if (buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('Build started...');
	}

	const compileFunctionMap = await createCompileFunctionMap(context);
	const compile = createCompiler({ ...context, compileFunctionMap });

	const compilers = createCompileFunctions(context);

	const fileArrays = await Promise.all(
		compilers.map((compilerEntry) =>
			getAssetGroup(
				{
					inputDir: context.dir.input,
					outputDir: context.dir.output,
					compilerEntry,
				},
				{ glob: buildConfig.targetGlob },
			),
		),
	);
	const allFiles = fileArrays.flat();

	const f = filePathColorizer(context.dir.input);

	const CHECK_MARK = c.green('✔');

	// Tracks directories already ensured in this build to avoid redundant mkdir
	// calls. mkdir with recursive:true is idempotent, so a rare duplicate from
	// concurrent tasks is harmless.
	const ensuredDirs = new Set<string>();

	await deal<CompilableFile>(
		allFiles,
		(file, log, _, setLineHeader) => {
			const cPath = f(file.inputPath);
			setLineHeader(`${c.cyan('%braille%')} ${cPath} `);

			return async () => {
				const content = await compile(file, log);

				const buffer =
					typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content);

				if (buildConfig.skipUnchanged) {
					// Cheap size check first; read the file only when sizes match
					const stat = await fs.stat(file.outputPath).catch(() => null);
					if (stat && stat.size === buffer.byteLength) {
						const existing = await fs.readFile(file.outputPath).catch(() => null);
						if (existing && existing.equals(buffer)) {
							log(`${CHECK_MARK} Unchanged`);
							return;
						}
					}
				}

				log(c.yellow('Writing...'));
				const outputDir = path.dirname(file.outputPath);
				if (!ensuredDirs.has(outputDir)) {
					await fs.mkdir(outputDir, { recursive: true });
					ensuredDirs.add(outputDir);
				}

				await fs.writeFile(file.outputPath, buffer);

				log(`${CHECK_MARK} Compiled!`);
			};
		},
		{
			header: (progress, done, total) =>
				progress === 1
					? `${CHECK_MARK} Built! ${done}/${total}`
					: `Building%dots% ${done}/${total}`,
			verbose: buildConfig.verbose,
		},
	);

	if (context.onAfterBuild && buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('After build...');
	}
	await context.onAfterBuild?.(context);

	const endTime = Date.now();
	// eslint-disable-next-line no-console
	console.log(`Build completed in ${((endTime - startTime) / 1000).toFixed(2)}s`);
}
