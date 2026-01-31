import type { PageCompilerOptions } from '../types.js';

/**
 * Options for line break normalization
 */
export interface LineBreakOptions {
	/**
	 * Target line break format (e.g., '\n', '\r\n')
	 */
	readonly lineBreak?: PageCompilerOptions['lineBreak'];
}

/**
 * Normalizes line breaks in HTML content.
 *
 * Replaces all line breaks (both \n and \r\n) with the specified format.
 * @param options - Configuration options
 * @returns A function that takes content and returns content with normalized line breaks
 * @internal
 */
export function lineBreak(
	options?: LineBreakOptions,
): (content: string | ArrayBuffer) => string | ArrayBuffer {
	return (content: string | ArrayBuffer): string | ArrayBuffer => {
		if (typeof content !== 'string') {
			return content;
		}

		const { lineBreak } = options ?? {};

		if (!lineBreak) {
			return content;
		}

		return content.replaceAll(/\r?\n/g, lineBreak);
	};
}
