import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-module-state';

describe(RULE, () => {
	test.each([
		['let n = 0;\nexport default () => { n = 1; return <p />; };'],
		['let n = 0;\nexport default () => { n += 1; return <p />; };'],
		['let n = 0;\nexport default () => { n++; return <p />; };'],
		['let n = 0;\nexport default () => { --n; return <p />; };'],
		['const o = {};\nexport default () => { o.a = 1; return <p />; };'],
		['const o = {};\nexport default () => { o.a.b = 1; return <p />; };'],
		["const o = {};\nexport default () => { o['a'] = 1; return <p />; };"],
		['const o = {};\nexport default () => { delete o.a; return <p />; };'],
		['let a, b;\nexport default () => { [a, b] = [1, 2]; return <p />; };'],
		['let a;\nexport default () => { ({ a } = {}); return <p />; };'],
		['let a;\nexport default () => { [a = 1] = []; return <p />; };'],
		['let a;\nexport default () => { [...a] = []; return <p />; };'],
		[
			"const cache = new Map();\nexport default () => { cache.set('a', 1); return <p />; };",
		],
		['const seen = new Set();\nexport default () => { seen.add(1); return <p />; };'],
		['const seen = new Set();\nexport default () => { seen.delete(1); return <p />; };'],
		['const seen = new Set();\nexport default () => { seen.clear(); return <p />; };'],
		['const list = [];\nexport default () => { list.push(1); return <p />; };'],
		['const list = [3, 1];\nexport default () => { list.sort(); return <p />; };'],
		[
			'const list = [];\nexport default () => { list.reverse(); list.pop(); list.shift(); return <p />; };',
		],
		[
			'const list = [];\nexport default () => { list.splice(0, 1); list.unshift(1); return <p />; };',
		],
		[
			'const list = [];\nexport default () => { list.fill(0); list.copyWithin(0, 1); return <p />; };',
		],
		[
			'const o = {};\nexport default () => { Object.assign(o, { a: 1 }); return <p />; };',
		],
		[
			'const o = {};\nexport default () => { Object.defineProperty(o, "a", {}); return <p />; };',
		],
		[
			"import { config } from './config.js';\nexport default () => { config.a = 1; return <p />; };",
		],
		[
			"import { config } from './config.js';\nexport default () => { config.a.b++; return <p />; };",
		],
		[
			"import { config } from './config.js';\nexport default () => { delete config.a; return <p />; };",
		],
		[
			"import { config } from './config.js';\nexport default () => { Object.assign(config, { a: 1 }); return <p />; };",
		],
		['let n = 0;\nfunction bump() { n = n + 1; }'],
		['let n = 0;\nconst bump = function () { n = 1; };'],
		['let n = 0;\nexport const x = { f() { n = 1; } };'],
		['let n = 0;\nexport default () => () => { n = 1; };'],
		['let n = 0;\nclass A { m() { n = 1; } }'],
		['const o = {};\nexport default () => { o.list.push(1); return <p />; };'],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code).length).toBeGreaterThan(0);
		expect(new Set(ids(RULE, code))).toStrictEqual(new Set(['noModuleState']));
	});

	test.each([
		// What the module does when it is loaded is not a render.
		['let n = 0;\nn = 1;\nexport default () => <p />;'],
		['const o = {};\no.a = 1;\nexport default () => <p />;'],
		['const cache = new Map();\ncache.set("a", 1);\nexport default () => <p />;'],
		[
			'let n = 0;\nfor (let i = 0; i < 3; i++) { n += i; }\nexport default () => <p>{n}</p>;',
		],
		// Reading is not writing.
		['const o = { a: 1 };\nexport default () => <p>{o.a}</p>;'],
		['const list = [1, 2];\nexport default () => <p>{list.map((x) => x)}</p>;'],
		['const list = [1, 2];\nexport default () => <p>{list.slice().sort()}</p>;'],
		['const m = new Map();\nexport default () => <p>{m.get("a")}</p>;'],
		['const o = {};\nexport default () => <p>{Object.keys(o)}</p>;'],
		[
			'const o = { a: 1 };\nexport default () => { const b = { ...o }; return <p>{b.a}</p>; };',
		],
		// What the function owns.
		['export default () => { let n = 0; n++; n = 2; return <p>{n}</p>; };'],
		['export default () => { const o = {}; o.a = 1; return <p>{o.a}</p>; };'],
		['export default () => { const list = []; list.push(1); return <p>{list}</p>; };'],
		['export default () => { const m = new Map(); m.set("a", 1); return <p />; };'],
		['let n = 0;\nexport default (n) => { n = 1; return <p>{n}</p>; };'],
		['let n = 0;\nexport default ({ n }) => { n = 1; return <p>{n}</p>; };'],
		['let n = 0;\nexport default () => { let n = 1; n++; return <p>{n}</p>; };'],
		['const o = {};\nexport default () => { const o = {}; o.a = 1; return <p />; };'],
		['const list = [];\nexport default (list) => { list.push(1); return <p />; };'],
		['let n = 0;\nexport default () => { { let n = 1; n = 2; } return <p />; };'],
		[
			'let n = 0;\nexport default () => { for (let n = 0; n < 2; n++) {} return <p />; };',
		],
		['let n = 0;\nexport default () => { try {} catch (n) { n = 1; } return <p />; };'],
		// What is imported is not told apart by its methods: `_.set(…)` and `R.sort(…)` are
		// functions of a library, and `items.sort()` can be a write that no name shows.
		[
			"import _ from 'lodash';\nexport default () => { _.set(o, 'a', 1); return <p />; };",
		],
		[
			"import * as R from 'ramda';\nexport default () => { R.sort(f, xs); R.add(1, 2); R.fill(0); return <p />; };",
		],
		[
			"import { items } from './data.js';\nexport default () => { items.sort(); return <p />; };",
		],
		// Not a variable of the module.
		['export default () => { window.x = 1; return <p />; };'],
		['export default () => { globalThis.x = 1; return <p />; };'],
		['export default () => { undeclared = 1; return <p />; };'],
		['const f = () => 1;\nexport default () => { f.x; return <p />; };'],
		['const o = {};\nexport default () => { o.push; o.set; return <p />; };'],
		['const o = {};\nexport default () => { const set = o.set; return <p />; };'],
		['const o = { push() {} };\nexport default () => <p>{o.pushed()}</p>;'],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	// The number of reports is part of what is said: a rule that reports twice for one write
	// is as wrong as one that does not report.
	test.each([
		['let n = 0;\nexport default () => { n = 1; return <p />; };', 1],
		['let a, b;\nexport default () => { [a, b] = [1, 2]; return <p />; };', 2],
		['const o = {};\nexport default () => { o.a.b.c = 1; return <p />; };', 1],
		['const l = [];\nexport default () => { l.push(1); l.pop(); return <p />; };', 2],
		['const o = {};\nexport default () => { Object.assign(o, p); return <p />; };', 1],
		['let n = 0;\nexport default () => { n++; n--; return <p />; };', 2],
		// A write that is the argument of a write is two writes.
		['let a, b;\nexport default () => { a = b = 1; return <p />; };', 2],
	])('the number of reports: %s', (code, count) => {
		expect(ids(RULE, code)).toStrictEqual(
			Array.from({ length: count }, () => 'noModuleState'),
		);
	});

	test.each([
		// The left side of for…of and for…in is a write.
		['let n;\nexport default (xs) => { for (n of xs) {} return <p />; };'],
		['let k;\nexport default (o) => { for (k in o) {} return <p />; };'],
		['const o = {};\nexport default (xs) => { for (o.k of xs) {} return <p />; };'],
		// A method that is named by a string.
		["const list = [];\nexport default () => { list['push'](1); return <p />; };"],
		// `Reflect` writes as `Object` does.
		["const o = {};\nexport default () => { Reflect.set(o, 'a', 1); return <p />; };"],
		[
			"const o = {};\nexport default () => { Reflect.deleteProperty(o, 'a'); return <p />; };",
		],
		[
			"const o = {};\nexport default () => { Reflect.defineProperty(o, 'a', {}); return <p />; };",
		],
		// A class field runs for each instance, so when the class is used by a render.
		['let n = 0;\nclass K { x = n++; }'],
		// What a render calls is not what the module runs as it is loaded.
		[
			'let n = 0;\nexport default (xs) => { xs.forEach((x) => { n += x; }); return <p />; };',
		],
		['let n = 0;\nregister(() => { n++; });'],
		['let n = 0;\nexport const f = () => { (() => { n = 1; })(); };'],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual(['noModuleState']);
	});

	// What runs as the module is loaded is a script that fills a table: the callback of an
	// iteration at the top, and a function that is called at once.
	test.each([
		[
			'const byId = {};\nITEMS.forEach((i) => { byId[i] = i; });\nexport default () => <p />;',
		],
		['const m = new Map();\n[1, 2].forEach(function (x) { m.set(x, x); });'],
		['const m = new Map();\nITEMS.map((x) => m.set(x, x));'],
		['const t = {};\nITEMS.filter((x) => { t[x] = 1; return true; });'],
		['let n = 0;\n(() => { n = 5; })();\nexport default () => <p>{n}</p>;'],
		['let n = 0;\n(function () { n = 5; })();'],
		['let n = 0;\n(async () => { n = 5; })();'],
	])('valid, as the module is loaded: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('the report is on what is written, one for each', () => {
		expect(
			lint(
				RULE,
				'let a = 0;\nconst l = [];\nexport default () => {\n\ta++;\n\tl.push(a);\n\treturn <p />;\n};',
			),
		).toStrictEqual([
			{ messageId: 'noModuleState', line: 4, column: 2 },
			{ messageId: 'noModuleState', line: 5, column: 2 },
		]);
	});
});
