# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [2.0.0-alpha.17](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.16...v2.0.0-alpha.17) (2026-08-12)

### Bug Fixes

- **page-compiler:** close incremental-build staleness gaps in bundled compilers ([6f5509e](https://github.com/d-zero-dev/kamado/commit/6f5509e64cbf583aabee038a897314870c91e79b))

### Features

- **jsx-compiler:** add JSX/TSX compiler package for React SSR ([77c6dc5](https://github.com/d-zero-dev/kamado/commit/77c6dc5158342814cdd997e24312d39a3777702e))
- **page-compiler:** report incremental-build inputs from the bundled compilers ([93d371c](https://github.com/d-zero-dev/kamado/commit/93d371c6ff8827b57bf82174f4a7d55d01534bb1))
- **script-compiler:** add inline sourcemap option ([ef1747e](https://github.com/d-zero-dev/kamado/commit/ef1747e3f7afb2a36e1f87c3c48b2c20f16ee418))
- **script-compiler:** bundle in memory and select output by path ([fb87d98](https://github.com/d-zero-dev/kamado/commit/fb87d986b777371be39bf7efd0a63df7eeb672fc))
- **script-compiler:** default sourcemap to 'onServer' ([e3c1a53](https://github.com/d-zero-dev/kamado/commit/e3c1a536d4287f7f64f75a4d8cbf15140b7dbc63))
- **script-compiler:** support 'onServer' for sourcemap option ([fdec413](https://github.com/d-zero-dev/kamado/commit/fdec413b7ed109b1554ba1ff06985a577f421718))

# [2.0.0-alpha.16](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.15...v2.0.0-alpha.16) (2026-05-12)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.15](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.14...v2.0.0-alpha.15) (2026-05-12)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.14](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.13...v2.0.0-alpha.14) (2026-05-11)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.13](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.12...v2.0.0-alpha.13) (2026-04-10)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.12](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.11...v2.0.0-alpha.12) (2026-04-07)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.11](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.10...v2.0.0-alpha.11) (2026-04-07)

### Bug Fixes

- **repo:** add repository field to [@kamado-io](https://github.com/kamado-io) packages for OIDC provenance ([90201ed](https://github.com/d-zero-dev/kamado/commit/90201edd92e1e5ac1e889e73ec64fd1f6a1b9e78))

# [2.0.0-alpha.10](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.9...v2.0.0-alpha.10) (2026-04-07)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.9](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.8...v2.0.0-alpha.9) (2026-04-07)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.8](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.7...v2.0.0-alpha.8) (2026-03-24)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.6...v2.0.0-alpha.7) (2026-03-23)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.5...v2.0.0-alpha.6) (2026-03-23)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.4...v2.0.0-alpha.5) (2026-03-23)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.3...v2.0.0-alpha.4) (2026-03-13)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.3](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.2...v2.0.0-alpha.3) (2026-03-12)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.2](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.1...v2.0.0-alpha.2) (2026-03-12)

**Note:** Version bump only for package @kamado-io/script-compiler

# [2.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.0...v2.0.0-alpha.1) (2026-02-07)

- feat(script-compiler)!: convert scriptCompiler to createScriptCompiler generic factory ([77bc9ca](https://github.com/d-zero-dev/kamado/commit/77bc9ca83fcc343aa7760b53e2effeea5a27b0a2))

### BREAKING CHANGES

- Replace scriptCompiler constant with
  createScriptCompiler<M>() factory function to support generic
  MetaData type parameter

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
