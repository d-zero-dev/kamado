# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [1.1.0](https://github.com/d-zero-dev/kamodo/compare/v1.0.0...v1.1.0) (2026-01-07)

### Bug Fixes

- **kamado:** add error handling for missing config file ([7dcbe37](https://github.com/d-zero-dev/kamodo/commit/7dcbe374d307475c56d55129d348a9fd1da45dfa))

### Features

- **kamado:** add --config CLI option to specify config file path ([893c8bc](https://github.com/d-zero-dev/kamodo/commit/893c8bc731bb3c44d3cb5c87f83035f7b3efc3a4))
- **kamado:** add pageList config option type definition ([e62f4ff](https://github.com/d-zero-dev/kamodo/commit/e62f4ff3ab60c1e9dcfed5bc1e50ce245ee8c698))
- **kamado:** add pageList to config merge ([8a4b904](https://github.com/d-zero-dev/kamodo/commit/8a4b904be54d292c3d9927b6eeabc950735eba84))
- **kamado:** add safe option to getTitle for error handling ([1323d7e](https://github.com/d-zero-dev/kamodo/commit/1323d7e19b4f45964e34821997516d58c96e9a3f))
- **kamado:** add urlToFile utility function for URL to CompilableFile conversion ([3442322](https://github.com/d-zero-dev/kamodo/commit/34423222b658e0b11efe6bee4fd5647d3459bd4d))
- **kamado:** implement pageList option in global data ([74f2e00](https://github.com/d-zero-dev/kamodo/commit/74f2e002a7361f4c003a08aaa9f5354a1fbf1dcd))

# [1.0.0](https://github.com/d-zero-dev/kamodo/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package kamado

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

- feat(kamado)!: add flexible extension config and guaranteed compilation order ([e16a8c7](https://github.com/d-zero-dev/kamodo/commit/e16a8c744b0a06bbbe5d16399c38490a968432fa))

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

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

- feat(kamado)!: add flexible extension config and guaranteed compilation order ([e16a8c7](https://github.com/d-zero-dev/kamodo/commit/e16a8c744b0a06bbbe5d16399c38490a968432fa))

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

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

### Bug Fixes

- **kamado:** add error handling for compile function ([d4140f6](https://github.com/d-zero-dev/kamodo/commit/d4140f64255efa13a4601946f82da4132c529100))

### Features

- **kamado:** add cache parameter to file content retrieval ([f94396d](https://github.com/d-zero-dev/kamodo/commit/f94396d489fec699ff0184928fdb2399cd18d511))

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

**Note:** Version bump only for package kamado

# [0.1.0-alpha.5](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2025-12-15)

### Features

- **kamado:** add url option to JSDOM for domain configuration ([eb52576](https://github.com/d-zero-dev/kamodo/commit/eb52576ad8844520b0cfb135ba79856f77f93998))

# [0.1.0-alpha.4](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2025-12-11)

**Note:** Version bump only for package kamado

# [0.1.0-alpha.3](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.2...v0.1.0-alpha.3) (2025-12-04)

**Note:** Version bump only for package kamado

# [0.1.0-alpha.2](https://github.com/d-zero-dev/kamodo/compare/v0.1.0-alpha.1...v0.1.0-alpha.2) (2025-12-04)

### Features

- **kamado:** add computeOutputPath function and export path utilities ([5571c4b](https://github.com/d-zero-dev/kamodo/commit/5571c4ba48e487a16f7db772b5dd2d3dfa42d3fa))
- **kamado:** add data and path module exports to package.json ([290b888](https://github.com/d-zero-dev/kamodo/commit/290b888fa531c96b29b76b9e840803ceaaec758f))
- **kamado:** implement core features including CLI, builder, compiler, and server ([9abd284](https://github.com/d-zero-dev/kamodo/commit/9abd284bd9ea62ad3c1c10ada879ca4c6c5cf9df))

# 0.1.0-alpha.1 (2025-12-02)

### Features

- **repo:** first commit ([4ded5bb](https://github.com/d-zero-dev/kamodo/commit/4ded5bb71a280f9635c797f6f663a42a9ea2591e))
