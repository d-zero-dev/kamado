/**
 * Writes a CSS corpus for `kd_css`: `<n>.in` files holding
 * - random but valid style sheets (nested media queries, @font-face,
 *   @keyframes, vendor prefixes, custom properties, calc(), gradients,
 *   shorthands, colours in all notations, urls, attribute selectors, :is /
 *   :not / :where / :has, nesting, @layer, @container, unicode-range,
 *   escapes, `!important` with odd spacing, comments in odd places, @charset,
 *   duplicated and empty rules),
 * - the hand-written cases of `css-golden-cases.mjs`,
 * - the CSS files found in `node_modules`.
 *
 * The oracle outputs come from `generate-css-oracle.mjs`; the checks from
 * `check-css.mjs` and the ignored cargo test
 * `crates/kd_css/tests/differential.rs`:
 *
 * ```sh
 * node scripts/fuzz-css.mjs /tmp/kd-css 600 1
 * node scripts/generate-css-oracle.mjs /tmp/kd-css
 * cargo build --release --offline -p kd_css --example minify
 * KD_CSS_DIR=/tmp/kd-css node scripts/check-css.mjs
 * KD_CSS_DIR=/tmp/kd-css cargo test --release --offline -p kd_css --test differential -- --ignored
 * ```
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { cssCases } from './css-golden-cases.mjs';

const [outDirArg, countArg = '600', seedArg = '1'] = process.argv.slice(2);
if (!outDirArg) {
	process.stderr.write('usage: fuzz-css.mjs <outDir> [count] [seed]\n');
	process.exit(2);
}
const root = path.resolve(import.meta.dirname, '..');
const outDir = path.resolve(outDirArg);

/**
 * A small deterministic generator (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} A function returning numbers in [0, 1)
 */
function createRandom(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d_2b_79_f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const random = createRandom(Number(seedArg));
const int = (/** @type {number} */ min, /** @type {number} */ max) =>
	min + Math.floor(random() * (max - min + 1));
const chance = (/** @type {number} */ p) => random() < p;
/**
 * @template T
 * @param {readonly T[]} list - Choices
 * @returns {T} One of them
 */
const pick = (list) => list[int(0, list.length - 1)];

const names = [
	'red',
	'RED',
	'Blue',
	'white',
	'black',
	'tan',
	'gold',
	'orange',
	'rebeccapurple',
	'lightgoldenrodyellow',
	'aqua',
	'cyan',
	'fuchsia',
	'magenta',
	'gray',
	'grey',
	'silver',
	'currentColor',
	'transparent',
	'inherit',
	'navy',
	'darkslategray',
];

/** @returns {string} A colour in some notation */
function colour() {
	const hex = (/** @type {number} */ n) =>
		Array.from({ length: n }, () => '0123456789abcdefABCDEF'[int(0, 21)]).join('');
	switch (int(0, 14)) {
		case 0:
		case 1:
		case 2: {
			return pick(names);
		}
		case 3: {
			return `#${hex(3)}`;
		}
		case 4: {
			return `#${hex(6)}`;
		}
		case 5: {
			return `#${hex(chance(0.5) ? 4 : 8)}`;
		}
		case 6: {
			const c = `${hex(2)}`.toLowerCase();
			return `#${c}${c}${c}`;
		}
		case 7: {
			return `rgb(${int(0, 255)},${int(0, 255)},${int(0, 255)})`;
		}
		case 8: {
			return `rgb(${int(0, 255)} ${int(0, 255)} ${int(0, 255)}${chance(0.4) ? ` / ${pick(['50%', '.5', '0.25', '1'])}` : ''})`;
		}
		case 9: {
			return `rgba(${int(0, 255)}, ${int(0, 255)}, ${int(0, 255)}, ${pick(['0', '.5', '0.25', '0.75', '.333', '1', '0.1'])})`;
		}
		case 10: {
			return `hsl(${int(0, 360)}${pick(['', 'deg', 'turn'])}, ${int(0, 100)}%, ${int(0, 100)}%)`;
		}
		case 11: {
			return `hsla(${int(0, 360)}, ${int(0, 100)}%, ${int(0, 100)}%, ${pick(['.5', '0.9', '0'])})`;
		}
		case 12: {
			return `rgb(${int(0, 100)}%, ${int(0, 100)}%, ${int(0, 100)}%)`;
		}
		case 13: {
			return pick([
				'oklch(0.7 0.1 200)',
				'lab(50% 20 30)',
				'hwb(200 10% 10%)',
				'color-mix(in srgb, red 30%, white)',
				'var(--c)',
				'light-dark(#fff, #000)',
			]);
		}
		default: {
			return `HSL(${int(0, 360)} ${int(0, 100)}% ${int(0, 100)}%)`;
		}
	}
}

/** @returns {string} A number as written in odd ways */
function num() {
	return pick([
		'0',
		'0.0',
		'.5',
		'0.5',
		'0.50',
		'1',
		'1.0',
		'1.50',
		'10',
		'100',
		'12.5',
		'-1',
		'-.5',
		'-0.5',
		'+.5',
		'2',
		'3',
		'16',
		'0.25',
		'33.3333',
		'1e3',
		'00.5',
		String(int(0, 400)),
	]);
}

/** @returns {string} A length */
function length() {
	if (chance(0.1)) {
		return '0';
	}
	return `${num()}${pick(['px', 'px', 'px', 'em', 'rem', '%', 'vw', 'vh', 'pt', 'ch', 'cm', 'in', 'vmin', 'PX', 'Em'])}`;
}

/** @returns {string} A time or angle */
function timeOrAngle() {
	return `${pick(['0', '.5', '1', '0.3', '250', '1000', '1.5', '360', '90', '0.25'])}${pick(['s', 'ms', 's', 'deg', 'turn', 'MS'])}`;
}

/** @returns {string} A url() */
function url() {
	const body = pick([
		'a.png',
		'img/a.png',
		'./img/a.png',
		'../img/b.png',
		'a/../b.png',
		// (`a b.png` and `a(1).png` are in the hand-written cases: cssnano
		// writes an unescaped space for the first, depending on what it
		// minified before.)
		'data:image/png;base64,AAAA',
		'//example.com/a.png',
		'https://EXAMPLE.com/a.png?x=1#y',
		'',
		'#frag',
		'a.svg#b',
	]);
	switch (int(0, 3)) {
		case 0: {
			return `url(${body.includes(' ') || body.includes('(') || body.includes("'") ? JSON.stringify(body) : body})`;
		}
		case 1: {
			return `url("${body.replaceAll('"', String.raw`\"`)}")`;
		}
		case 2: {
			return `url( '${body.replaceAll("'", String.raw`\'`)}' )`;
		}
		default: {
			return `url("${body.replaceAll('"', String.raw`\"`)}")`;
		}
	}
}

/** @returns {string} A calc expression */
function calc() {
	// Only valid expressions, and only units cssnano does not convert
	// between (it folds `in` and `cm` into each other).
	// (Nor zero: cssnano keeps `calc(0rem + 1000%)`, which kd_css folds.)
	const len = () =>
		`${num().replace(/^[+-]?0*\.?0*$/u, '1')}${pick(['px', 'px', 'em', 'rem', '%', 'vw', 'vh'])}`;
	const term = () => pick([len(), '100%', 'var(--a)', `(${len()} + ${len()})`, `${int(2, 5)} * ${len()}`]);
	switch (int(0, 4)) {
		case 0: {
			return `calc(${term()} ${pick(['+', '-'])} ${term()})`;
		}
		case 1: {
			return `calc(${len()} * ${int(2, 5)})`;
		}
		case 2: {
			return `${pick(['min', 'max'])}(${len()}${pick([',', ', '])}${len()})`;
		}
		case 3: {
			return `clamp(${len()}${pick([',', ', '])}${len()}${pick([',', ', '])}${len()})`;
		}
		default: {
			return `calc(${pick(['100%', '50vw'])} ${pick(['-', '+'])} ${len()})`;
		}
	}
}

/** @returns {string} A gradient */
function gradient() {
	const stops = Array.from({ length: int(2, 4) }, (_, i, all) =>
		chance(0.5) ? `${colour()} ${pick(['0%', '50%', '100%', '30%', '10px', '40%', '20%'])}` : colour(),
	);
	const kind = pick([
		'linear-gradient',
		'linear-gradient',
		'repeating-linear-gradient',
		'-webkit-linear-gradient',
		'radial-gradient',
		'conic-gradient',
	]);
	const head = kind.includes('linear')
		? pick(['', 'to bottom, ', 'to top, ', 'to right, ', 'to left top, ', '45deg, ', '180deg, '])
		: kind.includes('radial')
			? pick(['', 'circle at center, ', 'ellipse, '])
			: pick(['', 'from 0deg, ', 'from 90deg at 50% 50%, ']);
	return `${kind}(${head}${stops.join(pick([',', ', ', ' , ']))})`;
}

/** @returns {string} A font family list */
function fontFamily() {
	const families = [
		'"Helvetica Neue"',
		"'Open Sans'",
		'Arial',
		'"Arial"',
		'sans-serif',
		'serif',
		'monospace',
		'"Noto Sans JP"',
		'"1Pass"',
		'system-ui',
		'"Font, Name"',
		'Georgia',
		'"Segoe UI"',
		'"M PLUS 1p"',
		'-apple-system',
		'BlinkMacSystemFont',
		'"Hiragino Kaku Gothic ProN"',
		'メイリオ',
	];
	// Distinct families: in the `font` shorthand cssnano misplaces a space
	// and then keeps a repeated family (the hand-written cases repeat them).
	const chosen = [];
	for (let i = 0, n = int(1, 5); i < n; i++) {
		const f = pick(families);
		if (!chosen.includes(f)) {
			chosen.push(f);
		}
	}
	return chosen.join(pick([',', ', ', ' , ']));
}

/** @returns {string} One transform function list */
function transform() {
	return Array.from({ length: int(1, 3) }, () =>
		pick([
			`translate(${length()}, ${length()})`,
			'translate(0, 0)',
			`translate(0,${length()})`,
			`translate(${length()},0)`,
			'translate3d(0, 0, 0)',
			`translate3d(0,0,${length()})`,
			`scale(${pick(['1', '2', '1.5'])}, ${pick(['1', '2'])})`,
			'scale(1)',
			`rotate(${timeOrAngle().replace(/s$|ms$/u, 'deg')})`,
			'rotateZ(45deg)',
			'rotate3d(0, 0, 1, 45deg)',
			'rotate3d(1, 0, 0, 45deg)',
			'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,10,20,0,1)',
			'skew(10deg)',
			`translateX(${length()})`,
		]),
	).join(' ');
}

/**
 * A random declaration as `property: value`.
 * @returns {string} The declaration
 */
function declaration() {
	const important = chance(0.08)
		? pick(['!important', ' !important', ' !important', '!IMPORTANT'])
		: '';
	const colourProps = [
		'color',
		'background-color',
		'border-color',
		'outline-color',
		'fill',
		'stroke',
		'caret-color',
		'text-decoration-color',
		'column-rule-color',
	];
	const lengthProps = [
		'width',
		'height',
		'min-width',
		'max-width',
		'min-height',
		'max-height',
		'top',
		'left',
		'right',
		'bottom',
		'font-size',
		'line-height',
		'letter-spacing',
		'border-radius',
		'gap',
		'text-indent',
		'margin-top',
		'padding-left',
		'flex-basis',
		'stroke-width',
		'outline-offset',
	];
	const value = ((/** @type {number} */ kind) => {
		switch (kind) {
			case 0: {
				return `${pick(colourProps)}:${colour()}`;
			}
			case 1: {
				return `${pick(lengthProps)}:${chance(0.15) ? calc() : length()}`;
			}
			case 2: {
				const sides = Array.from({ length: int(1, 4) }, () => (chance(0.4) ? pick(['0', 'auto', '1px']) : length()));
				const prop = pick(['margin', 'padding']);
				// Padding takes neither `auto` nor negative lengths (cssnano
				// leaves such declarations alone, which hides real differences).
				const valid = prop === 'padding' ? sides.map((s) => (s === 'auto' ? '1px' : s.replace(/^-/u, ''))) : sides;
				return `${prop}:${valid.join(pick([' ', '  ']))}`;
			}
			case 3: {
				return `border${pick(['', '-top', '-left', '-bottom'])}:${pick(['1px', '2px', '0', 'thin', length()])} ${pick(['solid', 'dashed', 'none', 'dotted'])} ${colour()}`;
			}
			case 4: {
				return `background:${pick([colour(), url(), gradient(), `${colour()} ${url()} no-repeat ${pick(['left top', 'center center', '0 0', 'right 10px top 20px', 'top', 'left'])}`, `${url()} ${pick(['repeat no-repeat', 'no-repeat repeat', 'repeat-x', 'no-repeat no-repeat'])}`, `${url()} center / cover`, `${gradient()}, ${gradient()}`])}`;
			}
			case 5: {
				return `font-family:${fontFamily()}`;
			}
			case 6: {
				return `font:${pick(['', 'italic ', 'bold ', 'normal normal bold ', 'small-caps ', '700 '])}${pick(['12px', '1em', '14px/1.5', '16px / 24px', 'small', 'large/1.2'])} ${fontFamily()}`;
			}
			case 7: {
				return `transition:${Array.from({ length: int(1, 3) }, () => `${pick(['all', 'opacity', 'transform', 'color'])} ${pick(['.3s', '0.3s', '300ms', '1s', '500ms'])} ${pick(['ease', 'linear', 'ease-in-out', 'cubic-bezier(0.25, 0.1, 0.25, 1)', 'cubic-bezier(.42,0,.58,1)', 'steps(4, end)', 'steps(1,start)', ''])}${chance(0.3) ? ` ${pick(['0s', '100ms', '.1s'])}` : ''}`.trim()).join(pick([',', ', ']))}`;
			}
			case 8: {
				return `animation:${pick(['spin', 'fade-in', 'x'])} ${pick(['1s', '500ms', '2s'])} ${pick(['linear', 'ease', 'cubic-bezier(0.25,0.1,0.25,1)', 'steps(1,end)'])}${chance(0.5) ? ` ${pick(['infinite', '3', 'alternate', 'both', 'running'])}` : ''}`;
			}
			case 9: {
				return `${pick(['transform', '-webkit-transform', '-ms-transform'])}:${transform()}`;
			}
			case 10: {
				// Custom properties keep their values as written (kd_css never
				// touches them; cssnano minifies colours and calc() in them),
				// so the random values are the ones people write; the odd ones
				// are in the hand-written cases.
				return `${pick(['--x', '--Color', '--spacing-1', '--a-b', '--empty'])}:${pick(['', ' ', '1px', '#fff', '#112233', 'red', '{ "a": [1, 2] }', '"a"', "'b'", '8px', 'a, b', '10px/2', '1px solid var(--c)'])}`;
			}
			case 11: {
				return `box-shadow:${Array.from({ length: int(1, 3) }, () => `${chance(0.3) ? 'inset ' : ''}${length()} ${length()} ${chance(0.6) ? `${length()} ` : ''}${colour()}`).join(pick([',', ', ']))}`;
			}
			case 12: {
				return `display:${pick(['block', 'flex', 'none', 'inline-block', 'block flow', 'inline flow-root', 'block flex', 'grid', 'list-item block flow', 'inline flex', 'block grid'])}`;
			}
			case 13: {
				return `background-position:${pick(['left top', 'top left', 'center center', '0 0', 'right bottom', 'center left', 'left center', '50% 50%', '10px 20px', 'left 10px top 20px', 'center', 'top', 'bottom right'])}`;
			}
			case 14: {
				return `flex:${pick(['1', '1 1 0%', '1 1 0px', '0 0 auto', '1 0 0', 'none'])}`;
			}
			case 15: {
				return `${pick(['grid-template-columns', 'grid-template-rows'])}:${pick(['repeat(2, 1fr)', 'repeat(auto-fill, minmax(100px, 1fr))', '1fr 1fr', '[a] 1fr [b]', 'minmax(0px, 1fr) auto', '200px repeat(2, 1fr)'])}`;
			}
			case 16: {
				return `grid-area:${pick(['1 / 2 / 3 / 4', 'a', '1/3', 'span 2 / 3'])}`;
			}
			case 17: {
				return `${pick(['opacity', 'z-index', 'order', 'flex-grow', 'font-weight', 'line-height', 'zoom'])}:${pick(['1', '0.5', '.50', '010', 'bold', 'normal', 'BOLD', '1.5', '-1', '0', '700', '2'])}`;
			}
			case 18: {
				return `content:${pick(['""', "''", '"a"', "'a'", '"\\201C"', '"a\\"b"', "'a\"b'", "'a\\'b'", 'counter(x)', 'attr(href)', '"é"', 'url(a.png)', 'open-quote'])}`;
			}
			case 19: {
				return pick([
					'*zoom:1',
					'_height:1px',
					'filter:alpha(opacity=50)',
					'-ms-filter:"progid:DXImageTransform.Microsoft.Alpha(Opacity=50)"',
					'width:100px\\9',
					'color:red\\9',
					'cursor:pointer',
					'-webkit-appearance:none',
					'-moz-osx-font-smoothing:grayscale',
					'text-rendering:optimizeLegibility',
					'filter:progid:DXImageTransform.Microsoft.gradient(startColorstr=\'#80000000\', endColorstr=\'#80000000\')',
					'unicode-range:U+0025-00FF,u+4??',
					'unicode-range:U+0000-00FF',
					'will-change:transform , opacity',
					'font-feature-settings:"liga" 1 , "kern" 1',
					'quotes:"«" "»"',
					'list-style:none',
					'overflow:hidden',
					'visibility:hidden',
					'aspect-ratio:16 / 9',
					'inset:0',
					'transform-origin:50% 50%',
					'text-shadow:0 0 1px #FFF',
					'object-position:0% 0%',
					'clip-path:polygon(0% 0%,100% 0%,100% 100%)',
					'src:url("a.woff2") format("woff2"),url(\'a.woff\') format(\'woff\')',
					'transition:none',
					'margin:0 auto',
					'padding:0',
				]);
			}
			default: {
				return `${pick(['margin', 'padding', 'border-width', 'inset'])}:${length()} ${length()}`;
			}
		}
	})(int(0, 21));
	const [property, ...rest] = value.split(':');
	const v = rest.join(':');
	// Spaces around the colon and the value.
	const colon = pick([':', ':', ': ', ' : ', ':  ']);
	// cssnano keeps the white space before `!important` in a custom property.
	const flag = property.startsWith('--') ? important.trim() : important;
	const text = `${chance(0.05) ? property.toUpperCase() : property}${colon}${v}${flag}`;
	return chance(0.04) ? `${text.slice(0, text.indexOf(colon))}/* c */${text.slice(text.indexOf(colon))}` : text;
}

/** @returns {string} One compound selector */
function compound() {
	const tag = pick(['a', 'div', 'p', 'ul', 'li', 'span', 'h1', 'input', 'button', 'body', 'html', 'svg', '*', '']);
	const parts = [];
	const count = int(0, 3);
	for (let i = 0; i < count; i++) {
		parts.push(
			pick([
				'.a',
				'.b-c',
				'.is-active',
				'#id',
				'.c_d',
				String.raw`.a\:b`,
				String.raw`.\31 0`,
				'[type="text"]',
				"[type='checkbox']",
				'[ data-x = "y z" ]',
				'[href^="http"]',
				'[lang|=en]',
				'[data-a=1]',
				'[title="a" i]',
				'[class~="x"]',
				'[href$=".pdf"]',
				'[data-b="1x"]',
				':hover',
				':focus-visible',
				':first-child',
				':nth-child(2n+1)',
				':nth-child( 2n + 1 )',
				':nth-child(even)',
				':nth-child(1)',
				':nth-of-type(odd)',
				':nth-last-child(1)',
				':nth-child(2n+1 of .a)',
				':not(.a)',
				':not(.a,.a)',
				':not(.a, .b)',
				':is(.a, .b)',
				':where(.a,.b)',
				':has(> img)',
				':has(+ .a)',
				':is(h1,h2) :is(a)',
				':root',
				'::before',
				'::after',
				'::first-line',
				'::placeholder',
				'::-webkit-scrollbar',
				':lang(en)',
				'::part(foo)',
			]),
		);
	}
	const text = tag + parts.join('');
	return text === '' ? '.x' : text;
}

/** @returns {string} A selector list */
function selector() {
	const complex = () => {
		let text = compound();
		for (let i = 0, n = int(0, 3); i < n; i++) {
			// cssnano keeps a line break inside a selector (`a\n\tb`); that is
			// a known difference, tested by the hand-written cases only.
			text += pick([' ', ' > ', '>', ' + ', ' ~ ', '  ', ' >', '> ']) + compound();
		}
		return text;
	};
	const list = Array.from({ length: chance(0.3) ? int(2, 4) : 1 }, complex);
	if (chance(0.1)) {
		list.push(list[0]);
	}
	return list.join(pick([',', ', ', ',\n', ' , ']));
}

/**
 * @param {number} depth - Nesting depth, to stop the recursion
 * @returns {string} A block of declarations, with nested rules sometimes
 */
function block(depth) {
	const items = [];
	// One declaration per property: cssnano drops an earlier shorthand that a
	// later one overrides (`margin: 0; margin: 0 auto`) and merges longhands;
	// kd_css does neither, and a random corpus that repeats properties all
	// the time would only measure that.
	const used = new Set();
	for (let i = 0, n = int(0, 7); i < n; i++) {
		const d = declaration();
		const property = d.split(':')[0].replace(/\/\*.*?\*\//u, '').trim().toLowerCase();
		if (!used.has(property)) {
			used.add(property);
			items.push(d);
		}
	}
	// A declaration twice (hand-written cases cover that too): cssnano
	// removes duplicates from the last block to the first, so two equal
	// blocks that differ by a duplicate inside survive in cssnano and not in
	// kd_css, which would be noise here.
	if (chance(0.06) && items.length > 0 && depth > 0) {
		items.push(items[int(0, items.length - 1)]);
	}
	const sep = pick([';', ';', '; ', ';\n\t', ' ;', ';;']);
	// cssnano keeps stray semicolons in front of a custom property.
	let text = items.join(sep).replaceAll(/;\s*;(\s*--)/gu, ';$1');
	// Nested rules follow the declarations after a single semicolon (cssnano
	// keeps doubled and trailing semicolons around them).
	const nested = [];
	if (depth < 2 && chance(0.15)) {
		nested.push(
			`${pick(['&', '&:hover', '& .a', '.b &', '& > .c', '&.d', '> .e', '+ .f'])} { ${block(depth + 1)} }`,
		);
	}
	if (depth < 2 && chance(0.06)) {
		nested.push(`@media (min-width:${int(1, 9)}00px) { ${declaration()}; ${declaration()} }`);
	}
	if (nested.length === 0) {
		return text + (chance(0.5) && items.length > 0 ? ';' : '');
	}
	if (items.length > 0) {
		text += ';';
	}
	return text + nested.join(' ');
}

/** @returns {string} A rule */
function rule() {
	const nl = pick([' ', '\n', '', '\n\t']);
	return `${selector()}${pick([' ', '', '\n'])}{${nl}${block(0)}${nl}}`;
}

/** @returns {string} A media query list */
function mediaQuery() {
	const feature = () =>
		pick([
			`(min-width: ${int(1, 12)}${pick(['00px', '0em', '0px'])})`,
			`(max-width:${int(1, 12)}00px)`,
			'(prefers-color-scheme: dark)',
			'(orientation:landscape)',
			'(min-aspect-ratio: 16/9)',
			'(min-aspect-ratio: 32 / 18)',
			'(-webkit-min-device-pixel-ratio: 1.5)',
			'(min-resolution: 2dppx)',
			'(hover: hover)',
			'(width >= 600px)',
			'(400px <= width <= 700px)',
			'(prefers-reduced-motion:reduce)',
		]);
	const one = () =>
		pick([
			feature(),
			`screen and ${feature()}`,
			`only screen and ${feature()} and ${feature()}`,
			'print',
			'screen',
			`not all and ${feature()}`,
			`screen  and  ${feature()}`,
		]);
	// cssnano turns `all, x` into `, x` (an invalid list), so `all` is only
	// used for a list of one.
	if (chance(0.08)) {
		return pick(['all', `all and ${feature()}`]);
	}
	return Array.from({ length: chance(0.25) ? 2 : 1 }, one).join(pick([',', ', ', ' , ']));
}

/**
 * @param {number} depth - Nesting depth
 * @returns {string} A top-level item
 */
function item(depth = 0) {
	const r = random();
	if (r < 0.62) {
		return rule();
	}
	if (r < 0.7) {
		return `@media ${mediaQuery()} {\n${Array.from({ length: int(1, 3) }, () => (depth < 1 && chance(0.15) ? item(depth + 1) : rule())).join('\n')}\n}`;
	}
	if (r < 0.74) {
		return `@supports ${pick(['(display: grid)', 'not (display:grid)', '(display:grid) and (not (display:inline-grid))', '(--css: variables)', 'selector(:has(a))', '(display: flex) or (display: -webkit-flex)'])} { ${rule()} }`;
	}
	if (r < 0.79) {
		const family = pick(['"A"', "'My Font'", 'Mono', '"Noto Sans"']);
		return `@font-face {\n\tfont-family: ${family};\n\tsrc: ${pick([`url("a.woff2") format("woff2"), url('a.woff') format('woff')`, 'url(a.eot?#iefix) format("embedded-opentype")', 'local("A"), url(a.ttf)'])};\n\tfont-weight: ${pick(['normal', 'bold', '400', '100 900'])};\n\tfont-display: swap;${chance(0.5) ? `\n\tunicode-range: ${pick(['U+0000-00FF, U+0131', 'U+0025-00FF', 'u+4??', 'U+0400-045F, U+0490-0491'])};` : ''}\n}`;
	}
	if (r < 0.84) {
		const name = pick(['spin', 'fade', 'slide-in', 'pulse']);
		const frames = chance(0.5)
			? `from{${block(0)}}${pick([' ', '\n'])}to{${block(0)}}`
			: `0%{${block(0)}} ${pick(['50%', '25%,75%', '30%'])}{${block(0)}} 100%{${block(0)}}`;
		return `@${pick(['keyframes', 'keyframes', '-webkit-keyframes'])} ${name} { ${frames} }`;
	}
	if (r < 0.87) {
		return `@layer ${pick(['base', 'components', 'a.b', 'base, components'])}${chance(0.4) ? ';' : ` { ${rule()} }`}`;
	}
	if (r < 0.9) {
		// cssnano leaves the white space in a container query alone; kd_css
		// removes it (see the hand-written cases).
		return `@container ${pick(['', 'sidebar ', 'card '])}(min-width:${int(1, 9)}00px) { ${rule()} }`;
	}
	if (r < 0.92) {
		return `@property --${pick(['x', 'angle', 'p'])} { syntax: '${pick(['<length>', '<percentage>', '<color>', '<number>', '<length-percentage>'])}'; inherits: ${pick(['true', 'false'])}; initial-value: ${pick(['0px', '0%', '0', 'red', '#FFF'])}; }`;
	}
	if (r < 0.94) {
		return pick([
			`@import url("a${int(1, 9)}.css");`,
			// cssnano keeps the white space of an @import's media query.
			`@import 'b.css' ${mediaQuery().replaceAll(/\s+/gu, ' ')};`,
			'@namespace svg url(http://www.w3.org/2000/svg);',
			'@page :first { margin: 0px }',
			'@counter-style x { system: cyclic; symbols: "a" }',
			'@font-feature-values Font One { @styleset { nice-style: 12 } }',
		]);
	}
	if (r < 0.96) {
		return pick(['/* comment */', '/*! banner */', '/*!\n * Big\n */', '/**/', '/* a */ /* b */']);
	}
	if (r < 0.98) {
		return pick(['a{}', 'a { }', '@media print { }', '.x{;}', '@media screen { a {} }']);
	}
	return rule() + '\n' + rule();
}

/**
 * Inserts comments at random token gaps.
 * @param {string} css - A style sheet
 * @returns {string} The style sheet with comments
 */
function addComments(css) {
	// Between declarations and rules; a comment inside a selector or a value
	// makes cssnano skip rules (ordered-values, duplicate selectors), which
	// the hand-written cases cover.
	return css.replaceAll(/([;{}])/gu, (m) => (chance(0.02) ? `${m}/* x */` : m));
}

/**
 * @returns {string} A style sheet
 */
function sheet() {
	const parts = [];
	if (chance(0.06)) {
		parts.push('@charset "utf-8";');
	}
	if (chance(0.1)) {
		parts.push('/*! Banner v1 */');
	}
	// Mostly small sheets: a difference found in one rule is easy to read, and
	// cssnano's rule merging cannot reorder what is not there.
	const roll = random();
	const count = roll < 0.55 ? int(1, 2) : roll < 0.85 ? int(3, 8) : int(10, 30);
	for (let i = 0; i < count; i++) {
		parts.push(item());
		if (chance(0.05)) {
			parts.push(parts[int(0, parts.length - 1)]);
		}
	}
	let css = parts.join(pick(['\n', '\n\n', '', ' ', '\r\n']));
	if (chance(0.3)) {
		css = addComments(css);
	}
	return css + pick(['', '\n']);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let n = 0;
const write = (/** @type {string} */ text) => {
	writeFileSync(path.join(outDir, `${n}.in`), text);
	n++;
};
for (let i = 0; i < Number(countArg); i++) {
	write(sheet());
}
for (const c of cssCases()) {
	write(c);
}
// The CSS files found in node_modules (the real ones).
let real = 0;
try {
	const list = execFileSync(
		'find',
		[path.join(root, 'node_modules'), '-name', '*.css', '-size', '+300c'],
		{ encoding: 'utf8', maxBuffer: 1 << 26 },
	)
		.split('\n')
		.filter(Boolean);
	for (const file of list.toSorted()) {
		write(readFileSync(file, 'utf8'));
		real++;
	}
} catch {
	// no node_modules: only the generated cases
}
process.stdout.write(`wrote ${n} cases (${real} real files) to ${outDir}\n`);
