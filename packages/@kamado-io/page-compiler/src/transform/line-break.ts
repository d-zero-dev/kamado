import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

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
export function lineBreak<M extends MetaData>(options?: LineBreakOptions): Transform<M> {
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
