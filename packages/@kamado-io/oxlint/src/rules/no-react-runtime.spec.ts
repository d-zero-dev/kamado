import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-react-runtime';

describe(RULE, () => {
	test.each([
		["import { useState } from 'react';"],
		["import React from 'react';"],
		["import * as React from 'react';"],
		["import 'react';"],
		["import { createRoot } from 'react-dom/client';"],
		["import { renderToString } from 'react-dom/server';"],
		["import { jsx } from 'react/jsx-runtime';"],
		["export { useState } from 'react';"],
		["export * from 'react';"],
		["const { useState } = require('react');"],
		["const React = require('react-dom/server');"],
		["const react = await import('react');"],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual(['noReactRuntime']);
	});

	test.each([
		["import { jsx } from 'kamado/jsx';"],
		["import { x } from 'react-router';"],
		["import { x } from 'reactive';"],
		["import { x } from 'preact';"],
		["import x from './react';"],
		["import x from '../react/index.js';"],
		["const x = require('./react');"],
		["const x = await import('./react');"],
		["const x = require('react' + suffix);"],
		['const react = {}; react.useState();'],
		['const x = import(name);'],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('the report is on the import, with its place', () => {
		expect(lint(RULE, "\nimport { a } from 'react';\n")).toStrictEqual([
			{ messageId: 'noReactRuntime', line: 2, column: 1 },
		]);
	});

	test('each import of react is a report of its own', () => {
		expect(
			ids(RULE, "import { a } from 'react';\nimport { b } from 'react-dom';"),
		).toStrictEqual(['noReactRuntime', 'noReactRuntime']);
	});
});
