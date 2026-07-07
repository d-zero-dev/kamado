import { runModuleScript } from './run-module-script.js';

/**
 * Runs `body` in a fresh Node.js child process with `createCompileHooks`
 * already imported into scope, and JSON-parses whatever it prints to
 * stdout.
 * @param body - Async script source; must `console.log(JSON.stringify(...))` its result
 */
export async function runCreateCompileHooksScript<T>(body: string): Promise<T> {
	return runModuleScript<T>('create-compile-hooks.ts', ['createCompileHooks'], body);
}
