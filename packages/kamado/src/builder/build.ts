import type { UserConfig, Context } from '../config/types.js';
import type { CompilableFile, MetaData } from '../files/types.js';

import fs from 'node:fs/promises';
import path from 'node:path';

import { deal } from '@d-zero/dealer';
import c from 'ansi-colors';

import { hashContent } from '../compiler/cache-digest.js';
import { createCompileFunctions } from '../compiler/compile-functions.js';
import { createCompiler } from '../compiler/create-compiler.js';
import { createCompileFunctionMap } from '../compiler/function-map.js';
import { mergeConfig } from '../config/merge-config.js';
import { clearBuildCaches } from '../data/clear-build-caches.js';
import { getAssetGroup } from '../data/get-asset-group.js';
import { collectDependencies } from '../files/dependency-tracker.js';
import { filePathColorizer } from '../stdout/color.js';

import {
	BUILD_MANIFEST_VERSION,
	createFileHasher,
	loadBuildManifest,
	saveBuildManifest,
	type BuildManifestEntry,
} from './build-manifest.js';

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
	/**
	 * Whether to skip compiling outputs whose recorded inputs are unchanged.
	 * Each build records a verifying trace per output (input file hash, every
	 * dependency's hash, and the compiler's environment digest) in
	 * `.kamado/cache/build-manifest.json`; the next incremental build skips
	 * the entire compilation when all of them still match and the output file
	 * is present. Compilers must read files through kamado's file APIs or
	 * report extra inputs via `trackDependency()` — the bundled compilers do.
	 * @default false
	 */
	readonly incremental?: boolean;
	/**
	 * Path to the kamado config file. When set with `incremental`, the config
	 * file's content hash joins the environment digest, so config edits
	 * invalidate the whole cache. The CLI passes this automatically.
	 */
	readonly configFilePath?: string;
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
	clearBuildCaches();

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

	// Incremental build state: the previous manifest's verifying traces, the
	// environment digest per output extension, and a per-build file hasher
	const incremental = buildConfig.incremental
		? {
				previous: await loadBuildManifest(context.dir.root),
				next: {} as Record<string, BuildManifestEntry>,
				envByExt: new Map<string, string>(),
				hashFile: createFileHasher(),
			}
		: undefined;
	if (incremental) {
		const configContent = buildConfig.configFilePath
			? await fs.readFile(buildConfig.configFilePath, 'utf8').catch(() => '')
			: '';
		const configHash = hashContent(configContent);
		for (const [extension, compileFunction] of compileFunctionMap) {
			const digest = await compileFunction.cacheDigest?.();
			incremental.envByExt.set(extension, hashContent(`${digest ?? ''}\0${configHash}`));
		}
	}
	// Files without a compiler are raw copies: their output depends only on
	// the input bytes, never on config or compiler options
	const RAW_ENV = 'raw';

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
				const env = incremental
					? (incremental.envByExt.get(path.extname(file.outputPath)) ?? RAW_ENV)
					: '';

				if (incremental) {
					// Verifying trace: skip the whole compilation when the previous
					// entry's environment, input, every dependency hash, and the
					// output file still match.
					const entry = incremental.previous?.entries[file.outputPath];
					if (
						entry &&
						entry.env === env &&
						entry.inputPath === file.inputPath &&
						// Entries without recorded dependencies never skip — a
						// compiler that bypasses kamado's file APIs gives us nothing
						// to verify against.
						Object.keys(entry.deps).length > 0
					) {
						// Output verification is size-only (no content compare): an
						// externally-modified output of the same byte length is NOT
						// detected here. Pair --incremental with --skip-unchanged when
						// outputs may be touched out of band.
						const stat = await fs.stat(file.outputPath).catch(() => null);
						if (stat && stat.size === entry.outputSize) {
							// Hash every dependency in parallel; the memoized hasher
							// dedupes shared layouts/partials across files
							const matches = await Promise.all(
								Object.entries(entry.deps).map(
									async ([dep, recorded]) =>
										(await incremental.hashFile(dep)) === recorded,
								),
							);
							if (matches.every(Boolean)) {
								incremental.next[file.outputPath] = entry;
								log(`${CHECK_MARK} Cached`);
								return;
							}
						}
					}
				}

				let content: string | ArrayBuffer;
				let dependencies: Set<string> | undefined;
				if (incremental) {
					// Dependencies are hashed from disk after the compile finishes,
					// not at the instant each was read, so editing a source file
					// mid-build is unsupported (the recorded hash may describe newer
					// content than the output embeds). A normal end-to-end build does
					// not race itself; the dev server never takes this path.
					({ result: content, dependencies } = await collectDependencies(() =>
						compile(file, log),
					));
				} else {
					content = await compile(file, log);
				}

				// Allocated lazily: the size precheck needs only the byte length,
				// and fs.writeFile accepts strings directly
				const toWritable = () =>
					typeof content === 'string' ? Buffer.from(content) : new Uint8Array(content);

				const byteLength =
					typeof content === 'string' ? Buffer.byteLength(content) : content.byteLength;

				const recordEntry = async () => {
					if (!incremental || !dependencies) {
						return;
					}
					// Hash all dependencies in parallel, then build the record with
					// keys in sorted order so the persisted manifest is byte-stable
					const hashed = await Promise.all(
						[...dependencies]
							.toSorted()
							.map(async (dep) => [dep, await incremental.hashFile(dep)] as const),
					);
					incremental.next[file.outputPath] = {
						inputPath: file.inputPath,
						deps: Object.fromEntries(hashed),
						env,
						outputSize: byteLength,
					};
				};

				if (buildConfig.skipUnchanged) {
					// Cheap size check first (no allocation); read the file only
					// when sizes match
					const stat = await fs.stat(file.outputPath).catch(() => null);
					if (stat && stat.size === byteLength) {
						const existing = await fs.readFile(file.outputPath).catch(() => null);
						if (existing && existing.equals(toWritable())) {
							await recordEntry();
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

				await fs.writeFile(
					file.outputPath,
					typeof content === 'string' ? content : new Uint8Array(content),
				);

				await recordEntry();
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

	if (incremental) {
		// A partial build (targetGlob) revalidates only the targeted files, so
		// carry the other entries over; a full build replaces the manifest, which
		// also prunes entries for deleted sources
		const entries = buildConfig.targetGlob
			? { ...incremental.previous?.entries, ...incremental.next }
			: incremental.next;
		await saveBuildManifest(context.dir.root, {
			version: BUILD_MANIFEST_VERSION,
			entries,
		});
	}

	if (context.onAfterBuild && buildConfig.verbose) {
		// eslint-disable-next-line no-console
		console.log('After build...');
	}
	await context.onAfterBuild?.(context);

	const endTime = Date.now();
	// eslint-disable-next-line no-console
	console.log(`Build completed in ${((endTime - startTime) / 1000).toFixed(2)}s`);
}
