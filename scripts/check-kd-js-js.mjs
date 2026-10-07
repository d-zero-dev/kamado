/**
 * Robustness check of `kd_js`'s JavaScript grammar: plain JavaScript has
 * nothing to erase and no JSX, so `compile` must accept every file and give
 * it back byte for byte. Files that Node itself cannot parse as a module or a
 * script (checked with `node --check`-style `vm.Script` / `vm.SourceTextModule`
 * constructors via `new Function` for CommonJS bodies) are skipped.
 *
 * ```sh
 * cargo build --release --offline -p kd_js --example compile
 * KD_FILES=<list of .js/.mjs/.cjs files> node scripts/check-kd-js-js.mjs
 * ```
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = path.resolve(import.meta.dirname, '..');
const binary = path.join(root, 'target', 'release', 'examples', 'compile');
const files = readFileSync(process.env.KD_FILES, 'utf8')
	.split('\n')
	.filter(Boolean)
	.map((f) => path.resolve(root, f));

/**
 * Whether Node accepts the source as a script (CommonJS wrapper included) or
 * as an ES module.
 * @param {string} source - The file's text
 * @returns {boolean} True when Node parses it
 */
function nodeAccepts(source) {
	try {
		new vm.Script(
			`(function(exports, require, module, __filename, __dirname) {${source}\n})`,
		);
		return true;
	} catch {
		// not a script
	}
	try {
		new vm.SourceTextModule(source);
		return true;
	} catch {
		return false;
	}
}

const run = spawnSync(binary, [], {
	input: files.join('\n') + '\n',
	encoding: 'utf8',
	maxBuffer: 1 << 30,
});
if (run.status !== 0) {
	throw new Error(`compile example failed: ${run.stderr}`);
}
let same = 0;
let skipped = 0;
const problems = [];
for (const line of run.stdout.split('\n').filter(Boolean)) {
	const result = JSON.parse(line);
	const source = readFileSync(result.path, 'utf8');
	if (result.error) {
		if (nodeAccepts(source)) {
			problems.push(`${path.relative(root, result.path)}: ${result.error}`);
		} else {
			skipped++;
		}
	} else if (result.code === source) {
		same++;
	} else {
		problems.push(
			`${path.relative(root, result.path)}: the output differs from the input`,
		);
	}
}
for (const p of problems.slice(0, 25)) {
	process.stdout.write(`${p}\n`);
}
process.stdout.write(
	`${same} unchanged, ${problems.length} problems, ${skipped} not parseable by Node either, of ${files.length} files\n`,
);
process.exit(problems.length > 0 ? 1 : 0);
