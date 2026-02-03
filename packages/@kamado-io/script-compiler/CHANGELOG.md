# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v1.3.0...v2.0.0-alpha.0) (2026-02-03)

- refactor(script-compiler)!: remove index.ts and use script-compiler.ts ([657147d](https://github.com/d-zero-dev/kamado/commit/657147d3317f0c416599d4f8d9c8a98d83dfb90e))
- feat(script-compiler)!: use createCustomCompiler from kamado ([ba49260](https://github.com/d-zero-dev/kamado/commit/ba492605e6c79376dcf34c8615f1497521631f5f))

### BREAKING CHANGES

- Internal file structure changed. Public API unchanged.

* Create src/script-compiler.ts (move impl from index.ts)
* Update package.json (main, types, exports)
* Delete src/index.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

- Update import to use renamed createCustomCompiler function

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.3.0](https://github.com/d-zero-dev/kamado/compare/v1.2.0...v1.3.0) (2026-01-29)

**Note:** Version bump only for package @kamado-io/script-compiler

# [1.2.0](https://github.com/d-zero-dev/kamado/compare/v1.1.0...v1.2.0) (2026-01-09)

**Note:** Version bump only for package @kamado-io/script-compiler

# [1.1.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0...v1.1.0) (2026-01-07)

**Note:** Version bump only for package @kamado-io/script-compiler

# [1.0.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package @kamado-io/script-compiler

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

### Features

- **script-compiler:** adapt to new compiler API with metadata ([04647b9](https://github.com/d-zero-dev/kamado/commit/04647b9d152e0958bdb6380b852a5f1bd4ac5c6e))

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

### Features

- **script-compiler:** adapt to new compiler API with metadata ([04647b9](https://github.com/d-zero-dev/kamado/commit/04647b9d152e0958bdb6380b852a5f1bd4ac5c6e))

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

### Bug Fixes

- **script-compiler:** use temporary directory for esbuild output ([ffa9cbe](https://github.com/d-zero-dev/kamado/commit/ffa9cbef130ed703621f33069db5c6e51dc242e6))

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

**Note:** Version bump only for package @kamado-io/script-compiler

# [0.1.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.4...v0.1.0-alpha.5) (2025-12-15)

**Note:** Version bump only for package @kamado-io/script-compiler

# [0.1.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.3...v0.1.0-alpha.4) (2025-12-11)

### Bug Fixes

- **script-compiler:** use dynamic import for esbuild to avoid runtime error ([1775694](https://github.com/d-zero-dev/kamado/commit/17756949b8e486c571279a3a254d279d61e3753c))
