/**
 * What v2 does to a page's HTML after it has been serialized: prettier, then
 * html-minifier-terser (the order `createDefaultPageTransforms` runs them in),
 * with the options v2 passes. Used to produce the expected output that the
 * Rust printer (`kd_html::print`) is compared with.
 *
 * `prettierOnly` stops after prettier, to check the layout before the
 * minifier's attribute rewrites are added on top.
 */
import { minify } from 'html-minifier-terser';
import { domSerialize } from 'kamado-v2/utils/dom';
import { format } from 'prettier';

/**
 * html-minifier-terser as v2 calls it, without the code minifiers (those are
 * compared on their own).
 * @param {string} content - The prettier output
 * @returns {Promise<string>} The minified HTML
 */
export async function v2Minify(content) {
	return await minify(content, {
		collapseWhitespace: false,
		collapseBooleanAttributes: true,
		removeComments: false,
		removeRedundantAttributes: true,
		removeScriptTypeAttributes: true,
		removeStyleLinkTypeAttributes: true,
		useShortDoctype: false,
		minifyCSS: false,
		minifyJS: false,
	});
}

/**
 * @typedef {object} PrintOptions
 * @property {number} [printWidth] - Defaults to 100000 (v2's default)
 * @property {number} [tabWidth] - Defaults to 2
 * @property {boolean} [useTabs] - Defaults to false
 * @property {boolean} [bracketSameLine] - Defaults to false
 * @property {boolean} [singleAttributePerLine] - Defaults to false
 */

/**
 * Formats `html` with prettier as v2 called it.
 * @param {string} html - The serialized page
 * @param {PrintOptions} [options] - Formatting options
 * @returns {Promise<string>} The formatted HTML
 */
export async function prettierHtml(html, options = {}) {
	return await format(html, {
		parser: 'html',
		printWidth: 100_000,
		tabWidth: 2,
		useTabs: false,
		...options,
	});
}

/**
 * v2's `doctype` transform: a document that starts with `<html` and has no
 * doctype gets `<!DOCTYPE html>` and a line break in front.
 * @param {string} content - The serialized page
 * @returns {string} The content, with a doctype when it needed one
 */
export function addDoctype(content) {
	const trimmed = content.trim();
	if (/^<html(?:\s|>)/i.test(trimmed) && !/^<!doctype html/i.test(trimmed)) {
		return `<!DOCTYPE html>\n${content}`;
	}
	return content;
}

/**
 * Everything v2 does to an HTML string before minifying: parse and serialize
 * with linkedom (`domSerialize`), add the doctype, format with prettier.
 * @param {string} html - The markup as authored
 * @param {PrintOptions} [options] - Formatting options
 * @returns {Promise<string>} The formatted HTML
 */
export async function v2Layout(html, options = {}) {
	const serialized = await domSerialize(html, { hook: () => {} });
	return await prettierHtml(addDoctype(serialized), options);
}
