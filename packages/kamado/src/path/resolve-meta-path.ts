import path from 'node:path';

/**
 * Required context for resolving a frontmatter `path` override
 */
export interface ResolveMetaPathContext {
	/**
	 * The `path` value declared in the frontmatter or JSON sidecar.
	 * Must start with a leading slash. Three forms are accepted:
	 * - `/foo/bar.html` — used as-is
	 * - `/foo/bar`      — `outputExtension` is appended
	 * - `/foo/bar/`     — treated as a directory, `index<outputExtension>` is appended
	 */
	readonly metaPath: string;
	/**
	 * Output directory (resolved to an absolute path internally).
	 */
	readonly outputDir: string;
	/**
	 * Output extension to append when `metaPath` has no extension or ends with `/`.
	 */
	readonly outputExtension: string;
}

/**
 * Resolved frontmatter path
 */
export interface ResolvedMetaPath {
	/**
	 * Absolute path on disk where the file should be written / served from.
	 */
	readonly outputPath: string;
	/**
	 * POSIX-style path relative to the output directory, with extension.
	 * Used to derive `url` / `filePathStem` for the resulting `CompilableFile`.
	 */
	readonly rootRelPathWithExt: string;
}

/**
 * Resolves a frontmatter override path string to a concrete output location.
 *
 * Three forms of `metaPath` are accepted:
 * - With explicit extension (e.g. `/foo/bar.html`) — used as-is.
 * - Without extension (e.g. `/foo/bar`) — `outputExtension` is appended.
 * - With a trailing slash (e.g. `/foo/bar/`) — treated as a directory and
 *   `index<outputExtension>` is appended.
 * @param context - Required context (the override string and the compiler's
 *   output directory and extension).
 * @returns The absolute `outputPath` and the POSIX-style relative path with
 *   extension, suitable for deriving `url` and `filePathStem`.
 * @throws {Error} if `metaPath` does not start with `/`, contains `.` or `..`
 *   segments, or resolves outside `outputDir`.
 */
export function resolveMetaPath(context: ResolveMetaPathContext): ResolvedMetaPath {
	const { metaPath, outputDir, outputExtension } = context;

	if (!metaPath.startsWith('/')) {
		throw new Error(`'path' must start with '/': ${JSON.stringify(metaPath)}`);
	}

	const stripped = metaPath.slice(1);
	const endsWithSlash = stripped.endsWith('/') || stripped === '';

	const segments = stripped.split('/').filter((segment) => segment !== '');
	for (const segment of segments) {
		if (segment === '..' || segment === '.') {
			throw new Error(
				`'path' must not contain '.' or '..' segments: ${JSON.stringify(metaPath)}`,
			);
		}
	}

	let rootRelPathWithExt: string;
	if (endsWithSlash) {
		rootRelPathWithExt = [...segments, `index${outputExtension}`].join('/');
	} else {
		const lastSegment = segments.at(-1) ?? '';
		const hasExtension = path.posix.extname(lastSegment) !== '';
		rootRelPathWithExt = hasExtension
			? segments.join('/')
			: `${segments.join('/')}${outputExtension}`;
	}

	const resolvedOutputDir = path.resolve(outputDir);
	const outputPath = path.resolve(resolvedOutputDir, rootRelPathWithExt);

	// Defense-in-depth: even if a future change loosens segment validation
	// or the OS resolves the path differently, reject anything that escapes
	// the output directory.
	if (
		outputPath !== resolvedOutputDir &&
		!outputPath.startsWith(resolvedOutputDir + path.sep)
	) {
		throw new Error(
			`'path' resolves outside of the output directory: ${JSON.stringify(metaPath)}`,
		);
	}

	return {
		outputPath,
		rootRelPathWithExt,
	};
}
