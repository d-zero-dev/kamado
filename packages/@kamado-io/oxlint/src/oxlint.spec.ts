/**
 * The plugin in the oxlint that people run: its own parser of TypeScript and JSX, the plugin
 * found by the name of its package (so the `exports` of the package are read, and `dist/` is
 * what is loaded), the rules with their prefix, and `overrides`. The specs of each rule go
 * through ESLint and cannot parse TypeScript; what is TypeScript only is shown here.
 *
 * The files of `fixtures/app/` say what is expected of them. A line that ends in
 * `// ✗ rule` is reported by that rule; a line that is only `// ✗ rule` is about the line
 * after it (for the places where a formatter moves a comment at the end of a line). A line
 * with no mark is not reported. `yarn build` comes before `yarn test`.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, test } from 'vitest';

import plugin from './index.js';

const run = promisify(execFile);
const require = createRequire(import.meta.url);
const OXLINT = path.join(
	path.dirname(require.resolve('oxlint/package.json')),
	'bin',
	'oxlint',
);
const PACKAGE = path.resolve(import.meta.dirname, '..');
const APP = path.join(PACKAGE, 'fixtures', 'app');

/** One report of oxlint. */
interface Report {
	readonly file: string;
	readonly line: number;
	readonly rule: string;
}

/**
 * Runs oxlint in the fixtures with a config, and reads its reports of this plugin.
 * @param config - The config file, relative to `fixtures/app`
 * @param paths - What to lint, relative to `fixtures/app`
 * @returns The reports, in the order of the file and the line
 */
async function oxlint(config: string, ...paths: string[]): Promise<Report[]> {
	let stdout: string;
	let stderr: string;
	let code = 0;
	try {
		({ stdout, stderr } = await run(
			process.execPath,
			[OXLINT, '-c', config, '--format', 'unix', ...paths],
			{ cwd: APP },
		));
	} catch (error) {
		const failed = error as { code?: number; stdout?: string; stderr?: string };
		({ stdout = '', stderr = '' } = failed);
		code = failed.code ?? -1;
	}
	// Exit code 1 means more than "reported something": a file that does not parse and a plugin
	// that cannot be loaded are 1 as well, and print nothing of this plugin. So what is printed
	// is read for all it says, and a report that is not of this plugin, or a 1 with no report of
	// it, is a failure of the test and not "nothing reported".
	const lines = stdout.split('\n');
	const reports = lines.flatMap((text) => {
		const match =
			/^(.+?):(\d+):\d+: .* \[(?:Error|Warning)\/@kamado-io\(([\w-]+)\)\]$/.exec(text);
		return match ? [{ file: match[1]!, line: Number(match[2]), rule: match[3]! }] : [];
	});
	const printed = lines.filter((text) =>
		/\[(?:Error|Warning)(?:\/[^\]]*)?\]$/.test(text),
	);
	if (printed.length !== reports.length || (code !== 0 && reports.length === 0)) {
		throw new Error(
			`oxlint did not lint as expected (exit ${code}):\n${stdout}\n${stderr}`,
		);
	}
	return sorted(reports);
}

/**
 * What the marks in a fixture expect.
 * @param file - The fixture, relative to `fixtures/app`
 * @returns The reports that the marks ask for
 */
function expectedIn(file: string): Report[] {
	const expected: Report[] = [];
	let about: string | undefined;
	for (const [index, text] of readFileSync(path.join(APP, file), 'utf8')
		.split('\n')
		.entries()) {
		const alone = /^\s*\/\/ ✗ ([\w-]+)\s*$/.exec(text);
		if (alone) {
			about = alone[1];
			continue;
		}
		const rule = about ?? /\/\/ ✗ ([\w-]+)\s*$/.exec(text)?.[1];
		about = undefined;
		if (rule) {
			expected.push({ file, line: index + 1, rule });
		}
	}
	return sorted(expected);
}

/**
 * @param reports - Reports
 * @returns The same, by file, line and rule
 */
function sorted(reports: Report[]): Report[] {
	return reports.toSorted(
		(a, b) =>
			a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule),
	);
}

beforeAll(() => {
	if (!existsSync(path.join(PACKAGE, 'dist', 'index.js'))) {
		throw new Error('dist/ is not built: run yarn build first');
	}
});

describe('the plugin in oxlint', () => {
	test('reports what the fixture marks, and every rule is in the fixture', async () => {
		const reports = await oxlint('.oxlintrc.json', 'src/invalid.tsx');

		expect(reports).toStrictEqual(expectedIn('src/invalid.tsx'));
		expect(new Set(reports.map((report) => report.rule))).toStrictEqual(
			new Set(Object.keys(plugin.rules)),
		);
	});

	test('reports nothing in TypeScript that is allowed: type imports, hooks of props, strings in <html static>', async () => {
		expect(await oxlint('.oxlintrc.json', 'src/valid.tsx')).toStrictEqual([]);
	});

	test('a file of data.dir may read, fetch and wait when its config switches the two rules off', async () => {
		expect(await oxlint('.oxlintrc.json', 'data')).toStrictEqual([]);

		const without = await oxlint('all-rules.oxlintrc.json', 'data');
		expect(new Set(without.map((report) => report.rule))).toStrictEqual(
			new Set(['no-async-component', 'no-untracked-input']),
		);
	});

	test('what oxlint cannot lint is a failure of the test, not "nothing reported"', async () => {
		const dir = await mkdtemp(path.join(tmpdir(), 'kamado-oxlint-'));
		try {
			const broken = path.join(dir, 'broken.tsx');
			await writeFile(broken, 'const = ;\n');
			await expect(oxlint('.oxlintrc.json', broken)).rejects.toThrow(
				'did not lint as expected',
			);

			const missing = path.join(dir, 'missing-plugin.json');
			await writeFile(
				missing,
				JSON.stringify({ jsPlugins: ['@kamado-io/does-not-exist'] }),
			);
			await expect(oxlint(missing, 'src/valid.tsx')).rejects.toThrow(
				'did not lint as expected',
			);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	test('the config as a TypeScript file does the same as the JSON one', async () => {
		expect(await oxlint('oxlint.config.mts', 'src', 'data')).toStrictEqual(
			await oxlint('.oxlintrc.json', 'src', 'data'),
		);
	});
});
