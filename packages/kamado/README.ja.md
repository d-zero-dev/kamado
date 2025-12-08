# Kamado

[![npm version](https://badge.fury.io/js/kamado.svg)](https://www.npmjs.com/package/kamado)

![kamado](https://cdn.jsdelivr.net/gh/d-zero-dev/kamado@main/assets/kamado_logo.png)

**Kamadoは極めてシンプルな静的サイトビルドツールです。** ハイドレーションなし、クライアントサイドランタイムなし、マジックなし。**ランタイム不要**で、ファイルシステムと生のHTMLだけ。オンデマンドで焼き上げます。かまどでじっくり焼き上げる、それがKamadoです。

## プロジェクト概要

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
	extensions: {
		// 特定の拡張子を無視する場合は '#ignore' を指定
		scss: '#ignore',
		sass: '#ignore',
	},
	compilers: {
		page: pageCompiler({
			globalData: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'data'),
			},
			layouts: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'layouts'),
			},
			pathAlias: path.resolve(import.meta.dirname, '__assets', '_libs'),
			async afterSerialize(elements) {
				// DOM操作やカスタム処理をここに記述
			},
		}),
		style: styleCompiler({
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
		script: scriptCompiler({
			minifier: true,
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
	},
	async onBeforeBuild(config) {
		// ビルド前の処理
	},
	async onAfterBuild() {
		// ビルド後の処理
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

- `devServer.port`: サーバーのポート番号（デフォルト: `8000`）
- `devServer.host`: サーバーのホスト名（デフォルト: `localhost`）
- `devServer.open`: 起動時にブラウザを自動で開くか（デフォルト: `false`）

#### 拡張子マッピング

`extensions`でファイル拡張子と出力タイプをマッピングします：

- `page`: HTMLページ（`.html`, `.pug`など）
- `style`: スタイルシート（`.css`, `.scss`, `.sass`など）
- `script`: スクリプト（`.js`, `.ts`, `.jsx`, `.tsx`など）
- `#ignore`: 無視する拡張子

#### コンパイラ設定

##### pageCompiler

- `globalData.dir`: グローバルデータファイルのディレクトリ
- `globalData.data`: 追加のグローバルデータ
- `layouts.dir`: レイアウトファイルのディレクトリ
- `pathAlias`: テンプレートエンジン向けのパスエイリアス
- `afterSerialize`: DOMシリアライズ後のフック

##### styleCompiler

- `alias`: パスエイリアスのマップ（PostCSSの`@import`で使用）

##### scriptCompiler

- `alias`: パスエイリアスのマップ（esbuildのalias）
- `minifier`: ミニファイを有効にするか

#### フック関数

- `onBeforeBuild`: ビルド前に実行される関数
- `onAfterBuild`: ビルド後に実行される関数

### ビルドコマンド

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

### 開発サーバーの起動

```bash
kamado server
```

開発サーバーが起動すると、ブラウザでアクセスしたページがオンデマンドでビルドされます。リクエストがあれば、その場で焼いて返します。
