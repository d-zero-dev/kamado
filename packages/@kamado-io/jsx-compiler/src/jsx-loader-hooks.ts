import type {
	LoadFnOutput,
	LoadHookContext,
	ModuleHooks,
	ResolveFnOutput,
	ResolveHookContext,
} from 'node:module';

import crypto from 'node:crypto';
import Module from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Scheme used for virtual modules registered by {@link registerVirtualModule}.
 * Any specifier/URL not starting with this scheme is passed straight through
 * to Node's default resolution, so registering these hooks has no effect on
 * unrelated `import`/`require` calls elsewhere in the process.
 */
const SCHEME = 'kamado-jsx:';
const HOST = 'vm';

/**
 * key -> bundled ESM source. Entries are removed as soon as they are
 * consumed by the `load` hook, so this map never grows past the number of
 * modules currently mid-import.
 */
const registry = new Map<string, string>();

let hooksHandle: ModuleHooks | undefined;

/**
 * `module.registerHooks()` resolve hook. Non-`kamado-jsx:` specifiers are
 * passed straight through, so registering this hook has no effect on
 * unrelated imports elsewhere in the process.
 * @param specifier - Module specifier being resolved
 * @param context - Resolution context, including the importing module's URL
 * @param nextResolve - Delegates to Node's default resolution algorithm
 * @returns The resolved module URL
 */
function resolve(
	specifier: string,
	context: ResolveHookContext,
	nextResolve: (
		specifier: string,
		context?: Partial<ResolveHookContext>,
	) => ResolveFnOutput,
): ResolveFnOutput {
	if (specifier.startsWith(SCHEME)) {
		// The specifier is a URL minted by registerVirtualModule() itself
		// (the entry point of an import() call), so it resolves to itself.
		return { url: specifier, shortCircuit: true };
	}
	if (context.parentURL?.startsWith(SCHEME)) {
		// A bare/relative specifier imported *from* a virtual module (e.g.
		// `react`, `react-dom/server`, or a relative sibling). Swap the
		// parent to a pseudo file:// URL under the resolveDir carried in the
		// virtual URL's query string, then let Node's normal node_modules /
		// relative-path algorithm take over.
		const resolveDir = new URL(context.parentURL).searchParams.get('d') ?? '';
		const pseudoParentUrl = pathToFileURL(
			path.join(resolveDir, '__kamado_jsx__.js'),
		).href;
		return nextResolve(specifier, { ...context, parentURL: pseudoParentUrl });
	}
	return nextResolve(specifier, context);
}

/**
 * `module.registerHooks()` load hook, serving the source registered by
 * {@link registerVirtualModule} for `kamado-jsx:` URLs; everything else is
 * passed straight through.
 * @param url - Module URL being loaded
 * @param context - Load context (format, import attributes)
 * @param nextLoad - Delegates to Node's default loading algorithm
 * @returns The module's source and format
 */
function load(
	url: string,
	context: LoadHookContext,
	nextLoad: (url: string, context?: Partial<LoadHookContext>) => LoadFnOutput,
): LoadFnOutput {
	if (url.startsWith(SCHEME)) {
		const key = new URL(url).pathname.replace(/^\//, '');
		const source = registry.get(key);
		// Consume-once: the same virtual URL is never imported twice in
		// practice (each compile call mints a fresh key), so freeing the
		// entry here keeps the registry from outliving the import() call.
		registry.delete(key);
		if (source === undefined) {
			throw new Error(
				`@kamado-io/jsx-compiler: virtual module already consumed or unknown: ${url}`,
			);
		}
		return { format: 'module', shortCircuit: true, source };
	}
	return nextLoad(url, context);
}

/**
 * Registers the resolve/load hooks exactly once per process; safe to call
 * on every {@link registerVirtualModule} invocation.
 */
function ensureHooksRegistered(): void {
	if (hooksHandle) {
		return;
	}
	// Accessed off the default export (rather than a named import) so tests
	// can simulate a Node.js version without registerHooks() by overwriting
	// this property — a named ESM binding cannot be reassigned.
	if (typeof Module.registerHooks !== 'function') {
		throw new TypeError(
			'@kamado-io/jsx-compiler requires Node.js module.registerHooks() ' +
				`(Node >= 24.13.1). Current runtime: ${process.version}`,
		);
	}
	hooksHandle = Module.registerHooks({ resolve, load });
}

/**
 * Registers a bundled ESM source string as an importable virtual module and
 * returns the URL to `import()` it from.
 *
 * No disk I/O is involved: the source lives only in an in-memory registry
 * and is handed to Node directly through the `load` hook, consumed exactly
 * once. `resolveDir` travels with the URL (as a query parameter) so that
 * bare/relative specifiers inside `source` (`react`, `./sibling.js`, ...)
 * resolve against the right `node_modules`/directory tree.
 * @param code - Bundled ESM source code
 * @param resolveDir - Directory relative/bare imports inside `code` resolve against
 * @returns A `kamado-jsx:` URL suitable for `import()`
 */
export function registerVirtualModule(code: string, resolveDir: string): string {
	ensureHooksRegistered();
	const key = crypto.randomUUID();
	registry.set(key, code);
	const url = new URL(`${SCHEME}//${HOST}/${key}`);
	url.searchParams.set('d', resolveDir);
	return url.href;
}
