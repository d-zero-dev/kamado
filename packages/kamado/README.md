# Kamado

[![npm version](https://badge.fury.io/js/kamado.svg)](https://www.npmjs.com/package/kamado)

**Kamado is an extremely simple static site build tool.** No hydration, no client-side runtime, no magic. Pure static HTML, baked on demand.

設計の詳細・実行フロー・依存追跡・キャッシュ戦略・型システム上の制約は [ARCHITECTURE.md](./ARCHITECTURE.md) を参照。

## Installation

```sh
yarn add kamado
```

## 基本的な使い方

`kamado.config.ts` をプロジェクトルートに作成:

```ts
import path from 'node:path';

import { defineConfig } from 'kamado/config';
import { createPageCompiler } from '@kamado-io/page-compiler';
import { createScriptCompiler } from '@kamado-io/script-compiler';
import { createStyleCompiler } from '@kamado-io/style-compiler';

export default defineConfig({
	dir: {
		root: import.meta.dirname,
		input: path.resolve(import.meta.dirname, '__assets', 'htdocs'),
		output: path.resolve(import.meta.dirname, 'htdocs'),
	},
	devServer: { port: 8000, open: true },
	compilers: (def) => [
		def(createPageCompiler(), {
			files: '**/*.html',
			outputExtension: '.html',
		}),
		def(createStyleCompiler(), {
			files: '**/*.{css,scss,sass}',
			ignore: '**/*.{scss,sass}',
			outputExtension: '.css',
		}),
		def(createScriptCompiler(), {
			files: '**/*.{js,ts,jsx,tsx,mjs,cjs}',
			outputExtension: '.js',
			minifier: true,
		}),
	],
});
```

CLI:

```sh
kamado build              # 静的ビルド
kamado server             # 開発サーバ起動
kamado build --incremental  # キャッシュベースの増分ビルド
kamado build --skip-unchanged  # 出力が同一ならスキップ（mtime 保持）
```

各オプション・各 compiler の設定値は型定義（`Config<M>`、`CompilerOptions`）と各 compiler パッケージの README を参照。

## 重要な罠・設計上の注意

### `compileHooks` / `transforms` の解決タイミング

関数で渡した場合、解決は **ビルド/サーブごとに 1 回**（ファイルごとではない）。並列コンパイル中のすべてのページが**同じインスタンスを共有**するため、ファイル間で状態を持たせてはいけない。

### `pageList` フックの `metaData`

`pageList` 実行時点では `metaData` はまだ frontmatter から populate されていない。breadcrumbs/navigation で `__NO_TITLE__` を避けるには、`pageList` 内で `metaData.title` を明示的に設定する必要がある。

### `outputPathField` は opt-in

frontmatter の特定フィールドから出力パスを上書きする機能はデフォルト off。既存プロジェクトの frontmatter キーが routing として誤解釈されないため。詳細は [`@kamado-io/page-compiler`](../@kamado-io/page-compiler/) の README。

### `devServer.transforms` と Page Compiler の `transforms` の違い

| 項目     | `devServer.transforms`               | `createPageCompiler({ transforms })` |
| -------- | ------------------------------------ | ------------------------------------ |
| スコープ | serve のみ                           | build + serve 両方                   |
| 対象     | 全レスポンス（HTML/CSS/JS/画像など） | コンパイル後 HTML のみ               |
| `filter` | 有効                                 | 無視（全 HTML を処理）               |

同じ `Transform` インターフェース（`kamado/config`）を使うが、上記の通り適用範囲が異なる。

### `sourcemap: 'onServer'`（デフォルト）

`kamado server` 時のみ source map を埋め込み、`kamado build` では出力しない。常に出すなら `true`、常に出さないなら `false`。

## 主要 API

### `devServer.transforms` — レスポンス変換

```ts
defineConfig({
	devServer: {
		transforms: [
			{
				name: 'inject-dev-script',
				filter: { include: '**/*.html' },
				transform: (content) => {
					if (typeof content !== 'string') {
						content = new TextDecoder('utf-8').decode(content);
					}
					return content.replace('</body>', '<script src="/__dev.js"></script></body>');
				},
			},
		],
	},
});
```

非 HTML は `ArrayBuffer` で渡る点に注意（`TextDecoder` で復号）。transform 内のエラーはサーバを落とさず、元のコンテンツが返る。

### `devServer.proxy` — 外部 API への転送

```ts
defineConfig({
	devServer: {
		proxy: {
			'/api': 'https://backend.example.com',
			'/api/v2': {
				target: 'https://api-v2.example.com',
				pathRewrite: (path) => path.replace(/^\/api\/v2/, ''),
				changeOrigin: true,
			},
		},
	},
});
```

ストリーミング転送。全 HTTP メソッド対応。serve 時のみ動作（build には影響しない）。

### Hooks

`onBeforeBuild` / `onAfterBuild` は `Context`（`Config` + `mode: 'build' | 'serve'`）を受け取る。`mode` は CLI コマンドで自動設定され、ユーザは変更できない。詳細は [ARCHITECTURE.md](./ARCHITECTURE.md#config-vs-context) 参照。

### Page List

```ts
defineConfig({
	pageList: async (pageAssetFiles, config) => {
		return pageAssetFiles.filter((p) => !p.url.includes('/drafts/'));
	},
});
```

External page を追加する場合は `urlToFile` を使う（`kamado/files` から import）。

## License

MIT
