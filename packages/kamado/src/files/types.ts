/**
 * Options for getting a file
 */
export interface GetFileOptions {
	readonly inputDir: string;
	readonly outputDir: string;
	readonly outputExtension: string;
}

/**
 * File object interface
 */
export interface FileObject {
	/**
	 * Input file path
	 */
	readonly inputPath: string;
}

/**
 * File content
 */
export interface FileContent {
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
	 * File date/time
	 */
	readonly date: Date;
}

/**
 * Page data with optional metadata
 */
export interface PageData<M extends MetaData = MetaData> extends CompilableFile {
	/**
	 * Metadata (front matter, etc.)
	 */
	metaData?: M;
}
