# `@kamado-io/script-compiler`

Kamado 用の JavaScript/TypeScript バンドラ。esbuild を使い、各エントリをメモリ内でバンドルする。

## Installation

```sh
yarn add @kamado-io/script-compiler
```

## Usage

```ts
import { defineConfig } from 'kamado/config';
import { createScriptCompiler } from '@kamado-io/script-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createScriptCompiler(), {
			alias: { '@': './src' },
			minifier: true,
			banner: 'Generated file',
		}),
	],
});
```

オプション（`files` / `ignore` / `outputExtension` / `alias` / `minifier` / `banner` / `sourcemap`）は型定義を参照。

## 重要な挙動

- **メモリ内バンドル**: 一時ファイルを書かず、esbuild の結果を直接返す
- **`import './style.css'` のような追加出力は無視される**（JS バンドル本体のみ採用、警告ログのみ）。CSS は `@kamado-io/style-compiler` 側で処理する想定
- **`sourcemap: 'onServer'`（デフォルト）**: `kamado server` 時のみ inline source map を埋める。`true` で常時、`false` で常時無効。esbuild が banner 分のマッピングを自動補正する
