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

`kamado/features` は v2.0.0 で削除されます。これらの機能は `@kamado-io/page-compiler` 内部で自動的に使用されるため、直接インポートする必要はありません。

カスタマイズが必要な場合は、`PageCompilerOptions` の `transformBreadcrumbItem` および `transformNavNode` オプションを使用してください。詳細は [@kamado-io/page-compiler の README](./packages/@kamado-io/page-compiler/README.md) を参照してください。
