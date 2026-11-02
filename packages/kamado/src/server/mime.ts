import path from 'node:path';

/**
 * The content types of the files a site is made of. v2 knew six; a browser
 * refuses fonts, modules and media that arrive with a wrong type, and sniffs
 * the rest, so the common ones are listed.
 *
 * No type carries a `charset`. These files are sent as the bytes they are, and
 * the bytes are not read, so a header of `charset=utf-8` would be a claim
 * nobody checked: the header outranks a `<meta charset>` and an `@charset`, so
 * for a Shift_JIS file the claim turns it into garbage. Without the header the
 * declaration in the file decides. A file with none (a UTF-8 HTML with no BOM
 * and no `<meta charset>`, a text file) is read as the page that loads it or the
 * browser decides, as in v2.
 *
 * Reading the bytes to claim UTF-8 only for a file that is valid UTF-8 is not
 * done either: every static file would have to be read whole before its first
 * byte is sent, and would no longer be streamed or answer a `Range`.
 *
 * A body that is built here (a page, a stylesheet, a script) is always UTF-8,
 * and whoever sends it says so.
 */
const TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html',
	'.htm': 'text/html',
	'.css': 'text/css',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.json': 'application/json',
	'.map': 'application/json',
	'.webmanifest': 'application/manifest+json',
	'.xml': 'application/xml',
	'.txt': 'text/plain',
	'.csv': 'text/csv',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.avif': 'image/avif',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.eot': 'application/vnd.ms-fontobject',
	'.mp4': 'video/mp4',
	'.m4v': 'video/mp4',
	'.webm': 'video/webm',
	'.ogv': 'video/ogg',
	'.mov': 'video/quicktime',
	'.vtt': 'text/vtt',
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.aac': 'audio/aac',
	'.flac': 'audio/flac',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.wasm': 'application/wasm',
};

/**
 * The content type of a body that is built here (a page, a stylesheet, a
 * script): it is always UTF-8, so it says so. The one place that says it, so
 * that a file's type (`contentTypeOf`, which carries no `charset`) is never
 * given a second one.
 * @param type - A type with no parameter, such as `text/html`
 * @returns The type with `charset=utf-8`
 * @example
 * ```ts
 * withUtf8('text/html'); // 'text/html; charset=utf-8'
 * ```
 */
export function withUtf8(type: string): string {
	return `${type}; charset=utf-8`;
}

/**
 * The content type for a file name, from its extension.
 * @param file - A path or file name
 * @returns The type, or `application/octet-stream` for an unknown extension
 * @example
 * ```ts
 * contentTypeOf('/site/logo.svg'); // 'image/svg+xml'
 * contentTypeOf('/site/index.html'); // 'text/html' (no charset: the file's own declaration decides)
 * ```
 */
export function contentTypeOf(file: string): string {
	return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
