/**
 * File path information for output
 */
export interface OutputPathInfo {
	/**
	 * Output file path (absolute path)
	 */
	readonly outputPath: string;
	/**
	 * File name without extension
	 */
	readonly name: string;
	/**
	 * File extension (lowercase, includes dot)
	 */
	readonly extension: string;
	/**
	 * Relative directory from input directory
	 */
	readonly relDir: string;
	/**
	 * Root relative path without extension
	 */
	readonly rootRelPath: string;
	/**
	 * Root relative path with output extension
	 */
	readonly rootRelPathWithExt: string;
}

/**
 * Path information from splitPath
 */
export interface SplitPathInfo {
	/**
	 * Relative path from current working directory to base directory
	 */
	readonly fromCwd: string;
	/**
	 * Relative path from base directory to file directory
	 */
	readonly fromBase: string;
	/**
	 * File name without extension
	 */
	readonly name: string;
	/**
	 * File extension (includes dot)
	 */
	readonly ext: `.${string}`;
}
