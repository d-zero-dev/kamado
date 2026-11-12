'use client'; // ✗ no-client-directive
import { useState } from 'react'; // ✗ no-react-runtime
import React from 'react'; // ✗ no-react-runtime
import * as ReactDom from 'react-dom/client'; // ✗ no-react-runtime
import { jsx } from 'react/jsx-runtime'; // ✗ no-react-runtime
import fs from 'node:fs'; // ✗ no-untracked-input
import { readFile } from 'fs/promises'; // ✗ no-untracked-input
import fse from 'fs-extra'; // ✗ no-untracked-input
import http from 'node:http'; // ✗ no-untracked-input
import { exec } from 'node:child_process'; // ✗ no-untracked-input
export { useMemo } from 'react'; // ✗ no-react-runtime

import ReactLegacy = require('react'); // ✗ no-react-runtime
import fsLegacy = require('node:fs'); // ✗ no-untracked-input
const first = await load(); // ✗ no-untracked-input
const lazy = import('react'); // ✗ no-react-runtime
let visits = 0;
const seen = new Set<string>();
const counts: Record<string, number> = {};

export const fetchAll = () => fetch('https://example.com/all.json'); // ✗ no-untracked-input
export const fetchEach = (urls: string[]) => urls.map(fetch); // ✗ no-untracked-input
export const legacy = () => new XMLHttpRequest(); // ✗ no-untracked-input
const { fetch: get } = globalThis; // ✗ no-untracked-input
export const key = () => process.env['API_KEY']; // ✗ no-untracked-input
export const builtAt = () => new Date().toISOString(); // ✗ no-untracked-input
export const nowMs = () => Date.now(); // ✗ no-untracked-input
export const pick = () => Math.random(); // ✗ no-untracked-input

export const Header = (props: { title: string }) => {
	visits++; // ✗ no-module-state
	seen.add(props.title); // ✗ no-module-state
	counts[props.title] = visits; // ✗ no-module-state
	return (
		<header>
			<button
				onClick={() => {}} // ✗ no-function-event-handler
				ref={null} // ✗ no-ignored-props
				onblur="ok()"
			/>
			<my-button
				onClick={visits} // ✗ no-function-event-handler
			/>
			<time
				suppressHydrationWarning // ✗ no-ignored-props
			/>
			<p
				contentEditable
				suppressContentEditableWarning // ✗ no-ignored-props
			/>
		</header>
	);
};

// TypeScript wraps what it writes to in `as`, `!` and `?.`; they do not hide it.
export const Wrapped = () => {
	(visits as number)++; // ✗ no-module-state
	(seen as Set<string>).add('a'); // ✗ no-module-state
	counts!['x'] = 1; // ✗ no-module-state
	delete counts?.['y']; // ✗ no-module-state
	return <p />;
};

export const Card = async (props: { id: string }) => <p>{props.id}</p>; // ✗ no-async-component

// ✗ no-async-component
export default async function Page() {
	const data = await load();
	return <main>{data}</main>;
}
