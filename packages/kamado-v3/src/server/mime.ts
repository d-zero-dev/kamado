import path from 'node:path';

/**
 * The content types of the files a site is made of. v2 knew six; a browser
 * refuses fonts, modules and media that arrive with a wrong type, and sniffs
 * the rest, so the common ones are listed.
 */
const TYPES: Readonly<Record<string, string>> = {
	'.html': 'text/html; charset=utf-8',
	'.htm': 'text/html; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.xml': 'application/xml; charset=utf-8',
	'.txt': 'text/plain; charset=utf-8',
	'.csv': 'text/csv; charset=utf-8',
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
	'.webm': 'video/webm',
	'.mp3': 'audio/mpeg',
	'.wav': 'audio/wav',
	'.ogg': 'audio/ogg',
	'.pdf': 'application/pdf',
	'.zip': 'application/zip',
	'.wasm': 'application/wasm',
};

/**
 * The content type for a file name, from its extension.
 * @param file - A path or file name
 * @returns The type, or `application/octet-stream` for an unknown extension
 * @example
 * ```ts
 * contentTypeOf('/site/logo.svg'); // 'image/svg+xml'
 * ```
 */
export function contentTypeOf(file: string): string {
	return TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
