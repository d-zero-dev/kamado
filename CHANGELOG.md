# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-02-07)

### Bug Fixes

- **kamado:** correct lifecycle hook parameter types from Config to Context ([cac8c31](https://github.com/d-zero-dev/kamado/commit/cac8c31cbf36ee3042db7faea538f73ef280c295))

- feat(kamado)!: add Compilers callback API types ([c47a4b5](https://github.com/d-zero-dev/kamado/commit/c47a4b52f17000825d8acf3da453c94a46a9c917))
- feat(style-compiler)!: convert styleCompiler to createStyleCompiler generic factory ([2571217](https://github.com/d-zero-dev/kamado/commit/2571217adb54b6ee88c0c46be5c5595c42cd8089))
- feat(script-compiler)!: convert scriptCompiler to createScriptCompiler generic factory ([77bc9ca](https://github.com/d-zero-dev/kamado/commit/77bc9ca83fcc343aa7760b53e2effeea5a27b0a2))
- feat(pug-compiler)!: add generic MetaData type parameter to createCompileHooks ([51319e2](https://github.com/d-zero-dev/kamado/commit/51319e266cfea6cd4be6317e0dc80b26170d8a4b))
- feat(page-compiler)!: convert pageCompiler to createPageCompiler generic factory ([606037c](https://github.com/d-zero-dev/kamado/commit/606037c56377bf3631a491efe657c877d209ceaf))
- feat(page-compiler)!: convert defaultPageTransforms to generic factory function ([c7523d4](https://github.com/d-zero-dev/kamado/commit/c7523d4d3809812476469eff5f6800ff24b1501d))
- feat(page-compiler)!: add generic MetaData type parameter to interfaces and transforms ([3b48bd9](https://github.com/d-zero-dev/kamado/commit/3b48bd94bd76004772566d35182207dd014037a6))
- feat(kamado)!: add generic MetaData type parameter to core interfaces ([c0fe5f9](https://github.com/d-zero-dev/kamado/commit/c0fe5f9fb40852c9a2aa7b3cb73c17cdd5dc4eaa))
- refactor(page-compiler)!: rename filter to filterNavigationNode ([83d3573](https://github.com/d-zero-dev/kamado/commit/83d35738a2a41dba9f3ed76ccef0c88bbf5eda1c))
- refactor(page-compiler)!: rename transformNode to filter ([21ee93e](https://github.com/d-zero-dev/kamado/commit/21ee93e51af1a9585ca4f5528b50a88a560d8e3d))
- refactor(page-compiler)!: change transformNode return type to boolean ([fafc368](https://github.com/d-zero-dev/kamado/commit/fafc368183d50ddf7924f60d75f5c7a9d71ca1a1))
- refactor(page-compiler)!: use addMetaData API from @d-zero/shared 0.18.0 ([1742e52](https://github.com/d-zero-dev/kamado/commit/1742e529ad1da9402d02ec2493de85577a630b45))
- refactor(page-compiler)!: simplify title handling and use metaData.title ([5616bee](https://github.com/d-zero-dev/kamado/commit/5616bee0b80bb4aed34943ccb7ccec35567dc4d1))
- refactor(kamado)!: change pageList return type from title to PageData ([436fdde](https://github.com/d-zero-dev/kamado/commit/436fddebe7a6841ceb5716afbf5a06be42afa5e1))
- refactor(kamado)!: remove deprecated title.ts and title auto-population ([0dd6870](https://github.com/d-zero-dev/kamado/commit/0dd6870e3f806b6c5b23cc404356724c4cb15486))
- refactor(kamado)!: extract getContentFromFile and getContentFromFileObject functions ([4421f8f](https://github.com/d-zero-dev/kamado/commit/4421f8fc3ede85b058dce4266afe741441ee55b7))

### Features

- **kamado:** add createCompileFunctions utility ([f91c7d1](https://github.com/d-zero-dev/kamado/commit/f91c7d180be2ca1ab12eb8614e94b8ee6046b9a0))
- **kamado:** add default generic parameters to user-facing types ([387d820](https://github.com/d-zero-dev/kamado/commit/387d820b17db7da0256cb003236d045f71d057dd))
- **kamado:** add defineConfig helper for type-safe configuration ([41cb4c4](https://github.com/d-zero-dev/kamado/commit/41cb4c4e2394a6bb35888a71df352407ebcbb5ef))
- **kamado:** change MetaData to empty interface and document Config<M> invariance ([414956b](https://github.com/d-zero-dev/kamado/commit/414956b09c6d73cc504dbf4d9aab24d9077f962a))

### BREAKING CHANGES

- Config.compilers is now a callback function instead of
  an array. Users must use `compilers: (def) => [def(factory(), opts)]`
  form for type-safe compiler definition.

Add CompilerDefine<M>, CustomCompilerFactory<M>, and Compilers<M> types.
Update mergeConfig default to callback form.

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>

- Replace styleCompiler constant with
  createStyleCompiler<M>() factory function to support generic
  MetaData type parameter
- Replace scriptCompiler constant with
  createScriptCompiler<M>() factory function to support generic
  MetaData type parameter
- createCompileHooks now requires a generic type
  parameter <M extends MetaData> and returns () => CompileHooksObject<M>
  to support type-safe custom metadata
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
- Add generic type parameter <M extends MetaData> to
  Config, Context, UserConfig, and related interfaces/functions for
  type-safe custom metadata support
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

- pageList hook now returns PageData[] instead of
  (CompilableFile & { title?: string })[]

* Add PageData interface extending CompilableFile with optional metaData
* Title should now be set via metaData.title instead of title property
* Update documentation to reflect new PageData type and metaData usage

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- kamado no longer auto-populates pageList titles.
  Users should set titles via config.pageList hook, or rely on
  page-compiler's getTitle fallback in breadcrumbs/nav.

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

- Remove get() method from FileObject and CompilableFile interfaces

* Add getContentFromFile() for CompilableFile (parses front matter, merges JSON metadata)
* Add getContentFromFileObject() for FileObject (simple read, no parsing)
* Remove get() method from types.ts and get-file.ts implementation
* Update internal usages in create-compiler.ts and deprecated/title.ts
* Add unit tests for new functions

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>

# [2.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v1.3.0...v2.0.0-alpha.0) (2026-02-03)

### Bug Fixes

- **page-compiler:** remove characterEntities from defaultPageTransforms ([cda1331](https://github.com/d-zero-dev/kamado/commit/cda1331aa9173ebd0d41f30b9be01da4648d33cf))
- **page-compiler:** use domSerialize and pass parent elements to imageSizes ([d8f71ad](https://github.com/d-zero-dev/kamado/commit/d8f71ad6a4907f447fa469c95c1b1fe4032ac007))

- refactor(page-compiler)!: move format transforms to transform directory ([329d266](https://github.com/d-zero-dev/kamado/commit/329d2661c39d451dfe3afae78dbe6475c0a1cf1a))
- refactor(page-compiler)!: replace individual format options with unified transforms option ([10b26ec](https://github.com/d-zero-dev/kamado/commit/10b26ec68c28c32285b80f28e9fd475543aba66d))
- refactor(kamado)!: unify Transform interface for page-compiler and devServer ([513e654](https://github.com/d-zero-dev/kamado/commit/513e654b0c794cadda2ba3074b6b82947b600d98))
- refactor(page-compiler)!: update pageTransform option names in pageCompiler ([59b8f88](https://github.com/d-zero-dev/kamado/commit/59b8f88563149aef301cd56dfd6afb52165de299))
- refactor(page-compiler)!: rename pageTransform API hooks ([365a5a1](https://github.com/d-zero-dev/kamado/commit/365a5a1a39d69eb786ffff2bab91d9c5fabf1d44))
- refactor(page-compiler)!: rename format files to page-transform ([4496365](https://github.com/d-zero-dev/kamado/commit/4496365bae291d941d383ae0237fa3d2f451a214))
- refactor(page-compiler)!: rename format files to page-transform ([b4e324a](https://github.com/d-zero-dev/kamado/commit/b4e324a8913dbf0a71b96eacb797dc5363f02a16))
- refactor(page-compiler)!: rename formatHtml to pageTransform ([bba3fd3](https://github.com/d-zero-dev/kamado/commit/bba3fd3f2369911c5637ce27b7a9922171c04614))
- refactor(page-compiler)!: split formatHtml into modular pipeline processors ([2c5bb43](https://github.com/d-zero-dev/kamado/commit/2c5bb435ccc84748ed6e1cbecc83646d9c7ba6df))
- refactor(kamado)!: change computeOutputPath signature to context pattern ([c5643b8](https://github.com/d-zero-dev/kamado/commit/c5643b831cf7552d2fc07bfa4b809c2a701f8f7d))
- refactor(kamado)!: apply context+options pattern to getAssetGroup ([a602d92](https://github.com/d-zero-dev/kamado/commit/a602d92cd279fbd0c2fb25a7e056feaf98a05a56))
- refactor(pug-compiler)!: remove index.ts and use pug-compiler.ts ([f8c798b](https://github.com/d-zero-dev/kamado/commit/f8c798b2402b3f48ebb80e9a37422e3a4f6ed255))
- refactor(style-compiler)!: remove index.ts and use style-compiler.ts ([552bb73](https://github.com/d-zero-dev/kamado/commit/552bb73bc6db73a58f28807208fa69863d57e5f2))
- refactor(script-compiler)!: remove index.ts and use script-compiler.ts ([657147d](https://github.com/d-zero-dev/kamado/commit/657147d3317f0c416599d4f8d9c8a98d83dfb90e))
- feat(page-compiler)!: add compile parameter to hook signatures ([b6d714b](https://github.com/d-zero-dev/kamado/commit/b6d714bd1dacfdd0c0b4f73e9d9f36739a6ca3c8))
- refactor(kamado)!: add compile parameter to CustomCompileFunction ([1dbd6d0](https://github.com/d-zero-dev/kamado/commit/1dbd6d01d053e2f4ee78bab06372ebe4c71d20d3))
- feat(kamado)!: remove features export completely ([8237c75](https://github.com/d-zero-dev/kamado/commit/8237c75608961ff72abfab944b94ed6c6dda5057))
- docs(kamado)!: update compiler API documentation to use CustomCompiler ([77213e7](https://github.com/d-zero-dev/kamado/commit/77213e7fbb922a33a0f1a9078c0886f773bd5384))
- feat(style-compiler)!: use createCustomCompiler from kamado ([9568803](https://github.com/d-zero-dev/kamado/commit/9568803835e4d98ba3dce5e49287ff533fd72ed2))
- feat(script-compiler)!: use createCustomCompiler from kamado ([ba49260](https://github.com/d-zero-dev/kamado/commit/ba492605e6c79376dcf34c8615f1497521631f5f))
- feat(page-compiler)!: use createCustomCompiler from kamado ([5727e7e](https://github.com/d-zero-dev/kamado/commit/5727e7e6364a212f26a422b169ecfeab72de46f4))
- feat(kamado)!: rename compiler API types to custom compiler ([4ad3229](https://github.com/d-zero-dev/kamado/commit/4ad322969ba727e0fe5c066366633ca1b75aea91))

### Features

- **page-compiler:** add function support to transforms option ([ced2d4c](https://github.com/d-zero-dev/kamado/commit/ced2d4cdeefab2a470360c8b5e00b97f093f0727))
- **repo:** add monorepo-architect skill ([be31ef4](https://github.com/d-zero-dev/kamado/commit/be31ef4756a96acd905bca215ab4842b0248fd6b))

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

- Rename ResponseTransform to Transform and extend TransformContext

Type changes:

- ResponseTransform -> Transform
- Transform.name is now required (was optional)
- TransformContext extended with filePath, outputDir, and compile properties

This unifies the transform interfaces between page-compiler and devServer.transforms,
enabling better code reuse and consistency across the compilation pipeline.

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

- computeOutputPath now takes a single context object
  instead of 4 separate parameters

* Add ComputeOutputPathContext interface to types.ts
* Update computeOutputPath signature (4 params → context object)
* Update call site in get-file.ts
* Update JSDoc example code
* Update 9 test cases in output-path.spec.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- getAssetGroup function signature changed from
  getAssetGroup(options) to getAssetGroup(context, options?).

Before:
getAssetGroup({
inputDir: '/path',
outputDir: '/path',
compilerEntry: {...},
glob: '\*_/_.html'
})

After:
getAssetGroup(
{ inputDir: '/path', outputDir: '/path', compilerEntry: {...} },
{ glob: '\*_/_.html' }
)

- Split GetAssetsOptions into GetAssetGroupContext + GetAssetGroupOptions
- Update internal call sites in build.ts and assets.spec.ts
- All 155 tests passing

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Internal file structure changed. Public API unchanged.

* Create src/pug-compiler.ts (re-exports)
* Rename src/index.spec.ts to src/pug-compiler.spec.ts
* Update spec import path
* Update package.json (main, types, exports)
* Delete src/index.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Internal file structure changed. Public API unchanged.

* Create src/style-compiler.ts (move impl from index.ts)
* Update package.json (main, types, exports)
* Delete src/index.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Internal file structure changed. Public API unchanged.

* Create src/script-compiler.ts (move impl from index.ts)
* Update package.json (main, types, exports)
* Delete src/index.ts

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

- CustomCompileFunction signature changed to include compile parameter

The CustomCompileFunction interface now requires a compile parameter as the
second argument, enabling compilers to recursively compile other files during
compilation (e.g., layouts, includes).

Old signature:
(compilableFile, log?, cache?) => Promise<string | ArrayBuffer>

New signature:
(compilableFile, compile, log?, cache?) => Promise<string | ArrayBuffer>

Changes:

- Add new compiler.ts with CompileFunction interface and createCompiler
- Update CustomCompileFunction to accept compile parameter
- Refactor builder and server to use centralized createCompiler
- Add comprehensive JSDoc comments for all compiler interfaces
- Export CompileFunction from compiler/index.ts

Migration: All custom compilers must update their function signature to accept
the compile parameter, even if not used.

- Remove ./features export from kamado package

Changes:

- Move features/title.ts to deprecated/title.ts (remove getTitleFromStaticFile)
- Delete features directory files (breadcrumbs, nav, title-list)
- Remove "./features" from package.json exports
- These features are already migrated to @kamado-io/page-compiler

Migration: Import from @kamado-io/page-compiler instead of kamado/features

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update documentation to reflect renamed compiler types

Type renames in documentation:

- CompilerPlugin -> CustomCompilerPlugin
- Compiler -> CustomCompiler
- CompileFunction -> CustomCompileFunction

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Rename all compiler-related types and functions

Type renames:

- Compiler -> CustomCompiler
- CompilerPlugin -> CustomCompilerPlugin
- CompileFunction -> CustomCompileFunction
- CompilerWithMetadata -> CustomCompilerWithMetadata
- CompilerMetadataOptions -> CustomCompilerMetadataOptions
- CompilerFactoryResult -> CustomCompilerFactoryResult
- createCompiler -> createCustomCompiler

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.3.0](https://github.com/d-zero-dev/kamado/compare/v1.2.0...v1.3.0) (2026-01-29)

### Bug Fixes

- **page-compiler:** use Context to determine isServe flag correctly ([b4d4715](https://github.com/d-zero-dev/kamado/commit/b4d4715ee2db985a5023a7f6750ec682fd6157fe))

### Features

- **kamado:** add response transform API for dev server ([4290f69](https://github.com/d-zero-dev/kamado/commit/4290f69d90e735e602c32f66c15fddcfb408b0f9))
- **kamado:** add server start path configuration ([a133234](https://github.com/d-zero-dev/kamado/commit/a133234c7b44ea1e2c2617341f388d6f845bc610))
- **kamado:** introduce Context type to separate config from execution mode ([9d47de5](https://github.com/d-zero-dev/kamado/commit/9d47de5a1621077f1673ae894546e05e30994997))
- **page-compiler:** add dev-transform utilities for Transform API ([629b48b](https://github.com/d-zero-dev/kamado/commit/629b48bc5e7608a7f828d899fa7ee5b34fa0966d))
- **page-compiler:** add formatHtml to package.json exports ([093945f](https://github.com/d-zero-dev/kamado/commit/093945f0f2e0cba47f42e291a8549c40dbb2254a))
- **page-compiler:** add TransformContext to afterSerialize hook ([086ecd1](https://github.com/d-zero-dev/kamado/commit/086ecd19663811ae60ad1d93a9111f8b2a4b66a9))
- **page-compiler:** add TransformContext to beforeSerialize hook ([bcee5e6](https://github.com/d-zero-dev/kamado/commit/bcee5e64099b3d339b4e84e5dd13268423ee6188))

# [1.2.0](https://github.com/d-zero-dev/kamado/compare/v1.1.0...v1.2.0) (2026-01-09)

### Bug Fixes

- **kamado:** apply AND condition for glob filtering in getAssetGroup ([d885e24](https://github.com/d-zero-dev/kamado/commit/d885e247598087529ef40f8be337cd2ccb25dc18))

### Features

- **page-compiler:** add transform options to breadcrumbs and navigation features ([f50c9d8](https://github.com/d-zero-dev/kamado/commit/f50c9d86586c7c643d3e303e22e64dca663df333))

## [Unreleased]

### Deprecated

- **kamado:** `kamado/features` module is now deprecated and will be removed in v2.0.0
  - `getBreadcrumbs` - use `@kamado-io/page-compiler` instead
  - `getNavTree` - use `@kamado-io/page-compiler` instead
  - `titleList` - use `@kamado-io/page-compiler` instead
  - `getTitle` - use `@kamado-io/page-compiler` instead
  - `getTitleFromStaticFile` - use `@kamado-io/page-compiler` instead

# [1.1.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0...v1.1.0) (2026-01-07)

### Bug Fixes

- **kamado:** add error handling for missing config file ([7dcbe37](https://github.com/d-zero-dev/kamado/commit/7dcbe374d307475c56d55129d348a9fd1da45dfa))

### Features

- **kamado:** add --config CLI option to specify config file path ([893c8bc](https://github.com/d-zero-dev/kamado/commit/893c8bc731bb3c44d3cb5c87f83035f7b3efc3a4))
- **kamado:** add pageList config option type definition ([e62f4ff](https://github.com/d-zero-dev/kamado/commit/e62f4ff3ab60c1e9dcfed5bc1e50ce245ee8c698))
- **kamado:** add pageList to config merge ([8a4b904](https://github.com/d-zero-dev/kamado/commit/8a4b904be54d292c3d9927b6eeabc950735eba84))
- **kamado:** add safe option to getTitle for error handling ([1323d7e](https://github.com/d-zero-dev/kamado/commit/1323d7e19b4f45964e34821997516d58c96e9a3f))
- **kamado:** add urlToFile utility function for URL to CompilableFile conversion ([3442322](https://github.com/d-zero-dev/kamado/commit/34423222b658e0b11efe6bee4fd5647d3459bd4d))
- **kamado:** implement pageList option in global data ([74f2e00](https://github.com/d-zero-dev/kamado/commit/74f2e002a7361f4c003a08aaa9f5354a1fbf1dcd))

# [1.0.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package kamado-monorepo

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

### Bug Fixes

- **page-compiler:** pass cache parameter to layout.get() ([9e85f62](https://github.com/d-zero-dev/kamado/commit/9e85f6230787c70a5c84c730194f868b20248748))
- **style-compiler:** pass cache parameter to file.get() ([39c038b](https://github.com/d-zero-dev/kamado/commit/39c038b78ce5b3b2bd82e73d393dfa1b678bffcf))

- feat(kamado)!: add flexible extension config and guaranteed compilation order ([e16a8c7](https://github.com/d-zero-dev/kamado/commit/e16a8c744b0a06bbbe5d16399c38490a968432fa))

### Features

- **page-compiler:** adapt to new compiler API with metadata ([94bafe6](https://github.com/d-zero-dev/kamado/commit/94bafe668e46becedebdbb9a3cc6b1cdf73674ec))
- **page-compiler:** add cache parameter to getLayout get method ([8746095](https://github.com/d-zero-dev/kamado/commit/8746095416b33cff0b56915fbdf142bce26e55ec))
- **script-compiler:** adapt to new compiler API with metadata ([04647b9](https://github.com/d-zero-dev/kamado/commit/04647b9d152e0958bdb6380b852a5f1bd4ac5c6e))
- **style-compiler:** adapt to new compiler API with metadata ([4de9112](https://github.com/d-zero-dev/kamado/commit/4de91124a90b7493de0c3f3234dba6b85e40ea85))

### BREAKING CHANGES

- createCompiler API has been completely redesigned

The createCompiler function now requires a factory function that

returns CompilerFactoryResult with defaultFiles and

defaultOutputExtension. It returns CompilerWithMetadata instead

of CompilerPlugin.

Improvements:

- Added flexible extension configuration for both input and

  output files

- Compilation order is now guaranteed

- Removed unused files: extension.ts, wildcard-glob.ts,

  files/types.ts, config/defaults.ts

Refactored data and file processing logic for better

maintainability. Updated documentation to reflect the new API.

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

### Bug Fixes

- **page-compiler:** pass cache parameter to layout.get() ([9e85f62](https://github.com/d-zero-dev/kamado/commit/9e85f6230787c70a5c84c730194f868b20248748))
- **style-compiler:** pass cache parameter to file.get() ([39c038b](https://github.com/d-zero-dev/kamado/commit/39c038b78ce5b3b2bd82e73d393dfa1b678bffcf))

- feat(kamado)!: add flexible extension config and guaranteed compilation order ([e16a8c7](https://github.com/d-zero-dev/kamado/commit/e16a8c744b0a06bbbe5d16399c38490a968432fa))

### Features

- **page-compiler:** adapt to new compiler API with metadata ([94bafe6](https://github.com/d-zero-dev/kamado/commit/94bafe668e46becedebdbb9a3cc6b1cdf73674ec))
- **script-compiler:** adapt to new compiler API with metadata ([04647b9](https://github.com/d-zero-dev/kamado/commit/04647b9d152e0958bdb6380b852a5f1bd4ac5c6e))
- **style-compiler:** adapt to new compiler API with metadata ([4de9112](https://github.com/d-zero-dev/kamado/commit/4de91124a90b7493de0c3f3234dba6b85e40ea85))

### BREAKING CHANGES

- createCompiler API has been completely redesigned

The createCompiler function now requires a factory function that

returns CompilerFactoryResult with defaultFiles and

defaultOutputExtension. It returns CompilerWithMetadata instead

of CompilerPlugin.

Improvements:

- Added flexible extension configuration for both input and

  output files

- Compilation order is now guaranteed

- Removed unused files: extension.ts, wildcard-glob.ts,

  files/types.ts, config/defaults.ts

Refactored data and file processing logic for better

maintainability. Updated documentation to reflect the new API.

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

### Bug Fixes

- **kamado:** add error handling for compile function ([d4140f6](https://github.com/d-zero-dev/kamado/commit/d4140f64255efa13a4601946f82da4132c529100))
- **script-compiler:** use temporary directory for esbuild output ([ffa9cbe](https://github.com/d-zero-dev/kamado/commit/ffa9cbef130ed703621f33069db5c6e51dc242e6))

### Features

- **kamado:** add cache parameter to file content retrieval ([f94396d](https://github.com/d-zero-dev/kamado/commit/f94396d489fec699ff0184928fdb2399cd18d511))
- **page-compiler:** pass cache parameter to file.get() ([e895bff](https://github.com/d-zero-dev/kamado/commit/e895bffece2864e246e4a25bae386ab16df8659e))

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

### Features

- **pug-compiler:** add pug compiler package ([6f0e1df](https://github.com/d-zero-dev/kamado/commit/6f0e1df23b01f56fbcd7128e19d44b5e6bc6196e))
- **pug-compiler:** refactor API and add createCompileHooks helper ([41c4c1a](https://github.com/d-zero-dev/kamado/commit/41c4c1a717e2ad9e1e515825052e1df938dd1c64))

# [0.1.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2025-12-15)

### Features

- **kamado:** add url option to JSDOM for domain configuration ([eb52576](https://github.com/d-zero-dev/kamado/commit/eb52576ad8844520b0cfb135ba79856f77f93998))
- **page-compiler:** add host option and URL resolution for JSDOM ([34d7c7a](https://github.com/d-zero-dev/kamado/commit/34d7c7aea686ba5387adc460f201880ff0afc53a))

# [0.1.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2025-12-11)

### Bug Fixes

- **script-compiler:** use dynamic import for esbuild to avoid runtime error ([1775694](https://github.com/d-zero-dev/kamado/commit/17756949b8e486c571279a3a254d279d61e3753c))

# [0.1.0-alpha.3](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.2...v0.1.0-alpha.3) (2025-12-04)

**Note:** Version bump only for package kamado-monorepo

# [0.1.0-alpha.2](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.1...v0.1.0-alpha.2) (2025-12-04)

### Features

- **kamado:** add computeOutputPath function and export path utilities ([5571c4b](https://github.com/d-zero-dev/kamado/commit/5571c4ba48e487a16f7db772b5dd2d3dfa42d3fa))
- **kamado:** add data and path module exports to package.json ([290b888](https://github.com/d-zero-dev/kamado/commit/290b888fa531c96b29b76b9e840803ceaaec758f))
- **kamado:** implement core features including CLI, builder, compiler, and server ([9abd284](https://github.com/d-zero-dev/kamado/commit/9abd284bd9ea62ad3c1c10ada879ca4c6c5cf9df))

# 0.1.0-alpha.1 (2025-12-02)

### Features

- **repo:** first commit ([4ded5bb](https://github.com/d-zero-dev/kamado/commit/4ded5bb71a280f9635c797f6f663a42a9ea2591e))
