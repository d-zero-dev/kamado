import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, test, expect, beforeEach, afterEach } from 'vitest';

import { bundleJsx } from './bundle-jsx.js';

describe('bundle-jsx', () => {
	let tmpDir: string;

	beforeEach(async () => {
		// realpath: on macOS os.tmpdir() is a symlink (/var -> /private/var),
		// and esbuild's metafile keys are resolved through the real path, so
		// dependency-path assertions would otherwise never match.
		tmpDir = await fs.realpath(
			await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-jsx-bundle-test-')),
		);
	});

	afterEach(async () => {
		await fs.rm(tmpDir, { recursive: true, force: true });
	});

	test('bundles a standalone .tsx component', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const { code, dependencies } = await bundleJsx({
			source: 'export default function Page() { return <div>Hello</div>; }',
			filePath,
			resolveDir: tmpDir,
		});
		expect(code).toContain('jsx-runtime');
		expect(code).toContain('export');
		expect(dependencies).toEqual([]);
	});

	test('bundles a standalone .jsx component (jsx loader)', async () => {
		const filePath = path.join(tmpDir, 'Page.jsx');
		const { code } = await bundleJsx({
			source: 'export default function Page() { return <div>Hello</div>; }',
			filePath,
			resolveDir: tmpDir,
		});
		expect(code).toContain('jsx-runtime');
	});

	test('inlines a relative sibling import and reports it as a dependency', async () => {
		const buttonPath = path.join(tmpDir, 'Button.tsx');
		await fs.writeFile(
			buttonPath,
			'export function Button() { return <button>Click</button>; }',
		);
		const filePath = path.join(tmpDir, 'Page.tsx');
		const { code, dependencies } = await bundleJsx({
			source:
				"import { Button } from './Button.tsx';\nexport default function Page() { return <Button />; }",
			filePath,
			resolveDir: tmpDir,
		});
		expect(code).toContain('button');
		expect(dependencies).toEqual([buttonPath]);
	});

	test('keeps react/react-dom external instead of bundling them', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const { code } = await bundleJsx({
			source:
				"import { useMemo } from 'react';\nexport default function Page() { useMemo(() => 1, []); return <div />; }",
			filePath,
			resolveDir: tmpDir,
		});
		expect(code).toMatch(/from\s+["']react["']/);
	});

	test('appends a //# sourceURL= comment pointing at the origin file', async () => {
		const filePath = path.join(tmpDir, 'Page.tsx');
		const { code } = await bundleJsx({
			source: 'export default function Page() { return null; }',
			filePath,
			resolveDir: tmpDir,
		});
		expect(code.trimEnd().endsWith(`//# sourceURL=${filePath}`)).toBe(true);
	});

	test('forwards the alias option to esbuild', async () => {
		const realPath = path.join(tmpDir, 'Real.tsx');
		await fs.writeFile(realPath, 'export const label = "aliased";');
		const filePath = path.join(tmpDir, 'Page.tsx');
		const { code } = await bundleJsx(
			{
				source:
					"import { label } from '@aliased';\nexport default function Page() { return label; }",
				filePath,
				resolveDir: tmpDir,
			},
			{ alias: { '@aliased': realPath } },
		);
		expect(code).toContain('aliased');
	});

	test('throws a clear error on invalid JSX syntax', async () => {
		const filePath = path.join(tmpDir, 'Broken.tsx');
		await expect(
			bundleJsx({
				source: 'export default function Page() { return <div> }',
				filePath,
				resolveDir: tmpDir,
			}),
		).rejects.toThrow();
	});
});
