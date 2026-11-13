import config from '@d-zero/oxlint-config';

/**
 * Lint is oxlint-native only: the ESLint-only rules of `@d-zero/eslint-config` (`import-x/*`
 * order and `no-extraneous-dependencies`, `sort-class-members`, `eslint-plugin-regexp`,
 * the `#private` over `private` convention) are not ported. oxlint has no equivalent of
 * `react/no-deprecated`, `react/prop-types` (unneeded with TypeScript) or the React
 * Compiler rules of `eslint-plugin-react-hooks`, so the react, react-hooks and jsx-a11y
 * rules of the screen of `kamado ui` are enumerated explicitly (oxlint enables only the
 * correctness category by default).
 */

const viewerReactRules = Object.fromEntries(
	[
		'react/display-name',
		'react/jsx-key',
		'react/jsx-no-comment-textnodes',
		'react/jsx-no-duplicate-props',
		'react/jsx-no-target-blank',
		'react/jsx-no-undef',
		'react/no-children-prop',
		'react/no-danger-with-children',
		'react/no-direct-mutation-state',
		'react/no-find-dom-node',
		'react/no-is-mounted',
		'react/no-render-return-value',
		'react/no-string-refs',
		'react/no-unescaped-entities',
		'react/no-unknown-property',
		'react/no-unsafe',
		'react/require-render-return',
		'react/rules-of-hooks',
		'jsx-a11y/alt-text',
		'jsx-a11y/anchor-has-content',
		'jsx-a11y/anchor-is-valid',
		'jsx-a11y/aria-activedescendant-has-tabindex',
		'jsx-a11y/aria-props',
		'jsx-a11y/aria-proptypes',
		'jsx-a11y/aria-role',
		'jsx-a11y/aria-unsupported-elements',
		'jsx-a11y/autocomplete-valid',
		'jsx-a11y/click-events-have-key-events',
		'jsx-a11y/heading-has-content',
		'jsx-a11y/html-has-lang',
		'jsx-a11y/iframe-has-title',
		'jsx-a11y/img-redundant-alt',
		'jsx-a11y/interactive-supports-focus',
		'jsx-a11y/label-has-associated-control',
		'jsx-a11y/lang',
		'jsx-a11y/media-has-caption',
		'jsx-a11y/mouse-events-have-key-events',
		'jsx-a11y/no-access-key',
		'jsx-a11y/no-autofocus',
		'jsx-a11y/no-distracting-elements',
		'jsx-a11y/no-interactive-element-to-noninteractive-role',
		'jsx-a11y/no-noninteractive-element-interactions',
		'jsx-a11y/no-noninteractive-element-to-interactive-role',
		'jsx-a11y/no-noninteractive-tabindex',
		'jsx-a11y/no-redundant-roles',
		'jsx-a11y/no-static-element-interactions',
		'jsx-a11y/role-has-required-aria-props',
		'jsx-a11y/role-supports-aria-props',
		'jsx-a11y/scope',
		'jsx-a11y/tabindex-no-positive',
	].map((rule) => [rule, 'error']),
);

// `exhaustive-deps` is advisory in the react-hooks recommended preset.
viewerReactRules['react/exhaustive-deps'] = 'warn';

export default {
	...config,
	jsPlugins: ['@d-zero/oxlint-plugin'],
	rules: {
		...config.rules,
		// The types live in TypeScript; do not make JSDoc restate them.
		'jsdoc/require-param-type': 'off',
		'jsdoc/require-param-description': 'off',
		'jsdoc/require-returns': 'off',
		'jsdoc/require-returns-type': 'off',
		'jsdoc/require-returns-description': 'off',
		'unicorn/prefer-event-target': 'off',
		// oxfmt always lowercases hex digits, so this rule (which wants uppercase) could
		// only ever disagree with the formatter.
		'unicorn/number-literal-case': 'off',
		'typescript/no-floating-promises': 'error',
		// Buttons send commands (the Invoker Commands API); a click handler is the thing
		// to replace, and the other events (`onChange`, `onKeyDown`, ...) stay allowed.
		'@d-zero/no-click-event': 'error',
	},
	ignorePatterns: [
		...config.ignorePatterns,
		'**/dist/**',
		'**/target/**',
		// The code that the rules of `@kamado-io/oxlint` are run on, and that breaks them on purpose.
		'packages/@kamado-io/*/fixtures/**',
		// The frozen copy of kamado v2 that the differential specs compare with (see its README.md).
		'packages/*/oracle/**',
		// A standalone project with its own yarn.lock.
		'benchmarks/v2-baseline/**',
		// Nested git worktrees of other sessions hold full copies of the repository.
		'.claude/worktrees/**',
	],
	overrides: [
		{
			files: ['.textlintrc.js'],
			rules: {
				'typescript/no-require-imports': 'off',
				'typescript/no-var-requires': 'off',
				'unicorn/prefer-module': 'off',
			},
		},
		{
			// Tests reference mocked methods as values (`expect(fake.close)`) and stub
			// async signatures with synchronous bodies, which these two rules forbid.
			files: ['**/*.spec.{ts,tsx,js,mjs}', '**/*.test-util.ts', '**/__tests__/**'],
			rules: {
				'typescript/unbound-method': 'off',
				'typescript/require-await': 'off',
				// The callbacks of a test are not documented one by one.
				'jsdoc/require-param': 'off',
			},
		},
		{
			// Maintenance scripts and benchmarks: stdout is their interface.
			files: ['scripts/**', 'benchmarks/**', '.claude/skills/*/scripts/**'],
			rules: {
				'no-console': 'off',
			},
		},
		{
			// The screen of `kamado ui` runs in the browser (React).
			files: ['packages/kamado/client/**/*.{ts,tsx}'],
			plugins: [...config.plugins, 'react', 'jsx-a11y'],
			rules: viewerReactRules,
		},
	],
};
