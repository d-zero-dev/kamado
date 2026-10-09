import { spawnSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import {
	checkPaths,
	differences,
	findNewlineLines,
	parseArguments,
	prune,
	pruneProject,
	removeLines,
	snapshot,
	tsxFiles,
} from './prune-jsx-newlines.mjs';

describe('findNewlineLines', () => {
	test('finds the lines that are only a newline expression, in either quote', () => {
		expect(
			findNewlineLines(['<a>', '\t{"\\n"}', "\t{'\\n'}  ", '\t{"\\n"}\r', '</a>']),
		).toEqual([1, 2, 3]);
	});

	test('leaves a newline expression that has other things on its line', () => {
		expect(findNewlineLines(['<a>{"\\n"}</a>', 'text {"\\n"}', '{"\\n" + x}'])).toEqual(
			[],
		);
	});

	test('leaves other expressions and a space', () => {
		expect(findNewlineLines(["{' '}", '{"\\t"}', '{x}'])).toEqual([]);
	});
});

describe('removeLines', () => {
	test('removes the lines at the indexes', () => {
		expect(removeLines(['a', 'b', 'c', 'd'], [1, 3])).toEqual(['a', 'c']);
	});

	test('keeps everything when there is nothing to remove', () => {
		expect(removeLines(['a', 'b'], [])).toEqual(['a', 'b']);
	});
});

describe('prune', () => {
	test('removes everything in one trial when the output stays', () => {
		const trials: number[][] = [];
		const removed = prune([1, 2, 3, 4], (items) => {
			trials.push([...items]);
			return true;
		});
		expect(removed).toEqual([1, 2, 3, 4]);
		expect(trials).toEqual([[1, 2, 3, 4]]);
	});

	test('keeps the items that the output needs and removes the rest', () => {
		const removed = prune(
			[1, 2, 3, 4, 5, 6],
			(items) => !items.includes(2) && !items.includes(5),
		);
		expect(removed).toEqual([1, 3, 4, 6]);
	});

	test('keeps all when every item is needed', () => {
		expect(prune([1, 2, 3], (items) => items.length === 0)).toEqual([]);
	});

	test('finds an item that is only needed once another stays', () => {
		// 1 can go alone and 2 can go alone, but not both together.
		const removed = prune([1, 2], (items) => !(items.includes(1) && items.includes(2)));
		expect(removed).toEqual([1]);
	});

	test('does not try anything for no items', () => {
		let tried = 0;
		expect(
			prune([], () => {
				tried += 1;
				return true;
			}),
		).toEqual([]);
		expect(tried).toBe(0);
	});
});

describe('differences', () => {
	test('lists the changed, the added and the missing paths in order', () => {
		const reference = new Map([
			['a', '1'],
			['b', '1'],
			['c', '1'],
		]);
		const current = new Map([
			['a', '2'],
			['c', '1'],
			['d', '1'],
		]);
		expect(differences(reference, current)).toEqual(['a', 'b', 'd']);
	});

	test('is empty for the same snapshot', () => {
		const same = new Map([['a', '1']]);
		expect(differences(same, new Map(same))).toEqual([]);
	});
});

describe('parseArguments', () => {
	test('reads the project, the paths and the options', () => {
		expect(
			parseArguments([
				'site',
				'--output',
				'htdocs',
				'a',
				'b',
				'--cli',
				'cli.js',
				'--config',
				'k.jsonc',
				'--incremental',
			]),
		).toEqual({
			project: 'site',
			output: 'htdocs',
			paths: ['a', 'b'],
			cli: 'cli.js',
			config: 'k.jsonc',
			incremental: true,
		});
	});

	test('the options are optional but the output and a path are not', () => {
		expect(parseArguments(['site', '--output', 'out', 'a'])).toMatchObject({
			cli: undefined,
			config: undefined,
			incremental: false,
		});
		expect(() => parseArguments(['site', 'a'])).toThrow('usage:');
		expect(() => parseArguments(['site', '--output', 'out'])).toThrow('usage:');
		expect(() => parseArguments([])).toThrow('usage:');
	});

	test('an option may be written with an equals sign', () => {
		expect(parseArguments(['site', '--output=out', 'a'])).toMatchObject({
			output: 'out',
			paths: ['a'],
		});
	});

	test('an option that does not exist is an error, not a path', () => {
		expect(() =>
			parseArguments(['site', '--output', 'out', '--unknown-option', 'a']),
		).toThrow('usage:');
	});

	test('an option without its value does not take the next option as it', () => {
		expect(() => parseArguments(['site', 'a', '--output', '--incremental'])).toThrow(
			'usage:',
		);
	});
});

describe('checkPaths', () => {
	test('accepts an output directory and paths inside the project', () => {
		expect(() =>
			checkPaths('/work/site', 'htdocs', ['__assets', 'src/a.tsx']),
		).not.toThrow();
	});

	test('refuses an output directory that is the project or outside of it', () => {
		expect(() => checkPaths('/work/site', '.', ['src'])).toThrow('--output');
		expect(() => checkPaths('/work/site', '..', ['src'])).toThrow('--output');
		expect(() => checkPaths('/work/site', '/work/other', ['src'])).toThrow('--output');
	});

	test('refuses a path outside of the project', () => {
		expect(() => checkPaths('/work/site', 'out', ['../other'])).toThrow('outside');
		expect(() => checkPaths('/work/site', 'out', ['/work/other'])).toThrow('outside');
	});

	test('refuses a path that overlaps the output directory', () => {
		expect(() => checkPaths('/work/site', 'out', ['out/x'])).toThrow('overlap');
		expect(() => checkPaths('/work/site', 'out/x', ['out'])).toThrow('overlap');
		expect(() => checkPaths('/work/site', 'out', ['.'])).toThrow('overlap');
	});

	test('a directory that only starts with the same letters is not the same', () => {
		expect(() => checkPaths('/work/site', 'out', ['outer'])).not.toThrow();
	});
});

// The build is a stand-in script: it covers the search, the writing back, the comparison
// with the reference and the failures. What the HTML printer of kamado does with the
// white space is not here: that is only seen by a real build of a real project.
describe('with files', () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'prune-jsx-newlines-'));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/**
	 * A stand-in for `kamado build`, run in the project directory: the output of each
	 * `src/*.tsx` is the page without its newline lines, except for one right after a
	 * `<button` line (the one that matters). `extra` is added to the script.
	 * @param extra - More of the script, which may exit or change what is written
	 */
	const writeCli = (extra = '') => {
		const cli = path.join(root, 'cli.mjs');
		writeFileSync(
			cli,
			`import fs from 'node:fs';
import path from 'node:path';
const NEWLINE = /^\\s*\\{"\\\\n"\\}\\s*\\r?$/;
const incremental = process.argv.includes('--incremental');
${extra}
fs.mkdirSync('out', { recursive: true });
for (const name of fs.readdirSync('src')) {
	if (!name.endsWith('.tsx')) continue;
	const lines = fs.readFileSync(path.join('src', name), 'utf8').split('\\n');
	const kept = lines.filter((line, i) => !NEWLINE.test(line) || /<button/.test(lines[i - 1] ?? ''));
	fs.writeFileSync(path.join('out', name.replace('.tsx', '.html')), kept.join('\\n'));
}
`,
		);
		return cli;
	};

	const project = () => {
		const dir = path.join(root, 'project');
		mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
		return dir;
	};

	const read = (dir: string, name: string) =>
		readFileSync(path.join(dir, 'src', name), 'utf8');

	test('keeps the newline that the output needs and removes the others', () => {
		const dir = project();
		const page = [
			'<div>',
			'\t{"\\n"}',
			'\t<p>a</p>',
			'\t<button>b</button>',
			'\t{"\\n"}',
			'\t<button>c</button>',
			'\t{"\\n"}',
			'</div>',
			'',
		].join('\n');
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);

		const { files } = pruneProject({
			project: dir,
			output: 'out',
			paths: ['src'],
			cli: writeCli(),
		});

		expect(files).toEqual([{ file: path.join('src', 'page.tsx'), found: 3, removed: 1 }]);
		// Only the one after `<div>` can go: the other two follow a `<button` line.
		expect(read(dir, 'page.tsx')).toBe(
			[
				'<div>',
				'\t<p>a</p>',
				'\t<button>b</button>',
				'\t{"\\n"}',
				'\t<button>c</button>',
				'\t{"\\n"}',
				'</div>',
				'',
			].join('\n'),
		);
	});

	test('a second run removes nothing and leaves the output unchanged', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'x.tsx'), '<a>\n\t{"\\n"}\n</a>\n');
		writeFileSync(path.join(dir, 'src', 'y.tsx'), '<button>\n\t{"\\n"}\n</button>\n');
		const cli = writeCli();
		const run = () => pruneProject({ project: dir, output: 'out', paths: ['src'], cli });
		// The output before any pruning.
		spawnSync(process.execPath, [cli, 'build', '--force'], { cwd: dir });
		const before = snapshot(path.join(dir, 'out'));

		const first = run();
		const second = run();

		expect(first.files).toEqual([
			{ file: path.join('src', 'x.tsx'), found: 1, removed: 1 },
			{ file: path.join('src', 'y.tsx'), found: 1, removed: 0 },
		]);
		expect(second.files).toEqual([
			{ file: path.join('src', 'y.tsx'), found: 1, removed: 0 },
		]);
		expect(read(dir, 'x.tsx')).toBe('<a>\n</a>\n');
		expect(differences(before, snapshot(path.join(dir, 'out')))).toEqual([]);
	});

	test('keeps the line endings of a file with CRLF', () => {
		const dir = project();
		writeFileSync(
			path.join(dir, 'src', 'page.tsx'),
			'<div>\r\n\t{"\\n"}\r\n\t<button>b</button>\r\n\t{"\\n"}\r\n</div>\r\n',
		);

		pruneProject({ project: dir, output: 'out', paths: ['src'], cli: writeCli() });

		expect(read(dir, 'page.tsx')).toBe(
			'<div>\r\n\t<button>b</button>\r\n\t{"\\n"}\r\n</div>\r\n',
		);
	});

	test('a trial whose build fails counts as a change', () => {
		const dir = project();
		const page = '<button>b</button>\n{"\\n"}\n<p>p</p>\n';
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);
		// A syntax error stand-in: the build fails when the line after the button is gone.
		const extra = `const lines = fs.readFileSync('src/page.tsx', 'utf8').split('\\n');
if (lines[1] !== '{"\\\\n"}') process.exit(1);`;

		pruneProject({ project: dir, output: 'out', paths: ['src'], cli: writeCli(extra) });

		expect(read(dir, 'page.tsx')).toBe(page);
	});

	test('a project that does not build is refused, with the end of its output', () => {
		const dir = project();
		const page = '<a>\n\t{"\\n"}\n</a>\n';
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);
		const cli = path.join(root, 'broken.mjs');
		writeFileSync(cli, 'console.error("config: unknown key"); process.exit(1);\n');

		expect(() =>
			pruneProject({ project: dir, output: 'out', paths: ['src'], cli }),
		).toThrow(/does not build as it is:\nconfig: unknown key/);
		expect(read(dir, 'page.tsx')).toBe(page);
	});

	test('an output that differs between two builds cannot be the reference', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'page.tsx'), '<a>\n\t{"\\n"}\n</a>\n');
		const extra = `const counter = path.join('count.txt');
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) + 1 : 0;
fs.writeFileSync(counter, String(n));
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync('out/stamp.txt', String(n));`;

		expect(() =>
			pruneProject({ project: dir, output: 'out', paths: ['src'], cli: writeCli(extra) }),
		).toThrow(/not the same for two builds.*stamp\.txt/);
	});

	test('a build that is stopped puts the files back as they were', () => {
		const dir = project();
		const page = '<div>\n\t{"\\n"}\n\t<p>a</p>\n</div>\n';
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);
		// The two builds of the reference see the newline line; the first trial does not.
		const extra = `if (!fs.readFileSync('src/page.tsx', 'utf8').includes('{"\\\\n"}')) process.kill(process.pid, 'SIGINT');`;

		expect(() =>
			pruneProject({ project: dir, output: 'out', paths: ['src'], cli: writeCli(extra) }),
		).toThrow('stopped by SIGINT');
		expect(read(dir, 'page.tsx')).toBe(page);
	});

	test('a stale incremental trial is caught by the full check and the files are put back', () => {
		const dir = project();
		const page = '<button>b</button>\n{"\\n"}\n';
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);
		// An incremental build that does not notice the change: it leaves the output as it was.
		const extra = `if (incremental) process.exit(0);`;

		expect(() =>
			pruneProject({
				project: dir,
				output: 'out',
				paths: ['src'],
				cli: writeCli(extra),
				incremental: true,
			}),
		).toThrow('not the reference');
		expect(read(dir, 'page.tsx')).toBe(page);
	});

	test('passes the config to the build', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'page.tsx'), '<a>\n\t{"\\n"}\n</a>\n');
		// The build refuses to run without `--config` and its value.
		const extra = `const at = process.argv.indexOf('--config');
if (at === -1 || process.argv[at + 1] !== 'site.jsonc') process.exit(1);`;

		expect(() =>
			pruneProject({
				project: dir,
				output: 'out',
				paths: ['src'],
				cli: writeCli(extra),
				config: 'site.jsonc',
			}),
		).not.toThrow();
	});

	test('an empty output directory is refused, so that a wrong --output removes nothing', () => {
		const dir = project();
		const page = '<a>\n\t{"\\n"}\n</a>\n';
		writeFileSync(path.join(dir, 'src', 'page.tsx'), page);
		mkdirSync(path.join(dir, 'empty'));
		// The build writes nothing into `empty`.
		const extra = `process.exit(0);`;

		expect(() =>
			pruneProject({
				project: dir,
				output: 'empty',
				paths: ['src'],
				cli: writeCli(extra),
			}),
		).toThrow('output directory is empty');
		expect(read(dir, 'page.tsx')).toBe(page);
	});

	test('builds in full by default and incrementally on request', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'page.tsx'), '<a>\n\t{"\\n"}\n</a>\n');
		// Each build adds the arguments it got to a log outside of the output.
		const extra = `fs.appendFileSync('args.log', process.argv.slice(2).join(' ') + '\\n');`;
		const cli = writeCli(extra);
		const run = (incremental: boolean) => {
			rmSync(path.join(dir, 'args.log'), { force: true });
			pruneProject({ project: dir, output: 'out', paths: ['src'], cli, incremental });
			return readFileSync(path.join(dir, 'args.log'), 'utf8').trimEnd().split('\n');
		};

		// Two builds make the reference, one is the trial, and one checks the result.
		expect(run(false)).toEqual([
			'build --force',
			'build --force',
			'build --force',
			'build --force',
		]);
		writeFileSync(path.join(dir, 'src', 'page.tsx'), '<a>\n\t{"\\n"}\n</a>\n');
		// The reference and the check after pruning are full builds either way.
		expect(run(true)).toEqual([
			'build --force',
			'build --force',
			'build --incremental',
			'build --force',
		]);
	});

	test('an output directory that the build does not make is explained', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'page.tsx'), '<a>\n\t{"\\n"}\n</a>\n');

		expect(() =>
			pruneProject({ project: dir, output: 'missing', paths: ['src'], cli: writeCli() }),
		).toThrow('output directory does not exist');
	});

	test('tsxFiles takes the files and the directories, and skips node_modules', () => {
		const dir = project();
		mkdirSync(path.join(dir, 'src', 'node_modules', 'pkg'), { recursive: true });
		writeFileSync(path.join(dir, 'src', 'a.tsx'), '');
		writeFileSync(path.join(dir, 'src', 'b.ts'), '');
		writeFileSync(path.join(dir, 'src', 'nested', 'c.tsx'), '');
		writeFileSync(path.join(dir, 'src', 'node_modules', 'pkg', 'd.tsx'), '');

		expect(tsxFiles(dir, ['src']).map((f) => path.relative(dir, f))).toEqual([
			path.join('src', 'a.tsx'),
			path.join('src', 'nested', 'c.tsx'),
		]);
		expect(tsxFiles(dir, [path.join('src', 'a.tsx')])).toEqual([
			path.join(dir, 'src', 'a.tsx'),
		]);
	});

	test('tsxFiles does not follow a symbolic link, so a loop ends', () => {
		const dir = project();
		writeFileSync(path.join(dir, 'src', 'a.tsx'), '');
		symlinkSync(path.join(dir, 'src'), path.join(dir, 'src', 'loop'));
		symlinkSync(path.join(dir, 'src', 'a.tsx'), path.join(dir, 'src', 'link.tsx'));

		expect(tsxFiles(dir, ['src']).map((f) => path.relative(dir, f))).toEqual([
			path.join('src', 'a.tsx'),
		]);
	});
});
