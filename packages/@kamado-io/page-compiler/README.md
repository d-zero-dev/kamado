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
- `transformBreadcrumbItem`: Function to transform each breadcrumb item. Can add custom properties to breadcrumb items. `(item: BreadcrumbItem) => BreadcrumbItem`
- `transformNavNode`: Function to transform each navigation node. Can add custom properties or filter nodes by returning `null`/`undefined`. `(node: NavNode) => NavNode | null | undefined`
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

## Development Transform Utilities

The page-compiler package provides utilities for Kamado's Transform API, which allows you to modify response content during both development server mode and build time.

### Available Utilities

#### injectToHead

Inject content into the HTML `<head>` element. Useful for adding development scripts, meta tags, or stylesheets during local development.

```ts
import { injectToHead } from '@kamado-io/page-compiler/transform/inject-to-head';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	devServer: {
		transforms: [
			injectToHead({
				content: '<script src="/__dev-tools.js"></script>',
				position: 'head-end', // or 'head-start'
			}),
		],
	},
};
```

**Options:**

- `content`: String or function that returns the content to inject
- `position`: `'head-start'` (after `<head>`) or `'head-end'` (before `</head>`, default)
- `name`: Optional name for debugging (default: `'inject-to-head'`)
- `filter`: Optional filter options
  - `include`: Glob pattern(s) to include (default: `'**/*.html'`)
  - `exclude`: Glob pattern(s) to exclude

**Customizing with spread syntax:**

```ts
transforms: [
	{
		...injectToHead({ content: '<script src="/dev.js"></script>' }),
		name: 'my-custom-inject',
		filter: { include: '**/*.htm' },
	},
];
```

#### createSSIShim

Implement pseudo Server Side Includes (SSI) for development. Processes `<!--#include virtual="/path/to/file.html" -->` directives and replaces them with file content.

```ts
import { createSSIShim } from '@kamado-io/page-compiler/transform/ssi-shim';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	devServer: {
		transforms: [createSSIShim()],
	},
};
```

**Usage in HTML:**

```html
<!DOCTYPE html>
<html>
	<head>
		<title>My Page</title>
	</head>
	<body>
		<!--#include virtual="/header.html" -->
		<main>Content here</main>
		<!--#include virtual="/footer.html" -->
	</body>
</html>
```

**Options:**

- `name`: Optional name for debugging (default: `'ssi-shim'`)
- `filter`: Optional filter options
  - `include`: Glob pattern(s) to include (default: `'**/*.html'`)
  - `exclude`: Glob pattern(s) to exclude
- `dir`: Server document root path to simulate. When specified, virtual paths are treated as absolute paths from this document root, and the relative portion is resolved against the output directory. Useful for simulating production server paths.
- `onError`: Custom error handler `(includePath: string, error: unknown) => string | Promise<string>`

**With custom error handling:**

```ts
createSSIShim({
	onError: (path, error) => {
		console.error(`Failed to include ${path}:`, error);
		return `<!-- Failed to include: ${path} -->`;
	},
});
```

**Simulating server document root:**

```ts
createSSIShim({
	dir: '/home/www/document_root/',
});
// In HTML: <!--#include virtual="/home/www/document_root/includes/header.html" -->
// Will read from: {output}/includes/header.html
```

### Using Transform Utilities in Build Time

Transform utilities can also be used during build time via the `beforeSerialize` hook. The hook receives a `TransformContext` as its third parameter, allowing you to use transform utilities in both development and build contexts.

**Example: Using injectToHead in beforeSerialize**

```ts
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';
import type { PageCompilerOptions } from '@kamado-io/page-compiler';

const pageCompilerOptions: PageCompilerOptions = {
	beforeSerialize: async (content, isServe, context) => {
		// Apply injectToHead transform
		const injectTransform = createInjectToHeadTransform({
			content: isServe
				? '<script src="/__dev-tools.js"></script>'
				: '<meta name="build-time" content="' + Date.now() + '">',
		});

		return await injectTransform(content, context);
	},
};
```

**Example: Using createSSIShim in beforeSerialize**

```ts
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';
import type { PageCompilerOptions } from '@kamado-io/page-compiler';

const pageCompilerOptions: PageCompilerOptions = {
	beforeSerialize: async (content, isServe, context) => {
		// Apply SSI shim transform
		const ssiTransform = createSSIShimTransform({
			onError: (path) => `<!-- Failed to include: ${path} -->`,
		});

		return await ssiTransform(content, context);
	},
};
```

**Example: Combining multiple transforms**

```ts
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';
import type { PageCompilerOptions } from '@kamado-io/page-compiler';

const pageCompilerOptions: PageCompilerOptions = {
	beforeSerialize: async (content, isServe, context) => {
		// Apply SSI first
		const ssiTransform = createSSIShimTransform();
		let result = await ssiTransform(content, context);

		// Then inject to head
		const injectTransform = createInjectToHeadTransform({
			content: '<meta name="generator" content="Kamado">',
		});
		result = await injectTransform(result, context);

		return result;
	},
};
```

### Advanced: Transform Functions

For advanced use cases, you can use the lower-level transform functions to create custom `ResponseTransform` objects:

```ts
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';

export const config: UserConfig = {
	devServer: {
		transforms: [
			{
				name: 'my-custom-transform',
				filter: { include: '**/*.html', contentType: 'text/html' },
				transform: createInjectToHeadTransform({
					content: '<script src="/__dev.js"></script>',
					position: 'head-end',
				}),
			},
		],
	},
};
```

These functions return the raw transform function `(content, context) => Promise<string | ArrayBuffer>` without the name and filter configuration, allowing you to create fully custom `ResponseTransform` objects.

## Standalone API: formatHtml

The `formatHtml` function is available as a standalone API for formatting HTML content outside of the Kamado build system.

### Import

```ts
import { formatHtml, type FormatHtmlOptions } from '@kamado-io/page-compiler/format';
```

### Usage

```ts
const formattedHtml = await formatHtml({
	content: '<html><body><h1>Hello</h1></body></html>',
	inputPath: '/project/src/pages/about.html',
	outputPath: '/project/dist/pages/about.html',
	outputDir: '/project/dist', // Root output directory, not /project/dist/pages
	url: 'https://example.com',
	imageSizes: true,
	prettier: true,
	minifier: true,
	isServe: false,
});
```

### FormatHtmlOptions

- `content` (required): HTML content to format
- `inputPath` (required): Input file path (used for Prettier config resolution)
- `outputPath` (required): Output file path. Full path to the output file (e.g., `/dist/pages/about.html`)
- `outputDir` (required): Output directory root. Base directory for the build output (e.g., `/dist`). Used as the root for relative path calculations and image size detection. Note: This is NOT `path.dirname(outputPath)` - it's the root output directory that may be several levels up from the output file
- `url` (optional): JSDOM URL configuration for DOM operations
- `beforeSerialize` (optional): Hook function called before DOM serialization `(content: string, isServe: boolean) => Promise<string> | string`
- `afterSerialize` (optional): Hook function called after DOM serialization `(elements: readonly Element[], window: Window, isServe: boolean) => Promise<void> | void`
- `imageSizes` (optional): Configuration for automatically adding width/height attributes to images (default: `true`)
- `characterEntities` (optional): Whether to enable character entity conversion
- `prettier` (optional): Prettier options (default: `true`)
- `minifier` (optional): HTML minifier options (default: `true`)
- `lineBreak` (optional): Line break configuration (`'\n'` or `'\r\n'`)
- `replace` (optional): Final HTML content replacement processing `(content: string, paths: Paths, isServe: boolean) => Promise<string> | string`
- `isServe` (optional): Whether running on development server (default: `false`)

## License

MIT
