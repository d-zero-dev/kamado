import type { FC } from 'react';
import { type ReactNode } from 'react';
import { type A, type B } from 'react';
import { html } from 'kamado/jsx';
import { Link } from 'react-router';
import path from 'node:path';

// A type that names `fetch` is no use of it.
export type Fetch = typeof fetch;
export type FetchOfGlobal = typeof globalThis.fetch;
export type { FC } from 'react';
export type * from 'react';
export { type A as ReactA } from 'react';
export { type Stats } from 'node:fs';

const labels = { a: 'A' } as const;
const list = [1, 2, 3];

export const List: FC<{
	items: number[];
	onRender: (n: number) => ReactNode;
}> = ({ items, onRender }) => {
	const local: number[] = [];
	local.push(items.length);
	return (
		<ul>
			{list.map((n) => (
				<li key={n}>{onRender(n)}</li>
			))}
			<Link onClick={() => local.length} to={path.join('a', labels.a)} />
		</ul>
	);
};

export default function Page(props: { title: string }) {
	let count = 0;
	count++;
	const cache = new Map<string, number>();
	cache.set(props.title, count);
	return (
		<html static lang="ja">
			<body>
				<button onClick="go()" onblur={'ok()'} type="button" />
				<List items={[count]} onRender={(n) => <b>{n}</b>} />
				{html('<!--#include virtual="/a.html" -->')}
			</body>
		</html>
	);
}

export const loader = async () => ({ ok: true });
export const unused: [A?, B?] = [];
