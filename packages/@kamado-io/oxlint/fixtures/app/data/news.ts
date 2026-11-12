import { readFile } from 'node:fs/promises';

// A file of data.dir runs before the pages: it may read, fetch and wait.
const response = await fetch('https://example.com/news.json');
export const news = await response.json();

export default async function load() {
	return JSON.parse(await readFile('news.json', 'utf8'));
}
