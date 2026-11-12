import { describe, expect, test } from 'vitest';

import { recordDataReads, tracedData, withFailures } from './data-trace.js';

const data = { posts: [1, 2], site: { name: 'S' }, news: [] };

describe('recordDataReads', () => {
	test('records the top-level keys a page reads, once each', () => {
		const trace = recordDataReads(data);

		void trace.data.posts;
		void trace.data.posts;
		void trace.data.site.name;
		trace.finish();

		expect(trace.keys()).toEqual(['posts', 'site']);
	});

	test('records a key that does not exist, so that adding it later rebuilds the page', () => {
		const trace = recordDataReads(data);

		void (trace.data as Record<string, unknown>).missing;
		trace.finish();

		expect(trace.keys()).toEqual(['missing']);
	});

	test('records nothing for a page that reads no data', () => {
		const trace = recordDataReads(data);
		trace.finish();

		expect(trace.keys()).toEqual([]);
	});

	test.each([
		['Object.keys', (d: object) => Object.keys(d)],
		['the spread', (d: object) => ({ ...d })],
		['JSON.stringify', (d: object) => JSON.stringify(d)],
		['the in operator', (d: object) => 'posts' in d],
		['Object.entries', (d: object) => Object.entries(d)],
	])('%s depends on every key', (_, read) => {
		const trace = recordDataReads(data);

		read(trace.data);
		trace.finish();

		expect(trace.keys()).toBeNull();
	});

	test('a read after the page is rendered throws instead of going unrecorded', () => {
		const trace = recordDataReads(data);
		const kept = trace.data;
		trace.finish();

		expect(() => kept.posts).toThrow(TypeError);
	});

	test('a value read from a key is the plain value, not a wrapper', () => {
		const trace = recordDataReads(data);

		expect(trace.data.posts).toBe(data.posts);
		trace.finish();
	});

	test('a failed render depends on every key', () => {
		const trace = recordDataReads(data);

		void trace.data.posts;
		trace.fail();

		expect(trace.keys()).toBeNull();
	});

	test('a name that is not a key now is a dependency too, for a file of that name later', () => {
		const trace = recordDataReads(data);

		void (trace.data as Record<string, unknown>).toJSON;
		void trace.data.constructor;
		void trace.data.posts;
		trace.finish();

		expect(trace.keys()).toEqual(['toJSON', 'constructor', 'posts']);
	});

	test('a page cannot change the data', () => {
		const trace = recordDataReads({ ...data });

		expect(() => {
			(trace.data as Record<string, unknown>).posts = 1;
		}).toThrow(TypeError);
		expect(() => {
			delete (trace.data as Record<string, unknown>).posts;
		}).toThrow(TypeError);
		expect(() => Object.defineProperty(trace.data, 'x', { value: 1 })).toThrow(TypeError);
	});

	test('reading the descriptor of a key is enough to depend on every key', () => {
		const trace = recordDataReads(data);

		Object.getOwnPropertyDescriptor(trace.data, 'posts');
		trace.finish();

		expect(trace.keys()).toBeNull();
	});

	test('a failed render revokes the view too', () => {
		const trace = recordDataReads(data);
		const kept = trace.data;
		trace.fail();

		expect(() => kept.posts).toThrow(TypeError);
	});

	test('replay counts keys as read, or every key', () => {
		const trace = recordDataReads(data);

		tracedData(trace.data)?.replay(['news']);
		expect(trace.keys()).toEqual(['news']);
		tracedData(trace.data)?.replay(null);

		expect(trace.keys()).toBeNull();
		expect(tracedData({})).toBeUndefined();
		expect(tracedData(null)).toBeUndefined();
	});
});

describe('withFailures', () => {
	test('gives the data back as it is when nothing failed', () => {
		expect(withFailures(data)).toBe(data);
		expect(withFailures(data, {})).toBe(data);
	});

	test('a page that reads a failed key fails with the reason, and the others read on', () => {
		const view = withFailures({ posts: [1] }, { news: 'timed out' }) as Record<
			string,
			unknown
		>;

		expect(view['posts']).toEqual([1]);
		expect(() => view['news']).toThrow(
			'data.news is not available, its data file failed: timed out',
		);
	});

	test('the spread and JSON.stringify fail too, instead of leaving the key out', () => {
		const view = withFailures({ posts: [1] }, { news: 'refused' });

		expect(() => ({ ...view })).toThrow('refused');
		expect(() => JSON.stringify(view)).toThrow('refused');
		expect(Object.keys(view)).toEqual(['posts', 'news']);
	});

	test('the recording view still records the key a page tried to read', () => {
		const trace = recordDataReads(withFailures({}, { news: 'x' }));

		expect(() => (trace.data as Record<string, unknown>)['news']).toThrow();
		trace.fail();

		expect(trace.keys()).toBeNull();
	});
});
