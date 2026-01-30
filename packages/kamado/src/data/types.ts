import type { CompilableFile } from '../files/types.js';
import type dayjs from 'dayjs';

/**
 * Global data interface
 * Defines global data available in templates
 */
export interface GlobalData {
	/**
	 * Package information
	 */
	readonly pkg: {
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
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		readonly [key: string]: any;
	};
	/**
	 * List of all page asset files (from local file system)
	 */
	readonly pageAssetFiles: CompilableFile[];
	/**
	 * List of pages with titles (from user-defined page list)
	 */
	readonly pageList: (CompilableFile & { title: string })[];
	/**
	 * Filter functions
	 */
	readonly filters: {
		/**
		 * Function to format dates
		 * @param date - Date
		 * @param format - Format string
		 * @returns Formatted date string
		 */
		readonly date: (date: dayjs.ConfigType, format: string) => string;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	readonly [key: string]: any;
}
