import { createHash } from 'node:crypto';

/**
 * Hashes content with SHA-256.
 * @param content - Content to hash
 * @returns Hex-encoded digest
 */
export function hashContent(content: string | Uint8Array): string {
	return createHash('sha256').update(content).digest('hex');
}

/**
 * Serializes a value deterministically for cache digests:
 * object keys are sorted, functions and undefined values are omitted
 * (function behavior cannot be observed from here — compilers must include
 * anything behavior-relevant in their digest explicitly), and circular
 * references collapse to a marker instead of throwing.
 * @param value - Value to serialize
 * @returns Deterministic string representation
 */
export function stableSerialize(value?: unknown): string {
	return serialize(value, new WeakSet());
}

/**
 * Computes a digest of a value via {@link stableSerialize}.
 * Intended for compiler `cacheDigest` implementations that need to capture
 * context-level inputs (options, global data) for incremental builds.
 * @param value - Value to digest
 * @returns Hex-encoded digest
 */
export function createCacheDigest(value: unknown): string {
	return hashContent(stableSerialize(value));
}

/**
 * Recursive serializer behind {@link stableSerialize}.
 * @param value
 * @param seen
 */
function serialize(value: unknown, seen: WeakSet<object>): string {
	if (value === null) {
		return 'null';
	}
	switch (typeof value) {
		case 'string':
		case 'number':
		case 'boolean': {
			return JSON.stringify(value);
		}
		case 'bigint': {
			return `"${value}n"`;
		}
		case 'undefined':
		case 'function':
		case 'symbol': {
			// Only reachable as an array element or the root value — object
			// properties with these values are skipped by the object branch
			return 'null';
		}
	}
	const object = value as object;
	if (seen.has(object)) {
		return '"[circular]"';
	}
	seen.add(object);
	try {
		if (object instanceof Date) {
			return JSON.stringify(object.toISOString());
		}
		if (Array.isArray(object)) {
			return '[' + object.map((item) => serialize(item, seen)).join(',') + ']';
		}
		const record = object as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(record).toSorted()) {
			const item = record[key];
			if (item === undefined || typeof item === 'function' || typeof item === 'symbol') {
				continue;
			}
			parts.push(`${JSON.stringify(key)}:${serialize(item, seen)}`);
		}
		return '{' + parts.join(',') + '}';
	} finally {
		seen.delete(object);
	}
}
