import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { basePathOf } from './index.js';

// Types of page props and `<html static>` are checked by compiling a small
// TSX file against the source of `kamado/jsx` (same pattern as html-child).
const repo = path.resolve(import.meta.dirname, '..', '..', '..', '..');
const entry = path.resolve(import.meta.dirname, 'index.ts');
const compiler = path.join(repo, 'node_modules', 'typescript', 'bin', 'tsc');
const available =
	existsSync(compiler) &&
	existsSync(path.join(repo, 'node_modules', '@types', 'react')) &&
	existsSync(path.join(repo, 'node_modules', '@types', 'node'));

describe('basePathOf from kamado/jsx', () => {
	test('keeps a path base URL as it is', () => {
		expect(basePathOf('/sub/')).toBe('/sub/');
	});
});

describe.skipIf(!available)('the types of page props on a TSX file', () => {
	let root: string;

	/**
	 * Compiles a TSX file with the strictest settings and the types of React.
	 * @param source - The TSX file
	 * @returns Whether the compiler accepted it, and what it said
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
			const { status, stdout, stderr } = error as {
				status?: number;
				stdout?: string;
				stderr?: string;
			};
			return { ok: false, output: `${status}: ${stdout ?? ''}${stderr ?? ''}` };
		}
	};

	beforeAll(() => {
		root = mkdtempSync(path.join(tmpdir(), 'page-props-'));
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
					types: ['react', 'node'],
					paths: {
						react: [path.join(repo, 'node_modules', '@types', 'react')],
						'kamado/jsx': [entry],
					},
				},
				include: ['check.tsx', 'ambient.d.ts'],
			}),
		);
		writeFileSync(
			path.join(root, 'ambient.d.ts'),
			`import 'kamado/jsx';

declare module 'kamado/jsx' {
	interface PageMeta {
		ogImage?: string;
	}
	interface GlobalData {
		'bge-blocks': string;
	}
}
`,
		);
	}, 60_000);

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('accepts PageProps and LayoutProps with merged meta and data', () => {
		const result = compile(`import type {
	BreadcrumbItem,
	LayoutProps,
	PageProps,
	TitleListOptions,
} from 'kamado/jsx';

export function Page({ page, meta, data, site, pages, nav, breadcrumbs, titleList, formatDate }: PageProps) {
	const _date: string = page.date;
	const _image: string | undefined = meta.ogImage;
	const _blocks: string = data['bge-blocks'];
	const _host: string | null = site.host;
	const _n: number = pages.length;
	const _nav = nav();
	const _crumbs: readonly BreadcrumbItem[] = breadcrumbs;
	const _opts: TitleListOptions = { siteName: 'Site' };
	const _formatted: string = formatDate('2026-01-01', 'YYYY');
	void _nav;
	return <title>{titleList(_opts)}{_crumbs.length}{_formatted}{_host}{_n}</title>;
}

export function Layout({ content, breadcrumbs }: LayoutProps) {
	const _title: string | undefined = breadcrumbs[0]?.title;
	return <main dangerouslySetInnerHTML={{ __html: content }} />;
}
`);
		expect(result).toEqual({ ok: true, output: '' });
	}, 120_000);

	test('accepts basePathOf and <html static>', () => {
		const result = compile(`import { basePathOf } from 'kamado/jsx';

export const path = basePathOf('https://example.com/sub/');

export const page = <html static lang="ja"><body /></html>;
`);
		expect(result).toEqual({ ok: true, output: '' });
	}, 120_000);

	test('rejects a Date for page.date', () => {
		const result = compile(`import type { PageEntry } from 'kamado/jsx';

export function bad(page: PageEntry): Date {
	return page.date;
}
`);
		expect(result.ok).toBe(false);
		expect(result.output).toMatch(/check\.tsx.*TS2322/);
	}, 120_000);
});
