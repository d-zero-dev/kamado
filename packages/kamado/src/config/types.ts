import type { Compiler } from '../compiler/index.js';
import type { ExtensionOutputTypeMap } from '../files/types.js';

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
	 * Mapping of extensions to output file types
	 */
	readonly extensions: ExtensionOutputTypeMap;
	/**
	 * Compiler configuration
	 */
	readonly compilers: {
		/**
		 * Page compiler
		 */
		readonly page?: Compiler;
		/**
		 * Style compiler
		 */
		readonly style?: Compiler;
		/**
		 * Script compiler
		 */
		readonly script?: Compiler;
	};
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
 * Type for user-configurable settings
 * Partial version of Config
 */
export type UserConfig = Partial<
	Omit<Config, 'pkg' | 'dir' | 'devServer' | 'extensions'> & {
		readonly dir: Partial<DirectoryConfig>;
		readonly devServer: Partial<DevServerConfig>;
		readonly extensions: Partial<ExtensionOutputTypeMap>;
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
