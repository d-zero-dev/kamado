import type { DomElement } from 'kamado/utils/dom';

import fs from 'node:fs/promises';
import path from 'node:path';

import { Cache } from '@d-zero/shared/cache';
import { imageSize } from 'image-size';
import { trackDependency } from 'kamado/files';

/**
 * Options for automatic image size addition
 */
export interface ImageSizesOptions {
	/**
	 * Root directory for image files
	 */
	readonly rootDir?: string;
	/**
	 * Selector for target image elements (only applies to <img>; <picture> > <source>
	 * is always processed so picture-driven sources stay sized regardless of selector).
	 */
	readonly selector?: string;
	/**
	 * List of image extensions to target
	 * @default ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg']
	 */
	readonly ext?: readonly string[];
}

type ImageSize = {
	readonly width: number;
	readonly height: number;
};

/**
 * Asynchronously retrieves the dimensions of an image file.
 * @param filePath - The path to the image file to measure
 * @returns A Promise that resolves to an ImageSize object containing the dimensions of the image
 * @throws {Error} Will throw an error if the file cannot be read or if the image format is not supported
 */
async function sizeOf(filePath: string): Promise<ImageSize> {
	const buffer = await fs.readFile(filePath);
	const res = imageSize(buffer);
	return res;
}

/**
 * Automatically adds width/height attributes to image elements
 * @param elements - Array of elements to process
 * @param options - Optional options (rootDir, selector, ext)
 */
export async function imageSizes(
	elements: readonly DomElement[],
	options?: ImageSizesOptions,
) {
	const {
		rootDir,
		selector,
		// https://github.com/image-size/image-size?tab=readme-ov-file#supported-formats
		ext = ['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg'],
	} = options ?? {};
	const cache = new Cache<ImageSize>('@d-zero/builder/image-sizes');

	// linkedom's querySelectorAll returns a real Array, so flatMap flattens
	// it directly without an intermediate spread copy. The lib.dom-shaped
	// NodeListOf<Element> declared by TS doesn't satisfy DomElement[]
	// structurally, so cast through unknown.
	const images = elements.flatMap(
		(el) =>
			el.querySelectorAll('img, picture > source') as unknown as readonly DomElement[],
	);

	for (const img of images) {
		// selector is documented as targeting <img>; <source> elements never match
		// an img-shaped selector, so skip the filter for them to keep the picture
		// fallback wired up regardless of selector.
		if (selector && img.matches('img') && !img.matches(selector)) {
			continue;
		}

		const src = img.getAttribute('src');

		// Strip query string and hash before extension/protocol checks so that
		// a cache-busted src like "hero.png?v=abc" still resolves.
		const srcPath = src?.split('?')[0]?.split('#')[0] ?? '';

		if (
			!src ||
			src.startsWith('data:') ||
			src.startsWith('http://') ||
			src.startsWith('https://') ||
			src.startsWith('//') ||
			!ext.some((e) => srcPath.endsWith(`.${e}`))
		) {
			continue;
		}

		const filePath = path.join(rootDir ?? '', ...srcPath.split('/'));
		// The emitted width/height depend on this image file's bytes, but it is
		// read here outside kamado's file APIs — report it so incremental builds
		// invalidate the page when the image is replaced (tracked even when the
		// file is currently missing, so adding it later also invalidates)
		trackDependency(filePath);
		const stats = await fs.stat(filePath).catch(() => null);

		if (!stats) {
			continue;
		}

		const size = stats.size;

		const cacheKey = `${src}:${size}`;

		const cached = await cache.load(cacheKey);

		if (cached) {
			// Update the DOM
			img.setAttribute('width', `${cached.width}`);
			img.setAttribute('height', `${cached.height}`);
			continue;
		}

		const imageSize = await sizeOf(filePath);

		if (!imageSize || !(imageSize.width && imageSize.height)) {
			continue;
		}

		img.setAttribute('width', `${imageSize.width}`);
		img.setAttribute('height', `${imageSize.height}`);

		await cache.store(cacheKey, imageSize);
	}
}
