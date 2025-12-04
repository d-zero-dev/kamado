import type { Dayjs } from 'dayjs';

import dayjs from 'dayjs';

/**
 * Type for banner creation function
 * Takes options and returns a function that takes current time and returns banner text
 */
export type CreateBanner = (options?: BannerOptions) => (now: Dayjs) => string;

/**
 * Options for banner creation
 */
export type BannerOptions = {
	/**
	 * Whether in development mode
	 * If true, displays development warning message
	 */
	readonly devMode?: boolean;
};

const defaultBanner: CreateBanner = (options) => {
	return (now) => {
		if (options?.devMode) {
			return `🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧
🚧                                                                    🚧
🚧                      👷これは開発中のコードです。                       🚧
🚧                                                                    🚧
🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧 🚧

🈲 このファイルを直接編集しないでください。
⚠️ 正式公開の場合は正しい手順でリリースビルドを行なってファイルを最適化してください。`;
		}

		return `rev. ${now.format('YYYY-MM-DD')}
copyright © ${now.year()}`;
	};
};

/**
 * Creates banner text
 * @param create - Banner creation function (uses default banner if omitted)
 * @returns Banner text in CSS comment format
 */
export function createBanner(create?: ReturnType<CreateBanner>) {
	create ??= defaultBanner();
	const banner = create(dayjs());
	return `/*\n${banner}\n*/`;
}
