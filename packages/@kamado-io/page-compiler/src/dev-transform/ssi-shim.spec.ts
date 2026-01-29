import type { Context, TransformContext } from 'kamado/config';

import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { createSSIShim } from './ssi-shim.js';

/**
 * Create a mock TransformContext for testing
 * @param overrides
 */
function createMockContext(overrides: Partial<TransformContext> = {}): TransformContext {
	const mockContext: Context = {
		mode: 'serve',
		pkg: {},
		dir: {
			root: '/mock/root',
			input: '/mock/input',
			output: '/mock/output',
		},
		devServer: {
			port: 3000,
			host: 'localhost',
			open: false,
		},
		compilers: [],
	};

	return {
		path: '/test.html',
		outputPath: '/mock/output/test.html',
		isServe: true,
		context: mockContext,
		...overrides,
	};
}

describe('createSSIShim', () => {
	const mockOutputDir = '/tmp/kamado-test-ssi';

	beforeEach(async () => {
		// Create test directory and files
		await fs.mkdir(mockOutputDir, { recursive: true });
		await fs.writeFile(
			path.join(mockOutputDir, 'header.html'),
			'<header>Site Header</header>',
		);
		await fs.writeFile(
			path.join(mockOutputDir, 'footer.html'),
			'<footer>Site Footer</footer>',
		);
	});

	afterEach(async () => {
		// Clean up test files
		await fs.rm(mockOutputDir, { recursive: true, force: true });
	});

	describe('basic functionality', () => {
		test('should replace SSI include directives with file content', async () => {
			const transform = createSSIShim();

			const html = `<!DOCTYPE html>
<html>
<head>
<title>Test</title>
</head>
<body>
<!--#include virtual="/header.html" -->
<main>Content</main>
<!--#include virtual="/footer.html" -->
</body>
</html>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<header>Site Header</header>');
			expect(result).toContain('<footer>Site Footer</footer>');
			expect(result).not.toContain('<!--#include virtual="/header.html" -->');
			expect(result).not.toContain('<!--#include virtual="/footer.html" -->');
		});

		test('should handle ArrayBuffer input', async () => {
			const transform = createSSIShim();

			const html = `<!DOCTYPE html>
<html>
<body>
<!--#include virtual="/header.html" -->
</body>
</html>`;

			const encoder = new TextEncoder();
			const buffer = encoder.encode(html);

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(buffer, ctx);

			expect(typeof result).toBe('string');
			expect(result).toContain('<header>Site Header</header>');
		});

		test('should handle include directives with extra whitespace', async () => {
			const transform = createSSIShim();

			const html = `<!--#include   virtual="/header.html"   -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);
			expect(result).toContain('<header>Site Header</header>');
		});
	});

	describe('error handling', () => {
		test('should warn and replace with empty string when file not found', async () => {
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const transform = createSSIShim();

			const html = `<!--#include virtual="/nonexistent.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe('');
			expect(consoleWarnSpy).toHaveBeenCalledWith(
				'[ssi-shim] Failed to include /nonexistent.html:',
				expect.any(String),
			);

			consoleWarnSpy.mockRestore();
		});

		test('should use custom error handler when provided', async () => {
			const onError = vi.fn().mockReturnValue('<!-- Error: File not found -->');

			const transform = createSSIShim({ onError });

			const html = `<!--#include virtual="/nonexistent.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe('<!-- Error: File not found -->');
			expect(onError).toHaveBeenCalledWith('/nonexistent.html', expect.any(Error));
		});

		test('should support async error handler', async () => {
			const onError = vi.fn().mockImplementation(async (includePath: string) => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return `<!-- Failed to load ${includePath} -->`;
			});

			const transform = createSSIShim({ onError });

			const html = `<!--#include virtual="/nonexistent.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe('<!-- Failed to load /nonexistent.html -->');
			expect(onError).toHaveBeenCalledWith('/nonexistent.html', expect.any(Error));
		});
	});

	describe('filter configuration', () => {
		test('should have default filter for HTML files', () => {
			const transform = createSSIShim();

			expect(transform.filter).toBeDefined();
			expect(transform.filter?.include).toBe('**/*.html');
		});

		test('should allow custom filter configuration', () => {
			const transform = createSSIShim({
				filter: {
					include: ['**/*.html', '**/*.htm'],
					exclude: '**/admin/**',
				},
			});

			expect(transform.filter?.include).toEqual(['**/*.html', '**/*.htm']);
			expect(transform.filter?.exclude).toBe('**/admin/**');
		});

		test('should allow custom name', () => {
			const transform = createSSIShim({ name: 'custom-ssi' });

			expect(transform.name).toBe('custom-ssi');
		});
	});

	describe('real-world scenarios', () => {
		test('should handle multiple includes in one file', async () => {
			const transform = createSSIShim();

			const html = `<!DOCTYPE html>
<html>
<head><title>Test</title></head>
<body>
<!--#include virtual="/header.html" -->
<main>Main Content</main>
<!--#include virtual="/footer.html" -->
</body>
</html>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<header>Site Header</header>');
			expect(result).toContain('<main>Main Content</main>');
			expect(result).toContain('<footer>Site Footer</footer>');
		});

		test('should handle includes with subdirectories', async () => {
			const subDir = path.join(mockOutputDir, 'components');
			await fs.mkdir(subDir, { recursive: true });
			await fs.writeFile(path.join(subDir, 'nav.html'), '<nav>Navigation</nav>');

			const transform = createSSIShim();

			const html = `<!--#include virtual="/components/nav.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<nav>Navigation</nav>');
		});
	});

	describe('dir option for simulating server document root', () => {
		test('should resolve paths relative to specified dir', async () => {
			// Setup: Create file in subdirectory
			const includesDir = path.join(mockOutputDir, 'includes');
			await fs.mkdir(includesDir, { recursive: true });
			await fs.writeFile(
				path.join(includesDir, 'header.html'),
				'<header>Header with dir</header>',
			);

			// Simulate server document root path
			const serverDocRoot = '/home/www/document_root/';
			const transform = createSSIShim({ dir: serverDocRoot });

			// Use absolute server path in SSI directive
			const html = `<!--#include virtual="/home/www/document_root/includes/header.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			// Should read from {output}/includes/header.html
			expect(result).toContain('<header>Header with dir</header>');
		});

		test('should handle multiple includes with dir option', async () => {
			// Setup files
			const includesDir = path.join(mockOutputDir, 'includes');
			const partialsDir = path.join(mockOutputDir, 'partials');
			await fs.mkdir(includesDir, { recursive: true });
			await fs.mkdir(partialsDir, { recursive: true });
			await fs.writeFile(
				path.join(includesDir, 'header.html'),
				'<header>Header</header>',
			);
			await fs.writeFile(
				path.join(partialsDir, 'footer.html'),
				'<footer>Footer</footer>',
			);

			const serverDocRoot = '/var/www/html/';
			const transform = createSSIShim({ dir: serverDocRoot });

			const html = `<!DOCTYPE html>
<html>
<body>
<!--#include virtual="/var/www/html/includes/header.html" -->
<main>Content</main>
<!--#include virtual="/var/www/html/partials/footer.html" -->
</body>
</html>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<header>Header</header>');
			expect(result).toContain('<footer>Footer</footer>');
		});

		test('should handle error when path is outside of dir', async () => {
			const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

			const serverDocRoot = '/home/www/document_root/';
			const transform = createSSIShim({ dir: serverDocRoot });

			// Path outside of document root - file doesn't exist
			const html = `<!--#include virtual="/var/this-definitely-does-not-exist/file.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			// Should fail and return empty (file doesn't exist)
			expect(result).toBe('');
			expect(consoleWarnSpy).toHaveBeenCalled();

			consoleWarnSpy.mockRestore();
		});
	});

	describe('common SSI use cases and patterns', () => {
		test('should handle different file extensions (.txt, .shtml, .htm)', async () => {
			// Create files with different extensions
			await fs.writeFile(
				path.join(mockOutputDir, 'script.txt'),
				'<script>console.log("loaded");</script>',
			);
			await fs.writeFile(
				path.join(mockOutputDir, 'nav.shtml'),
				'<nav>Navigation Menu</nav>',
			);
			await fs.writeFile(
				path.join(mockOutputDir, 'sidebar.htm'),
				'<aside>Sidebar</aside>',
			);

			const transform = createSSIShim();

			const html = `<!DOCTYPE html>
<html>
<head>
<!--#include virtual="/script.txt" -->
</head>
<body>
<!--#include virtual="/nav.shtml" -->
<main>Content</main>
<!--#include virtual="/sidebar.htm" -->
</body>
</html>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<script>console.log("loaded");</script>');
			expect(result).toContain('<nav>Navigation Menu</nav>');
			expect(result).toContain('<aside>Sidebar</aside>');
		});

		test('should handle empty files', async () => {
			await fs.writeFile(path.join(mockOutputDir, 'empty.html'), '');

			const transform = createSSIShim();

			const html = `<div>Before</div>
<!--#include virtual="/empty.html" -->
<div>After</div>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe('<div>Before</div>\n\n<div>After</div>');
		});

		test('should handle typical page template pattern', async () => {
			// Setup typical template structure
			const includesDir = path.join(mockOutputDir, 'includes');
			await fs.mkdir(includesDir, { recursive: true });
			await fs.writeFile(
				path.join(includesDir, 'header.html'),
				'<header><h1>Site Title</h1></header>',
			);
			await fs.writeFile(
				path.join(includesDir, 'navigation.html'),
				'<nav><a href="/">Home</a></nav>',
			);
			await fs.writeFile(
				path.join(includesDir, 'footer.html'),
				'<footer>&copy; 2026</footer>',
			);

			const transform = createSSIShim();

			const html = `<!DOCTYPE html>
<html>
<head>
<title>My Page</title>
</head>
<body>
<!--#include virtual="/includes/header.html" -->
<!--#include virtual="/includes/navigation.html" -->
<main>
<h2>Page Content</h2>
<p>This is the main content.</p>
</main>
<!--#include virtual="/includes/footer.html" -->
</body>
</html>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<header><h1>Site Title</h1></header>');
			expect(result).toContain('<nav><a href="/">Home</a></nav>');
			expect(result).toContain('<h2>Page Content</h2>');
			expect(result).toContain('<footer>&copy; 2026</footer>');
			// Verify order is maintained
			expect(result.indexOf('<header>')).toBeLessThan(result.indexOf('<nav>'));
			expect(result.indexOf('<nav>')).toBeLessThan(result.indexOf('<main>'));
			expect(result.indexOf('<main>')).toBeLessThan(result.indexOf('<footer>'));
		});

		test('should handle filenames with special characters', async () => {
			// Create file with spaces and dashes
			await fs.writeFile(
				path.join(mockOutputDir, 'my-include file.html'),
				'<div>Special filename</div>',
			);

			const transform = createSSIShim();

			const html = `<!--#include virtual="/my-include file.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain('<div>Special filename</div>');
		});

		test('should handle large file includes', async () => {
			// Create a large file (100KB of content)
			const largeContent = '<div>Line</div>\n'.repeat(5000);
			await fs.writeFile(path.join(mockOutputDir, 'large.html'), largeContent);

			const transform = createSSIShim();

			const html = `<!--#include virtual="/large.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe(largeContent);
		});

		test('should preserve whitespace and formatting in included files', async () => {
			const formattedContent = `    <div class="indented">
        <p>Indented content</p>
    </div>`;
			await fs.writeFile(path.join(mockOutputDir, 'formatted.html'), formattedContent);

			const transform = createSSIShim();

			const html = `<div>
<!--#include virtual="/formatted.html" -->
</div>`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toContain(formattedContent);
		});

		test('should handle includes at the very beginning and end of document', async () => {
			await fs.writeFile(path.join(mockOutputDir, 'doctype.txt'), '<!DOCTYPE html>');
			await fs.writeFile(path.join(mockOutputDir, 'closing.txt'), '</html>');

			const transform = createSSIShim();

			const html = `<!--#include virtual="/doctype.txt" -->
<html>
<body>Content</body>
<!--#include virtual="/closing.txt" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toMatch(/^<!DOCTYPE html>/);
			expect(result).toMatch(/<\/html>$/);
		});

		test('should handle consecutive includes without content between them', async () => {
			await fs.writeFile(path.join(mockOutputDir, 'part1.html'), '<div>Part 1</div>');
			await fs.writeFile(path.join(mockOutputDir, 'part2.html'), '<div>Part 2</div>');
			await fs.writeFile(path.join(mockOutputDir, 'part3.html'), '<div>Part 3</div>');

			const transform = createSSIShim();

			const html = `<!--#include virtual="/part1.html" --><!--#include virtual="/part2.html" --><!--#include virtual="/part3.html" -->`;

			const ctx = createMockContext({
				context: {
					...createMockContext().context,
					dir: {
						root: '/mock/root',
						input: '/mock/input',
						output: mockOutputDir,
					},
				},
			});

			const result = await transform.transform(html, ctx);

			expect(result).toBe('<div>Part 1</div><div>Part 2</div><div>Part 3</div>');
		});
	});
});
