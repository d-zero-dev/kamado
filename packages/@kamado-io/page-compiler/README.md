# `@kamado-io/page-compiler`

Kamado 用のページコンパイラ。**汎用コンテナ**としてレイアウト適用と HTML フォーマットを担い、テンプレートエンジンは `compileHooks` 経由で差し込む。

## Installation

```sh
yarn add @kamado-io/page-compiler
```

## Usage

```ts
import { defineConfig } from 'kamado/config';
import { createPageCompiler } from '@kamado-io/page-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createPageCompiler(), {
			globalData: { dir: './data' },
			layouts: { dir: './layouts' },
			// transforms 省略時は createDefaultPageTransforms()
		}),
	],
});
```

主要オプション・型定義は `src/types.ts` / `src/page-compiler.ts` を参照。Pug を使うには [`@kamado-io/pug-compiler`](../pug-compiler/) と組み合わせる。

## Transform Pipeline

`createPageCompiler()` のデフォルトは 5 段:

```
manipulateDOM → doctype → prettier → minifier → lineBreak
```

`characterEntities` は含まれないので、必要なら明示的に挟む。

```ts
createPageCompiler()({
	layouts: { dir: './layouts' },
	transforms: (defaults) => [
		{ name: 'pre', transform: (c) => /* ... */ },
		...defaults,
		{ name: 'analytics', transform: (c) => /* ... */ },
	],
});
```

### `Transform` インターフェース

`kamado/config` の `Transform` と同型（`devServer.transforms` と共有）。ただし **page compiler では `filter` が無視される**（全 HTML を処理）。フィルタリングが必要なら `devServer.transforms` 側で行う。

### `formatOptions.parseError` — 失敗時ポリシー

ビルトイン含む全 transform が throw した時の挙動を 1 か所で決める:

- `'silent'`（デフォルト） … 失敗 transform をスキップして前段の出力を次段に渡す
- `'warning'` … `console.warn` してスキップ
- `'error'` … `Error` を throw（`error.cause` に原例外を保持）

### `manipulateDOM` の `baseURL` / `getHref`

linkedom が `window.location` / `Document.baseURI` を populate しないため、ホック内で `ctx.baseURL` と `ctx.getHref(el)` を使う。`getHref` は base 解決済みの絶対 URL を返し、`javascript:` / `data:` / `vbscript:` / `file:` の危険スキームと relative + base 無しケースは `null` を返す（basic-auth 資格情報も結果からスクラブされる）。

## Output Path Override（frontmatter routing）

**opt-in**。`outputPathField: 'path'` のように field 名を指定して有効化（既存 frontmatter キーが routing に誤解釈されないようデフォルト off）。

```ts
def(createPageCompiler(), {
	outputPathField: 'path', // 'permalink' などでも可
});
```

```html
---
path: /docs/getting-started/
---
```

許容される 3 形式:

- `/foo.html` — そのまま
- `/foo` — `outputExtension` を付与
- `/foo/` — `index<outputExtension>` を付与

`.` / `..` セグメントは拒否（`dir.output` 外に出ない保証）。string 以外は無視。JSON sidecar が同名フィールドを持つ場合は **JSON が優先**。

### 衝突時の挙動 `outputPathConflict`

| 値                        | 動作                      |
| ------------------------- | ------------------------- |
| `'error'`                 | abort                     |
| `'warning'`（デフォルト） | stderr に警告、勝者を選ぶ |
| `'silent'`                | 無音で勝者を選ぶ          |

勝者選択: **frontmatter override が default computed path に優先**、同列なら first-seen。順序依存しない（`getAssetGroup` の Map 順）。

> **Note**: `compilableFileMap` は dev server 起動時に 1 度だけ構築されるため、ページ追加や override 変更は `kamado server` 再起動が必要。

## 重要な解決タイミング

`transforms` / `compileHooks` を関数で渡した場合、解決は **ビルド/サーブごとに 1 回**。返したインスタンスは並列コンパイル中の全ページで共有されるため、**ファイル間の可変状態を持たせてはいけない**。

`compileHooks.*.compiler` の `cache` 引数: serve モードでは `false` が渡る（template/include の編集を確実に反映するため）。build モードでは `true`（再利用可）。

## 主要な拡張 API

- `createDefaultPageTransforms()` — デフォルト 5 transforms を返す
- `manipulateDOM({ hook, imageSizes })` — DOM 操作 + 自動画像サイズ
- `characterEntities()` — 非 ASCII → HTML エンティティ
- `prettier({ options })` / `minifier({ options })` / `lineBreak({ lineBreak })`
- `transformBreadcrumbItem` / `filterNavigationNode` / `navigationComparator` — Navigation / Breadcrumb 制御

各 API の詳細・引数仕様は src の JSDoc を参照。
