import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Generated fixture directory set
 */
export interface FixtureSet {
	/**
	 * Fixture root directory
	 */
	readonly rootDir: string;
	/**
	 * Input directory (pages, styles, scripts)
	 */
	readonly inputDir: string;
	/**
	 * Output directory
	 */
	readonly outputDir: string;
	/**
	 * Layouts directory
	 */
	readonly layoutsDir: string;
	/**
	 * Global data directory
	 */
	readonly dataDir: string;
}

const STYLE_COUNT = 5;
const SCRIPT_COUNT = 5;

/**
 * Generates a synthetic site for build benchmarking:
 * - N Pug pages sharing a single layout (the layout includes a partial)
 * - a few CSS files importing a shared partial
 * - a few TS files importing a shared module
 * @param baseDir - Directory to generate fixtures under
 * @param pageCount - Number of pages to generate
 * @returns Generated fixture directory set
 */
export async function generateFixtures(
	baseDir: string,
	pageCount: number,
): Promise<FixtureSet> {
	const rootDir = path.resolve(baseDir, `fixtures-${pageCount}`);
	const inputDir = path.join(rootDir, 'input');
	const outputDir = path.join(rootDir, 'output');
	const layoutsDir = path.join(rootDir, 'layouts');
	const partialsDir = path.join(rootDir, 'partials');
	const dataDir = path.join(rootDir, 'data');

	await fs.rm(rootDir, { recursive: true, force: true });
	await fs.mkdir(inputDir, { recursive: true });
	await fs.mkdir(path.join(inputDir, 'css'), { recursive: true });
	await fs.mkdir(path.join(inputDir, 'js'), { recursive: true });
	await fs.mkdir(layoutsDir, { recursive: true });
	await fs.mkdir(partialsDir, { recursive: true });
	await fs.mkdir(dataDir, { recursive: true });

	await fs.writeFile(
		path.join(partialsDir, 'header.pug'),
		['mixin header(t)', '\theader', '\t\th1= t', '\t\tp= site.description', ''].join(
			'\n',
		),
	);

	await fs.writeFile(
		path.join(layoutsDir, 'default.pug'),
		[
			'include /partials/header.pug',
			'doctype html',
			'html',
			'\thead',
			'\t\ttitle= title',
			'\tbody',
			'\t\t+header(title)',
			'\t\tmain !{content}',
			'',
		].join('\n'),
	);

	await fs.writeFile(
		path.join(dataDir, 'site.yml'),
		['description: Benchmark fixture site', ''].join('\n'),
	);

	const pageWrites: Promise<void>[] = [];
	for (let i = 0; i < pageCount; i++) {
		const name = `page-${String(i).padStart(5, '0')}`;
		const body = [
			'---',
			'layout: default.pug',
			`title: Page ${i}`,
			'---',
			`h2 Section ${i}`,
			`p This is the body of page ${i}. It exists to give the compiler real work.`,
			'ul',
			'\teach item in [1, 2, 3, 4, 5]',
			`\t\tli Item #{item} of page ${i}`,
			'',
		].join('\n');
		pageWrites.push(fs.writeFile(path.join(inputDir, `${name}.pug`), body));
	}
	await Promise.all(pageWrites);

	await fs.writeFile(
		path.join(partialsDir, 'base.css'),
		['body {', '\tmargin: 0;', '\tfont-family: sans-serif;', '}', ''].join('\n'),
	);
	for (let i = 0; i < STYLE_COUNT; i++) {
		await fs.writeFile(
			path.join(inputDir, 'css', `style-${i}.css`),
			[
				'@import "../../partials/base.css";',
				`.component-${i} {`,
				`\tcolor: rgb(${i * 10}, 0, 0);`,
				'\tdisplay: flex;',
				'}',
				'',
			].join('\n'),
		);
	}

	await fs.writeFile(
		path.join(partialsDir, 'util.ts'),
		[
			'export function greet(name: string): string {',
			'\treturn `Hello, ${name}!`;',
			'}',
			'',
		].join('\n'),
	);
	for (let i = 0; i < SCRIPT_COUNT; i++) {
		await fs.writeFile(
			path.join(inputDir, 'js', `main-${i}.ts`),
			[
				"import { greet } from '../../partials/util';",
				'',
				`console.log(greet('page-${i}'));`,
				'',
			].join('\n'),
		);
	}

	return { rootDir, inputDir, outputDir, layoutsDir, dataDir };
}
