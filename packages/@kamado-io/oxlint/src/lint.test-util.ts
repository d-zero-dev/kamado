import { Linter } from 'eslint';

import plugin from './index.js';

const linter = new Linter();

/** What a rule said about one place of the code. */
export interface Found {
	readonly messageId: string | undefined;
	readonly line: number;
	readonly column: number;
}

/**
 * Lints a module of JavaScript and JSX with one rule of the plugin, through ESLint (the
 * plugin is written for the API that ESLint and oxlint share). TypeScript syntax cannot be
 * parsed here; the files in `fixtures/` go through oxlint, which parses it.
 * @param rule - The name of the rule, without the prefix of the plugin
 * @param code - The source of the module
 * @returns What the rule reported, in the order of the source
 * @example
 * ```ts
 * lint('no-react-runtime', "import { useState } from 'react';");
 * // [{ messageId: 'noReactRuntime', line: 1, column: 1 }]
 * ```
 */
export function lint(rule: string, code: string): Found[] {
	const messages = linter.verify(code, {
		languageOptions: {
			ecmaVersion: 2024,
			sourceType: 'module',
			parserOptions: { ecmaFeatures: { jsx: true } },
		},
		plugins: { '@kamado-io': plugin },
		rules: { [`@kamado-io/${rule}`]: 'error' },
	});
	const fatal = messages.find((message) => message.fatal);
	if (fatal) {
		throw new Error(`the code does not parse: ${fatal.message}`);
	}
	return messages.map(({ messageId, line, column }) => ({ messageId, line, column }));
}

/**
 * The names of the messages of `lint`.
 * @param rule - The name of the rule, without the prefix of the plugin
 * @param code - The source of the module
 * @returns The `messageId` of each report
 */
export function ids(rule: string, code: string): (string | undefined)[] {
	return lint(rule, code).map((found) => found.messageId);
}
