import type { ESLint } from 'eslint';

import { readFileSync } from 'node:fs';

import { noAsyncComponent } from './rules/no-async-component.js';
import { noClientDirective } from './rules/no-client-directive.js';
import { noFunctionEventHandler } from './rules/no-function-event-handler.js';
import { noIgnoredProps } from './rules/no-ignored-props.js';
import { noModuleState } from './rules/no-module-state.js';
import { noReactRuntime } from './rules/no-react-runtime.js';
import { noUntrackedInput } from './rules/no-untracked-input.js';

const { version } = JSON.parse(
	readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * The plugin: the rules for the JSX of kamado, for oxlint (they are written for the API that
 * oxlint and ESLint share, and run in both). kamado renders each page once, to HTML, and sends
 * no JavaScript: what a page needs from the browser, or from outside the render, is what these
 * rules find. The names of the rules have the prefix `@kamado-io/`.
 * @example
 * ```ts
 * // oxlint.config.mts
 * export default {
 *   jsPlugins: ['@kamado-io/oxlint'],
 *   rules: { '@kamado-io/no-react-runtime': 'error' },
 * };
 * ```
 */
const plugin = {
	// The name is the prefix of the rules (`@kamado-io/no-react-runtime`), as in
	// `@d-zero/no-click-event`.
	meta: { name: '@kamado-io', version },
	rules: {
		'no-async-component': noAsyncComponent,
		'no-client-directive': noClientDirective,
		'no-function-event-handler': noFunctionEventHandler,
		'no-ignored-props': noIgnoredProps,
		'no-module-state': noModuleState,
		'no-react-runtime': noReactRuntime,
		'no-untracked-input': noUntrackedInput,
	},
} satisfies ESLint.Plugin;

export default plugin;
