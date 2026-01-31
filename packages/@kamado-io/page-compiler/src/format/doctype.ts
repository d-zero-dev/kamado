/**
 * Applies DOCTYPE declaration to HTML content.
 *
 * Inserts `<!DOCTYPE html>` at the beginning of the content if:
 * - Content starts with `<html` tag (case insensitive)
 * - Content does not already start with `<!doctype html` (case insensitive)
 * @returns A function that takes content and returns content with DOCTYPE applied
 * @internal
 */
export function doctype(): (content: string | ArrayBuffer) => string | ArrayBuffer {
	return (content: string | ArrayBuffer): string | ArrayBuffer => {
		if (typeof content !== 'string') {
			return content;
		}

		const trimmed = content.trim();

		// Check if content starts with <html but not with <!doctype html
		if (/^<html(?:\s|>)/i.test(trimmed) && !/^<!doctype html/i.test(trimmed)) {
			return '<!DOCTYPE html>\n' + content;
		}

		return content;
	};
}
