# Milestone: v2.0.0

## Breaking Changes TODO

- [x] `kamado/features` エクスポートを削除
  - [x] `getBreadcrumbs` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getNavTree` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getTitleList` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getTitle` を削除（`getTitleFromHtmlString` を `@kamado-io/page-compiler/title` で公開）
  - [x] `getTitleFromStaticFile` を削除
  - [x] `kamado/features` に deprecation 警告を追加（v2.0.0 で削除予定）
  - [x] `PageData` 型を追加（`metaData.title` でタイトル管理）
- [x] `compileHooks` / `transforms` の関数形式の解決タイミングを「ファイルごと」から「build/serve コンテキストごとに1回」に変更（ビルド高速化）

## Migration Guide

### `compileHooks` / `transforms` の解決タイミング変更 (v2.0.0)

ビルド高速化のため、`PageCompilerOptions` の `compileHooks` と `transforms` を関数として指定した場合の解決タイミングが変更されました。

#### 変更内容

| API                    | v1.x（変更前）       | v2.0.0（変更後）                          |
| ---------------------- | -------------------- | ----------------------------------------- |
| `compileHooks`（関数） | ページごとに毎回呼出 | build/serve コンテキストごとに1回だけ呼出 |
| `transforms`（関数）   | ページごとに毎回呼出 | build/serve コンテキストごとに1回だけ呼出 |

返されたフック・transform インスタンスは、そのコンテキストの全ページ（並行コンパイルを含む）で共有されます。

#### 影響を受けるケースと対応

ファクトリ関数内でページごとに変わる値を読んでいた場合のみ影響があります。

```ts
// ❌ v1.x ではページごとに評価されていたが、v2.0.0 では起動時に1回だけ評価される
def(createPageCompiler(), {
	transforms: (defaults) => [
		{
			name: 'timestamp',
			transform: (content) => content.replace('%TIME%', factoryTime), // factoryTime はファクトリ実行時に固定
		},
		...defaults,
	],
});

// ✅ v2.0.0 — ページごとに変わる値は transform 関数の「実行時」（content, context を受け取る側）で読む
def(createPageCompiler(), {
	transforms: (defaults) => [
		{
			name: 'timestamp',
			transform: (content) => content.replace('%TIME%', String(Date.now())), // 変換実行時に評価
		},
		...defaults,
	],
});
```

`compileHooks` も同様に、ページごとの動的な値はファクトリ内ではなく `before` / `compiler` / `after` フックの実行時（`content` と `data` を受け取る側）で評価してください。transform / フックのインスタンスにページごとの可変状態（カウンタ・蓄積バッファ等）を持たせることはできません。

ファクトリがページに依存しない初期化のみを行っている場合（`@kamado-io/pug-compiler` の `createCompileHooks` を含む）、対応は不要です。

### `kamado/features` の削除 (v2.0.0)

`kamado/features` エクスポートは v2.0.0 で削除されました。

#### v1.x での使用方法

```ts
import { getBreadcrumbs, getNavTree, titleList } from 'kamado/features';

// テンプレート内で直接使用
const breadcrumbs = getBreadcrumbs(file, pageList, options);
const nav = getNavTree(file, pageList, options);
```

#### v2.0.0 での対応方法

これらの機能は `@kamado-io/page-compiler` 内部で自動的に使用されるため、**直接インポートする必要はありません**。テンプレート内で `breadcrumbs` と `nav()` 関数が自動的に利用可能です。

```pug
// Pug テンプレート例
ul.breadcrumbs
  each item in breadcrumbs
    li= item.title

nav
  each item in nav({ depth: 2 })
    a(href=item.url)= item.meta.title
```

#### カスタマイズが必要な場合

`PageCompilerOptions` の `transformBreadcrumbItem` および `filterNavigationNode` オプションを使用してください。

```ts
import { createPageCompiler } from '@kamado-io/page-compiler';

export const config = {
	compilers: (def) => [
		def(createPageCompiler(), {
			transformBreadcrumbItem: (item) => ({
				...item,
				icon: item.href === '/' ? 'home' : 'page',
			}),
			filterNavigationNode: (node) => !node.url.includes('/drafts/'),
		}),
	],
};
```

詳細は [@kamado-io/page-compiler の README](./packages/@kamado-io/page-compiler/README.md) を参照してください。
