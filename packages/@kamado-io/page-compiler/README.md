# @kamado-io/page-compiler

Page compiler for Kamado. Compiles Pug templates to HTML, applies layouts, and formats the output.

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
	compilers: {
		page: pageCompiler({
			globalData: {
				dir: './data',
			},
			layouts: {
				dir: './layouts',
			},
			imageSizes: true,
		}),
	},
};
```

## Options

- `globalData`: Global data configuration
  - `dir`: Directory path where global data files are stored
  - `data`: Additional global data
- `layouts`: Layout file configuration
  - `dir`: Directory path where layout files are stored
  - `files`: Map of layout files
  - `contentVariableName`: Variable name for content in layout (default: `'content'`)
- `pathAlias`: Path alias for Pug templates (used as basedir)
- `imageSizes`: Configuration for automatically adding width/height attributes to images (default: `true`)
- `minifier`: HTML minifier options (default: `true`)
- `prettier`: Prettier options (default: `true`)
- `lineBreak`: Line break configuration (`'\n'` or `'\r\n'`)
- `characterEntities`: Whether to enable character entity conversion
- `optimizeTitle`: Function to optimize titles
- `host`: Host URL for JSDOM's url option (if not specified, uses production domain from package.json)
- `beforeSerialize`: Hook function called before DOM serialization
- `afterSerialize`: Hook function called after DOM serialization
- `replace`: Final HTML content replacement processing

## License

MIT
