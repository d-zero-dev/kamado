import { recordDataReads, tracedData, type TracedData } from '../data-trace.js';

interface Remembered<R> {
	readonly result: R;
	/** For each argument that was a page's `data`: the keys the call read from it. */
	readonly reads: readonly (readonly string[] | null | undefined)[];
}

/**
 * One step of the tree of arguments. Objects are held weakly: an argument that
 * only one page has (its `props.page`) must not stay alive, with its result,
 * for the life of the worker.
 */
interface Node<R> {
	readonly primitives: Map<unknown, Node<R>>;
	readonly objects: WeakMap<object, Node<R>>;
	remembered?: Remembered<R>;
}

/**
 * The step of `node` for one argument, made when there is none.
 * @param node - The step before
 * @param part - The argument (or the number of arguments, for the first step)
 */
function step<R>(node: Node<R>, part: unknown): Node<R> {
	const isObject =
		(typeof part === 'object' && part !== null) || typeof part === 'function';
	const existing = isObject ? node.objects.get(part) : node.primitives.get(part);
	if (existing) {
		return existing;
	}
	const next: Node<R> = { primitives: new Map(), objects: new WeakMap() };
	if (isObject) {
		node.objects.set(part, next);
	} else {
		node.primitives.set(part, next);
	}
	return next;
}

/**
 * Remembers the results of a function in the worker that renders, so that
 * what is the same for many pages (sorting the posts, building a list) is
 * computed once. Arguments are compared one by one the way a `Map` compares
 * keys (`Object.is`, except that `0` and `-0` are the same), so the values of
 * `props.data` (the same objects for every page of the worker) find the call
 * again, and a new object literal never does.
 *
 * The function must be synchronous and give a plain value: the result is
 * shared by every page that makes the call, so it must not be changed, and it
 * must not hold on to an argument that is the page's `data`, which is only
 * valid during the call (a read later throws, as a read that nobody recorded
 * would give a stale page).
 *
 * Why this and not a `Map` in the module: a page that keeps a result of the
 * data in a variable of the module is a page whose output depends on which
 * pages the worker rendered before it (RFC section 7.2); `no-module-state`
 * reports it. This keeps the result and still tells the core which keys of
 * `data` the page depends on, as the call read them: pass `props.data` itself
 * as an argument, and a page that gets the result from the cache depends on
 * the same keys as the page that made it.
 * Why not a key function: a wrong key would return a stale value, and a
 * stale page is the one thing a static site must not produce.
 * @param fn - A pure, synchronous function
 * @example
 * ```ts
 * const latest = memo((data: GlobalData) => data.posts.slice(0, 5));
 * export default (props: PageProps) => <List items={latest(props.data)} />;
 * ```
 */
export function memo<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	const root: Node<R> = { primitives: new Map(), objects: new WeakMap() };
	return (...args) => {
		const views = args.map((arg) => tracedData(arg));
		// A page's `data` is a new view for each page; what it stands for is the same.
		const identity = args.map((arg, i) => views[i]?.target ?? arg);
		let node = root;
		for (const part of [identity.length, ...identity]) {
			node = step(node, part);
		}
		const { remembered } = node;
		if (remembered) {
			replay(views, remembered.reads);
			return remembered.result;
		}
		const inner = views.map((view) => (view ? recordDataReads(view.target) : undefined));
		let result: R;
		try {
			result = fn(...(args.map((arg, i) => inner[i]?.data ?? arg) as A));
			if (inner.some((trace) => trace !== undefined && trace.data === result)) {
				throw new TypeError(
					'memo: the result is the data of the page itself, which is valid only during the call; return a value computed from it',
				);
			}
		} catch (error) {
			// Which keys the call would have read is not known.
			replay(
				views,
				views.map((view) => (view ? null : undefined)),
			);
			throw error;
		} finally {
			for (const trace of inner) {
				trace?.finish();
			}
		}
		const reads = inner.map((trace) => trace?.keys());
		node.remembered = { result, reads };
		replay(views, reads);
		return result;
	};
}

/**
 * Counts the keys a call read as read by each page that used the call.
 * @param views - The page's `data` among the arguments, by position
 * @param reads - The keys of the call, by position
 */
function replay(
	views: readonly (TracedData<object> | undefined)[],
	reads: readonly (readonly string[] | null | undefined)[],
): void {
	for (const [i, view] of views.entries()) {
		const keys = reads[i];
		if (view && keys !== undefined) {
			view.replay(keys);
		}
	}
}
