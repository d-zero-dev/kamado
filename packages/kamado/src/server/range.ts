/** The bytes a `Range` header asks for, both ends included. */
export interface ByteRange {
	readonly start: number;
	readonly end: number;
}

/**
 * Reads the `Range` header of a request for a file of `size` bytes. A browser
 * asks for parts of a video or an audio file (Safari will not play one from a
 * server that ignores it, and no browser can seek), so the dev server answers
 * them with `206`.
 *
 * Only one range of bytes is read: a header with several ranges, another unit
 * or a malformed value is ignored (`null`), and the whole file is sent, as
 * RFC 9110 allows. Why not several: browsers do not ask for them, and the
 * answer would be a `multipart/byteranges` body.
 * @param header - The value of the `Range` header, if the request had one
 * @param size - The size of the file
 * @returns The range to send, `'unsatisfiable'` when it starts at or after the
 *   end of the file (a `416`), or `null` to send the whole file
 * @example
 * ```ts
 * byteRange('bytes=0-1', 100); // { start: 0, end: 1 }
 * byteRange('bytes=90-', 100); // { start: 90, end: 99 }
 * byteRange('bytes=-10', 100); // { start: 90, end: 99 }
 * byteRange('bytes=100-', 100); // 'unsatisfiable'
 * byteRange(undefined, 100); // null
 * ```
 */
export function byteRange(
	header: string | undefined,
	size: number,
): ByteRange | 'unsatisfiable' | null {
	// The unit is not case-sensitive (RFC 9110).
	const match = /^bytes=(\d*)-(\d*)$/i.exec(header?.trim() ?? '');
	if (!match) {
		return null;
	}
	const [, first = '', last = ''] = match;
	if (first === '') {
		if (last === '') {
			return null;
		}
		// A suffix: the last bytes of the file.
		const length = Number(last);
		if (length === 0 || size === 0) {
			return 'unsatisfiable';
		}
		return { start: Math.max(0, size - length), end: size - 1 };
	}
	const start = Number(first);
	if (last !== '' && Number(last) < start) {
		return null;
	}
	if (start >= size) {
		return 'unsatisfiable';
	}
	return { start, end: last === '' ? size - 1 : Math.min(Number(last), size - 1) };
}
