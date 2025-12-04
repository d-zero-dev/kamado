import { describe, test, expect } from 'vitest';

import { mergeConfig } from '../config/merge.js';

import { createCompileFunctionMap } from './function-map.js';

describe('createCompileFunctionMap', async () => {
	const config = await mergeConfig({});

	test('should create a compile function map', async () => {
		const compileFunctionMap = await createCompileFunctionMap({
			...config,
			compilers: {
				page: () => () => 'content',
				style: () => () => 'content',
				script: () => () => 'content',
				// @ts-ignore
				foo: () => () => 'content',
			},
		});
		expect(compileFunctionMap.get('page')).toBeDefined();
		expect(compileFunctionMap.get('style')).toBeDefined();
		expect(compileFunctionMap.get('script')).toBeDefined();
		// @ts-ignore
		expect(compileFunctionMap.get('foo')).toBeDefined();
	});
});
