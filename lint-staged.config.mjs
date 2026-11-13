import lintStagedConfigGenerator from '@d-zero/lint-staged-config';

/**
 * The mapping of `@d-zero/lint-staged-config` (oxlint and oxfmt), with the extensions that
 * this repository has. The package does not export its `defaultMapping`, so it cannot be
 * reused; use it when the package does. There is no cspell, and no pug, astro, vue or svelte.
 */
const mapping = {
	cjs: ['oxlint', 'oxfmt'],
	css: ['stylelint', 'oxfmt'],
	cts: ['oxlint', 'oxfmt'],
	html: ['markuplint', 'oxfmt'],
	js: ['oxlint', 'oxfmt'],
	json: ['oxfmt'],
	jsx: ['oxlint', 'markuplint', 'oxfmt'],
	md: ['oxfmt', 'textlint'],
	mdx: ['oxfmt', 'textlint'],
	mjs: ['oxlint', 'oxfmt'],
	mts: ['oxlint', 'oxfmt'],
	ts: ['oxlint', 'oxfmt'],
	tsx: ['oxlint', 'markuplint', 'oxfmt'],
	yaml: ['oxfmt'],
	yml: ['oxfmt'],
};

// The markup that markuplint checks is the screen of `kamado ui` (the scripts of `package.json` run it
// on `packages/kamado/client` only): the staged files anywhere else are not its.
const OUTSIDE_THE_SCREEN = [
	'packages/@kamado-io/**',
	'packages/*/oracle/**',
	'packages/kamado/src/**',
	'benchmarks/**',
	'crates/**',
	'docs/**',
	'scripts/**',
];

// The code that the rules of @kamado-io/oxlint are run on, which breaks them on purpose (and
// holds two oxlint configs, which oxlint refuses to discover), and the frozen copy of kamado v2.
const FROZEN = [
	'packages/@kamado-io/*/fixtures/**',
	'packages/*/oracle/**',
	'benchmarks/v2-baseline/**',
];

export default lintStagedConfigGenerator(
	{
		ignore: [
			{
				// `.oxfmtrc.json` ignores the CHANGELOGs, and oxfmt fails when every file it is given is
				// ignored, so a commit of the CHANGELOGs alone (a release) must not hand them to it.
				oxfmt: 'CHANGELOG.md',
				textlint: 'CHANGELOG.md',
			},
			{
				oxlint: FROZEN,
				oxfmt: FROZEN,
				markuplint: OUTSIDE_THE_SCREEN,
				stylelint: FROZEN,
			},
		],
	},
	mapping,
);
