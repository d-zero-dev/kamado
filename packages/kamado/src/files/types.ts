/**
 * Mapping of extensions to output file types
 */
export interface ExtensionOutputTypeMap {
	/**
	 * Output type for HTML files
	 */
	readonly html: OutputFileType;
	/**
	 * Output type for Pug files
	 */
	readonly pug: OutputFileType;
	/**
	 * Output type for CSS files
	 */
	readonly css: OutputFileType;
	/**
	 * Output type for SCSS files
	 */
	readonly scss: OutputFileType;
	/**
	 * Output type for SASS files
	 */
	readonly sass: OutputFileType;
	/**
	 * Output type for JavaScript files
	 */
	readonly js: OutputFileType;
	/**
	 * Output type for ES Module files
	 */
	readonly mjs: OutputFileType;
	/**
	 * Output type for CommonJS files
	 */
	readonly cjs: OutputFileType;
	/**
	 * Output type for JSX files
	 */
	readonly jsx: OutputFileType;
	/**
	 * Output type for TypeScript files
	 */
	readonly ts: OutputFileType;
	/**
	 * Output type for TSX files
	 */
	readonly tsx: OutputFileType;
}

/**
 * Type for supported extensions
 */
export type Extension = keyof ExtensionOutputTypeMap;

/**
 * Output file type
 * - 'page': Page file (HTML)
 * - 'style': Style file (CSS)
 * - 'script': Script file (JavaScript)
 * - '#error': Error (unsupported file type)
 * - '#ignore': Ignored file
 */
export type OutputFileType = 'page' | 'style' | 'script' | '#error' | '#ignore';

/**
 * File object interface
 */
export interface FileObject {
	/**
	 * Input file path
	 */
	readonly inputPath: string;
	/**
	 * Gets file content
	 * @param cache - Whether to cache the file content (default: true)
	 * @returns File content
	 */
	get(cache?: boolean): Promise<FileContent>;
}

/**
 * File content
 */
export interface FileContent {
	/**
	 * Metadata (front matter, etc.)
	 */
	readonly metaData: MetaData;
	/**
	 * File content (excluding metadata)
	 */
	readonly content: string;
	/**
	 * Raw file content
	 */
	readonly raw: string | ArrayBuffer;
}

/**
 * Metadata interface
 * Object with arbitrary key-value pairs
 */
export interface MetaData {
	readonly [key: string]: unknown;
}

/**
 * Compilable file interface
 */
export interface CompilableFile extends FileObject {
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * File slug (filename without extension, or parent directory name if index)
	 */
	readonly fileSlug: string;
	/**
	 * File path stem (path without extension, slash-separated)
	 */
	readonly filePathStem: string;
	/**
	 * File URL path
	 */
	readonly url: string;
	/**
	 * File extension (including dot)
	 */
	readonly extension: string;
	/**
	 * Output file type
	 */
	readonly outputFileType: OutputFileType;
	/**
	 * File date/time
	 */
	readonly date: Date;
}
