# Kamado

[![npm version](https://badge.fury.io/js/kamado.svg)](https://www.npmjs.com/package/kamado)

![kamado](https://cdn.jsdelivr.net/gh/d-zero-dev/kamado@main/assets/kamado_logo.png)

**Kamado is an extremely simple static site build tool.** No hydration, no client-side runtime, no magic. **No runtime needed**, just the file system and raw HTML. Baked on demand. Thoroughly baked in a Kamado, that is what Kamado is.

## Project Overview

- 🏗️ [Kamado Architecture](./ARCHITECTURE.md) | [Internal Architecture (JA)](./ARCHITECTURE.ja.md)

Kamado is a static site build tool similar to 11ty, but aims for a simpler design. It is a tool for those who stick to the legacy, old-school ways of building.

**The biggest feature of Kamado is that it requires absolutely no runtime.** No client-side runtime (hydration) is needed. Because it generates pure static HTML, it achieves persistence and robustness. It generates HTML that will work just the same 10 years, or even 20 years from now.

Modern frameworks like Astro or Next.js require a runtime. Kamado does not depend on a runtime and generates pure static HTML. It is a tool for developers who prefer legacy approaches and do not want to depend on a runtime.

## Key Features

### No Runtime Required

The biggest feature of Kamado is that it **requires absolutely no runtime**. No client-side runtime (hydration) is needed. Only pure static HTML is generated. This ensures persistence and robustness. You won't be troubled by runtime version upgrades or security patches.

### Use with esbuild/vite

Leave CSS and JavaScript to esbuild or vite, and Kamado will focus on managing HTML. This allows development that leverages the strengths of each tool.

### On-Demand Build System

The development server builds only the necessary files when they are accessed. With the transpile-on-demand method, it works comfortably even on sites with 10,000 pages. A lean design that bakes only what is needed.

### Large-Scale Site Support

Mapping management via a page tree allows for efficient builds even on large-scale sites.

### Rich Logging and Parallel Builds

Kamado adopts parallel build processing. What is happening during the build is clearly output to the console. You can check the build status of each file in real-time, and progress is obvious at a glance. Parallel processing also improves build speed.

## Development Server

### Hono-based Lightweight Server

**Fire up the Kamado with Hono 🔥**

### Transpile-on-Demand Method

If a server request matches a destination path, it builds starting from the requested file in a chain reaction. There is no need to watch dependency files; only the necessary files are automatically built.

### No File Watching

It doesn't use `Chokidar` and doesn't do live reload. During development, only server requests from browser reloads trigger builds.

### Mapping Management via Page Tree

The page tree holds the source file paths and destination paths. Since mapping is managed at this point, if a server request matches a destination path, only the source file needs to be built.

## Basic Usage

### Installation

```bash
npm install kamado
# or
yarn add kamado
```

### Configuration File

Create `kamado.config.ts` in the project root:

```ts
import type { UserConfig } from 'kamado/config';

import path from 'node:path';

import { pageCompiler } from '@kamado-io/page-compiler';
import { scriptCompiler } from '@kamado-io/script-compiler';
import { styleCompiler } from '@kamado-io/style-compiler';

export const config: UserConfig = {
	dir: {
		root: import.meta.dirname,
		input: path.resolve(import.meta.dirname, '__assets', 'htdocs'),
		output: path.resolve(import.meta.dirname, 'htdocs'),
	},
	devServer: {
		open: true,
		port: 8000,
	},
	compilers: [
		pageCompiler({
			files: '**/*.{html,pug}',
			outputExtension: '.html',
			globalData: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'data'),
			},
			layouts: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'layouts'),
			},
			// Transform pipeline (optional, defaults to defaultPageTransforms)
			// See @kamado-io/page-compiler documentation for customization
		}),
		styleCompiler({
			files: '**/*.{css,scss,sass}',
			ignore: '**/*.{scss,sass}',
			outputExtension: '.css',
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
		scriptCompiler({
			files: '**/*.{js,ts,jsx,tsx,mjs,cjs}',
			outputExtension: '.js',
			minifier: true,
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
	],
	async onBeforeBuild(context) {
		// Process before build
		// context.mode is available: 'build' or 'serve'
	},
	async onAfterBuild(context) {
		// Process after build
		// context.mode is available: 'build' or 'serve'
	},
};

export default config;
```

### Configuration Description

#### Directory Settings

- `dir.root`: Project root directory
- `dir.input`: Source file directory
- `dir.output`: Output directory

#### Development Server Settings

- `devServer.port`: Server port number (default: `3000`)
- `devServer.host`: Server host name (default: `localhost`)
- `devServer.open`: Whether to automatically open the browser on startup (default: `false`)
- `devServer.startPath`: Custom path to open in the browser when starting the server (optional, e.g., `'__tmpl/'`)
- `devServer.transforms`: Array of response transformation functions that modify responses during development (optional, see [Response Transform API](#response-transform-api))

#### Compiler Settings

The `compilers` array defines how files are compiled. Each entry is a compiler function call that returns a compiler with metadata. The compiler function accepts optional options including:

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input`. Default values are provided by each compiler (see below).
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.scss'` will ignore all `.scss` files in the input directory and subdirectories.
- `outputExtension` (optional): Output file extension (e.g., `.html`, `.css`, `.js`, `.php`). Default values are provided by each compiler (see below).
- Other compiler-specific options (see each compiler's documentation below)

The order of entries in the array determines the processing order.

##### pageCompiler

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.html'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.tmp'` will ignore all `.tmp` files.
- `outputExtension` (optional): Output file extension (default: `'.html'`)
- `globalData.dir`: Global data file directory
- `globalData.data`: Additional global data
- `layouts.dir`: Layout file directory
- `compileHooks`: Compilation hooks for customizing compile process (required for Pug templates)
- `transforms`: Array of transform functions to apply to compiled HTML. If omitted, uses `defaultPageTransforms`. See [@kamado-io/page-compiler](../packages/@kamado-io/page-compiler/README.md) for details on the Transform Pipeline API.

**Note**: `page-compiler` is a generic container compiler and does not compile Pug templates by default. To use Pug templates, install `@kamado-io/pug-compiler` and configure `compileHooks`. See [@kamado-io/pug-compiler README](../@kamado-io/pug-compiler/README.md) for details.

**Example**: To compile `.pug` files to `.html`:

```ts
pageCompiler({
	files: '**/*.pug',
	outputExtension: '.html',
	compileHooks: {
		main: {
			compiler: compilePug(),
		},
	},
});
```

##### styleCompiler

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.css'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.{scss,sass}'` will ignore all `.scss` and `.sass` files.
- `outputExtension` (optional): Output file extension (default: `'.css'`)
- `alias`: Path alias map (used in PostCSS `@import`)
- `banner`: Banner configuration (can specify CreateBanner function or string)

**Example**: To compile `.scss` files to `.css` while ignoring source files:

```ts
styleCompiler({
	files: '**/*.{css,scss,sass}',
	ignore: '**/*.{scss,sass}',
	outputExtension: '.css',
	alias: {
		'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
	},
});
```

##### scriptCompiler

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.{js,ts,jsx,tsx,mjs,cjs}'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.test.ts'` will ignore all test files.
- `outputExtension` (optional): Output file extension (default: `'.js'`)
- `alias`: Path alias map (esbuild alias)
- `minifier`: Whether to enable minification
- `banner`: Banner configuration (can specify CreateBanner function or string)

**Example**: To compile TypeScript files to JavaScript:

```ts
scriptCompiler({
	files: '**/*.{js,ts,jsx,tsx}',
	outputExtension: '.js',
	minifier: true,
	alias: {
		'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
	},
});
```

#### Page List Configuration

The `pageList` option allows you to customize the page list used for navigation, breadcrumbs, and other features that require a list of pages.

```ts
import { urlToFile, getFile } from 'kamado/files';

export const config: UserConfig = {
	// ... other config
	pageList: async (pageAssetFiles, config) => {
		// Filter pages (e.g., exclude drafts)
		const filtered = pageAssetFiles.filter((page) => !page.url.includes('/drafts/'));

		// Add external pages with custom metadata
		const externalPage = {
			...urlToFile('/external-page/', {
				inputDir: config.dir.input,
				outputDir: config.dir.output,
				outputExtension: '.html',
			}),
			metaData: { title: 'External Page Title' },
		};

		return [...filtered, externalPage];
	},
};
```

The function receives:

- `pageAssetFiles`: Array of all page files found in the file system
- `config`: The full configuration object

Returns an array of `PageData` objects (extends `CompilableFile` with optional `metaData`).

**Note about `metaData` and titles:**

- During individual page compilation, `metaData` is automatically populated from frontmatter
- However, at `pageList` hook time (globalData collection), `metaData` is NOT yet populated
- If you need titles for breadcrumbs/navigation, you must explicitly set `metaData.title` in the `pageList` hook
- Without explicit `metaData.title`, breadcrumbs and navigation will show `__NO_TITLE__`

#### Hook Functions

- `onBeforeBuild`: Function executed before build. Receives `Context` (which extends `Config` with `mode: 'build' | 'serve'`)
- `onAfterBuild`: Function executed after build. Receives `Context` (which extends `Config` with `mode: 'build' | 'serve'`)

#### Response Transform API

The Response Transform API allows you to modify response content during development server mode. This is useful for injecting scripts, implementing pseudo-SSI, adding meta tags, or any other response transformation needs.

**Important Distinction:**

Both use the same `Transform` interface (`kamado/config`), but differ in scope and application:

- **`devServer.transforms`**: Applied to ALL responses during development server mode only (`kamado server`). Middleware-style transforms that can process any file type (HTML, CSS, JS, images, etc.). The `filter` option (include/exclude) is respected here. Does not run during builds.
- **`pageCompiler({ transforms })`**: Applied to compiled HTML pages in both build and serve modes. Transform pipeline for HTML processing only. The `filter` option is ignored (all HTML pages are processed). See [@kamado-io/page-compiler](../packages/@kamado-io/page-compiler/README.md) for details.

You can reuse the same transform functions (like `manipulateDOM()`, `prettier()`, or custom transforms) in both places.

**Key Features:**

- **Development-only**: Transforms only apply in `serve` mode, not during builds
- **Flexible filtering**: Filter by glob patterns (include/exclude)
- **Error resilient**: Errors in transform functions don't break the server
- **Async support**: Supports both synchronous and asynchronous transform functions
- **Chainable**: Multiple transforms are applied in array order

**Configuration:**

```typescript
import type { UserConfig } from 'kamado/config';
import path from 'node:path';
import fs from 'node:fs/promises';

export const config: UserConfig = {
	devServer: {
		port: 3000,
		transforms: [
			// Example 1: Inject development script into HTML
			{
				name: 'inject-dev-script',
				filter: {
					include: '**/*.html',
				},
				transform: (content) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}
					return content.replace(
						'</body>',
						'<script src="/__dev-tools.js"></script></body>',
					);
				},
			},

			// Example 2: Implement pseudo-SSI (Server Side Includes)
			{
				name: 'pseudo-ssi',
				filter: {
					include: '**/*.html',
				},
				transform: async (content, ctx) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}

					// Process <!--#include virtual="/path/to/file.html" -->
					const includeRegex = /<!--#include virtual="([^"]+)" -->/g;
					let result = content;

					for (const match of content.matchAll(includeRegex)) {
						const includePath = match[1];
						const filePath = path.resolve(
							ctx.context.dir.output,
							includePath.replace(/^\//, ''),
						);

						try {
							const includeContent = await fs.readFile(filePath, 'utf-8');
							result = result.replace(match[0], includeContent);
						} catch (error) {
							console.warn(`Failed to include ${includePath}:`, error);
						}
					}

					return result;
				},
			},

			// Example 3: Add source comment to CSS files
			{
				name: 'css-source-comment',
				filter: {
					include: '**/*.css',
				},
				transform: (content, ctx) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}
					const source = ctx.inputPath || ctx.outputPath;
					return `/* Generated from: ${source} */\n${content}`;
				},
			},
		],
	},
};
```

**ResponseTransform Interface:**

```typescript
interface ResponseTransform {
	name?: string; // Transform name for debugging
	filter?: {
		include?: string | string[]; // Glob patterns to include
		exclude?: string | string[]; // Glob patterns to exclude
	};
	transform: (
		content: string | ArrayBuffer,
		context: TransformContext,
	) => Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

interface TransformContext {
	path: string; // Request path
	inputPath?: string; // Original input file path (if available)
	outputPath: string; // Output file path
	isServe: boolean; // Always true in dev server
	context: Context; // Full execution context
}
```

**Filter Options:**

- `include`: Glob pattern(s) to match request paths (e.g., `'**/*.html'`, `['**/*.css', '**/*.js']`)
- `exclude`: Glob pattern(s) to exclude (e.g., `'**/_*.html'` to skip files starting with `_`)

**Important Notes:**

- Transform functions receive either `string` or `ArrayBuffer`. For text-based transformations, decode `ArrayBuffer` using `TextDecoder`:
  ```typescript
  if (typeof content !== 'string') {
  	const decoder = new TextDecoder('utf-8');
  	content = decoder.decode(content);
  }
  ```
- Static files (non-compiled files) are typically passed as `ArrayBuffer`, so always decode them if you need to process as text
- Errors in transform functions are logged but don't break the server (original content is returned)
- Transforms are executed in array order
- Only applied in development server mode (`kamado server`), not during builds

### CLI Commands

#### Build Entire Site

```bash
kamado build
```

#### Build Specific Files Only

```bash
kamado build "path/to/file.pug" # Build a specific file
kamado build "path/to/*.css" # Build only CSS files
kamado build "path/to/*.ts" # Build only TypeScript files
```

#### Start Development Server

```bash
kamado server
```

When the development server starts, pages accessed via the browser are built on demand. If there is a request, it bakes it on the spot and returns it.

### CLI Options

The following options are available for all commands:

| Option            | Short | Description                                                                                                        |
| ----------------- | ----- | ------------------------------------------------------------------------------------------------------------------ |
| `--config <path>` | `-c`  | Path to a specific config file. If not specified, Kamado searches for `kamado.config.js`, `kamado.config.ts`, etc. |
| `--verbose`       |       | Enable verbose logging                                                                                             |

#### Examples

```bash
# Use a specific config file
kamado build --config ./custom.config.ts
kamado server -c ./dev.config.js

# Enable verbose logging during build
kamado build --verbose
```
