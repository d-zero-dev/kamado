# Kamado

![kamado](./assets/kamado_logo.png)

**Kamado is a distinctively simple static site generator.**
No hydration, no client-side runtime, no magic. Just your filesystem and raw HTML, baked on demand.

[English Documentation](./packages/kamado/README.md) | [日本語ドキュメント](./packages/kamado/README.ja.md)

---

## About Kamado

Kamado is a static site build tool that aims for a simpler design, similar to 11ty but with a focus on "No Runtime". It generates pure static HTML, ensuring robustness and longevity.

For detailed usage and configuration, please refer to the documentation below:

- 📖 [Kamado Package README (English)](./packages/kamado/README.md)
- 📖 [Kamado Package README (日本語)](./packages/kamado/README.ja.md)

## Monorepo Structure

This repository is a monorepo managed by Lerna.

| Package           | Description                                  | Version                                                                                     |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `packages/kamado` | The core logic of the static site generator. | [![npm version](https://badge.fury.io/js/kamado.svg)](https://www.npmjs.com/package/kamado) |

## Development

### Prerequisites

- Node.js
- Yarn

### Commands

Run these commands from the root directory:

- `yarn build`: Build all packages.
- `yarn dev`: Run development scripts.
- `yarn test`: Run tests using Vitest.
- `yarn lint`: Run linters (ESLint, Prettier, textlint, cspell).

### Contributing

Please read the documentation in `packages/kamado` for details on how Kamado works.

### License

MIT
