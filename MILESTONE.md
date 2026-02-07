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

## Migration Guide

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
