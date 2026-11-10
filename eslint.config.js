import dz from '@d-zero/eslint-config';

/**
 * @type {import('eslint').Linter.Config[]}
 */
export default [
	...dz.configs.node,
	{
		// The frozen copy of kamado v2 that the differential specs compare with (see its README.md).
		ignores: ['packages/*/oracle/**'],
	},
	// The screen of `kamado ui` runs in the browser (React), apart from the Node code of the package.
	...dz.configs.frontend.map((config) => ({
		...config,
		files: ['packages/*/client/**/*.{ts,tsx}'],
	})),
	{
		// Its own tsconfig (the DOM, `jsx`, bundler resolution): the root one leaves it out.
		files: ['packages/*/client/**/*.{ts,tsx}'],
		languageOptions: {
			parserOptions: {
				project: ['./packages/kamado/client/tsconfig.json'],
				tsconfigRootDir: import.meta.dirname,
			},
		},
	},
	{
		files: ['**/{*.{config,spec}.{js,mjs,ts},*.*rc,*.*rc.{js,mjs}}'],
		rules: {
			'import-x/no-extraneous-dependencies': 0,
		},
	},
	{
		files: ['.textlintrc.js'],
		rules: {
			'no-undef': 0,
			'@typescript-eslint/no-require-imports': 0,
		},
	},
];
