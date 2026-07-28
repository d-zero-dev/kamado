import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface RunNodeScriptResult {
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * Source files import each other with a `.js` extension (the compiled
 * output's real extension), which TypeScript's own resolver rewrites to
 * `.ts` at typecheck time. Node's built-in type-stripping does not do this
 * rewrite, so running an un-built `.ts` file directly would fail to resolve
 * any `./sibling.js` import. This hook falls back to `.ts` only when the
 * `.js` path does not resolve, so it never shadows a real `.js` resolution
 * (e.g. from node_modules).
 */
const JS_TO_TS_FALLBACK_HOOK = `
	import Module from 'node:module';
	Module.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (!specifier.endsWith('.js')) {
				return nextResolve(specifier, context);
			}
			try {
				return nextResolve(specifier, context);
			} catch {
				return nextResolve(specifier.replace(/\\.js$/, '.ts'), context);
			}
		},
	});
`;

/**
 * Runs `script` (ESM source) in a fresh, real Node.js child process and
 * returns its stdout/stderr.
 *
 * vitest's own module runner intercepts dynamic `import()` calls and cannot
 * resolve the `kamado-jsx:` virtual module scheme registered via
 * `module.registerHooks()`, so `import()` of a virtual module always fails
 * with "Cannot find module" when called directly from a spec file. Code
 * paths that exercise the loader hooks must therefore run in an unmodified
 * Node.js process. Node's built-in TypeScript type-stripping lets the
 * script `import` local `.ts` files directly (no build step needed); a
 * `.js`-to-`.ts` resolution fallback is prepended so multi-file imports
 * between this package's own un-built sources resolve too.
 * @param script - ESM source to execute via `node --input-type=module -e`
 */
export async function runNodeScript(script: string): Promise<RunNodeScriptResult> {
	return execFileAsync(process.execPath, [
		'--input-type=module',
		'-e',
		`${JS_TO_TS_FALLBACK_HOOK}\n${script}`,
	]);
}
