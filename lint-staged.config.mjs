import lintStagedConfigGenerator from '@d-zero/lint-staged-config';
export default lintStagedConfigGenerator({
	ignore: [
		{
			textlint: 'CHANGELOG.md',
		},
		{
			// Neither is a dependency of this repository (it had no CSS, HTML or TSX of its own
			// to stage before the screen of kamado ui); eslint, prettier and cspell check it.
			stylelint: 'packages/*/client/**',
			markuplint: 'packages/*/client/**',
		},
		{
			// The TSX of the fixtures breaks the rules of @kamado-io/oxlint on purpose.
			markuplint: 'packages/@kamado-io/*/fixtures/**',
		},
	],
});
