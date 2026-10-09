/**
 * Removes the `{"\n"}` lines of converted TSX that do not change the output
 * (docs/v3/MIGRATION.md, §3.4).
 *
 * ```sh
 * node scripts/prune-jsx-newlines.mjs <project> --output <dir> <path>... [--cli <file>] [--config <file>] [--incremental]
 * ```
 *
 * Why: `pug-to-tsx.mjs --pretty` writes the white space of Pug's `pretty` as a
 * `{"\n"}` line before every tag that Pug does not count as inline. Most of them are
 * redundant (the HTML printer of the build, `kd_html`, breaks the line there anyway),
 * and the ones that matter cannot be told from the rest by a rule: it depends on the
 * decisions of that printer (the element around, whether the line fits). So the answer
 * is asked of the build: the output of the project is the oracle.
 *
 * How: it builds the project twice (the output must be the same both times) and keeps
 * that output as the reference. For each TSX file under the `<path>`s it removes all of
 * the `{"\n"}` lines, builds, and compares: the output must be byte for byte the
 * reference. When it is not, the lines are split in halves and tried again, so that the
 * lines that matter stay and the rest go (`prune`). A trial whose build fails counts as
 * a change. At the end it builds once more from the pruned sources and checks the
 * reference again.
 *
 * What to know:
 * - The files are rewritten in place: run it on a clean working tree. When it stops for
 *   any reason (an error, a failed check, Ctrl-C) the files are put back as they were.
 * - The reference is the output of the project as it is, not the output of the project
 *   before the migration: a difference that is already there stays.
 * - A file that the build does not read (an unused component, a page outside the input
 *   directory) cannot change the output, so all of its lines go. Look at such files by
 *   hand.
 * - The build runs the code of the project and of the `--cli`: run it on a project you
 *   trust.
 * - The cost is the number of builds, about `k * log(n / k)` per file with `k` lines that
 *   matter among `n`. `--incremental` makes each trial faster by trusting the cache of
 *   the build (a page that does not notice a change in a component it uses hides a
 *   needed line); the reference and the final check are always full builds, which
 *   catches that: it fails, and the files are put back.
 * - The files are visited one after another, and the lines of a file that stay are
 *   decided with the earlier files already pruned. The result is checked as a whole,
 *   but a second run may still remove a line that the first run kept.
 *
 * `<project>` is the directory of `kamado.config.jsonc`; `--output` (the output
 * directory) and the `<path>`s (files or directories to prune) are relative to it.
 * `--cli` is the `cli.js` of kamado (relative to where the command is run; by default
 * the one of the project's `node_modules`), `--config` is passed to `kamado build`
 * (relative to the project). The native addon is found as `kamado build` finds it (set
 * `KAMADO_NATIVE_ADDON` for a build of your own).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const NEWLINE_LINE = /^[ \t]*\{(['"])\\n\1\}[ \t]*\r?$/;
const USAGE =
	'usage: node scripts/prune-jsx-newlines.mjs <project> --output <dir> <path>... [--cli <file>] [--config <file>] [--incremental]';

/**
 * The indexes of the lines that are only a `{"\n"}` (or `{'\n'}`) expression.
 * @param {readonly string[]} lines - The lines of a file
 * @returns {number[]}
 * @example
 * findNewlineLines(['<a>', '  {"\\n"}', '</a>']); // [1]
 */
export function findNewlineLines(lines) {
	const found = [];
	for (const [index, line] of lines.entries()) {
		if (NEWLINE_LINE.test(line)) {
			found.push(index);
		}
	}
	return found;
}

/**
 * The lines without those at the indexes.
 * @param {readonly string[]} lines - The lines of a file
 * @param {readonly number[]} indexes - The lines to remove
 * @returns {string[]}
 * @example
 * removeLines(['a', 'b', 'c'], [1]); // ['a', 'c']
 */
export function removeLines(lines, indexes) {
	const gone = new Set(indexes);
	return lines.filter((_, index) => !gone.has(index));
}

/**
 * Finds the items that can go. A group is tried whole; when the output changes it is
 * split in halves, down to single items, which stay. Each trial removes the items that
 * were accepted before it, together with the group, so the last accepted trial is the
 * result as a whole (an item that is only needed once another stays is found too).
 * @template T
 * @param {readonly T[]} items - The candidates, in the order to try
 * @param {(removed: readonly T[]) => boolean} keepsOutput - Whether the output stays the
 * same with exactly these items removed
 * @returns {T[]} The items that can be removed
 * @example
 * prune([1, 2, 3, 4], (removed) => !removed.includes(3)); // [1, 2, 4]
 */
export function prune(items, keepsOutput) {
	/** @type {T[]} */
	const removed = [];
	/** @param {readonly T[]} group */
	const visit = (group) => {
		if (group.length === 0) {
			return;
		}
		if (keepsOutput([...removed, ...group])) {
			removed.push(...group);
			return;
		}
		if (group.length === 1) {
			return;
		}
		const half = group.length >> 1;
		visit(group.slice(0, half));
		visit(group.slice(half));
	};
	visit(items);
	return removed;
}

/**
 * Walks a directory (or takes a file) and calls `visit` with every file. A symbolic
 * link is not followed: it may loop, break, or lead out of the directory.
 * @param {string} start - A file or a directory
 * @param {(file: string) => void} visit - Called with each file
 * @param {(name: string) => boolean} [skip] - Whether to leave a directory entry out
 */
function walkFiles(start, visit, skip = () => false) {
	const stat = lstatSync(start);
	if (stat.isSymbolicLink()) {
		return;
	}
	if (!stat.isDirectory()) {
		visit(start);
		return;
	}
	for (const entry of readdirSync(start)) {
		if (!skip(entry)) {
			walkFiles(path.join(start, entry), visit, skip);
		}
	}
}

/**
 * A hash of every file under a directory, by the path relative to it.
 * @param {string} dir - The directory
 * @returns {Map<string, string>}
 * @example
 * snapshot('out'); // Map { 'index.html' => 'da39a3ee5e6b4b0d3255bfef95601890afd80709' }
 */
export function snapshot(dir) {
	if (!existsSync(dir)) {
		throw new Error(`the output directory does not exist after the build: ${dir}`);
	}
	/** @type {Map<string, string>} */
	const files = new Map();
	walkFiles(dir, (file) => {
		files.set(
			path.relative(dir, file),
			createHash('sha1').update(readFileSync(file)).digest('hex'),
		);
	});
	return files;
}

/**
 * The paths that are not the same in two snapshots (changed, added or missing).
 * @param {ReadonlyMap<string, string>} reference - The snapshot to keep
 * @param {ReadonlyMap<string, string>} current - The snapshot to check
 * @returns {string[]}
 * @example
 * differences(new Map([['a', '1']]), new Map([['a', '2'], ['b', '1']])); // ['a', 'b']
 */
export function differences(reference, current) {
	const paths = new Set([...reference.keys(), ...current.keys()]);
	return [...paths].filter((p) => reference.get(p) !== current.get(p)).toSorted();
}

/**
 * The `.tsx` files at the paths (a file, or the files under a directory;
 * `node_modules` and symbolic links are left out).
 * @param {string} project - The project directory
 * @param {readonly string[]} paths - Files or directories, relative to the project
 * @returns {string[]} Absolute paths, sorted
 * @example
 * tsxFiles('/work/site', ['__assets']); // ['/work/site/__assets/_libs/layouts/l-sub.tsx', ...]
 */
export function tsxFiles(project, paths) {
	/** @type {string[]} */
	const files = [];
	for (const p of paths) {
		walkFiles(
			path.resolve(project, p),
			(file) => {
				if (file.endsWith('.tsx')) {
					files.push(file);
				}
			},
			(name) => name === 'node_modules',
		);
	}
	return files.toSorted();
}

/**
 * Whether `child` is `parent` or below it.
 * @param {string} parent - A directory
 * @param {string} child - A path
 * @returns {boolean}
 */
function within(parent, child) {
	const relative = path.relative(parent, child);
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Refuses an output directory or paths that would make the oracle meaningless or write
 * out of the project.
 * @param {string} project - The project directory
 * @param {string} output - The output directory, relative to the project
 * @param {readonly string[]} paths - The files or directories to prune
 * @example
 * checkPaths('/work/site', 'htdocs', ['__assets']); // fine
 * checkPaths('/work/site', 'htdocs', ['..']); // throws: outside of the project
 */
export function checkPaths(project, output, paths) {
	const root = path.resolve(project);
	const outputDir = path.resolve(root, output);
	if (outputDir === root || !within(root, outputDir)) {
		throw new Error(`--output must be a directory inside the project: ${output}`);
	}
	for (const p of paths) {
		const resolved = path.resolve(root, p);
		if (!within(root, resolved)) {
			throw new Error(`the path is outside of the project: ${p}`);
		}
		if (within(outputDir, resolved) || within(resolved, outputDir)) {
			throw new Error(`the path and the output directory overlap: ${p}`);
		}
	}
}

/**
 * The last lines of a text, for an error message.
 * @param {string} text - Output of a command
 * @returns {string}
 */
function tail(text) {
	return text.trimEnd().split('\n').slice(-20).join('\n');
}

/**
 * Prunes the `{"\n"}` lines of the TSX files of a project. It throws when the project
 * does not build or its output is not the same for two builds, and when the check after
 * pruning fails; the files are then put back as they were.
 * @param {object} options - What to prune
 * @param {string} options.project - The project directory
 * @param {string} options.output - The output directory, relative to the project
 * @param {readonly string[]} options.paths - Files or directories to prune
 * @param {string} options.cli - The `cli.js` of kamado
 * @param {string} [options.config] - The config file for `kamado build`
 * @param {boolean} [options.incremental] - Build the trials with `--incremental`
 * @param {(message: string) => void} [options.log] - Progress
 * @returns {{ files: { file: string; found: number; removed: number }[]; builds: number }}
 * The lines found and removed per file, and the number of builds
 * @example
 * pruneProject({
 * 	project: '/work/site',
 * 	output: 'htdocs',
 * 	paths: ['__assets'],
 * 	cli: '/work/site/node_modules/kamado/dist/cli.js',
 * }); // { files: [{ file: '__assets/_libs/layouts/l-sub.tsx', found: 33, removed: 33 }], builds: 41 }
 */
export function pruneProject({
	project,
	output,
	paths,
	cli,
	config,
	incremental = false,
	log = () => {},
}) {
	checkPaths(project, output, paths);
	const outputDir = path.resolve(project, output);
	let builds = 0;
	/**
	 * Builds the project. A build that fails is `ok: false`; one that cannot run or is
	 * stopped (a missing `cli`, Ctrl-C, no memory) throws: it says nothing about the lines.
	 * @param {boolean} full - A full build (`--force`), not an incremental one
	 */
	const build = (full) => {
		builds += 1;
		const args = [cli, 'build', full ? '--force' : '--incremental'];
		if (config !== undefined) {
			args.push('--config', config);
		}
		const result = spawnSync(process.execPath, args, {
			cwd: project,
			encoding: 'utf8',
			maxBuffer: 1 << 28,
		});
		if (result.error) {
			throw result.error;
		}
		if (result.signal !== null) {
			throw new Error(`the build was stopped by ${result.signal}`);
		}
		return { ok: result.status === 0, stderr: `${result.stderr}${result.stdout}` };
	};

	const first = build(true);
	if (!first.ok) {
		throw new Error(`the project does not build as it is:\n${tail(first.stderr)}`);
	}
	const reference = snapshot(outputDir);
	if (reference.size === 0) {
		// Everything would "stay the same": a wrong `--output` must not remove every line.
		throw new Error(`the output directory is empty after the build: ${output}`);
	}
	const second = build(true);
	if (!second.ok) {
		throw new Error(`the project does not build as it is:\n${tail(second.stderr)}`);
	}
	const unstable = differences(reference, snapshot(outputDir));
	if (unstable.length > 0) {
		throw new Error(
			`the output is not the same for two builds of the same sources, so it cannot be the reference: ${unstable.slice(0, 10).join(', ')}`,
		);
	}
	/** @param {boolean} full */
	const sameOutput = (full) => {
		return build(full).ok && differences(reference, snapshot(outputDir)).length === 0;
	};

	/** @type {Map<string, string>} */
	const originals = new Map();
	/** @type {{ file: string; found: number; removed: number }[]} */
	const files = [];
	try {
		for (const file of tsxFiles(project, paths)) {
			const original = readFileSync(file, 'utf8');
			const lines = original.split('\n');
			const found = findNewlineLines(lines);
			if (found.length === 0) {
				continue;
			}
			originals.set(file, original);
			const removed = prune(found, (indexes) => {
				writeFileSync(file, removeLines(lines, indexes).join('\n'));
				return sameOutput(!incremental);
			});
			writeFileSync(file, removeLines(lines, removed).join('\n'));
			const name = path.relative(project, file);
			files.push({ file: name, found: found.length, removed: removed.length });
			log(`${name}: removed ${removed.length} of ${found.length}`);
		}
		// The last trial of a file may have been a rejected one, and an incremental trial
		// may have trusted a stale cache: build what is on disk now in full.
		if (!sameOutput(true)) {
			throw new Error('the output of the pruned sources is not the reference');
		}
	} catch (error) {
		for (const [file, text] of originals) {
			writeFileSync(file, text);
		}
		throw error;
	}
	return { files, builds };
}

/**
 * Reads the command line.
 * @param {readonly string[]} argv - The arguments after the script
 * @returns {{ project: string; output: string; paths: string[]; cli: string | undefined; config: string | undefined; incremental: boolean }}
 * @example
 * parseArguments(['site', '--output', 'htdocs', '__assets']);
 * // { project: 'site', output: 'htdocs', paths: ['__assets'], cli: undefined, config: undefined, incremental: false }
 */
export function parseArguments(argv) {
	let parsed;
	try {
		parsed = parseArgs({
			args: [...argv],
			allowPositionals: true,
			strict: true,
			options: {
				output: { type: 'string' },
				cli: { type: 'string' },
				config: { type: 'string' },
				incremental: { type: 'boolean', default: false },
			},
		});
	} catch (error) {
		throw new Error(`${/** @type {Error} */ (error).message}\n${USAGE}`, {
			cause: error,
		});
	}
	const [project, ...paths] = parsed.positionals;
	const { output, cli, config, incremental } = parsed.values;
	if (!project || !output || paths.length === 0) {
		throw new Error(USAGE);
	}
	return { project, output, paths, cli, config, incremental: incremental === true };
}

/**
 * The `cli.js` of the kamado that the project has.
 * @param {string} project - The project directory
 * @returns {string}
 */
function projectCli(project) {
	const require = createRequire(path.join(path.resolve(project), 'package.json'));
	return path.join(path.dirname(require.resolve('kamado')), 'cli.js');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		const args = parseArguments(process.argv.slice(2));
		const project = path.resolve(args.project);
		const started = Date.now();
		const { files, builds } = pruneProject({
			project,
			output: args.output,
			paths: args.paths,
			// The build runs in the project directory: `--cli` is made absolute here, from where
			// the command was started. `--config` is read by the build, so it is relative to the
			// project.
			cli: args.cli === undefined ? projectCli(project) : path.resolve(args.cli),
			config: args.config,
			incremental: args.incremental,
			log: console.log,
		});
		const found = files.reduce((sum, f) => sum + f.found, 0);
		const removed = files.reduce((sum, f) => sum + f.removed, 0);
		console.log(
			`removed ${removed} of ${found} lines in ${files.length} files (${builds} builds, ${((Date.now() - started) / 1000).toFixed(1)}s)`,
		);
	} catch (error) {
		console.error(/** @type {Error} */ (error).message);
		process.exit(1);
	}
}
