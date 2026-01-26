# Kamado

[![npm version](https://badge.fury.io/js/kamado.svg)](https://www.npmjs.com/package/kamado)

![kamado](https://cdn.jsdelivr.net/gh/d-zero-dev/kamado@main/assets/kamado_logo.png)

**Kamadoは極めてシンプルな静的サイトビルドツールです。** ハイドレーションなし、クライアントサイドランタイムなし、マジックなし。**ランタイム不要**で、ファイルシステムと生のHTMLだけ。オンデマンドで焼き上げます。かまどでじっくり焼き上げる、それがKamadoです。

## プロジェクト概要

- 🏗️ [Kamado Architecture](./ARCHITECTURE.md) | [内部アーキテクチャ](./ARCHITECTURE.ja.md)

Kamadoは11tyに似た静的サイトビルドツールですが、よりシンプルな設計を目指しています。レガシーな古い作り方にこだわる人向けのツールです。

**Kamadoの最大の特徴は、ランタイムを一切必要としないことです。** クライアントサイドのランタイム（ハイドレーション）は不要です。純粋な静的HTMLを生成するため、永続性と堅牢性を実現しています。10年後、20年後も同じように動作するHTMLを生成します。

AstroやNext.jsのようなモダンなフレームワークは、ランタイムを必要とします。Kamadoはランタイムに依存せず、純粋な静的HTMLを生成します。レガシーなアプローチを好む開発者、ランタイムに依存したくない開発者向けのツールです。

## 主な特徴

### ランタイム不要

Kamadoの最大の特徴は、**ランタイムを一切必要としない**ことです。クライアントサイドのランタイム（ハイドレーション）は不要です。生成されるのは純粋な静的HTMLだけです。これにより、永続性と堅牢性が保証されます。ランタイムのバージョンアップやセキュリティパッチに悩まされることもありません。

### esbuild/viteとの併用

CSSとJavaScriptはesbuildやviteに任せ、KamadoはHTMLの管理に専念します。これにより、各ツールの強みを活かした開発が可能になります。

### オンデマンドビルド方式

開発サーバーでは、アクセスがあったときに必要なファイルのみをビルドします。トランスパイルオンデマンド方式により、10000ページのサイトでも快適に動作します。必要な分だけ焼く、無駄のない設計です。

### 大規模サイト対応

ページツリーによるマッピング管理により、大規模サイトでも効率的にビルドできます。

### 充実したログ出力と並列ビルド

Kamadoは並列ビルド処理を採用しています。ビルド中は何をやっているかがコンソールにしっかりと出力されます。各ファイルのビルド状況がリアルタイムで確認でき、進捗状況も一目瞭然です。並列処理により、ビルド速度も向上します。

## 開発サーバー

### Honoベースの軽量サーバー

**かまどにくべるのはHonoだろ🔥**

### トランスパイルオンデマンド方式

サーバーのリクエストがディスティネーションパスとマッチすれば、リクエストされたファイルを起点に芋づる式にビルドします。依存ファイルも監視する必要なく、必要なファイルだけが自動的にビルドされます。

### ファイル監視なし

`Chokidar`も使わず、ライブリロードもしません。開発時はあくまでブラウザのリロードによるサーバーリクエストのみがビルドのトリガーとなります。

### ページツリーによるマッピング管理

ページツリーはソースファイルのパスとディスティネーションパスを持ちます。この時点でマッピングが管理されているため、サーバーのリクエストがディスティネーションパスとマッチすれば、ソースファイルだけをビルドできます。

## 基本的な使い方

### インストール

```bash
npm install kamado
# または
yarn add kamado
```

### 設定ファイル

プロジェクトルートに`kamado.config.ts`を作成します：

```ts
import type { UserConfig } from 'kamado/config';

import path from 'node:path';

import { pageCompiler } from '@kamado-io/page-compiler';
import { scriptCompiler } from '@kamado-io/script-compiler';
import { styleCompiler } from '@kamado-io/style-compiler';

export const config: UserConfig = {
	dir: {
		root: import.meta.dirname,
		input: path.resolve(import.meta.dirname, '__assets', 'htdocs'),
		output: path.resolve(import.meta.dirname, 'htdocs'),
	},
	devServer: {
		open: true,
		port: 8000,
	},
	compilers: [
		pageCompiler({
			files: '**/*.{html,pug}',
			outputExtension: '.html',
			globalData: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'data'),
			},
			layouts: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'layouts'),
			},
			async afterSerialize(elements, window, isServe) {
				// DOM操作やカスタム処理をここに記述
			},
		}),
		styleCompiler({
			files: '**/*.{css,scss,sass}',
			ignore: '**/*.{scss,sass}',
			outputExtension: '.css',
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
		scriptCompiler({
			files: '**/*.{js,ts,jsx,tsx,mjs,cjs}',
			outputExtension: '.js',
			minifier: true,
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
	],
	async onBeforeBuild(context) {
		// ビルド前の処理
		// context.mode が利用可能: 'build' または 'serve'
	},
	async onAfterBuild(context) {
		// ビルド後の処理
		// context.mode が利用可能: 'build' または 'serve'
	},
};

export default config;
```

### 設定項目の説明

#### ディレクトリ設定

- `dir.root`: プロジェクトルートディレクトリ
- `dir.input`: ソースファイルのディレクトリ
- `dir.output`: 出力先ディレクトリ

#### 開発サーバー設定

- `devServer.port`: サーバーのポート番号（デフォルト: `3000`）
- `devServer.host`: サーバーのホスト名（デフォルト: `localhost`）
- `devServer.open`: 起動時にブラウザを自動で開くか（デフォルト: `false`）
- `devServer.startPath`: サーバー起動時にブラウザで開くカスタムパス（オプション、例: `'/__tmpl/'`）

#### コンパイラ設定

`compilers`配列でファイルのコンパイル方法を定義します。各エントリはコンパイラ関数の呼び出しで、メタデータ付きのコンパイラを返します。コンパイラ関数は以下のオプションを受け取ります：

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます。デフォルト値は各コンパイラで提供されます（下記参照）。
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.scss'`と指定すると、入力ディレクトリとそのサブディレクトリ内のすべての`.scss`ファイルが無視されます。
- `outputExtension`（オプション）: 出力ファイルの拡張子（例: `.html`, `.css`, `.js`, `.php`）。デフォルト値は各コンパイラで提供されます（下記参照）。
- その他のコンパイラ固有のオプション（各コンパイラのドキュメントを参照）。

配列の順序が処理順序を決定します。

##### pageCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.html'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.tmp'`と指定すると、すべての`.tmp`ファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.html'`）
- `globalData.dir`: グローバルデータファイルのディレクトリ
- `globalData.data`: 追加のグローバルデータ
- `layouts.dir`: レイアウトファイルのディレクトリ
- `compileHooks`: コンパイルプロセスをカスタマイズするコンパイルフック（Pugテンプレートを使用する場合は必須）
- `host`: JSDOMのurlオプションに使用するホストURL。未指定の場合、ビルドモードではpackage.jsonの`production.baseURL`または`production.host`を使用、開発サーバーモードでは開発サーバーURL（`http://${devServer.host}:${devServer.port}`）を使用
- `afterSerialize`: DOMシリアライズ後のフック

**注意**: `page-compiler`は汎用コンテナコンパイラであり、デフォルトではPugテンプレートをコンパイルしません。Pugテンプレートを使用するには、`@kamado-io/pug-compiler`をインストールし、`compileHooks`を設定してください。詳細は[@kamado-io/pug-compiler README](../@kamado-io/pug-compiler/README.md)を参照してください。

**例**: `.pug`ファイルを`.html`にコンパイルする場合：

```ts
pageCompiler({
	files: '**/*.pug',
	outputExtension: '.html',
	compileHooks: {
		main: {
			compiler: compilePug(),
		},
	},
});
```

##### styleCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.css'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.{scss,sass}'`と指定すると、すべての`.scss`と`.sass`ファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.css'`）
- `alias`: パスエイリアスのマップ（PostCSSの`@import`で使用）
- `banner`: バナー設定（CreateBanner関数または文字列を指定可能）

**例**: `.scss`ファイルを`.css`にコンパイルし、ソースファイルを無視する場合：

```ts
styleCompiler({
	files: '**/*.{css,scss,sass}',
	ignore: '**/*.{scss,sass}',
	outputExtension: '.css',
	alias: {
		'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
	},
});
```

##### scriptCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.{js,ts,jsx,tsx,mjs,cjs}'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.test.ts'`と指定すると、すべてのテストファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.js'`）
- `alias`: パスエイリアスのマップ（esbuildのエイリアス）
- `minifier`: ミニファイを有効にするか
- `banner`: バナー設定（CreateBanner関数または文字列を指定可能）

**例**: TypeScriptファイルをJavaScriptにコンパイルする場合：

```ts
scriptCompiler({
	files: '**/*.{js,ts,jsx,tsx}',
	outputExtension: '.js',
	minifier: true,
	alias: {
		'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
	},
});
```

#### ページリスト設定

`pageList`オプションを使用すると、ナビゲーション、パンくずリスト、その他ページリストを必要とする機能で使用されるページリストをカスタマイズできます。

```ts
import { urlToFile, getFile } from 'kamado/files';

export const config: UserConfig = {
	// ... その他の設定
	pageList: async (pageAssetFiles, config) => {
		// ページをフィルタリング（例: 下書きを除外）
		const filtered = pageAssetFiles.filter((page) => !page.url.includes('/drafts/'));

		// カスタムタイトル付きの外部ページを追加
		const externalPage = {
			...urlToFile('/external-page/', {
				inputDir: config.dir.input,
				outputDir: config.dir.output,
				outputExtension: '.html',
			}),
			title: '外部ページのタイトル',
		};

		return [...filtered, externalPage];
	},
};
```

この関数は以下を受け取ります：

- `pageAssetFiles`: ファイルシステムで見つかったすべてのページファイルの配列
- `config`: 完全な設定オブジェクト

`CompilableFile`オブジェクトの配列を返します。オプションで`title`プロパティを含めることができます。`title`が指定された場合、ページコンテンツからタイトルを抽出する代わりにその値が使用されます。

#### フック関数

- `onBeforeBuild`: ビルド前に実行される関数。`Context`（`Config`を拡張し`mode: 'build' | 'serve'`を含む）を受け取ります
- `onAfterBuild`: ビルド後に実行される関数。`Context`（`Config`を拡張し`mode: 'build' | 'serve'`を含む）を受け取ります

### CLIコマンド

#### サイト全体のビルド

```bash
kamado build
```

#### 特定のファイルのみをビルド

```bash
kamado build "path/to/file.pug" # 特定のファイルをビルド
kamado build "path/to/*.css" # CSSファイルのみをビルド
kamado build "path/to/*.ts" # TypeScriptファイルのみをビルド
```

#### 開発サーバーの起動

```bash
kamado server
```

開発サーバーが起動すると、ブラウザでアクセスしたページがオンデマンドでビルドされます。リクエストがあれば、その場で焼いて返します。

### CLIオプション

すべてのコマンドで以下のオプションが利用可能です：

| オプション        | 短縮形 | 説明                                                                                         |
| ----------------- | ------ | -------------------------------------------------------------------------------------------- |
| `--config <path>` | `-c`   | 設定ファイルのパスを指定。未指定の場合、`kamado.config.js`、`kamado.config.ts`などを自動探索 |
| `--verbose`       |        | 詳細なログ出力を有効化                                                                       |

#### 使用例

```bash
# 特定の設定ファイルを使用
kamado build --config ./custom.config.ts
kamado server -c ./dev.config.js

# ビルド時に詳細ログを出力
kamado build --verbose
```
