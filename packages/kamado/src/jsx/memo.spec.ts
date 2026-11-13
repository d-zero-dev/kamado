import { describe, expect, test } from 'vitest';

import { recordDataReads } from '../data-trace.js';

import { memo } from './memo.js';

const data = { posts: [3, 1, 2], site: { name: 'S' }, news: [] as number[] };

describe('memo', () => {
	test('calls the function once for the same arguments', () => {
		let calls = 0;
		const sorted = memo((list: number[]) => {
			calls++;
			return list.toSorted((a, b) => a - b);
		});

		const first = sorted(data.posts);
		const second = sorted(data.posts);

		expect(calls).toBe(1);
		expect(second).toBe(first);
	});

	test('calls it again for an argument that is not the same value', () => {
		let calls = 0;
		const double = memo((n: number, label: string) => {
			calls++;
			return `${label}${n * 2}`;
		});

		double(1, 'a');
		double(2, 'a');
		double(1, 'b');
		double(1, 'a');

		expect(calls).toBe(3);
	});

	test('a different number of arguments is a different call', () => {
		let calls = 0;
		const count = memo((...args: number[]) => {
			calls++;
			return args.length;
		});

		count(1);
		count(1, 2);
		count(1);

		expect(calls).toBe(2);
	});

	test('does not keep a call that threw', () => {
		let calls = 0;
		const fail = memo((): number => {
			calls++;
			throw new Error('x');
		});

		expect(() => fail()).toThrow('x');
		expect(() => fail()).toThrow('x');

		expect(calls).toBe(2);
	});
});

describe('memo with the data of a page', () => {
	test('is shared by two pages, each depending on the keys the function read', () => {
		let calls = 0;
		const titles = memo((d: typeof data) => {
			calls++;
			return d.posts.length;
		});
		const one = recordDataReads(data);
		const two = recordDataReads(data);

		expect(titles(one.data)).toBe(3);
		expect(titles(two.data)).toBe(3);
		one.finish();
		two.finish();

		expect(calls).toBe(1);
		expect(one.keys()).toEqual(['posts']);
		// The page that hit the cache depends on the same key.
		expect(two.keys()).toEqual(['posts']);
	});

	test('keeps what the page read itself besides what the function read', () => {
		const titles = memo((d: typeof data) => d.posts.length);
		const page = recordDataReads(data);

		void page.data.site;
		titles(page.data);
		page.finish();

		expect(page.keys()).toEqual(['site', 'posts']);
	});

	test('a function that lists the keys makes the page depend on every key', () => {
		const all = memo((d: typeof data) => Object.keys(d).length);
		const first = recordDataReads(data);
		const second = recordDataReads(data);

		all(first.data);
		all(second.data);

		expect(first.keys()).toBeNull();
		expect(second.keys()).toBeNull();
	});

	test('a call that threw makes the page depend on every key', () => {
		const fail = memo((d: typeof data) => {
			void d.posts;
			throw new Error('x');
		});
		const page = recordDataReads(data);

		expect(() => fail(page.data)).toThrow('x');

		expect(page.keys()).toBeNull();
	});

	test('another data object is another call', () => {
		let calls = 0;
		const count = memo((d: typeof data) => {
			calls++;
			return d.posts.length;
		});
		const next = { ...data, posts: [1] };

		count(recordDataReads(data).data);
		count(recordDataReads(next).data);

		expect(calls).toBe(2);
	});

	test('refuses a result that is the data of the page itself', () => {
		const pick = memo((d: typeof data) => d);
		const page = recordDataReads(data);

		expect(() => pick(page.data)).toThrow(TypeError);
		expect(page.keys()).toBeNull();
	});

	test('a closure over the data of the page throws when it is used after the call', () => {
		const lazy = memo((d: typeof data) => () => d.posts);
		const page = recordDataReads(data);

		const read = lazy(page.data);

		expect(() => read()).toThrow(TypeError);
	});

	test('a value and its negative zero are the same argument, as for a Map', () => {
		let calls = 0;
		const inverse = memo((x: number) => {
			calls++;
			return 1 / x;
		});

		inverse(0);
		inverse(-0);

		expect(calls).toBe(1);
	});

	test('an argument next to the data is part of the call', () => {
		let calls = 0;
		const count = memo((d: typeof data, n: number) => {
			calls++;
			return d.posts.length + n;
		});
		const page = recordDataReads(data);

		count(page.data, 1);
		count(page.data, 2);
		count(page.data, 1);

		expect(calls).toBe(2);
	});

	test('a function that returns undefined is remembered too', () => {
		let calls = 0;
		const nothing = memo((): undefined => {
			calls++;
		});

		nothing();
		nothing();

		expect(calls).toBe(1);
	});
});
