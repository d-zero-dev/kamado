import { describe, expect, test } from 'vitest';

import { contentTypeOf } from './mime.js';

describe('contentTypeOf', () => {
	test.each([
		['/site/index.html', 'text/html; charset=utf-8'],
		['/site/a.css', 'text/css; charset=utf-8'],
		['/site/a.js', 'text/javascript; charset=utf-8'],
		['/site/a.json', 'application/json; charset=utf-8'],
		['/site/feed.xml', 'application/xml; charset=utf-8'],
		['/site/logo.svg', 'image/svg+xml'],
		['/site/photo.jpeg', 'image/jpeg'],
		['/site/photo.webp', 'image/webp'],
		['/site/font.woff2', 'font/woff2'],
		['/site/clip.mp4', 'video/mp4'],
		['/site/doc.pdf', 'application/pdf'],
	])('%s is %s', (file, type) => {
		expect(contentTypeOf(file)).toBe(type);
	});

	test('the extension is matched without regard to case', () => {
		expect(contentTypeOf('/site/LOGO.PNG')).toBe('image/png');
	});

	test('an unknown or missing extension is a binary download', () => {
		expect(contentTypeOf('/site/file.unknown')).toBe('application/octet-stream');
		expect(contentTypeOf('/site/LICENSE')).toBe('application/octet-stream');
	});
});
