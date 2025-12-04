export interface ExtensionOutputTypeMap {
	readonly html: OutputFileType;
	readonly pug: OutputFileType;
	readonly css: OutputFileType;
	readonly scss: OutputFileType;
	readonly sass: OutputFileType;
	readonly js: OutputFileType;
	readonly mjs: OutputFileType;
	readonly cjs: OutputFileType;
	readonly jsx: OutputFileType;
	readonly ts: OutputFileType;
	readonly tsx: OutputFileType;
}

export type Extension = keyof ExtensionOutputTypeMap;

export type OutputFileType = 'page' | 'style' | 'script' | '#error' | '#ignore';

export interface FileObject {
	readonly inputPath: string;
	get(): Promise<FileContent>;
}

export interface FileContent {
	readonly metaData: MetaData;
	readonly content: string;
	readonly raw: string | ArrayBuffer;
}

export interface MetaData {
	readonly [key: string]: unknown;
}

export interface CompilableFile extends FileObject {
	readonly outputPath: string;
	readonly fileSlug: string;
	readonly filePathStem: string;
	readonly url: string;
	readonly extension: string;
	readonly outputFileType: OutputFileType;
	readonly date: Date;
}
