# @kamado-io/pug-compiler

Pug compiler for Kamado. Compiles Pug templates to HTML.

## Installation

```bash
npm install @kamado-io/pug-compiler
# or
yarn add @kamado-io/pug-compiler
```

## Usage

### Basic Usage

```ts
import { compilePug } from '@kamado-io/pug-compiler';

// Create a compiler function with options
const compiler = compilePug({
	pathAlias: './src',
	doctype: 'html',
	pretty: true,
});

// Use the compiler function
const html = await compiler('p Hello, world!', { title: 'My Page' });
```

## API

### `compilePug(options)`

Creates a Pug compiler function.

- `options` (object): Pug compiler options
  - `pathAlias` (string): Path alias for Pug templates (alias for `basedir`)
  - `basedir` (string): Base directory for resolving includes
  - `doctype` (string): Document type (default: `'html'`)
  - `pretty` (boolean): Whether to pretty-print HTML (default: `true`)

Returns: `CompilerFunction` - A function that takes `(template: string, data: Record<string, unknown>)` and returns `Promise<string>`

**Note**: This `CompilerFunction` type is specific to `pug-compiler` and differs from `page-compiler`'s `CompilerFunction` type. To use with `page-compiler`, use `createCompileHooks` which returns compatible compiler functions.

### `createCompileHooks(options)`

Creates compile hooks for `@kamado-io/page-compiler`.

- `options` (object): Pug compiler options (same as `compilePug`)

Returns: `() => CompileHooksObject` - A function that returns compile hooks object with `main` and `layout` compilers

The returned compiler functions automatically check the file extension and only compile `.pug` files. Other file types are passed through unchanged.

## Integration with @kamado-io/page-compiler

To use Pug templates with `@kamado-io/page-compiler`, you need to install both packages:

**Note**: For detailed information about `compileHooks` API (including `main`, `layout`, `before`, `after`, and `compiler` hooks), see the [@kamado-io/page-compiler README](../@kamado-io/page-compiler/README.md).

```bash
npm install @kamado-io/page-compiler @kamado-io/pug-compiler
# or
yarn add @kamado-io/page-compiler @kamado-io/pug-compiler
```

### Pattern 1: Individual Definition (Explicit but Verbose)

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';

const hooks = createCompileHooks({
	pathAlias: './src', // pug-compiler のオプション
	doctype: 'html',
	pretty: true,
})();

export const config = {
	compilers: {
		page: pageCompiler({
			layouts: { dir: './layouts' },
			globalData: { dir: './data' },
			compileHooks: {
				main: {
					compiler: hooks.main?.compiler,
				},
				layout: {
					compiler: hooks.layout?.compiler,
				},
			},
		}),
	},
};
```

Note: `compilePug` cannot be directly used with `compileHooks` because `page-compiler`'s `compiler` function signature requires an `extension` parameter. `createCompileHooks` handles extension checking automatically and returns compatible compiler functions.

### Pattern 2: Function Form (Define main and layout together)

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';

const hooksFactory = createCompileHooks({
	pathAlias: './src', // pug-compiler のオプション
	doctype: 'html',
	pretty: true,
});

export const config = {
	compilers: {
		page: pageCompiler({
			layouts: { dir: './layouts' },
			globalData: { dir: './data' },
			compileHooks: () => hooksFactory(),
		}),
	},
};
```

### Pattern 3: Dynamic Options

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';

export const config = {
	compilers: {
		page: pageCompiler({
			layouts: { dir: './layouts' },
			globalData: { dir: './data' },
			compileHooks: () => {
				const hooks = createCompileHooks({
					pathAlias: './src', // pug-compiler のオプション
					doctype: 'html',
					pretty: true,
				});
				return hooks();
			},
		}),
	},
};
```

### Pattern 4: Using `createCompileHooks` Helper (Most Concise)

```ts
import { pageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';

export const config = {
	compilers: {
		page: pageCompiler({
			layouts: { dir: './layouts' },
			globalData: { dir: './data' },
			compileHooks: createCompileHooks({
				pathAlias: './src',
				doctype: 'html',
				pretty: true,
			}),
		}),
	},
};
```

## Best Practices

- Use `createCompileHooks` (Pattern 4) when you want the simplest setup with the same compiler for both main content and layouts
- Use Pattern 1 when you need to customize `main` and `layout` hooks individually (e.g., different `before`/`after` hooks)
- Use Pattern 2 when you need a function form and want to define the hooks factory outside the config
- Use Pattern 3 when you need to create the hooks factory dynamically inside the function (e.g., based on environment variables or other runtime values)

## Troubleshooting

### `.pug` files are not being compiled

Make sure you have configured `compileHooks` with a compiler function. `page-compiler` does not compile Pug files by default - you must provide a compiler via `compileHooks`. See the [@kamado-io/page-compiler README](../@kamado-io/page-compiler/README.md) for details on how to configure `compileHooks`.

### Path resolution issues

Use the `pathAlias` option to specify the base directory for resolving `include` and `extends` directives in Pug templates.

## License

MIT
