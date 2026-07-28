import { runModuleScript } from './run-module-script.js';

/**
 * Runs `body` in a fresh Node.js child process with `compileJsx` already
 * imported into scope, and JSON-parses whatever it prints to stdout.
 * @param body - Async script source; must `console.log(JSON.stringify(...))` its result
 */
export async function runCompileJsxScript<T>(body: string): Promise<T> {
	return runModuleScript<T>('compile-jsx.ts', ['compileJsx'], body);
}
