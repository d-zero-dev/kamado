import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-untracked-input';

describe(RULE, () => {
	test.each([
		["import fs from 'fs';", 'noFileRead'],
		["import fs from 'node:fs';", 'noFileRead'],
		["import { readFile } from 'fs/promises';", 'noFileRead'],
		["import { readFile } from 'node:fs/promises';", 'noFileRead'],
		["import * as fs from 'node:fs';", 'noFileRead'],
		["import 'node:fs';", 'noFileRead'],
		["export { readFile } from 'node:fs/promises';", 'noFileRead'],
		["const fs = require('fs');", 'noFileRead'],
		["const fs = require('node:fs/promises');", 'noFileRead'],
		["const fs = import('node:fs');", 'noFileRead'],
		["export default async () => (await import('node:fs')).readFile;", 'noFileRead'],
		["import fse from 'fs-extra';", 'noFileRead'],
		["const fse = require('fs-extra');", 'noFileRead'],
		["import http from 'node:http';", 'noFetch'],
		["import https from 'https';", 'noFetch'],
		["import { request } from 'node:https';", 'noFetch'],
		["import axios from 'axios';", 'noFetch'],
		["const axios = require('axios');", 'noFetch'],
		["import { request } from 'undici';", 'noFetch'],
		["const http = import('node:http');", 'noFetch'],
		["import { exec } from 'node:child_process';", 'noChildProcess'],
		["import cp from 'child_process';", 'noChildProcess'],
		["const cp = require('node:child_process');", 'noChildProcess'],
		['export default () => new XMLHttpRequest();', 'noFetch'],
		['const f = fetch;', 'noFetch'],
		['export default (urls) => urls.map(fetch);', 'noFetch'],
		['export const load = (u) => Promise.all(u.map((x) => fetch(x)));', 'noFetch'],
		['const { fetch } = globalThis;', 'noFetch'],
		['const { fetch: get } = window;', 'noFetch'],
		['const get = globalThis.fetch;', 'noFetch'],
		['const get = self.fetch.bind(self);', 'noFetch'],
		["export default () => fetch('/api');", 'noFetch'],
		["export default () => fetch('/api').then((r) => r.json());", 'noFetch'],
		["const r = globalThis.fetch('/api');", 'noFetch'],
		["const r = window.fetch('/api');", 'noFetch'],
		["const r = self.fetch('/api');", 'noFetch'],
		["const r = global.fetch('/api');", 'noFetch'],
		['const data = await load();', 'noTopLevelAwait'],
		['await 1;', 'noTopLevelAwait'],
		['for await (const chunk of stream) { use(chunk); }', 'noTopLevelAwait'],
		['if (a) { await b; }', 'noTopLevelAwait'],
		['{ await b; }', 'noTopLevelAwait'],
		['const x = { y: await z };', 'noTopLevelAwait'],
	])('invalid: %s', (code, messageId) => {
		expect(ids(RULE, code)).toStrictEqual([messageId]);
	});

	test.each([
		["import path from 'node:path';"],
		["import { x } from './fs.js';"],
		["import { x } from 'fs-extra-thing';"],
		["import { x } from './http.js';"],
		["import x from 'https-proxy-agent';"],
		["import x from 'axios-mock-adapter';"],
		["import x from 'undici-thing';"],
		["import x from './child_process.js';"],
		['const http = { get() {} };\nhttp.get();'],
		['export default () => ({ XMLHttpRequest: 1 });'],
		['export default (XMLHttpRequest) => new XMLHttpRequest();'],
		['const o = { fetch: 1 };\nexport default () => o.fetch;'],
		['const { fetch } = api;'],
		['const { fetch } = obj.globalThis;'],
		["import x from 'fsevents';"],
		["const x = require('./fs');"],
		["const x = require('fs' + y);"],
		["const x = import('./fs.js').then((m) => m);"],
		['export default () => { function fetch() {} return fetch(); };'],
		["export default (fetch) => fetch('/a');"],
		["import { fetch } from './mine.js';\nexport default () => fetch('/a');"],
		['const api = { fetch() {} };\napi.fetch();'],
		["export default () => this.fetch('/a');"],
		['export default async () => { await 1; };'],
		['export const f = async () => await x;'],
		['async function load() { for await (const c of s) {} }'],
		['export default function () { const g = async () => { await 1; }; }'],
		['class A { async m() { await 1; } }'],
		['const o = { async m() { await 1; } };'],
		['const f = function* () { yield 1; };'],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('each await of the top level is a report of its own', () => {
		expect(ids(RULE, 'export const data = await (await x).json();')).toStrictEqual([
			'noTopLevelAwait',
			'noTopLevelAwait',
		]);
	});

	test('an await that waits for a file is both: it reads, and it waits at the top', () => {
		expect(ids(RULE, "const fs = await import('node:fs');")).toStrictEqual([
			'noTopLevelAwait',
			'noFileRead',
		]);
	});

	test('the report is on the import, the call and the await', () => {
		expect(lint(RULE, "import fs from 'fs';\nfetch(u);\nawait x;\n")).toStrictEqual([
			{ messageId: 'noFileRead', line: 1, column: 1 },
			{ messageId: 'noFetch', line: 2, column: 1 },
			{ messageId: 'noTopLevelAwait', line: 3, column: 1 },
		]);
	});
});
