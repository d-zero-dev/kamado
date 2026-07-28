# `@kamado-io/jsx-compiler`

JSX/TSX で書いた React コンポーネントを HTML 文字列にコンパイルするコンパイラ（SSR のみ・ハイドレーションなし）。[`@kamado-io/page-compiler`](../page-compiler/) の `compileHooks` に差し込んで使う。

## Requirements

- Node.js 24.13.1 以上（`node:module` の `registerHooks()` に依存）

## Installation

```sh
yarn add @kamado-io/jsx-compiler @kamado-io/page-compiler react react-dom
```

`react`/`react-dom` は peerDependency。コンパイル結果はホストプロジェクト自身の `react`/`react-dom` を解決して実行するため必須（バンドルには含まれない — 単一インスタンス共有のため常に external 化される）。

## Usage

`createCompileHooks` で page compiler に差し込むのが推奨パターン:

```ts
import { defineConfig } from 'kamado/config';
import { createPageCompiler } from '@kamado-io/page-compiler';
import { createCompileHooks } from '@kamado-io/jsx-compiler';

export default defineConfig({
	compilers: (def) => [
		def(createPageCompiler(), {
			files: '**/*.{jsx,tsx}',
			outputExtension: '.html',
			layouts: { dir: './layouts' },
			compileHooks: createCompileHooks(),
		}),
	],
});
```

`@kamado-io/pug-compiler` と異なり、`createCompileHooks` は **`PageCompilerOptions` を受け取る 1 引数のファクトリ**を返す（`() => CompileHooksObject` ではなく `(pageCompilerOptions) => CompileHooksObject`）。page-compiler は build/serve コンテキストごとに 1 度だけこの関数を呼び出し、自身の `options`（特に `layouts.dir`）を渡す。

### ページコンポーネントの書き方

`export default` で単一の関数コンポーネントをエクスポートし、`CompileData`（frontmatter・グローバルデータ・`nav`/`breadcrumbs`/`titleList` を含む）を唯一の props として受け取る:

```tsx
// input/index.tsx
export default function Page({ page, breadcrumbs }: CompileData<MetaData>) {
	return (
		<article>
			<h1>{page.metaData?.title}</h1>
		</article>
	);
}
```

### レイアウトコンポーネントの書き方

レイアウトは `{ content, ...data }` を受け取り、`content`（main のコンパイル済み HTML 文字列）を `dangerouslySetInnerHTML` で埋め込む:

```tsx
// layouts/default.tsx
export default function Layout({
	content,
	page,
}: CompileData<MetaData> & { content: string }) {
	return (
		<html>
			<head>
				<title>{page.metaData?.title}</title>
			</head>
			<body>
				<main dangerouslySetInnerHTML={{ __html: content }} />
			</body>
		</html>
	);
}
```

`content` は常に固定のプロパティ名で渡される。page-compiler の `layouts.contentVariableName`（pug 等の文字列テンプレート向けオプション）を変更していても、jsx-compiler 側では常に `content` として正規化される。

### frontmatter

他のコンパイラと同じく、ファイル先頭の `---` ブロックが frontmatter として除去されてから本体がコンパイルされる:

```tsx
---
layout: default.tsx
title: Hello
---
export default function Page() {
	return <p>Hello</p>;
}
```

## 重要な仕様

- **SSR のみ** — Reactの標準的な SSR 制約をそのまま受け入れる（`useEffect` はサーバーで実行されない等）。kamado 側で機能制限は行わない
- **コンパイル結果のキャッシュ** — コンパイル済みコンポーネントは compiler インスタンスごとに LRU キャッシュされる（上限 256）。`cache = false`（dev server が自動で渡す）でバイパスし、依存ファイルの編集が即反映される
- **非標準の `jsxImportSource` を使う場合のみ: incremental ビルドでの検知範囲に注意**（既定の `react`/`react-dom` を使っている限り気にする必要はない） — `cacheDigest`（page-compiler の incremental ビルド判定に合成される）は esbuild・ランタイムの実行時バージョン・`JsxCompilerOptions` を含めるが、これは `react`/`react-dom` が両方とも `version` を公開しているから成り立つ。`jsxImportSource` に代替ランタイムを指定する場合、そのランタイム（および `<jsxImportSource>/server`）が同様に `version` を公開していなければ依存更新を検知できず、incremental ビルドが古い HTML を再利用し続けることがある。該当する場合は `--force` でフルリビルドすること
- **main と layout は別々にキャッシュされる** — 理由は `createCompileHooks` の JSDoc を参照。実用上の影響として、layout 内のコンパイルエラーはファイルパスがプレースホルダーになる場合があるが、page-compiler 側で実際の layout パスに差し替えられる
- **`registerHooks()` について** — JSX を Node.js 上で実行するため、esbuild でバンドルしたコードをディスク I/O なしで `import()` する `node:module` の `registerHooks()`（同期版カスタム ESM ローダー）を使う。このフックはプロセス全体に一度だけ登録され、対象は専用のスキーム（`kamado-jsx:`）に限定されるため、他の `import`/`require` には影響しない
- **serve モードでのメモリ特性** — Node.js の ESM には一度 `import()` したモジュールをレジストリから明示的に解放する標準 API がない。`cache = false` で同一ファイルを繰り返しコンパイルするたびに新しい仮想モジュールが作られ import され続けるため、プロセスのメモリ使用量は理論上無制限に増加する。実測（同一ファイルを2000回連続編集・再コンパイル）では heap 使用量の増加は数十MB程度に留まり、通常の開発セッション規模では実害はない。長時間・大量の編集を行う dev サーバープロセスは定期的に再起動することを推奨する

## `@kamado-io/script-compiler` との拡張子重複に関する注意

`@kamado-io/script-compiler` の `defaultFiles` は `'**/*.{js,ts,jsx,tsx,mjs,cjs}'` であり、`.jsx`/`.tsx` も対象に含みます。`@kamado-io/jsx-compiler` と `@kamado-io/script-compiler` を同一プロジェクトで併用する場合、両方の `files` パターンが同じソースファイルにマッチすると意図しない二重コンパイルが発生します。ページ/レイアウト用の JSX/TSX と、クライアント配布用スクリプトの TS/TSX は**別ディレクトリに分離**し、各 compiler の `files`（および必要に応じて `ignore`）オプションで明示的に排他となるよう設定してください。
