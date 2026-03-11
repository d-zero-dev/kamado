import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { characterEntities as characterEntitiesMap } from 'character-entities';

/**
 * Options for characterEntities
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CharacterEntitiesOptions {}

// Pre-compute the character-to-entity reverse map once at module load time
// instead of iterating all 2000+ entries on every transform call
const charToEntityMap = new Map<string, string>();
for (const [entity, char] of Object.entries(characterEntitiesMap)) {
	const codePoint = char.codePointAt(0);

	// Skip characters with code points < 127 (ASCII)
	if (codePoint == null || codePoint < 127) {
		continue;
	}

	// Prefer lowercase entity name if both exist
	const preferredEntity =
		/^[A-Z]+$/i.test(entity) && characterEntitiesMap[entity.toLowerCase()] === char
			? entity.toLowerCase()
			: entity;

	// Only set if not already mapped (first match wins, preserving original precedence)
	if (!charToEntityMap.has(char)) {
		charToEntityMap.set(char, preferredEntity);
	}
}

// Pre-compile a single regex that matches all target characters
const charPattern = new RegExp(
	[...charToEntityMap.keys()]
		.map((c) => c.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&'))
		.join('|'),
	'g',
);

/**
 * Creates a transform for character entities conversion
 * @returns Transform object
 */
export function characterEntities<M extends MetaData>(): Transform<M> {
	return {
		name: 'characterEntities',
		transform: (content) => {
			if (typeof content !== 'string') {
				const decoder = new TextDecoder('utf-8');
				content = decoder.decode(content);
			}

			return content.replace(charPattern, (char) => {
				const entity = charToEntityMap.get(char);
				return entity ? `&${entity};` : char;
			});
		},
	};
}
