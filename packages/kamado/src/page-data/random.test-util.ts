/**
 * Deterministic random generators shared by the differential specs.
 * Not part of the build (`tsconfig.build.json` excludes `*.test-util.ts`).
 */
import type { PageInfo } from './nav.js';

/** A seeded random source. */
export interface Rng {
	/** Float in [0, 1). */
	next(): number;
	/** Integer in [min, max]. */
	int(min: number, max: number): number;
	/** True with the given probability. */
	chance(probability: number): boolean;
	/** One element of a non-empty list. */
	pick<T>(list: readonly T[]): T;
}

/**
 * Creates a mulberry32 generator.
 * @param seed - Integer seed.
 * @returns The generator.
 */
export function createRng(seed: number): Rng {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 1_831_565_813) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
	return {
		next,
		int: (min, max) => min + Math.floor(next() * (max - min + 1)),
		chance: (probability) => next() < probability,
		pick: (list) => list[Math.floor(next() * list.length)]!,
	};
}

const SEGMENTS = [
	'a',
	'b',
	'c',
	'about',
	'news',
	'Blog',
	'2024',
	'10',
	'9',
	'item-2',
	'item-10',
	'index-old',
	'a%20b',
	'caf%C3%A9',
	'x y',
];
const FILES = ['page', 'b', 'c', 'Page', '10', '9', 'about', 'index', 'INDEX', 'z'];
const EXTENSIONS = ['.html', '.html', '.html', '.htm', '.HTML', '.pdf', '.php'];
const TITLES = [
	undefined,
	undefined,
	'',
	'   ',
	'Title',
	'  Padded title  ',
	'Another',
	'Z last',
	'a first',
];

/**
 * Generates one random page URL.
 * @param rng - Random source.
 * @returns A URL such as `/`, `/a/b/`, `/a/index.html` or `/a/b/page.html`.
 */
export function randomUrl(rng: Rng): string {
	const depth = rng.int(0, 4);
	let url = '/';
	for (let i = 0; i < depth; i++) {
		url += rng.pick(SEGMENTS) + '/';
	}
	const kind = rng.int(0, 9);
	if (kind < 4) {
		return url;
	}
	if (kind < 6) {
		return url + 'index' + rng.pick(['.html', '.htm', '.html']);
	}
	return url + rng.pick(FILES) + rng.pick(EXTENSIONS);
}

/**
 * Derives the `filePathStem` of a URL the way the page list does: the URL without
 * its extension, with `index` appended to directory URLs.
 * @param url - Page URL.
 * @returns The stem.
 */
export function stemOf(url: string): string {
	if (url.endsWith('/')) {
		return url + 'index';
	}
	return url.replace(/\.[^./]+$/, '');
}

/**
 * Generates a random page.
 * @param rng - Random source.
 * @param url - Page URL (random when omitted).
 * @returns The page.
 */
export function randomPage(rng: Rng, url = randomUrl(rng)): PageInfo {
	const title = rng.pick(TITLES);
	const meta: Record<string, unknown> = { order: rng.int(0, 5) };
	if (title !== undefined) {
		meta.title = title;
	}
	if (rng.chance(0.2)) {
		meta.draft = true;
	}
	return { url, filePathStem: stemOf(url), meta };
}

/**
 * Generates a random page list, biased towards having a root and parents.
 * @param rng - Random source.
 * @param maxPages - Upper bound of the list length.
 * @returns The pages (may contain duplicates and missing parents).
 */
export function randomPages(rng: Rng, maxPages = 14): PageInfo[] {
	const count = rng.int(0, maxPages);
	const pages: PageInfo[] = [];
	if (count > 0 && rng.chance(0.7)) {
		pages.push(randomPage(rng, rng.pick(['/', '/index.html'])));
	}
	while (pages.length < count) {
		if (pages.length > 0 && rng.chance(0.08)) {
			pages.push(randomPage(rng, rng.pick(pages).url));
		} else if (pages.length > 0 && rng.chance(0.25)) {
			// A page next to or below an existing one, so ancestors often exist.
			const base = rng.pick(pages).url;
			const dir = base.endsWith('/') ? base : base.slice(0, base.lastIndexOf('/') + 1);
			pages.push(
				randomPage(
					rng,
					rng.chance(0.5)
						? dir + rng.pick(FILES) + '.html'
						: dir + rng.pick(SEGMENTS) + '/',
				),
			);
		} else {
			pages.push(randomPage(rng));
		}
	}
	return pages;
}

/**
 * Runs a function and captures either its value or the error it throws.
 * @param fn - Function to run.
 * @returns A comparable outcome.
 */
export function outcome<T>(
	fn: () => T,
): { value: T } | { error: { name: string; message: string } } {
	try {
		return { value: fn() };
	} catch (error) {
		const e = error as Error;
		return { error: { name: e.name, message: e.message } };
	}
}
