/**
 * Refuses keys a program API does not take. TypeScript catches typos at compile
 * time; JavaScript callers get the same refusal the config's unknown keys get.
 */

/**
 * Throws when `options` has a key that is not in `allowed`.
 * @param options - What the caller passed
 * @param allowed - The keys the API reads
 * @throws {Error} `unknown option: <key>` for the first key that is not allowed
 * @example
 * ```ts
 * assertKnownOptions({ incrementl: true }, ['incremental', 'cacheDir']);
 * // Error: unknown option: incrementl
 * ```
 */
export function assertKnownOptions(options: object, allowed: readonly string[]): void {
	const known = new Set(allowed);
	for (const key of Object.keys(options)) {
		if (!known.has(key)) {
			throw new Error(`unknown option: ${key}`);
		}
	}
}
