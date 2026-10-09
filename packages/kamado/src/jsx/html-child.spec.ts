import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { html, Markup } from './runtime.js';

// The type of what `html()` returns is checked by the compiler on a small TSX file, with
// the types of React that a project has, against the source of the runtime (not the build,
// which may be missing or old). The JSX of the file is typed by `@types/react`: without
// them every element is an error (TS7026) of the strict settings, so a pass proves that
// `{html(text)}` fits the type of a child.
const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const runtime = path.resolve(import.meta.dirname, 'runtime.ts');
const compiler = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const available =
	existsSync(compiler) &&
	existsSync(path.join(repo, 'node_modules', '@types', 'react')) &&
	existsSync(path.join(repo, 'node_modules', '@types', 'node'));

describe('the value of html()', () => {
	test('is a Markup that holds the text as it is', () => {
		const child = html('<b>x</b>');
		expect(child).toBeInstanceOf(Markup);
		expect((child as unknown as Markup).html).toBe('<b>x</b>');
	});

	test('has no type, props or key at runtime', () => {
		const child = html('x') as unknown as Record<string, unknown>;
		expect(child.type).toBeUndefined();
		expect(child.props).toBeUndefined();
		expect(child.key).toBeUndefined();
	});
});

describe.skipIf(!available)('the type of html() on a TSX file', () => {
	let root: string;

	/**
	 * Compiles a TSX file with the strictest settings and the types of React.
	 * @param source - The TSX file
	 * @returns Whether the compiler accepted it (its exit status), and what it said
	 */
	const compile = (source: string) => {
		writeFileSync(path.join(root, 'check.tsx'), source);
		try {
			execFileSync(process.execPath, [compiler, '-p', root], {
				encoding: 'utf8',
				stdio: 'pipe',
			});
			return { ok: true, output: '' };
		} catch (error) {
			const { status, stdout } = error as { status?: number; stdout?: string };
			return { ok: false, output: `${status}: ${stdout ?? ''}` };
		}
	};

	beforeAll(() => {
		root = mkdtempSync(path.join(tmpdir(), 'html-child-'));
		writeFileSync(
			path.join(root, 'tsconfig.json'),
			JSON.stringify({
				compilerOptions: {
					noEmit: true,
					strict: true,
					skipLibCheck: true,
					jsx: 'preserve',
					module: 'NodeNext',
					moduleResolution: 'NodeNext',
					typeRoots: [path.join(repo, 'node_modules', '@types')],
					// `node` for the source of the runtime, which uses `node:crypto`.
					types: ['react', 'node'],
					paths: {
						react: [path.join(repo, 'node_modules', '@types', 'react')],
						'kamado/jsx': [runtime],
					},
				},
				include: ['check.tsx'],
			}),
		);
	}, 60_000);

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('is accepted as a child next to the other children', () => {
		const result = compile(`import { html } from 'kamado/jsx';
export const page = (text: string) => <div>{html(text)}<footer>end</footer></div>;
`);
		expect(result).toEqual({ ok: true, output: '' });
	}, 120_000);

	test('is what makes a Markup acceptable: a Markup itself is not a child', () => {
		const result = compile(`import { Markup } from 'kamado/jsx';
export const page = <div>{new Markup('x')}</div>;
`);
		expect(result.ok).toBe(false);
		// The code and the name of the type: the rest of the message follows the compiler.
		expect(result.output).toMatch(/check\.tsx.*TS2322.*'Markup'/);
	}, 120_000);
});
