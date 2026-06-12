import { parseHTML } from 'linkedom';
import { describe, expect, test, vi } from 'vitest';

import { domSerialize, resolveHref } from './dom.js';

/**
 * Builds a detached <a> element with the given href attribute (or none if null).
 * @param href - href attribute value, or null to omit the attribute entirely
 */
function makeAnchor(href: string | null) {
	const { document } = parseHTML('<html><body></body></html>');
	const a = document.createElement('a');
	if (href !== null) {
		a.setAttribute('href', href);
	}
	return a;
}

describe('domSerialize > fragment classification', () => {
	test('full <html> document is treated as a full document, not a fragment', async () => {
		const out = await domSerialize('<html><body><p>x</p></body></html>', {
			hook: vi.fn(),
		});
		// documentElement.outerHTML round-trip + auto-head insertion (C9)
		expect(out).toBe('<html><head></head><body><p>x</p></body></html>');
	});

	test('input with leading HTML comment + DOCTYPE is still treated as a full document (C2)', async () => {
		// Without the C2 fix, this regex misclassifies as fragment and the
		// doctype/html structure are lost inside a synthetic <div>.
		const out = await domSerialize(
			'<!-- license --><!DOCTYPE html><html><body><p>x</p></body></html>',
			{ hook: vi.fn() },
		);
		expect(out).toContain('<html>');
		expect(out).toContain('<body>');
		// the document body element survives, not a wrapping div
		expect(out).not.toContain('<div>');
	});

	test('uppercase DOCTYPE is recognized', async () => {
		const out = await domSerialize('<!DOCTYPE html><html><body>x</body></html>', {
			hook: vi.fn(),
		});
		expect(out).toContain('<html>');
		expect(out).toContain('<body>x</body>');
	});

	test('leading whitespace before <html> is not misclassified', async () => {
		const out = await domSerialize('   <html><body>x</body></html>', { hook: vi.fn() });
		expect(out).toContain('<body>x</body>');
		expect(out).not.toContain('<div>');
	});

	test('leading comment terminated with --!> is recognized and stripped', async () => {
		// HTML5 tolerates `--!>` as an alternate comment terminator. The fragment
		// regex must strip such a leading comment before classifying the rest.
		const out = await domSerialize(
			'<!-- copyright --!><html><body><p>x</p></body></html>',
			{ hook: vi.fn() },
		);
		expect(out).toContain('<html>');
		expect(out).toContain('<body>');
		expect(out).not.toContain('<div>');
	});
});

describe('domSerialize > fragment branch (C3)', () => {
	test('text-only fragment is preserved', async () => {
		// Under the previous jsdom + tmpContainer.children path this would
		// return '' because text nodes are not Element nodes.
		const out = await domSerialize('hello world', { hook: vi.fn() });
		expect(out).toBe('hello world');
	});

	test('comment-only fragment is preserved', async () => {
		const out = await domSerialize('<!-- keep me -->', { hook: vi.fn() });
		expect(out).toBe('<!-- keep me -->');
	});

	test('mixed text and element fragment preserves both', async () => {
		const out = await domSerialize('<p>a</p>between<p>b</p>', { hook: vi.fn() });
		expect(out).toBe('<p>a</p>between<p>b</p>');
	});

	test('empty input returns empty string', async () => {
		const out = await domSerialize('', { hook: vi.fn() });
		expect(out).toBe('');
	});
});

describe('domSerialize > full-document branch', () => {
	test('bare "<!doctype html>" input does not throw and returns empty (C4)', async () => {
		// Pre-fix this would throw "Cannot read properties of null (reading 'outerHTML')"
		// because linkedom returns documentElement = null for this input.
		await expect(domSerialize('<!doctype html>', { hook: vi.fn() })).resolves.toBe('');
	});

	test('head-less document gets <head> auto-inserted (C9)', async () => {
		// Without C9 there is no </head> for the downstream inject-to-head
		// regex transform to anchor on, so script/meta injection silently no-ops.
		const out = await domSerialize('<html><body>x</body></html>', { hook: vi.fn() });
		expect(out).toContain('<head>');
		expect(out).toContain('</head>');
	});

	test('existing <head> is not duplicated', async () => {
		const out = await domSerialize(
			'<html><head><title>t</title></head><body>x</body></html>',
			{ hook: vi.fn() },
		);
		// exactly one <head> opening tag
		expect(out.match(/<head>/g)).toHaveLength(1);
		expect(out).toContain('<title>t</title>');
	});
});

describe('domSerialize > hook contract', () => {
	test('hook receives the elements and window', async () => {
		const seen: { elementCount: number; hasDocument: boolean } = {
			elementCount: 0,
			hasDocument: false,
		};
		await domSerialize('<p>a</p><p>b</p>', {
			hook: (elements, window) => {
				seen.elementCount = elements.length;
				seen.hasDocument = typeof window.document?.createElement === 'function';
			},
		});
		expect(seen.elementCount).toBe(2);
		expect(seen.hasDocument).toBe(true);
	});

	test('hook DOM mutations are reflected in the serialized output', async () => {
		const out = await domSerialize('<p>old</p>', {
			hook: (elements) => {
				elements[0]?.setAttribute('data-touched', 'yes');
			},
		});
		expect(out).toContain('data-touched="yes"');
	});

	test('async hooks are awaited before serialization', async () => {
		const out = await domSerialize('<p>start</p>', {
			hook: async (elements) => {
				await new Promise((resolve) => setImmediate(resolve));
				elements[0]?.setAttribute('async-applied', 'true');
			},
		});
		expect(out).toContain('async-applied="true"');
	});
});

describe('resolveHref', () => {
	test('absolute href is returned unchanged (ignores base)', () => {
		const a = makeAnchor('https://example.com/x?q=1');
		expect(resolveHref(a, 'https://other.example')).toBe('https://example.com/x?q=1');
	});

	test('relative href is resolved against the base URL', () => {
		const a = makeAnchor('/foo/bar');
		expect(resolveHref(a, 'https://example.com')).toBe('https://example.com/foo/bar');
	});

	test('relative href against a base with a path resolves like the URL spec', () => {
		const a = makeAnchor('sibling');
		expect(resolveHref(a, 'https://example.com/parent/child')).toBe(
			'https://example.com/parent/sibling',
		);
	});

	test('protocol-relative href takes the base scheme', () => {
		const a = makeAnchor('//cdn.example.com/x');
		expect(resolveHref(a, 'https://example.com')).toBe('https://cdn.example.com/x');
	});

	test('missing href attribute returns null', () => {
		const a = makeAnchor(null);
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('empty href returns null', () => {
		const a = makeAnchor('');
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('relative href with no base returns null', () => {
		const a = makeAnchor('/foo');
		expect(resolveHref(a)).toBeNull();
	});

	test('malformed URL returns null instead of throwing', () => {
		const a = makeAnchor('http://[invalid');
		expect(resolveHref(a)).toBeNull();
	});

	test('accepts a URL object as base', () => {
		const a = makeAnchor('/foo');
		expect(resolveHref(a, new URL('https://example.com/sub/'))).toBe(
			'https://example.com/foo',
		);
	});

	test('rejects javascript: URLs (XSS guard)', () => {
		const a = makeAnchor('javascript:alert(1)');
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('rejects data: URLs', () => {
		const a = makeAnchor('data:text/html,<script>alert(1)</script>');
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('rejects vbscript: URLs', () => {
		const a = makeAnchor('vbscript:msgbox(1)');
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('rejects file: URLs', () => {
		const a = makeAnchor('file:///etc/passwd');
		expect(resolveHref(a, 'https://example.com')).toBeNull();
	});

	test('strips basic-auth credentials from the resolved URL', () => {
		const a = makeAnchor('/foo');
		expect(resolveHref(a, 'https://user:pass@example.com')).toBe(
			'https://example.com/foo',
		);
	});

	test('strips credentials from an absolute href as well', () => {
		const a = makeAnchor('https://attacker:secret@evil.example/x');
		// Returned value must not contain the credentials.
		expect(resolveHref(a)).toBe('https://evil.example/x');
	});
});
