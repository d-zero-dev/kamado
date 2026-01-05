# @kamado-io/page-compiler

Page compiler for Kamado. A generic container compiler that applies layouts and formats the output. Template compilation is handled via `compileHooks`.

## Installation

```bash
npm install @kamado-io/page-compiler
# or
yarn add @kamado-io/page-compiler
```

## Usage

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	compilers: [
		pageCompiler({
			globalData: {
				dir: './data',
			},
			layouts: {
				dir: './layouts',
			},
			imageSizes: true,
		}),
	],
};
```

## Options

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.html'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.tmp'` will ignore all `.tmp` files.
- `outputExtension` (optional): Output file extension (default: `'.html'`)
- `globalData`: Global data configuration
  - `dir`: Directory path where global data files are stored
  - `data`: Additional global data
- `layouts`: Layout file configuration
  - `dir`: Directory path where layout files are stored
  - `files`: Map of layout files
  - `contentVariableName`: Variable name for content in layout (default: `'content'`)
- `imageSizes`: Configuration for automatically adding width/height attributes to images (default: `true`)
- `minifier`: HTML minifier options (default: `true`)
- `prettier`: Prettier options (default: `true`)
- `lineBreak`: Line break configuration (`'\n'` or `'\r\n'`)
- `characterEntities`: Whether to enable character entity conversion
- `optimizeTitle`: Function to optimize titles
- `host`: Host URL for JSDOM's url option. If not specified, in build mode uses `production.baseURL` or `production.host` from package.json, in serve mode uses dev server URL (`http://${devServer.host}:${devServer.port}`)
- `beforeSerialize`: Hook function called before DOM serialization `(content: string, isServe: boolean) => Promise<string> | string`
- `afterSerialize`: Hook function called after DOM serialization `(elements: readonly Element[], window: Window, isServe: boolean) => Promise<void> | void`
- `replace`: Final HTML content replacement processing `(content: string, paths: Paths, isServe: boolean) => Promise<string> | string`
- `compileHooks`: Compilation hooks for customizing compile process
  - Can be an object or a function `(options: PageCompilerOptions) => CompileHooksObject | Promise<CompileHooksObject>` that returns an object (sync or async)
  - `main`: Hooks for main content compilation
    - `before`: Hook called before compilation (receives content and data, returns processed content)
    - `after`: Hook called after compilation (receives HTML and data, returns processed HTML)
    - `compiler`: Custom compiler function `(content: string, data: CompileData, extension: string) => Promise<string> | string`
  - `layout`: Hooks for layout compilation
    - `before`: Hook called before compilation (receives content and data, returns processed content)
    - `after`: Hook called after compilation (receives HTML and data, returns processed HTML)
    - `compiler`: Custom compiler function `(content: string, data: CompileData, extension: string) => Promise<string> | string`

**Note**: To use Pug templates, install `@kamado-io/pug-compiler` and use `createCompileHooks` helper. See the [@kamado-io/pug-compiler README](../@kamado-io/pug-compiler/README.md) for integration examples.

## Example: Using compileHooks

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	compilers: [
		pageCompiler({
			compileHooks: {
				main: {
					before: (content, data) => {
						// Pre-process content before compilation
						return content.replace(/<!--.*?-->/g, '');
					},
					after: (html, data) => {
						// Post-process HTML after compilation
						return html.replace(/<br\s*\/?>/g, '<br />');
					},
				},
				layout: {
					compiler: async (content, data, extension) => {
						// Use custom compiler for layouts
						// extension is the file extension (e.g., '.pug', '.html')
						return await myCustomCompiler(content, data, extension);
					},
				},
			},
		}),
	],
};
```

## License

MIT
