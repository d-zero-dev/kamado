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
import { scriptCompiler } from '@kamado-io/script-compiler';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	compilers: {
		script: scriptCompiler({
			alias: { '@': './src' },
			minifier: true,
			banner: 'Generated file',
		}),
	},
};
```

## Options

- `alias`: Map of path aliases (key is alias name, value is actual path)
- `minifier`: Whether to enable minification
- `banner`: Banner configuration (can specify CreateBanner function or string)

## License

MIT
