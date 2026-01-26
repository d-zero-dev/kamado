import type { CompilerWithMetadata } from '../compiler/index.js';
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
	readonly compilers: readonly CompilerWithMetadata[];
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
		readonly compilers?: readonly CompilerWithMetadata[];
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
