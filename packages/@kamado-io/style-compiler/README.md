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

## License

MIT
