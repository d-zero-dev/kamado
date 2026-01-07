import { describe, test, expect } from 'vitest';

import { getFile } from '../files/file.js';

import { getBreadcrumbs } from './breadcrumbs.js';

describe('getAssetGroup with virtual file system', () => {
	test('use compiler', async () => {
		const page = {
			...getFile('/mock/input/dir/path/to/index.html', {
				inputDir: '/mock/input/dir',
				outputDir: '/mock/output/dir',
				outputExtension: '.html',
			}),
			title: 'Page Title',
		};
		const breadcrumbs = await getBreadcrumbs(page, [page]);

		expect(breadcrumbs).toStrictEqual([
			{
				title: 'Page Title',
				href: '/path/to/',
				depth: 2,
			},
		]);
	});
});
