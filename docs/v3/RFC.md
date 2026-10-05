# kamado v3 RFC

状態: **合意済み**。17 章の論点はユーザーが確認して確定した（`Html` 型の実体だけは実装して測ってから決める）。仕様の変更は、この文書を更新してから実装に反映する。

関連: `docs/v3/spike-results.md`（設計判断の根拠にした実測結果）。

## 1. 目的

10 万ページ級のフルビルド・差分ビルド・開発サーバー応答で最速の、ミニマムな静的ビルドツール。v2 の基本機能を維持し、API の破壊的変更を許容する。依存は最小（Rust は std のみ、npm ランタイム依存は esbuild / hono / @hono/node-server のみ）。

**完成の定義**: 実案件のプロジェクトが、v2 と同じ基本要件で v3 上で動くこと（ビルド出力が v2 と一致、開発サーバー、差分ビルド、v2 機能の代替手段が揃っている）。

## 2. 破壊的変更の一覧

| #   | v2                                                                                                                                                                                                                                                                            | v3                                                                                                                                                                     | 移行                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | 設定は `kamado.config.{ts,js,...}`、`.kamadorc*`、`package.json` の `kamado` キー                                                                                                                                                                                             | `kamado.config.jsonc` のみ                                                                                                                                             | 設定を JSONC に書き直す。関数はすべて宣言的オプションに置き換わる                              |
| 2   | `defineConfig` / `mergeConfig` / `getConfig`                                                                                                                                                                                                                                  | JSON Schema（`$schema`）                                                                                                                                               | `$schema` を設定の先頭に書く                                                                   |
| 3   | `compilers: (def) => [...]` とコンパイラのプラグイン契約                                                                                                                                                                                                                      | 組み込み。コンパイラの種類は `pages` / `styles` / `scripts` の 3 つ                                                                                                    | セクションに書き直す                                                                           |
| 4   | Pug（`.pug`）                                                                                                                                                                                                                                                                 | 廃止                                                                                                                                                                   | Pug → JSX の移行手順書                                                                         |
| 5   | React による JSX 描画                                                                                                                                                                                                                                                         | kamado 独自の静的 JSX                                                                                                                                                  | hooks（`useState` 等）と Context を使っていたら書き直す。`external` / `jsxImportSource` は廃止 |
| 6   | `compileHooks`（main / layout の before / compiler / after）                                                                                                                                                                                                                  | 廃止                                                                                                                                                                   | JSX のコンポーネントで書く                                                                     |
| 7   | `transforms` 配列（独自 transform を含む）                                                                                                                                                                                                                                    | `html.*` の宣言的オプション                                                                                                                                            | §9 の対応表                                                                                    |
| 8   | `manipulateDOM` の hook、`ctx.getHref` / `ctx.baseURL`                                                                                                                                                                                                                        | `html.rules`                                                                                                                                                           | §9                                                                                             |
| 9   | `injectToHead` の関数、`devServer.transforms`（関数）                                                                                                                                                                                                                         | `html.inject`（`mode: serve` を含む）                                                                                                                                  | §9                                                                                             |
| 10  | `nav` の `filter` / `comparator`、`filterNavigationNode` / `navigationComparator` / `transformBreadcrumbItem`                                                                                                                                                                 | JSX 側で配列を加工                                                                                                                                                     | §7.3                                                                                           |
| 11  | `pageList(fn)`                                                                                                                                                                                                                                                                | `pages.overrides`（外部 JSON）                                                                                                                                         | 関数の結果を prebuild で JSON に書き出す                                                       |
| 12  | `globalData` の `.js`                                                                                                                                                                                                                                                         | 廃止。`.json` / `.yml` / `.yaml`、文字列として読む `.html` / `.txt` のみ                                                                                               | prebuild で JSON を生成する                                                                    |
| 13  | `onBeforeBuild` / `onAfterBuild`                                                                                                                                                                                                                                              | 廃止                                                                                                                                                                   | npm scripts の prebuild / postbuild + `build.report` + 組み込み sitemap                        |
| 14  | `layouts.files`（オブジェクトで直接指定）、`contentVariableName`                                                                                                                                                                                                              | `layouts.dir` のみ。`content` prop 固定                                                                                                                                | —                                                                                              |
| 15  | prettier 設定の自動読み込み（入力パスで幅が変わる）                                                                                                                                                                                                                           | `html.format` で指定。幅は入力によらず統一                                                                                                                             | `printWidth` を設定に書く（v2 の `.pug` / `.tsx` と一致させるなら 90）                         |
| 16  | postcss（postcss.config のプラグイン、cssnano）                                                                                                                                                                                                                               | Rust 自作の CSS 処理。ユーザーのプラグインは非対応                                                                                                                     | autoprefixer 等が必要なら npm scripts で別に処理する                                           |
| 17  | `banner` に関数（`CreateBanner`）                                                                                                                                                                                                                                             | 文字列＋プレースホルダ                                                                                                                                                 | §8                                                                                             |
| 18  | `devServer.proxy.pathRewrite` が関数                                                                                                                                                                                                                                          | `rewrite: {from, to}`（正規表現）                                                                                                                                      | —                                                                                              |
| 19  | YAML の日付は front matter だけ `Date`                                                                                                                                                                                                                                        | すべて文字列                                                                                                                                                           | `formatDate()` に文字列を渡す                                                                  |
| 20  | `.yaml` のデータは無視                                                                                                                                                                                                                                                        | `.yaml` も読む                                                                                                                                                         | —                                                                                              |
| 21  | 本文中の `<?php ... ?>` が linkedom により**削除**される                                                                                                                                                                                                                      | 処理命令のトークンとして**保持**する                                                                                                                                   | v2 のデータ損失を再現しない                                                                    |
| 22  | `@kamado-io/*` の 6 パッケージ                                                                                                                                                                                                                                                | `kamado` 1 つ + プラットフォーム別 core                                                                                                                                | import の指定を変える                                                                          |
| 23  | `kamado/compiler` `kamado/data` `kamado/files` `kamado/path` `kamado/utils/dom` 等の内部 export                                                                                                                                                                               | 廃止。プログラム API は `build()` / `start()` のみ                                                                                                                     | —                                                                                              |
| 24  | Windows ネイティブ                                                                                                                                                                                                                                                            | 非対応（WSL2 は対応）                                                                                                                                                  | —                                                                                              |
| 25  | リクエストごとの再コンパイル（開発サーバー）                                                                                                                                                                                                                                  | 依存の stat による再利用                                                                                                                                               | 挙動は同じ（結果は新しい）                                                                     |
| 26  | `enum` / `namespace` 等を含む TS                                                                                                                                                                                                                                              | `.tsx` ページでは非対応（erasable な構文のみ）                                                                                                                         | `const` オブジェクトに置き換える                                                               |
| 27  | `<title>` の中身は、文字参照を展開したうえで**エスケープせずに**出力される。`&amp;copy` は `&copy` になり、ブラウザでは © と読まれる。`&lt;/title&gt;` は `</title>` になり、`<title>` が早く閉じて以降がマークアップになる（タイトルに外部データが入るサイトでは注入になる） | v2 と同じ形で出力する（`A &amp; B` は `A & B`）が、展開すると意味が変わる `&amp;`（後ろの文字と文字参照を作る）と `&lt;`（`</title` が続く）だけは展開せずそのまま残す | 影響は上の 2 つの並びを含むタイトルだけ                                                        |
| 28  | `<script>` の開始タグの属性値に `><` を含むと本文が壊れる（linkedom の文字列分割）                                                                                                                                                                                            | 再現しない（本文は常に生テキストとして出力）                                                                                                                           | —                                                                                              |
| 29  | `characterEntities` が出力全体（`<script>` `<style>` の中身、コメントを含む）の非 ASCII を置換する                                                                                                                                                                            | テキスト・属性値・コメント・`<title>` / `<textarea>` / `<xmp>` だけ。`<script>` `<style>` の中身は変更しない                                                           | v2 の出力は JS / CSS の文字列を壊していた                                                      |
| 30  | 断片（`<html>` / `<!doctype` で始まらない本文）の途中に `<!doctype>` があると、linkedom が doctype 以外の内容を**落とす**                                                                                                                                                     | 内容を落とさない（doctype は先頭に出力する）                                                                                                                           | v2 のデータ損失を再現しない                                                                    |
| 31  | `imageSizes` が壊れた画像で匿名のパーサエラーを出す                                                                                                                                                                                                                           | エラーメッセージに画像のパスを含める。`keepAuthored: true` で手書きの `width` / `height` を残せる                                                                      | —                                                                                              |

## 3. 設定（`kamado.config.jsonc`）

JSONC（`//` と `/* */` のコメント、末尾カンマ可）。`$schema` で補完。相対パスは設定ファイルのディレクトリ基準。未知のキーは**エラー**（タイプミスの黙殺を防ぐ）。

```jsonc
{
	"$schema": "./node_modules/kamado/schema.json",
	"dir": { "input": "src", "output": "htdocs" }, // 既定は両方とも root だが、同じだとエラー（出力が入力を上書きするため）。output は必ず指定する
	"site": {
		"host": "example.com",
		"baseURL": "https://example.com/",
		"siteName": "Example",
		"siteNameEn": "Example",
	},
	// 未指定なら package.json の production から取る

	"pages": {
		"files": "**/*.{html,tsx}", // 既定
		"ignore": ["_includes/**"],
		"outputExtension": ".html",
		"outputPathField": null, // meta / front matter のキー名。例: "path"
		"outputPathConflict": "warning", // "error" | "warning" | "silent"
		"layouts": { "dir": "_libs/layouts" },
		"alias": { "@": "_libs" }, // JSX の import の別名（コンパイル時に書き換え）
		"define": { "process.env.NODE_ENV": "\"production\"" }, // 定数置換
		"overrides": "pages.overrides.json", // 外部 JSON（§6）
	},
	"data": { "dir": "_libs/data", "values": {} },

	"html": {
		"doctype": true,
		"format": {
			"useTabs": true,
			"tabWidth": 2,
			"printWidth": 100000,
			"bracketSameLine": true,
		},
		"minify": {
			"booleanAttributes": true,
			"redundantAttributes": true,
			"scriptTypeAttributes": true,
			"styleLinkTypeAttributes": true,
			"css": true,
			"js": true,
		},
		"lineBreak": "\n",
		"entities": "none", // "none" | "all" | { "©": "&copy;" }
		"imageSizes": { "enabled": true, "exclude": [], "keepAuthored": false },
		"rules": [], // §9.1
		"includes": [], // §9.2
		"inject": [], // §9.3
		"overrides": [], // [{ "pages": [glob], ...html の任意のオプション }]
		"onError": "silent", // "silent" | "warning" | "error"
	},

	"sitemap": {
		"output": "sitemap.xml",
		"include": ["**/*.html"],
		"exclude": [],
		"lastmod": "none",
		"changefreq": null,
		"priority": null,
	},

	"styles": {
		"files": "**/*.css",
		"ignore": [],
		"alias": { "@": "_libs" },
		"banner": "/*! rev. {{date:YYYY-MM-DD}} */",
		"sourcemap": "onServer",
		"minify": true,
	},
	"scripts": {
		"files": "**/*.{js,ts,jsx,tsx,mjs,cjs}",
		"ignore": [],
		"alias": {},
		"define": {},
		"banner": "",
		"sourcemap": "onServer",
		"minify": true,
		"target": "es2022",
	},

	"devServer": {
		"port": 3000,
		"host": "localhost",
		"open": false,
		"startPath": "/",
		"proxy": {
			"/api": {
				"target": "https://api.example.com",
				"rewrite": { "from": "^/api", "to": "" },
				"changeOrigin": true,
			},
		},
	},
	"build": {
		"jobs": "auto",
		"incremental": false,
		"cacheDir": null,
		"skipUnchanged": false,
		"report": null,
	},
}
```

### 3.1 `pages.files` と `scripts.files` の重複

`pages.files` が `.tsx` を含み、`scripts.files` も `.tsx` を含むと、同じ入力が二重に処理される。**v3 は `scripts.files` から `pages.files` に一致するものを除外**する（ページが優先）。クライアント側の `.tsx` を `scripts` で扱う場合は、`pages.files` の範囲を狭める。

## 4. メタデータ

供給源は 4 系統。**優先順位は高い順に、`pages.overrides`、sidecar `.json`、ファイル内（`export const meta` または YAML front matter）**。同じキーはオブジェクトを再帰的にマージせず、上位が丸ごと置き換える。

- **TSX**: `export const meta = { ... }`。**リテラルのみ**（文字列、数値、真偽値、null、配列、オブジェクト、テンプレートリテラル（式なし））。`as const` と `satisfies T` は許可する（型注釈の除去と同じ扱い）。式、変数参照、スプレッド、関数呼び出しは**ビルドエラー**（行と列を示す）。Rust が JS を実行せずに抽出する。
- **HTML**: 先頭の YAML front matter（`---` で囲む。gray-matter と同じ規則: 先頭 0 バイト目（BOM 可）から、閉じは `---` の行、1 つの改行を除去、空は `{}`）。
- **sidecar**: 同じディレクトリ・同じ名前の `.json`（`page.tsx` に対して `page.json`）。存在しなくてよい。不正な JSON はエラー。
- **`pages.overrides`**: §6。

YAML のサブセット: ブロック / フローのマップとシーケンス、プレーン / シングル / ダブルクォートのスカラー、`|` と `>`（chomping と indent 指示子）、コメント、アンカーとエイリアス、`<<` のマージ。YAML 1.2 の core スキーマ。**日付は文字列のまま**。タグ（`!foo`）、複雑なキー（`?`）、複数ドキュメントはエラー。

## 5. ページとファイル

- 出力パス: 入力ディレクトリの構造を鏡写しにし、拡張子を `outputExtension` に差し替える（v2 と同じ）。
- `page`（テンプレートに渡すファイル情報）は v2 の `CompilableFile` と同じ形: `inputPath` `outputPath`（絶対）、`fileSlug`（拡張子なしのファイル名。`index` なら親ディレクトリ名）、`filePathStem`（`/` 始まり、POSIX、拡張子なし）、`url`、`extension`（小文字）、`date`（ファイルオブジェクトを作った時刻）。
- `outputPathField` / `outputPathConflict`: v2 と同じ規則。値は `/` で始まる。`.` と `..` のセグメントは拒否。`/a/b.ext` はそのまま、`/a/b` は `outputExtension` を補う、`/a/b/` は `index<outputExtension>`。出力ディレクトリの外は拒否。衝突は front matter 指定が優先し、同列なら先勝ち。`warning` が既定。
- glob: `**` `*` `?` `[abc]` `[!a]` `{a,b}`（入れ子可）`\` エスケープ、先頭 `!` の否定は**設定ではエラー**（除外は `ignore` / `exclude` で書く。適用されないまま黙って無視されるのを防ぐ）。大文字小文字を区別、`/` 区切り、`dot: false`（`.` で始まるセグメントは、パターンに `.` が明示されたときだけ一致）。拡張グロブ（`@(...)` 等）はエラー。走査結果は**辞書順にソート**する（v2 は fs 依存）。
- 出力が入力を上書きしないための規則: `dir.output` は `dir.input` と異なる。出力ディレクトリが入力ディレクトリの内側にあるとき（`input: "."`、`output: "htdocs"`）、その中のファイルはページとして探索しない。ページの出力先が別の入力ファイルのパスと一致する場合（`outputPathField` の指定による）はビルドエラーにする。
- 探索では、`ignore` に `dir/**` の形で書いたディレクトリには入らない（`node_modules` のような大きなツリーを走査しない）。この場合、`.` で始まるエントリも含めて、そのディレクトリ全体が除外される。
- 古い出力は削除しない（v2 と同じ）。
- 出力に対応する入力がないファイルは、開発サーバーでは出力ディレクトリから静的に配信する（v2 と同じ）。

## 6. `pages.overrides`

`pages.overrides` は JSON ファイルへのパス。prebuild が外部のデータ（スプレッドシート等）から書き出す。

```jsonc
{
	"version": 1,
	"pages": [
		{
			"url": "/service/", // 必須。ページの URL
			"virtual": false, // true なら入力ファイルがない仮想ページ（nav / breadcrumbs / pages に現れる）
			"meta": { "title": "…", "navHidden": true, "realHref": "https://…" }, // メタに上書き（最優先）
			"lastmod": "2026-01-02T00:00:00+09:00", // sitemap.lastmod: "manifest" のとき使う
		},
	],
}
```

- `url` が既存ページに一致すれば `meta` を上書き、一致しなければ `virtual: true` が必要（なければエラー）。
- 仮想ページは出力しない。`pages` / `nav()` / `breadcrumbs` / `titleList()` のインデックスにだけ加わる。
- ファイルが存在しない・不正な JSON はビルドエラー。`version` が未知なら拒否。

## 7. JSX

### 7.1 コンパイルモデル

TSX を Rust が「HTML 文字列を返す JS」にコンパイルする。コンパイル後の JS は Node のワーカーが読み込んで実行する。**React・仮想 DOM は使わない**。

- 要素は文字列の連結になる。静的な部分木はモジュールの定数に巻き上げる。
- 式の値の描画: 文字列・数値は**エスケープ**して出す。コンポーネントの戻り値（`Html` 型。内部は文字列のラッパー）はそのまま出す。配列は平坦化して連結する。`null` / `undefined` / `false` / `true` は出さない。`0` は `"0"`。
- 属性: `className` → `class`、`htmlFor` → `for`、`style` はオブジェクト → `prop: value;` 形式（ケバブケース、数値には React と同じ unitless の表に従い `px` を付ける）、真偽値は属性の有無、`null` / `undefined` / `false` は出さない、`dangerouslySetInnerHTML={{ __html }}` は生で出す。`key` と `ref` は無視する。関数値（`onClick` 等）は**警告して無視**する。
- 空要素（`br` `img` `input` `meta` `link` `hr` 等）は閉じタグを出さない。`<script>` と `<style>` の子はエスケープしない。
- JSX の空白の規則は React / TypeScript の `jsx` 変換と同じ（行頭行末の空白と改行の除去、空行の除去、`{" "}` で明示）。
- **描画結果の文字列は、そのまま出力されず、Rust の HTML 後処理（再パース → 融合印字）を通る**。したがって、エスケープの細かい形（`&#x27;` と `&#39;` など）は後処理で正規化され、出力に影響しない。

### 7.2 コンポーネントと型

- 同梱の `.d.ts` が `JSX` の名前空間、`Html`、`PageProps`、`LayoutProps` を定義する。`tsconfig.json` の `"jsx": "preserve"` と `"jsxImportSource": "kamado"`（型のみ）で使う。
- hooks（`useState` など）、Context、`Suspense` は**非対応**。コンポーネントは**純粋関数**（同じ props なら同じ出力、モジュールの変数を書き換えない）。ワーカーが並列に描画するので、この契約を破ると結果が不定になる。
- `import` できるもの: 相対パスと `pages.alias` で指定した別名の TSX / TS / JSON、npm パッケージ（Node が解決し、ESM のみ）。CSS の import は非対応。

### 7.3 ページとレイアウトに渡されるもの

ページのコンポーネントは `props` として次を受け取る。

| 名前                        | 内容                                                                                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                      | §5 の `page`                                                                                                                                                                                    |
| `meta`                      | このページのメタ（§4 のマージ後）                                                                                                                                                               |
| `site`                      | `site.*`                                                                                                                                                                                        |
| `data`                      | `data.dir` と `data.values` をマージしたオブジェクト（ファイル名がキー）                                                                                                                        |
| `pages`                     | 全ページの一覧（`page` と `meta`）。**Rust のインデックスを引くアクセサ**で、コピーしない                                                                                                       |
| `nav(options?)`             | v2 と同じ。`{ ignoreGlobs, baseDepth }`。ツリーのノードは `{ page, meta, children }`。絞り込みと並べ替えは、返ってきた配列を JSX 側で加工する                                                   |
| `breadcrumbs`               | v2 と同じ。祖先の `index` ページとページ自身。`{ title, href, depth, meta }`。タイトルがなければ `__NO_TITLE__`                                                                                 |
| `titleList(options?)`       | v2 と同じ。`{ separator, baseURL, prefix, suffix, fallback }`                                                                                                                                   |
| `formatDate(value, format)` | dayjs のトークンのサブセット（`YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ X x`、`[…]` でエスケープ、英語、ローカルのタイムゾーン）。`value` は文字列・数値・Date |

レイアウトは追加で `content`（ページの描画結果。`Html`）を受け取る。`meta.layout` に `layouts.dir` 内のファイル名（拡張子なし）を書く。`.html` ページはこれがレイアウトを使う唯一の手段。JSX ページは `<Layout>` を直接合成してもよい。存在しないレイアウト名はエラー。

`pages` / `nav` / `breadcrumbs` / `titleList` が読んだメタのフィールドは、ページごとに記録され、差分ビルドの判定に使われる（読んでいないフィールドの変更では再描画しない）。

## 8. バナー

`styles.banner` / `scripts.banner` は文字列。`{{date:FORMAT}}`（`formatDate` と同じトークン）、`{{year}}`、`{{version}}`（package.json の version）が使える。既定は `rev. YYYY-MM-DD` と `copyright © YYYY` を含むコメント、`"" `で無効。開発サーバーでは、日本語の「開発中・編集不可」の注意書きに置き換わる（v2 と同じ）。CSS は `/*! */` 形式にして、圧縮後も残す。

## 9. HTML 後処理

パイプラインの順序（1 回のパースと 1 回の印字）:

1. 描画結果（または `.html` の本文）を、レイアウトと合成する
2. パース（`<?...?>` は処理命令として保持する）
3. `html.includes`（取り込み。再帰）
4. `html.rules`（宣言的な DOM 操作）
5. `html.inject`
6. `imageSizes`
7. 印字（`doctype`、`format`、`minify`、`entities`、`lineBreak`）。`<style>` と `style` 属性の CSS は Rust の CSS 圧縮、`<script>` は esbuild（子プロセス、内容のハッシュでキャッシュ）
8. 書き出し

`html.overrides` は、`pages` の glob に一致するページに限り、`html` の任意のオプションを上書きする。たとえば整形と圧縮を切る、`imageSizes` を切る、といった使い方ができる。

### 9.1 `html.rules`

```jsonc
{
	"pages": ["**"],
	"exclude": [],
	"selector": "a[href^='http']",
	"action": "setAttr",
	"name": "rel",
	"value": "noopener",
}
```

`pages` / `exclude` は glob（出力 URL に対して）。`selector` は CSS セレクタ（タイプ、`*`、`#id`、`.class`、属性セレクタ全種と `i` フラグ、結合子 ` ` `>` `+` `~`、`:not` `:is` `:where` `:has`、`:first-child` `:last-child` `:only-child` `:nth-child(an+b)` `:nth-last-child` `:nth-of-type` `:first-of-type` `:last-of-type` `:empty` `:root`。未対応はエラー）。

| action                     | 追加のキー                                                                                             | 動作                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `remove`                   | —                                                                                                      | 要素を削除                                                                                |
| `unwrap`                   | —                                                                                                      | 要素を外して子を残す                                                                      |
| `wrap`                     | `html`                                                                                                 | `html`（`{{content}}` を含む）で包む                                                      |
| `setAttr`                  | `name`, `value`                                                                                        | 属性を設定。`value` は文字列、`{{attr:href}}` `{{url}}` `{{baseURL}}` が使える            |
| `removeAttr`               | `name`（文字列または `/regex/`）                                                                       | 属性を削除                                                                                |
| `addClass` / `removeClass` | `value`                                                                                                | クラスを追加 / 削除                                                                       |
| `insert`                   | `position`（`before` `after` `prepend` `append`）, `html`                                              | HTML を挿入                                                                               |
| `rewriteUrl`               | `to`（`absolute` / `rootRelative`）, `origin`, `attrs`（既定 `href` `src` `srcset` `poster` `action`） | URL を書き換える。危険なスキーム（`javascript:` `data:` `vbscript:` `file:`）は変更しない |

条件は `selector` で表す。属性値による条件（例: 同じホストでない外部リンク）は `:not([href*='{{host}}'])` のように `{{host}}` を使える。

### 9.2 `html.includes`

```jsonc
{ "preset": "ssi" }
{ "preset": "ssi", "dir": "/home/www/document_root/" }
{ "preset": "includeComment", "root": "_libs" }
{ "preset": "burgerEditorImport" }
{ "selector": "[data-include]", "attr": "data-include", "root": "_libs", "pick": "section", "replace": "element" }
```

- 取り込んだファイルは、差分ビルドの依存として記録する（存在しないファイルも記録する）。
- パスの起点（`root`）の外に出るパス（`..` による脱出）はエラー（path traversal の防御）。起点の内側にとどまる `..` は許す。シンボリックリンクは辿らない前提（解決しない）。
- 取り込み先のファイルの中の include も展開する。入れ子は 16 段まで、循環（自分自身を取り込む）はエラー。
- 取り込めない（読めない）ファイルの扱いは `html.onError`（`error` は失敗、`warning` は警告して空に、`silent` は空に）に従う。
- 汎用ルール（`selector`）: `attr` の値が取り込むファイルのパス（`/` 始まりは `root` 基準、それ以外は取り込み元のファイル基準）。`pick` は取り込んだファイルの中から使う部分（セレクタの最初の一致。省略すると全体）。`replace` は `element`（一致した要素を置き換える）か `children`（一致した要素の子を置き換える）。
- `preset: "ssi"`: `<!--#include virtual="..." -->`。起点は出力ディレクトリ（v2 と同じ）。`dir` を指定すると、本番サーバーのドキュメントルートを出力ディレクトリに対応づける（v2 の `dir` と同じ）。
- `preset: "includeComment"`: `<!-- @include(PATH) -->`。PATH が `<documentRoot>/` で始まれば入力ディレクトリ基準、`/` で始まれば `root` 基準、それ以外は取り込み元のファイル基準。**取り込み先もパイプライン全体を通す**（取り込んだ先の include も再帰的に展開する。v2 は最初の 1 つしか展開しなかった）。
- `preset: "burgerEditorImport"`: `[data-bge-container] [data-bgi=import] bge-import` の `src` を読み、取り込んだファイルの `[data-bge-container]` で、外側の container を置き換える。`src` は `/` 始まりのみ（相対パスはエラー）。

### 9.3 `html.inject`

```jsonc
{
	"pages": ["**"],
	"exclude": ["/search/**"],
	"position": "head-end",
	"mode": "build",
	"html": "<link rel=\"stylesheet\" href=\"/x.css\">",
}
```

`position`: `head-start` / `head-end` / `body-start` / `body-end`。`mode`: `build` / `serve` / `both`。同じ内容を重複して挿入しない（`name` で識別できる）。

### 9.4 `entities` と `imageSizes`

- `entities`: `"all"` は ASCII 以外を名前付き文字参照（小文字を優先）に。オブジェクトは指定した文字だけ。`<script>` / `<style>` の中は変更しない。
- `imageSizes`: `img` と `picture > source` に `width` / `height` を付ける（png / jpg / jpeg / webp / avif / svg）。出力ディレクトリ基準で解決し、外部 URL・`data:` URI・パスが出力ディレクトリを出るものは対象外。`exclude` は glob（ページ）、`keepAuthored: true` は手書きの値を残す。読んだ画像は依存として記録する。

## 10. CSS と JS

- `styles`: CSS Syntax 3 のトークナイザとパーサ、`@import` の展開（alias は `prefix/`、`url()` と文字列の両方、メディア条件は `@media` で包む、リモート URL は残す、同じファイルの重複は除く、循環は検出）、安全な圧縮（cssnano の既定のうち、空白・コメント（`/*!` は残す）・空ルール・文字列・数値・色・`url()`・フォント値・セレクタの正規化・重複の削除）。`calc` の定数畳み込み、`mergeLonghand`、`mergeRules`、`reduceInitial`、`svgo` は対象外。**サイズは cssnano の出力の +3% 以内、gzip 後は +1% 以内**を目標にする。
- `scripts`: esbuild（固定バージョン）。`alias` / `define` / `minify` / `sourcemap` / `banner`。出力は v2 とバイト一致。

## 11. 差分ビルド

- manifest: v2 と同じ場所（`<os.tmpdir()>/kamado/<basename>-<hash>/`、`--cache-dir` で上書き）。形式は version 2。
- 各入力と依存の指紋は `(size, mtime_ns)` を先に比較し、変わったときだけ SHA-256 を取る（`--force` で全て再計算）。ハッシュが一致すれば（early cutoff）再ビルドしない。
- 環境ダイジェスト: 設定ファイルの内容、kamado のバージョン、`pages.overrides`、ページごとに「読んだメタのフィールド」の値。
- 依存ゼロのファイルはスキップしない（v2 と同じ）。manifest の version 不一致・破損は全ビルド。

## 12. 開発サーバー

- hono。`/` → `index.html`、末尾 `/` → `index.html`、拡張子なし → `.html`。出力ディレクトリ外は 403。マップにない場合は出力ディレクトリから静的配信、なければ 404、コンパイルの失敗は 500（本文はエラーメッセージ）。
- MIME は一般的な拡張子の表を持つ。プロキシ: 最長一致、`rewrite`、`changeOrigin`、Node の `fetch`（TLS は Node）、リダイレクトは手動、ネットワークエラーは 502。
- ファイル監視とライブリロードは**持たない**（v2 と同じ）。リクエストごとに依存の stat を確認し、変更がなければ前回の出力を返す。

## 13. CLI

`kamado build [globs...]`、`kamado server`。共通: `--config/-c`、`--verbose`。build: `--incremental`、`--force`、`--cache-dir <dir>`、`--skip-unchanged`、`--jobs <n|auto>`。設定エラーは赤字で表示して exit 1。進捗表示（スピナー、done/total、`Build completed in Xs`）と色分けは v2 に準じる。

プログラム API: `build(config)` と `start(config)`。引数は JSONC と同じ形のオブジェクト。

## 14. ビルドの出力: `build.report`

`build.report` にパスを指定すると、ビルド結果の JSON を書き出す。postbuild のスクリプトが使う。

```jsonc
{
	"version": 1,
	"pages": [
		{ "url": "/a/", "inputPath": "…", "outputPath": "…", "meta": {}, "status": "built" },
	],
	"files": [{ "inputPath": "…", "outputPath": "…", "status": "cached" }],
}
```

## 15. sitemap

`sitemap.output` に XML を書く。対象は `include` の glob（出力ディレクトリ基準、既定 `**/*.html`）から `exclude` を除いたもの。`index.html` は末尾スラッシュの URL。`lastmod`: `"manifest"` は `pages.overrides` の値、`"mtime"` はファイルの更新時刻、`"none"` は出力しない。URL の起点は `site.baseURL`。

## 16. 並列モデルと純粋性

- Rust のスレッドプールが、パース・DOM・整形・圧縮・画像・I/O を処理する。JSX の描画は `worker_threads` が並列に行う（`--jobs` で数を指定）。
- コンポーネントは純粋関数（§7.2）。モジュールの変数にページをまたいで状態を貯めない。`ctx.emit` のようなページ間の集計 API は提供しない（集計したいなら `build.report` を使う）。

## 17. 論点と決定

| #   | 論点                                                           | 決定                                                                              |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Q2  | `html.rules` の `pages` は出力 URL か入力パスか                | 出力 URL（`/a/b/` や `/a/b.html`）。ユーザーが見るのは URL                        |
| Q3  | `HTML` ページ（`.html`）での JSX                               | 不可。`.html` は HTML としてのみ扱い、レイアウトだけが JSX                        |
| Q4  | `pages.files` の既定に `.md` を含めるか                        | 含めない（v2 にもない）                                                           |
| Q5  | `Html` 型の実体（文字列のラッパークラス / ブランド型の文字列） | 描画の実装時に実測して決める（性能に影響する）                                    |
| Q6  | `kamado/jsx-runtime` を公開するか                              | 型だけ公開し、ランタイムは非公開（コンパイル後の JS が使う内部 API は変更しうる） |
