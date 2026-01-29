# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

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
