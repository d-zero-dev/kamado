import { describe, expect, test } from 'vitest';

import { missingPlatforms, SUPPORTED_PLATFORMS } from './check-package-addon.mjs';

describe('missingPlatforms', () => {
	test('nothing is missing when every supported platform is present', () => {
		expect(missingPlatforms(() => true)).toEqual([]);
	});

	test('the platforms without an addon are listed', () => {
		expect(missingPlatforms((platform) => platform !== 'linux-x64')).toEqual([
			'linux-x64',
		]);
	});

	test('every platform is missing when the package has no addon', () => {
		expect(missingPlatforms(() => false)).toEqual(SUPPORTED_PLATFORMS);
	});
});
