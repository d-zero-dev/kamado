# @kamado-io/style-compiler

Style compiler for Kamado. Processes CSS/SCSS/SASS files with PostCSS and adds a banner before compiling.

## Installation

```bash
npm install @kamado-io/style-compiler
# or
yarn add @kamado-io/style-compiler
```

## Usage

```ts
import { defineConfig } from 'kamado/config';
import { createStyleCompiler } from '@kamado-io/style-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createStyleCompiler(), {
			alias: { '@': './src/styles' },
			banner: 'Generated file',
		}),
	],
});
```

## Options

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.css'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.{scss,sass}'` will ignore all `.scss` and `.sass` files.
- `outputExtension` (optional): Output file extension (default: `'.css'`)
- `alias`: Map of path aliases (key is alias name, value is actual path)
- `banner`: Banner configuration (can specify CreateBanner function or string)

## PostCSS Configuration

The compiler loads the project's PostCSS config (e.g. `postcss.config.js`) via `postcss-load-config` and merges its plugins after the built-in ones (`postcss-import` with alias support, then `cssnano`). A `postcss-import` entry in the user config is skipped to avoid duplicates.

- During `kamado build`, the config is loaded **once per build** and the processor is reused for all CSS files.
- During `kamado server`, the config is reloaded **per compilation**, so edits to `postcss.config.js` apply without restarting the dev server.
- If no config exists, the built-in plugins alone are used. If the config fails to load for any other reason (e.g. a syntax error), a warning is printed and the built-in plugins are used as a fallback — check the console if your plugins do not seem to apply.

## License

MIT
