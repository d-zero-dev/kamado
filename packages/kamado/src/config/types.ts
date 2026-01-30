import type { CustomCompilerWithMetadata } from '../compiler/index.js';
import type { CompilableFile } from '../files/types.js';

/**
 * Application configuration
 */
export interface Config {
	/**
	 * Package information
	 */
	readonly pkg: PackageJson;
	/**
	 * Directory configuration
	 */
	readonly dir: DirectoryConfig;
	/**
	 * Development server configuration
	 */
	readonly devServer: DevServerConfig;
	/**
	 * Function to filter or transform the page list
	 * @param pageAssetFiles - Page asset files
	 * @param config - Configuration object
	 * @returns Filtered or transformed page list with optional title
	 */
	readonly pageList?: (
		pageAssetFiles: readonly CompilableFile[],
		config: Config,
	) =>
		| (CompilableFile & { title?: string })[]
		| Promise<(CompilableFile & { title?: string })[]>;
	/**
	 * Compiler configuration (array to guarantee processing order)
	 */
	readonly compilers: readonly CustomCompilerWithMetadata[];
	/**
	 * Hook function called before build
	 * @param config - Configuration object
	 */
	readonly onBeforeBuild?: (config: Config) => Promise<void> | void;
	/**
	 * Hook function called after build
	 * @param config - Configuration object
	 */
	readonly onAfterBuild?: (config: Config) => Promise<void> | void;
}

/**
 * Execution context
 * Config + execution mode information
 * Created by CLI commands (build/serve)
 */
export interface Context extends Config {
	/**
	 * Execution mode (set by CLI)
	 * Users cannot configure this - it's automatically set by the command
	 */
	readonly mode: 'serve' | 'build';
}

/**
 * Type for user-configurable settings
 * Partial version of Config
 */
export type UserConfig = Partial<
	Omit<Config, 'pkg' | 'dir' | 'devServer'> & {
		readonly dir: Partial<DirectoryConfig>;
		readonly devServer: Partial<DevServerConfig>;
		readonly compilers?: readonly CustomCompilerWithMetadata[];
	}
>;

/**
 * Directory configuration
 */
export interface DirectoryConfig {
	/**
	 * Project root directory
	 */
	readonly root: string;
	/**
	 * Input files directory
	 */
	readonly input: string;
	/**
	 * Output files directory
	 */
	readonly output: string;
}

/**
 * Response transform context
 * Provides information about the current request and response
 */
export interface TransformContext {
	/**
	 * Request path (relative to output directory)
	 */
	readonly path: string;
	/**
	 * Original input file path (if available from compiler)
	 */
	readonly inputPath?: string;
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * Whether running in development server mode
	 */
	readonly isServe: boolean;
	/**
	 * Execution context (config + mode)
	 */
	readonly context: Context;
}

/**
 * Response transformation function
 * Allows modifying response content in development server
 */
export interface ResponseTransform {
	/**
	 * Transform name (for debugging and error messages)
	 */
	readonly name?: string;
	/**
	 * Filter conditions to determine when to apply this transform
	 */
	readonly filter?: {
		/**
		 * Include paths (glob pattern)
		 * @example '**\/*.html'
		 */
		readonly include?: string | readonly string[];
		/**
		 * Exclude paths (glob pattern)
		 * @example '**\/_*.html'
		 */
		readonly exclude?: string | readonly string[];
	};
	/**
	 * Transform function to modify response content
	 * @param content - Response content (string or ArrayBuffer).
	 *                  Static files (non-compiled) are typically ArrayBuffer.
	 *                  Use TextDecoder to decode ArrayBuffer for text processing:
	 *                  ```
	 *                  if (typeof content !== 'string') {
	 *                    const decoder = new TextDecoder('utf-8');
	 *                    content = decoder.decode(content);
	 *                  }
	 *                  ```
	 * @param context - Transform context with request/response information
	 * @returns Transformed content (can be async)
	 */
	readonly transform: (
		content: string | ArrayBuffer,
		context: TransformContext,
	) => Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

/**
 * Development server configuration
 */
export interface DevServerConfig {
	/**
	 * Server port number
	 */
	readonly port: number;
	/**
	 * Server hostname
	 */
	readonly host: string;
	/**
	 * Whether to automatically open browser on startup
	 */
	readonly open: boolean;
	/**
	 * Path to start the server
	 */
	readonly startPath?: string;
	/**
	 * Response transformation functions (dev server only)
	 * Applied in array order to all responses matching the filter.
	 * Static files (non-compiled) are passed as ArrayBuffer - use TextDecoder to decode.
	 * @example
	 * ```typescript
	 * transforms: [
	 *   {
	 *     name: 'inject-script',
	 *     filter: { include: '**\/*.html', contentType: 'text/html' },
	 *     transform: (content) => {
	 *       if (typeof content !== 'string') {
	 *         const decoder = new TextDecoder('utf-8');
	 *         content = decoder.decode(content);
	 *       }
	 *       return content.replace('</body>', '<script>...</script></body>');
	 *     }
	 *   }
	 * ]
	 * ```
	 */
	readonly transforms?: readonly ResponseTransform[];
}

/**
 * Type for package.json
 */
export interface PackageJson {
	/**
	 * Package name
	 */
	readonly name?: string;
	/**
	 * Package version
	 */
	readonly version?: string;
	/**
	 * Production environment configuration
	 */
	readonly production?: {
		/**
		 * Hostname
		 */
		readonly host?: string;
		/**
		 * Base URL
		 */
		readonly baseURL?: string;
		/**
		 * Site name
		 */
		readonly siteName?: string;
		/**
		 * Site name (English)
		 */
		readonly siteNameEn?: string;
	};
}
