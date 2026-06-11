import { describe, test, expect } from 'vitest';

import { createCacheDigest, hashContent, stableSerialize } from './cache-digest.js';

describe('stableSerialize', () => {
	test('serializes objects with sorted keys so key order does not matter', () => {
		expect(stableSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(stableSerialize({ a: 2, b: 1 })).toBe('{"a":2,"b":1}');
	});

	test('omits function and undefined object properties', () => {
		expect(stableSerialize({ a: 1, fn: () => 1, missing: undefined })).toBe('{"a":1}');
	});

	test('serializes function and undefined array elements as null', () => {
		expect(stableSerialize([1, () => 1, undefined, 'x'])).toBe('[1,null,null,"x"]');
	});

	test('serializes dates as ISO strings', () => {
		expect(stableSerialize(new Date('2026-01-02T03:04:05.000Z'))).toBe(
			'"2026-01-02T03:04:05.000Z"',
		);
	});

	test('serializes primitives and null', () => {
		expect(stableSerialize('text')).toBe('"text"');
		expect(stableSerialize(42)).toBe('42');
		expect(stableSerialize(true)).toBe('true');
		expect(stableSerialize(null)).toBe('null');
		expect(stableSerialize()).toBe('null');
		expect(stableSerialize(10n)).toBe('"10n"');
	});

	test('collapses circular references instead of throwing', () => {
		const circular: Record<string, unknown> = { name: 'root' };
		circular.self = circular;
		expect(stableSerialize(circular)).toBe('{"name":"root","self":"[circular]"}');
	});

	test('serializes nested structures deterministically', () => {
		expect(stableSerialize({ list: [{ z: 1, y: [2, 3] }] })).toBe(
			'{"list":[{"y":[2,3],"z":1}]}',
		);
	});

	test('serializes Map contents instead of collapsing to {}', () => {
		const a = stableSerialize(
			new Map([
				['home', '/'],
				['about', '/about/'],
			]),
		);
		// Different entries must produce a different serialization
		const b = stableSerialize(new Map([['home', '/changed']]));
		expect(a).not.toBe(b);
		expect(a).not.toBe('{}');
		// Entry insertion order does not matter
		expect(
			stableSerialize(
				new Map([
					['about', '/about/'],
					['home', '/'],
				]),
			),
		).toBe(a);
		// Lock the exact format so an accidental change (which would invalidate
		// every existing manifest) is caught
		expect(
			stableSerialize(
				new Map<string, number>([
					['b', 2],
					['a', 1],
				]),
			),
		).toBe('Map("a":1,"b":2)');
	});

	test('serializes Set contents and distinguishes it from a Map', () => {
		const set = stableSerialize(new Set(['a', 'b']));
		expect(set).not.toBe('{}');
		expect(stableSerialize(new Set(['b', 'a']))).toBe(set);
		expect(stableSerialize(new Set(['a', 'c']))).not.toBe(set);
		// A Map and a Set with the same elements must not collide
		expect(stableSerialize(new Map([['a', 'b']]))).not.toBe(
			stableSerialize(new Set(['a', 'b'])),
		);
		// Lock the exact format
		expect(stableSerialize(new Set(['b', 'a']))).toBe('Set("a","b")');
	});

	test('serializes RegExp by source and flags', () => {
		expect(stableSerialize(/foo/gi)).toBe('"RegExp(foo/gi)"');
		expect(stableSerialize(/foo/g)).not.toBe(stableSerialize(/foo/gi));
		expect(stableSerialize(/foo/)).not.toBe(stableSerialize(/bar/));
	});
});

describe('hashContent / createCacheDigest', () => {
	test('hashContent returns the SHA-256 hex digest', () => {
		// echo -n 'kamado' | shasum -a 256
		expect(hashContent('kamado')).toBe(
			'6618ce7305a59453069b3ff14b9e1b3f1c7798e6c6e2e4434b90461f9b72cc58',
		);
	});

	test('createCacheDigest is identical for objects that differ only in key order', () => {
		expect(createCacheDigest({ a: 1, b: { d: 4, c: 3 } })).toBe(
			createCacheDigest({ b: { c: 3, d: 4 }, a: 1 }),
		);
	});

	test('createCacheDigest differs when a value changes', () => {
		expect(createCacheDigest({ a: 1 })).not.toBe(createCacheDigest({ a: 2 }));
	});
});
