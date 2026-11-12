import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-async-component';

describe(RULE, () => {
	test.each([
		['export default async function Page() { return <main />; }'],
		['export default async function Page() { return null; }'],
		['export default async () => <main />;'],
		['export default async function () { await x; }'],
		['export async function Header() { return <header />; }'],
		['export const Card = async () => <p />;'],
		['export const Card = async function () { return <p />; };'],
		['async function Row() { return cond ? <a /> : <b />; }'],
		['async function Row() { return cond && <a />; }'],
		['async function Row() { return <></>; }'],
		['const x = async () => { if (a) { return <a />; } return null; };'],
		['async function Row() { return (<a />); }'],
		// The default export that is named, not declared there.
		['async function Page() { return null; }\nexport default Page;'],
		['const Page = async () => null;\nexport default Page;'],
		['const Page = async function () { return 1; };\nexport default Page;'],
		['async function Page() {}\nexport { Page as default };'],
		['async function Page() {}\nexport { Page as "default" };'],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual(['noAsyncComponent']);
	});

	test.each([
		['export default function Page() { return <main />; }'],
		['export default () => <main />;'],
		['export const Card = () => <p />;'],
		['async function load() { return fetch(url); }'],
		['export async function loader() { return { a: 1 }; }'],
		['const x = async () => { await 1; };'],
		['function Row() { const f = async () => 1; return <a>{f}</a>; }'],
		['function Row() { async function g() { return 1; } return <a />; }'],
		['async function load() { const View = () => <p />; return View; }'],
		['async function main() { render(<App />); }'],
		['function Page() { return <p />; }\nexport default Page;'],
		['const Page = () => <p />;\nexport default Page;'],
		["import Page from './page.js';\nexport default Page;"],
		['async function load() {}\nexport default function Page() { return <p />; }'],
		['async function load() {}\nexport { load };'],
		['async function load() {}\nexport { load as loader };'],
		["export { Page as default } from './page.js';"],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('one report for a default export that is async and returns JSX', () => {
		expect(
			lint(RULE, 'export default async function Page() {\n\treturn <main />;\n}'),
		).toStrictEqual([{ messageId: 'noAsyncComponent', line: 1, column: 16 }]);
	});

	test('the report is on the function, not on the nested ones', () => {
		expect(
			lint(
				RULE,
				'async function A() {\n\tconst B = () => <p />;\n\treturn <a>{B}</a>;\n}',
			),
		).toStrictEqual([{ messageId: 'noAsyncComponent', line: 1, column: 1 }]);
	});
});
