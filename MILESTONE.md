# Milestone: v2.0.0

## Breaking Changes TODO

- [x] `kamado/features` エクスポートを削除
  - [x] `getBreadcrumbs` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getNavTree` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getTitleList` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getTitle` を `@kamado-io/page-compiler` 内部に移動
  - [x] `getTitleFromStaticFile` を `@kamado-io/page-compiler` 内部に移動
  - [x] `kamado/features` に deprecation 警告を追加（v2.0.0 で削除予定）
  - [ ] `CompilableFile` 型の再設計を検討

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
    a(href=item.url)= item.title
```

#### カスタマイズが必要な場合

`PageCompilerOptions` の `transformBreadcrumbItem` および `transformNavNode` オプションを使用してください。

```ts
import { pageCompiler } from '@kamado-io/page-compiler';

export const config = {
	compilers: [
		pageCompiler({
			transformBreadcrumbItem: (item) => ({
				...item,
				icon: item.href === '/' ? 'home' : 'page',
			}),
			transformNavNode: (node) => ({
				...node,
				badge: node.url === '/new' ? 'NEW' : undefined,
			}),
		}),
	],
};
```

詳細は [@kamado-io/page-compiler の README](./packages/@kamado-io/page-compiler/README.md) を参照してください。
