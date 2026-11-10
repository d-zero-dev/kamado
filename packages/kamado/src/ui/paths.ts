/**
 * What the screen is told of the paths of the machine: none. The core answers with absolute
 * paths (the files it reads and writes), and the browser would hold the home directory of the
 * user, the name of the project's folder and what else is on the way to it, for nothing: a
 * page's source file is told from the input directory (`about/index.html`), where it would be
 * written from the output directory.
 */
import path from 'node:path';

/** The directories the paths are told from. All absolute. */
export interface Roots {
	/** The directory of the config file. */
	readonly rootDir: string;
	/** `dir.input` */
	readonly inputDir: string;
	/** `dir.output` */
	readonly outputDir: string;
}

/**
 * A path as it is told from a directory: relative, with `/`.
 * @param file - An absolute path
 * @param from - The directory
 * @example
 * ```ts
 * relativeTo('/site/src/about/index.html', '/site/src'); // 'about/index.html'
 * ```
 */
export function relativeTo(file: string, from: string): string {
	const relative = path.relative(from, file).split(path.sep).join('/');
	// A file outside the directory would be told as `../../x`, a part of the layout of the
	// machine; the name of the file is what is left of it. It does not happen to a page of
	// the plan (its source is in `dir.input`), but this is the one place that decides.
	return relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)
		? path.basename(file)
		: relative;
}

/**
 * Takes the absolute paths out of one row of the list: the source file from the input
 * directory, the output file from the output directory.
 * @param page - A row as the core answers it
 * @param roots - The directories
 * @example
 * ```ts
 * showPaths(
 * 	{ url: '/', inputPath: '/s/src/index.html', outputPath: '/s/out/index.html' },
 * 	{ rootDir: '/s', inputDir: '/s/src', outputDir: '/s/out' },
 * );
 * // { url: '/', inputPath: 'index.html', outputPath: 'index.html' }
 * ```
 */
export function showPaths<
	T extends {
		readonly inputPath: string | null;
		readonly outputPath: string;
		readonly meta?: Readonly<Record<string, { readonly reason?: string }>>;
	},
>(page: T, roots: Roots): T {
	const meta =
		page.meta === undefined
			? {}
			: {
					meta: Object.fromEntries(
						Object.entries(page.meta).map(([key, cell]) => [
							key,
							// The reason a value cannot be edited is a sentence of the core.
							cell.reason === undefined
								? cell
								: { ...cell, reason: scrub(cell.reason, roots) },
						]),
					),
				};
	return {
		...page,
		...meta,
		inputPath:
			page.inputPath === null ? null : relativeTo(page.inputPath, roots.inputDir),
		outputPath: relativeTo(page.outputPath, roots.outputDir),
	};
}

/**
 * Takes the directories out of a text (a message of the core, a warning): each is named by
 * what it is (`<input>`, `<output>`, `<root>`), the longest first, so that the input
 * directory inside the root is not told as a part of it.
 * @param text - The text
 * @param roots - The directories
 * @example
 * ```ts
 * scrub('cannot read /s/pages.json', { rootDir: '/s', inputDir: '/s/src', outputDir: '/s/out' });
 * // 'cannot read <root>/pages.json'
 * ```
 */
export function scrub(text: string, roots: Roots): string {
	const names: [string, string][] = [
		[roots.inputDir, '<input>'],
		[roots.outputDir, '<output>'],
		[roots.rootDir, '<root>'],
	];
	names.sort((a, b) => b[0].length - a[0].length);
	let result = text;
	for (const [dir, name] of names) {
		const bare = dir.replace(/\/+$/, '');
		if (bare !== '') {
			// Only where the directory begins and ends as a path does: `/site` is not the start
			// of `/site-old` or `/site.bak` (but is the end of a sentence's `/site.`), and `/work`
			// is not the end of `/home/u/work`, which would leave `/home/u<root>`.
			const escaped = bare.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
			result = result.replaceAll(
				new RegExp(`(?<![\\w.-])${escaped}(?![\\w-]|\\.\\w)`, 'g'),
				name,
			);
		}
	}
	return result;
}
