import type { ResponseTransform, TransformContext } from '../config/types.js';

import c from 'ansi-colors';
import picomatch from 'picomatch';

/**
 * Apply response transforms
 * Executes transform functions in array order on the response content.
 * Only applies in serve mode.
 * @param content - Original response content (string or ArrayBuffer).
 *                  Static files are typically ArrayBuffer.
 * @param context - Transform context with request/response information
 * @param transforms - Array of transform functions to apply
 * @returns Transformed content
 */
export async function applyTransforms(
	content: string | ArrayBuffer,
	context: TransformContext,
	transforms: readonly ResponseTransform[] | undefined,
): Promise<string | ArrayBuffer> {
	if (!transforms || transforms.length === 0) {
		return content;
	}

	// Guard: Only apply in serve mode
	if (context.context.mode !== 'serve') {
		return content;
	}

	let result = content;

	for (const transform of transforms) {
		// Check if transform should be applied based on filters
		if (!shouldApplyTransform(transform, context)) {
			continue;
		}

		try {
			result = await Promise.resolve(transform.transform(result, context));
		} catch (error) {
			const name = transform.name || 'anonymous';
			// eslint-disable-next-line no-console
			console.error(c.red(`Transform error [${name}] at ${context.path}:`), error);
			// Continue with current result on error (graceful degradation)
			continue;
		}
	}

	return result;
}

/**
 * Check if transform should be applied based on filters
 * @param transform - Transform configuration with filters
 * @param context - Transform context with request/response information
 * @returns true if transform should be applied
 */
function shouldApplyTransform(
	transform: ResponseTransform,
	context: TransformContext,
): boolean {
	const filter = transform.filter;

	if (!filter) {
		return true;
	}

	// Path filtering (glob pattern matching)
	if (filter.include || filter.exclude) {
		const includes = Array.isArray(filter.include)
			? filter.include
			: filter.include
				? [filter.include]
				: ['**/*'];

		const excludes = Array.isArray(filter.exclude)
			? filter.exclude
			: filter.exclude
				? [filter.exclude]
				: [];

		// Check if path matches any include pattern
		const matchesInclude = includes.some((pattern) => {
			const isMatch = picomatch(pattern);
			return isMatch(context.path);
		});

		// Check if path matches any exclude pattern
		const matchesExclude = excludes.some((pattern) => {
			const isMatch = picomatch(pattern);
			return isMatch(context.path);
		});

		if (!matchesInclude || matchesExclude) {
			return false;
		}
	}

	return true;
}
