# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [3.0.0-alpha.3](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.2...v3.0.0-alpha.3) (2026-11-02)

### Bug Fixes

- **kamado:** listen on both loopback addresses for localhost ([cacca9e](https://github.com/d-zero-dev/kamado/commit/cacca9eebf3c0e2dcb0c083ff3fecc0b83fd518c))
- **kamado:** open the dev server again when telling it to forget an answer left it unusable ([79b45b3](https://github.com/d-zero-dev/kamado/commit/79b45b3bb2c1f405b4a62d8c465bb1ce6b10678c))
- **kamado:** resolve the globs of kamado build from the cwd and those of build() from the config ([857a080](https://github.com/d-zero-dev/kamado/commit/857a0805f0648025cdc431cb82934f99278329aa))
- **kamado:** run the table generator on react-dom 19.3.0 and add the booleans of one element ([9dd72dd](https://github.com/d-zero-dev/kamado/commit/9dd72dd8920b8fcc617c6e17bf4fb9bb8b4e9a4d))
- **kamado:** write the selected of an option where it was given in a static page ([f007697](https://github.com/d-zero-dev/kamado/commit/f0076972098ed3f5a70a7b2baecb03445653f327))

### Features

- **kamado:** answer a byte range of a file in the dev server ([9cfaced](https://github.com/d-zero-dev/kamado/commit/9cfacede2e215c2488d81b13913802e5b27ab216)), closes [#220](https://github.com/d-zero-dev/kamado/issues/220) [#220](https://github.com/d-zero-dev/kamado/issues/220)
- **kamado:** drop the print width from the HTML formatter and its config ([61b5a91](https://github.com/d-zero-dev/kamado/commit/61b5a91a7a5e0d3667e21f026292d13f8d8cd89b))
- **kamado:** open the dev server's native core again after a panic ([a07d97b](https://github.com/d-zero-dev/kamado/commit/a07d97b52c12a650989835a425d450360e0ff74b)), closes [#295](https://github.com/d-zero-dev/kamado/issues/295)
- **kamado:** refuse requests to other hosts and from other sites on the dev server ([0ea0f0a](https://github.com/d-zero-dev/kamado/commit/0ea0f0ab3b8e0f9f1017103e75affd1f559f8d87))
- **repo:** accept devServer.allowedHosts in the config ([54d84e2](https://github.com/d-zero-dev/kamado/commit/54d84e28a4124009d60f8175dee1f8cd34fb06a2))

# [3.0.0-alpha.2](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.1...v3.0.0-alpha.2) (2026-10-09)

### Features

- **kamado:** type the result of html() as a child that React accepts ([78ed12a](https://github.com/d-zero-dev/kamado/commit/78ed12a1040ced0207e46faaddb1cea3e24e2b3d))

# [3.0.0-alpha.1](https://github.com/d-zero-dev/kamado/compare/v2.0.0-alpha.17...v3.0.0-alpha.1) (2026-10-07)

- feat(repo)!: make v3 the kamado package and move v2 to its own branch ([945f10a](https://github.com/d-zero-dev/kamado/commit/945f10ade55c996755b6d7348572a2588833896e)), closes [#277](https://github.com/d-zero-dev/kamado/issues/277)

### Bug Fixes

- **kamado:** keep the frozen v2 copy out of the build ([03fd9f9](https://github.com/d-zero-dev/kamado/commit/03fd9f91c129bd049ad37472339363d0ec4f4d6f))

### Features

- **github:** publish kamado with the addons of all platforms ([64d57cf](https://github.com/d-zero-dev/kamado/commit/64d57cf1f2e4f9be8d696b46b07996a7a32d8bac))

### BREAKING CHANGES

- `kamado` is v3. v2 users stay on the 2.x releases (v2
  branch).
