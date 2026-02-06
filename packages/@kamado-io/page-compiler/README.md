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
import { defineConfig } from 'kamado/config';
import { pageCompiler } from '@kamado-io/page-compiler';

export default defineConfig({
	compilers: [
		pageCompiler({
			globalData: {
				dir: './data',
			},
			layouts: {
				dir: './layouts',
			},
			// Transform pipeline is configured via transforms option
			// If omitted, uses defaultPageTransforms
		}),
	],
});
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
- `transforms`: Transform functions to apply to compiled HTML in both build and serve modes. Can be:
  - `Transform[]` - Array of transform functions (uses `kamado/config` Transform interface)
  - `(defaultTransforms: readonly Transform[]) => Transform[]` - Function that receives default transforms (5 transforms) and returns modified array
  - If omitted, uses `defaultPageTransforms` (5 transforms: manipulateDOM, doctype, prettier, minifier, lineBreak). See [Transform Pipeline](#transform-pipeline) for details.
  - **Note**: Uses the same `Transform` interface as `devServer.transforms`, but applies only to HTML pages in both build and serve modes. The `filter` option is ignored here (use `devServer.transforms` for filtering).
- `transformBreadcrumbItem`: Function to transform each breadcrumb item. Can add custom properties to breadcrumb items. `(item: BreadcrumbItem) => BreadcrumbItem`
- `filterNavigationNode`: Function to filter navigation nodes. Return `true` to keep the node, `false` to remove it. `(node: NavNode) => boolean`
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

## Transform Pipeline

The page compiler uses a Transform Pipeline to process HTML content after compilation. Each transform is an object with a `name` and `transform` function that receives content and contextual information.

### Transform Interface

```typescript
interface Transform {
	readonly name: string;
	readonly filter?: {
		// Note: filter is ignored in pageCompiler transforms
		readonly include?: string | readonly string[];
		readonly exclude?: string | readonly string[];
	};
	readonly transform: (
		content: string | ArrayBuffer,
		context: TransformContext,
	) => Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

interface TransformContext {
	path: string; // Request path relative to output directory
	filePath: string; // Same as path (for compatibility)
	inputPath?: string; // Original input file path (always provided by pageCompiler)
	outputPath: string; // Output file path
	outputDir: string; // Output directory path
	isServe: boolean; // true in serve mode, false in build mode
	context: Context; // Kamado Context (Config + mode)
	compile: CompileFunction; // Function to compile other files
}
```

**Note**: The `Transform` interface is shared with `devServer.transforms` (from `kamado/config`). However, the `filter` option is only effective in `devServer.transforms` and is ignored when used in `pageCompiler({ transforms })`. All HTML pages are processed regardless of filter settings.

### Transform Factory Functions

The package provides **6 transform factory functions** (5 included in default pipeline):

1. **`manipulateDOM(options?)`** - DOM manipulation (includes imageSizes integration)
   - `options.hook`: Custom DOM manipulation function
     ```typescript
     (
       elements: readonly Element[],
       window: Window,
       context: TransformContext
     ) => Promise<void> | void
     ```
   - `options.imageSizes`: Enable/configure automatic image size detection (default: `true`)
     - `boolean` - `true` to enable with defaults, `false` to disable
     - `ImageSizesOptions` object with properties:
       - `rootDir?: string` - Root directory for resolving image paths (defaults to `outputDir` from context)
       - `selector?: string` - CSS selector to filter target images (default: no filter, all `img` and `picture > source` elements are processed)
       - `ext?: readonly string[]` - Image extensions to process (default: `['png', 'jpg', 'jpeg', 'webp', 'avif', 'svg']`)
     - Note: Width and height attributes are always set/overwritten, even if they already exist
     - Note: Uses kamado's `domSerialize` utility which preserves fragments as fragments and full documents as full documents
   - `options.host`: URL for DOM resolution context (defaults to `http://{devServer.host}:{devServer.port}` in serve mode, or production `baseURL`/`host` in build mode)

2. **`characterEntities(options?)`** - Convert characters to HTML entities
   - Converts non-ASCII characters (code points ≥ 127) to their HTML entity equivalents (e.g., `©` → `&copy;`)
   - **Note**: Not included in `defaultPageTransforms` - must be explicitly added if needed
   - No options currently available

3. **`doctype(options?)`** - Add DOCTYPE declaration
   - No options currently available

4. **`prettier(options?)`** - Format HTML with Prettier
   - `options.options`: Prettier configuration object
     ```typescript
     {
       printWidth?: number;
       tabWidth?: number;
       useTabs?: boolean;
       // ... other Prettier options
     }
     ```

5. **`minifier(options?)`** - Minify HTML
   - `options.options`: html-minifier-terser configuration object
     ```typescript
     {
       collapseWhitespace?: boolean;
       removeComments?: boolean;
       minifyCSS?: boolean;
       minifyJS?: boolean;
       // ... other minifier options
     }
     ```

6. **`lineBreak(options?)`** - Normalize line breaks
   - `options.lineBreak`: Line break style
     - `'\n'` (default) - Unix/Linux/macOS line breaks
     - `'\r\n'` - Windows line breaks

### Default Transform Pipeline

```typescript
import { defaultPageTransforms } from '@kamado-io/page-compiler';

// The default pipeline includes 5 transforms:
const defaultPageTransforms = [
	manipulateDOM({ imageSizes: true }), // 1. DOM manipulation
	doctype(), // 2. DOCTYPE injection
	prettier(), // 3. HTML formatting
	minifier(), // 4. HTML minification
	lineBreak(), // 5. Line break normalization
];
// Note: characterEntities() is NOT included by default
```

### Usage Examples

#### Using Default Transforms

```typescript
import { pageCompiler, defaultPageTransforms } from '@kamado-io/page-compiler';

pageCompiler({
	layouts: { dir: './layouts' },
	transforms: defaultPageTransforms, // Explicitly use defaults
});

// Or simply omit transforms to use defaults
pageCompiler({
	layouts: { dir: './layouts' },
	// transforms defaults to defaultPageTransforms
});
```

#### Extending Defaults with Function (Recommended)

Use a function to extend defaults without importing `defaultPageTransforms`:

```typescript
import { pageCompiler } from '@kamado-io/page-compiler';

pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) => [
		// Add custom transform before defaults
		{
			name: 'custom-preprocessing',
			transform: async (content) => {
				if (typeof content !== 'string') return content;
				return content.replace(/\{DATE\}/g, new Date().toISOString());
			},
		},
		...defaults,
		// Add custom transform after defaults
		{
			name: 'custom-analytics',
			transform: async (content) => {
				if (typeof content !== 'string') return content;
				return content.replace('</head>', '<script src="/analytics.js"></script></head>');
			},
		},
	],
});
```

#### Extending Defaults with Array (Requires Import)

```typescript
import { pageCompiler, defaultPageTransforms } from '@kamado-io/page-compiler';

// Add custom transform after defaults
pageCompiler({
	layouts: { dir: './layouts' },
	transforms: [
		...defaultPageTransforms,
		{
			name: 'custom-analytics',
			transform: async (content) => {
				if (typeof content !== 'string') return content;
				return content.replace('</head>', '<script src="/analytics.js"></script></head>');
			},
		},
	],
});
```

#### Custom Transform Selection

```typescript
import { pageCompiler, manipulateDOM, prettier } from '@kamado-io/page-compiler';

pageCompiler({
	layouts: { dir: './layouts' },
	transforms: [
		manipulateDOM({
			imageSizes: true,
			hook: async (elements, window, context) => {
				// Custom DOM manipulation
				const links = window.document.querySelectorAll('a[href^="http"]');
				links.forEach((link) => link.setAttribute('target', '_blank'));
			},
		}),
		prettier({ options: { printWidth: 120 } }),
	],
});
```

#### Customizing Specific Transforms

```typescript
import { pageCompiler, prettier, minifier } from '@kamado-io/page-compiler';

// Replace specific transforms using function
pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) =>
		defaults.map((t) => {
			if (t.name === 'prettier') {
				return prettier({ options: { printWidth: 120 } });
			}
			if (t.name === 'minifier') {
				return minifier({ options: { collapseWhitespace: true, removeComments: true } });
			}
			return t;
		}),
});
```

#### Filtering Transforms

```typescript
import { pageCompiler } from '@kamado-io/page-compiler';

// Remove specific transforms
pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) => defaults.filter((t) => t.name !== 'minifier'),
});
```

#### Adding Character Entities Transform

The `characterEntities` transform is not included in `defaultPageTransforms`. Add it explicitly if needed:

```typescript
import { pageCompiler, characterEntities } from '@kamado-io/page-compiler';

// Add characterEntities to the pipeline
pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) => [
		...defaults.slice(0, 1), // manipulateDOM
		characterEntities(), // Insert after DOM manipulation
		...defaults.slice(1), // doctype, prettier, minifier, lineBreak
	],
});
```

#### Environment-Specific Transforms

```typescript
import { pageCompiler, prettier, minifier } from '@kamado-io/page-compiler';

const isProduction = process.env.NODE_ENV === 'production';

pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) =>
		defaults.map((t) => {
			// Skip prettier in production
			if (t.name === 'prettier' && isProduction) {
				return prettier({ options: { printWidth: 200 } }); // Less formatting in prod
			}
			// Enhanced minification in production
			if (t.name === 'minifier' && isProduction) {
				return minifier({
					options: {
						collapseWhitespace: true,
						removeComments: true,
						minifyCSS: true,
						minifyJS: true,
					},
				});
			}
			return t;
		}),
});
```

#### Advanced: Custom Transform with imageSizes Configuration

```typescript
import { pageCompiler, manipulateDOM } from '@kamado-io/page-compiler';

pageCompiler({
	layouts: { dir: './layouts' },
	transforms: (defaults) => [
		// Replace manipulateDOM with custom configuration
		manipulateDOM({
			imageSizes: {
				rootDir: '/custom/root',
				selector: 'img[data-auto-size]', // Only process images with data attribute
				ext: ['png', 'jpg', 'webp'], // Process only specific formats
			},
			hook: async (elements, window) => {
				// Additional DOM manipulation
				const images = window.document.querySelectorAll('img');
				images.forEach((img) => {
					if (!img.getAttribute('loading')) {
						img.setAttribute('loading', 'lazy');
					}
				});
			},
		}),
		...defaults.slice(1), // Include remaining defaults
	],
});
```

## Example: Using compileHooks

```ts
import { defineConfig } from 'kamado/config';
import { pageCompiler } from '@kamado-io/page-compiler';

export default defineConfig({
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
});
```

## Development Transform Utilities

The page-compiler package provides utilities for Kamado's Transform API, which allows you to modify response content during both development server mode and build time.

### Available Utilities

#### injectToHead

Inject content into the HTML `<head>` element. Useful for adding development scripts, meta tags, or stylesheets during local development.

```ts
import { defineConfig } from 'kamado/config';
import { injectToHead } from '@kamado-io/page-compiler/transform/inject-to-head';

export default defineConfig({
	devServer: {
		transforms: [
			injectToHead({
				content: '<script src="/__dev-tools.js"></script>',
				position: 'head-end', // or 'head-start'
			}),
		],
	},
});
```

**Important:** The `devServer.transforms` array only applies during development server mode (`kamado server`). Transforms in this array are automatically applied to responses in serve mode only.

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
import { defineConfig } from 'kamado/config';
import { createSSIShim } from '@kamado-io/page-compiler/transform/ssi-shim';

export default defineConfig({
	devServer: {
		transforms: [createSSIShim()],
	},
});
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

### Using Transform Utilities in Page Transforms

Transform utilities can be used within the `manipulateDOM` hook or custom transforms. The utilities provide lower-level transform functions for advanced integration.

#### Example: Using injectToHead in manipulateDOM

```ts
import { manipulateDOM } from '@kamado-io/page-compiler';
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';

manipulateDOM({
	imageSizes: true,
	hook: async (elements, window, context) => {
		// Get the document HTML
		const html = window.document.documentElement.outerHTML;

		// Apply injectToHead transform
		const injectTransform = createInjectToHeadTransform({
			content: context.isServe
				? '<script src="/__dev-tools.js"></script>'
				: '<meta name="build-time" content="' + Date.now() + '">',
		});

		const result = await injectTransform(html, context);

		// Update document with result
		window.document.documentElement.outerHTML = result;
	},
});
```

#### Example: Using createSSIShim in Custom Transform

```ts
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';

const customTransform = {
	name: 'custom-ssi',
	transform: async (content, context) => {
		if (typeof content !== 'string') return content;

		// Apply SSI shim transform
		const ssiTransform = createSSIShimTransform({
			onError: (path) => `<!-- Failed to include: ${path} -->`,
		});

		return await ssiTransform(content, context);
	},
};
```

#### Example: Combining Multiple Utility Transforms

```ts
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';

const combinedTransform = {
	name: 'combined-utilities',
	transform: async (content, context) => {
		if (typeof content !== 'string') return content;

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

#### Example: Conditional Processing Based on Context

```ts
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';

const contextAwareTransform = {
	name: 'context-aware',
	transform: async (content, context) => {
		if (typeof content !== 'string') return content;

		// Inject admin tools only for admin pages
		if (context.path.startsWith('admin/')) {
			const adminTransform = createInjectToHeadTransform({
				content: '<script src="/__admin-tools.js"></script>',
			});
			content = await adminTransform(content, context);
		}

		// Add analytics only in production builds
		if (!context.isServe) {
			const analyticsTransform = createInjectToHeadTransform({
				content: '<script src="/analytics.js"></script>',
			});
			content = await analyticsTransform(content, context);
		}

		return content;
	},
};
```

#### Example: Using Context for File Operations

```ts
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

const fileBasedTransform = {
	name: 'file-based',
	transform: async (content, context) => {
		if (typeof content !== 'string') return content;

		// Read a sibling file based on current file location
		const inputDir = dirname(context.inputPath);
		const metaFile = join(inputDir, 'meta.json');

		if (existsSync(metaFile)) {
			const meta = JSON.parse(readFileSync(metaFile, 'utf-8'));
			console.log(`Processing ${context.path} with meta:`, meta);

			// Use meta information for custom processing
			if (meta.inject) {
				content = content.replace('</head>', `${meta.inject}</head>`);
			}
		}

		return content;
	},
};
```

### Advanced: Transform Functions

For advanced use cases, you can use the lower-level transform functions to create custom `ResponseTransform` objects:

```ts
import { defineConfig } from 'kamado/config';
import { createInjectToHeadTransform } from '@kamado-io/page-compiler/transform/inject-to-head';
import { createSSIShimTransform } from '@kamado-io/page-compiler/transform/ssi-shim';

export default defineConfig({
	devServer: {
		transforms: [
			{
				name: 'my-custom-transform',
				filter: { include: '**/*.html' },
				transform: createInjectToHeadTransform({
					content: '<script src="/__dev.js"></script>',
					position: 'head-end',
				}),
			},
		],
	},
});
```

These functions return the raw transform function `(content, context) => Promise<string | ArrayBuffer>` without the name and filter configuration, allowing you to create fully custom `ResponseTransform` objects.

## API Exports

### Main Package (`@kamado-io/page-compiler`)

```typescript
import {
	// Compiler
	pageCompiler,

	// Default transforms
	defaultPageTransforms,

	// Transform factory functions
	manipulateDOM,
	characterEntities,
	doctype,
	prettier,
	minifier,
	lineBreak,

	// Title utilities
	getTitleFromHtmlString,

	// Types
	type PageCompilerOptions,
	type Transform,
	type TransformContext,
	type CompileData,
	type CompileHooks,
	type CompileHooksObject,
	type CompileHook,
	// ... other types
} from '@kamado-io/page-compiler';
```

### Transform Utilities

```typescript
// Inject to head
import {
	injectToHead,
	createInjectToHeadTransform,
	type InjectToHeadOptions,
	type InjectToHeadTransformOptions,
} from '@kamado-io/page-compiler/transform/inject-to-head';

// SSI shim
import {
	createSSIShim,
	createSSIShimTransform,
	type SSIShimOptions,
	type SSIShimTransformOptions,
} from '@kamado-io/page-compiler/transform/ssi-shim';
```

### Title Utilities

```typescript
// Extract title from HTML string (searches only in <head> section for performance)
import { getTitleFromHtmlString } from '@kamado-io/page-compiler/title';

const title = getTitleFromHtmlString(
	'<html><head><title>My Page</title></head>...</html>',
);
// Returns: 'My Page'
```

### Individual Transforms (Subpath Exports)

```typescript
import { manipulateDOM } from '@kamado-io/page-compiler/transform/manipulate-dom';
import { characterEntities } from '@kamado-io/page-compiler/transform/character-entities';
import { doctype } from '@kamado-io/page-compiler/transform/doctype';
import { prettier } from '@kamado-io/page-compiler/transform/prettier';
import { minifier } from '@kamado-io/page-compiler/transform/minifier';
import { lineBreak } from '@kamado-io/page-compiler/transform/line-break';
```

## License

MIT
