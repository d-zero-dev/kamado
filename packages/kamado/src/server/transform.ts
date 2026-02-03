import type { Transform, TransformContext } from '../config/types.js';

import c from 'ansi-colors';
import picomatch from 'picomatch';

/**
 * Required context for applying transforms
 */
export interface ApplyTransformsContext {
	readonly content: string | ArrayBuffer;
	readonly transformContext: TransformContext;
}

/**
 * Optional options for applying transforms
 */
export interface ApplyTransformsOptions {
	readonly transforms?: readonly Transform[];
}

/**
 * Apply response transforms
 * Executes transform functions in array order on the response content.
 * Only applies in serve mode.
 * @param context - Required context (content, transformContext)
 * @param options - Optional options (transforms)
 * @returns Transformed content
 */
export async function applyTransforms(
	context: ApplyTransformsContext,
	options?: ApplyTransformsOptions,
): Promise<string | ArrayBuffer> {
	const { content, transformContext } = context;
	const { transforms } = options ?? {};
	if (!transforms || transforms.length === 0) {
		return content;
	}

	// Guard: Only apply in serve mode
	if (transformContext.context.mode !== 'serve') {
		return content;
	}

	let result = content;

	for (const transform of transforms) {
		// Check if transform should be applied based on filters
		if (!shouldApplyTransform(transform, transformContext)) {
			continue;
		}

		try {
			result = await Promise.resolve(transform.transform(result, transformContext));
		} catch (error) {
			const name = transform.name || 'anonymous';
			// eslint-disable-next-line no-console
			console.error(
				c.red(`Transform error [${name}] at ${transformContext.path}:`),
				error,
			);
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
function shouldApplyTransform(transform: Transform, context: TransformContext): boolean {
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
