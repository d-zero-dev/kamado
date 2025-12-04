import fs from 'node:fs/promises';

import esbuild from 'esbuild';

import { createBanner, type CreateBanner } from './banner.js';

import { createCompiler } from './index.js';

export interface ScriptCompilerOptions {
	readonly alias?: Record<string, string>;
	readonly minifier?: boolean;
	readonly banner?: CreateBanner | string;
}

export const scriptCompiler = createCompiler<ScriptCompilerOptions>((options) => () => {
	return async (file) => {
		const banner =
			typeof options?.banner === 'string'
				? options.banner
				: createBanner(options?.banner?.());
		await esbuild.build({
			entryPoints: [file.inputPath],
			bundle: true,
			alias: options?.alias,
			outfile: file.outputPath,
			minify: options?.minifier,
			charset: 'utf8',
			banner: {
				js: banner,
			},
		});
		return await fs.readFile(file.outputPath, 'utf8');
	};
});
