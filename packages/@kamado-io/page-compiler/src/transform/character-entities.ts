import type { Transform } from 'kamado/config';
import type { MetaData } from 'kamado/files';

import { characterEntities as characterEntitiesMap } from 'character-entities';

/**
 * Options for characterEntities
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface CharacterEntitiesOptions {}

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
		},
	};
}
