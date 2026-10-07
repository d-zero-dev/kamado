/**
 * Random TSX components for `check-kd-js-jsx.mjs fuzz`: element trees with
 * random attributes (static, dynamic, boolean, style objects, spreads, data
 * and aria), text with odd white space and entities, expression children,
 * conditionals and maps, local components, fragments, and now and then a whole
 * document with head and body. The props supply the values the expressions
 * read.
 */

/**
 * A small deterministic PRNG (mulberry32).
 * @param {number} seed - The seed
 * @returns {() => number} Numbers in [0, 1)
 */
function rng(seed) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d_2b_79_f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const flatTags = [
	'div',
	'p',
	'span',
	'a',
	'section',
	'nav',
	'h1',
	'h2',
	'em',
	'strong',
	'small',
	'code',
	'label',
	'button',
	'li',
	'td',
	'article',
	'figure',
	'figcaption',
	'blockquote',
	'main',
	'header',
	'footer',
];
const voidTags = ['br', 'hr', 'wbr', 'input', 'img'];
const runtimeTags = [
	'pre',
	'textarea',
	'title',
	'meta',
	'link',
	'script',
	'style',
	'select',
];

const texts = [
	'hello',
	'a b',
	'日本語のテキスト',
	'a &amp; b',
	'1 &lt; 2',
	'&copy; 2026',
	'&nbsp;',
	'quote "x" and \'y\'',
	'tab\there',
	'  leading',
	'trailing  ',
	'x\n\t\t\ty',
	'\n\t\t\tline\n\t\t',
	'a\n\n\nb',
	'&#169; &#xA9;',
	'&unknown; &',
	'😀',
];

/**
 * @param {number} seed - The seed
 * @returns {() => { name: string; source: string; props: Record<string, unknown> }} A case generator
 */
export function createCaseGenerator(seed) {
	const random = rng(seed);
	/**
	 * @template T
	 * @param {readonly T[]} list - The choices
	 * @returns {T} One of them
	 */
	const pick = (list) => list[Math.floor(random() * list.length)];
	const chance = (p) => random() < p;
	const below = (n) => Math.floor(random() * n);

	const strValues = [
		'a',
		'a b',
		'',
		'x"y',
		"x'y",
		'<b>&</b>',
		'/p?a=1&b=2',
		'日本',
		'  sp  ',
		'0',
	];
	const props = () => ({
		s: pick(strValues),
		t: pick(strValues),
		n: pick([0, 1, 2, -3, 1.5, 100]),
		b: chance(0.5),
		z: pick([null, undefined, false, 0, '']),
		arr: Array.from({ length: below(4) }, () => pick(strValues)),
		o: pick([
			{ id: 'oid', className: 'oc' },
			{ 'data-a': 1, title: 'ot' },
			{},
			{ style: { color: 'red', fontSize: 10 } },
		]),
		st: pick([
			{ color: 'red' },
			{ width: 10, height: '5em', zIndex: 2 },
			{},
			{ opacity: 0.5 },
		]),
	});

	/**
	 * @returns {string} An attribute expression's value source
	 */
	function dynValue() {
		return pick([
			'props.s',
			'props.t',
			'props.n',
			'props.b',
			'props.z',
			'props.b ? "yes" : undefined',
			'`${props.s}-x`',
			'props.s + props.t',
			'props.n > 1 && "big"',
		]);
	}

	/**
	 * @param {string} tag - The element name
	 * @returns {string} Attributes (each with a leading space)
	 */
	function attrs(tag) {
		const n = below(4);
		let out = '';
		const used = new Set();
		for (let i = 0; i < n; i++) {
			const kind = below(14);
			let attr;
			switch (kind) {
				case 0: {
					attr = `className="${pick(['a', 'a b', 'x-y', 'c  d'])}"`;
					break;
				}
				case 1: {
					attr = `className={${dynValue()}}`;
					break;
				}
				case 2: {
					attr = `id="${pick(['i', 'j-1', 'k_2'])}"`;
					break;
				}
				case 3: {
					attr = `data-x="${pick(['1', 'a&amp;b', 'q"r'.replace('"', '&quot;')])}"`;
					break;
				}
				case 4: {
					attr = `data-y={${dynValue()}}`;
					break;
				}
				case 5: {
					attr = `aria-label={${dynValue()}}`;
					break;
				}
				case 6: {
					attr = `title="${pick(['t', 'a b', 'x &amp; y'])}"`;
					break;
				}
				case 7: {
					attr = pick([
						'hidden',
						'disabled',
						'checked',
						'readOnly',
						'required',
						'autoFocus',
						'multiple',
					]);
					break;
				}
				case 8: {
					attr = `${pick(['hidden', 'disabled', 'checked', 'required'])}={${pick(['props.b', 'false', 'true', 'props.z', 'props.n'])}}`;
					break;
				}
				case 9: {
					attr = `style={${pick(['props.st', '{ color: "red" }', '{ width: props.n, margin: 0 }', '{ fontSize: 12, lineHeight: 1.5 }'])}}`;
					break;
				}
				case 10: {
					attr = `href={${pick(['props.s', '"/x"', '"https://example.com/?a=1&b=2"'])}}`;
					break;
				}
				case 11: {
					attr = `tabIndex={${pick(['0', 'props.n', '-1'])}}`;
					break;
				}
				case 12: {
					attr = `{...props.o}`;
					break;
				}
				default: {
					attr = `key={props.n}`;
				}
			}
			const name = attr.split(/[={]/)[0];
			if (!used.has(name) || name === '') {
				used.add(name);
				out += ` ${attr}`;
			}
		}
		if (tag === 'img') {
			out += ` src=${pick(['"/a.png"', '{props.s}', '"/b.png"'])} alt=""`;
			if (chance(0.2)) {
				out += ' loading="lazy"';
			}
		}
		if (tag === 'input') {
			out += ` type="${pick(['text', 'checkbox', 'hidden'])}"`;
		}
		if (tag === 'meta') {
			out += ` name="${pick(['d', 'viewport', 'robots'])}" content={${dynValue()}}`;
		}
		if (tag === 'link') {
			out += ` rel="${pick(['stylesheet', 'icon', 'preload', 'canonical'])}" href="/l.css"`;
		}
		if (tag === 'script') {
			out += pick([' src="/s.js"', ' src="/s.js" async', ' type="application/ld+json"']);
		}
		return out;
	}

	/**
	 * @returns {string} Text for children
	 */
	const text = () => pick(texts);

	/**
	 * @param {number} depth - Nesting depth so far
	 * @returns {string} A child: text, an expression or an element
	 */
	function child(depth) {
		const r = random();
		if (depth > 3 || r < 0.22) {
			return text();
		}
		if (r < 0.4) {
			return pick([
				'{props.s}',
				'{props.n}',
				'{props.z}',
				'{props.b && "shown"}',
				'{props.b ? "a" : "b"}',
				"{' '}",
				'{"<b>lit</b>"}',
				'{`t ${props.s}`}',
				'{props.arr.join(",")}',
				'{/* c */}',
				'{null}',
				'{props.n}{props.n}',
			]);
		}
		if (r < 0.5) {
			return `{props.arr.map((x: string, i: number) => <li key={i}>{x}</li>)}`;
		}
		if (r < 0.55) {
			return `{props.b ? ${element(depth + 1)} : ${element(depth + 1)}}`;
		}
		if (r < 0.6) {
			return `{props.b && ${element(depth + 1)}}`;
		}
		if (r < 0.67) {
			return `<Box a={props.s}${chance(0.5) ? ' {...props.o}' : ''}>${children(depth + 1)}</Box>`;
		}
		if (r < 0.7) {
			return `<Item v={props.n} />`;
		}
		if (r < 0.74) {
			return `<>${children(depth + 1)}</>`;
		}
		return element(depth + 1);
	}

	/**
	 * @param {number} depth - Nesting depth so far
	 * @returns {string} Several children
	 */
	function children(depth) {
		const n = below(4);
		let out = '';
		for (let i = 0; i < n; i++) {
			out += `${chance(0.3) ? pick(['\n\t\t', ' ', '\n']) : ''}${child(depth)}`;
		}
		return out;
	}

	/**
	 * @param {number} depth - Nesting depth so far
	 * @returns {string} An element
	 */
	function element(depth) {
		const r = random();
		if (r < 0.1) {
			const tag = pick(voidTags);
			return `<${tag}${attrs(tag)} />`;
		}
		if (r < 0.2) {
			const tag = pick(runtimeTags);
			if (tag === 'select') {
				return `<select${chance(0.5) ? ' value={props.s}' : ''}><option value="a">A</option><option value={props.s}>B</option></select>`;
			}
			if (tag === 'title') {
				return `<title>${pick(['T', '{props.s}', '{`x ${props.s}`}'])}</title>`;
			}
			if (['meta', 'link'].includes(tag)) {
				return `<${tag}${attrs(tag)} />`;
			}
			if (tag === 'script') {
				return `<script${attrs(tag)}>${chance(0.5) ? '{"var a = 1 < 2;"}' : ''}</script>`;
			}
			if (tag === 'style') {
				return `<style>{"a > b { color: red }"}</style>`;
			}
			if (tag === 'textarea') {
				return `<textarea${attrs(tag)}>{props.s}</textarea>`;
			}
			return `<pre${attrs(tag)}>${pick(['{props.s}', 'text', '\nx', '{"\\nlead"}'])}</pre>`;
		}
		if (r < 0.24) {
			return pick([
				'<svg viewBox="0 0 10 10"><path d="M0 0L5 5" strokeWidth={props.n} fill="none" /><circle cx={props.n} r="2" />{props.b && <title>t</title>}</svg>',
				'<svg xmlns="http://www.w3.org/2000/svg" width={props.n}><g className="g"><rect x="0" y="0" width="1" height="1" /><text>{props.s}</text></g></svg>',
				'<picture><source srcSet="/a.webp" type="image/webp" /><img src={props.s} alt="" /></picture>',
				'<noscript><img src="/ns.png" alt="" /></noscript>',
				'<a href={props.s}>{props.t}</a>',
				'<a href="">x</a>',
				'<a href={props.z as any}>y</a>',
				'<img src="/x.png" alt="" loading="lazy" />',
			]);
		}
		const tag = pick(flatTags);
		return `<${tag}${attrs(tag)}>${children(depth)}</${tag}>`;
	}

	return () => {
		const hasDoc = chance(0.2);
		let body;
		if (hasDoc) {
			const parts = [
				pick([
					'',
					'<base href="/" />',
					'<style>{"a{b:c}"}</style>',
					'<noscript><img src="/n.png" alt="" /></noscript>',
				]),
				pick([
					'',
					'<meta charSet="utf-8" />',
					'<meta name="viewport" content="width=device-width" />',
				]),
				'<title>{props.s}</title>',
				pick([
					'',
					'<link rel="stylesheet" href="/c.css" />',
					'<script src="/a.js" async></script>',
					'<link rel="icon" href="/f.ico" />',
				]),
				pick(['', '<meta name="description" content={props.t} />']),
			];
			const head = `<head>${parts.join('')}</head>`;
			body = `<html lang="ja">${head}<body>${children(1)}${chance(0.3) ? '<title>b</title>' : ''}</body></html>`;
		} else if (chance(0.5)) {
			body = element(0);
		} else {
			body = `<>${children(0)}</>`;
		}
		const components = `function Box(p: any) { return <div className="box"${chance(0.5) ? ' data-a={p.a}' : ''}>{p.children}</div>; }\nconst Item = ({ v }: { v: number }) => <i>{v}</i>;\n`;
		const source = `${components}export default function Page(props: any) {\n\treturn (\n\t\t${body}\n\t);\n}\n`;
		return { name: `fuzz`, source, props: props() };
	};
}
