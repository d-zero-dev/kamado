# kamado v3 RFC

状態: **合意済み**。17 章の論点はユーザーが確認して確定した（`Html` 型の実体は、実装して測ったうえで `Markup` クラスに決めた）。仕様の変更は、この文書を更新してから実装に反映する。

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
		"encoding": "utf8", // "utf8" | "shift_jis"（§9.4）
		"serializer": "linkedom", // "linkedom" | "spec"（§9.5）
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
- **並び順**: ファイルに書いたページ（既存・仮想とも）が、書いた順で `pages` の先頭に並び、書かなかったページが（辞書順のまま）その後に続く。`nav()` は並べ替えをしないので、この順がナビゲーションの表示順になる（v2 の `pageList()` の返り値の順）。
- ファイルが存在しない・不正な JSON はビルドエラー。`version` が未知なら拒否。

## 7. JSX

### 7.1 コンパイルモデル

TSX を Rust が「HTML 文字列を返す JS」にコンパイルする。コンパイル後の JS は Node のワーカーが読み込んで実行する。**React・仮想 DOM は使わない**。

- 要素は文字列の連結になる。静的な部分木はモジュールの定数に巻き上げる。
- 式の値の描画: 文字列・数値は**エスケープ**して出す。コンポーネントの戻り値（ランタイムの `Markup` クラス。文字列のラッパー）はそのまま出す。配列は平坦化して連結する。`null` / `undefined` / `false` / `true` は出さない。`0` は `"0"`。
- 属性: `className` → `class`、`htmlFor` → `for`、`style` はオブジェクト → `prop: value;` 形式（ケバブケース、数値には React と同じ unitless の表に従い `px` を付ける）、真偽値は属性の有無、`null` / `undefined` / `false` は出さない、`dangerouslySetInnerHTML={{ __html }}` は生で出す。`key` と `ref` は無視する。関数値（`onClick` 等）は**警告して無視**する。
- 空要素（`br` `img` `input` `meta` `link` `hr` 等）は閉じタグを出さない。`<script>` と `<style>` の子はエスケープしない。
- JSX の空白の規則は React / TypeScript の `jsx` 変換と同じ（行頭行末の空白と改行の除去、空行の除去、`{" "}` で明示）。
- **React との意図した違い**: ①`<html static>` の中でだけ、属性 `on*` の**文字列**をそのまま属性として出す（React は全部捨てる。テンプレートから移した静的なページは `onclick="..."` を持つ）。関数と、static でない描画では捨てる。②`<html static>`（または、`<html>` を持たないページの `meta.kdStatic: true`）は、テンプレートの書いた順を保つモード。`<head>` の `title` / `meta` / `link` / `script` を持ち上げず（`<head hoist={false}>` ならこれだけ）、`form` / `input` / `button` の属性を書いた順で出す。`html` と `head` の子はこの目的で遅延評価（thunk）にコンパイルされる。③`styleOf(text)`（`kamado-v3/jsx` が公開する、ユーザー向けの名前。もう 1 つは `html(text)`）は CSS 文字列を `style` のオブジェクトにする。
- **描画結果の文字列は、そのまま出力されず、Rust の HTML 後処理（再パース → 融合印字）を通る**。したがって、エスケープの細かい形（`&#x27;` と `&#39;` など）は後処理で正規化され、出力に影響しない。

**コンパイル結果の置き場**: `build` は、ページ（TSX）を 1 ファイル 1 モジュールとして書き出さず、**連続する 64 ページを 1 つの「チャンク」ファイル（`node_modules/.cache/kamado-v3/jsx/__chunks__/<hash>.mjs`）の関数**にまとめる。チャンクは runtime とページが import するモジュールを 1 回だけ import し、`pages[i]()` がそのページの export（`default`）を返す。ページが import するコンポーネントやレイアウトは、従来どおり 1 モジュール 1 ファイルで、全ページで共有する。

- なぜ: ファイルの作成と Node の `import()` は、ページ数が数万になるとビルドの大半を占める。`import()` はファイルを開いて解決しリンクする。開発に使っている macOS では `open` が 70〜200µs かかる。チャンクにすると、ページを読み込む CPU 時間は 1 ページあたり約 440µs から約 30µs になる（20000 ページのフルビルドで 9s から 7s）。HTML の出力は、チャンクにしても 20013 ファイルがバイト一致する（その後、描画結果をバッチごとに `feed` で渡すようにして 6.2s）。
- 副作用: チャンクはページが import するモジュールを先頭でまとめて import するので、同じチャンクのどれかのページの import が失敗すると、チャンクの全ページが失敗し、エラーは最初にチャンクを読んだページの名前で出る（壊れたページとは限らない）。前回のチャンクは「今回使わないもの」をすべて消す。コンパイル結果の置き場は `build.cacheDir` に関係なく**常に `<プロジェクトのルート>/node_modules/.cache/kamado-v3/jsx`**（`node_modules` を辿ってパッケージを解決させるため、プロジェクトの中に置く）なので、同じプロジェクトで 2 つのビルド（開発サーバーを含む）を同時に走らせると互いのファイルを消し合って壊れる。また `node_modules` に書き込めなければ、JSX ページのビルドはできない。ページが別のモジュールから import されている場合、そのページは関数とモジュールの 2 つの実体になる。
- 取り込みの意味: `import { a } from "m"` は、チャンクが取り込んだ `m` の名前空間から `const { a } = ...` で取り出す（ESM の巻き上げと同じく、ページの先頭で）。ページの `export default` は関数の `default`、それ以外の `export` は捨てる（ホストは読まない。宣言したものはローカルに残る）。
- チャンクにできないページ（`export * from` / `export { a } from` の再 export、`import.meta`、副作用だけの `import "x"`、hashbang）は、従来どおり 1 ファイルのモジュールとして書き出す。ページが別のモジュールから import されている場合も、そのページはモジュールとして書き出す。
- 開発サーバーはチャンクを使わない（1 ページずつ、モジュールのファイルから描画する）。環境変数 `KD_PAGE_CHUNKS=0` で `build` でも使わなくなる（出力の比較用）。
- チャンクのファイル名は内容のハッシュで、今回のビルドが使わなかった前回のチャンクは削除する（変更したページだけを描画する差分ビルドは、そのページだけを別のチャンクにする）。

### 7.2 コンポーネントと型

- 型定義（`PageProps` などの `.d.ts`）は同梱しない。コンポーネントの props の型は、使う側が宣言する（`jsx` の型は `@types/react` など、使うプロジェクトが持つもので足りる）。`tsconfig.json` は `"jsx": "preserve"` にする。
- hooks（`useState` など）、Context、`Suspense` は**非対応**。コンポーネントは**純粋関数**（同じ props なら同じ出力、モジュールの変数を書き換えない）。ワーカーが並列に描画するので、この契約を破ると結果が不定になる。
- `import` できるもの: 相対パスと `pages.alias` で指定した別名の TSX / TS / JSON、npm パッケージ（Node が解決し、ESM のみ）。CSS の import は非対応。

### 7.3 ページとレイアウトに渡されるもの

ページのコンポーネントは `props` として次を受け取る。

| 名前                        | 内容                                                                                                                                                                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                      | §5 の `page`                                                                                                                                                                                                                                                                                        |
| `meta`                      | このページのメタ（§4 のマージ後）                                                                                                                                                                                                                                                                   |
| `site`                      | `site.*`                                                                                                                                                                                                                                                                                            |
| `data`                      | `data.dir` と `data.values` をマージしたオブジェクト（ファイル名がキー）                                                                                                                                                                                                                            |
| `pages`                     | 全ページの一覧（`page` と `meta`）。ワーカーに 1 回渡した配列を、そのワーカーのすべてのページが共有する（ページごとにはコピーしない。Rust のインデックスを引くアクセサではない）                                                                                                                    |
| `nav(options?)`             | v2 と同じ。`{ ignoreGlobs, baseDepth }`。ツリーのノードは `{ page, meta, children }`。絞り込みと並べ替えは、返ってきた配列を JSX 側で加工する                                                                                                                                                       |
| `breadcrumbs`               | v2 と同じ。祖先の `index` ページとページ自身。`{ title, href, depth, meta }`。タイトルがなければ `__NO_TITLE__`。起点は `site.baseURL` の**パス部分**（`https://example.com/sub/` なら `/sub/`）で、それより浅い階層は含めない（v2 は値をそのまま数えたので、フル URL を書くと上位 2 階層が欠けた） |
| `titleList(options?)`       | v2 と同じ。`{ separator, baseURL, prefix, suffix, fallback }`                                                                                                                                                                                                                                       |
| `formatDate(value, format)` | dayjs のトークンのサブセット（`YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ X x`、`[…]` でエスケープ、英語、ローカルのタイムゾーン）。`value` は文字列・数値・Date                                                                                                     |

レイアウトは追加で `content`（ページの描画結果。エスケープ済みの HTML として印字されるので、`{content}`、`dangerouslySetInnerHTML={{ __html: content }}`、`html(content)` のどれでも二重にエスケープされない）を受け取る。`meta.layout` に `layouts.dir` 内のファイル名（拡張子なし）を書く。`.html` ページはこれがレイアウトを使う唯一の手段。JSX ページは `<Layout>` を直接合成してもよい。存在しないレイアウト名はエラー。

差分ビルドは、全ページの URL とメタのダイジェストを JSX ページの環境に含める。`pages` / `nav` / `breadcrumbs` / `titleList` がどのフィールドを読んだかは記録しないので、**どのページのメタが変わっても、JSX で描画する全ページが再ビルドされる**（`.html` ページは影響を受けない）。フィールド単位の追跡は行わない（読んだフィールドの記録は、アクセサ化とあわせて入れるまで持たない）。

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
7. 印字（`doctype`、`format`、`minify`、`entities`、`lineBreak`）。DOM を戻す書き方は `serializer`、書き出すバイト列の文字コードは `encoding`（§9.5、§9.6）。`<style>` と `style` 属性の CSS は Rust の CSS 圧縮、`<script>` は esbuild（子プロセス、内容のハッシュでキャッシュ）
8. 書き出し

`<script type="application/ld+json">`（`importmap`、`speculationrules`、`json` で終わる type も同じ）の中身は、v2 と同じく prettier の JSON 整形がそのまま出力に残る（オブジェクトは `{ "a": 1 }` の 1 行、`{` の直後で改行されていれば展開、複数のオブジェクトを持つ配列は展開、数値は `1.50` → `1.5`、文字列は二重引用符、末尾カンマなし）。コメントを含む JSON と JSON として読めない中身は整形せず、書かれたまま出す（prettier も後者はそのまま出す）。

`html.overrides` は、`pages` の glob（出力 URL に対して）に一致するページに限り、`html` の任意のオプションを上書きする。上書きするのは、そのエントリが**書いたオプションだけ**で（`rules` を書けば `rules` 全体が置き換わる）、書かなかったオプションは `html` の値のまま。一致するエントリが複数あれば、書かれた順に適用する。たとえば整形と圧縮を切る、`imageSizes` を切る、といった使い方ができる。エントリの中に `overrides` は書けない。

**ステージの失敗と `html.onError`**: 手順 2〜6（パース・取り込み・ルール・inject・画像）は 1 つの「DOM ステージ」で、`doctype`、`format`、`minify` はそれぞれ別のステージ。v2 の `formatOptions.parseError` と同じく、ステージが失敗したとき `silent`（既定）は何も報告せずそのステージを飛ばして直前の文字列を次のステージに渡し、`warning` は警告を出して同じく飛ばし、`error` はそのページのビルドを失敗にする。DOM ステージの失敗（たとえば取り込みの path traversal）で、ルールや inject も一緒に飛ばされるので、CI では `warning` か `error` にする。警告はそのビルドで組み立てたページ分だけ出る（差分ビルドで `cached` になったページの警告は再掲されない）。

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

条件は `selector` で表す。属性値による条件（例: 同じホストでない外部リンク）は `:not([href*='{{host}}'])` のように `{{host}}`（`site.host`）を使える。`site.host` が未設定のまま `{{host}}` を使うと、何にも一致しないルールになってしまうので、設定エラーにする。

### 9.2 `html.includes`

```jsonc
{ "preset": "ssi" }
{ "preset": "ssi", "dir": "/home/www/document_root/" }
{ "preset": "includeComment", "root": "_libs" }
{ "preset": "burgerEditorImport", "root": "." }
{ "selector": "[data-include]", "attr": "data-include", "root": "_libs", "pick": "section", "replace": "element" }
```

- 取り込んだファイルは、差分ビルドの依存として記録する（存在しないファイルも記録する）。
- パスの起点（`root`）の外に出るパス（`..` による脱出）はエラー（path traversal の防御）。起点の内側にとどまる `..` は許す。境界の判定はパスの文字列だけで行い、シンボリックリンクは解決しない（起点の内側にあるリンクは辿って読む。ページの書き手は信頼する前提）。`root` の相対パスは、設定ファイルのあるディレクトリ基準。
- `ssi` は出力ディレクトリのファイルを読む。取り込み先がこのビルドで作られるページなら、並列ビルドでは作られる前後のどちらを読むかが決まらない（v2 の並行ビルドも同じ）。取り込み先は、出力ディレクトリに先にあるものにする。
- 取り込み先のファイルの中の include も展開する。入れ子は 16 段まで、循環（自分自身を取り込む）はエラー。
- 取り込めない（読めない）ファイルの扱いは `html.onError`（`error` は失敗、`warning` は警告して空に、`silent` は空に）に従う。
- 汎用ルール（`selector`）: `attr` の値が取り込むファイルのパス（`/` 始まりは `root` 基準、それ以外は取り込み元のファイル基準）。`pick` は取り込んだファイルの中から使う部分（セレクタの最初の一致。省略すると全体）。`replace` は `element`（一致した要素を置き換える）か `children`（一致した要素の子を置き換える）。
- `preset: "ssi"`: `<!--#include virtual="..." -->`。起点は出力ディレクトリ（v2 と同じ）。`dir` を指定すると、本番サーバーのドキュメントルートを出力ディレクトリに対応づける（v2 の `dir` と同じ）。
- `preset: "includeComment"`: `<!-- @include(PATH) -->`。PATH が `<documentRoot>/` で始まれば入力ディレクトリ基準、`/` で始まれば `root` 基準、それ以外は取り込み元のファイル基準。**取り込み先もパイプライン全体を通す**（取り込んだ先の include も再帰的に展開する。v2 は最初の 1 つしか展開しなかった）。
- `preset: "burgerEditorImport"`: `[data-bge-container] [data-bgi=import] bge-import` の `src` を読み、取り込んだファイルの**すべての** `[data-bge-container]`（文書順）で、外側の container を置き換える（v2 の `importBlock` と同じ。ただし container の中の container は、v2 はその外へ出して兄弟にするが、v3 はその中に残す）。`src` は `/` 始まりで、`root` 基準。相対パスはエラー。

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

`position`: `head-start` / `head-end` / `body-start` / `body-end`。`mode`: `build` / `serve` / `both`。挿入先にすでに同じマークアップがあれば、重複して挿入しない（内容で判定する。名前での識別はしない）。`<head>` / `<body>` のない断片には挿入しない。

### 9.4 `entities` と `imageSizes`

- `entities`: `"all"` は ASCII 以外を名前付き文字参照（小文字を優先）に。オブジェクトは指定した文字だけ。`<script>` / `<style>` の中は変更しない。
- `imageSizes`: `img` と `picture > source` に `width` / `height` を付ける（png / jpg / jpeg / webp / avif / svg）。出力ディレクトリ基準で解決し、外部 URL・`data:` URI・パスが出力ディレクトリを出るものは対象外。`exclude` は glob（ページ）、`keepAuthored: true` は手書きの値を残す。読んだ画像は依存として記録する。

### 9.5 `html.encoding`

ページのバイト列の文字コード。`"utf8"`（既定）と `"shift_jis"`（別名 `shift-jis` `sjis` `cp932` `windows-31j`。Windows の Shift_JIS = CP932）。ページごとに `html.overrides` の `pages`（出力 URL の glob）で変えられる。ビルドだけに効き、開発サーバーは UTF-8 で返す。CSS と JS は常に UTF-8。

- 入力は UTF-8 のまま書く。印字のあと（`lineBreak` のあと）に、1 回だけ変換する。
- `<meta charset="utf-8">`（`utf8`、大文字小文字、閉じの `/` の有無は問わない）は `<meta charset="shift_jis">` に書き換える（d-zero/builder と同じ）。
- Shift_JIS にない文字は文字参照にする: 名前があれば名前（`©` → `&copy;`）、なければ番号（`〜` U+301C → `&#12316;`）。`<script>` と `<style>` の中は参照が文字として読まれるので `?`（`iconv-lite` と同じ）。表は CP932（NEC 行 13、IBM 拡張を含む）で、`iconv-lite` の `CP932` と BMP 全域で同じ結果（私用領域は変換しない。`¥` は 0x5C、`‾` は 0x7E）。
- 表は `scripts/gen-cp932-table.mjs` が Node のデコーダ（WHATWG `shift_jis`）から作る。

### 9.6 `html.serializer`

DOM を HTML に戻すときの書き方。`"linkedom"`（既定）は v2 の中間 HTML と同じ書き方で、v2 とバイト一致させるためのもの。`"spec"` は HTML 標準（ブラウザ、jsdom、parse5）の書き方で、d-zero/builder の出力と揃える。違い:

|                                   | `linkedom`                                                 | `spec`                          |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------- |
| 属性値の `&` と U+00A0            | そのまま（`&`）／そのまま                                  | `&amp;` ／ `&nbsp;`             |
| テキストの U+00A0                 | `&#160;`                                                   | `&nbsp;`                        |
| `<title>` `<textarea>` のテキスト | そのまま                                                   | `&` `<` `>` U+00A0 をエスケープ |
| 空の属性                          | 既知の真偽属性は名前だけ。空の `class` `id` `style` は消す | すべて `name=""`                |
| 空の SVG 要素                     | `<path />`                                                 | `<path></path>`                 |

`html.entities: "all"` は U+00A0 を `&nbsp;` にする（表の先頭の `NonBreakingSpace` ではなく）。

## 10. CSS と JS

- `styles`: CSS Syntax 3 のトークナイザとパーサ、`@import` の展開（alias は `prefix/`、`url()` と文字列の両方、メディア条件は `@media` で包む、リモート URL は残す、同じファイルの重複は除く、循環は検出）、安全な圧縮（cssnano の既定のうち、空白・コメント（`/*!` は残す）・空ルール・文字列・数値・色・`url()`・フォント値・セレクタの正規化・重複の削除）。`calc` の定数畳み込みと、隣接する同一ブロックのルールの結合も行う。`mergeLonghand`（長手の結合）、非隣接ルールの結合、`reduceInitial`、`svgo` は対象外。custom property と未知のプロパティの値は加工しない（ブラウザの解釈が変わりうるものは、サイズより安全を優先して縮めない）。**サイズは cssnano の出力の +3% 以内、gzip 後は +1% 以内**を目標にし、実在の CSS 21 件で 100.28%（gzip 99.97%）、2 回圧縮しても結果は変わらない。cssnano との意図した差は `crates/kd_css/tests/common/mod.rs` の `DECISIONS` に両側の出力つきで記録する。
  - `<style>` 要素・`style` 属性・`media` 属性も同じ圧縮器を通す（HTML 後処理の一部）。
  - `sourcemap`: `true`、または `onServer` で開発サーバー経由のとき、末尾に inline の source map（`/*# sourceMappingURL=data:application/json;base64,… */`）を付ける。ルールと宣言の単位で、`@import` で取り込んだ元のファイルを指す（トークン単位ではない）。
- `scripts`: esbuild（固定バージョン）。`alias` / `define` / `target`（既定 `es2022`）/ `minify` / `sourcemap` / `banner`。esbuild は JavaScript 側で `bundle: true` として呼び、どのファイルを読んだかをコアに返して差分ビルドの依存にする。v2 は `target` と `define` を渡さないので、既定の `es2022` と esnext で出力が違う構文を使うコードでは v2 と一致しない（`scripts.target` に `esnext` を指定すれば揃う）。
- HTML 内の `<script>` の中身とイベントハンドラ属性は、コアが esbuild の実行ファイルを子プロセスとして直接呼んで圧縮する（JavaScript のスレッドを経由しない）。同じ内容は 1 回だけ圧縮し、結果はキャッシュディレクトリに残す（キー: esbuild のバージョンと内容）。esbuild が読めないコードはそのまま残す。結果は terser（v2）と同一ではないが意味は同じ。esbuild の実行ファイルが見つからないときは圧縮しない。

## 11. 差分ビルド

- manifest: v2 と同じ場所（`<os.tmpdir()>/kamado/<basename>-<hash>/`、`--cache-dir` で上書き）。形式は**バイナリ**（`build-manifest.bin`、version 3）。文字列と（パス、指紋）の組を 1 回だけ書き、エントリは番号で参照する。末尾の SHA-256 で切り詰めや破損を検出し、読めなければ全ビルド。10 万ページでも数十 MB に収まる（JSON では数百 MB になる）。内容を見たいときは `Manifest::to_json`。
- plan cache（`plan-cache.bin`、同じディレクトリ）: ページごとに、ファイルと sidecar の指紋とメタを覚える。ファイルの size と mtime が記録と同じなら、読まず・ハッシュせず・パースせずにキャッシュのメタを使う（本文はそのページをビルドするときに読む）。何も変わらない差分ビルドは、ファイルごとに stat だけで終わる。`--force` は使わない。
- 各入力と依存の指紋は `(size, mtime_ns)` を先に比較し、変わったときだけ SHA-256 を取る（`--force` で全て再計算）。ハッシュが一致すれば（early cutoff）再ビルドしない。同じ依存（レイアウトやコンポーネント）の stat は 1 ビルドで 1 回だけ。ビルド中に変更された入力は（読んだあとに書き換えられた可能性があるので）manifest に「最新」として記録せず、次のビルドでやり直す。
- **既知の限界**: `(size, mtime_ns)` が記録と同じなら、内容は変わっていないとみなす。ファイルシステムの時計の粒度の内に、同じサイズで書き換えられた変更は検出できない（`--force` で全て再計算する）。
- 環境ダイジェスト: 設定ファイルの内容、kamado のバージョン、`pages.overrides`、ページごとに「読んだメタのフィールド」の値。
- 依存ゼロのファイルはスキップしない（v2 と同じ）。manifest の version 不一致・破損は全ビルド。

## 12. 開発サーバー

- hono。`/` → `index.html`、末尾 `/` → `index.html`、拡張子なし → `.html`。出力ディレクトリ外は 403。マップにない場合は出力ディレクトリから静的配信、なければ 404、コンパイルの失敗は 500（本文はエラーメッセージ）。
- MIME は一般的な拡張子の表を持つ。プロキシ: 最長一致、`rewrite`、`changeOrigin`、Node の `fetch`（TLS は Node）、リダイレクトは手動、ネットワークエラーは 502。
- ファイル監視とライブリロードは**持たない**（v2 と同じ）。リクエストごとに依存の stat を確認し、変更がなければメモリの出力を返す（何も書き出さない）。
- コアはサイトを起動時に 1 回だけ計画し、リクエストを「本文」「出力ディレクトリのファイル」「JavaScript に描画を頼む」「esbuild にビルドを頼む」のどれかに振り分ける。JSX ページの描画は専用のワーカー 1 つが行う。Node はモジュールをアンロードできないので、**コンポーネント（またはそれが import するファイル）が変わったら、ワーカーを作り直して全コンテキストを渡す**（古いワーカーは受け持ちを終えてから止まる）。メタだけが変わったときは、変わったページの差分を渡す。
- 起動後に気づかないもの（再起動が必要）: ページファイルの追加と削除、`outputPathField` による出力先の変更、`pages.overrides`・設定ファイル・`html.*` の変更。**他のページ**のメタの変更は、そのページ自身のファイルが変わるか、そのページが要求されるまで、ナビゲーションなどに反映されない。
- スタイルは `styles.sourcemap: "onServer"`（既定）で inline の source map つき、バナーは開発中の警告。スクリプトも同様（esbuild は JavaScript 側で呼ぶ）。

## 13. CLI

`kamado3 build [globs...]`、`kamado3 server`。共通: `--config/-c`、`--verbose`、`--cache-dir <dir>`、`--help/-h`。build: `--incremental`、`--force`、`--skip-unchanged`、`--jobs <n|auto>`（`auto` は設定の `build.jobs` と同じく既定の数）。設定エラーは赤字で表示して exit 1。進捗表示（スピナー、done/total、`Build completed in Xs`）と色分けは v2 に準じる。

コマンド名は `kamado3`（`package.json` の `bin`。公開時に `kamado` へ戻す）。

プログラム API: `build(configPath, options?)` と `start(configPath, options?)`。第 1 引数は**設定ファイル（JSONC）の絶対パス**の文字列で、オブジェクトは受け取らない（相対パスの基準になるディレクトリが設定ファイルの場所だから）。`options` は CLI のフラグに対応する（`build` は `incremental` / `force` / `skipUnchanged` / `targets` / `jobs` / `cacheDir` / `onProgress`、`start` は `verbose` / `cacheDir` / `write`）。

## 14. ビルドの出力: `build.report`

`build.report` にパスを指定すると、ビルド結果の JSON を書き出す。postbuild のスクリプトが使う。

```jsonc
{
	"version": 1,
	"pages": [
		{ "url": "/a/", "inputPath": "…", "outputPath": "…", "status": "built", "meta": {} },
	],
	// ページ以外の出力（styles / scripts）
	"assets": [
		{ "kind": "style", "inputPath": "…", "outputPath": "…", "status": "cached" },
	],
	"warnings": [],
	"elapsedMs": 1234,
}
```

`status` は `built` / `cached`（差分ビルドで飛ばした）/ `unchanged`（`skipUnchanged` で、出力が同じバイト列だった）/ `skipped`（`targets` の対象外）/ `virtual`（仮想ページ。書き出さない）。`kind` は `style` / `script`。

## 15. sitemap

`sitemap.output` に XML を書く。対象は `include` の glob（出力ディレクトリ基準、既定 `**/*.html`）から `exclude` を除いたもの。`index.html` は末尾スラッシュの URL。`lastmod`: `"manifest"` は `pages.overrides` の値、`"mtime"` はファイルの更新時刻、`"none"` は出力しない。URL の起点は `site.baseURL`（`https://example.com/sub/` のように完全な URL）、なければ `https://<site.host>`。どちらもなければ設定エラー。`output` は出力ディレクトリの中でなければならない。仮想ページ（`pages.overrides`）も載り、`lastmod: "mtime"` は入力ファイルの更新時刻（仮想ページは出さない）。差分ビルドや `targets` を指定したビルドでも、計画の全ページから毎回書く。1 ファイルに載せられる URL は 5 万件までなので、超えるときは `sitemap-1.xml`、`sitemap-2.xml`、…（`output` のファイル名に `-番号` を付けたもの）に分け、`output` はそれらを並べたインデックス（`sitemapindex`）にする。URL に空白や日本語があれば `%XX` に符号化する。**分けるのは件数だけ**で、1 ファイル 50MB（非圧縮）の上限は見ない（1 件が 1KB を超えるほど `lastmod` などを付けると超えうる）。**古いファイルは消さない**（§5）ので、ページ数が減って分割がなくなった、または分割数が減ったとき、前のビルドの `sitemap-N.xml` が出力に残る。配信の前に消すのは `build.report` を使う postbuild の仕事。

## 16. 並列モデルと純粋性

- Rust のスレッドプールが、パース・DOM・整形・圧縮・画像・I/O を処理する。JSX の描画は `worker_threads` が並列に行う（`--jobs` で数を指定）。
- コンポーネントは純粋関数（§7.2）。モジュールの変数にページをまたいで状態を貯めない。`ctx.emit` のようなページ間の集計 API は提供しない（集計したいなら `build.report` を使う）。

## 17. 論点と決定

| #   | 論点                                                           | 決定                                                                                                                                                                               |
| --- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q2  | `html.rules` の `pages` は出力 URL か入力パスか                | 出力 URL（`/a/b/` や `/a/b.html`）。ユーザーが見るのは URL                                                                                                                         |
| Q3  | `HTML` ページ（`.html`）での JSX                               | 不可。`.html` は HTML としてのみ扱い、レイアウトだけが JSX                                                                                                                         |
| Q4  | `pages.files` の既定に `.md` を含めるか                        | 含めない（v2 にもない）                                                                                                                                                            |
| Q5  | `Html` 型の実体（文字列のラッパークラス / ブランド型の文字列） | 文字列のラッパークラス（ランタイムの `Markup`）。型は同梱しない（§7.2）                                                                                                            |
| Q6  | `kamado-v3/jsx` を公開するか                                   | `./jsx` として export する。ユーザー向けの名前は `html` と `styleOf` だけで、それ以外（コンパイル後の JS が使う `Markup` `el` `k` `c` `a` `render` など）は内部 API で、変更しうる |

Q1 は欠番（番号の飛びで、内容は記録に残っていない）。
