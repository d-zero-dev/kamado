# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-02-07)

- feat(page-compiler)!: convert pageCompiler to createPageCompiler generic factory ([606037c](https://github.com/d-zero-dev/kamado/commit/606037c56377bf3631a491efe657c877d209ceaf))
- feat(page-compiler)!: convert defaultPageTransforms to generic factory function ([c7523d4](https://github.com/d-zero-dev/kamado/commit/c7523d4d3809812476469eff5f6800ff24b1501d))
- feat(page-compiler)!: add generic MetaData type parameter to interfaces and transforms ([3b48bd9](https://github.com/d-zero-dev/kamado/commit/3b48bd94bd76004772566d35182207dd014037a6))
- refactor(page-compiler)!: rename filter to filterNavigationNode ([83d3573](https://github.com/d-zero-dev/kamado/commit/83d35738a2a41dba9f3ed76ccef0c88bbf5eda1c))
- refactor(page-compiler)!: rename transformNode to filter ([21ee93e](https://github.com/d-zero-dev/kamado/commit/21ee93e51af1a9585ca4f5528b50a88a560d8e3d))
- refactor(page-compiler)!: change transformNode return type to boolean ([fafc368](https://github.com/d-zero-dev/kamado/commit/fafc368183d50ddf7924f60d75f5c7a9d71ca1a1))
- refactor(page-compiler)!: use addMetaData API from @d-zero/shared 0.18.0 ([1742e52](https://github.com/d-zero-dev/kamado/commit/1742e529ad1da9402d02ec2493de85577a630b45))
- refactor(page-compiler)!: simplify title handling and use metaData.title ([5616bee](https://github.com/d-zero-dev/kamado/commit/5616bee0b80bb4aed34943ccb7ccec35567dc4d1))

### BREAKING CHANGES

- Replace pageCompiler constant with
  createPageCompiler<M>() factory function. NavNode type now includes
  custom metadata via Node<NavNodeMetaData & M>. Breadcrumbs and nav
  features are generalized to propagate type-safe metadata throughout
  the compilation pipeline.
- Replace defaultPageTransforms constant with
  createDefaultPageTransforms<M>() factory function to support
  generic MetaData type parameter
- Add generic type parameter <M extends MetaData> to
  PageCompilerOptions, CompileData, CompileHook, CompilerFunction, and
  all transform functions to propagate type-safe metadata support from
  the kamado package
- Rename PageCompilerOptions.filter to filterNavigationNode

More descriptive name to clarify this filters navigation nodes specifically.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- Rename transformNode/transformNavNode to filter

* Rename GetNavTreeOptions.transformNode to filter
* Rename PageCompilerOptions.transformNavNode to filter
* Rename internal transformTreeNodes to filterTreeNodes
* Update JSDoc with @param descriptions

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- transformNode now returns boolean instead of NavNode

* Return true to keep the node, false to remove it
* Simplifies the API by focusing on filtering rather than transformation
* Remove tests for node property transformation (no longer supported)

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- NavNode now uses node.meta.title instead of node.title

* Use pathListToTree addMetaData option instead of filter with @ts-ignore
* Remove generic type parameter <TOut> from getNavTree and related types
* Access title via node.meta.title (type-safe)
* Simplify JSDoc comments

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- Remove getTitle, getTitleFromStaticFile, and optimizeTitle

* Remove getTitle and getTitleFromStaticFile functions
* Remove optimizeTitle option from PageCompilerOptions and feature options
* Replace getTitleFromDOM with getTitleFromHtmlString (public API)
* Update breadcrumbs and nav to use metaData.title instead of title
* Add ./title export for users to use in pageList hook
* Update tests to use metaData.title in mock data

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

# [2.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v1.3.0...v2.0.0-alpha.0) (2026-02-03)

### Bug Fixes

- **page-compiler:** remove characterEntities from defaultPageTransforms ([cda1331](https://github.com/d-zero-dev/kamado/commit/cda1331aa9173ebd0d41f30b9be01da4648d33cf))
- **page-compiler:** use domSerialize and pass parent elements to imageSizes ([d8f71ad](https://github.com/d-zero-dev/kamado/commit/d8f71ad6a4907f447fa469c95c1b1fe4032ac007))

- refactor(page-compiler)!: move format transforms to transform directory ([329d266](https://github.com/d-zero-dev/kamado/commit/329d2661c39d451dfe3afae78dbe6475c0a1cf1a))
- refactor(page-compiler)!: replace individual format options with unified transforms option ([10b26ec](https://github.com/d-zero-dev/kamado/commit/10b26ec68c28c32285b80f28e9fd475543aba66d))
- refactor(page-compiler)!: update pageTransform option names in pageCompiler ([59b8f88](https://github.com/d-zero-dev/kamado/commit/59b8f88563149aef301cd56dfd6afb52165de299))
- refactor(page-compiler)!: rename pageTransform API hooks ([365a5a1](https://github.com/d-zero-dev/kamado/commit/365a5a1a39d69eb786ffff2bab91d9c5fabf1d44))
- refactor(page-compiler)!: rename format files to page-transform ([4496365](https://github.com/d-zero-dev/kamado/commit/4496365bae291d941d383ae0237fa3d2f451a214))
- refactor(page-compiler)!: rename format files to page-transform ([b4e324a](https://github.com/d-zero-dev/kamado/commit/b4e324a8913dbf0a71b96eacb797dc5363f02a16))
- refactor(page-compiler)!: rename formatHtml to pageTransform ([bba3fd3](https://github.com/d-zero-dev/kamado/commit/bba3fd3f2369911c5637ce27b7a9922171c04614))
- refactor(page-compiler)!: split formatHtml into modular pipeline processors ([2c5bb43](https://github.com/d-zero-dev/kamado/commit/2c5bb435ccc84748ed6e1cbecc83646d9c7ba6df))
- feat(page-compiler)!: add compile parameter to hook signatures ([b6d714b](https://github.com/d-zero-dev/kamado/commit/b6d714bd1dacfdd0c0b4f73e9d9f36739a6ca3c8))
- feat(page-compiler)!: use createCustomCompiler from kamado ([5727e7e](https://github.com/d-zero-dev/kamado/commit/5727e7e6364a212f26a422b169ecfeab72de46f4))

### Features

- **page-compiler:** add function support to transforms option ([ced2d4c](https://github.com/d-zero-dev/kamado/commit/ced2d4cdeefab2a470360c8b5e00b97f093f0727))

### BREAKING CHANGES

- Move and refactor format/ transforms to transform/ directory

File movements and removals:

- Delete format/build-transform-context.ts (no longer needed)
- Delete format/preprocess-content.ts (functionality removed)
- Delete format/postprocess-content.ts (functionality removed)
- Move format/character-entities.ts -> transform/character-entities.ts
- Move format/doctype.ts -> transform/doctype.ts
- Move format/line-break.ts -> transform/line-break.ts
- Move format/manipulate-dom.ts -> transform/manipulate-dom.ts
- Move format/minifier.ts -> transform/minifier.ts
- Move format/prettier.ts -> transform/prettier.ts

All transform factory functions now:

- Accept options parameter only (no context parameter)
- Return Transform object directly
- Have simpler, unified API surface
- Remove unused preprocess/postprocess transform builders

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Replace granular formatting options with flexible Transform Pipeline

Removed options:

- imageSizes (boolean | ImageSizesOptions)
- minifier (boolean | HMTOptions)
- prettier (boolean | PrettierOptions)
- lineBreak ('\n' | '\r\n')
- characterEntities (boolean)

Added option:

- transforms: Transform[] | ((defaultTransforms: readonly Transform[]) => Transform[])

Users must now configure transforms explicitly or use defaultPageTransforms.
Function variant allows extending defaults without importing defaultPageTransforms.

Migration guide:

```typescript
// Before
pageCompiler({ imageSizes: true, minifier: { collapseWhitespace: true } });

// After (using defaults)
pageCompiler({ transforms: defaultPageTransforms });

// After (customizing)
import { manipulateDOM, minifier } from '@kamado-io/page-compiler';
pageCompiler({
	transforms: [
		manipulateDOM({ imageSizes: true }),
		minifier({ options: { collapseWhitespace: true } }),
	],
});

// After (extending defaults without import)
pageCompiler({
	transforms: (defaults) => [customTransform, ...defaults],
});
```

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update pageTransform call to use new option names

Updated option names when calling pageTransform:

- beforeSerialize -> preprocessContent
- afterSerialize -> manipulateDOM
- replace -> postprocessContent

This aligns the pageCompiler implementation with the renamed pageTransform API.

- Rename pageTransform hook APIs for clarity

API renames:

- beforeSerialize -> preprocessContent (content preprocessing before DOM parsing)
- afterSerialize -> manipulateDOM (DOM manipulation after parsing)
- replace -> postprocessContent (content postprocessing after serialization)

Updated type definitions and internal implementations:

- PageCompilerOptions, PageTransformOptions interfaces
- PreprocessContentContext, ManipulateDOMContext, PostprocessContentContext types
- preprocessContent(), manipulateDOM(), postprocessContent() processor functions
- Updated JSDoc comments to reflect new phase names

* Rename format processor files to match pageTransform API

File renames:

- before-serialize.ts -> preprocess-content.ts
- dom-serialize.ts -> manipulate-dom.ts
- replace.ts -> postprocess-content.ts

This is the first step of the breaking change.
The next commit will update internal implementations and API names.

- Rename format.ts to page-transform.ts

* Rename src/format.ts to src/page-transform.ts
* Rename src/format.spec.ts to src/page-transform.spec.ts
* Update package.json exports: ./format -> ./page-transform
* Update all import statements to use ./page-transform.js
* Update README.md import examples

This aligns file names with the function name pageTransform.

Migration:

- Import from '@kamado-io/page-compiler/page-transform' instead of '@kamado-io/page-compiler/format'

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Replace formatHtml with pageTransform

* Rename formatHtml function to pageTransform
* Rename FormatHtmlContext to PageTransformContext
* Rename FormatHtmlOptions to PageTransformOptions
* Reorganize options by transformation phase (beforeFormat, domManipulation, afterFormat)
* Update all documentation and examples

The transformation pipeline is now explicitly divided into three phases:

1. Phase 1: beforeFormat - String transformations before DOM parsing
2. Phase 2: domManipulation - DOM-based transformations
3. Phase 3: afterFormat - String transformations after DOM serialization

Migration:

- Import { pageTransform } instead of { formatHtml }
- Use PageTransformContext instead of FormatHtmlContext
- Use PageTransformOptions instead of FormatHtmlOptions
- Function signature and options remain the same

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Add boolean support to minifier option type

Split the 130+ line formatHtml function into 9 separate processor functions:

- buildTransformContext: Builds TransformContext for hooks
- beforeSerialize: Executes beforeSerialize hook
- domSerialize: DOM serialization with image size injection
- characterEntities: Converts characters to HTML entities
- doctype: Inserts DOCTYPE declaration
- prettier: Formats HTML with Prettier
- minifier: Minifies HTML with html-minifier-terser
- lineBreak: Normalizes line breaks
- replace: Final content replacement

Each processor follows a curried pattern: initialized with context/options,
returns a function that processes content. Processors are executed in a
pipeline array for clear, sequential transformation flow.

Type change:

- PageCompilerOptions.minifier: HMTOptions → HMTOptions | boolean
  (now supports false to disable minification)

Benefits:

- Single responsibility: Each function has one clear purpose
- Testability: Individual processors can be tested independently
- Maintainability: Easy to add, modify, or remove processing steps
- Readability: Main function is now a clear pipeline

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- beforeSerialize and afterSerialize hook signatures changed

The PageCompilerOptions hook signatures now include a compile parameter
enabling hooks to compile dependencies during page processing:

beforeSerialize:
Old: (content, isServe, context) => Promise<string> | string
New: (content, isServe, context, compile) => Promise<string> | string

afterSerialize:
Old: (elements, window, isServe, context) => Promise<void> | void
New: (elements, window, isServe, context, compile) => Promise<void> | void

Also adapts the internal compiler function to the new CustomCompileFunction
signature.

Migration: Update all beforeSerialize and afterSerialize hook implementations
to accept the compile parameter.

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.3.0](https://github.com/d-zero-dev/kamado/compare/v1.2.0...v1.3.0) (2026-01-29)

### Bug Fixes

- **page-compiler:** use Context to determine isServe flag correctly ([b4d4715](https://github.com/d-zero-dev/kamado/commit/b4d4715ee2db985a5023a7f6750ec682fd6157fe))

### Features

- **page-compiler:** add dev-transform utilities for Transform API ([629b48b](https://github.com/d-zero-dev/kamado/commit/629b48bc5e7608a7f828d899fa7ee5b34fa0966d))
- **page-compiler:** add formatHtml to package.json exports ([093945f](https://github.com/d-zero-dev/kamado/commit/093945f0f2e0cba47f42e291a8549c40dbb2254a))
- **page-compiler:** add TransformContext to afterSerialize hook ([086ecd1](https://github.com/d-zero-dev/kamado/commit/086ecd19663811ae60ad1d93a9111f8b2a4b66a9))
- **page-compiler:** add TransformContext to beforeSerialize hook ([bcee5e6](https://github.com/d-zero-dev/kamado/commit/bcee5e64099b3d339b4e84e5dd13268423ee6188))

# [1.2.0](https://github.com/d-zero-dev/kamado/compare/v1.1.0...v1.2.0) (2026-01-09)

### Features

- **page-compiler:** add transform options to breadcrumbs and navigation features ([f50c9d8](https://github.com/d-zero-dev/kamado/commit/f50c9d86586c7c643d3e303e22e64dca663df333))

# [1.1.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0...v1.1.0) (2026-01-07)

**Note:** Version bump only for package @kamado-io/page-compiler

# [1.0.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package @kamado-io/page-compiler

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

### Bug Fixes

- **page-compiler:** pass cache parameter to layout.get() ([9e85f62](https://github.com/d-zero-dev/kamado/commit/9e85f6230787c70a5c84c730194f868b20248748))

### Features

- **page-compiler:** adapt to new compiler API with metadata ([94bafe6](https://github.com/d-zero-dev/kamado/commit/94bafe668e46becedebdbb9a3cc6b1cdf73674ec))
- **page-compiler:** add cache parameter to getLayout get method ([8746095](https://github.com/d-zero-dev/kamado/commit/8746095416b33cff0b56915fbdf142bce26e55ec))

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

### Bug Fixes

- **page-compiler:** pass cache parameter to layout.get() ([9e85f62](https://github.com/d-zero-dev/kamado/commit/9e85f6230787c70a5c84c730194f868b20248748))

### Features

- **page-compiler:** adapt to new compiler API with metadata ([94bafe6](https://github.com/d-zero-dev/kamado/commit/94bafe668e46becedebdbb9a3cc6b1cdf73674ec))

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

### Features

- **page-compiler:** pass cache parameter to file.get() ([e895bff](https://github.com/d-zero-dev/kamado/commit/e895bffece2864e246e4a25bae386ab16df8659e))

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

**Note:** Version bump only for package @kamado-io/page-compiler

# [0.1.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2025-12-15)

### Features

- **page-compiler:** add host option and URL resolution for JSDOM ([34d7c7a](https://github.com/d-zero-dev/kamado/commit/34d7c7aea686ba5387adc460f201880ff0afc53a))

# [0.1.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2025-12-11)

**Note:** Version bump only for package @kamado-io/page-compiler
