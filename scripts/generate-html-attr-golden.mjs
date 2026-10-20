/**
 * Generates the differential corpus of the attribute and class edits of
 * `kd_html` (`html.rules` and `html.imageSizes`): each case is an input and a
 * list of operations, run in v2's DOM (`domSerialize` with a hook that calls
 * `setAttribute` / `removeAttribute` / `classList`, as the `manipulateDOM`
 * hooks of v2 did) and stored next to the bytes v2 produced. The Rust test
 * `crates/kd_html/tests/attr_golden.rs` runs the same operations through
 * `kd_html::rules` and `kd_html::image_sizes` and requires the same bytes.
 *
 * linkedom is a dev-time input only. Run this when a case is added or
 * `kamado-v2` is upgraded: `node scripts/generate-html-attr-golden.mjs`.
 *
 * Files per case, in `crates/kd_html/tests/attr_golden/`: `<case>.in`,
 * `<case>.ops` (one operation per line, tab-separated) and `<case>.out`.
 * Operations: `setAttr SEL NAME VALUE`, `removeAttr SEL NAME`,
 * `addClass SEL CLASS`, `removeClass SEL CLASS`, `imageSizes WIDTH HEIGHT`.
 * `{{attr:NAME}}` in a `setAttr` value is the element's own attribute (empty
 * when missing).
 *
 * Inputs on which v3 deliberately differs are NOT cases here; they live as
 * unit tests of the modules (`rules.rs`, `selector.rs`, `image_sizes.rs`,
 * `dom.rs` in `crates/kd_html/src`): attribute names written in capitals
 * (`CLASS`, `DATA-X`). linkedom keeps the case an author wrote and matches
 * names exactly, so a selector never sees them and `setAttribute` adds a
 * second attribute beside them; an HTML document matches names without case.
 *
 * What is the oracle: v2's DOM (linkedom and its selector engine) running
 * the operations as v2's hooks wrote them. `imageSizes` is the part v2 kept
 * outside the `kamado` package, so it is reproduced here by the two
 * `setAttribute` calls it made: the golden proves the order of the
 * attributes, not which elements v2 measured. `keepAuthored` is not in v2.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { domSerialize } from 'kamado-v2/utils/dom';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'crates', 'kd_html', 'tests', 'attr_golden');

const IMG = '<img src="/x.svg" alt="x">';

/** @type {Record<string, { input: string, ops: string[][] }>} */
const cases = {
	'image-no-size': { input: IMG, ops: [['imageSizes', '22', '22']] },
	'image-height-only': {
		input: '<img src="/x.svg" height="5" alt="x">',
		ops: [['imageSizes', '22', '22']],
	},
	'image-width-only': {
		input: '<img src="/x.svg" width="5" alt="x">',
		ops: [['imageSizes', '22', '22']],
	},
	'image-both': {
		input: '<img width="1" src="/x.svg" height="2">',
		ops: [['imageSizes', '22', '22']],
	},
	'image-picture-source': {
		input: '<picture><source src="/x.svg"><img src="/x.svg"></picture>',
		ops: [['imageSizes', '3', '2']],
	},
	'set-new': { input: '<a href="x">t</a>', ops: [['setAttr', 'a', 'rel', 'noopener']] },
	'set-existing': {
		input: '<a rel="old" href="x">t</a>',
		ops: [['setAttr', 'a', 'rel', 'noopener']],
	},
	'set-two-new': {
		input: '<p id="a">x</p>',
		ops: [
			['setAttr', 'p', 'data-a', '1'],
			['setAttr', 'p', 'data-b', '2'],
		],
	},
	'set-empty-id': { input: '<p>x</p>', ops: [['setAttr', 'p', 'id', '']] },
	'remove-exact': {
		input: '<p style="a" id=k>x</p>',
		ops: [['removeAttr', 'p', 'style']],
	},
	'add-class-none': { input: '<p>x</p>', ops: [['addClass', 'p', 'k']] },
	'add-class-after-attrs': { input: IMG, ops: [['addClass', 'img', 'k']] },
	'add-class-existing': {
		input: '<p id=i class="a b">x</p>',
		ops: [['addClass', 'p', 'k']],
	},
	'add-class-present': { input: '<p class="a k">x</p>', ops: [['addClass', 'p', 'k']] },
	'add-class-empty-attr': { input: '<p class="">x</p>', ops: [['addClass', 'p', 'k']] },
	'add-class-then-set': {
		input: '<img src="/a.png">',
		ops: [
			['addClass', 'img', 'k'],
			['setAttr', 'img', 'data-x', '1'],
		],
	},
	'add-class-untidy-value': {
		input: '<p>x</p>',
		ops: [
			['setAttr', 'p', 'class', 'a  b a'],
			['addClass', 'p', 'c'],
		],
	},
	'add-class-untidy-space': {
		input: '<p>x</p>',
		ops: [
			['setAttr', 'p', 'class', 'a b　a'],
			['addClass', 'p', 'c'],
		],
	},
	'remove-class-last': {
		input: '<p id=i class="a">x</p>',
		ops: [['removeClass', 'p', 'a']],
	},
	'remove-class-one-of-many': {
		input: '<p class="a b c">x</p>',
		ops: [['removeClass', 'p', 'b']],
	},
	'remove-class-none': { input: '<p>x</p>', ops: [['removeClass', 'p', 'a']] },
	'remove-class-absent-token': {
		input: '<p class=" b  c ">x</p>',
		ops: [['removeClass', 'p', 'a']],
	},
	'remove-class-untidy-value': {
		input: '<p>x</p>',
		ops: [
			['setAttr', 'p', 'class', 'a  b a'],
			['removeClass', 'p', 'b'],
		],
	},
	'image-source-without-src': {
		input: '<picture><source srcset="/a.webp"><img src="/x.svg"></picture>',
		ops: [['imageSizes', '3', '2']],
	},
	'set-template-attr': {
		input: '<a href=x>t</a><a>u</a>',
		ops: [['setAttr', 'a', 'data-h', '{{attr:href}}|{{attr:none}}']],
	},
	'remove-missing-and-several': {
		input: '<p>a</p><p style="s" id=i class=c>b</p>',
		ops: [
			['removeAttr', 'p', 'style'],
			['removeAttr', 'p', 'id'],
			['removeAttr', 'p', 'nope'],
		],
	},
	// Attribute values a selector compares without case (the HTML standard's
	// list, which v2's selector engine follows): `type` yes, `title` no.
	'selector-value-type': {
		input: '<input type=TEXT><input type=text><input type=radio>',
		ops: [['setAttr', '[type=text]', 'm', '1']],
	},
	'selector-value-title': {
		input: '<p title=Hi>x</p><p title=hi>y</p>',
		ops: [['setAttr', '[title=hi]', 'm', '1']],
	},
	'selector-value-prefix': {
		input: '<a rel=NOFOLLOW>x</a><a rel=follow>y</a>',
		ops: [['setAttr', '[rel^=no]', 'm', '1']],
	},
	'selector-value-suffix': {
		input: '<a href="/a.pdf" type=APPLICATION>x</a><a href="/a.html">y</a>',
		ops: [['setAttr', '[href$=".pdf"]', 'm', '1']],
	},
	'selector-value-substring': {
		input: '<a href="/a.pdf" target=_BLANK>x</a><a href="/b.html">y</a>',
		ops: [['setAttr', '[target*=blank]', 'm', '1']],
	},
	'selector-value-includes': {
		input: '<p class="a b">x</p><p class=ab>y</p><p rel="x NoFollow">z</p>',
		ops: [
			['setAttr', '[class~=b]', 'm', '1'],
			['setAttr', '[rel~=nofollow]', 'n', '1'],
		],
	},
	'selector-value-dash': {
		input: '<p lang=EN-us>x</p><p lang=eng>y</p>',
		ops: [['setAttr', '[lang|=en]', 'm', '1']],
	},
};

/**
 * @param {any[]} elements
 * @param {string} selector
 */
function select(elements, selector) {
	const found = [];
	for (const element of elements) {
		if (element.matches(selector)) {
			found.push(element);
		}
		found.push(...element.querySelectorAll(selector));
	}
	return found;
}

/**
 * @param {string[][]} ops
 * @returns {(elements: any[]) => void}
 */
function hookFor(ops) {
	return (elements) => {
		for (const [action, a, b, c] of ops) {
			switch (action) {
				case 'setAttr': {
					for (const element of select(elements, a)) {
						const value = c.replaceAll(
							/\{\{attr:([^}]+)\}\}/g,
							(_, name) => element.getAttribute(name) ?? '',
						);
						element.setAttribute(b, value);
					}
					break;
				}
				case 'removeAttr': {
					for (const element of select(elements, a)) {
						element.removeAttribute(b);
					}
					break;
				}
				case 'addClass': {
					for (const element of select(elements, a)) {
						element.classList.add(b);
					}
					break;
				}
				case 'removeClass': {
					for (const element of select(elements, a)) {
						element.classList.remove(b);
					}
					break;
				}
				case 'imageSizes': {
					for (const element of select(elements, 'img, picture > source')) {
						if (element.hasAttribute('src')) {
							element.setAttribute('width', a);
							element.setAttribute('height', b);
						}
					}
					break;
				}
				default: {
					throw new Error(`unknown operation ${action}`);
				}
			}
		}
	};
}

mkdirSync(outDir, { recursive: true });
// A removed case must not leave its files behind (the Rust test would still
// run them), so the directory is rebuilt from scratch.
for (const file of readdirSync(outDir)) {
	if (/\.(?:in|ops|out)$/.test(file)) {
		rmSync(path.join(outDir, file));
	}
}
let count = 0;
for (const [name, { input, ops }] of Object.entries(cases)) {
	const expected = await domSerialize(input, { hook: hookFor(ops) });
	writeFileSync(path.join(outDir, `${name}.in`), input);
	writeFileSync(
		path.join(outDir, `${name}.ops`),
		ops.map((o) => o.join('\t')).join('\n'),
	);
	writeFileSync(path.join(outDir, `${name}.out`), expected);
	count++;
}
process.stdout.write(`wrote ${count} cases to ${path.relative(root, outDir)}\n`);
