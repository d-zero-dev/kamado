# Kamado

![kamado](https://cdn.jsdelivr.net/gh/d-zero-dev/kamado@main/assets/kamado_logo.png)

**Kamado is a distinctively simple static site generator.**
No hydration, no client-side runtime, no magic. Just your filesystem and raw HTML, baked on demand.

---

## About Kamado

Kamado is a static site build tool that aims for a simpler design, similar to 11ty but with a focus on "No Runtime". It generates pure static HTML, ensuring robustness and longevity.

This is **v3**: the core is written in Rust (standard library only), with a thin Node layer for the CLI, the dev server and JSX rendering. It is under alpha development; the package carries the addon of every supported platform (macOS arm64 / x64, Linux x64 / arm64 with glibc).

**v2** (the `kamado` and `@kamado-io/*` packages on npm) is maintained on the [`v2` branch](https://github.com/d-zero-dev/kamado/tree/v2). The published v2 releases stay on npm.

- 📖 [Kamado Package README (日本語)](./packages/kamado/README.md)
- 📐 [v3 RFC (仕様)](./docs/v3/RFC.md)
- 🚚 [v2 → v3 移行手順](./docs/v3/MIGRATION.md)
- 🛠️ [v3 の開発手順](./docs/v3/development.md)

## Repository Structure

| Path              | Description                                                                             |
| ----------------- | --------------------------------------------------------------------------------------- |
| `crates/`         | Rust workspace (`kd_*`). No external crates                                             |
| `packages/kamado` | The Node layer: the `kamado` package (CLI, `build()` / `start()`, `kamado/jsx`)         |
| `docs/v3`         | RFC, migration guide, development guide                                                 |
| `benchmarks/`     | Output comparison harness and fixture generator (`v3`), the v2 baseline (`v2-baseline`) |
| `scripts/`        | Generators for tables and golden files, differential tests                              |

Lerna is kept for versioning and publishing the single workspace package.

## Development

### Prerequisites

- Node.js 24.11 or later (Volta pins 26.x)
- Yarn 4 (via Corepack)
- Rust 1.98.1 (the version CI uses)

### Commands

Run these commands from the root directory:

- `yarn build`: Build the Node package.
- `yarn test`: Run tests using Vitest.
- `yarn lint`: Run linters (ESLint, Prettier, textlint, cspell).
- `cargo fmt --all`, `cargo clippy --locked --offline --all-targets -- -D warnings`, `cargo test --locked --offline --workspace`: Format, lint and test the Rust workspace.

See [`docs/v3/development.md`](./docs/v3/development.md) for the details (the native addon, the oracle scripts, the benchmarks).

### Contributing

Please read [`docs/v3/RFC.md`](./docs/v3/RFC.md) for how Kamado v3 works.

### License

MIT
