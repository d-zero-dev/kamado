/**
 * A line diff for showing how two normalized pages differ (`compare-outputs.ts --diff`).
 * The common head and tail are cut first, so a page that differs in a few places stays
 * cheap. The middle is matched by the longest common subsequence; when it is too large
 * for that table, every line of it is shown as removed and added.
 */

// The table is a Uint32Array of (lines + 1)² cells: 20 million is about 80 MB, enough
// for two pages of about 4,500 differing lines each. Past that the middle is shown whole.
const MAX_CELLS = 20_000_000;

/**
 * Compares two lists of lines.
 * @param a - The baseline lines
 * @param b - The candidate lines
 * @param context - The number of unchanged lines shown around each change
 * @returns `-` for removed lines, `+` for added ones, a space for context, and `@@`
 * between changes that are further apart than the context
 * @example
 * lineDiff(['a', 'b'], ['a', 'c'], 0); // ['-b', '+c']
 */
export function lineDiff(
	a: readonly string[],
	b: readonly string[],
	context = 3,
): string[] {
	let head = 0;
	while (head < a.length && head < b.length && a[head] === b[head]) {
		head++;
	}
	let tail = 0;
	while (
		tail < a.length - head &&
		tail < b.length - head &&
		a[a.length - 1 - tail] === b[b.length - 1 - tail]
	) {
		tail++;
	}
	const x = a.slice(head, a.length - tail);
	const y = b.slice(head, b.length - tail);

	const ops: { kind: ' ' | '-' | '+'; line: string }[] = a
		.slice(0, head)
		.map((line) => ({ kind: ' ', line }));
	if ((x.length + 1) * (y.length + 1) > MAX_CELLS) {
		ops.push(
			...x.map((line) => ({ kind: '-' as const, line })),
			...y.map((line) => ({ kind: '+' as const, line })),
		);
	} else {
		const width = y.length + 1;
		const table = new Uint32Array((x.length + 1) * width);
		for (let i = x.length - 1; i >= 0; i--) {
			for (let j = y.length - 1; j >= 0; j--) {
				table[i * width + j] =
					x[i] === y[j]
						? table[(i + 1) * width + j + 1]! + 1
						: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
			}
		}
		let i = 0;
		let j = 0;
		while (i < x.length || j < y.length) {
			if (i < x.length && j < y.length && x[i] === y[j]) {
				ops.push({ kind: ' ', line: x[i]! });
				i++;
				j++;
			} else if (
				i < x.length &&
				(j === y.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)
			) {
				ops.push({ kind: '-', line: x[i]! });
				i++;
			} else {
				ops.push({ kind: '+', line: y[j]! });
				j++;
			}
		}
	}
	ops.push(...a.slice(a.length - tail).map((line) => ({ kind: ' ' as const, line })));

	// Show every change with `context` lines on each side; hunks that do not touch are
	// separated by `@@`.
	const show = new Set<number>();
	for (const [index, op] of ops.entries()) {
		if (op.kind === ' ') {
			continue;
		}
		for (
			let k = Math.max(0, index - context);
			k <= Math.min(ops.length - 1, index + context);
			k++
		) {
			show.add(k);
		}
	}
	const out: string[] = [];
	let previous = -1;
	for (const index of [...show].toSorted((p, q) => p - q)) {
		if (previous !== -1 && index > previous + 1) {
			out.push('@@');
		}
		const op = ops[index]!;
		out.push(`${op.kind}${op.line}`);
		previous = index;
	}
	return out;
}
