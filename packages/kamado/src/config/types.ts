import type { CompileFunction, CustomCompilerWithMetadata } from '../compiler/types.js';
import type { CompilableFile, PageData } from '../files/types.js';

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
	 * @returns Filtered or transformed page list with optional metadata
	 */
	readonly pageList?: (
		pageAssetFiles: readonly CompilableFile[],
		config: Config,
	) => PageData[] | Promise<PageData[]>;
	/**
	 * Compiler configuration (array to guarantee processing order)
	 */
	readonly compilers: readonly CustomCompilerWithMetadata[];
	/**
	 * Hook function called before build
	 * @param context - Execution context (Config + mode)
	 */
	readonly onBeforeBuild?: (context: Context) => Promise<void> | void;
	/**
	 * Hook function called after build
	 * @param context - Execution context (Config + mode)
	 */
	readonly onAfterBuild?: (context: Context) => Promise<void> | void;
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
	 * File path (alias for path, for clarity)
	 */
	readonly filePath: string;
	/**
	 * Original input file path (if available from compiler)
	 */
	readonly inputPath?: string;
	/**
	 * Output file path
	 */
	readonly outputPath: string;
	/**
	 * Output directory path
	 */
	readonly outputDir: string;
	/**
	 * Whether running in development server mode
	 */
	readonly isServe: boolean;
	/**
	 * Execution context (config + mode)
	 */
	readonly context: Context;
	/**
	 * Compile function for compiling other files during transformation
	 */
	readonly compile: CompileFunction;
}

/**
 * Transform object that processes content
 * Used by both page-compiler transforms and devServer.transforms
 */
export interface Transform {
	/**
	 * Transform name (used for find/filter/map customization)
	 */
	readonly name: string;
	/**
	 * Optional filter configuration (only used in devServer.transforms)
	 */
	readonly filter?: {
		readonly include?: string | readonly string[];
		readonly exclude?: string | readonly string[];
	};
	/**
	 * Transform function
	 * @param content - Content to transform
	 * @param ctx - Transform context (includes Kamado context, paths, compile function, etc.)
	 * @returns Transformed content
	 */
	readonly transform: (
		content: string | ArrayBuffer,
		ctx: TransformContext,
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
	 *     filter: { include: '**\/*.html' },
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
	readonly transforms?: readonly Transform[];
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
