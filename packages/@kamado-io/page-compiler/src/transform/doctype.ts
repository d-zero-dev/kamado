import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

/**
 * Options for doctype
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface DoctypeOptions {}

/**
 * Creates a transform for adding DOCTYPE
 * @returns Transform object
 */
export function doctype<M extends MetaData>(): Transform<M> {
	return {
		name: 'doctype',
		transform: (content) => {
			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

			const trimmed = content.trim();

			// Check if content starts with <html but not with <!doctype html
			if (/^<html(?:\s|>)/i.test(trimmed) && !/^<!doctype html/i.test(trimmed)) {
				return '<!DOCTYPE html>\n' + content;
			}

			return content;
		},
	};
}
