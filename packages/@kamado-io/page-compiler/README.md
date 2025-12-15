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
- `compileHooks`: Compilation hooks for customizing compile process
  - `main`: Hooks for main content compilation
    - `before`: Hook called before compilation (receives content and data, returns processed content)
    - `after`: Hook called after compilation (receives HTML and data, returns processed HTML)
    - `compiler`: Custom compiler function (replaces default Pug compiler)
  - `layout`: Hooks for layout compilation
    - `before`: Hook called before compilation (receives content and data, returns processed content)
    - `after`: Hook called after compilation (receives HTML and data, returns processed HTML)
    - `compiler`: Custom compiler function (replaces default Pug compiler)

## Example: Using compileHooks

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import type { UserConfig } from 'kamado/config';

export const config: UserConfig = {
	compilers: {
		page: pageCompiler({
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
					compiler: async (content, data, options) => {
						// Use custom compiler for layouts
						return await myCustomCompiler(content, data, options);
					},
				},
			},
		}),
	},
};
```

## License

MIT
