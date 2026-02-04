import type { CompilableFile } from './types.js';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getFileContent } from './file-content.js';
import { getContentFromFile } from './get-content-from-file.js';

// Mock getFileContent (hoisted by vitest)
vi.mock('./file-content.js', () => ({
	getFileContent: vi.fn(),
}));

const mockGetFileContent = vi.mocked(getFileContent);

describe('getContentFromFile', () => {
	beforeEach(() => {
		mockGetFileContent.mockReset();
	});

	/**
	 * Creates a mock CompilableFile
	 * @param inputPath - Input path
	 */
	function createMockFile(inputPath: string): CompilableFile {
		return {
			inputPath,
			outputPath: inputPath.replace('.html', '.out.html'),
			fileSlug: 'test',
			filePathStem: '/test',
			url: '/test/',
			extension: '.html',
			date: new Date(),
		};
	}

	test('should read file content', async () => {
		mockGetFileContent.mockImplementation((path) => {
			if (path === '/path/to/test.html') {
				return Promise.resolve('<p>Hello, world!</p>');
			}
			return Promise.reject(new Error('File not found'));
		});

		const file = createMockFile('/path/to/test.html');
		const result = await getContentFromFile(file);

		expect(result.content).toBe('<p>Hello, world!</p>');
		expect(result.raw).toBe('<p>Hello, world!</p>');
		expect(result.metaData).toEqual({});
	});

	test('should parse front matter', async () => {
		const rawContent = `---
title: Test Page
layout: default
---
<p>Content here</p>`;

		mockGetFileContent.mockImplementation((path) => {
			if (path === '/path/to/test.html') {
				return Promise.resolve(rawContent);
			}
			return Promise.reject(new Error('File not found'));
		});

		const file = createMockFile('/path/to/test.html');
		const result = await getContentFromFile(file);

		expect(result.metaData).toEqual({
			title: 'Test Page',
			layout: 'default',
		});
		expect(result.content).toBe('<p>Content here</p>');
		expect(result.raw).toBe(rawContent);
	});

	test('should merge JSON file metadata', async () => {
		mockGetFileContent.mockImplementation((path) => {
			if (path === '/path/to/page.html') {
				return Promise.resolve('<p>Content</p>');
			}
			if (path === '/path/to/page.json') {
				return Promise.resolve(JSON.stringify({ customField: 'value', num: 42 }));
			}
			return Promise.reject(new Error('File not found'));
		});

		const file = createMockFile('/path/to/page.html');
		const result = await getContentFromFile(file);

		expect(result.metaData).toEqual({
			customField: 'value',
			num: 42,
		});
	});

	test('should merge front matter and JSON file metadata (JSON takes precedence)', async () => {
		const rawContent = `---
title: From Front Matter
shared: front-matter-value
---
<p>Content</p>`;

		mockGetFileContent.mockImplementation((path) => {
			if (path === '/path/to/page.html') {
				return Promise.resolve(rawContent);
			}
			if (path === '/path/to/page.json') {
				return Promise.resolve(JSON.stringify({ shared: 'json-value', extra: 'data' }));
			}
			return Promise.reject(new Error('File not found'));
		});

		const file = createMockFile('/path/to/page.html');
		const result = await getContentFromFile(file);

		expect(result.metaData).toEqual({
			title: 'From Front Matter',
			shared: 'json-value', // JSON takes precedence
			extra: 'data',
		});
	});

	test('should handle missing JSON file gracefully', async () => {
		mockGetFileContent.mockImplementation((path) => {
			if (path === '/path/to/no-json.html') {
				return Promise.resolve('<p>No JSON</p>');
			}
			return Promise.reject(new Error('File not found'));
		});

		const file = createMockFile('/path/to/no-json.html');
		const result = await getContentFromFile(file);

		expect(result.content).toBe('<p>No JSON</p>');
		expect(result.metaData).toEqual({});
	});
});
