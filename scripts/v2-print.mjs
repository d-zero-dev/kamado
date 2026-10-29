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
import { format } from 'prettier-v2';

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
 * Whether a serialized page holds code that prettier formats: the content of
 * `<script>` and `<style>`, `style` attributes and event handlers. v2 minified
 * that code right afterwards, and v3 does not format it (RFC §2), so a corpus
 * of the layout alone leaves such pages out: they show prettier's layout of
 * the code, which v2 did not output.
 * @param {string} content - The serialized page
 * @returns {boolean} Whether the page holds code
 * @example
 * hasCode('<script>a</script>'); // true
 * hasCode('<p class="a">b</p>'); // false
 * hasCode('<p>a one=b</p>'); // false: the attribute has to sit in a tag
 */
export function hasCode(content) {
	return /<(?:script|style)\b|<[a-z][^<>]*\s(?:style|on[a-z]+)=/i.test(content);
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
 * What v2 does first to an HTML string: parse and serialize it with linkedom
 * (`domSerialize`). Kept apart from the layout so that a corpus can look at
 * the serialized page (`hasCode`) before prettier formats it.
 * @param {string} html - The markup as authored
 * @returns {Promise<string>} The serialized page
 * @example
 * await v2Serialize('<p>a'); // '<p>a</p>'
 */
export async function v2Serialize(html) {
	return await domSerialize(html, { hook: () => {} });
}

/**
 * Everything v2 does to an HTML string before minifying: parse and serialize
 * with linkedom (`v2Serialize`), add the doctype, format with prettier.
 * @param {string} html - The markup as authored
 * @param {PrintOptions} [options] - Formatting options
 * @returns {Promise<string>} The formatted HTML
 */
export async function v2Layout(html, options = {}) {
	return await prettierHtml(addDoctype(await v2Serialize(html)), options);
}
