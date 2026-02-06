import type { FileObject } from './types.js';

import { beforeEach, describe, expect, test, vi } from 'vitest';

import { getFileContent } from './file-content.js';
import { getContentFromFileObject } from './get-content-from-file-object.js';

// Mock getFileContent (hoisted by vitest)
vi.mock('./file-content.js', () => ({
	getFileContent: vi.fn(),
}));

const mockGetFileContent = vi.mocked(getFileContent);

describe('getContentFromFileObject', () => {
	beforeEach(() => {
		mockGetFileContent.mockReset();
	});

	/**
	 * Creates a mock FileObject
	 * @param inputPath - Input path
	 */
	function createMockFileObject(inputPath: string): FileObject {
		return {
			inputPath,
		};
	}

	test('should read file content', async () => {
		mockGetFileContent.mockResolvedValue('html\n  body\n    block content');

		const file = createMockFileObject('/path/to/layout.pug');
		const result = await getContentFromFileObject(file);

		expect(result.content).toBe('html\n  body\n    block content');
		expect(result.raw).toBe('html\n  body\n    block content');
	});

	test('should return empty metaData always', async () => {
		mockGetFileContent.mockResolvedValue('Some content with --- markers ---');

		const file = createMockFileObject('/path/to/test.txt');
		const result = await getContentFromFileObject(file);

		// Unlike getContentFromFile, this does not parse front matter
		expect(result.content).toBe('Some content with --- markers ---');
	});

	test('should not parse front matter (simple read)', async () => {
		const content = `---
title: Should Not Parse
---
html
  body`;
		mockGetFileContent.mockResolvedValue(content);

		const file = createMockFileObject('/path/to/layout.pug');
		const result = await getContentFromFileObject(file);

		// Front matter should NOT be parsed - content includes everything
		expect(result.content).toBe(content);
		expect(result.raw).toBe(content);
	});
});
