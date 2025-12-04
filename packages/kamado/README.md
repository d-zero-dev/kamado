# Kamado

**Kamado is an extremely simple static site build tool.** No hydration, no client-side runtime, no magic. **No runtime needed**, just the file system and raw HTML. Baked on demand. Thoroughly baked in a Kamado, that is what Kamado is.

## Project Overview

Kamado is a static site build tool similar to 11ty, but aims for a simpler design. It is a tool for those who stick to the legacy, old-school ways of building.

**The biggest feature of Kamado is that it requires absolutely no runtime.** No client-side runtime (hydration) is needed. Because it generates pure static HTML, it achieves persistence and robustness. It generates HTML that will work just the same 10 years, or even 20 years from now.

### Difference from 11ty

- Simpler design
- **No Runtime** - No client-side runtime (hydration) needed
- Designed to be used with esbuild or vite

### Difference from Other Tools

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

import { pageCompiler } from 'kamado/compiler/page';
import { scriptCompiler } from 'kamado/compiler/script';
import { styleCompiler } from 'kamado/compiler/style';

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
	extensions: {
		// Ignore specific extensions by specifying '#ignore'
		scss: '#ignore',
		sass: '#ignore',
	},
	compilers: {
		page: pageCompiler({
			globalData: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'data'),
			},
			layouts: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'layouts'),
			},
			pathAlias: path.resolve(import.meta.dirname, '__assets', '_libs'),
			async afterSerialize(elements) {
				// DOM manipulation or custom processing here
			},
		}),
		style: styleCompiler({
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
		script: scriptCompiler({
			minifier: true,
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
	},
	async onBeforeBuild(config) {
		// Process before build
	},
	async onAfterBuild() {
		// Process after build
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

- `devServer.port`: Server port number (default: `8000`)
- `devServer.host`: Server host name (default: `localhost`)
- `devServer.open`: Whether to automatically open the browser on startup (default: `false`)

#### Extension Mapping

Map file extensions to output types in `extensions`:

- `page`: HTML pages (`.html`, `.pug`, etc.)
- `style`: Stylesheets (`.css`, `.scss`, `.sass`, etc.)
- `script`: Scripts (`.js`, `.ts`, `.jsx`, `.tsx`, etc.)
- `#ignore`: Extensions to ignore

#### Compiler Settings

##### pageCompiler

- `globalData.dir`: Global data file directory
- `globalData.data`: Additional global data
- `layouts.dir`: Layout file directory
- `pathAlias`: Path alias for template engines
- `afterSerialize`: Hook after DOM serialization

##### styleCompiler

- `alias`: Path alias map (used in PostCSS `@import`)

##### scriptCompiler

- `alias`: Path alias map (esbuild alias)
- `minifier`: Whether to enable minification

#### Hook Functions

- `onBeforeBuild`: Function executed before build
- `onAfterBuild`: Function executed after build

### Build Commands

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

### Start Development Server

```bash
kamado server
```

When the development server starts, pages accessed via the browser are built on demand. If there is a request, it bakes it on the spot and returns it.
