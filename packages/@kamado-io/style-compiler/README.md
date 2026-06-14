# `@kamado-io/style-compiler`

Kamado 用の PostCSS ベースの CSS/SCSS/SASS コンパイラ。

## Installation

```sh
yarn add @kamado-io/style-compiler
```

## Usage

```ts
import { defineConfig } from 'kamado/config';
import { createStyleCompiler } from '@kamado-io/style-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createStyleCompiler(), {
			alias: { '@': './src/styles' },
			banner: 'Generated file',
		}),
	],
});
```

オプションは型定義（`files` / `ignore` / `outputExtension` / `alias` / `banner` / `sourcemap`）を参照。

## PostCSS 設定

プロジェクトの `postcss.config.js` を `postcss-load-config` で読み込み、ビルトイン（`postcss-import` + cssnano）の後にユーザプラグインをマージする。`postcss-import` をユーザ側で書いた場合は重複回避のためスキップ。

- **`kamado build`**: 設定はビルドごとに 1 回ロード、processor は全 CSS ファイルで共有
- **`kamado server`**: コンパイルごとにリロード → `postcss.config.js` 編集が dev server 再起動なしで反映
- 読み込み失敗時: ビルトインのみで継続し warning ログ（プラグインが効かない場合はコンソール確認）

## `sourcemap`

デフォルト `'onServer'`。enabled 時、banner は `/*!` important コメントとして PostCSS に渡され cssnano が保持する（source map の行オフセットを保つため）。
