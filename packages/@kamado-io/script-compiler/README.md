# @kamado-io/script-compiler

Script compiler for Kamado. Bundles JavaScript/TypeScript files with esbuild and adds a banner before compiling.

## Installation

```bash
npm install @kamado-io/script-compiler
# or
yarn add @kamado-io/script-compiler
```

## Usage

```ts
import { defineConfig } from 'kamado/config';
import { createScriptCompiler } from '@kamado-io/script-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createScriptCompiler(), {
			alias: { '@': './src' },
			minifier: true,
			banner: 'Generated file',
		}),
	],
});
```

## Options

- `files` (optional): Glob pattern for files to compile. Patterns are resolved relative to `dir.input` (default: `'**/*.{js,ts,jsx,tsx,mjs,cjs}'`)
- `ignore` (optional): Glob pattern for files to exclude from compilation. Patterns are resolved relative to `dir.input`. For example, `'**/*.test.ts'` will ignore all test files.
- `outputExtension` (optional): Output file extension (default: `'.js'`)
- `alias`: Map of path aliases (key is alias name, value is actual path)
- `minifier`: Whether to enable minification
- `banner`: Banner configuration (can specify CreateBanner function or string)

## License

MIT
