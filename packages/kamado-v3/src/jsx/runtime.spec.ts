import { createElement as h, Fragment as ReactFragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { PROPS as GENERATED_PROPS } from './attr-table.js';
import {
	a,
	c,
	el,
	Fragment,
	html,
	k,
	m,
	Markup,
	preloadImage,
	render,
	styleOf,
} from './runtime.js';

// ---------------------------------------------------------------------------
// Differential harness: one data tree, rendered by React (the oracle) and by
// the runtime in the way the compiler would emit it.
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;
type Component = (props: Props) => unknown;

/** A host element or component in the data tree. */
class E {
	constructor(
		readonly type: string | Component | typeof FRAGMENT,
		readonly props: Props | null,
		readonly children: unknown[],
	) {}
}

const FRAGMENT = Symbol('fragment');

/**
 * @param type - Tag name, component or `FRAGMENT`
 * @param props - Props
 * @param children - Children
 */
function e(type: E['type'], props: Props | null, ...children: unknown[]): E {
	return new E(type, props, children);
}

const reactComponents = new WeakMap<Component, Component>();
const runtimeComponents = new WeakMap<Component, Component>();

/**
 * @param node - A data tree
 * @returns The React node
 */
function toReact(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map((child) => toReact(child));
	}
	if (!(node instanceof E)) {
		return node;
	}
	const children = node.children.map((child) => toReact(child));
	if (node.type === FRAGMENT) {
		return h(ReactFragment, null, ...(children as never[]));
	}
	if (typeof node.type === 'function') {
		let wrapped = reactComponents.get(node.type);
		if (!wrapped) {
			const original = node.type;
			wrapped = (props) => toReact(original(props));
			reactComponents.set(node.type, wrapped);
		}
		return h(wrapped as never, node.props, ...(children as never[]));
	}
	return h(node.type, node.props as never, ...(children as never[]));
}

/** Parents the compiler gives a thunk because their children's rendering depends on them. */
const THUNK_PARENTS = new Set(['select', 'svg', 'foreignObject', 'noscript', 'picture']);

/**
 * @param node - A data tree
 * @returns The runtime value (call inside `render`)
 */
function toRuntime(node: unknown): unknown {
	if (Array.isArray(node)) {
		return node.map((child) => toRuntime(child));
	}
	if (!(node instanceof E)) {
		return node;
	}
	const evaluate = (): unknown => {
		const children = node.children.map((child) => toRuntime(child));
		return children.length === 1 ? children[0] : children;
	};
	if (node.type === FRAGMENT) {
		return k(Fragment, { children: evaluate() });
	}
	if (typeof node.type === 'function') {
		let wrapped = runtimeComponents.get(node.type);
		if (!wrapped) {
			const original = node.type;
			wrapped = (props) => toRuntime(original(props));
			runtimeComponents.set(node.type, wrapped);
		}
		const props: Props = { ...node.props };
		if (node.children.length > 0) {
			props.children = evaluate();
		}
		return k(wrapped, props);
	}
	if (node.children.length === 0) {
		return el(node.type, node.props);
	}
	return el(node.type, node.props, THUNK_PARENTS.has(node.type) ? evaluate : evaluate());
}

type Outcome = { html: string } | { error: string };

/**
 * @param run - Produces the HTML
 * @returns The HTML or the error message
 */
function outcome(run: () => string): Outcome {
	try {
		return { html: run() };
	} catch (error) {
		return { error: (error as Error).message };
	}
}

/**
 * @param tree - A data tree
 * @returns React's outcome
 */
function react(tree: unknown): Outcome {
	return outcome(() => renderToStaticMarkup(toReact(tree) as never));
}

/**
 * @param tree - A data tree
 * @returns The runtime's outcome
 */
function ours(tree: unknown): Outcome {
	return outcome(() => render(() => toRuntime(tree), {}));
}

/**
 * Asserts the runtime renders the tree exactly like React (or throws the same error).
 * @param tree - A data tree
 */
function expectSame(tree: unknown): void {
	expect(ours(tree)).toEqual(react(tree));
}

const noop = (): void => {};

let consoleError: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
	// React's development build warns about unknown props, missing keys, ...
	consoleError = vi.spyOn(console, 'error').mockImplementation(noop);
});
afterAll(() => {
	consoleError.mockRestore();
});

// ---------------------------------------------------------------------------
// Differential: element x props x children
// ---------------------------------------------------------------------------

const TAGS = [
	'div',
	'span',
	'p',
	'a',
	'br',
	'hr',
	'img',
	'input',
	'button',
	'select',
	'option',
	'textarea',
	'pre',
	'listing',
	'form',
	'object',
	'menuitem',
	'ul',
	'svg',
	'path',
	'title',
	'meta',
	'link',
	'script',
	'style',
	'base',
	'my-element',
	'noscript',
	'picture',
	'table',
];

const PROP_SETS: Props[] = [
	{},
	{ id: 'a' },
	{ id: 'a"<&\'>' },
	{ className: 'a b' },
	{ className: '' },
	{ 'data-x': '1&2' },
	{ 'data-flag': true },
	{ 'data-flag': false },
	{ 'aria-hidden': true },
	{ 'aria-label': 'x', role: 'button' },
	{ hidden: true },
	{ hidden: false },
	{ hidden: '' },
	{ disabled: 'disabled' },
	{ tabIndex: 0 },
	{ tabIndex: -1 },
	{ htmlFor: 'x' },
	{ style: { color: 'red' } },
	{ style: {} },
	{
		style: {
			fontSize: 12,
			lineHeight: 1.5,
			'--x': ' 1 ',
			msTransform: 'a',
			WebkitTransition: 'b',
			margin: 0,
			zIndex: 3,
			padding: null,
			top: false,
			left: '',
			opacity: 0.5,
		},
	},
	{ onClick: noop },
	{ href: '/a?b=1&c=2' },
	{ href: '' },
	{ src: '' },
	{ href: 'javascript:alert(1)' },
	{ href: ' \tJaVa\nScRiPt:alert(1)' },
	{ src: '/a.png' },
	{ src: '/a.png', alt: 'x' },
	{ src: '/a.png', loading: 'lazy' },
	{ src: 'data:image/png;base64,AA==' },
	{ srcSet: '/a.png 1x, /b.png 2x', sizes: '100vw' },
	{ value: 'v' },
	{ value: 0 },
	{ value: true },
	{ defaultValue: 'd' },
	{ value: 'v', defaultValue: 'd' },
	{ checked: true },
	{ defaultChecked: true },
	{ checked: false, defaultChecked: true },
	{ selected: true },
	{ rows: 0 },
	{ rows: 3 },
	{ cols: '4', size: 2, span: 0 },
	{ start: Number.NaN },
	{ rowSpan: 2, start: 5 },
	{ download: true },
	{ download: 'f.txt' },
	{ download: false },
	{ capture: true },
	{ contentEditable: true, spellCheck: false, draggable: 'true' },
	{ async: true, src: '/x.js' },
	{ async: true, src: '/x.js', type: 'module' },
	{ async: false, src: '/x.js' },
	{ src: '/x.js', defer: true },
	{ ref: noop },
	{ suppressHydrationWarning: true, suppressContentEditableWarning: true },
	{ xlinkHref: '#a', xmlLang: 'en', xmlnsXlink: 'http://www.w3.org/1999/xlink' },
	{ strokeWidth: 2, strokeLinecap: 'round', fillOpacity: 0.5, clipPath: 'url(#c)' },
	{ viewBox: '0 0 1 1', width: 10, height: '20' },
	{ charSet: 'utf8' },
	{ name: 'viewport', content: 'width=device-width' },
	{ name: 'description', content: 'd' },
	{ httpEquiv: 'refresh', content: '1' },
	{ rel: 'stylesheet', href: '/a.css' },
	{ rel: 'stylesheet', href: '/a.css', precedence: 'x' },
	{ rel: 'stylesheet', href: '/a.css', precedence: 'x', media: 'print' },
	{ rel: 'stylesheet', href: '/a.css', precedence: 'x', disabled: true },
	{ rel: 'stylesheet', href: '/a.css', onLoad: noop },
	{ rel: 'icon', href: '/f.ico', sizes: '16x16' },
	{ rel: 'preload', href: '/f.woff2', as: 'font', crossOrigin: '' },
	{ rel: 'preconnect', href: 'https://example.com' },
	{ rel: 'canonical', href: '' },
	{ itemProp: 'name' },
	{ itemProp: 'name', content: 'c' },
	{ precedence: 'p', href: 'h' },
	{ dangerouslySetInnerHTML: { __html: '<b>x</b>' } },
	{ dangerouslySetInnerHTML: { __html: '\nlead' } },
	{ dangerouslySetInnerHTML: { __html: null } },
	{ dangerouslySetInnerHTML: {} },
	{ dangerouslySetInnerHTML: 'x' },
	{ foo: 'bar' },
	{ foo: true },
	{ foo: false },
	{ foo: 1 },
	{ foo: noop },
	{ foo: Symbol('x') },
	{ foo: { a: 1 } },
	{ 'foo bar': 'x' },
	{ '1foo': 'x' },
	{ ' ': 'x' },
	{ name: 'n', method: 'post', target: '_blank', encType: 'text/plain', action: '/go' },
	{
		name: 'n',
		formMethod: 'post',
		formTarget: '_blank',
		formEncType: 'x',
		formAction: '/go',
	},
	{ type: 'text', placeholder: 'p', maxLength: 3, autoFocus: true, autoComplete: 'off' },
	{ type: 'checkbox', checked: true, readOnly: true, required: true },
	{
		multiple: true,
		autoPlay: true,
		muted: true,
		controls: true,
		loop: true,
		playsInline: true,
	},
	{ allowFullScreen: true, noValidate: true, open: true, reversed: true, inert: true },
	{ data: '/o.swf', type: 'x' },
	{ data: '' },
	{ crossOrigin: 'anonymous', referrerPolicy: 'no-referrer', fetchPriority: 'high' },
	{ srcDoc: '<p>', sandbox: 'allow-scripts', allow: 'camera' },
	{ is: 'x-y', slot: 's', part: 'p' },
	{ nonce: 'n', integrity: 'sha', blocking: 'render' },
];

const CHILDREN: unknown[][] = [
	[],
	['text'],
	['a<b>&"\''],
	[''],
	['\nlead'],
	['\n'],
	['\n\nx'],
	[0],
	[Number.NaN],
	[42],
	[-0],
	[1.5],
	[true],
	[false],
	[null],
	[undefined],
	['a', 'b'],
	['a', 1, null, 'b'],
	[['a', 'b']],
	[['a', ['b', 1]]],
	[['\nx']],
	[[null, 'x', false]],
	['x</script><script>'],
	['a</style>b</STYLE>'],
	['a{b:c}'],
	[e('span', null, 'in')],
	[e('i', null), 'tail'],
	['head', e('b', null, 'b')],
	[e('option', { value: 'a' }, 'A')],
	[e('option', { value: 'a' }, 'A'), e('option', { value: 'b', selected: true }, 'B')],
	[{ toString: () => 'x' }],
];

describe.each(TAGS)('differential: <%s> props x children', (tag) => {
	test('matches React', () => {
		const mismatches: string[] = [];
		let count = 0;
		for (const props of PROP_SETS) {
			for (const children of CHILDREN) {
				if (skipCase(tag, props, children)) {
					continue;
				}
				count++;
				const tree = e(tag, props, ...children);
				const expected = react(tree);
				const actual = ours(tree);
				try {
					expect(actual).toEqual(expected);
				} catch {
					mismatches.push(
						`${tag} ${safeJson(props)} children=${safeJson(children)}\n  react: ${safeJson(expected)}\n  ours:  ${safeJson(actual)}`,
					);
				}
			}
		}
		expect(count).toBeGreaterThan(2000);
		expect(mismatches.slice(0, 5).join('\n')).toBe('');
	});
});

/**
 * Combinations that are not comparable with React:
 *
 * - `title` / `textarea` / `style` with an element child: React writes `[object Object]`,
 * the runtime takes a `Markup` child as already-escaped HTML (documented deviation).
 * - A hoisted stylesheet with children: React fails while flushing and leaves its
 * module-level flush queue dirty, which corrupts every later render in the process.
 * @param tag - The tag
 * @param props - The props
 * @param children - The children
 * @returns Whether to skip the combination
 */
function skipCase(tag: string, props: Props, children: unknown[]): boolean {
	if (
		(tag === 'title' || tag === 'textarea' || tag === 'style') &&
		children.some((child) => child instanceof E)
	) {
		return true;
	}
	return (
		tag === 'link' &&
		props.rel === 'stylesheet' &&
		'precedence' in props &&
		children.length > 0
	);
}

/**
 * @param value - Anything
 * @returns A compact one-line description
 */
function safeJson(value: unknown): string {
	return JSON.stringify(value, (_key, v) => {
		if (typeof v === 'function') {
			return '[fn]';
		}
		if (typeof v === 'symbol') {
			return '[symbol]';
		}
		if (typeof v === 'number' && !Number.isFinite(v)) {
			return String(v);
		}
		if (v instanceof E) {
			return `<${String(v.type)}>`;
		}
		return v;
	});
}

// ---------------------------------------------------------------------------
// Differential: form controls with context (select / option / textarea / input)
// ---------------------------------------------------------------------------

describe('differential: form controls', () => {
	const options = [
		e('option', { value: 'a' }, 'A'),
		e('option', { value: 'b' }, 'B'),
		e('option', null, 'C'),
		e('option', null, 'D', 'E'),
		e('option', { value: 1 }, 1),
		e('option', { selected: true }, 'S'),
	];
	const values: unknown[] = [
		'a',
		'b',
		'C',
		'DE',
		1,
		'1',
		['a', 'C'],
		[],
		[1],
		'zzz',
		null,
		undefined,
	];

	test.each(values.map((v) => [safeJson(v), v] as const))(
		'select value=%s selects the matching option',
		(_name, value) => {
			expectSame(e('select', { value }, ...options));
			expectSame(e('select', { defaultValue: value }, ...options));
			expectSame(e('select', { value: undefined, defaultValue: value }, ...options));
			expectSame(e('select', { value, multiple: true, name: 'n' }, ...options));
		},
	);

	test('options in optgroups and nested components see the select', () => {
		const Group = (): unknown =>
			e('optgroup', { label: 'g' }, e('option', null, 'a'), e('option', null, 'b'));
		expectSame(e('select', { value: 'b' }, e(Group, null), e('option', null, 'b')));
		expectSame(e('div', null, e('select', { value: 'x' }, e('option', null, 'x'))));
		expectSame(e('select', { value: 'x' }, e('option', null, 'x')));
	});

	test('option outside a select ignores nothing but its own selected prop', () => {
		expectSame(e('option', { selected: true }, 'x'));
		expectSame(e('option', { value: 'a', selected: false }, 'x'));
	});

	test('textarea value, defaultValue and children', () => {
		for (const props of [
			{},
			{ value: 'v' },
			{ defaultValue: 'd' },
			{ value: '\nv' },
			{ defaultValue: '<&>' },
			{ value: 0 },
			{ value: false },
			{ value: 'v', defaultValue: 'd' },
			{ name: 'n', rows: 3, placeholder: 'p', disabled: true },
		]) {
			expectSame(e('textarea', props));
			expectSame(e('textarea', props, 'child'));
			expectSame(e('textarea', props, '\nchild'));
			expectSame(e('textarea', props, 'a', 'b'));
			expectSame(e('textarea', props, ['a']));
			expectSame(e('textarea', props, 1));
		}
	});

	test('input value / defaultValue / checked / defaultChecked ordering', () => {
		for (const props of [
			{ type: 'text', value: 'v', name: 'n', id: 'i' },
			{ name: 'n', type: 'text', defaultValue: 'd', id: 'i' },
			{ value: 'v', defaultValue: 'd' },
			{ type: 'checkbox', checked: true, defaultChecked: false },
			{ type: 'checkbox', checked: false, defaultChecked: true },
			{ type: 'checkbox', defaultChecked: true, className: 'c' },
			{
				type: 'text',
				formAction: '/x',
				formMethod: 'post',
				formEncType: 'e',
				formTarget: 't',
			},
			{ type: 'text', value: '', onChange: noop },
			{ type: 'number', value: 0, min: 0, max: 5, step: 0.5 },
			{ type: 'text', value: 'v', readOnly: true },
		]) {
			expectSame(e('input', props));
			expectSame(e('input', props, 'child'));
		}
	});

	test('button / form attribute ordering', () => {
		expectSame(
			e('button', { name: 'n', className: 'c', type: 'submit', formAction: '/a' }, 'go'),
		);
		expectSame(
			e('button', { formTarget: 't', formMethod: 'm', formEncType: 'e', id: 'i' }),
		);
		expectSame(
			e(
				'form',
				{ action: '/a', className: 'c', method: 'post', target: 't', encType: 'e' },
				'x',
			),
		);
		expectSame(e('form', { method: 'get', id: 'f' }, e('input', { name: 'q' })));
	});

	test('pre / listing leading newline rule', () => {
		for (const tag of ['pre', 'listing']) {
			expectSame(e(tag, null, '\nx'));
			expectSame(e(tag, null, '\n'));
			expectSame(e(tag, null, ['\nx']));
			expectSame(e(tag, null, 'a', '\nx'));
			expectSame(e(tag, null, e('b', null, '\nx')));
			expectSame(e(tag, { dangerouslySetInnerHTML: { __html: '\n<b>' } }));
			expectSame(e(tag, { dangerouslySetInnerHTML: { __html: '<b>' } }));
		}
	});
});

// ---------------------------------------------------------------------------
// Differential: documents
// ---------------------------------------------------------------------------

const link = (props: Props): E => e('link', props);
const meta = (props: Props): E => e('meta', props);

describe('differential: documents', () => {
	const lead = e(
		'html',
		{ lang: 'ja' },
		e(
			'head',
			null,
			link({ rel: 'stylesheet', href: '/a.css' }),
			meta({ name: 'description', content: 'd' }),
			e('title', null, 'T'),
			meta({ charSet: 'utf8' }),
			e('script', { src: '/x.js', async: true }),
			link({ rel: 'icon', href: '/f.ico' }),
			meta({ name: 'viewport', content: 'width=device-width' }),
			e('style', null, 'a{b:c}'),
		),
		e('body', null, e('p', null, 'x'), e('title', null, 'in body'), meta({ name: 'a' })),
	);

	test("the lead's example matches React and the expected string", () => {
		expect(ours(lead)).toEqual({
			html: '<html lang="ja"><head><meta charSet="utf8"/><meta name="viewport" content="width=device-width"/><script src="/x.js" async=""></script><meta name="description" content="d"/><title>T</title><link rel="icon" href="/f.ico"/><title>in body</title><meta name="a"/><link rel="stylesheet" href="/a.css"/><style>a{b:c}</style></head><body><p>x</p></body></html>',
		});
		expectSame(lead);
	});

	test('a root div: title and meta come first, a stylesheet without precedence stays in place', () => {
		const tree = e(
			'div',
			null,
			e('title', null, 'T'),
			meta({ name: 'a', content: 'b' }),
			e('div', null, link({ rel: 'stylesheet', href: '/a.css' })),
		);
		expect(ours(tree)).toEqual({
			html: '<title>T</title><meta name="a" content="b"/><div><div><link rel="stylesheet" href="/a.css"/></div></div>',
		});
		expectSame(tree);
	});

	test('fragments and arrays at the root', () => {
		expectSame(
			e(FRAGMENT, null, e('title', null, 'a'), e('p', null, 'b'), e('title', null, 'c')),
		);
		expectSame([e('p', null, 'x'), e('meta', { name: 'a' })]);
		expectSame('just text');
		expectSame(null);
	});

	test('documents without head, without body, and body only', () => {
		expectSame(e('html', null, e('body', null, 'x')));
		expectSame(e('html', null, e('head', null, e('title', null, 't'))));
		expectSame(e('html', { lang: 'en' }, 'only text'));
		expectSame(e('html', null));
		expectSame(e('body', { className: 'b' }, e('p', null, 'x'), e('title', null, 't')));
		expectSame(e('head', null, e('title', null, 't'), e('base', { href: '/' })));
		expectSame(e('html', { dangerouslySetInnerHTML: { __html: '<head></head>' } }));
		expectSame(e('html', null, e('head', { id: 'h' }), e('body', { id: 'b' })));
		expectSame(
			e(
				'html',
				null,
				e('head', { dangerouslySetInnerHTML: { __html: '<meta name="x">' } }),
				e('body', { dangerouslySetInnerHTML: { __html: '<i>x</i>' } }),
			),
		);
	});

	test('head and body may only be rendered once', () => {
		expectSame(e('html', null, e('head', null), e('head', null), e('body', null)));
		expectSame(e('html', null, e('head', null), e('body', null), e('body', null)));
		expectSame([e('html', null), e('html', null)]);
	});

	test('title forms', () => {
		for (const children of [
			['T'],
			['a', 'b'],
			[['a', 'b']],
			[['a']],
			[1],
			[0],
			[''],
			[null],
			[true],
			['<&>'],
		]) {
			expectSame(
				e('html', null, e('head', null, e('title', null, ...children)), e('body', null)),
			);
			expectSame(e('div', null, e('title', null, ...children)));
		}
		expectSame(e('div', null, e('title', { id: 'x', lang: 'ja' }, 'T')));
		expectSame(e('svg', null, e('title', null, 'svg title')));
		expectSame(e('div', null, e('title', { itemProp: 'name' }, 'T')));
		expectSame(e('noscript', null, e('title', null, 'T')));
	});

	test('multiple titles keep encounter order across nested components', () => {
		const Inner = (): unknown => e('title', null, 'inner');
		const Layout = (props: Props): unknown =>
			e(
				'html',
				null,
				e('head', null, e('title', null, 'layout'), e(Inner, null)),
				e('body', null, props.children),
			);
		expectSame(e(Layout, null, e('title', null, 'page'), e('p', null, 'x')));
	});

	test('a layout rendering its own hoistables before its children (evaluation order)', () => {
		const Layout = (props: Props): unknown =>
			e(
				'html',
				null,
				e('head', null, e('title', null, 'layout'), meta({ name: 'layout' })),
				e('body', null, e('header', null, e('title', null, 'header')), props.children),
			);
		expectSame(
			e(
				Layout,
				null,
				e('title', null, 'page'),
				meta({ name: 'page' }),
				e('main', null, 'x'),
			),
		);
	});

	test('children a component never renders are never hoisted', () => {
		const Ignore = (): unknown => e('p', null, 'x');
		expectSame(
			e(Ignore, null, e('title', null, 'dropped'), link({ rel: 'icon', href: '/d.ico' })),
		);
		expectSame(
			e(
				'div',
				null,
				e(Ignore, null, e('script', { async: true, src: '/dropped.js' })),
				e('i', null),
			),
		);
	});

	test('the same element used twice', () => {
		const Twice = (props: Props): unknown => [props.children, props.children];
		expectSame(e(Twice, null, e('title', null, 'x')));
		expectSame(
			e(Twice, null, link({ rel: 'stylesheet', href: '/a.css', precedence: 'p' })),
		);
	});

	test('stylesheets with precedence: grouping, order and de-duplication', () => {
		const sheet = (href: string, precedence: string, extra: Props = {}): E =>
			link({ rel: 'stylesheet', href, precedence, ...extra });
		expectSame(
			e(
				'html',
				null,
				e(
					'head',
					null,
					sheet('/a.css', 'low'),
					sheet('/b.css', 'high'),
					sheet('/c.css', 'low'),
				),
				e(
					'body',
					null,
					sheet('/a.css', 'low'),
					sheet('/d.css', 'high', { media: 'print' }),
					'x',
				),
			),
		);
		expectSame(
			e(
				'div',
				null,
				sheet('/a.css', 'p'),
				link({ rel: 'stylesheet', href: '/plain.css' }),
			),
		);
		expectSame(
			e(
				'div',
				null,
				link({ rel: 'stylesheet', href: '/plain.css' }),
				link({ rel: 'stylesheet', href: '/plain.css' }),
			),
		);
		expectSame(e('div', null, sheet('/a.css', 'p', { 'data-x': 'y', precedence: 'p' })));
		expectSame(
			e('div', null, sheet('/a.css', 'p', { crossOrigin: 'anonymous', integrity: 'i' })),
		);
		expectSame(e('div', null, sheet('/a.css', 'a&b')));
	});

	test('styles with precedence and href', () => {
		const style = (
			href: string,
			precedence: string,
			css: unknown,
			extra: Props = {},
		): E => e('style', { href, precedence, ...extra }, css);
		expectSame(
			e(
				'div',
				null,
				style('a', 'p', 'a{b:c}'),
				style('b', 'p', 'b{c:d}'),
				style('a', 'p', 'dup'),
			),
		);
		expectSame(
			e(
				'div',
				null,
				link({ rel: 'stylesheet', href: 'a', precedence: 'p' }),
				style('a', 'p', 'a{}'),
				style('b', 'p', 'b{}'),
				link({ rel: 'stylesheet', href: 'c', precedence: 'q' }),
				style('d', 'q', '</style>x'),
			),
		);
		expectSame(e('div', null, style('a', 'p', ['a{}']), style('b', 'p', ['a', 'b'])));
		expectSame(
			e(
				'div',
				null,
				e('style', {
					href: 'a',
					precedence: 'p',
					dangerouslySetInnerHTML: { __html: 'x{}' },
				}),
			),
		);
		expectSame(e('div', null, e('style', { href: '', precedence: 'p' }, 'a{}')));
		expectSame(e('div', null, e('style', { precedence: 'p' }, 'a{}')));
		expectSame(e('div', null, e('style', { media: 'print', nonce: 'n' }, 'a{}')));
		expectSame(e('div', null, e('style', { href: 'a&b', precedence: 'x"y' }, 'a{}')));
	});

	test('async scripts: hoisting, ordering and de-duplication', () => {
		const script = (src: string, extra: Props = {}): E =>
			e('script', { src, async: true, ...extra });
		expectSame(
			e(
				'html',
				null,
				e(
					'head',
					null,
					script('/a.js'),
					e('script', { src: '/sync.js' }),
					e('script', null, 'var a=1;'),
				),
				e(
					'body',
					null,
					script('/b.js'),
					script('/a.js'),
					script('/m.js', { type: 'module' }),
					script('/a.js', { type: 'module' }),
				),
			),
		);
		expectSame(e('div', null, script('/a.js', { onLoad: noop })));
		expectSame(e('div', null, script('/a.js', { itemProp: 'x' })));
		expectSame(e('div', null, e('script', { src: '', async: true })));
		expectSame(e('div', null, e('script', { async: true }, 'inline')));
		expectSame(
			e('div', null, e('script', { dangerouslySetInnerHTML: { __html: 'a</script>' } })),
		);
		expectSame(e('div', null, e('script', null, 'a</script><SCRIPT>b</Script>')));
		expectSame(e('div', null, e('script', null, 1)));
		expectSame(e('div', null, e('script', null, ['a', 'b'])));
		expectSame(e('svg', null, script('/a.js')));
		expectSame(e('noscript', null, script('/a.js')));
	});

	test('link rel variants (preload, preconnect, dns-prefetch, icon, ...)', () => {
		for (const props of [
			{
				rel: 'preload',
				href: '/a.woff2',
				as: 'font',
				type: 'font/woff2',
				crossOrigin: 'anonymous',
			},
			{ rel: 'preload', href: '/a.png', as: 'image' },
			{ rel: 'preload', href: '/a.js', as: 'script' },
			{ rel: 'preconnect', href: 'https://a.example' },
			{ rel: 'dns-prefetch', href: 'https://b.example' },
			{ rel: 'modulepreload', href: '/m.js' },
			{ rel: 'icon', href: '/f.ico' },
			{ rel: 'canonical', href: 'https://example.com/' },
			{ rel: 'alternate', hrefLang: 'en', href: '/en' },
			{ rel: 'manifest', href: '/m.json' },
			{ rel: 'stylesheet', href: '/a.css', onError: noop },
			{ rel: 'stylesheet', href: '' },
			{ rel: 'stylesheet' },
			{ href: '/x' },
			{ rel: 'x' },
			{ rel: ['a'], href: '/x' },
			{ rel: 'icon', href: '/x', itemProp: 'p' },
			{ rel: 'icon', href: '/x', onLoad: noop },
			{ rel: 'icon', href: 'javascript:1' },
		]) {
			expectSame(
				e('html', null, e('head', null, link(props)), e('body', null, link(props))),
			);
			expectSame(e('div', null, link(props), 'x'));
			expectSame(e('svg', null, link(props)));
			expectSame(e('noscript', null, link(props)));
		}
	});

	test('meta categories: charset, viewport and others', () => {
		for (const props of [
			{ charSet: 'utf8' },
			{ charSet: 'utf8', name: 'viewport' },
			{ name: 'viewport', content: 'w' },
			{ name: 'viewport' },
			{ httpEquiv: 'x-ua', content: 'y' },
			{ property: 'og:title', content: 'T' },
			{ itemProp: 'a', content: 'b' },
			{ charSet: 1 },
			{},
		]) {
			expectSame(
				e(
					'html',
					null,
					e('head', null, meta(props), meta({ name: 'z' }), meta(props)),
					e('body', null, meta(props)),
				),
			);
			expectSame(e('svg', null, meta(props)));
			expectSame(e('noscript', null, meta(props)));
		}
	});

	test('images preload into the head', () => {
		const img = (props: Props, ...children: unknown[]): E => e('img', props, ...children);
		expectSame(e('div', null, img({ src: '/a.png', alt: 'a' })));
		expectSame(
			e(
				'html',
				null,
				e('head', null),
				e('body', null, img({ src: '/a.png' }), img({ src: '/a.png' })),
			),
		);
		expectSame(
			e(
				'div',
				null,
				img({ src: '/a.png', srcSet: '/a.png 1x, /b.png 2x', sizes: '50vw' }),
			),
		);
		expectSame(e('div', null, img({ srcSet: '/a.png 1x' })));
		expectSame(
			e(
				'div',
				null,
				img({ srcSet: '/a.png 1x', sizes: '1px' }),
				img({ srcSet: '/a.png 1x', sizes: '2px' }),
			),
		);
		expectSame(e('div', null, img({ src: '/a.png', crossOrigin: 'use-credentials' })));
		expectSame(
			e(
				'div',
				null,
				img({
					src: '/a.png',
					crossOrigin: 'anonymous',
					integrity: 'i',
					type: 'image/png',
					referrerPolicy: 'x',
				}),
			),
		);
		expectSame(e('div', null, img({ src: '/a.png', fetchPriority: 'high' })));
		expectSame(e('div', null, img({ src: '/a.png', fetchPriority: 'low' })));
		expectSame(e('div', null, img({ src: '/a.png', loading: 'lazy' })));
		expectSame(e('div', null, img({ src: 'data:image/png;base64,AA==' })));
		expectSame(e('div', null, img({ src: 'DATA:image/png;base64,AA==' })));
		expectSame(e('div', null, img({ srcSet: 'data:image/png;base64,AA== 1x' })));
		expectSame(e('div', null, img({ alt: 'none' })));
		expectSame(e('div', null, img({ src: '' })));
		expectSame(e('div', null, img({ src: 3 })));
		expectSame(e('div', null, img({ src: '/a.png' }, 'children')));
		expectSame(e('picture', null, img({ src: '/a.png' })));
		expectSame(e('noscript', null, img({ src: '/a.png' })));
		expectSame(e('svg', null, img({ src: '/a.png' })));
		expectSame(
			e(
				'div',
				null,
				e('picture', null, e('source', { srcSet: '/a.webp' }), img({ src: '/a.png' })),
				img({ src: '/b.png' }),
			),
		);
	});

	test('more than ten images: high priority first, the rest after the scripts', () => {
		const images = Array.from({ length: 14 }, (_, i) =>
			e('img', { src: `/${i}.png`, alt: String(i) }),
		);
		const high = e('img', { src: '/high.png', fetchPriority: 'high' });
		const tree = (rest: unknown[]): E =>
			e(
				'html',
				null,
				e('head', null, e('script', { src: '/s.js', async: true })),
				e('body', null, ...rest, link({ rel: 'icon', href: '/i' })),
			);
		expectSame(tree(images));
		expectSame(tree([...images, high]));
		expectSame(
			tree([
				...images,
				e('img', { src: '/3.png' }),
				e('img', { src: '/12.png', fetchPriority: 'high' }),
			]),
		);
		expectSame(
			tree([
				...images.slice(0, 10),
				e('img', { src: '/10.png' }),
				e('img', { src: '/10.png', fetchPriority: 'high' }),
			]),
		);
	});

	test('a document with everything, in a nested component tree', () => {
		const Seo = (props: Props): unknown => [
			e('title', null, props.title),
			meta({ name: 'description', content: props.description }),
			link({ rel: 'canonical', href: props.url }),
		];
		const Head = (props: Props): unknown =>
			e(
				'head',
				null,
				meta({ charSet: 'utf8' }),
				e(Seo, { title: 'T & U', description: 'd "q"', url: '/x' }),
				link({ rel: 'stylesheet', href: '/site.css', precedence: 'default' }),
				e('script', { src: '/analytics.js', async: true }),
				props.children,
			);
		const Page = (): unknown =>
			e(
				'html',
				{ lang: 'ja', className: 'no-js' },
				e(
					Head,
					null,
					link({ rel: 'preload', href: '/f.woff2', as: 'font' }),
					e('style', null, 'body{margin:0}'),
				),
				e(
					'body',
					{ className: 'page' },
					e(
						'main',
						null,
						e('h1', null, 'Hello'),
						e('img', { src: '/hero.jpg', alt: '' }),
						e('script', { src: '/b.js', async: true }),
					),
					e(
						'footer',
						null,
						e('title', null, 'footer title'),
						link({ rel: 'stylesheet', href: '/footer.css', precedence: 'default' }),
					),
				),
			);
		expectSame(e(Page, null));
	});

	test('components returning arrays, strings, numbers, null and nested fragments', () => {
		const Arr = (): unknown => ['a', 1, null, e('i', null)];
		const Str = (): unknown => '<s>';
		const Num = (): unknown => 0;
		const Nil = (): unknown => null;
		const Bool = (): unknown => true;
		const Frag = (): unknown =>
			e(FRAGMENT, null, 'x', e(FRAGMENT, null, 'y', e('b', null)));
		expectSame(
			e(
				'div',
				null,
				e(Arr, null),
				e(Str, null),
				e(Num, null),
				e(Nil, null),
				e(Bool, null),
				e(Frag, null),
			),
		);
		expectSame(e(Arr, null));
		expectSame(e(Str, null));
		expectSame(e(Nil, null));
	});

	test('errors match React (message equality)', () => {
		const Throws = (): unknown => {
			throw new Error('boom');
		};
		expectSame(e('div', null, e(Throws, null)));
		expectSame(e('div', null, { a: 1, b: 2 }));
		expectSame(e('div', null, new Date(0)));
		expectSame(e('br', null, 'x'));
		expectSame(e('div', { style: 'color:red' }));
		expectSame(e('div', { style: 5 }));
		expectSame(e('my-element', { style: 'x' }));
		expectSame(e('div', { dangerouslySetInnerHTML: { __html: 'x' } }, 'child'));
		expectSame(e('textarea', { dangerouslySetInnerHTML: { __html: 'x' } }));
		expectSame(e('textarea', { value: 'v' }, 'child'));
		expectSame(e('input', null, 'child'));
		expectSame(e('meta', { name: 'x' }, 'child'));
		expectSame(e('link', { rel: 'icon', href: '/x' }, 'child'));
		expectSame(e('menuitem', null, 'child'));
		expectSame(e('menuitem', { label: 'l' }));
		expectSame(e('bad tag', null));
		expectSame(e('1tag', null));
	});

	test('custom elements pass attributes through', () => {
		for (const props of [
			{ className: 'a', htmlFor: 'b', tabIndex: 1 },
			{
				foo: true,
				bar: false,
				baz: 1,
				qux: 'x',
				obj: { a: 1 },
				fn: noop,
				sym: Symbol('s'),
			},
			{ style: { color: 'red', fontSize: 2 } },
			{ onClick: noop, onclick: 'x', hidden: true, disabled: '' },
			{ 'aria-hidden': true, 'data-x': false },
			{ ref: noop, suppressHydrationWarning: true },
			{ dangerouslySetInnerHTML: { __html: '<b>x</b>' } },
			{ 'bad name': 'x', '1x': 'y' },
			{ strokeWidth: 3, xlinkHref: '#a' },
		]) {
			expectSame(e('x-widget', props));
			expectSame(e('x-widget', props, 'child', e('b', null)));
		}
		expectSame(e('font-face', { fontFamily: 'x' }));
		expectSame(e('annotation-xml', { encoding: 'x' }, 'c'));
	});

	test('html entities and escaping in text and attributes', () => {
		const nasty = '&<>"\' &amp; \u0000   日本語 😀';
		expectSame(e('div', { title: nasty, 'data-x': nasty, href: nasty }, nasty, [nasty]));
		expectSame(e('a', { href: nasty }, nasty));
		expectSame(e('div', { style: { content: nasty, '--v': nasty } }));
		expectSame(e('option', { value: nasty }, nasty));
		expectSame(e('textarea', null, nasty));
		expectSame(e('script', null, nasty));
		expectSame(e('style', null, nasty));
		expectSame(e('title', null, nasty));
	});
});

// ---------------------------------------------------------------------------
// Unit tests: c / a / m / Markup
// ---------------------------------------------------------------------------

describe('m / Markup', () => {
	test('wraps without copying and stringifies to its html', () => {
		const markup = m('<b>x</b>');
		expect(markup).toBeInstanceOf(Markup);
		expect(markup.html).toBe('<b>x</b>');
		expect(`${markup}`).toBe('<b>x</b>');
		expect(c(markup)).toBe('<b>x</b>');
	});
});

describe('c', () => {
	test('escapes strings exactly like React', () => {
		expect(c('a&b<c>d"e\'f')).toBe('a&amp;b&lt;c&gt;d&quot;e&#x27;f');
		expect(c('')).toBe('');
		expect(c('plain')).toBe('plain');
	});

	test('numbers and bigints are text', () => {
		expect(c(0)).toBe('0');
		expect(c(-0)).toBe('0');
		expect(c(Number.NaN)).toBe('NaN');
		expect(c(1.5)).toBe('1.5');
		expect(c(10n)).toBe('10');
	});

	test('null, undefined, booleans, functions and symbols render nothing', () => {
		for (const value of [null, undefined, true, false, noop, Symbol('x')]) {
			expect(c(value)).toBe('');
		}
	});

	test('arrays, nested arrays and iterables concatenate', () => {
		expect(c(['a', ['b', [1, null, m('<i/>')]], false])).toBe('ab1<i/>');
		expect(c(new Set(['<', '>']))).toBe('&lt;&gt;');
		expect(
			c(
				(function* () {
					yield 'x';
					yield 2;
				})(),
			),
		).toBe('x2');
		expect(c([, 'a'])).toBe('a'); // eslint-disable-line no-sparse-arrays
	});

	test('plain objects throw like React', () => {
		expect(() => c({ a: 1, b: 2 })).toThrow(
			new TypeError(
				'Objects are not valid as a React child (found: object with keys {a, b}). If you meant to render a collection of children, use an array instead.',
			),
		);
		expect(() => c(new Date(0))).toThrow(/found: \[object Date\]/);
		expect(() => c([{}])).toThrow(TypeError);
	});
});

describe('a', () => {
	test.each([
		['className', 'x y', ' class="x y"'],
		['htmlFor', 'x', ' for="x"'],
		['tabIndex', 0, ' tabindex="0"'],
		['strokeWidth', 2, ' stroke-width="2"'],
		['xlinkHref', '#a', ' xlink:href="#a"'],
		['xmlLang', 'en', ' xml:lang="en"'],
		['crossOrigin', 'anonymous', ' crossorigin="anonymous"'],
		['httpEquiv', 'refresh', ' http-equiv="refresh"'],
		['acceptCharset', 'u', ' accept-charset="u"'],
		['data-x', 'a"b', ' data-x="a&quot;b"'],
		['data-x', true, ' data-x="true"'],
		['data-x', false, ' data-x="false"'],
		['aria-hidden', true, ' aria-hidden="true"'],
		['DATA-x', true, ' DATA-x="true"'],
		['disabled', true, ' disabled=""'],
		['disabled', false, ''],
		['disabled', 'false', ' disabled=""'],
		['disabled', 0, ''],
		['autoFocus', true, ' autofocus=""'],
		['allowFullScreen', true, ' allowFullScreen=""'],
		['download', true, ' download=""'],
		['download', false, ''],
		['download', 'x.txt', ' download="x.txt"'],
		['rows', 0, ''],
		['rows', 2, ' rows="2"'],
		['rows', 'x', ''],
		['start', 0, ' start="0"'],
		['start', Number.NaN, ''],
		['contentEditable', true, ' contentEditable="true"'],
		['spellCheck', false, ' spellCheck="false"'],
		['value', true, ' value="true"'],
		['value', 0, ' value="0"'],
		['id', 'x', ' id="x"'],
		['id', 0, ' id="0"'],
		['id', Number.NaN, ' id="NaN"'],
		['id', true, ''],
		['id', false, ''],
		['id', null, ''],
		['id', undefined, ''],
		['id', noop, ''],
		['id', Symbol('s'), ''],
		['id', { toString: () => 'obj' }, ' id="obj"'],
		['href', '', ''],
		['src', '', ''],
		['action', '', ' action=""'],
		['href', '/a&b', ' href="/a&amp;b"'],
		[
			'href',
			'javascript:alert(1)',
			` href="javascript:throw new Error(&#x27;React has blocked a javascript: URL as a security precaution.&#x27;)"`,
		],
		[
			'src',
			' java\tscript:1',
			` src="javascript:throw new Error(&#x27;React has blocked a javascript: URL as a security precaution.&#x27;)"`,
		],
		['href', true, ''],
		['onClick', noop, ''],
		['onClick', 'x', ''],
		['onClick', 1, ''],
		['onload', 'x', ''],
		['on', 'x', ' on="x"'],
		['one', 'x', ''],
		['key', 'x', ''],
		['ref', noop, ''],
		['children', 'x', ''],
		['dangerouslySetInnerHTML', { __html: 'x' }, ''],
		['defaultValue', 'x', ''],
		['defaultChecked', true, ''],
		['suppressHydrationWarning', true, ''],
		['bad name', 'x', ''],
		['1x', 'x', ''],
		['style', { color: 'red' }, ' style="color:red"'],
		['style', {}, ''],
		['foo', 'bar', ' foo="bar"'],
	])('a(%j, %j) = %j', (prop, value, expected) => {
		expect(a(prop, value)).toBe(expected);
	});

	test('style objects: hyphenation, ms prefix, custom properties, units', () => {
		expect(
			a('style', {
				backgroundColor: 'red',
				msTransform: 'x',
				MozAppearance: 'none',
				WebkitLineClamp: 2,
				'--Custom': ' 1px ',
				width: 10,
				height: 0,
				flexGrow: 1,
				lineHeight: 1.5,
				opacity: 0,
				zIndex: 5,
				fontWeight: 700,
				content: '"a"',
				skipNull: null,
				skipUndefined: undefined,
				skipBool: true,
				skipEmpty: '',
			}),
		).toBe(
			' style="background-color:red;-ms-transform:x;-moz-appearance:none;-webkit-line-clamp:2;--Custom:1px;width:10px;height:0;flex-grow:1;line-height:1.5;opacity:0;z-index:5;font-weight:700;content:&quot;a&quot;"',
		);
	});

	test('a string style throws like React', () => {
		expect(() => a('style', 'color:red')).toThrow(/The `style` prop expects a mapping/);
	});

	test('every generated table entry behaves like React for every value type', () => {
		const values: unknown[] = [
			'x',
			'',
			0,
			1,
			2,
			-1,
			Number.NaN,
			true,
			false,
			noop,
			Symbol('s'),
			{},
			[],
			'3',
		];
		const mismatches: string[] = [];
		for (const prop of tableProps()) {
			for (const value of values) {
				const expected = react(e('div', { [prop]: value }));
				const actual = outcome(() => `<div${a(prop, value)}></div>`);
				if (JSON.stringify(actual) !== JSON.stringify(expected)) {
					mismatches.push(
						`${prop}=${safeJson(value)}: ${safeJson(expected)} vs ${safeJson(actual)}`,
					);
				}
			}
		}
		expect(mismatches.slice(0, 5)).toEqual([]);
	});
});

/**
 * @returns Every prop name in the generated table plus a few default-path names
 */
function tableProps(): string[] {
	const names = new Set<string>([
		'id',
		'title',
		'lang',
		'foo',
		'data-a',
		'aria-b',
		'onFoo',
	]);
	for (const [prop] of GENERATED_PROPS) {
		if (prop !== 'style' && prop !== 'ref' && prop !== 'innerHTML') {
			names.add(prop);
		}
	}
	return [...names];
}

// ---------------------------------------------------------------------------
// Unit tests: el / k / render
// ---------------------------------------------------------------------------

describe('el', () => {
	test('void elements are self-closing, others have an end tag', () => {
		expect(el('br', null).html).toBe('<br/>');
		expect(el('img', { src: '/a.png', alt: '' }).html).toBe('<img src="/a.png" alt=""/>');
		expect(el('div', null).html).toBe('<div></div>');
		expect(el('div', null, 'x').html).toBe('<div>x</div>');
	});

	test('children: omitted uses props.children, explicit undefined overrides it', () => {
		expect(el('div', { children: 'from props' }).html).toBe('<div>from props</div>');
		expect(el('div', { children: 'from props' }, 'explicit').html).toBe(
			'<div>explicit</div>',
		);
		const undefinedChild: unknown = undefined;
		expect(el('div', { children: 'from props' }, undefinedChild).html).toBe(
			'<div></div>',
		);
		expect(el('div', { children: 'from props' }, null).html).toBe('<div></div>');
	});

	test('children are escaped, Markup children are not', () => {
		expect(el('p', null, ['<', m('<b>x</b>'), 1]).html).toBe('<p>&lt;<b>x</b>1</p>');
	});

	test('dangerouslySetInnerHTML is inserted raw and conflicts with children', () => {
		expect(el('div', { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }).html).toBe(
			'<div><b>x</b></div>',
		);
		expect(() => el('div', { dangerouslySetInnerHTML: { __html: 'x' } }, 'c')).toThrow(
			'Can only set one of `children` or `props.dangerouslySetInnerHTML`.',
		);
		expect(() => el('div', { dangerouslySetInnerHTML: 'x' })).toThrow(
			/must be in the form `\{__html: ...\}`/,
		);
	});

	test('validates tag names', () => {
		expect(() => el('a b', null)).toThrow('Invalid tag: a b');
		expect(el('x-y_z.w:v', null).html).toBe('<x-y_z.w:v></x-y_z.w:v>');
	});

	test('null props and null children are fine', () => {
		expect(el('div', null, null).html).toBe('<div></div>');
	});

	test('a thunk is called with the parent context: select values reach options', () => {
		const html = el('select', { value: 'b' }, () => [
			el('option', { value: 'a' }, 'A'),
			el('option', { value: 'b' }, 'B'),
		]).html;
		expect(html).toBe(
			'<select><option value="a">A</option><option value="b" selected="">B</option></select>',
		);
	});

	test('the select context does not leak past its thunk', () => {
		el('select', { value: 'b' }, () => el('option', { value: 'b' }, 'B'));
		expect(el('option', { value: 'b' }, 'B').html).toBe('<option value="b">B</option>');
	});

	test('the select context is restored when the thunk throws', () => {
		expect(() =>
			el('select', { value: 'b' }, () => {
				throw new Error('x');
			}),
		).toThrow('x');
		expect(el('option', { value: 'b' }, 'B').html).toBe('<option value="b">B</option>');
	});

	test('option text selects by children when it has no value', () => {
		expect(
			el('select', { defaultValue: ['x', 'y'], multiple: true }, () => [
				el('option', null, 'x'),
				el('option', null, ['y', 1]),
				el('option', null, 'z'),
			]).html,
		).toBe(
			'<select multiple=""><option selected="">x</option><option>y1</option><option>z</option></select>',
		);
	});

	test('svg / noscript / picture thunks keep hoistable tags and image preloads in place', () => {
		const html = render(
			() => [
				el('svg', null, () => el('title', null, 'in svg')),
				el('noscript', null, () => el('link', { rel: 'icon', href: '/n.ico' })),
				el('div', null, 'x'),
			],
			{},
		);
		expect(html).toBe(
			'<svg><title>in svg</title></svg><noscript><link rel="icon" href="/n.ico"/></noscript><div>x</div>',
		);
	});

	test('foreignObject leaves the svg scope', () => {
		const html = render(
			() =>
				el('svg', null, () =>
					el('foreignObject', null, () => el('title', null, 'html title')),
				),
			{},
		);
		expect(html).toBe(
			'<title>html title</title><svg><foreignObject></foreignObject></svg>',
		);
	});

	test('outside render, hoistable elements render in place', () => {
		expect(el('title', null, 'T').html).toBe('<title>T</title>');
		expect(el('meta', { charSet: 'utf8' }).html).toBe('<meta charSet="utf8"/>');
		expect(el('link', { rel: 'stylesheet', href: '/a.css', precedence: 'p' }).html).toBe(
			'<link rel="stylesheet" href="/a.css" precedence="p"/>',
		);
		expect(el('script', { src: '/a.js', async: true }).html).toBe(
			'<script src="/a.js" async=""></script>',
		);
		expect(el('style', { href: 'a', precedence: 'p' }, 'a{}').html).toBe(
			'<style href="a" precedence="p">a{}</style>',
		);
		expect(el('img', { src: '/a.png' }).html).toBe('<img src="/a.png"/>');
		expect(
			el('html', { lang: 'en' }, el('head', null, el('title', null, 't'))).html,
		).toBe('<html lang="en"><head><title>t</title></head></html>');
		expect(el('body', null, 'x').html).toBe('<body>x</body>');
	});

	test('props are read in insertion order and key / ref / children are not attributes', () => {
		expect(
			el('div', { id: 'a', key: 'k', ref: noop, className: 'c', children: 'x' }).html,
		).toBe('<div id="a" class="c">x</div>');
	});
});

describe('k', () => {
	test('calls function components and keeps Markup results as is', () => {
		const result = m('<b/>');
		expect(k(() => result, {})).toBe(result);
		expect(k((p: Props) => m(`<i>${p.n}</i>`), { n: 1 }).html).toBe('<i>1</i>');
	});

	test('coerces results like child content', () => {
		expect(k(() => 'a<b', {}).html).toBe('a&lt;b');
		expect(k(() => 3, {}).html).toBe('3');
		expect(k(() => 0, {}).html).toBe('0');
		expect(k(() => null, {}).html).toBe('');
		expect(k(() => {}, {}).html).toBe('');
		expect(k(() => false, {}).html).toBe('');
		expect(k(() => ['a', m('<b/>'), ['c']], {}).html).toBe('a<b/>c');
		expect(() => k(() => ({}), {})).toThrow(TypeError);
	});

	test('string types go through el with props.children', () => {
		expect(k('div', { id: 'x', children: ['a', m('<b/>')] }).html).toBe(
			'<div id="x">a<b/></div>',
		);
		expect(k('br', {}).html).toBe('<br/>');
	});

	test('a function props.children of a host tag is not called', () => {
		expect(k('div', { children: () => 'x' }).html).toBe('<div></div>');
	});

	test('Fragment concatenates its children', () => {
		expect(k(Fragment, { children: ['a', m('<b/>'), 1] }).html).toBe('a<b/>1');
		expect(Fragment).toBe(Symbol.for('react.fragment'));
	});

	test('errors thrown by components propagate; bad types throw', () => {
		expect(() =>
			k(() => {
				throw new Error('boom');
			}, {}),
		).toThrow('boom');
		expect(() => k(undefined, {})).toThrow(/Element type is invalid.*undefined/);
		expect(() => k(null, {})).toThrow(/got: null/);
		expect(() => k({}, {})).toThrow(/got: object/);
	});

	test('props.children is what the component sees', () => {
		const Card = (p: Props): unknown => el('section', { title: p.title }, p.children);
		expect(k(Card, { title: 't', children: m('<p>x</p>') }).html).toBe(
			'<section title="t"><p>x</p></section>',
		);
	});
});

describe('render', () => {
	test('renders like renderToStaticMarkup(createElement(component, props))', () => {
		const Page = (p: Props): unknown => el('p', { className: p.cls }, p.text);
		expect(render(Page, { cls: 'a', text: '<x>' })).toBe('<p class="a">&lt;x&gt;</p>');
		expect(render(() => null, {})).toBe('');
		expect(render(() => 'text', {})).toBe('text');
		expect(render(() => ['a', 1], {})).toBe('a1');
	});

	test('puts the document skeleton together', () => {
		const html = render(
			() =>
				el('html', { lang: 'ja' }, [
					el('head', null, [el('meta', { charSet: 'utf8' }), el('title', null, 'T')]),
					el('body', null, el('p', null, 'x')),
				]),
			{},
		);
		expect(html).toBe(
			'<html lang="ja"><head><meta charSet="utf8"/><title>T</title></head><body><p>x</p></body></html>',
		);
	});

	test('hoisted elements inside a body component go to the head', () => {
		const Child = (): unknown => [el('title', null, 'T'), el('p', null, 'x')];
		const html = render(
			() =>
				el('html', null, [
					el('head', null, el('meta', { name: 'a' })),
					el('body', null, k(Child, {})),
				]),
			{},
		);
		expect(html).toBe(
			'<html><head><meta name="a"/><title>T</title></head><body><p>x</p></body></html>',
		);
	});

	test('an html without head gets one, an html without body gets none', () => {
		expect(
			render(() => el('html', null, [el('title', null, 'T'), el('p', null, 'x')]), {}),
		).toBe('<html><head><title>T</title></head><p>x</p></html>');
	});

	test('the render context does not leak: renders are independent', () => {
		render(() => el('title', null, 'first'), {});
		expect(render(() => el('p', null, 'x'), {})).toBe('<p>x</p>');
		expect(el('title', null, 'T').html).toBe('<title>T</title>');
	});

	test('a failed render does not leave a context behind', () => {
		expect(() =>
			render(() => {
				el('title', null, 'x');
				throw new Error('boom');
			}, {}),
		).toThrow('boom');
		expect(el('title', null, 'T').html).toBe('<title>T</title>');
	});

	test('a nested render is isolated from the outer one', () => {
		const html = render(
			() => [
				el('title', null, 'outer'),
				m(render(() => [el('title', null, 'inner'), el('b', null)], {})),
			],
			{},
		);
		expect(html).toBe('<title>outer</title><title>inner</title><b></b>');
	});

	test('markers of dropped children never reach the output', () => {
		const html = render(() => {
			el('title', null, 'dropped');
			return el('p', null, 'kept');
		}, {});
		expect(html).toBe('<p>kept</p>');
	});

	test('constants created once are reusable across renders without copying', () => {
		const constant = m('<p class="x">y</p>');
		const page = (): unknown => [constant, el('title', null, 't')];
		expect(render(page, {})).toBe('<title>t</title><p class="x">y</p>');
		expect(render(page, {})).toBe('<title>t</title><p class="x">y</p>');
		expect(c(constant)).toBe(constant.html);
	});

	test('NUL characters in user text do not break assembly', () => {
		const html = render(() => [el('title', null, 't'), 'a\0h0\0b\0[x\0]'], {});
		expect(html).toBe('<title>t</title>a\0h0\0b\0[x\0]');
	});

	test('images preload into the head; picture / noscript thunks and lazy images do not', () => {
		expect(render(() => el('div', null, el('img', { src: '/a.png', alt: '' })), {})).toBe(
			'<link rel="preload" as="image" href="/a.png"/><div><img src="/a.png" alt=""/></div>',
		);
		expect(
			render(() => el('picture', null, () => el('img', { src: '/a.png' })), {}),
		).toBe('<picture><img src="/a.png"/></picture>');
		expect(
			render(() => el('noscript', null, () => el('img', { src: '/a.png' })), {}),
		).toBe('<noscript><img src="/a.png"/></noscript>');
		expect(render(() => el('img', { src: '/a.png', loading: 'lazy' }), {})).toBe(
			'<img src="/a.png" loading="lazy"/>',
		);
	});

	test('empty href / src: dropped by default, kept on <a href>', () => {
		expect(a('href', '')).toBe('');
		expect(el('a', { href: '', title: '' }, 'x').html).toBe('<a href="" title="">x</a>');
		expect(el('img', { src: '', alt: '' }).html).toBe('<img alt=""/>');
		expect(el('link', { rel: 'icon', href: '' }).html).toBe('<link rel="icon"/>');
		expect(el('script', { src: '' }).html).toBe('<script></script>');
	});

	test('leading newline of pre / listing / textarea string children is doubled', () => {
		expect(el('pre', null, '\nx').html).toBe('<pre>\n\nx</pre>');
		expect(el('listing', null, '\nx').html).toBe('<listing>\n\nx</listing>');
		expect(el('textarea', null, '\nx').html).toBe('<textarea>\n\nx</textarea>');
		expect(el('pre', null, ['\nx']).html).toBe('<pre>\nx</pre>');
	});

	test('preloadImage registers the head preload for flattened images', () => {
		const html = render(
			() => m(preloadImage({ src: '/a.png' }) + '<img src="/a.png"/>'),
			{},
		);
		expect(html).toBe(
			'<link rel="preload" as="image" href="/a.png"/><img src="/a.png"/>',
		);
		expect(preloadImage({ src: '/a.png' })).toBe('');
		expect(
			render(() => m(preloadImage({ src: '/a.png', loading: 'lazy' }) + '<img/>'), {}),
		).toBe('<img/>');
	});
});

// ---------------------------------------------------------------------------
// Documented differences from React: each one is asserted on both sides.
// ---------------------------------------------------------------------------

describe('deliberate deviations from React', () => {
	test('function-valued action / formAction are omitted (React writes a javascript: URL and a replay script)', () => {
		const tree = (): E => e('form', { action: noop, className: 'f' }, 'x');
		expect(ours(tree())).toEqual({ html: '<form class="f">x</form>' });
		const reacts = react(tree());
		expect(reacts).toHaveProperty('html');
		expect((reacts as { html: string }).html).toContain('javascript:throw new Error');

		const button = (): E => e('button', { formAction: noop }, 'x');
		expect(ours(button())).toEqual({ html: '<button>x</button>' });
		expect((react(button()) as { html: string }).html).toContain(
			'javascript:throw new Error',
		);

		const input = (): E => e('input', { formAction: noop });
		expect(ours(input())).toEqual({ html: '<input/>' });
		expect((react(input()) as { html: string }).html).toContain(
			'javascript:throw new Error',
		);
	});

	test('an event handler written as a string is an attribute only in a static page; anything else is dropped (React drops all)', () => {
		const link = (): Markup =>
			el('a', { href: '/a', oncontextmenu: 'return false;', onClick: noop }, 'x');
		// Not static: a prop that came from data must not become script.
		expect(render(link, {})).toBe('<a href="/a">x</a>');
		expect(render(link, { meta: { kdStatic: true } })).toBe(
			'<a href="/a" oncontextmenu="return false;">x</a>',
		);
		expect(
			render((): Markup => el('html', { static: true }, () => link()), {}),
		).toContain('<a href="/a" oncontextmenu="return false;">x</a>');
		expect(
			(react(e('a', { href: '/a', oncontextmenu: 'x' }, 'x')) as { html: string }).html,
		).not.toContain('oncontextmenu');
	});

	test('an input in a static page has one value and one checked, and no children', () => {
		const both = (): Markup =>
			el('input', { value: 'a', defaultValue: 'b', checked: true, defaultChecked: true });
		expect(render(both, { meta: { kdStatic: true } })).toBe(
			'<input value="a" checked=""/>',
		);
		const text = (): Markup => el('input', { type: 'text' }, 'x');
		expect(() => render(text, { meta: { kdStatic: true } })).toThrow();
	});

	test('a static page keeps defaultValue and defaultChecked of an input as value and checked', () => {
		const input = (): Markup =>
			el('input', { type: 'text', defaultValue: 'v', defaultChecked: true });
		expect(render(input, { meta: { kdStatic: true } })).toBe(
			'<input type="text" value="v" checked=""/>',
		);
	});

	const staticHead = (): Markup[] => [
		el('script', { src: '/a.js', async: true }),
		el('title', null, 'T'),
		el('meta', { name: 'x', content: 'y' }),
	];
	const staticBody = (): Markup =>
		el('form', { action: '/s', className: 'f' }, () =>
			el('input', { type: 'text', name: 'q', className: 'i' }),
		);

	test('<html static> keeps the order of the head and of the attributes of form controls (React hoists and reorders)', () => {
		const page = (): Markup =>
			el('html', { static: true }, () => [
				el('head', null, () => staticHead()),
				el('body', null, () => staticBody()),
			]);
		const out = render(page, {});
		expect(out).toBe(
			'<html><head><script src="/a.js" async=""></script><title>T</title><meta name="x" content="y"/></head><body><form action="/s" class="f"><input type="text" name="q" class="i"/></form></body></html>',
		);
		const plain = render(
			(): Markup =>
				el('html', null, () => [
					el('head', null, () => staticHead()),
					el('body', null, () => staticBody()),
				]),
			{},
		);
		// React's order: the async script first, `name` after the other attributes.
		expect(plain.indexOf('<script')).toBeLessThan(plain.indexOf('<title>'));
		expect(plain).toContain('<input type="text" class="i" name="q"/>');
	});

	test('a page whose meta says static is written like <html static> (a fragment has no html element)', () => {
		const page = (): Markup =>
			el('div', null, () => [staticBody(), el('title', null, 'T')]);
		expect(render(page, { meta: { kdStatic: true } })).toBe(
			'<div><form action="/s" class="f"><input type="text" name="q" class="i"/></form><title>T</title></div>',
		);
	});

	test('<head hoist={false}> alone keeps the order of what is in the head', () => {
		const page = (): Markup =>
			el('html', null, () => [
				el('head', { hoist: false }, () => staticHead()),
				el('body', null, 'x'),
			]);
		const out = render(page, {});
		expect(out.indexOf('<title>')).toBeLessThan(out.indexOf('<meta name="x"'));
		expect(out.indexOf('<script src="/a.js"')).toBeLessThan(out.indexOf('<title>'));
		expect(out).not.toContain('hoist');
	});

	test('head / body / html nested in another element are still the document singletons (React renders them in place)', () => {
		const tree = (): E =>
			e('div', null, e('head', null, e('title', null, 't')), e('body', null, 'x'));
		expect(ours(tree())).toEqual({
			html: '<head><title>t</title></head><body><div>x</div></body>',
		});
		expect(react(tree())).toEqual({
			html: '<title>t</title><div><head></head><body>x</body></div>',
		});
	});

	test('a function passed as the children argument is a thunk and is called (React renders nothing for a function child)', () => {
		expect(el('div', null, () => 'x').html).toBe('<div>x</div>');
		expect(react(e('div', null, () => 'x'))).toEqual({ html: '<div></div>' });
	});

	test('a Markup child of title / textarea / option is already escaped and is not escaped again', () => {
		expect(el('title', null, m('A &amp; B')).html).toBe('<title>A &amp; B</title>');
		expect(el('textarea', null, m('A &amp; B')).html).toBe(
			'<textarea>A &amp; B</textarea>',
		);
		expect(el('option', null, m('A &amp; B')).html).toBe('<option>A &amp; B</option>');
		// The plain string form is what React renders and what the runtime matches.
		expectSame(e('title', null, 'A & B'));
	});

	test('select children evaluated eagerly cannot see the select (the compiler must pass a thunk)', () => {
		const eager = el('select', { value: 'b' }, [el('option', { value: 'b' }, 'B')]).html;
		expect(eager).toBe('<select><option value="b">B</option></select>');
		expect(react(e('select', { value: 'b' }, e('option', { value: 'b' }, 'B')))).toEqual({
			html: '<select><option value="b" selected="">B</option></select>',
		});
	});

	test('React elements, thenables, context and class components are not supported as children', () => {
		expect(() => c(h('div', null))).toThrow(/Objects are not valid as a React child/);
		expect(() => c(Promise.resolve('x'))).toThrow(
			/Objects are not valid as a React child/,
		);
		class LegacyComponent {}
		expect(() => k(LegacyComponent, {})).toThrow(TypeError);
	});

	test('a Markup that leaves a position marker is only meaningful inside render', () => {
		const stray = render(() => el('title', null, 'x'), {});
		expect(stray).toBe('<title>x</title>');
	});
});

describe('styleOf', () => {
	test('CSS text becomes a style object (custom properties and url() with a semicolon kept)', () => {
		expect(styleOf('anchor-name: --a; --Gap: 1px;color:red')).toEqual({
			anchorName: '--a',
			'--Gap': '1px',
			color: 'red',
		});
		expect(styleOf('background: url("data:image/png;base64,AA=="); top: 0')).toEqual({
			background: 'url("data:image/png;base64,AA==")',
			top: '0',
		});
	});

	test('comments are skipped and upper case names are lower cased', () => {
		expect(styleOf('/* a;b */ margin: 0; COLOR: red')).toEqual({
			margin: '0',
			color: 'red',
		});
	});

	test('an object is kept and nothing is no style', () => {
		const object = { color: 'red' };
		expect(styleOf(object)).toBe(object);
		expect(styleOf(null)).toBeUndefined();
		expect(styleOf(false)).toBeUndefined();
		expect(styleOf('')).toBeUndefined();
	});

	test('it renders as the attribute of an element', () => {
		expect(el('div', { style: styleOf('anchor-name: --a') }).html).toBe(
			'<div style="anchor-name:--a"></div>',
		);
	});
});

describe('html', () => {
	test('nothing is written for null and undefined (Pug prints nothing for them)', () => {
		expect(
			el('div', null, [html(undefined as never), 'x', html(null as never)]).html,
		).toBe('<div>x</div>');
	});

	test('is output as it is, next to other children, where a string would be escaped', () => {
		const out = render(
			() => el('div', null, [html('<b>raw & ok</b>'), 'a & b', el('i', null, 'x')]),
			{},
		);
		expect(out).toBe('<div><b>raw & ok</b>a &amp; b<i>x</i></div>');
	});
});
