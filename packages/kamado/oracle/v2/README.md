# v2 の oracle（凍結コピー）

`nav()`、`breadcrumbs`、`titleList()` の v3 実装を、v2 の実装と差分テストするための**正解役**。`src/page-data/*.spec.ts` が `src/page-data/v2.test-util.ts` を通して読む。

- 元: kamado 2.0.0-alpha.17（`v2` ブランチの `packages/@kamado-io/page-compiler/src/features/{nav,breadcrumbs,title-list}.ts`）を**そのまま**コピーした。
- v2 は保守のみで、この 3 つの挙動は変わらない前提なので、更新しない。v3 の挙動を変えるときは、RFC で意図した差として書き、spec 側で差を明示する。
- 型だけの `import type ... from 'kamado/files'` は、テスト実行時に消えるので解決しなくてよい。`@d-zero/shared` は root の devDependency（`path-list-to-tree`）。
- `src/` の外に置くのは、ビルド（`tsc` の `rootDir`）の対象にしないため。
