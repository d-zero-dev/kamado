/**
 * Deterministic JSX fixture generator for v2/v3 comparison and the 100k-page
 * benchmark.
 *
 * Why synthetic and seeded: the harness compares v2 and v3 output byte for
 * byte, so the same `--pages` and `--seed` must always produce the same tree.
 * Real client sites are never committed; this fixture models their shape
 * instead (a shared layout, shared components, lists, tables, images that
 * need `width`/`height`, inline JSON-LD, a few CSS and script entries).
 *
 * Usage: node benchmarks/v3/generate-jsx-fixtures.ts --pages=1000 [--seed=1] [--out=dir]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/**
 * mulberry32: small, fast, deterministic PRNG.
 * @param initial
 */
function createRandom(initial: number) {
	let a = initial >>> 0;
	return () => {
		a = (a + 0x6d_2b_79_f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
	};
}

const WORDS =
	'static site generator build page template layout component section list table image heading paragraph link navigation footer header content article news sample dummy text lorem ipsum dolor amet'.split(
		' ',
	);

/**
 * 1x1 PNG with IHDR width/height patched (image-size reads IHDR only).
 * @param width
 * @param height
 */
function png(width: number, height: number): Buffer {
	const base = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
		'base64',
	);
	base.writeUInt32BE(width, 16);
	base.writeUInt32BE(height, 20);
	return base;
}

export type GenerateOptions = {
	/** Number of pages (positive integer). */
	readonly pages: number;
	/** PRNG seed: the same seed and page count always produce the same tree. */
	readonly seed: number;
	/** Output directory (created if missing). */
	readonly outDir: string;
};

/**
 * Writes the fixture tree.
 * @param options
 * @param options.pages
 * @param options.seed
 * @param options.outDir
 * @example
 * generateJsxFixtures({ pages: 100, seed: 1, outDir: '/tmp/fx' });
 */
export function generateJsxFixtures({ pages, seed, outDir }: GenerateOptions): void {
	if (!Number.isInteger(pages) || pages < 1) {
		throw new Error(`pages must be a positive integer: ${pages}`);
	}
	if (!Number.isInteger(seed)) {
		throw new TypeError(`seed must be an integer: ${seed}`);
	}

	const write = (rel: string, content: string | Buffer) => {
		const file = path.join(outDir, rel);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, content);
	};

	write('input/img/a.png', png(320, 200));
	write('input/img/b.png', png(640, 360));
	write('input/img/c.png', png(100, 100));

	write(
		'input/_libs/data/site.json',
		JSON.stringify(
			{ name: 'Bench', description: 'Synthetic benchmark site' },
			null,
			'\t',
		) + '\n',
	);

	write(
		'input/_libs/layouts/default.tsx',
		`import { Header } from '../components/header.tsx';
import { Footer } from '../components/footer.tsx';

export default function Layout(props: { content: string; title: string; description: string }) {
	return (
		<html lang="ja">
			<head>
				<meta charSet="utf-8" />
				<title>{props.title} | Bench</title>
				<meta name="description" content={props.description} />
				<link rel="stylesheet" href="/css/style.css" />
			</head>
			<body>
				<Header />
				<main dangerouslySetInnerHTML={{ __html: props.content }} />
				<Footer />
				<script src="/js/app.js" defer></script>
			</body>
		</html>
	);
}
`,
	);

	write(
		'input/_libs/components/header.tsx',
		`export function Header() {
	return (
		<header className="l-header">
			<a href="/" className="l-header__logo">
				<img src="/img/c.png" alt="Bench" />
			</a>
			<nav className="l-header__nav">
				<ul>
					<li><a href="/about/">About</a></li>
					<li><a href="/news/">News</a></li>
					<li><a href="/contact/">Contact</a></li>
				</ul>
			</nav>
		</header>
	);
}
`,
	);

	write(
		'input/_libs/components/footer.tsx',
		`export function Footer() {
	return (
		<footer className="l-footer">
			<p>&copy; Bench</p>
			<a href="https://example.com/" target="_blank" rel="noopener">example.com</a>
		</footer>
	);
}
`,
	);

	write(
		'input/_libs/components/card.tsx',
		`export function Card(props: { title: string; text: string; image: string; width?: number }) {
	return (
		<article className="c-card">
			<img src={props.image} alt="" />
			<h3 className="c-card__title">{props.title}</h3>
			<p className="c-card__text">{props.text}</p>
		</article>
	);
}
`,
	);

	write(
		'input/_libs/components/table.tsx',
		`export function DataTable(props: { rows: readonly (readonly string[])[] }) {
	return (
		<table className="c-table">
			<thead>
				<tr><th>Name</th><th>Value</th><th>Note</th></tr>
			</thead>
			<tbody>
				{props.rows.map((row, i) => (
					<tr key={i}>
						{row.map((cell, j) => (
							<td key={j}>{cell}</td>
						))}
					</tr>
				))}
			</tbody>
		</table>
	);
}
`,
	);

	for (let i = 0; i < 5; i++) {
		write(
			`input/css/part-${i}.css`,
			`.part-${i} { color: #${(i * 2 + 1).toString(16).repeat(6)}; margin: 0px auto; padding: 0.50em 1.0em; font-weight: normal; }\n.part-${i} a:hover { text-decoration: underline; }\n@media (min-width: ${480 + i * 100}px) { .part-${i} { display: block; } }\n`,
		);
	}
	write(
		'input/css/style.css',
		`/*! bench */\n${[0, 1, 2, 3, 4].map((i) => `@import "./part-${i}.css";`).join('\n')}\nbody { margin: 0; font-family: sans-serif; }\n`,
	);
	write(
		'input/js/app.ts',
		`import { greet } from './greet.ts';\nconst el: HTMLElement | null = document.querySelector('main');\nif (el) { el.dataset.ready = greet('bench'); }\n`,
	);
	write(
		'input/js/greet.ts',
		`export function greet(name: string): string {\n\treturn \`hello \${name}\`;\n}\n`,
	);

	const random = createRandom(seed);
	const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
	const sentence = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
	const images = ['/img/a.png', '/img/b.png', '/img/c.png'];

	for (let i = 0; i < pages; i++) {
		const id = String(i).padStart(String(pages - 1).length, '0');
		const cards = Array.from({ length: 6 }, () => ({
			title: sentence(3),
			text: sentence(14),
			image: pick(images),
		}));
		const rows = Array.from({ length: 8 }, () => [
			sentence(1),
			String(Math.floor(random() * 1000)),
			sentence(3),
		]);
		const sections = Array.from({ length: 4 }, () => ({
			heading: sentence(4),
			body: sentence(40),
		}));
		const dir = `section-${i % 100}`;
		write(
			`input/pages/${dir}/page-${id}.tsx`,
			`import { Card } from '../../_libs/components/card.tsx';
import { DataTable } from '../../_libs/components/table.tsx';

export const meta = {
	title: ${JSON.stringify(sentence(4))},
	description: ${JSON.stringify(sentence(12))},
	layout: 'default',
} as const;

const cards = ${JSON.stringify(cards)};
const rows = ${JSON.stringify(rows)};

export default function Page() {
	return (
		<>
			<h1>{meta.title}</h1>
			{${JSON.stringify(sections)}.map((s, i) => (
				<section key={i} className="p-section">
					<h2>{s.heading}</h2>
					<p>{s.body}</p>
				</section>
			))}
			<div className="p-cards">
				{cards.map((c, i) => (
					<Card key={i} title={c.title} text={c.text} image={c.image} />
				))}
			</div>
			<DataTable rows={rows} />
			<script type="application/ld+json">
				{JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: meta.title })}
			</script>
		</>
	);
}
`,
		);
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const { values } = parseArgs({
		options: {
			pages: { type: 'string', default: '1000' },
			seed: { type: 'string', default: '1' },
			out: { type: 'string' },
		},
	});
	const pages = Number(values.pages);
	const seed = Number(values.seed);
	const outDir = path.resolve(
		values.out ?? path.join(import.meta.dirname, '.bench', `fixtures-${pages}`),
	);
	generateJsxFixtures({ pages, seed, outDir });
	console.log(`generated ${pages} pages (seed ${seed}) in ${outDir}`);
}
