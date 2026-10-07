/**
 * Hand-written TSX cases for the differential check of `kd_js` and the JSX
 * runtime against v2's compiler (esbuild + React 19 `renderToStaticMarkup`).
 * Each case is a component module (`export default`) and the props it is
 * rendered with.
 * @typedef {object} JsxCase
 * @property {string} name - A short label
 * @property {string} source - The TSX module
 * @property {Record<string, unknown>} [props] - The props the default export gets
 */

/**
 * @param {string} body - The JSX (or other expression) returned by the component
 * @param {string} [before] - Statements before the return
 * @param {string} [top] - Module-level code (imports, helper components)
 * @returns {string} A module with a default-exported component
 */
const page = (body, before = '', top = '') =>
	`${top}\nexport default function Page(props: any) {\n${before}\n\treturn (\n${body}\n\t);\n}\n`;

/** @type {JsxCase[]} */
export const cases = [
	{ name: 'plain element', source: page('<p>hello</p>') },
	{ name: 'nested', source: page('<div><p>a</p><p>b</p></div>') },
	{
		name: 'text entities',
		source: page(
			'<p>a &amp; b &lt;c&gt; &quot;d&quot; &nbsp;e &copy; &#169; &#xA9; &unknown; &</p>',
		),
	},
	{
		name: 'text needing escape in an expression',
		source: page('<p>{props.t}</p>'),
		props: { t: '<b>"x" & \'y\'</b>' },
	},
	{
		name: 'multiline text',
		source: page('<p>\n\t\t\tline one\n\t\t\tline two\n\t\t</p>'),
	},
	{
		name: 'jsx whitespace between elements',
		source: page('<p>\n\t\t\t<b>a</b>\n\t\t\t<i>b</i>\n\t\t\ttext\n\t\t</p>'),
	},
	{ name: 'inline spaces kept', source: page('<p><b>a</b> <i>b</i>  c</p>') },
	{ name: 'space in expression', source: page('<p>a{\' \'}b{" "}c</p>') },
	{ name: 'tabs in text', source: page('<p>a\tb\t\tc</p>') },
	{ name: 'empty expression comment', source: page('<p>a{/* nothing */}b</p>') },
	{ name: 'only whitespace lines', source: page('<div>\n\n\n</div>') },
	{ name: 'fragment', source: page('<><p>a</p><p>b</p></>') },
	{ name: 'fragment with text', source: page('<>text <b>x</b> more</>') },
	{
		name: 'void elements',
		source: page(
			'<div><br /><img src="/a.png" alt="" /><hr/><input type="text" /></div>',
		),
	},
	{ name: 'self closing non void', source: page('<div><span /><p /></div>') },
	{
		name: 'static attributes',
		source: page(
			'<a href="/x?a=1&b=2" className="c d" id="i" title=\'t"q\' data-x="1" aria-label="l">a</a>',
		),
	},
	{
		name: 'attr entities',
		source: page('<a title="a &amp; b &quot;c&quot; &#169;">a</a>'),
	},
	{
		name: 'dynamic attributes',
		source: page('<a href={props.u} className={props.c} id={props.i}>a</a>'),
		props: { u: '/p?x=1&y=2', c: 'k', i: 'z"' },
	},
	{
		name: 'null and false attributes',
		source: page('<a href={props.n} id={props.f} title={undefined} data-x={null}>a</a>'),
		props: { n: null, f: false },
	},
	{
		name: 'boolean attributes',
		source: page('<input disabled checked readOnly required autoFocus />'),
	},
	{
		name: 'boolean attributes dynamic',
		source: page('<input disabled={props.t} checked={props.f} hidden={props.t} />'),
		props: { t: true, f: false },
	},
	{
		name: 'boolean attr string value',
		source: page('<input disabled="disabled" hidden="" />'),
	},
	{
		name: 'numeric attributes',
		source: page('<td colSpan={2} rowSpan={props.n} tabIndex={-1}>a</td>'),
		props: { n: 3 },
	},
	{ name: 'number zero attribute', source: page('<div data-n={0} tabIndex={0}>a</div>') },
	{
		name: 'data and aria booleans',
		source: page(
			'<div data-a={true} data-b={false} aria-hidden={true} aria-expanded={false}>a</div>',
		),
	},
	{
		name: 'draggable and contentEditable',
		source: page('<div draggable contentEditable={false} spellCheck={true}>a</div>'),
	},
	{
		name: 'className aliases',
		source: page('<label htmlFor="x" className="y">a</label>'),
	},
	{
		name: 'style object',
		source: page(
			'<div style={{ color: "red", fontSize: 12, marginTop: 0, lineHeight: 1.5, WebkitTransition: "all" }}>a</div>',
		),
	},
	{
		name: 'style dynamic',
		source: page('<div style={props.s}>a</div>'),
		props: { s: { backgroundColor: 'blue', opacity: 0.5, zIndex: 3, width: 100 } },
	},
	{
		name: 'style custom property',
		source: page('<div style={{ "--x": "1px", color: "red" }}>a</div>'),
	},
	{
		name: 'svg',
		source: page(
			'<svg viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg"><path d="M0 0L10 10" strokeWidth="2" fill="none" strokeLinecap="round" /><circle cx={5} cy={5} r="2" /></svg>',
		),
	},
	{ name: 'svg xlink', source: page('<svg><use xlinkHref="#a" /></svg>') },
	{
		name: 'event handlers omitted',
		source: page('<button onClick={() => 1} onMouseOver="x" type="button">a</button>'),
	},
	{
		name: 'key and ref omitted',
		source: page('<ul>{[1, 2].map((n) => <li key={n}>{n}</li>)}</ul>'),
	},
	{
		name: 'conditional and',
		source: page('<div>{props.show && <b>yes</b>}</div>'),
		props: { show: true },
	},
	{
		name: 'conditional and false',
		source: page('<div>{props.show && <b>yes</b>}</div>'),
		props: { show: false },
	},
	{
		name: 'conditional zero',
		source: page('<div>{props.n && <b>yes</b>}</div>'),
		props: { n: 0 },
	},
	{
		name: 'ternary',
		source: page('<div>{props.a ? <b>a</b> : <i>b</i>}</div>'),
		props: { a: false },
	},
	{
		name: 'ternary text',
		source: page('<div>{props.a ? "yes" : "no"}</div>'),
		props: { a: true },
	},
	{
		name: 'map',
		source: page('<ul>{props.items.map((i: string) => <li key={i}>{i}</li>)}</ul>'),
		props: { items: ['a', 'b<c', 'd&e'] },
	},
	{
		name: 'map with index',
		source: page(
			'<ol>{props.items.map((x: string, i: number) => <li key={i} className={i % 2 ? "o" : "e"}>{i}: {x}</li>)}</ol>',
		),
		props: { items: ['a', 'b', 'c'] },
	},
	{
		name: 'nested map',
		source: page(
			'<table>{props.rows.map((r: number[], i: number) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</table>',
		),
		props: {
			rows: [
				[1, 2],
				[3, 4],
			],
		},
	},
	{
		name: 'children expressions mix',
		source: page('<p>a{props.x}b{1}c{null}d{undefined}e{false}f{true}g</p>'),
		props: { x: 'X' },
	},
	{
		name: 'number children',
		source: page('<p>{0}{1.5}{-2}{NaN}{12345678901234567890}</p>'),
	},
	{
		name: 'string literal children',
		source: page('<p>{"<b>"}{\'a&b\'}{`t${props.v}`}</p>'),
		props: { v: 'V' },
	},
	{
		name: 'array children',
		source: page('<p>{[<b key="a">a</b>, "x", 1, null, [<i key="b">b</i>]]}</p>'),
	},
	{
		name: 'component',
		source: page(
			'<Card title="T" n={2}>child</Card>',
			'',
			'function Card(p: any) { return <div className="card"><h2>{p.title}</h2>{p.n}{p.children}</div>; }',
		),
	},
	{
		name: 'component without children',
		source: page(
			'<Hello name={props.n} />',
			'',
			'function Hello(p: any) { return <p>Hello {p.name}</p>; }',
		),
		props: { n: 'W' },
	},
	{
		name: 'component spread',
		source: page(
			'<Hello {...props.o} extra="e" />',
			'',
			'function Hello(p: any) { return <p>{p.a}-{p.b}-{p.extra}</p>; }',
		),
		props: { o: { a: 1, b: 2 } },
	},
	{
		name: 'component children array',
		source: page(
			'<Wrap><b>a</b>text<i>c</i></Wrap>',
			'',
			'function Wrap(p: any) { return <div>{p.children}</div>; }',
		),
	},
	{
		name: 'component returns string',
		source: page('<S />', '', 'function S() { return "a<b" as any; }'),
	},
	{
		name: 'component returns null',
		source: page('<div><N />x</div>', '', 'function N() { return null; }'),
	},
	{
		name: 'component returns array',
		source: page(
			'<div><L /></div>',
			'',
			'function L() { return [<b key="1">1</b>, <i key="2">2</i>]; }',
		),
	},
	{
		name: 'component returns fragment',
		source: page(
			'<div><F /></div>',
			'',
			'function F() { return <><b>1</b><i>2</i></>; }',
		),
	},
	{
		name: 'member component',
		source: page(
			'<ui.Box a="1" />',
			'',
			'const ui = { Box: (p: any) => <div className="box" data-a={p.a} /> };',
		),
	},
	{
		name: 'dynamic tag',
		source: page('<Tag className="x">y</Tag>', 'const Tag = props.t;'),
		props: { t: 'h2' },
	},
	{
		name: 'nested components',
		source: page(
			'<A><B><C /></B></A>',
			'',
			'const A = (p: any) => <section>{p.children}</section>; const B = (p: any) => <div>{p.children}</div>; const C = () => <i>c</i>;',
		),
	},
	{
		name: 'dangerouslySetInnerHTML',
		source: page('<main dangerouslySetInnerHTML={{ __html: props.h }} />'),
		props: { h: '<p>raw & <b>html</b></p>' },
	},
	{
		name: 'dangerouslySetInnerHTML null',
		source: page('<main dangerouslySetInnerHTML={{ __html: null as any }} />'),
	},
	{
		name: 'spread on element',
		source: page('<div {...props.p} id="b">x</div>'),
		props: { p: { id: 'a', className: 'c', 'data-z': 1 } },
	},
	{
		name: 'spread children override',
		source: page('<div {...props.p}>x</div>'),
		props: { p: { children: 'from spread' } },
	},
	{ name: 'textarea', source: page('<textarea defaultValue="a<b" rows={3} />') },
	{
		name: 'textarea children',
		source: page('<textarea>{props.v}</textarea>'),
		props: { v: '\nfirst newline' },
	},
	{
		name: 'pre leading newline',
		source: page('<pre>{props.v}</pre>'),
		props: { v: '\nx' },
	},
	{
		name: 'input value',
		source: page('<input type="text" value={props.v} defaultValue="d" />'),
		props: { v: 'v"' },
	},
	{
		name: 'input defaultValue',
		source: page('<input defaultValue="d" defaultChecked />'),
	},
	{
		name: 'select value',
		source: page(
			'<select value={props.v}><option value="a">A</option><option value="b">B</option></select>',
		),
		props: { v: 'b' },
	},
	{
		name: 'select defaultValue',
		source: page(
			'<select defaultValue="a"><option value="a">A</option><option>B</option></select>',
		),
	},
	{
		name: 'option selected',
		source: page('<select><option selected value="a">A</option></select>'),
	},
	{
		name: 'script text',
		source: page('<div><script>{"var a = 1 < 2 && \\"x\\";"}</script></div>'),
	},
	{ name: 'script src', source: page('<div><script src="/a.js" async /></div>') },
	{
		name: 'script jsonld',
		source: page(
			'<div><script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify({ a: "<b>" }) }} /></div>',
		),
	},
	{
		name: 'style text',
		source: page('<div><style>{"a > b { color: red }"}</style></div>'),
	},
	{ name: 'title in body', source: page('<div><title>t</title><p>x</p></div>') },
	{
		name: 'meta in body',
		source: page('<div><meta name="a" content="b" /><p>x</p></div>'),
	},
	{
		name: 'link in body',
		source: page('<div><link rel="stylesheet" href="/a.css" /><p>x</p></div>'),
	},
	{
		name: 'full document',
		source: page(
			'<html lang="ja"><head><meta charSet="utf-8" /><title>{props.t} | S</title><meta name="description" content={props.d} /><link rel="stylesheet" href="/c.css" /><script src="/a.js" defer></script></head><body><Header /><main>{props.children}</main><Footer /></body></html>',
			'',
			'const Header = () => <header className="h"><a href="/">top</a></header>; const Footer = () => <footer>f</footer>;',
		),
		props: { t: 'T', d: 'D', children: 'c' },
	},
	{
		name: 'document with hoisted body elements',
		source: page(
			'<html><head><link rel="stylesheet" href="/a.css" /><meta name="viewport" content="width=device-width" /><title>T</title><meta charSet="utf-8" /><script src="/x.js" async></script><link rel="icon" href="/f.ico" /></head><body><p>x</p><title>in body</title><meta name="a" /></body></html>',
		),
	},
	{
		name: 'document with preconnect and preload',
		source: page(
			'<html><head><link rel="preconnect" href="https://a.example" /><link rel="preload" href="/f.woff2" as="font" crossOrigin="" /><link rel="dns-prefetch" href="https://b.example" /><link rel="stylesheet" href="/s.css" precedence="default" /><title>x</title></head><body>y</body></html>',
		),
	},
	{
		name: 'generic component',
		source: page(
			'<Table<string> rows={["a", "b"]} />',
			'',
			'function Table<T,>(p: { rows: T[] }) { return <ul>{p.rows.map((r) => <li key={String(r)}>{String(r)}</li>)}</ul>; }',
		),
	},
	{
		name: 'typed props and satisfies',
		source: page('<p>{(props as { a: number }).a satisfies number}</p>'),
		props: { a: 5 },
	},
	{
		name: 'non-null assertion',
		source: page('<p>{props.o!.x}</p>'),
		props: { o: { x: 'X' } },
	},
	{
		name: 'arrow with generics in tsx',
		source: page('<p>{id<string>("a")}</p>', '', 'const id = <T,>(x: T): T => x;'),
	},
	{
		name: 'type only imports are dropped',
		source:
			"import type { ReactNode } from 'react';\nimport type { Foo } from './foo';\nexport default function Page(props: { children?: ReactNode }) { return <p>x</p>; }\n",
	},
	{
		name: 'interface and type',
		source:
			"interface P { a: string }\ntype Q = P & { b?: number };\nexport default function Page(props: Q) { const x: P = { a: 'A' }; return <p>{x.a}</p>; }\n",
	},
	{
		name: 'default props and destructuring',
		source:
			"export default function Page({ a = 'd', b: { c } = { c: 'C' } }: { a?: string; b?: { c: string } }) { return <p>{a}{c}</p>; }\n",
	},
	{
		name: 'arrow default export',
		source: 'export default (props: any) => <p>{props.a}</p>;\n',
		props: { a: 'A' },
	},
	{
		name: 'class component field syntax not used',
		source: page('<p>{[1, 2, 3].reduce((a, b) => a + b, 0)}</p>'),
	},
	{
		name: 'jsx in attribute expression',
		source: page(
			'<Frame icon={<b>i</b>} />',
			'',
			'const Frame = (p: any) => <div>{p.icon}</div>;',
		),
	},
	{
		name: 'jsx element as attribute value',
		source: page(
			'<Frame icon=<b>i</b> />',
			'',
			'const Frame = (p: any) => <div>{p.icon}</div>;',
		),
	},
	{ name: 'html comment style text', source: page('<p>{"<!-- c -->"}</p>') },
	{ name: 'unicode text', source: page('<p>日本語 テキスト 😀 &hearts;</p>') },
	{ name: 'attribute with newline', source: page('<p title="a\n   b">x</p>') },
	{ name: 'lt gt in text via entities', source: page('<p>1 &lt; 2 &gt; 0</p>') },
	{
		name: 'deep static',
		source: page(
			'<div><ul><li><a href="/a">A</a></li><li><a href="/b">B</a></li></ul><p>x <em>y</em> z</p></div>',
		),
	},
	{
		name: 'mixed static and dynamic',
		source: page(
			'<div><h1>{props.t}</h1><ul><li>one</li><li>two</li></ul><p>{props.t}</p></div>',
		),
		props: { t: 'T' },
	},
	{
		name: 'label and for',
		source: page(
			'<form><label htmlFor="a">A</label><input id="a" name="a" /><button type="submit" disabled={props.d}>go</button></form>',
		),
		props: { d: false },
	},
	{
		name: 'a with target',
		source: page(
			'<a href="https://example.com/" target="_blank" rel="noopener">example.com</a>',
		),
	},
	{
		name: 'img attributes',
		source: page(
			'<img src={props.s} alt="" width={10} height="20" loading="lazy" srcSet="a.png 1x, b.png 2x" />',
		),
		props: { s: '/a.png' },
	},
	{
		name: 'video',
		source: page(
			'<video controls autoPlay muted loop playsInline><source src="/a.mp4" type="video/mp4" /></video>',
		),
	},
	{
		name: 'iframe',
		source: page('<iframe src="https://example.com/" allowFullScreen frameBorder="0" />'),
	},
	{
		name: 'table',
		source: page(
			'<table><thead><tr><th scope="col">a</th></tr></thead><tbody><tr><td colSpan={2}>b</td></tr></tbody></table>',
		),
	},
	{
		name: 'custom element',
		source: page('<my-element some-attr="x" className="c">t</my-element>'),
	},
	{ name: 'javascript url', source: page('<a href="javascript:void(0)">x</a>') },
	{ name: 'empty attribute value', source: page('<a href="" title="">x</a>') },
	{
		name: 'long number attribute',
		source: page('<div data-n={1234567890123456789012}>x</div>'),
	},
	{ name: 'object attribute', source: page('<div data-o={{ a: 1 } as any}>x</div>') },
	{ name: 'function attribute', source: page('<div data-f={() => 1}>x</div>') },
	{ name: 'symbol and bigint', source: page('<div data-b={10n}>{10n}</div>') },
	{
		name: 'template literal attribute',
		source: page('<div className={`a ${props.b} c`}>x</div>'),
		props: { b: 'B' },
	},
	{
		name: 'logical or default',
		source: page('<div>{props.m || "none"}</div>'),
		props: { m: '' },
	},
	{ name: 'nullish', source: page('<div>{props.m ?? "none"}</div>'), props: { m: null } },
	{
		name: 'optional chaining',
		source: page('<div>{props.o?.p?.q}</div>'),
		props: { o: { p: { q: 'Q' } } },
	},
	{
		name: 'spread array children',
		source: page('<ul>{[...props.a, "z"].map((x: string) => <li key={x}>{x}</li>)}</ul>'),
		props: { a: ['x', 'y'] },
	},
	{ name: 'immediately invoked in child', source: page('<p>{(() => "iife")()}</p>') },
	{
		name: 'comment between attributes',
		source: page('<p /* c */ id="a" // d\n className="b">x</p>'),
	},
	{ name: 'closing tag with space', source: page('<p>x</p >') },
	{ name: 'text with braces entity', source: page('<p>{"{"}a{"}"}&#123;b&#125;</p>') },
	{
		name: 'conditional render of component',
		source: page('{props.on ? <A /> : null}', '', 'const A = () => <i>a</i>;').replace(
			'{props.on ? <A /> : null}',
			'<div>{props.on ? <A /> : null}</div>',
		),
		props: { on: true },
	},
];
