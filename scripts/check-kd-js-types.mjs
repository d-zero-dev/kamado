/**
 * Differential check of `kd_js`'s TypeScript erasure against Node's own type
 * stripping (`module.stripTypeScriptTypes`, the oracle): every file given on
 * the command line (or every tracked `.ts` / `.mts` file) is compiled by
 * `crates/kd_js/examples/compile.rs` with unused imports kept, and the result
 * must equal Node's output up to white space.
 *
 * ```sh
 * cargo build --release --offline -p kd_js --example compile
 * node scripts/check-kd-js-types.mjs [files...]
 * ```
 *
 * Files that Node rejects (enums, namespaces and the like: not just types)
 * must be rejected by kd_js too.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target', 'release', 'examples', 'compile');

let files = process.argv.slice(2);
if (process.env.KD_FILES) {
	// A file with one path per line (relative paths are relative to the root).
	files = readFileSync(process.env.KD_FILES, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((f) => path.resolve(root, f));
}
if (files.length === 0) {
	const listed = execFileSync('git', ['ls-files', '*.ts', '*.mts'], {
		cwd: root,
		encoding: 'utf8',
	});
	files = listed
		.split('\n')
		.filter(Boolean)
		.map((f) => path.join(root, f));
}

const run = spawnSync(binary, [], {
	input: files.join('\n') + '\n',
	encoding: 'utf8',
	maxBuffer: 1 << 30,
	env: { ...process.env, KD_JS_KEEP_IMPORTS: '1' },
});
if (run.status !== 0) {
	throw new Error(`compile example failed: ${run.stderr}`);
}
const squeeze = (text) => text.replaceAll(/\s+/g, '');
let same = 0;
let differ = 0;
let bothReject = 0;
const problems = [];
for (const line of run.stdout.split('\n').filter(Boolean)) {
	const result = JSON.parse(line);
	const source = readFileSync(result.path, 'utf8');
	let expected;
	try {
		expected = stripTypeScriptTypes(source, { mode: 'strip' });
	} catch (error) {
		if (result.error) {
			bothReject++;
		} else {
			problems.push(
				`${result.path}: Node rejects it (${String(error.message).split('\n')[0]}), kd_js accepts`,
			);
		}
		continue;
	}
	if (result.error) {
		differ++;
		problems.push(`${path.relative(root, result.path)}: kd_js error: ${result.error}`);
		continue;
	}
	if (squeeze(result.code) === squeeze(expected)) {
		same++;
	} else {
		differ++;
		const a = squeeze(result.code);
		const b = squeeze(expected);
		let i = 0;
		while (i < a.length && a[i] === b[i]) {
			i++;
		}
		problems.push(
			`${path.relative(root, result.path)}: differs at ${i}\n    kd_js: …${a.slice(Math.max(0, i - 40), i + 60)}\n    node:  …${b.slice(Math.max(0, i - 40), i + 60)}`,
		);
	}
}
for (const p of problems.slice(0, 25)) {
	process.stdout.write(`${p}\n`);
}
process.stdout.write(
	`${same} same, ${differ} differ, ${bothReject} rejected by both, of ${files.length} files\n`,
);
process.exit(differ > 0 ? 1 : 0);
