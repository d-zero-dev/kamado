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
