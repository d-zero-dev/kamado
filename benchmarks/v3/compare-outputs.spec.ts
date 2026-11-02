import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const cli = path.join(import.meta.dirname, 'compare-outputs.ts');

describe('compare-outputs', () => {
	let root: string;
	let baseline: string;
	let candidate: string;

	const put = (dir: string, rel: string, content: string) => {
		const file = path.join(dir, rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	};
	const run = (...args: string[]) =>
		spawnSync(process.execPath, [cli, baseline, candidate, ...args], {
			encoding: 'utf8',
		});

	beforeEach(() => {
		root = mkdtempSync(path.join(tmpdir(), 'kamado-compare-cli-'));
		baseline = path.join(root, 'baseline');
		candidate = path.join(root, 'candidate');
		mkdirSync(baseline);
		mkdirSync(candidate);
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	test('--semantic counts equivalent pages and exits 0 when they all agree', () => {
		put(baseline, 'index.html', '<div>\n  <p>x</p>\n</div>');
		put(candidate, 'index.html', '<div><p>x</p></div>');

		const without = run();
		const result = run('--semantic');

		expect(without.status).toBe(1);
		expect(without.stdout).not.toMatch(/^equivalent/m);
		expect(result.stdout).toMatch(/^equivalent\s+1\b/m);
		expect(result.status).toBe(0);
	});

	test('--semantic counts each kind of difference that is left to check', () => {
		put(baseline, 'a.html', '<p>x</p><script>var a = 1;</script>');
		put(candidate, 'a.html', '<p>x</p><script>var a=1</script>');
		put(baseline, 'b.html', '<p>y</p><script>var b = 1;</script>');
		put(candidate, 'b.html', '<p>y</p><script>var b=1</script>');

		const result = run('--semantic');

		expect(result.stdout).toMatch(/^ {2}inline-script\s+2$/m);
		expect(result.stdout).toContain('equivalent (inline-script): a.html');
		expect(result.status).toBe(1);
	});

	test('--diff prints the line difference of the normalized markup of one file', () => {
		put(baseline, 'dir/index.html', '<div>\n  <p>a</p>\n  <p>same</p>\n</div>');
		put(candidate, 'dir/index.html', '<div><p>b</p><p>same</p></div>');

		const result = run(`--diff=${path.join('dir', 'index.html')}`);

		expect(result.stdout).toContain('-a\n');
		expect(result.stdout).toContain('+b\n');
		expect(result.stdout).not.toMatch(/^[-+]same$/m);
		expect(result.status).toBe(1);
	});

	test('--diff exits 0 when nothing differs after normalizing', () => {
		put(baseline, 'index.html', '<div>\n  <p>a</p>\n</div>');
		put(candidate, 'index.html', '<div><p>a</p></div>');

		const result = run('--diff=index.html');

		expect(result.stdout).toBe('the normalized markup is the same\n');
		expect(result.status).toBe(0);
	});

	test('--diff also prints the inline code and empty classes that differ', () => {
		put(
			baseline,
			'index.html',
			'<p class="" style="color: red">x</p><script>var a = 1;</script>',
		);
		put(candidate, 'index.html', '<p style="color:red">x</p><script>var a=1</script>');

		const result = run('--diff=index.html');

		expect(result.stdout).toContain('the normalized markup is the same');
		expect(result.stdout).toContain('inline scripts:\n-var a = 1;\n+var a=1');
		expect(result.stdout).toContain('inline styles:\n-color: red\n+color:red');
		expect(result.stdout).toContain('empty class attributes on start tags: 0 -> (none)');
		expect(result.status).toBe(1);
	});

	test('--diff of a file that only one side has says so', () => {
		put(candidate, 'new.html', '<p>x</p>');
		put(baseline, 'old.html', '<p>x</p>');

		const missing = run('--diff=new.html');
		const extra = run('--diff=old.html');

		expect(missing.stderr).toContain('new.html is not in the baseline');
		expect(missing.status).toBe(2);
		expect(extra.stderr).toContain('old.html is not in the candidate');
		expect(extra.status).toBe(2);
	});

	test('--diff refuses a file that is not a page', () => {
		put(baseline, 'style.css', 'a{color:red}');
		put(candidate, 'style.css', 'a{color:blue}');

		const result = run('--diff=style.css');

		expect(result.stderr).toContain('--diff compares pages (.html, .htm)');
		expect(result.status).toBe(2);
	});

	test('an empty class difference prints the selectors that test the class attribute', () => {
		put(
			baseline,
			'index.html',
			'<ul class=""><li>x</li></ul><style>p:not([class]){color:red}</style>',
		);
		put(
			candidate,
			'index.html',
			'<ul><li>x</li></ul><style>p:not([class]){color:red}</style>',
		);
		put(
			baseline,
			'other.html',
			'<div>\n<p>x</p></div><style>i[class]{color:red}</style>',
		);
		put(candidate, 'other.html', '<div><p>x</p></div><style>i[class]{color:red}</style>');
		put(baseline, 'style.css', '.x [class]{color:red}b:not([class]){x:1}');
		put(candidate, 'style.css', '.x [class]{color:red}a{color:blue}[class^=icon-]{x:1}');

		const result = run('--semantic');

		expect(result.stdout).toContain('selectors that test the class attribute: 2');
		expect(result.stdout).toContain('  .x [class]\n');
		expect(result.stdout).toContain('  p:not([class])\n');
		// The baseline's stylesheets, the <style> of pages without the difference, and
		// selectors that an empty value cannot change are left out.
		expect(result.stdout).not.toContain('b:not([class])');
		expect(result.stdout).not.toContain('i[class]');
		expect(result.stdout).not.toContain('icon-');
	});

	test('prefixed declarations on only one side of a stylesheet are listed', () => {
		put(baseline, 'style.css', 'a{-webkit-text-decoration:underline;color:red}');
		put(candidate, 'style.css', 'a{color:red}b{-moz-appearance:none}');

		const result = run('--semantic');

		expect(result.stdout).toContain('prefixes: style.css');
		expect(result.stdout).toContain('  - a { -webkit-text-decoration:underline }');
		expect(result.stdout).toContain('  + b { -moz-appearance:none }');
	});

	test('--show also bounds the prefix list', () => {
		put(baseline, 'style.css', 'a{-webkit-a:1;-webkit-b:1;-webkit-c:1;color:red}');
		put(candidate, 'style.css', 'a{color:red}');

		const result = run('--semantic', '--show=2');

		expect(result.stdout).toContain('  - a { -webkit-b:1 }');
		expect(result.stdout).not.toContain('-webkit-c');
		expect(result.stdout).toContain('  ... and 1 more');
	});
});
