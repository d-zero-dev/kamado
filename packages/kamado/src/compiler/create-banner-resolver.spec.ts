import { describe, test, expect, vi } from 'vitest';

import { createBannerResolver } from './create-banner-resolver.js';

describe('createBannerResolver', () => {
	test('resolves the banner factory only once when cache is enabled', () => {
		const factory = vi.fn(() => () => 'BANNER');
		const resolve = createBannerResolver(factory);

		expect(resolve()).toBe('/*\nBANNER\n*/');
		expect(resolve(true)).toBe('/*\nBANNER\n*/');
		expect(resolve()).toBe('/*\nBANNER\n*/');

		expect(factory).toHaveBeenCalledTimes(1);
	});

	test('re-resolves the banner on every call when cache is false (serve mode)', () => {
		const factory = vi.fn(() => () => 'BANNER');
		const resolve = createBannerResolver(factory);

		resolve(false);
		resolve(false);

		expect(factory).toHaveBeenCalledTimes(2);
	});

	test('passes a string banner through unchanged', () => {
		const resolve = createBannerResolver('plain');

		expect(resolve()).toBe('plain');
	});

	test('applies the transform to the resolved banner', () => {
		const resolve = createBannerResolver('x', (banner) => `[${banner}]`);

		expect(resolve()).toBe('[x]');
	});
});
