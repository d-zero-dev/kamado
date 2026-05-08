import { describe, test, expect } from 'vitest';

import { resolveMetaPath } from './resolve-meta-path.js';

describe('resolveMetaPath', () => {
	test('explicit extension is used as-is', () => {
		const result = resolveMetaPath({
			metaPath: '/foo/bar.html',
			outputDir: '/out',
			outputExtension: '.html',
		});
		expect(result.outputPath).toBe('/out/foo/bar.html');
		expect(result.rootRelPathWithExt).toBe('foo/bar.html');
	});

	test('no extension appends outputExtension', () => {
		const result = resolveMetaPath({
			metaPath: '/foo/bar',
			outputDir: '/out',
			outputExtension: '.html',
		});
		expect(result.outputPath).toBe('/out/foo/bar.html');
		expect(result.rootRelPathWithExt).toBe('foo/bar.html');
	});

	test('trailing slash appends index<outputExtension>', () => {
		const result = resolveMetaPath({
			metaPath: '/foo/bar/',
			outputDir: '/out',
			outputExtension: '.html',
		});
		expect(result.outputPath).toBe('/out/foo/bar/index.html');
		expect(result.rootRelPathWithExt).toBe('foo/bar/index.html');
	});

	test('root with trailing slash resolves to /index<ext>', () => {
		const result = resolveMetaPath({
			metaPath: '/',
			outputDir: '/out',
			outputExtension: '.html',
		});
		expect(result.outputPath).toBe('/out/index.html');
		expect(result.rootRelPathWithExt).toBe('index.html');
	});

	test('different outputExtension is honored', () => {
		const result = resolveMetaPath({
			metaPath: '/feed',
			outputDir: '/out',
			outputExtension: '.xml',
		});
		expect(result.outputPath).toBe('/out/feed.xml');
		expect(result.rootRelPathWithExt).toBe('feed.xml');
	});

	test('different output extension via explicit suffix', () => {
		const result = resolveMetaPath({
			metaPath: '/sitemap.xml',
			outputDir: '/out',
			outputExtension: '.html',
		});
		expect(result.outputPath).toBe('/out/sitemap.xml');
		expect(result.rootRelPathWithExt).toBe('sitemap.xml');
	});

	test('throws when path does not start with slash', () => {
		expect(() =>
			resolveMetaPath({
				metaPath: 'foo/bar.html',
				outputDir: '/out',
				outputExtension: '.html',
			}),
		).toThrow(/must start with '\/'/);
	});

	test('throws when path contains parent segment', () => {
		expect(() =>
			resolveMetaPath({
				metaPath: '/foo/../bar',
				outputDir: '/out',
				outputExtension: '.html',
			}),
		).toThrow(/must not contain/);
	});

	test('throws when path contains current segment', () => {
		expect(() =>
			resolveMetaPath({
				metaPath: '/./foo',
				outputDir: '/out',
				outputExtension: '.html',
			}),
		).toThrow(/must not contain/);
	});

	test('throws when path starts with traversal', () => {
		expect(() =>
			resolveMetaPath({
				metaPath: '/../escape.html',
				outputDir: '/out',
				outputExtension: '.html',
			}),
		).toThrow(/must not contain/);
	});
});
