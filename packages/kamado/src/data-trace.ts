/**
 * Records which top-level keys of `data` a page reads while it is rendered,
 * so that the core rebuilds the page only when one of those keys changes.
 *
 * Why a Proxy at run time and not static analysis: a read that analysis
 * misses (a computed key, a value passed through a helper) would leave a
 * stale page behind, while a read the Proxy sees is never missed.
 * Why only the top level: nested values are returned as they are, so the
 * cost of a read stays that of a property access.
 * Enumeration (`Object.keys`, the spread, `JSON.stringify`, `in`) cannot say
 * which keys matter, so it depends on every key; so does a failed render.
 */

/** What `tracedData` tells about a `data` that records reads. */
export interface TracedData<T extends object> {
	/** The plain data behind the view. */
	readonly target: T;
	/** Counts keys as read by the page (`null`: every key), as if it had read them itself. */
	replay(keys: readonly string[] | null): void;
}

const traced = new WeakMap<object, TracedData<object>>();

/**
 * Tells whether a value is the recording view of a page's `data`.
 * Why: `memo` shares one call between pages whose views are different
 * objects, so it compares the data behind them and hands the keys the call
 * read to each page that uses the call.
 * @param value - Any argument of a memoized call
 * @example
 * ```ts
 * const view = tracedData(props.data);
 * view?.replay(['posts']);
 * ```
 */
export function tracedData(value: unknown): TracedData<object> | undefined {
	return typeof value === 'object' && value !== null ? traced.get(value) : undefined;
}

/** What a render read from `data`. */
export interface DataTrace<T extends object> {
	/** The `data` to hand to the page: a revocable view that records reads. */
	readonly data: T;
	/**
	 * Ends the render: later reads through `data` throw.
	 * Why: a reference kept in module state and read by a later page would
	 * otherwise be a read nobody recorded.
	 */
	finish(): void;
	/** Ends a render that threw; the page then depends on every key. */
	fail(): void;
	/** The keys read in the order of first read, or `null` for every key. */
	keys(): readonly string[] | null;
}

/**
 * Wraps `data` in a recording view.
 * @param data - The global data of the site
 * @example
 * ```ts
 * const trace = recordDataReads(context.data);
 * render(page, { ...props, data: trace.data });
 * trace.finish();
 * trace.keys(); // ['posts']
 * ```
 */
export function recordDataReads<T extends object>(data: T): DataTrace<T> {
	const read = new Set<string>();
	let everything = false;
	const all = () => {
		everything = true;
	};
	const { proxy, revoke } = Proxy.revocable(data, {
		get(target, key, receiver) {
			// Every name, also one that is not a key now: a data file of that name may be added later,
			// and the page must be built again then.
			if (typeof key === 'string') {
				read.add(key);
			}
			return Reflect.get(target, key, receiver);
		},
		// Why the data is read-only: a page that writes to it gives the pages the worker
		// renders after it a different `data`, which no record of reads can describe.
		set() {
			throw new TypeError('data is read-only: a page cannot change it');
		},
		defineProperty() {
			throw new TypeError('data is read-only: a page cannot change it');
		},
		deleteProperty() {
			throw new TypeError('data is read-only: a page cannot change it');
		},
		has(target, key) {
			all();
			return Reflect.has(target, key);
		},
		ownKeys(target) {
			all();
			return Reflect.ownKeys(target);
		},
		getOwnPropertyDescriptor(target, key) {
			all();
			return Reflect.getOwnPropertyDescriptor(target, key);
		},
	});
	traced.set(proxy, {
		target: data,
		replay(keys) {
			if (keys === null) {
				all();
				return;
			}
			for (const key of keys) {
				read.add(key);
			}
		},
	});
	return {
		data: proxy,
		finish: revoke,
		fail() {
			all();
			revoke();
		},
		keys: () => (everything ? null : [...read]),
	};
}
