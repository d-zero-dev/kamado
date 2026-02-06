import type {
	CustomCompilerFactoryResult,
	CustomCompilerMetadataOptions,
	CustomCompilerWithMetadata,
} from './types.js';
import type { MetaData } from '../files/types.js';

/**
 * Creates a compiler with metadata
 * @param factory - Factory function that returns compiler factory result
 * @returns Function that takes options and returns CompilerWithMetadata
 */
export function createCustomCompiler<CustomCompileOptions, M extends MetaData>(
	factory: () => CustomCompilerFactoryResult<M, CustomCompileOptions>,
): (
	options?: CustomCompileOptions & CustomCompilerMetadataOptions,
) => CustomCompilerWithMetadata<M> {
	return (
		userOptions?: CustomCompileOptions & CustomCompilerMetadataOptions,
	): CustomCompilerWithMetadata<M> => {
		const result = factory();
		const files = userOptions?.files ?? result.defaultFiles;
		const outputExtension = userOptions?.outputExtension ?? result.defaultOutputExtension;
		const ignore = userOptions?.ignore;

		return {
			files,
			ignore,
			outputExtension,
			compiler: result.compile(userOptions),
		};
	};
}
