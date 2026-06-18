# `@kamado-io/pug-compiler`

Pug テンプレートを HTML にコンパイルするコンパイラ。[`@kamado-io/page-compiler`](../page-compiler/) の `compileHooks` に差し込んで使う。

## Installation

```sh
yarn add @kamado-io/pug-compiler @kamado-io/page-compiler
```

## Usage

`createCompileHooks` で page compiler に差し込むのが推奨パターン:

```ts
import { defineConfig } from 'kamado/config';
import { createPageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/pug-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createPageCompiler(), {
			files: '**/*.pug',
			outputExtension: '.html',
			layouts: { dir: './layouts' },
			compileHooks: createCompileHooks({
				pathAlias: './src',
				doctype: 'html',
				pretty: true,
			}),
		}),
	],
});
```

`createCompileHooks` が返した `main` / `layout` のコンパイラは **拡張子で分岐**し、`.pug` のみコンパイル、他はパススルー。

## 重要な仕様

- **コンパイル関数のキャッシュ** … テンプレート関数は LRU でキャッシュされ、共有レイアウトは「1 回コンパイル × 多数回レンダリング」になる。`cache = false`（dev server が自動で渡す）でバイパスし、`include` / `extends` の編集が即反映される
- **factory は build/serve ごとに 1 回呼ばれる** … `createCompileHooks(...)` の結果は page compiler が build/serve ごとに 1 度だけ resolve する。**fresh な template cache を持つコンパイラを毎回生成**するため、連続ビルド間でテンプレート編集が反映される

低レベルの `compilePug({...})` を直接使うことも可能。詳細は `src/pug-compiler.ts` / `src/create-compile-hooks.ts` の JSDoc を参照。
