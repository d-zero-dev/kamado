import type { Compiler } from '../compiler/index.js';
import type { ExtensionOutputTypeMap } from '../files/types.js';

export interface Config {
	readonly pkg: PackageJson;
	readonly dir: DirectoryConfig;
	readonly devServer: DevServerConfig;
	readonly extensions: ExtensionOutputTypeMap;
	readonly compilers: {
		readonly page?: Compiler;
		readonly style?: Compiler;
		readonly script?: Compiler;
	};
	readonly onBeforeBuild?: (config: Config) => Promise<void> | void;
	readonly onAfterBuild?: (config: Config) => Promise<void> | void;
}

export type UserConfig = Partial<
	Omit<Config, 'pkg' | 'dir' | 'devServer' | 'extensions'> & {
		readonly dir: Partial<DirectoryConfig>;
		readonly devServer: Partial<DevServerConfig>;
		readonly extensions: Partial<ExtensionOutputTypeMap>;
	}
>;

export interface DirectoryConfig {
	readonly root: string;
	readonly input: string;
	readonly output: string;
}

export interface DevServerConfig {
	readonly port: number;
	readonly host: string;
	readonly open: boolean;
}

export interface PackageJson {
	readonly name?: string;
	readonly version?: string;
	readonly production?: {
		readonly host?: string;
		readonly baseURL?: string;
		readonly siteName?: string;
		readonly siteNameEn?: string;
	};
}
