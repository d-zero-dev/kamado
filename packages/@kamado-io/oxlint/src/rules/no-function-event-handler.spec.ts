import { describe, expect, test } from 'vitest';

import { ids, lint } from '../lint.test-util.js';

const RULE = 'no-function-event-handler';

describe(RULE, () => {
	test.each([
		['<button onClick={() => {}} />'],
		['<button onClick={function () {}} />'],
		['<button onClick={handler} />'],
		['<button onClick={this.handler} />'],
		['<button onClick={handle()} />'],
		['<button onClick={cond ? "a()" : fn} />'],
		['<button onClick={a ?? b} />'],
		['<button onClick={cond && "a()"} />'],
		['<a onClick={() => {}} />'],
		['<button onclick={fn} />'],
		['<my-button onClick={fn} />'],
		['<svg:rect onLoad={fn} />'],
		['<div {...rest} onClick={fn}></div>'],
		['const B = <button onClick={() => {}} />;'],
		['export default () => <p onToggle={fn} />;'],
	])('invalid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual(['noFunctionEventHandler']);
	});

	test('each attribute is a report of its own', () => {
		expect(ids(RULE, '<input onChange={fn} onBlur={fn} />')).toStrictEqual([
			'noFunctionEventHandler',
			'noFunctionEventHandler',
		]);
	});

	test.each([
		['<button onClick="go()" />'],
		["<button onClick={'go()'} />"],
		['<button onClick={`go(${id})`} />'],
		["<button onClick={'go(' + id + ')'} />"],
		['<button onClick={"go(" + a + "," + b + ")"} />'],
		['<button onClick={cond ? "a()" : undefined} />'],
		['<button onClick={cond ? "a()" : "b()"} />'],
		['<button onClick={undefined} />'],
		['<button onClick={null} />'],
		['<button onClick={false} />'],
		['<button onClick={true} />'],
		['<button onClick={void 0} />'],
		['<button onClick />'],
		['<button onclick="go()" />'],
		['<List onRender={() => 1} />'],
		['<List.Item onClick={() => 1} />'],
		['<Menu onClick={handler} />'],
		['<button title={() => 1} />'],
		['<button on={fn} />'],
		['<button {...rest} />'],
		['<button className="a" type="button" />'],
	])('valid: %s', (code) => {
		expect(ids(RULE, code)).toStrictEqual([]);
	});

	test('the report is on the attribute, one for each', () => {
		expect(lint(RULE, '<input onChange={a} onBlur={b} />')).toStrictEqual([
			{ messageId: 'noFunctionEventHandler', line: 1, column: 8 },
			{ messageId: 'noFunctionEventHandler', line: 1, column: 21 },
		]);
	});
});
