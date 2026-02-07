# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-02-07)

- feat(style-compiler)!: convert styleCompiler to createStyleCompiler generic factory ([2571217](https://github.com/d-zero-dev/kamado/commit/2571217adb54b6ee88c0c46be5c5595c42cd8089))

### BREAKING CHANGES

- Replace styleCompiler constant with
  createStyleCompiler<M>() factory function to support generic
  MetaData type parameter

# [2.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v1.3.0...v2.0.0-alpha.0) (2026-02-03)

- refactor(style-compiler)!: remove index.ts and use style-compiler.ts ([552bb73](https://github.com/d-zero-dev/kamado/commit/552bb73bc6db73a58f28807208fa69863d57e5f2))
- feat(style-compiler)!: use createCustomCompiler from kamado ([9568803](https://github.com/d-zero-dev/kamado/commit/9568803835e4d98ba3dce5e49287ff533fd72ed2))

### BREAKING CHANGES

- Internal file structure changed. Public API unchanged.

* Create src/style-compiler.ts (move impl from index.ts)
* Update package.json (main, types, exports)
* Delete src/index.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.3.0](https://github.com/d-zero-dev/kamado/compare/v1.2.0...v1.3.0) (2026-01-29)

**Note:** Version bump only for package @kamado-io/style-compiler

# [1.2.0](https://github.com/d-zero-dev/kamado/compare/v1.1.0...v1.2.0) (2026-01-09)

**Note:** Version bump only for package @kamado-io/style-compiler

# [1.1.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0...v1.1.0) (2026-01-07)

**Note:** Version bump only for package @kamado-io/style-compiler

# [1.0.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package @kamado-io/style-compiler

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

### Bug Fixes

- **style-compiler:** pass cache parameter to file.get() ([39c038b](https://github.com/d-zero-dev/kamado/commit/39c038b78ce5b3b2bd82e73d393dfa1b678bffcf))

### Features

- **style-compiler:** adapt to new compiler API with metadata ([4de9112](https://github.com/d-zero-dev/kamado/commit/4de91124a90b7493de0c3f3234dba6b85e40ea85))

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

### Bug Fixes

- **style-compiler:** pass cache parameter to file.get() ([39c038b](https://github.com/d-zero-dev/kamado/commit/39c038b78ce5b3b2bd82e73d393dfa1b678bffcf))

### Features

- **style-compiler:** adapt to new compiler API with metadata ([4de9112](https://github.com/d-zero-dev/kamado/commit/4de91124a90b7493de0c3f3234dba6b85e40ea85))

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

**Note:** Version bump only for package @kamado-io/style-compiler

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

**Note:** Version bump only for package @kamado-io/style-compiler

# [0.1.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2025-12-15)

**Note:** Version bump only for package @kamado-io/style-compiler

# [0.1.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2025-12-11)

**Note:** Version bump only for package @kamado-io/style-compiler
