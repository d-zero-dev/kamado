# Migrating from kamado v1.x to v2.x

Mechanical recipe for upgrading a kamado v1 project to v2. Each section is a self-contained transformation; apply top-to-bottom. Before/after blocks are exhaustive — no prose between them. AI agents: skip sections whose Before pattern does not appear in the target project.

Status: v2 is currently in alpha (`2.0.0-alpha.x`). Pin to the exact version in `package.json`; do not use `^`.

---

## 0. Prerequisites

- Node.js 24+
- Yarn 4+ (yarn workspaces; `npm`/`pnpm` not supported by the project layout, individual consumers may use any package manager that resolves the published packages)
- TypeScript: v2 surfaces generic `<M extends MetaData>` parameters across most public types. Strict mode recommended.

---

## 1. Bump package versions

File: `package.json`

```diff
- "kamado": "^1.3.0",
+ "kamado": "2.0.0-alpha.17",
- "@kamado-io/page-compiler": "^1.x",
+ "@kamado-io/page-compiler": "2.0.0-alpha.17",
- "@kamado-io/script-compiler": "^1.x",
+ "@kamado-io/script-compiler": "2.0.0-alpha.17",
- "@kamado-io/style-compiler": "^1.x",
+ "@kamado-io/style-compiler": "2.0.0-alpha.17",
- "@kamado-io/pug-compiler": "^1.x",
+ "@kamado-io/pug-compiler": "2.0.0-alpha.17",
```

Replace `2.0.0-alpha.17` with the actual latest tag (`npm view kamado dist-tags`). Run `yarn install` after editing.

---

## 2. Compiler constants → factory functions (curried)

Every compiler that was a bare callable in v1 is now a factory returning a callable: `createX<M>()(opts)`.

**Why curried**: v2 propagates a generic `<M extends MetaData>` (custom frontmatter) through every compiler. TypeScript does not support partial type-argument inference, so a single-stage `createPageCompiler<M>(opts)` would force the caller to specify either both `M` and `opts` or neither. Splitting into two calls lets the caller pin `M` on the first call and have `opts` inferred on the second. The same pattern is used in Zustand, tRPC, and similar libraries. The extra `()` is the cost. Once TypeScript's partial inference proposal lands, the curry can be unwound — that will be another major version, not a v2 patch.

### 2a. Imports

```diff
- import { pageCompiler } from '@kamado-io/page-compiler';
+ import { createPageCompiler } from '@kamado-io/page-compiler';
- import { styleCompiler } from '@kamado-io/style-compiler';
+ import { createStyleCompiler } from '@kamado-io/style-compiler';
- import { scriptCompiler } from '@kamado-io/script-compiler';
+ import { createScriptCompiler } from '@kamado-io/script-compiler';
- import { createCompileHooks } from '@kamado-io/pug-compiler';
+ import { createCompileHooks } from '@kamado-io/pug-compiler';   // name unchanged, signature is now curried (see 4)
```

### 2b. Call sites (see also section 3 for the surrounding `compilers:` shape)

Find: `pageCompiler(` / `styleCompiler(` / `scriptCompiler(` not preceded by `create`.
Replace each with `createPageCompiler()(` / `createStyleCompiler()(` / `createScriptCompiler()(`.

---

## 3. `Config.compilers` array → callback `(def) => [...]`

File: `kamado.config.ts` (or wherever `Config` / `UserConfig` is declared)

```diff
- import type { UserConfig } from 'kamado/config';
+ import { defineConfig } from 'kamado/config';
+ // `UserConfig` still exists but `defineConfig` gives better inference.

- import { pageCompiler } from '@kamado-io/page-compiler';
- import { styleCompiler } from '@kamado-io/style-compiler';
- import { scriptCompiler } from '@kamado-io/script-compiler';
+ import { createPageCompiler } from '@kamado-io/page-compiler';
+ import { createStyleCompiler } from '@kamado-io/style-compiler';
+ import { createScriptCompiler } from '@kamado-io/script-compiler';

- export const config: UserConfig = {
+ export default defineConfig({
    dir: { /* unchanged */ },
    devServer: { /* unchanged */ },
-   compilers: [
-     pageCompiler({ /* opts */ }),
-     styleCompiler({ /* opts */ }),
-     scriptCompiler({ /* opts */ }),
-   ],
+   compilers: (def) => [
+     def(createPageCompiler(), { /* opts */ }),
+     def(createStyleCompiler(), { /* opts */ }),
+     def(createScriptCompiler(), { /* opts */ }),
+   ],
- };
+ });
```

`UserConfig` and the named-`config` export still work; only `defineConfig` is added as a typed shorthand. Migrate to `defineConfig` for better generic inference if you customize `MetaData`.

---

## 4. `createCompileHooks` is now curried (pug-compiler)

Same curry pattern as section 2 — `createCompileHooks<M>()` pins the metadata type, the second call infers options.

```diff
- compileHooks: createCompileHooks({ basedir: '/...' }),
+ compileHooks: createCompileHooks()({ basedir: '/...' }),
```

If you parameterize `MetaData` (see section 8), insert it on the factory:

```ts
compileHooks: createCompileHooks<MyMeta>()({ basedir: '/...' }),
```

---

## 5. `afterSerialize` / `beforeSerialize` → `manipulateDOM` transform

v1 attached DOM hooks directly to `pageCompiler` options. v2 puts them inside the `transforms` pipeline.

**Why**: v1's two hard-coded hook slots could not be composed or reordered. v2 generalizes them into a `Transform` interface that the rest of the pipeline (`prettier`, `minifier`, `inject-to-head`, user-supplied transforms) already implements. The new shape lets the caller insert/remove/reorder/replace any stage, and lets third-party packages publish reusable transforms.

### Before (v1)

```ts
pageCompiler({
	files: '**/*.html',
	imageSizes: true,
	async afterSerialize(elements, window, isServe, context) {
		// mutate elements / window
	},
	async beforeSerialize(html, context) {
		return html.replace(/foo/g, 'bar');
	},
});
```

### After (v2)

```ts
import { createPageCompiler, manipulateDOM } from '@kamado-io/page-compiler';

def(createPageCompiler(), {
	files: '**/*.html',
	transforms: (defaults) => [
		manipulateDOM({
			imageSizes: true,
			hook: async (elements, window, ctx) => {
				// mutate elements / window. ctx is ManipulateDOMHookContext:
				// ctx.isServe, ctx.path, ctx.context, ctx.baseURL, ctx.getHref(el).
			},
		}),
		...defaults.slice(1), // keep doctype/prettier/minifier/lineBreak
	],
});
```

Notes:

- The hook's third argument changed: v1 `(elements, window, isServe, context)` → v2 `(elements, window, ctx)` where `ctx` is `ManipulateDOMHookContext<M>` (carries `isServe` and the rest as named fields, plus `baseURL` and `getHref`).
- `beforeSerialize` has no direct equivalent; the equivalent is a custom `Transform` placed before `manipulateDOM` in the pipeline (write a `{ name, transform }` object).
- `imageSizes: true | false | ImageSizesOptions` moved into `manipulateDOM({ imageSizes })`.

---

## 6. DOM types: lib.dom → linkedom-derived

v2 parses HTML through linkedom, not jsdom. The hook signature uses linkedom-derived types re-exported from `kamado/utils/dom`.

**Why**: linkedom benchmarks roughly 3.9× faster build / 47% lower RSS than jsdom on this project's workload and drops 38+ transitive dependencies. The trade-off is that linkedom is **intentionally not 100% spec-compliant** — see ARCHITECTURE.md "DOM Library (linkedom)" for the compatibility table. The kamado-side compensation (auto `<head>`, null `documentElement` fallback, `--!>` normalization, `ctx.getHref`) is in `packages/kamado/src/utils/dom.ts`.

```diff
- import type { Element } from 'lib.dom';   // implicit globals
+ import type { DomElement, DomWindow } from 'kamado/utils/dom';

  manipulateDOM({
-   hook: async (elements: readonly Element[], window: Window, ctx) => { ... },
+   hook: async (elements: readonly DomElement[], window: DomWindow, ctx) => { ... },
  })
```

Hook code that relied on jsdom-only behavior must be rewritten:

| v1 (jsdom)                                            | v2 (linkedom)                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------- |
| `el.getBoundingClientRect()`                          | not implemented — remove or compute externally                   |
| `window.getComputedStyle(el)`                         | not implemented — remove or compute externally                   |
| `(el as HTMLAnchorElement).href` returns absolute URL | returns the raw attribute. Use `ctx.getHref(el)` instead.        |
| `document.baseURI`                                    | empty/`about:blank`. Use `ctx.baseURL`.                          |
| `window.location.href`                                | not populated. Use `ctx.baseURL`.                                |
| `Document.head` always present                        | auto-inserted for full-document inputs; not for fragment inputs. |
| Comments use `-->` only                               | `-->` and `--!>` (HTML5-tolerated) both accepted.                |

---

## 7. Removed: `manipulateDOM({ host })` and `domSerialize({ url })`

Both `host` (on `manipulateDOM`) and `url` (on `domSerialize`) were deleted. Replacement is automatic via `ctx.baseURL`.

**Why**: linkedom does not populate `window.location` / `Document.baseURI`, so the v1 trick of "tell jsdom which URL we're at, then read `<a>.href`" no longer works. Two options closed: either reimplement URL reflection in user code (verbose, easy to get wrong, leaks credentials in `https://user:pass@…` bases), or surface a first-class helper. v2 chose the helper. As a side effect of moving URL resolution into kamado's helper, dangerous schemes (`javascript:`/`data:`/etc.) and basic-auth credentials are stripped centrally instead of being every hook author's responsibility.

```diff
  manipulateDOM({
-   host: 'https://example.com',
    hook: (elements, window, ctx) => {
-     const abs = new URL(el.getAttribute('href'), 'https://example.com');
+     const abs = ctx.getHref(el);
    },
  })
```

`ctx.baseURL` resolves automatically:

- serve mode → `http://${devServer.host}:${devServer.port}`
- build mode → `pkg.production.baseURL`, falling back to `https://${pkg.production.host}`
- `undefined` if neither is configured

`ctx.getHref(el)` returns `null` for dangerous schemes (`javascript:` / `data:` / `vbscript:` / `file:`) and strips basic-auth credentials. Safe to interpolate into rendered HTML.

For non-`href` URL attributes (e.g. `<img src>`), call directly:

```ts
const abs = ctx.baseURL ? new URL(el.getAttribute('src') ?? '', ctx.baseURL).href : null;
```

---

## 8. Generic `MetaData` parameter (`<M extends MetaData>`)

v2 propagates a generic `M extends MetaData` through `Config`, `Context`, `PageCompilerOptions`, navigation/breadcrumb structures, and hook contexts. **This is the reason every compiler factory in sections 2–4 is curried** — pinning `M` requires a separate call from the options so TypeScript can infer the latter independently.

If you have not customized frontmatter, no edit is required — defaults flow through.

If you customize frontmatter:

```ts
import type { MetaData } from 'kamado/files';

interface MyMeta extends MetaData {
	readonly seoTitle?: string;
	readonly noindex?: boolean;
}

createPageCompiler<MyMeta>()({
	layouts: {
		/* ... */
	},
	filterNavigationNode: (node) => !node.meta.noindex,
});

createCompileHooks<MyMeta>()({ basedir: '/...' });

defineConfig<MyMeta>({
	/* ... */
});
```

---

## 9. `features` module removed

The `kamado/features` deep import is gone. Use the page-compiler exports.

**Why**: navigation / breadcrumb / title-list helpers live conceptually inside page compilation, not the kamado core. v1 already marked the module `@deprecated` in `1.x` and pointed users at `@kamado-io/page-compiler`; v2 finishes the move.

```diff
- import { getBreadcrumbs, getNavTree, titleList, getTitle } from 'kamado/features';
+ // breadcrumbs / nav are now built-in to createPageCompiler and exposed via page data
+ // titleList: read PageData.title from data/map output
+ // getTitle: read metaData.title directly (auto-population removed)
```

Behavior changes:

- `pageList` return shape: `title: string` → `PageData` (object with `title`, `path`, `meta`, …). Read `.title` from the new shape.
- Title auto-population is removed. Set `metaData.title` explicitly in frontmatter or via `compileHooks.main.before`.

---

## 10. Renames

**Why**: `filter` was ambiguous (every option called `filter` could mean "filter the file list" or "filter nodes in the nav tree"). The new names spell out the target. `transformNode` returning `NavNode` invited mutation; switching to `boolean` separates "decide to keep" from "decide to rewrite" (rewrites go through `transformBreadcrumbItem` / a custom `Transform`).

Apply these one-for-one. Search regex shown.

| Find (regex)                                             | Replace                  |
| -------------------------------------------------------- | ------------------------ |
| `\.filter:\s*\(` in `PageCompilerOptions` literals       | `.filterNavigationNode:` |
| `transformNode:` in `getNavTree` / `PageCompilerOptions` | `filter:`                |
| `transformNavNode:`                                      | `filter:`                |

`transformNode` previously returned a `NavNode` (could mutate). v2 `filter` returns `boolean` — `true` keeps, `false` removes. If your v1 callback was mutating the node, move the mutation into `transformBreadcrumbItem` or a custom `Transform`.

```diff
  createPageCompiler()({
-   filter: (node) => ({ ...node, label: node.label.toUpperCase() }),
+   filter: (node) => !node.meta?.hidden,
+   transformBreadcrumbItem: (item) => ({ ...item, label: item.label.toUpperCase() }),
  });
```

---

## 11. Prettier error policy moved to pipeline-level (alpha.16)

**Why**: a per-transform `parseError` option meant configuring "what happens when prettier throws" separately from "what happens when minifier / a custom transform throws". The pipeline-level `formatOptions.parseError` applies the same policy to every transform uniformly, and the new error message format (`Transform '<name>' failed on <source>: <original>`) carries the failing transform's name so a single policy can still tell errors apart.

```diff
  prettier({
    options: { /* ... */ },
-   parseError: 'warning',  // PrettierOptions.parseError removed
  })

  createPageCompiler()({
+   formatOptions: { parseError: 'warning' }, // applies to every transform
  });
```

Type rename: `PrettierParseErrorMode` → `ParseErrorMode` (imported from the package entry).

Error-message format also changed to `Transform '<name>' failed on <source>: <original>`. Any log scraping needs to update its pattern.

`DefaultPageTransformsOptions` is removed; `createDefaultPageTransforms()` no longer accepts arguments.

```diff
- createDefaultPageTransforms({ prettier: { parseError: 'silent' } })
+ createDefaultPageTransforms()
+ // configure error policy via formatOptions.parseError on createPageCompiler() options
```

---

## 12. `kamado/files` re-exports changed

| v1 import                                                | v2 equivalent                                                  |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| `getFile`, `getContentFromFile` (combined in one helper) | split into `getContentFromFile` and `getContentFromFileObject` |
| `trackDependency`                                        | unchanged                                                      |
| `collectDependencies`                                    | unchanged                                                      |

Most user configs do not touch these — skip unless you have custom transforms / hooks that read raw files.

---

## 13. New additive features (no migration required, optional adoption)

These exist in v2 but do not force changes to v1 code paths.

- `defineConfig<M>(config)` — type-safe `kamado.config.ts` helper.
- `outputPathField` — frontmatter-driven output paths (similar to 11ty `permalink`). Opt-in via `createPageCompiler()({ outputPathField: 'path' })`.
- `outputPathConflict` — policy for collisions.
- `devServer.proxy` — proxy routes through the dev server.
- `kamado build --incremental` + `--cache-dir` + `--force` — verifying-trace incremental builds (~40× on no-change rebuilds).
- `kamado build --skip-unchanged` — skip writes when bytes are identical.
- `manipulateDOM` hook's `ctx.getHref(el)` / `ctx.baseURL` — URL resolution helpers.

---

## 14. Verification

Run after applying all sections:

```bash
yarn install
yarn build      # tsc must pass
yarn test       # if the project has its own tests; for a kamado-consumer project, run the consumer's own test command
```

Type-checking failures are the primary signal that a v1 pattern was missed. The most common holdouts are:

- bare `pageCompiler(` / `styleCompiler(` / `scriptCompiler(` calls (section 2)
- `compilers: [ ... ]` literal array (section 3)
- `afterSerialize` / `beforeSerialize` on pageCompiler options (section 5)
- jsdom-only DOM APIs in hooks (section 6)
- `host:` on `manipulateDOM` options (section 7)

Then run the build end-to-end:

```bash
kamado build                           # full build
kamado build --incremental             # cold incremental seed
kamado build --incremental             # confirm no-change rebuild is fast
kamado server                          # dev server boots
```

---

## 15. Rollback

v1 and v2 cannot share a single `kamado.config.ts`. To roll back:

```bash
git checkout -- kamado.config.ts        # revert config changes
# in package.json: pin every kamado package back to ^1.3.0
yarn install
```

The published v1.3.0 tags are immutable; rollback by version pin alone is safe.

---

## Quick checklist (for an agent's planning step)

1. [ ] Update versions in `package.json` (section 1)
2. [ ] Replace bare compiler constants with curried factories (section 2)
3. [ ] Convert `compilers:` array to callback (section 3)
4. [ ] Curry `createCompileHooks` (section 4)
5. [ ] Move `afterSerialize` / `beforeSerialize` into `manipulateDOM` transform (section 5)
6. [ ] Replace lib.dom hook types with `DomElement` / `DomWindow` (section 6)
7. [ ] Remove `manipulateDOM({ host })` / `domSerialize({ url })`; switch URL resolution to `ctx.getHref` / `ctx.baseURL` (section 7)
8. [ ] Add generic `<M>` parameters if frontmatter is customized (section 8)
9. [ ] Migrate `kamado/features` imports to page-compiler exports (section 9)
10. [ ] Apply renames (section 10)
11. [ ] Move prettier `parseError` to `formatOptions.parseError` (section 11)
12. [ ] `yarn install && yarn build` to surface remaining type errors (section 14)
