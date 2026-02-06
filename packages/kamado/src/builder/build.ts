import type { UserConfig, Context } from '../config/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { deal } from '@d-zero/dealer';
import c from 'ansi-colors';

import { createCompiler } from '../compiler/create-compiler.js';
import { createCompileFunctionMap } from '../compiler/function-map.js';
import { mergeConfig } from '../config/merge-config.js';
import { getAssetGroup } from '../data/get-asset-group.js';
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

	const fileArrays = await Promise.all(
		context.compilers.map((compilerEntry) =>
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

	await deal<CompilableFile>(
		allFiles,
		(file, log, _, setLineHeader) => {
			const cPath = f(file.inputPath);
			setLineHeader(`${c.cyan('%braille%')} ${cPath} `);

			return async () => {
				const content = await compile(file, log);

				log(c.yellow('Writing...'));
				await fs.mkdir(path.dirname(file.outputPath), { recursive: true });

				const buffer = typeof content === 'string' ? content : new Uint8Array(content);
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
