export default {
	categories: { correctness: 'off' },
	jsPlugins: ['@kamado-io/oxlint'],
	rules: {
		'@kamado-io/no-async-component': 'error',
		'@kamado-io/no-client-directive': 'error',
		'@kamado-io/no-function-event-handler': 'error',
		'@kamado-io/no-ignored-props': 'error',
		'@kamado-io/no-module-state': 'error',
		'@kamado-io/no-react-runtime': 'error',
		'@kamado-io/no-untracked-input': 'error',
	},
	overrides: [
		{
			files: ['data/**'],
			rules: {
				'@kamado-io/no-async-component': 'off',
				'@kamado-io/no-untracked-input': 'off',
			},
		},
	],
};
