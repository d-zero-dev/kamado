import { describe, test, expect } from 'vitest';

import { mergeConfig } from '../config/merge-config.js';

import { createCompileFunctionMap } from './function-map.js';

describe('createCompileFunctionMap', async () => {
	const config = await mergeConfig({});

	test('should create a compile function map', async () => {
		const compileFunctionMap = await createCompileFunctionMap({
			...config,
			compilers: () => [
				{
					files: '**/*.html',
					outputExtension: '.html',
					compiler: () => () => 'content',
				},
				{
					files: '**/*.css',
					outputExtension: '.css',
					compiler: () => () => 'content',
				},
				{
					files: '**/*.js',
					outputExtension: '.js',
					compiler: () => () => 'content',
				},
			],
		});
		expect(compileFunctionMap.get('.html')).toBeDefined();
		expect(compileFunctionMap.get('.css')).toBeDefined();
		expect(compileFunctionMap.get('.js')).toBeDefined();
	});
});
