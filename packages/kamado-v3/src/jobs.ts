/**
 * Reads the value of `--jobs`: a positive integer, or `auto` (what `build.jobs: "auto"`
 * of the config says too), which leaves the number to the core.
 * @param value - The text after `--jobs`, if the flag was given
 * @returns The number of jobs, or `undefined` to let the core decide
 * @throws {Error} when the text is neither `auto` nor a positive integer
 * @example
 * ```ts
 * parseJobs('4'); // 4
 * parseJobs('auto'); // undefined
 * ```
 */
export function parseJobs(value?: string): number | undefined {
	if (value === undefined || value === 'auto') {
		return undefined;
	}
	const jobs = Number(value);
	if (!Number.isInteger(jobs) || jobs < 1) {
		throw new Error(`--jobs must be a positive integer or "auto": ${value}`);
	}
	return jobs;
}
