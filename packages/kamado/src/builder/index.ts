import type { UserConfig } from '../config/types.js';
import type { CompilableFile } from '../files/types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { deal } from '@d-zero/dealer';
import c from 'ansi-colors';

import { createCompileFunctionMap } from '../compiler/function-map.js';
import { mergeConfig } from '../config/merge.js';
import { getAssetGroup } from '../data/assets.js';
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
export async function build(buildConfig: UserConfig & BuildConfig) {
	const config = await mergeConfig(buildConfig, buildConfig.rootDir);

	const startTime = Date.now();

	if (config.onBeforeBuild && buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('Before build...');
	}
	await config.onBeforeBuild?.(config);

	if (buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('Build started...');
	}

	const styleSheetFiles = await getAssetGroup('style', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
		glob: buildConfig.targetGlob,
	});

	const jsFiles = await getAssetGroup('script', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
		glob: buildConfig.targetGlob,
	});

	const pages = await getAssetGroup('page', {
		inputDir: config.dir.input,
		outputDir: config.dir.output,
		extensions: config.extensions,
		glob: buildConfig.targetGlob,
	});

	const compileFunctionMap = await createCompileFunctionMap(config);

	const f = filePathColorizer({
		rootDir: config.dir.input,
	});

	const CHECK_MARK = c.green('✔');

	await deal<CompilableFile>(
		[...pages, ...styleSheetFiles, ...jsFiles],
		(file, log, _, setLineHeader) => {
			const cPath = f(file.inputPath);
			setLineHeader(`${c.cyan('%braille%')} ${cPath} `);

			return async () => {
				let content: string | ArrayBuffer;

				const compile = compileFunctionMap.get(file.outputFileType);
				if (compile) {
					content = await compile(file, log);
				} else {
					const { raw } = await file.get();
					content = raw;
				}

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

	if (config.onAfterBuild && buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('After build...');
	}
	await config.onAfterBuild?.(config);

	const endTime = Date.now();
	// eslint-disable-next-line no-console
	console.log(`Build completed in ${((endTime - startTime) / 1000).toFixed(2)}s`);
}
