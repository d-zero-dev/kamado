import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const run = promisify(execFile);

const ROOT = path.resolve(import.meta.dirname, '..');
const BIN = path.join(ROOT, 'node_modules', '.bin');

// The click is on the line of `CLICK_LINE`; the other events are on the lines after it.
// `command` and `commandfor` come from a spread, as in the screen: React does not know them as props.
const SOURCE = `const command = { command: 'show-modal', commandfor: 'dialog' };
document.addEventListener('click', () => {});

export function Screen() {
	return (
		<div>
			<button type="button" {...command} onClick={() => {}}>
				Open
			</button>
			<input aria-label="name" onChange={() => {}} onKeyDown={() => {}} />
			<span
				onPointerDown={() => {}}
				onPointerMove={() => {}}
				onPointerUp={() => {}}
				onPointerCancel={() => {}}
				onDoubleClick={() => {}}
			/>
		</div>
	);
}
`;
const LISTENER_LINE = 2;
const CLICK_LINE = 7;

interface OxlintReport {
	readonly diagnostics: readonly {
		readonly code: string;
		readonly labels: readonly { readonly span: { readonly line: number } }[];
	}[];
}

interface MarkuplintReport {
	readonly name: string;
	readonly line: number;
}

/**
 * Runs a binary of `node_modules/.bin` that exits with 1 when it reports.
 * @param bin - The name of the binary
 * @param args - Its arguments
 * @returns What it printed on stdout
 */
async function stdoutOf(bin: string, args: readonly string[]): Promise<string> {
	try {
		const { stdout } = await run(path.join(BIN, bin), args, { cwd: ROOT });
		return stdout;
	} catch (error) {
		// A report is an exit with a code, and the report is what was printed.
		if (error instanceof Error && 'stdout' in error && typeof error.stdout === 'string') {
			return error.stdout;
		}
		throw error;
	}
}

describe('the click of a button is a command, and the other events are allowed', () => {
	let dir: string;
	let file: string;

	beforeAll(async () => {
		// Outside the repository: a file that stays here (the run was killed) would fail `yarn lint`.
		dir = await mkdtemp(path.join(tmpdir(), 'kamado-lint-click-event-'));
		file = path.join(dir, 'screen.tsx');
		await writeFile(file, SOURCE);
	});

	afterAll(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	test('oxlint reports `onClick` and a click listener, and nothing of the other events', async () => {
		const out = await stdoutOf('oxlint', [
			'-c',
			path.join(ROOT, 'oxlint.config.mts'),
			'-f',
			'json',
			file,
		]);
		const { diagnostics } = JSON.parse(out) as OxlintReport;
		expect(diagnostics.map((d) => [d.code, d.labels[0]?.span.line])).toStrictEqual([
			['@d-zero(no-click-event)', LISTENER_LINE],
			['@d-zero(no-click-event)', CLICK_LINE],
		]);
	});

	test('markuplint reports `onClick` and nothing of the other events', async () => {
		const out = await stdoutOf('markuplint', [
			'-c',
			path.join(ROOT, '.markuplintrc.json'),
			'--format',
			'JSON',
			file,
		]);
		const reports = JSON.parse(out) as MarkuplintReport[];
		expect(reports.map((r) => [r.name, r.line])).toStrictEqual([
			['security/no-event-handler-attr', CLICK_LINE],
		]);
	});
});
