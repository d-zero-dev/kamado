import type { Transform } from 'kamado/config';

/**
 * Options for lineBreak
 */
export interface LineBreakOptions {
	readonly lineBreak?: '\n' | '\r\n';
}

/**
 * Creates a transform for line break normalization
 * @param options - Line break options
 * @returns Transform object
 */
export function lineBreak(options?: LineBreakOptions): Transform {
	return {
		name: 'lineBreak',
		transform: (content) => {
			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

			const lineBreakChar = options?.lineBreak ?? '\n';
			return content.replaceAll(/\r?\n/g, lineBreakChar);
		},
	};
}
