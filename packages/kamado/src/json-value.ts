/**
 * Tells why a value cannot be the value of a data key, for a data file that is a script.
 * A value is JSON when it is `null`, a boolean, a finite number, a string, an array of
 * values or a plain object of values.
 * Why strict and not `JSON.stringify`'s own rules: `JSON.stringify` turns a `Date` into a
 * string and drops `undefined` and functions, so a data file would give the pages a value
 * different from the one it returned, and a Map or a class instance would become `{}`.
 * @param value - What the data file produced
 * @returns the path of the first value that is not JSON with what it is, or `null` when
 *   the whole value is
 * @example
 * ```ts
 * jsonProblem({ posts: [{ at: new Date() }] }); // '$.posts[0].at is a Date'
 * jsonProblem({ posts: [] }); // null
 * ```
 */
export function jsonProblem(value: unknown): string | null {
	const seen = new Set<object>();
	const walk = (v: unknown, at: string): string | null => {
		if (v === null || typeof v === 'boolean' || typeof v === 'string') {
			return null;
		}
		if (typeof v === 'number') {
			return Number.isFinite(v) ? null : `${at} is ${v}`;
		}
		if (typeof v !== 'object') {
			return `${at} is ${v === undefined ? 'undefined' : `a ${typeof v}`}`;
		}
		if (seen.has(v)) {
			return `${at} refers to a value that contains it`;
		}
		seen.add(v);
		try {
			if (Array.isArray(v)) {
				for (const [i, item] of v.entries()) {
					const found = walk(item, `${at}[${i}]`);
					if (found !== null) {
						return found;
					}
				}
				return null;
			}
			const proto = Object.getPrototypeOf(v) as unknown;
			if (proto !== Object.prototype && proto !== null) {
				const name = (proto as { constructor?: { name?: string } }).constructor?.name;
				return `${at} is ${name === undefined ? 'an object that is not plain' : `a ${name}`}`;
			}
			for (const [key, item] of Object.entries(v)) {
				const found = walk(item, `${at}.${key}`);
				if (found !== null) {
					return found;
				}
			}
			return null;
		} finally {
			seen.delete(v);
		}
	};
	return walk(value, '$');
}
