import { characterEntities as characterEntitiesMap } from 'character-entities';

/**
 * Options for character entity conversion
 */
export interface CharacterEntitiesOptions {
	/**
	 * Whether to enable character entity conversion
	 */
	readonly enabled?: boolean;
}

/**
 * Converts characters to HTML entities.
 *
 * Only converts characters with code points >= 127.
 * Prefers lowercase entity names when both upper and lower case exist.
 * @param options - Configuration options
 * @returns A function that takes content and returns content with character entities applied
 * @internal
 */
export function characterEntities(
	options?: CharacterEntitiesOptions,
): (content: string | ArrayBuffer) => string | ArrayBuffer {
	return (content: string | ArrayBuffer): string | ArrayBuffer => {
		if (typeof content !== 'string') {
			return content;
		}

		const { enabled } = options ?? {};

		if (!enabled) {
			return content;
		}

		let result = content;

		for (const [entity, char] of Object.entries(characterEntitiesMap)) {
			let _entity = entity;
			const codePoint = char.codePointAt(0);

			// Skip characters with code points < 127
			if (codePoint == null || codePoint < 127) {
				continue;
			}

			// Prefer lowercase entity name if both exist
			if (
				/^[A-Z]+$/i.test(entity) &&
				characterEntitiesMap[entity.toLowerCase()] === char
			) {
				_entity = entity.toLowerCase();
			}

			result = result.replaceAll(char, `&${_entity};`);
		}

		return result;
	};
}
