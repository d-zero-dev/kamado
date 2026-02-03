# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v1.3.0...v2.0.0-alpha.0) (2026-02-03)

- refactor(pug-compiler)!: remove index.ts and use pug-compiler.ts ([f8c798b](https://github.com/d-zero-dev/kamado/commit/f8c798b2402b3f48ebb80e9a37422e3a4f6ed255))

### BREAKING CHANGES

- Internal file structure changed. Public API unchanged.

* Create src/pug-compiler.ts (re-exports)
* Rename src/index.spec.ts to src/pug-compiler.spec.ts
* Update spec import path
* Update package.json (main, types, exports)
* Delete src/index.ts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>

# [1.3.0](https://github.com/d-zero-dev/kamado/compare/v1.2.0...v1.3.0) (2026-01-29)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [1.2.0](https://github.com/d-zero-dev/kamado/compare/v1.1.0...v1.2.0) (2026-01-09)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [1.1.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0...v1.1.0) (2026-01-07)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [1.0.0](https://github.com/d-zero-dev/kamado/compare/v1.0.0-alpha.1...v1.0.0) (2026-01-05)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [1.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.1) (2025-12-21)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [1.0.0-alpha.0](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.7...v1.0.0-alpha.0) (2025-12-21)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [0.1.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.6...v0.1.0-alpha.7) (2025-12-18)

**Note:** Version bump only for package @kamado-io/pug-compiler

# [0.1.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v0.1.0-alpha.5...v0.1.0-alpha.6) (2025-12-15)

### Features

- **pug-compiler:** add pug compiler package ([6f0e1df](https://github.com/d-zero-dev/kamado/commit/6f0e1df23b01f56fbcd7128e19d44b5e6bc6196e))
- **pug-compiler:** refactor API and add createCompileHooks helper ([41c4c1a](https://github.com/d-zero-dev/kamado/commit/41c4c1a717e2ad9e1e515825052e1df938dd1c64))
