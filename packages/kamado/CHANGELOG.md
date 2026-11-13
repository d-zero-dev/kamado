# Change Log

All notable changes to this project will be documented in this file.
See [Conventional Commits](https://conventionalcommits.org) for commit guidelines.

# [3.0.0-alpha.7](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.6...v3.0.0-alpha.7) (2026-11-13)

### Features

* **kamado:** add the sync to the screen of the editor ([ad8ebf3](https://github.com/d-zero-dev/kamado/commit/ad8ebf34f00ddc760ef785844c34cd4b3a69d997))
* **kamado:** expose the batch edit of the editor through the native addon ([62ab561](https://github.com/d-zero-dev/kamado/commit/62ab561fce68956eef6ee539332d629c8354f516))
* **kamado:** give a sync script select, read and write, and confirm an export ([b5bf449](https://github.com/d-zero-dev/kamado/commit/b5bf4491dd3a5344bc2a0ab6f8cb94c11cf37826))
* **kamado:** lay out the columns of kamado ui by the config, and reset them ([4399a38](https://github.com/d-zero-dev/kamado/commit/4399a3832a9289e6603708c00c2575f8018b8b6c))
* **kamado:** read ui.keys from the config ([9913cf6](https://github.com/d-zero-dev/kamado/commit/9913cf64fccc6d70f9a1ccaa77150136eaa0cf46))
* **kamado:** record the data a page reads and add memo and --verify-deps ([cee6f3e](https://github.com/d-zero-dev/kamado/commit/cee6f3e8844bba36ddaef2dbba35ce14b04fd6bb))
* **kamado:** return ui.keys in the answer of the page list ([30674b9](https://github.com/d-zero-dev/kamado/commit/30674b93163dbb61e0077f54bf74413dcde1986c))
* **kamado:** run a sync script and apply what it returns ([c07d2dc](https://github.com/d-zero-dev/kamado/commit/c07d2dcc9a8cd46a00cb9203ae1975e992deb601))
* **kamado:** run the data files that are scripts in a build and in the dev server ([fa90658](https://github.com/d-zero-dev/kamado/commit/fa906588f9302b460824eb190bfb3fa5b0718abf))
* **kamado:** send the commands of the reset button and its dialog through the Invoker Commands API ([53653d7](https://github.com/d-zero-dev/kamado/commit/53653d78d2e870259e0e722fe54a8d44ce8056f6))
* **kamado:** show an export, its writing and its cancel question in the sync dialog ([302dc4f](https://github.com/d-zero-dev/kamado/commit/302dc4f24a1fa869b3ec417e1f5aa5fb8e5e54b6))
* **kamado:** show the key order as a column and follow a page that its edit moves ([04aa443](https://github.com/d-zero-dev/kamado/commit/04aa4439c46d60f7af67a29abe9c5d33addc0bf0))
* **kamado:** show the label and the description of ui.keys in kamado ui ([90f04c2](https://github.com/d-zero-dev/kamado/commit/90f04c29af03a51d68dfdd828482a13c2fad75db))
* **repo:** read the default columns of kamado ui from the config ([678dc9b](https://github.com/d-zero-dev/kamado/commit/678dc9b9eebd148c174087439cad190a659b9107))
* **repo:** read ui.syncFunctions of the config ([5bb479d](https://github.com/d-zero-dev/kamado/commit/5bb479dc0f88b45e97e0cf5881947ed421d0a04c))


# [3.0.0-alpha.6](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.5...v3.0.0-alpha.6) (2026-11-11)

### Bug Fixes

- **kamado:** reject unknown CLI flags and API option keys for build, pages, start, and ui ([d839ada](https://github.com/d-zero-dev/kamado/commit/d839ada84927262a02a9760631fcfaee6e1b98a2))

### Features

- **kamado:** export page and layout prop types from kamado/jsx ([970e747](https://github.com/d-zero-dev/kamado/commit/970e7478841c6d1f8edfa04de1232f12b3f0a658))

# [3.0.0-alpha.5](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.4...v3.0.0-alpha.5) (2026-11-11)

### Bug Fixes

- **kamado:** send the static files of the dev server with no charset ([bcbb188](https://github.com/d-zero-dev/kamado/commit/bcbb188d80b29a03062488b3d673450a040ae3e7))
- **kamado:** write the byte values of head.ts in decimal ([26df2fd](https://github.com/d-zero-dev/kamado/commit/26df2fd788c4678d01984da26ab70caeb539f78f))

### Features

- **kamado:** add the pages command and the pages() API ([3bdffa8](https://github.com/d-zero-dev/kamado/commit/3bdffa8d77e1b77c76e0863fe3c2ba7ae9523136))
- **kamado:** add the screen of kamado ui ([fb88297](https://github.com/d-zero-dev/kamado/commit/fb882978df32eb122b3c3eab9ca3716aff9a6987))
- **kamado:** add, make virtual and remove pages in kamado ui, and show what the plan made ([3a23b18](https://github.com/d-zero-dev/kamado/commit/3a23b187ebb22f4609366247be4b978e0a6e29de))
- **kamado:** declare the editor functions of the addon ([734c4b0](https://github.com/d-zero-dev/kamado/commit/734c4b0bc3388f22828dbc6ca26ca659b1afb8c7))
- **kamado:** edit lists, choices and booleans in kamado ui ([e8b955f](https://github.com/d-zero-dev/kamado/commit/e8b955fa07e62442b600c494b7314311f69e8b3f))
- **kamado:** edit the path of a page file, choose layouts and show the branch in kamado ui ([3f51011](https://github.com/d-zero-dev/kamado/commit/3f5101196d9051468b2a88d06ed49db9400a676f))
- **kamado:** keep the layout of the columns of kamado ui in the settings ([83fa244](https://github.com/d-zero-dev/kamado/commit/83fa2443f9e627d462216a1af831c67d95ba185b))
- **kamado:** pin, reorder and resize the columns of kamado ui ([aa123a0](https://github.com/d-zero-dev/kamado/commit/aa123a0b1c55aa1b8f00669a4b787a604f9822d4))
- **kamado:** read the difference from HEAD and put a value back in the server of kamado ui ([a1d44df](https://github.com/d-zero-dev/kamado/commit/a1d44dffc851bc3c8e6071025d70157914b60193))
- **kamado:** save the settings of kamado ui and add the ui-settings command ([c5084fc](https://github.com/d-zero-dev/kamado/commit/c5084fc5d41c530b1abc3e4c3c9dc1e8b64f1fd1))
- **kamado:** serve the editor of the pages with kamado ui ([f151c3a](https://github.com/d-zero-dev/kamado/commit/f151c3a61601051dfe8e859156e4eed149791f24))
- **kamado:** serve the values of a key and keep the kinds of columns ([4391a76](https://github.com/d-zero-dev/kamado/commit/4391a76c8b9f7fe6881bd3eab567dc78b47f3bae))
- **kamado:** show where a value is written and how it differs from HEAD in kamado ui ([329c6d2](https://github.com/d-zero-dev/kamado/commit/329c6d2005de4a0d59cdd5f60362b16b37f2139e))
- **kamado:** sort the rows of kamado ui by a column and keep the order ([9729328](https://github.com/d-zero-dev/kamado/commit/97293281b501deaa3ae61d643c99b997f4e8ac4d))

# [3.0.0-alpha.4](https://github.com/d-zero-dev/kamado/compare/v3.0.0-alpha.3...v3.0.0-alpha.4) (2026-11-02)

**Note:** Version bump only for package kamado

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
