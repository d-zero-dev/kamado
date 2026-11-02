import { describe, expect, test } from 'vitest';

import { contentTypeOf, withUtf8 } from './mime.js';

describe('contentTypeOf', () => {
	test.each([
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/index.html', 'text/html'],
		// ['/site/index.html', 'text/html; charset=utf-8'], // previous
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/a.css', 'text/css'],
		// ['/site/a.css', 'text/css; charset=utf-8'], // previous
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/a.js', 'text/javascript'],
		// ['/site/a.js', 'text/javascript; charset=utf-8'], // previous
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/a.json', 'application/json'],
		// ['/site/a.json', 'application/json; charset=utf-8'], // previous
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/feed.xml', 'application/xml'],
		// ['/site/feed.xml', 'application/xml; charset=utf-8'], // previous
		['/site/logo.svg', 'image/svg+xml'],
		['/site/photo.jpeg', 'image/jpeg'],
		['/site/photo.webp', 'image/webp'],
		['/site/font.woff2', 'font/woff2'],
		['/site/clip.mp4', 'video/mp4'],
		['/site/clip.mov', 'video/quicktime'],
		// Behavior change: a static file has no charset, so that its own declaration decides
		['/site/subs.vtt', 'text/vtt'],
		// ['/site/subs.vtt', 'text/vtt; charset=utf-8'], // previous
		['/site/voice.m4a', 'audio/mp4'],
		['/site/doc.pdf', 'application/pdf'],
	])('%s is %s', (file, type) => {
		expect(contentTypeOf(file)).toBe(type);
	});

	test.each([
		['/site/old.htm', 'text/html'],
		['/site/a.mjs', 'text/javascript'],
		['/site/a.js.map', 'application/json'],
		['/site/a.webmanifest', 'application/manifest+json'],
		['/site/a.txt', 'text/plain'],
		['/site/a.csv', 'text/csv'],
	])('%s is %s, with no charset', (file, type) => {
		expect(contentTypeOf(file)).toBe(type);
	});

	test('a body that is built here says it is UTF-8', () => {
		expect(withUtf8('text/html')).toBe('text/html; charset=utf-8');
	});

	test('the extension is matched without regard to case', () => {
		expect(contentTypeOf('/site/LOGO.PNG')).toBe('image/png');
	});

	test('an unknown or missing extension is a binary download', () => {
		expect(contentTypeOf('/site/file.unknown')).toBe('application/octet-stream');
		expect(contentTypeOf('/site/LICENSE')).toBe('application/octet-stream');
	});
});
