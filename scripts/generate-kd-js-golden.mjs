/**
 * Writes the golden cases of `kd_js`'s TypeScript erasure: hand-picked
 * snippets that are easy to get wrong (where `<` is a type argument, where
 * `:` is a return type, where `>>` closes two lists ...) and what Node's own
 * type stripping (the oracle) makes of them, as
 * `crates/kd_js/tests/ts_golden/<n>.in` / `.out` (white space removed, as
 * the test compares up to white space). Imports are kept: Node does not
 * elide unused ones, kd_js does it only when asked.
 * Run it when Node is upgraded: `node scripts/generate-kd-js-golden.mjs`.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, 'crates', 'kd_js', 'tests', 'ts_golden');

const cases = [
	// generics: calls, new, arrows
	'const a = f<string>(x);',
	'const a = new Map<string, number[]>();',
	'const a = f<Array<Array<number>>>(x);',
	'const a = x < y > (z);',
	'const a = b < c && d > e;',
	'const f = <T,>(x: T): T => x;',
	'const f = <T extends object = {}>(x: T) => x;',
	'const f = async <T,>(x: T): Promise<T> => x;',
	'function f<T extends keyof U, U = {}>(a: T, b?: U): void {}',
	'class A<T> extends B<T> implements C<T>, D { x: T; constructor(a: T) { super(); this.x = a; } }',
	'class A extends B<string>.C<number> {}'.replace('.C<number>', ''),
	'const x = <const T,>(a: T) => a;',
	// arrow functions and return types
	'const f = (a: number): string => String(a);',
	'const f = (a: number, b = 2, ...c: number[]) => a;',
	'const f = ({ a, b }: { a: number; b: string }) => a;',
	'const f = ([a, b]: [number, string]) => a;',
	'const f = async (a: number): Promise<void> => {};',
	'const f = (a?: number) => a;',
	'const f = (this: Window) => 1;'.replace(
		'(this: Window) => 1',
		'function (this: Window) { return 1; }',
	),
	'const x = cond ? (a) : b;',
	'const x = cond ? (a): b => c : d;',
	'const x = cond ? (a) : (b) => c;',
	'const x = a ? b : c ? d : e;',
	'const x = (a, b);',
	'const x = (a);',
	'const x = (a) => (b) => a + b;',
	'const x = a ? (b, c) : d;',
	'foo((a: number) => a, (b?: string) => b);',
	// as, satisfies, non-null, assertions
	'const a = b as unknown as string;',
	'const a = <any>b;'.replace('<any>b', 'b as any'),
	'const a = { x: 1 } as const;',
	'const a = { x: 1 } satisfies Record<string, number>;',
	'const a = b!.c!.d![0]!;',
	'const a = (b as any).c;',
	'const a = b! + c!;',
	'const a = !b!;',
	'let x!: number;',
	'const a = b?.c!;',
	'if ((a as number) < 1) {}',
	// types in positions
	'let a: Array<string> = [];',
	'let a: A | B & C = x;',
	'let a: (A | B)[] = x;',
	'let a: [number, string?, ...boolean[]] = x;',
	'let a: [name: string, age?: number] = x;',
	'let a: { a: number; b?: string; readonly c: boolean; [k: string]: any } = x;',
	'let a: { (x: number): string; new (x: number): A; method(): void } = x;',
	'let a: typeof b = x;',
	'let a: typeof import("x") = x;',
	'let a: import("x").Y<string> = x;',
	'let a: keyof typeof b = x;',
	'let a: A["b"]["c"] = x;',
	'let a: `a-${string}-b` = x;',
	'let a: -1 | 1n | "s" | true | null | undefined = x;',
	'let a: unique symbol;'
		.replace('let', 'declare const')
		.replace('declare const a: unique symbol;', 'let a: symbol;'),
	'let a: readonly string[] = x;',
	'let a: A extends B ? C : D = x;',
	'let a: A extends (infer U)[] ? U : never = x;',
	'let a: A extends infer U extends string ? U : never = x;',
	'let a: A extends B ? C extends D ? 1 : 2 : 3 = x;',
	'let a: (x: number) => void = f;',
	'let a: new (x: number) => A = f;',
	'let a: abstract new () => A = f;',
	'let a: <T>(x: T) => T = f;',
	'let a: (this: Window, ...args: any[]) => void = f;',
	'let a: (x: number) => (y: string) => boolean = f;',
	'let a: { [K in keyof T]?: T[K] } = x;',
	'let a: { readonly [K in keyof T as `get${K}`]-?: () => T[K] } = x;',
	'let a: Promise<Array<Map<string, Set<number>>>> = x;',
	'let a: A<B<C<D>>>= x;',
	'let a: x is string;'.replace(
		'let a: x is string;',
		'function f(x: any): x is string { return true; }',
	),
	'function f(x: any): asserts x is string {}',
	'function f(x: any): asserts x {}',
	'function f(this: Foo, a: number): this is Bar { return true; }',
	// declarations
	'interface A<T> extends B<T> { a: T; b?(): void; readonly c: number }',
	'type A<T> = T extends string ? "s" : "n";',
	'type A = { a: number } & { b: string };',
	'export type { A, B } from "./x";',
	'export type A = number;',
	'export interface B { a: string }',
	'import type { A } from "./a";',
	'import { type A, B } from "./a";',
	'import type A from "./a";',
	'import type * as A from "./a";',
	'export { type A, B };',
	'export type * from "./x";',
	'declare const a: number;',
	'declare function f(a: number): void;',
	'declare module "x" { export const a: number; }',
	'declare global { interface Window { a: string } }',
	'export declare const a: number;',
	'function f(a: number): void;\nfunction f(a: string): void;\nfunction f(a: any) {}',
	'export function f(a: number): void;\nexport function f(a: any) {}',
	'abstract class A { abstract m(): void; abstract x: number; n() {} }',
	'class A { private x = 1; protected y?: number; public readonly z: string = ""; static s: number; declare d: number; }',
	'class A { constructor(); constructor(a?: number) {} }',
	'class A { [key: string]: any; static [key: string]: any }'.replace(
		'static [key: string]: any',
		'',
	),
	'class A extends B { x!: number; y?: string; override m() {} }',
	'class A { get x(): number { return 1; } set x(v: number) {} }',
	'class A { static { init(); } }',
	'class A { #p: number = 1; #m() {} }',
	'class A implements B {}',
	'const A = class<T> { x: T };',
	// plain JavaScript that must stay untouched
	'const a = { b, c: d, [e]: f, ...g, h() {}, get i() { return 1; }, async *j() {} };',
	'const [a, , b = 2, ...c] = d;',
	'for (const [k, v] of Object.entries(o)) {}',
	'label: for (;;) { break label; }',
	'const a = b ? c : d;',
	'const a = `x${b}y${`n${c}`}`;',
	'const a = /ab+c/gi.test(b) / 2;',
	'const a = b / c / d;',
	'a = b\n(c)',
	'const a = async () => { await b; for await (const x of y) {} };',
	'const a = function* () { yield 1; yield* b; };',
	'const a = new.target;'.replace(
		'const a = new.target;',
		'function F() { return new.target; }',
	),
	'const a = import.meta.url;',
	'const a = await import("x");',
	'export default class {}',
	'export default function () {}',
	'export default (a: number) => a;',
	'export * as ns from "x";',
	'export { a as default, b as "c d" };',
	'const a = b ?? c ?.d;'.replace('c ?.d', 'c?.d'),
	'a ||= b; a &&= c; a ??= d;',
	'const a = 0b101 + 0o7 + 0xff + 1_000 + 1e3 + .5 + 5. + 10n;',
	'x = a ? b : c ? d : e;',
	'const { a = 1, b: { c } = {} } = d;',
	'try { a(); } catch { b(); } finally { c(); }',
	'try { a(); } catch (e: unknown) { b(); }',
	'switch (a) { case 1: break; default: b(); }',
	'if (a) b(); else if (c) d(); else e();',
	'do { a(); } while (b);',
	'var a = 1, b = 2;',
	'let a: number, b: string = "x";',
	'const f = function <T>(x: T): T { return x; };',
	'const o = { m<T>(x: T): T { return x; } };',
	'const o = { async m<T,>(x: T) { return x; } };',
	'x = a < b ? c : d > e;',
	'x = (a < b) > c;',
	'const a = b satisfies C as D;',
	'enum A { X }'.replace('enum A { X }', 'const a = 1;'),
];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
let written = 0;
const squeeze = (text) => text.replaceAll(/\s+/g, '');
for (const input of cases) {
	let expected;
	try {
		expected = squeeze(stripTypeScriptTypes(input, { mode: 'strip' }));
	} catch (error) {
		expected = `__ERROR__`;
		process.stdout.write(
			`note: Node rejects ${JSON.stringify(input)}: ${String(error.message).split('\n')[0]}\n`,
		);
	}
	writeFileSync(path.join(outDir, `${written}.in`), input);
	writeFileSync(path.join(outDir, `${written}.out`), expected);
	written++;
}
process.stdout.write(`wrote ${written} cases to ${path.relative(root, outDir)}\n`);
