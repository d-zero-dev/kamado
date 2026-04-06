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
	devServer: {
		open: true,
		port: 8000,
	},
	compilers: (def) => [
		def(createPageCompiler(), {
			files: '**/*.{html,pug}',
			outputExtension: '.html',
			globalData: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'data'),
			},
			layouts: {
				dir: path.resolve(import.meta.dirname, '__assets', '_libs', 'layouts'),
			},
			// Transform パイプライン（オプション、省略時は createDefaultPageTransforms() を使用）
			// カスタマイズについては @kamado-io/page-compiler のドキュメントを参照してください
		}),
		def(createStyleCompiler(), {
			files: '**/*.{css,scss,sass}',
			ignore: '**/*.{scss,sass}',
			outputExtension: '.css',
			alias: {
				'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
			},
		}),
		def(createScriptCompiler(), {
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
});
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
- `devServer.startPath`: サーバー起動時にブラウザで開くカスタムパス（オプション、例: `'__tmpl/'`）
- `devServer.transforms`: 開発時にレスポンスを変換する関数の配列（オプション、[レスポンス変換API](#レスポンス変換api)を参照）
- `devServer.proxy`: 開発時に外部サーバーへリクエストを転送するプロキシルール（オプション、[プロキシAPI](#プロキシapi)を参照）

#### コンパイラ設定

`compilers`オプションは型安全なコンパイラ設定のためにコールバック形式を使用します。コールバックは`def`ヘルパー関数を受け取り、コンパイラファクトリとオプションをバインドします。各`def(factory(), options)`呼び出しはメタデータ付きのコンパイラを返します。コンパイラオプションは以下を含みます：

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます。デフォルト値は各コンパイラで提供されます（下記参照）。
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.scss'`と指定すると、入力ディレクトリとそのサブディレクトリ内のすべての`.scss`ファイルが無視されます。
- `outputExtension`（オプション）: 出力ファイルの拡張子（例: `.html`, `.css`, `.js`, `.php`）。デフォルト値は各コンパイラで提供されます（下記参照）。
- その他のコンパイラ固有のオプション（各コンパイラのドキュメントを参照）。

返却される配列の順序が処理順序を決定します。

##### createPageCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.html'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.tmp'`と指定すると、すべての`.tmp`ファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.html'`）
- `globalData.dir`: グローバルデータファイルのディレクトリ
- `globalData.data`: 追加のグローバルデータ
- `layouts.dir`: レイアウトファイルのディレクトリ
- `compileHooks`: コンパイルプロセスをカスタマイズするコンパイルフック（Pugテンプレートを使用する場合は必須）
- `transforms`: コンパイル済みHTMLに適用する変換関数の配列。省略時は`createDefaultPageTransforms()`を使用。Transform Pipeline APIの詳細は[@kamado-io/page-compiler](../packages/@kamado-io/page-compiler/README.md)を参照してください

**注意**: `page-compiler`は汎用コンテナコンパイラであり、デフォルトではPugテンプレートをコンパイルしません。Pugテンプレートを使用するには、`@kamado-io/pug-compiler`をインストールし、`compileHooks`を設定してください。詳細は[@kamado-io/pug-compiler README](../@kamado-io/pug-compiler/README.md)を参照してください。

**例**: `.pug`ファイルを`.html`にコンパイルする場合：

```ts
def(createPageCompiler(), {
	files: '**/*.pug',
	outputExtension: '.html',
	compileHooks: {
		main: {
			compiler: compilePug(),
		},
	},
});
```

##### createStyleCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.css'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.{scss,sass}'`と指定すると、すべての`.scss`と`.sass`ファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.css'`）
- `alias`: パスエイリアスのマップ（PostCSSの`@import`で使用）
- `banner`: バナー設定（CreateBanner関数または文字列を指定可能）

**例**: `.scss`ファイルを`.css`にコンパイルし、ソースファイルを無視する場合：

```ts
def(createStyleCompiler(), {
	files: '**/*.{css,scss,sass}',
	ignore: '**/*.{scss,sass}',
	outputExtension: '.css',
	alias: {
		'@': path.resolve(import.meta.dirname, '__assets', '_libs'),
	},
});
```

##### createScriptCompiler

- `files`（オプション）: コンパイルするファイルのglobパターン。パターンは`dir.input`を基準に解決されます（デフォルト: `'**/*.{js,ts,jsx,tsx,mjs,cjs}'`）
- `ignore`（オプション）: コンパイルから除外するファイルのglobパターン。パターンは`dir.input`を基準に解決されます。例えば、`'**/*.test.ts'`と指定すると、すべてのテストファイルが無視されます
- `outputExtension`（オプション）: 出力ファイルの拡張子（デフォルト: `'.js'`）
- `alias`: パスエイリアスのマップ（esbuildのエイリアス）
- `minifier`: ミニファイを有効にするか
- `banner`: バナー設定（CreateBanner関数または文字列を指定可能）

**例**: TypeScriptファイルをJavaScriptにコンパイルする場合：

```ts
def(createScriptCompiler(), {
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
import { defineConfig } from 'kamado/config';
import { urlToFile, getFile } from 'kamado/files';

export default defineConfig({
	// ... その他の設定
	pageList: async (pageAssetFiles, config) => {
		// ページをフィルタリング（例: 下書きを除外）
		const filtered = pageAssetFiles.filter((page) => !page.url.includes('/drafts/'));

		// カスタムメタデータ付きの外部ページを追加
		const externalPage = {
			...urlToFile('/external-page/', {
				inputDir: config.dir.input,
				outputDir: config.dir.output,
				outputExtension: '.html',
			}),
			metaData: { title: '外部ページのタイトル' },
		};

		return [...filtered, externalPage];
	},
});
```

この関数は以下を受け取ります：

- `pageAssetFiles`: ファイルシステムで見つかったすべてのページファイルの配列
- `config`: 完全な設定オブジェクト

`PageData`オブジェクト（`CompilableFile`を拡張しオプションで`metaData`を含む）の配列を返します。

**`metaData`とタイトルに関する注意:**

- 各ページのコンパイル時には、`metaData`はフロントマターから自動的に展開されます
- ただし、`pageList`フック時点（globalData収集時）では、`metaData`はまだ展開されていません
- パンくずリストやナビゲーションでタイトルが必要な場合は、`pageList`フックで明示的に`metaData.title`を設定する必要があります
- 明示的な`metaData.title`がない場合、パンくずリストやナビゲーションには`__NO_TITLE__`と表示されます

#### フック関数

- `onBeforeBuild`: ビルド前に実行される関数。`Context`（`Config`を拡張し`mode: 'build' | 'serve'`を含む）を受け取ります
- `onAfterBuild`: ビルド後に実行される関数。`Context`（`Config`を拡張し`mode: 'build' | 'serve'`を含む）を受け取ります

#### レスポンス変換API

レスポンス変換APIを使用すると、開発サーバーモード時にレスポンスコンテンツを変更できます。スクリプトの挿入、疑似SSIの実装、メタタグの追加など、あらゆるレスポンス変換のニーズに対応します。

**重要な区別:**

両方とも同じ `Transform` インターフェース（`kamado/config`）を使用しますが、適用範囲と動作が異なります：

- **`devServer.transforms`**: 開発サーバーモード時のみ（`kamado server`）、全てのレスポンスに適用されます。HTML、CSS、JS、画像など、あらゆるファイルタイプを処理できるミドルウェア形式の変換です。`filter` オプション（include/exclude）がここで有効です。ビルド時には実行されません。
- **`def(createPageCompiler(), { transforms })`**: ビルドモードと開発サーバーモードの両方で、コンパイル済みHTMLページに適用されます。HTML処理専用の変換パイプラインです。`filter` オプションは無視されます（全てのHTMLページが処理されます）。詳細は[@kamado-io/page-compiler](../packages/@kamado-io/page-compiler/README.md)を参照してください。

同じTransform関数（`manipulateDOM()`、`prettier()`、カスタムTransformなど）を両方で再利用できます。

**主な特徴:**

- **開発時のみ**: 変換は`serve`モードでのみ適用され、ビルド時には適用されません
- **柔軟なフィルタリング**: Globパターン（include/exclude）でフィルタリング
- **エラー耐性**: 変換関数のエラーがサーバーを停止させません
- **非同期対応**: 同期・非同期両方の変換関数をサポート
- **チェーン可能**: 複数の変換を配列順に適用

**設定例:**

```typescript
import path from 'node:path';
import fs from 'node:fs/promises';

import { defineConfig } from 'kamado/config';

export default defineConfig({
	devServer: {
		port: 3000,
		transforms: [
			// 例1: HTMLに開発用スクリプトを挿入
			{
				name: 'inject-dev-script',
				filter: {
					include: '**/*.html',
				},
				transform: (content) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}
					return content.replace(
						'</body>',
						'<script src="/__dev-tools.js"></script></body>',
					);
				},
			},

			// 例2: 疑似SSI（Server Side Includes）の実装
			{
				name: 'pseudo-ssi',
				filter: {
					include: '**/*.html',
				},
				transform: async (content, ctx) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}

					// <!--#include virtual="/path/to/file.html" --> を処理
					const includeRegex = /<!--#include virtual="([^"]+)" -->/g;
					let result = content;

					for (const match of content.matchAll(includeRegex)) {
						const includePath = match[1];
						const filePath = path.resolve(
							ctx.context.dir.output,
							includePath.replace(/^\//, ''),
						);

						try {
							const includeContent = await fs.readFile(filePath, 'utf-8');
							result = result.replace(match[0], includeContent);
						} catch (error) {
							console.warn(`Failed to include ${includePath}:`, error);
						}
					}

					return result;
				},
			},

			// 例3: CSSファイルにソースコメントを追加
			{
				name: 'css-source-comment',
				filter: {
					include: '**/*.css',
				},
				transform: (content, ctx) => {
					if (typeof content !== 'string') {
						const decoder = new TextDecoder('utf-8');
						content = decoder.decode(content);
					}
					const source = ctx.inputPath || ctx.outputPath;
					return `/* Generated from: ${source} */\n${content}`;
				},
			},
		],
	},
});
```

**ResponseTransformインターフェース:**

```typescript
interface Transform<M extends MetaData> {
	readonly name: string; // デバッグ用の変換名
	readonly filter?: {
		readonly include?: string | readonly string[]; // インクルードするGlobパターン
		readonly exclude?: string | readonly string[]; // エクスクルードするGlobパターン
	};
	readonly transform: (
		content: string | ArrayBuffer,
		context: TransformContext<M>,
	) => Promise<string | ArrayBuffer> | string | ArrayBuffer;
}

interface TransformContext<M extends MetaData> {
	readonly path: string; // リクエストパス
	readonly filePath: string; // ファイルパス（pathのエイリアス）
	readonly inputPath?: string; // 元の入力ファイルパス（利用可能な場合）
	readonly outputPath: string; // 出力ファイルパス
	readonly outputDir: string; // 出力ディレクトリパス
	readonly isServe: boolean; // 開発サーバーでは常にtrue
	readonly context: Context<M>; // 完全な実行コンテキスト
	readonly compile: CompileFunction; // 他のファイルをコンパイルする関数
}
```

**フィルタオプション:**

- `include`: リクエストパスにマッチするGlobパターン（例: `'**/*.html'`、`['**/*.css', '**/*.js']`）
- `exclude`: 除外するGlobパターン（例: `'**/_*.html'`で`_`で始まるファイルをスキップ）

**重要な注意事項:**

- 変換関数は`string`または`ArrayBuffer`を受け取ります。テキストベースの変換を行う場合は、`TextDecoder`を使って`ArrayBuffer`をデコードしてください：
  ```typescript
  if (typeof content !== 'string') {
  	const decoder = new TextDecoder('utf-8');
  	content = decoder.decode(content);
  }
  ```
- 静的ファイル（コンパイル対象外のファイル）は通常`ArrayBuffer`として渡されるため、テキストとして処理する場合は必ずデコードしてください
- 変換関数のエラーはログに記録されますが、サーバーを停止させません（元のコンテンツが返されます）
- 変換は配列の順序で実行されます
- 開発サーバーモード（`kamado server`）でのみ適用され、ビルド時には適用されません

#### プロキシAPI

プロキシAPIを使用すると、開発サーバーモード時にリクエストを外部サーバーに転送できます。静的サイトから別ドメインのAPIにAJAXリクエストを送る場合に、ローカル開発時のCORS問題を回避できます。

**主な特徴:**

- **開発時のみ**: プロキシは`serve`モードでのみ適用され、ビルド時には適用されません
- **全HTTPメソッド対応**: GET、POST、PUT、DELETE、PATCHなどすべてのメソッドをサポート
- **ストリーミング**: レスポンスはバッファリングせずにストリーミングされます
- **パスリライト**: リクエストパスを転送前に書き換え可能
- **簡易・詳細形式**: シンプルな場合は文字列、詳細な制御が必要な場合はオブジェクトを使用

**設定例:**

```typescript
import { defineConfig } from 'kamado/config';

export default defineConfig({
	devServer: {
		port: 3000,
		proxy: {
			// 簡易形式: 文字列でターゲットURLを指定 — /api/* をターゲットに転送
			'/api': 'https://backend.example.com',

			// 詳細形式: パスリライト付きのオブジェクト形式
			'/api/v2': {
				target: 'https://api-v2.example.com',
				// /api/v2/users → /users にリライト
				pathRewrite: (path) => path.replace(/^\/api\/v2/, ''),
				changeOrigin: true,
			},
		},
	},
});
```

上記の設定では:

- `GET /api/data` → `GET https://backend.example.com/api/data`
- `POST /api/v2/users` → `POST https://api-v2.example.com/users`（パスがリライトされます）

**ProxyRuleインターフェース:**

```typescript
interface ProxyRule {
	target: string; // プロキシ先のターゲットURL
	pathRewrite?: (path: string) => string; // プロキシ前にパスを書き換える関数
	changeOrigin?: boolean; // Origin/Hostヘッダーをターゲットに合わせて変更するか（デフォルト: false）
}
```

**プロキシ設定:**

`proxy`オプションはレコード型で、以下の形式です:

- **キー**: マッチするパスプレフィックス（例: `'/api'`）
- **値**: ターゲットURL文字列（簡易形式）または`ProxyRule`オブジェクト

**重要な注意事項:**

- プロキシルートはファイルサーブルートよりも先にマッチするため、プロキシパスはローカルファイルよりも優先されます
- 長いパスプレフィックスが先にマッチします（例: `/api/v2` は `/api` よりも優先）
- クエリ文字列は保持されターゲットに転送されます
- リクエストヘッダーは転送されます。ターゲットサーバーが `Host` ヘッダーを検証している場合は `changeOrigin: true` を設定すると `Host` と `Origin` ヘッダーがターゲットに合わせて書き換えられます
- プロキシ失敗時は`502 Bad Gateway`レスポンスが返されます
- 開発サーバーモード（`kamado server`）でのみ適用され、ビルド時には適用されません

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

### 型安全性とジェネリクス

Kamadoのコア型は、型安全なカスタムメタデータのためにジェネリック型パラメータ `M extends MetaData` を受け取ります。このセクションではその使い方を説明します。

#### デフォルトジェネリクス

ほとんどのユーザー向け型（`Config`、`Context`、`UserConfig`、`Transform`、`TransformContext`、`PageData`、`GlobalData`）は `= MetaData` デフォルトを持ちます。カスタムメタデータが不要な場合、型引数なしでそのまま使えます：

```typescript
import type { Config, Transform, PageData } from 'kamado/config';

// 型引数不要 — MetaData がデフォルト
const config: Config = {
	/* ... */
};
const transform: Transform = {
	/* ... */
};
```

#### カスタムメタデータ

ベースの `MetaData` インターフェースは空のインターフェース（`{}`）です。任意の `interface` や `type` が `extends MetaData` 制約を満たします。ジェネリクスを通じてカスタムメタデータプロパティを定義できます。

プロジェクト全体にカスタムメタデータ型を伝搬するには、`defineConfig` に型引数を渡します：

```typescript
interface MyMeta {
	title: string;
	description?: string;
	draft?: boolean;
}

export default defineConfig<MyMeta>({
	pageList: async (pageAssetFiles, config) => {
		// pageAssetFiles は CompilableFile[]、戻り値は PageData<MyMeta>[]
		return pageAssetFiles.map((file) => ({
			...file,
			metaData: { title: 'デフォルトタイトル' },
		}));
	},
	async onBeforeBuild(context) {
		// context は Context<MyMeta> — 完全に型付けされています
	},
});
```

> **注意: `Config<M>` は `M` に対して不変（invariant）です。**
>
> TypeScript の型システムの仕様により、`Config<M>` は型パラメータ `M` に対して不変です。つまり、`Config<PageMetaData>` を `Config<MetaData>` に代入することはできません（逆も同様）。これは `M` が共変位置（`PageData<M>[]` などの戻り値型）と反変位置（`config: Config<M>` などのコールバック引数）の両方に現れるためです。
>
> `Config` を受け取るヘルパー関数を書く場合は、ジェネリックにしてください：
>
> ```typescript
> // ✅ 良い例 — 任意のメタデータ型で動作
> function helper<M extends MetaData>(config: Config<M>) { ... }
>
> // ❌ 悪い例 — Config<PageMetaData> は Config<MetaData> に代入できない
> function helper(config: Config<MetaData>) { ... }
> ```

#### `def` コールバック

`compilers` オプションはコールバック形式を使用します：`compilers: (def) => [...]`。`def` パラメータは `CompilerDefine<M>` 型の関数で、コンパイラファクトリとオプションをバインドします。これはTypeScriptが各コンパイラのオプション型を自動推論するために存在します — 手動で型引数を指定する必要はありません：

```typescript
compilers: (def) => [
	// TypeScript は createPageCompiler の戻り値型からオプション型を推論
	def(createPageCompiler(), {
		files: '**/*.html',
		outputExtension: '.html',
	}),
];
```

#### `M` の伝搬チェーン

型パラメータ `M` はシステム全体を通じて伝搬します：

```
defineConfig<M>() → Config<M> → Context<M> → TransformContext<M>
                                            → PageData<M>
                                            → CompileData<M> → NavNode<M>
```

これにより、カスタムメタデータ型が設定、コンパイル、テンプレートデータ全体で一貫性を持ちます。
