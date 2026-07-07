import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, test, expect } from 'vitest';

import { runNodeScript } from './test-support/run-node-script.js';

const hooksModuleUrl = pathToFileURL(
	path.join(import.meta.dirname, 'jsx-loader-hooks.ts'),
).href;

describe('jsx-loader-hooks', () => {
	test('registers a virtual module and imports it', async () => {
		const { stdout } = await runNodeScript(`
			import { registerVirtualModule } from '${hooksModuleUrl}';
			const url = registerVirtualModule('export default 42;', process.cwd());
			const mod = await import(url);
			console.log(JSON.stringify({ default: mod.default }));
		`);
		expect(JSON.parse(stdout)).toEqual({ default: 42 });
	});

	test('does not affect unrelated imports (real module, real file)', async () => {
		const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kamado-jsx-test-'));
		try {
			const tmpFile = path.join(tmpDir, 'mod.mjs');
			await fs.writeFile(tmpFile, 'export const hello = "world";');
			const tmpFileUrl = pathToFileURL(tmpFile).href;

			const { stdout } = await runNodeScript(`
				import { registerVirtualModule } from '${hooksModuleUrl}';
				registerVirtualModule('export default 1;', process.cwd());
				const nodePath = await import('node:path');
				const real = await import('${tmpFileUrl}');
				console.log(JSON.stringify({
					hasJoin: typeof nodePath.join === 'function',
					hello: real.hello,
				}));
			`);
			expect(JSON.parse(stdout)).toEqual({ hasJoin: true, hello: 'world' });
		} finally {
			await fs.rm(tmpDir, { recursive: true, force: true });
		}
	});

	test('resolves bare specifiers relative to resolveDir', async () => {
		const packageRoot = path.resolve(import.meta.dirname, '..');
		const { stdout } = await runNodeScript(`
			import { registerVirtualModule } from '${hooksModuleUrl}';
			const url = registerVirtualModule(
				"import { version } from 'react'; export default version;",
				${JSON.stringify(packageRoot)},
			);
			const mod = await import(url);
			console.log(JSON.stringify({ type: typeof mod.default }));
		`);
		expect(JSON.parse(stdout)).toEqual({ type: 'string' });
	});

	test('throws a clear error when registerHooks is unavailable', async () => {
		await expect(
			runNodeScript(`
				const NodeModule = (await import('node:module')).default;
				Object.defineProperty(NodeModule, 'registerHooks', { value: undefined, configurable: true });
				const { registerVirtualModule } = await import('${hooksModuleUrl}');
				registerVirtualModule('export default 1;', process.cwd());
			`),
		).rejects.toThrow(/requires Node\.js module\.registerHooks/);
	});
});
