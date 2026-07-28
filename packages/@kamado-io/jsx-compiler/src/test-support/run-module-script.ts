import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { runNodeScript } from './run-node-script.js';

/**
 * Runs `body` in a fresh Node.js child process with the named exports of
 * `moduleFileName` (a sibling file under `src/`) already destructured into
 * scope, and JSON-parses whatever it prints to stdout.
 *
 * Needed because these modules import a `kamado-jsx:` virtual module under
 * the hood (via `module.registerHooks()`), which vitest's own module runner
 * cannot resolve — see `run-node-script.ts`.
 * @param moduleFileName - Source file under `src/` to import (e.g. `'compile-jsx.ts'`)
 * @param exportNames - Named exports to destructure into scope
 * @param body - Async script source; must `console.log(JSON.stringify(...))` its result
 */
export async function runModuleScript<T>(
	moduleFileName: string,
	exportNames: readonly string[],
	body: string,
): Promise<T> {
	const moduleUrl = pathToFileURL(
		path.join(import.meta.dirname, '..', moduleFileName),
	).href;
	// Dynamic import: a static `import` is resolved during the link phase,
	// before the .js-to-.ts fallback hook (registered by runNodeScript) has
	// had a chance to run, so it would fail to resolve the module's own
	// sibling imports.
	const { stdout } = await runNodeScript(`
		const { ${exportNames.join(', ')} } = await import('${moduleUrl}');
		${body}
	`);
	return JSON.parse(stdout) as T;
}
