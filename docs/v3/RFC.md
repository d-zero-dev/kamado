# kamado v3 RFC

状態: **合意済み**。17 章の論点はユーザーが確認して確定した（`Html`型の実体は、実装して測ったうえで`Markup`クラスに決めた）。仕様の変更は、この文書を更新してから実装に反映する。v3 はこのリポジトリの`kamado`パッケージで、v2 は`v2`ブランチで保守している。

関連: `docs/v3/spike-results.md`（設計判断の根拠にした実測結果）。

## 1. 目的

10 万ページ級のフルビルド・差分ビルド・開発サーバー応答で最速の、ミニマムな静的ビルドツール。v2 の基本機能を維持し、API の破壊的変更を許容する。依存は最小（Rust は std のみ、npm ランタイム依存は esbuild/hono/@hono/node-server のみ）。

**完成の定義**: 実案件のプロジェクトが、v2 と同じ基本要件で v3 上で動くこと（ビルド出力が v2 と一致、開発サーバー、差分ビルド、v2 機能の代替手段が揃っている）。

## 2. 破壊的変更の一覧

| #   | v2                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | v3                                                                                                                                                                                                                                                                                                          | 移行                                                                                                                                                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 設定は`kamado.config.{ts,js,...}`、`.kamadorc*`、`package.json`の`kamado`キー                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `kamado.config.jsonc`のみ                                                                                                                                                                                                                                                                                   | 設定を JSONC に書き直す。関数はすべて宣言的オプションに置き換わる                                                                                                                                                         |
| 2   | `defineConfig` / `mergeConfig` / `getConfig`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | JSON Schema（`$schema`）                                                                                                                                                                                                                                                                                    | `$schema`を設定の先頭に書く                                                                                                                                                                                               |
| 3   | `compilers: (def) => [...]`とコンパイラのプラグイン契約                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 組み込み。コンパイラの種類は`pages` / `styles` / `scripts`の 3 つ                                                                                                                                                                                                                                           | セクションに書き直す                                                                                                                                                                                                      |
| 4   | Pug（`.pug`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 廃止                                                                                                                                                                                                                                                                                                        | Pug → JSX の移行手順書                                                                                                                                                                                                    |
| 5   | React による JSX 描画                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | kamado 独自の静的 JSX                                                                                                                                                                                                                                                                                       | hooks（`useState`等）と Context を使っていたら書き直す。`external` / `jsxImportSource`は廃止                                                                                                                              |
| 6   | `compileHooks`（main / layout の before / compiler / after）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 廃止                                                                                                                                                                                                                                                                                                        | JSX のコンポーネントで書く                                                                                                                                                                                                |
| 7   | `transforms`配列（独自 transform を含む）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `html.*`の宣言的オプション                                                                                                                                                                                                                                                                                  | §9 の対応表                                                                                                                                                                                                               |
| 8   | `manipulateDOM`の hook、`ctx.getHref` / `ctx.baseURL`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `html.rules`                                                                                                                                                                                                                                                                                                | §9                                                                                                                                                                                                                        |
| 9   | `injectToHead`の関数、`devServer.transforms`（関数）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `html.inject`（`mode: serve`を含む）                                                                                                                                                                                                                                                                        | §9                                                                                                                                                                                                                        |
| 10  | `nav`の`filter` / `comparator`、`filterNavigationNode` / `navigationComparator` / `transformBreadcrumbItem`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | JSX 側で配列を加工                                                                                                                                                                                                                                                                                          | §7.3                                                                                                                                                                                                                      |
| 11  | `pageList(fn)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `pages.overrides`（外部 JSON）                                                                                                                                                                                                                                                                              | 関数の結果を prebuild で JSON に書き出す                                                                                                                                                                                  |
| 12  | `globalData`の`.js`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 廃止。`.json` / `.yml` / `.yaml`、文字列として読む`.html` / `.txt`のみ                                                                                                                                                                                                                                      | prebuild で JSON を生成する                                                                                                                                                                                               |
| 13  | `onBeforeBuild` / `onAfterBuild`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 廃止                                                                                                                                                                                                                                                                                                        | npm scripts の prebuild / postbuild + `build.report` + 組み込み sitemap                                                                                                                                                   |
| 14  | `layouts.files`（オブジェクトで直接指定）、`contentVariableName`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `layouts.dir`のみ。`content` prop 固定                                                                                                                                                                                                                                                                      | —                                                                                                                                                                                                                         |
| 15  | prettier 設定の自動読み込み（入力パスで幅が変わる）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `html.format`で指定。幅は持たない（折り返さない）                                                                                                                                                                                                                                                           | `printWidth`は廃止（書くとエラー）。v2 で幅 90 だった出力は折り返しの位置が一致しない                                                                                                                                     |
| 16  | postcss（postcss.config のプラグイン、cssnano）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Rust 自作の CSS 処理。ユーザーのプラグインは非対応                                                                                                                                                                                                                                                          | autoprefixer 等が必要なら npm scripts で別に処理する                                                                                                                                                                      |
| 17  | `banner`に関数（`CreateBanner`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 文字列＋プレースホルダ                                                                                                                                                                                                                                                                                      | §8                                                                                                                                                                                                                        |
| 18  | `devServer.proxy.pathRewrite`が関数                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `rewrite: {from, to}`（正規表現）                                                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                         |
| 19  | YAML の日付は front matter だけ`Date`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | すべて文字列                                                                                                                                                                                                                                                                                                | `formatDate()`に文字列を渡す                                                                                                                                                                                              |
| 20  | `.yaml`のデータは無視                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `.yaml`も読む                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                         |
| 21  | 本文中の`<?php ... ?>`が linkedom により**削除**される                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 処理命令のトークンとして**保持**する                                                                                                                                                                                                                                                                        | v2 のデータ損失を再現しない                                                                                                                                                                                               |
| 22  | `@kamado-io/*`の 6 パッケージ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `kamado` 1 つ（ネイティブのコアは全プラットフォーム分を同梱する。§18）                                                                                                                                                                                                                                      | import の指定を変える                                                                                                                                                                                                     |
| 23  | `kamado/compiler` `kamado/data` `kamado/files` `kamado/path` `kamado/utils/dom`等の内部 export                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 廃止。プログラム API は`build()` / `start()` / `pages()` / `ui()`のみ                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                         |
| 24  | Windows ネイティブ                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 非対応（WSL2 は対応）                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                         |
| 25  | リクエストごとの再コンパイル（開発サーバー）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 依存の stat による再利用                                                                                                                                                                                                                                                                                    | 挙動は同じ（結果は新しい）                                                                                                                                                                                                |
| 26  | `enum` / `namespace`等を含む TS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `.tsx`ページでは非対応（erasable な構文のみ）                                                                                                                                                                                                                                                               | `const`オブジェクトに置き換える                                                                                                                                                                                           |
| 27  | `<title>`の中身は、文字参照を展開したうえで**エスケープせずに**出力される。`&amp;copy`は`&copy`になり、ブラウザでは © と読まれる。`&lt;/title&gt;`は`</title>`になり、`<title>`が早く閉じて以降がマークアップになる（タイトルに外部データが入るサイトでは注入になる）                                                                                                                                                                                                                                                                                                                                 | v2 と同じ形で出力する（`A &amp; B`は`A & B`）が、展開すると意味が変わる`&amp;`（後ろの文字と文字参照を作る）と`&lt;`（`</title`が続く）だけは展開せずそのまま残す                                                                                                                                           | 影響は上の 2 つの並びを含むタイトルだけ                                                                                                                                                                                   |
| 28  | `<script>`の開始タグの属性値に`><`を含むと本文が壊れる（linkedom の文字列分割）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 再現しない（本文は常に生テキストとして出力）                                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                         |
| 29  | `characterEntities`が出力全体（`<script>` `<style>`の中身、コメントを含む）の非 ASCII を置換する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | テキスト・属性値・コメント・`<title>` / `<textarea>` / `<xmp>`だけ。`<script>` `<style>`の中身は変更しない                                                                                                                                                                                                  | v2 の出力は JS / CSS の文字列を壊していた                                                                                                                                                                                 |
| 30  | 断片（`<html>` / `<!doctype`で始まらない本文）の途中に`<!doctype>`があると、linkedom が doctype 以外の内容を**落とす**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 内容を落とさない（doctype は先頭に出力する）                                                                                                                                                                                                                                                                | v2 のデータ損失を再現しない                                                                                                                                                                                               |
| 31  | `imageSizes`が壊れた画像で匿名のパーサエラーを出す                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | エラーメッセージに画像のパスを含める。`keepAuthored: true`で手書きの`width` / `height`を残せる                                                                                                                                                                                                              | —                                                                                                                                                                                                                         |
| 32  | `<script>` / `<style>`の中身を prettier が整形し、そのあと minify が有効なら圧縮で置き換える                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 中身は整形しない。minify が有効なら圧縮される（出力は v2 と同じ傾向）。`minify: false`、`minify.js: false`、esbuild が見つからないときは、書かれたまま出る                                                                                                                                                  | 整形済みの出力が要るなら、ソースの JS を整形して書く                                                                                                                                                                      |
| 33  | 先頭の`<?xml ... ?>`を linkedom が**削除**する                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 先頭の`<?xml ?>`は保持して出力の先頭に置く（#21 と同じ理由）。その後ろが`<html`か`<!doctype`なら、`<?xml ?>`がないときと同じく文書として扱い、doctype 規則も働く（`<?xml ?>`、`<!DOCTYPE html>`、`<html>`の順）                                                                                             | 描画モードは移行前と同じ（標準モード）。XHTML の doctype も`<!DOCTYPE html>`に正規化される                                                                                                                                |
| 34  | `outputPathField`が指す出力が`.html`以外の拡張子（`.htm`など）のとき、v2 は出力の拡張子でコンパイラを選ぶので、ページとして処理せず、front matter 付きの入力をそのまま書く                                                                                                                                                                                                                                                                                                                                                                                                                            | 拡張子によらずページとして処理する。front matter を除き、整形・圧縮・doctype の規則が働く                                                                                                                                                                                                                   | v2 の出力にあった front matter が消え、HTML として整形される（出力が変わる）                                                                                                                                              |
| 35  | 大文字で書かれた属性名（`CLASS`、`DATA-X`）を linkedom は大文字のまま持ち、`getAttribute` / `removeAttribute` / セレクタ（`[data-x]` `.c`）に見えない。`setAttribute` / `classList.add`は、小文字の 2 つ目の属性を足す（ブラウザは先頭の属性だけを使うので、元の`class`が効かなくなる）                                                                                                                                                                                                                                                                                                               | 属性名は大文字小文字を区別せず照合する。`<p CLASS=c>`への`addClass`は、その`CLASS`に書き足す（2 つ目の`class`を足さない）                                                                                                                                                                                   | 大文字の属性名を持つページで、`setAttr` / `addClass`などの出力が変わる                                                                                                                                                    |
| 36  | `@import`の展開（postcss-import）が、`layer()`が 2 段以上ある取り込みの中の外部 URL の`@import`を`b.a`の順に書き、先頭へ上げた`@layer`の文と外部 URL の`@import`が、取り込んだ内容（`@layer`のブロックと文を含む）より先にレイヤーを宣言して順を変え、隣り合う無名の`@layer`ブロックを 1 つにまとめる。取り込みのあとの`@import`を黙って捨てる                                                                                                                                                                                                                                                        | `layer(a)`の中の`layer(b)`は`a.b`の順に書き、宣言の順がソースの順と変わるときは`@layer name;`を書き足し、無名の`@layer`は別のレイヤーのままにする。捨てた`@import`は`kamado build`の要約に警告する（§10）                                                                                                   | 案件の CSS が`layer()`の入れ子、取り込みと`@layer`の文・外部 URL の`@import`・取り込んだファイルの`@layer`の組み合わせ、無名の`layer`を使っていなければ出力は同じ。使っているときは出力の差を`MIGRATION.md` §6 で確かめる |
| 37  | `@custom-media`の展開（postcss-custom-media）が、(1) 循環する定義のうち循環ごとに 1 つの名前だけを未定義にし、残りの名前を展開する (2) `not screen and (a)`の定義を否定すると`screen, (a)`（どちらかに一致）になる (3) 同じ名前の定義が別々の`@layer`にあると、優先度の高いレイヤーの定義を使う (4) 定義を消して空になった`@layer x {}`も消す（レイヤー `x`の順序が変わりうる） (5) 定義の中の`var(--x)`のような関数の引数も参照に数え、循環とみなす (6) `--`だけの名前も定義する (7) 一致しない定義（不正なクエリ、`foo(x)`のような関数を含むもの）の否定を、定義のまま書く（`not (--x)`が効かない） | Media Queries 5 §10 に従う。(1) 循環に含まれる定義はすべて未定義（参照は書いたまま残る）(2) 否定は`screen and (a)` (3) レイヤーによらず、最後に書いた定義を使う (4) 空の`@layer x {}`は残す (5) 関数の引数は参照ではない (6) `--`は CSS Values 4 が予約する名前なので定義しない (7) 否定は常に一致する`all` | 循環する定義、`not <media type> and ...`の定義を、ほかの条件と並べるか`not`の後や括弧の中で使うこと、別々のレイヤーでの同じ名前の定義、定義だけを書いた`@layer`ブロックがなければ出力は同じ                               |
| 38  | 開発サーバーが任意の`Host`と別サイトからの要求に応える                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | ホスト名の検査（`localhost`・IP・`devServer.host`・`devServer.allowedHosts`以外は`403`）とクロスサイトの検査（§12）                                                                                                                                                                                         | `localhost`以外の名前で開くなら`devServer.allowedHosts`に足す                                                                                                                                                             |
| 39  | 開発サーバーの`devServer.host: "localhost"`は、OS が最初に返す loopback のアドレス（macOS では`::1`）だけで待ち受ける。`http://127.0.0.1:<port>/`に繋がらず、空いたほうのアドレスの同じポートを別のプロセスが取れる                                                                                                                                                                                                                                                                                                                                                                                   | `127.0.0.1`と`::1`の両方で待ち受ける（§12）                                                                                                                                                                                                                                                                 | どちらかのアドレスで同じポートを別のツールが使っていると起動しない（`port <port> is already in use on <アドレス> (devServer.port)`）。そのツールを止めるか`devServer.port`を変える                                        |
| 40  | `kamado build <globs>`に渡した、無いファイル・ディレクトリ・何にも当たらない glob は、黙って何もビルドしない                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 無いファイルはエラー（exit 1）、ディレクトリはその中のすべて、何も選ばなかったものは警告（§13）                                                                                                                                                                                                             | 無いファイルのパスを直す                                                                                                                                                                                                  |
| 41  | `pageList`を設定していないと、`breadcrumbs`と`titleList()`のタイトルは`__NO_TITLE__`（ページ一覧`pageAssetFiles`はメタを持たないため。front matter や sidecar に`title`があっても出ない）                                                                                                                                                                                                                                                                                                                                                                                                             | ページのメタ（front matter・sidecar・`pages.overrides`のマージ後）の`title`を出す。タイトルが無いときだけ`__NO_TITLE__`（§7.3）                                                                                                                                                                             | 不要。`__NO_TITLE__`に頼った出力があれば、v2 の基準との差になる（MIGRATION §11）                                                                                                                                          |

## 3. 設定（`kamado.config.jsonc`）

JSONC（`//`と`/* */`のコメント、末尾カンマ可）。`$schema`で補完。相対パスは設定ファイルのディレクトリ基準（設定を別のファイルから取り込む仕組みを足すときも、パスはそれが書かれたファイルの基準で解決する）。未知のキーは**エラー**（タイプミスの黙殺を防ぐ）。

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
		"encoding": "utf8", // "utf8" | "shift_jis"（§9.5）
		"serializer": "linkedom", // "linkedom" | "spec"（§9.6）
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
		"allowedHosts": [],
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

### 3.1 `pages.files`の空配列と、`scripts.files`との重複

`pages.files`が`[]`なら、ページは 1 件も無い（`.html`も`.tsx`も処理せず、`styles`と`scripts`だけがビルドされる）。v2 で`createPageCompiler`を使わず、CSS/JS だけを出していた設定の書き方。

`pages.files`が`.tsx`を含み、`scripts.files`も`.tsx`を含むと、同じ入力が二重に処理される。**v3 は`scripts.files`から`pages.files`に一致するものを除外**する（ページが優先）。クライアント側の`.tsx`を`scripts`で扱う場合は、`pages.files`の範囲を狭める。

## 4. メタデータ

供給源は 4 系統。**優先順位は高い順に、`pages.overrides`、sidecar `.json`、ファイル内（`export const meta`または YAML front matter）**。同じキーはオブジェクトを再帰的にマージせず、上位が丸ごと置き換える。

- **TSX**: `export const meta = { ... }`。**リテラルのみ**（文字列、数値、真偽値、null、配列、オブジェクト、テンプレートリテラル（式なし））。`as const`と`satisfies T`は許可する（型注釈の除去と同じ扱い）。式、変数参照、スプレッド、関数呼び出しは**ビルドエラー**（行と列を示す）。Rust が JS を実行せずに抽出する。
- **HTML**: 先頭の YAML front matter（`---`で囲む。gray-matter と同じ規則: 先頭 0 バイト目（BOM 可）から、閉じは`---`の行、1 つの改行を除去、空は`{}`）。
- **sidecar**: 同じディレクトリ・同じ名前の`.json`（`page.tsx`に対して`page.json`）。存在しなくてよい。不正な JSON はエラー。
- **`pages.overrides`**: §6。

YAML のサブセット: ブロック/フローのマップとシーケンス、プレーン/シングル/ダブルクォートのスカラー、`|`と`>`（chomping と indent 指示子）、コメント、アンカーとエイリアス、`<<`のマージ。YAML 1.2 の core スキーマ。**日付は文字列のまま**。タグ（`!foo`）、複雑なキー（`?`）、複数ドキュメントはエラー。

## 5. ページとファイル

- 出力パス: 入力ディレクトリの構造を鏡写しにし、拡張子を`outputExtension`に差し替える（v2 と同じ）。
- `page`（テンプレートに渡すファイル情報）は v2 の`CompilableFile`と同じ形: `inputPath` `outputPath`（絶対）、`fileSlug`（拡張子なしのファイル名。`index`なら親ディレクトリ名）、`filePathStem`（`/`始まり、POSIX、拡張子なし）、`url`、`extension`（小文字）、`date`（ファイルオブジェクトを作った時刻）。
- `outputPathField`/`outputPathConflict`: v2 と同じ規則（ただし、`.html`以外の拡張子の出力もページとして処理する。§2 の #34）。値は`/`で始まる。`.`と`..`のセグメントは拒否。`/a/b.ext`はそのまま、`/a/b`は`outputExtension`を補う、`/a/b/`は`index<outputExtension>`。出力ディレクトリの外は拒否。衝突は front matter 指定が優先し、同列なら先勝ち。`warning`が既定。
- glob: `**` `*` `?` `[abc]` `[!a]` `{a,b}`（入れ子可。ただし、展開した結果は 1000 パターンまでで、入れ子と連続を合わせて 32 グループまで。超えるとエラー。`{a,b}`を並べると 2^N に増えて、メモリと、ファイルごとの照合の時間を使い切るため）`\`エスケープ、先頭`!`の否定は**設定ではエラー**（除外は`ignore`/`exclude`で書く。適用されないまま黙って無視されるのを防ぐ）。大文字小文字を区別、`/`区切り、`dot: false`（`.`で始まるセグメントは、パターンに`.`が明示されたときだけ一致）。拡張グロブ（`@(...)`等）はエラー。走査結果は**辞書順にソート**する（v2 は fs 依存）。
- 出力が入力を上書きしないための規則: `dir.output`は`dir.input`と異なる。出力ディレクトリが入力ディレクトリの内側にあるとき（`input: "."`、`output: "htdocs"`）、その中のファイルはページとして探索しない。ページの出力先が別の入力ファイルのパスと一致する場合（`outputPathField`の指定による）はビルドエラーにする。
- 探索では、`ignore`に`dir/**`の形で書いたディレクトリには入らない（`node_modules`のような大きなツリーを走査しない）。この場合、`.`で始まるエントリも含めて、そのディレクトリ全体が除外される。
- 古い出力は削除しない（v2 と同じ）。
- 出力に対応する入力がないファイルは、開発サーバーでは出力ディレクトリから静的に配信する（v2 と同じ）。ただし`.html`/`.htm`には、当たる`html.inject`があれば入れて返す（§9.3）。

## 6. `pages.overrides`

`pages.overrides`は JSON ファイルへのパス。仮想ページ・並び順・メタの上書きを書く、サイト構成のソース。手で書いても、prebuild が外部のデータ（スプレッドシート等）から作っても、`kamado ui`（§14.2）が書いてもよい。prebuild が作り直す運用では、元のデータが正で、ほかが書いた分は次の prebuild で消える。

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

- `url`が既存ページに一致すれば`meta`を上書き、一致しなければ`virtual: true`が必要（なければエラー）。
- `url`は、ページの URL と同じ書き方にする。`index.html`は`/dir/`、ファイルは出力の拡張子付き（`/a.html`。`outputExtension: ""`なら`/a`）。`?`と`#`、空のセグメント（`//`）、`.`/`..`のセグメントを含む`url`は設定エラー。それ以外で、そのまま読むと別の URL のページになる書き方（`/a/index.html`、`/a`）も、正規化せずに設定エラーにする（エラーには、読んだ場合の URL を出す）。書き方の違うエントリを同じページとして読むと、並び順や重複の判定が、書いた文字列とずれるため。%符号化は解かない（`%20`は、ファイル名の文字どおりの`%20`）ので、ファイル名のとおりに書く。
- 仮想ページは出力しない。`pages`/`nav()`/`breadcrumbs`/`titleList()`のインデックスにだけ加わる。
- **並び順**: ファイルに書いたページ（既存・仮想とも）が、書いた順で`pages`の先頭に並び、書かなかったページが（辞書順のまま）その後に続く。`nav()`は並べ替えをしないので、この順がナビゲーションの表示順になる（v2 の`pageList()`の返り値の順）。
- ファイルが存在しない・不正な JSON はビルドエラー。`version`が未知なら拒否。

## 7. JSX

### 7.1 コンパイルモデル

TSX を Rust が「HTML 文字列を返す JS」にコンパイルする。コンパイル後の JS は Node のワーカーが読み込んで実行する。**React・仮想 DOM は使わない**。

- 要素は文字列の連結になる。静的な部分木はモジュールの定数に巻き上げる。
- 式の値の描画: 文字列・数値は**エスケープ**して出す。コンポーネントの戻り値（ランタイムの`Markup`クラス。文字列のラッパー）はそのまま出す。配列は平坦化して連結する。`null`/`undefined`/`false`/`true`は出さない。`0`は`"0"`。
- 属性: `className` → `class`、`htmlFor` → `for`、`style`はオブジェクト → `prop: value;`形式（ケバブケース、数値には React と同じ unitless の表に従い`px`を付ける）、真偽値は属性の有無、`null`/`undefined`/`false`は出さない、`dangerouslySetInnerHTML={{ __html }}`は生で出す。`key`と`ref`は無視する。関数値（`onClick`等）は**警告して無視**する。
- 空要素（`br` `img` `input` `meta` `link` `hr`等）は閉じタグを出さない。`<script>`と`<style>`の子はエスケープしない。
- JSX の空白の規則は React/TypeScript の`jsx`変換と同じ（行頭行末の空白と改行の除去、空行の除去、`{" "}`で明示）。
- **React との意図した違い**: ①`<html static>`の中でだけ、属性`on*`の**文字列**をそのまま属性として出す（React は全部捨てる。テンプレートから移した静的なページは`onclick="..."`を持つ）。関数と、static でない描画では捨てる。②`<html static>`（または、`<html>`を持たないページの`meta.kdStatic: true`）は、テンプレートの書いた順を保つモード。`<head>`の`title`/`meta`/`link`/`script`を持ち上げず（`<head hoist={false}>`ならこれだけ）、`form`/`input`/`button`の属性を書いた順で出し、`option`の`selected`も書いた位置に出す（React は属性の最後。囲む`select`に`value`/`defaultValue`があれば、どちらのモードでも`select`が選ぶ`option`を決め、`selected`は最後に 1 つ）。`html`と`head`の子はこの目的で遅延評価（thunk）にコンパイルされる。③`styleOf(text)`（`kamado/jsx`が公開する、ユーザー向けの名前。もう 1 つは`html(text)`）は CSS 文字列を`style`のオブジェクトにする。
- **描画結果の文字列は、そのまま出力されず、Rust の HTML 後処理（再パース → 融合印字）を通る**。したがって、エスケープの細かい形（`&#x27;`と`&#39;`など）は後処理で正規化され、出力に影響しない。

**コンパイル結果の置き場**: `build`は、ページ（TSX）を 1 ファイル 1 モジュールとして書き出さず、**連続する 64 ページを 1 つの「チャンク」ファイル（`node_modules/.cache/kamado/jsx/__chunks__/<hash>.mjs`）の関数**にまとめる。チャンクは runtime とページが import するモジュールを 1 回だけ import し、`pages[i]()`がそのページの export（`default`）を返す。ページが import するコンポーネントやレイアウトは、従来どおり 1 モジュール 1 ファイルで、全ページで共有する。

- なぜ: ファイルの作成と Node の`import()`は、ページ数が数万になるとビルドの大半を占める。`import()`はファイルを開いて解決しリンクする。開発に使っている macOS では`open`が 70〜200µs かかる。チャンクにすると、ページを読み込む CPU 時間は 1 ページあたり約 440µs から約 30µs になる（20000 ページのフルビルドで 9s から 7s）。HTML の出力は、チャンクにしても 20013 ファイルがバイト一致する（その後、描画結果をバッチごとに`feed`で渡すようにして 6.2s）。
- 副作用: チャンクはページが import するモジュールを先頭でまとめて import するので、同じチャンクのどれかのページの import が失敗すると、チャンクの全ページが失敗し、エラーは最初にチャンクを読んだページの名前で出る（壊れたページとは限らない）。前回のチャンクは「今回使わないもの」をすべて消す。コンパイル結果の置き場は`build.cacheDir`に関係なく**常に`<プロジェクトのルート>/node_modules/.cache/kamado/jsx`**（`node_modules`を辿ってパッケージを解決させるため、プロジェクトの中に置く）なので、同じプロジェクトで 2 つのビルド（開発サーバーを含む）を同時に走らせると互いのファイルを消し合って壊れる。また`node_modules`に書き込めなければ、JSX ページのビルドはできない。ページが別のモジュールから import されている場合、そのページは関数とモジュールの 2 つの実体になる。
- 取り込みの意味: `import { a } from "m"`は、チャンクが取り込んだ`m`の名前空間から`const { a } = ...`で取り出す（ESM の巻き上げと同じく、ページの先頭で）。ページの`export default`は関数の`default`、それ以外の`export`は捨てる（ホストは読まない。宣言したものはローカルに残る）。
- チャンクにできないページ（`export * from`/`export { a } from`の再 export、`import.meta`、副作用だけの`import "x"`、hashbang）は、従来どおり 1 ファイルのモジュールとして書き出す。ページが別のモジュールから import されている場合も、そのページはモジュールとして書き出す。
- 開発サーバーはチャンクを使わない（1 ページずつ、モジュールのファイルから描画する）。環境変数`KD_PAGE_CHUNKS=0`で`build`でも使わなくなる（出力の比較用）。
- チャンクのファイル名は内容のハッシュで、今回のビルドが使わなかった前回のチャンクは削除する（変更したページだけを描画する差分ビルドは、そのページだけを別のチャンクにする）。

### 7.2 コンポーネントと型

- 型定義（`PageProps`などの`.d.ts`）は同梱しない。コンポーネントの props の型は、使う側が宣言する（`jsx`の型は`@types/react`など、使うプロジェクトが持つもので足りる）。`tsconfig.json`は`"jsx": "preserve"`にする。例外は`html()`の戻り値の型`HtmlChild`だけで、`@types/react`が子として受け付けるように、`ReactElement`と同じ形で宣言してある（値は`Markup`で、中身は読めない）。
- hooks（`useState`など）、Context、`Suspense`は**非対応**。コンポーネントは**純粋関数**（同じ props なら同じ出力、モジュールの変数を書き換えない）。ワーカーが並列に描画するので、この契約を破ると結果が不定になる。
- `import`できるもの: 相対パスと`pages.alias`で指定した別名の TSX/TS/JSON、npm パッケージ（Node が解決し、ESM のみ）。CSS の import は非対応。

### 7.3 ページとレイアウトに渡されるもの

ページのコンポーネントは`props`として次を受け取る。

| 名前                        | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `page`                      | §5 の`page`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `meta`                      | このページのメタ（§4 のマージ後）                                                                                                                                                                                                                                                                                                                                                                                                   |
| `site`                      | `site.*`                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `data`                      | `data.dir`と`data.values`をマージしたオブジェクト（ファイル名がキー）                                                                                                                                                                                                                                                                                                                                                               |
| `pages`                     | 全ページの一覧（`page`と`meta`）。ワーカーに 1 回渡した配列を、そのワーカーのすべてのページが共有する（ページごとにはコピーしない。Rust のインデックスを引くアクセサではない）                                                                                                                                                                                                                                                      |
| `nav(options?)`             | v2 と同じ。`{ ignoreGlobs, baseDepth }`。ツリーのノードは`{ page, meta, children }`。絞り込みと並べ替えは、返ってきた配列を JSX 側で加工する                                                                                                                                                                                                                                                                                        |
| `breadcrumbs`               | v2 と同じ（ただし v2 で`pageList`が無いと、タイトルはメタを持たない一覧から取るので`__NO_TITLE__`になった。v3 はページのメタのタイトル。§2 #41）。祖先の`index`ページとページ自身。`{ title, href, depth, meta }`。タイトルがなければ`__NO_TITLE__`。起点は`site.baseURL`の**パス部分**（`https://example.com/sub/`なら`/sub/`）で、それより浅い階層は含めない（v2 は値をそのまま数えたので、フル URL を書くと上位 2 階層が欠けた） |
| `titleList(options?)`       | v2 と同じ（ただし v2 で`pageList`が無いと、各タイトルは`__NO_TITLE__`になった。v3 はページのメタのタイトル。§2 #41）。`{ separator, baseURL, prefix, suffix, fallback }`。トップ（`baseURL`と`/`）は除き、残りが無ければ`fallback`、最後に`suffix`を区切りなしで付ける（トップは既定で`SITESITE`、`suffix: ''`で`SITE`）。`prefix` / `suffix`は trim する                                                                           |
| `formatDate(value, format)` | dayjs のトークンのサブセット（`YYYY YY M MM MMM MMMM D DD d dd ddd dddd H HH h hh m mm s ss SSS A a Z ZZ X x`、`[…]`でエスケープ、英語、ローカルのタイムゾーン）。`value`は文字列・数値・Date                                                                                                                                                                                                                                       |

レイアウトは追加で`content`（ページの描画結果。エスケープ済みの HTML として印字されるので、`{content}`、`dangerouslySetInnerHTML={{ __html: content }}`、`html(content)`のどれでも二重にエスケープされない）を受け取る。`meta.layout`に`layouts.dir`内のファイル名（拡張子なし）を書く。`.html`ページはこれがレイアウトを使う唯一の手段。JSX ページは`<Layout>`を直接合成してもよい。存在しないレイアウト名はエラー。

差分ビルドは、全ページの URL とメタのダイジェストを JSX ページの環境に含める。`pages`/`nav`/`breadcrumbs`/`titleList`がどのフィールドを読んだかは記録しないので、**どのページのメタが変わっても、JSX で描画する全ページが再ビルドされる**（`.html`ページは影響を受けない）。フィールド単位の追跡は行わない（読んだフィールドの記録は、アクセサ化とあわせて入れるまで持たない）。

## 8. バナー

`styles.banner`/`scripts.banner`は文字列。`{{date:FORMAT}}`（`formatDate`と同じトークン）、`{{year}}`、`{{version}}`（package.json の version）が使える。既定は`rev. YYYY-MM-DD`と`copyright © YYYY`を含むコメント、`"" `で無効。開発サーバーでは、日本語の「開発中・編集不可」の注意書きに置き換わる（v2 と同じ）。CSS は`/*! */`形式にして、圧縮後も残す。

## 9. HTML 後処理

パイプラインの順序（1 回のパースと 1 回の印字）:

1. 描画結果（または`.html`の本文）を、レイアウトと合成する
2. パース（`<?...?>`は処理命令として保持する）
3. `html.includes`（取り込み。再帰）
4. `html.rules`（宣言的な DOM 操作）
5. `html.inject`
6. `imageSizes`
7. 印字（`doctype`、`format`、`minify`、`entities`、`lineBreak`）。`minify`のうち、属性の整理と値の整形、`<script>`/`<style>`の中身の圧縮は、整形した文字列を読み直さず、シリアライズの前の木（画像寸法のあと）の上で行う。`minify`が有効なとき、整形はタグを詰めて書く。属性は 1 行に並べ、持ち越した`>`の前では折らない。void 要素に` /`は付けない（svg と math の要素は残す）。`basefont`・`frame`・`isindex`には閉じタグを書かない（v2 の minify が空要素として読み直して捨てたもの。`minify: false`では書く。IE の条件付きコメントの中は v2 も読まないので書く。整形が失敗してそのまま出るページと、整形が写す原文（子を持つ`<pre>`の中、`prettier-ignore`の次の要素）からも落とす。`<script>` `<style>`の中とコメントは読まない）。圧縮した`<script>`/`<style>`の中身は、字下げせずにタグの間に書く。IE の条件付きコメントの中は、この詰め方をしない。DOM を戻す書き方は`serializer`、書き出すバイト列の文字コードは`encoding`（§9.5、§9.6）。`<style>`と`style`属性の CSS は Rust の CSS 圧縮、`<script>`は esbuild（子プロセス、内容のハッシュでキャッシュ）
8. 書き出し

`<script type="application/ld+json">`（`importmap`、`speculationrules`、`json`で終わる type も同じ）の中身は、v2 と同じく prettier の JSON 整形がそのまま出力に残る（オブジェクトは`{ "a": 1 }`の 1 行、`{`の直後で改行されていれば展開、複数のオブジェクトを持つ配列は展開、数値は`1.50` → `1.5`、文字列は二重引用符、末尾カンマなし）。コメントを含む JSON と JSON として読めない中身は整形せず、書かれたまま出す（prettier も後者はそのまま出す）。

`html.overrides`は、`pages`の glob（出力 URL に対して）に一致するページ（と、開発サーバーが`html.inject`を当てる静的な HTML。§9.3）に限り、`html`の任意のオプションを上書きする。上書きするのは、そのエントリが**書いたオプションだけ**で（`rules`を書けば`rules`全体が置き換わる）、書かなかったオプションは`html`の値のまま。一致するエントリが複数あれば、書かれた順に適用する。たとえば整形と圧縮を切る、`imageSizes`を切る、といった使い方ができる。エントリの中に`overrides`は書けない。

**ステージの失敗と`html.onError`**: 手順 2〜6（パース・取り込み・ルール・inject・画像）は 1 つの「DOM ステージ」で、`doctype`、`format`、`minify`はそれぞれ別のステージ。v2 の`formatOptions.parseError`と同じく、ステージが失敗したとき`silent`（既定）は何も報告せずそのステージを飛ばして直前の文字列を次のステージに渡し、`warning`は警告を出して同じく飛ばし、`error`はそのページのビルドを失敗にする。DOM ステージの失敗（たとえば取り込みの path traversal）で、ルールや inject も一緒に飛ばされるので、CI では`warning`か`error`にする。`minify`は木の上で行うので DOM ステージの中で動くが、失敗は`minify`として報告する。DOM ステージが失敗して飛ばされたページは、`minify`も行わない。`minify`はパースの失敗でページ全体を諦めることがない（v2 の minify は壊れたマークアップで投げ、そのページは圧縮されなかった）。`minify`の中で CSS/JS の 1 か所が圧縮できなかったとき（esbuild が読めない JS、esbuild が起動できない・途中で落ちた、`kd_css`が諦めた CSS）は、ステージを飛ばさず、その箇所だけを元のまま残して残りを圧縮する。`html.onError`は、その報告だけを決める（`silent`は何も言わない、`warning`は箇所と理由を警告、`error`はページの失敗）。警告はそのビルドで組み立てたページ分だけ出る（差分ビルドで`cached`になったページの警告は再掲されない）。

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

`pages`/`exclude`は glob（出力 URL に対して）。`selector`は CSS セレクタ（タイプ、`*`、`#id`、`.class`、属性セレクタ全種と`i`フラグ、結合子` ` `>` `+` `~`、`:not` `:is` `:where` `:has`、`:first-child` `:last-child` `:only-child` `:nth-child(an+b)` `:nth-last-child` `:nth-of-type` `:first-of-type` `:last-of-type` `:empty` `:root`。未対応はエラー）。

| action                     | 追加のキー                                                                                            | 動作                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `remove`                   | —                                                                                                     | 要素を削除                                                                                |
| `unwrap`                   | —                                                                                                     | 要素を外して子を残す                                                                      |
| `wrap`                     | `html`                                                                                                | `html`（`{{content}}`を含む）で包む                                                       |
| `setAttr`                  | `name`, `value`                                                                                       | 属性を設定。`value`は文字列、`{{attr:href}}` `{{url}}` `{{baseURL}}`が使える              |
| `removeAttr`               | `name`（文字列または`/regex/`）                                                                       | 属性を削除                                                                                |
| `addClass` / `removeClass` | `value`                                                                                               | クラスを追加 / 削除                                                                       |
| `insert`                   | `position`（`before` `after` `prepend` `append`）, `html`                                             | HTML を挿入                                                                               |
| `rewriteUrl`               | `to`（`absolute` / `rootRelative`）, `origin`, `attrs`（既定`href` `src` `srcset` `poster` `action`） | URL を書き換える。危険なスキーム（`javascript:` `data:` `vbscript:` `file:`）は変更しない |

属性の操作とセレクタは、HTML 文書の DOM（v2 の`manipulateDOM`で使った`setAttribute`/`removeAttribute`/`classList`）と同じに扱う。属性名の照合（`setAttr`、`removeAttr`の文字列、`rewriteUrl`の`attrs`、`{{attr:NAME}}`、セレクタの`[name]` `#id` `.class`）は大文字小文字を区別しない（`data-x`は`DATA-X`と書かれた属性も指す。`removeAttr`の`/regex/`は、書かれた名前に対する正規表現）。書き換えた属性は、書かれた名前のまま残る（`DATA-X`に`data-x`を設定しても`DATA-X`のまま）。無い属性は要素の**先頭**に入り（あとから足したものほど前）、ある属性は位置を保つ。`addClass`/`removeClass`と、セレクタの`.class`/`[class~=x]`は、`class`を JavaScript の空白（U+00A0 などを含む）で分け、`addClass`/`removeClass`は空と重複を除いた列で書き戻す。最後の 1 つを消した`class`は出力に残らない。セレクタの属性値は、`i`フラグが無い限り完全一致で照合するが、HTML の仕様が大文字小文字を無視すると決めている属性（`type` `rel` `lang` `dir` `target` `method`など）は、無視して照合する（`[type=text]`は`type=TEXT`に一致する）。

条件は`selector`で表す。属性値による条件（例: 同じホストでない外部リンク）は`:not([href*='{{host}}'])`のように`{{host}}`（`site.host`）を使える。`site.host`が未設定のまま`{{host}}`を使うと、何にも一致しないルールになってしまうので、設定エラーにする。

### 9.2 `html.includes`

```jsonc
{ "preset": "ssi" }
{ "preset": "ssi", "dir": "/home/www/document_root/" }
{ "preset": "includeComment", "root": "_libs" }
{ "preset": "burgerEditorImport", "root": "." }
{ "selector": "[data-include]", "attr": "data-include", "root": "_libs", "pick": "section", "replace": "element" }
```

- 取り込んだファイルは、差分ビルドの依存として記録する（存在しないファイルも記録する）。
- パスの起点（`root`）の外に出るパス（`..`による脱出）はエラー（path traversal の防御）。起点の内側にとどまる`..`は許す。境界の判定はパスの文字列だけで行い、シンボリックリンクは解決しない（起点の内側にあるリンクは辿って読む。ページの書き手は信頼する前提）。`root`の相対パスは、設定ファイルのあるディレクトリ基準。
- `ssi`は出力ディレクトリのファイルを読む。取り込み先がこのビルドで作られるページなら、並列ビルドでは作られる前後のどちらを読むかが決まらない（v2 の並行ビルドも同じ）。取り込み先は、出力ディレクトリに先にあるものにする。
- 取り込み先のファイルの中の include も展開する。入れ子は 16 段まで、循環（自分自身を取り込む）はエラー。
- 取り込めない（読めない）ファイルの扱いは`html.onError`（`error`は失敗、`warning`は警告して空に、`silent`は空に）に従う。
- 汎用ルール（`selector`）: `attr`の値が取り込むファイルのパス（`/`始まりは`root`基準、それ以外は取り込み元のファイル基準）。`pick`は取り込んだファイルの中から使う部分（セレクタの最初の一致。省略すると全体）。`replace`は`element`（一致した要素を置き換える）か`children`（一致した要素の子を置き換える）。
- `preset: "ssi"`: `<!--#include virtual="..." -->`。起点は出力ディレクトリ（v2 と同じ）。`dir`を指定すると、本番サーバーのドキュメントルートを出力ディレクトリに対応づける（v2 の`dir`と同じ）。
- `preset: "includeComment"`: `<!-- @include(PATH) -->`。PATH が`<documentRoot>/`で始まれば入力ディレクトリ基準、`/`で始まれば`root`基準、それ以外は取り込み元のファイル基準。**取り込み先もパイプライン全体を通す**（取り込んだ先の include も再帰的に展開する。v2 は最初の 1 つしか展開しなかった）。取り込んだファイルは、末尾の改行も含めて、そのままコメントの位置に入る（空白だけのテキストも取り込み先に残る）。コメントを単独の行に書き、直後に別の要素が続く場所へ、末尾に改行のあるファイルを取り込むと、整形後の出力に空行が 1 行できる。出力に空行を入れたくないときは、取り込むファイルの末尾の改行を省く。ファイル全体を取り込む`ssi`と、`pick`を書かない`selector`も同じ。`pick`を書いた`selector`は、選んだ要素だけを取り込むので、ファイルの末尾の改行（要素の外）は入らない。
- `preset: "burgerEditorImport"`: `[data-bge-container] [data-bgi=import] bge-import`の`src`を読み、取り込んだファイルの**すべての** `[data-bge-container]`（文書順）で、外側の container を置き換える（v2 の`importBlock`と同じ。ただし container の中の container は、v2 はその外へ出して兄弟にするが、v3 はその中に残す）。`src`は`/`始まりで、`root`基準。相対パスはエラー。

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

`position`: `head-start`/`head-end`/`body-start`/`body-end`。`mode`: `build`/`serve`/`both`。挿入先にすでに同じマークアップがあれば、重複して挿入しない（内容で判定する。名前での識別はしない）。`<head>`/`<body>`のない断片には挿入しない。

**静的な HTML への挿入（開発サーバー）**: 開発サーバーは、出力ディレクトリにあって対応するページのない`.html`/`.htm`（拡張子は大文字小文字を区別しない）にも、`mode`が`serve`または`both`の`html.inject`を入れて返す（v2 の`devServer.transforms`が静的なファイルにも当たったのと同じ）。ビルドには関わらない。

- URL: 出力ディレクトリからのパスの先頭に`/`を付けたもの。ファイル名が`index<outputExtension>`のときだけ`/dir/`（`legacy/index.htm`は`/legacy/index.htm`）。`pages`/`exclude`の glob と`html.overrides`の`pages`は、この URL に照らす。
- 入れ方: 文字列の挿入。`head-start`/`body-start`は開始タグの直後に改行と挿入、`head-end`/`body-end`は終了タグの直前に挿入と改行（v2 の`injectToHead`と同じ）。`includes`、`rules`、`imageSizes`、`doctype`、`entities`、`serializer`、`lineBreak`、整形、圧縮は当てず、挿入した以外のバイトは変わらない。`html.onError`は関わらない（失敗する段がない）。
- タグの探し方: タグ名は ASCII の大文字小文字を区別しない。コメント、`<script>`、`<style>`、`<textarea>`の中身にあるタグは数えない。開始タグの`>`は、`=`の直後に開いた引用符の外のものを終わりとする（引用符のない値の途中の引用符は数えない）。最初の開始タグと、その後ろの最初の終了タグを使う。属性値や`<title>`などの中は見ないので、そこに書かれたタグらしい文字列も数える（v2 の置換と同じ）。**開始タグと終了タグの両方が書かれていない要素には入れない**（終了タグを省略した文書、`<head>`のない文書、断片）。ページは DOM がそれらを補うので入るが、静的な HTML は v2 と同じく入れない。
- 重複: 開始タグと終了タグの間の、書かれた文字列に挿入するマークアップがそのまま含まれていれば入れない（ページのように直列化して比べない。引用符や空白の書き方が違えば別のものとして入る）。コメントと`<script>`/`<style>`/`<textarea>`の中に書かれたものは、要素ではないので数えない。
- そのまま返すもの（挿入しない静的なファイルと同じ応答で、何も変わらない）: 当たる`html.inject`がないファイル、UTF-8 でないファイル（変換しない）、何も入らなかったファイル（上の 2 つに当たるもの）。
- 開発サーバーの応答の違い: 入れたファイルは、ストリームではなく本文として返るので、Range と`Content-Length`は付かず、`Content-Type`は常に`text/html; charset=utf-8`になる（入れなかった静的なファイルには`charset`を付けない。§12）。要求ごとの表示の種別は`file`でなく`page`になる。

### 9.4 `entities`と`imageSizes`

- `entities`: `"all"`は ASCII 以外を名前付き文字参照（小文字を優先）に。オブジェクトは指定した文字だけ。`<script>`/`<style>`の中は変更しない。
- `imageSizes`: `img`と`picture > source`に`width`/`height`を付ける（png/jpg/jpeg/webp/avif/svg）。出力ディレクトリ基準で解決し、外部 URL・`data:` URI・パスが出力ディレクトリを出るものは対象外。`exclude`は glob（ページ）、`keepAuthored: true`は手書きの値を残す。読んだ画像は依存として記録する。`width` → `height`の順に、無ければ要素の先頭に入れるので、寸法の無い画像は`height` `width`の順になる（v2 と同じ）。ある方は位置を保つ。

### 9.5 `html.encoding`

ページのバイト列の文字コード。`"utf8"`（既定）と`"shift_jis"`（別名`shift-jis` `sjis` `cp932` `windows-31j`。Windows の Shift_JIS = CP932）。ページごとに`html.overrides`の`pages`（出力 URL の glob）で変えられる。ビルドだけに効き、開発サーバーが作るページは UTF-8 で返す（出力ディレクトリの静的なファイルはそのまま返す。§12）。CSS と JS は常に UTF-8。

- 入力は UTF-8 のまま書く。印字のあと（`lineBreak`のあと）に、1 回だけ変換する。
- `<meta charset="utf-8">`（`utf8`、大文字小文字、閉じの`/`の有無は問わない）は`<meta charset="shift_jis">`に書き換える（d-zero/builder と同じ）。コメントの中と`<script>`の中身（JS の文字列等）にある`<meta>`は、タグではないので書き換えない。
- Shift_JIS にない文字は文字参照にする: 名前があれば名前（`©` → `&copy;`）、なければ番号（`〜` U+301C → `&#12316;`）。`<script>`と`<style>`の中は参照が文字として読まれるので`?`（`iconv-lite`と同じ）。中身は、同じ名前の閉じタグ（`</script>`等。`</scripts>`は含まない）までで、その中に書かれたもう一方の開始タグ（JS の文字列の中の`<style>`等）は、ブラウザと同じく文字として扱う。ほかの生テキスト要素（`<xmp>` `<iframe>` `<noembed>` `<noframes>`、`<plaintext>`は文書の終わりまで）の中も`?`にする。`<title>`と`<textarea>`の中は参照を読むので文字参照にし、そこに書かれたタグは文字として扱う。`<noscript>`は、それを表示するスクリプト無効のブラウザと同じく HTML として読む。コメントと、引用符で囲んだ属性値の中の`<script>`は、何も始めない（引用符は`=`の直後だけが値の始まりで、`data-x=don't`の`'`は文字）。`<svg>`と`<math>`の中の`<style>`と`<script>`は、ブラウザが参照を読むので文字参照にし、そこの CDATA セクション（`<![CDATA[` 〜 `]]>`）は読まないので`?`にする。統合点（SVG の`<foreignObject>` `<desc>` `<title>`、MathML の`<mi>` `<mo>` `<mn>` `<ms>` `<mtext>`と、`encoding`が HTML の`<annotation-xml>`）の中は HTML に戻り、`<p>`や`<div>`などの HTML のタグは`<svg>`と`<math>`を終える（HTML の構文解析と同じ）。`?`にした文字は、ビルドの警告に出る（JS の文字列や CSS の`content`が書いたものと変わるため。`html.onError`には依らず、常に出る。文字参照にした文字は、書いたとおりに読めるので警告しない）。警告は文字ごとに 1 件で、その文字を`?`にした最初のページ（`pages`の順）と残りのページ数を出す（`src/a.html and 119 more pages: Shift_JIS has no U+301C; …`）。layout の script の文字を、ページごとに繰り返し警告しないためで、別の文字を持つページがあっても同じ。ページ数は、そのビルドで組み立てたページの数で、差分ビルドで再ビルドしなかったページは数えず、警告も繰り返さない。警告を止める設定はない。表は CP932（NEC 行 13、IBM 拡張を含む）で、`iconv-lite`の`CP932`と BMP 全域で同じ結果（私用領域は変換しない。`¥`は 0x5C、`‾`は 0x7E）。
- 表は`scripts/gen-cp932-table.mjs`が Node のデコーダ（WHATWG `shift_jis`）から作る。

### 9.6 `html.serializer`

DOM を HTML に戻すときの書き方。`"linkedom"`（既定）は v2 の中間 HTML と同じ書き方で、v2 とバイト一致させるためのもの。`"spec"`は HTML 標準（ブラウザ、jsdom、parse5）の書き方で、d-zero/builder の出力と揃える。違い:

|                                  | `linkedom`                                                                                                         | `spec`                                                                                                                                                                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 属性値の`&`と U+00A0             | そのまま（`&`）／そのまま                                                                                          | `&amp;` ／ `&nbsp;`                                                                                                                                                                                                                                                                         |
| テキストの U+00A0                | `&#160;`                                                                                                           | `&nbsp;`                                                                                                                                                                                                                                                                                    |
| `<title>` `<textarea>`のテキスト | そのまま                                                                                                           | `&` `<` `>` U+00A0 をエスケープ                                                                                                                                                                                                                                                             |
| 空の属性                         | 既知の真偽属性は名前だけ。空の`class` `id` `style`は消す                                                           | すべて`name=""`                                                                                                                                                                                                                                                                             |
| 空の SVG 要素                    | `<path />`                                                                                                         | `<path></path>`                                                                                                                                                                                                                                                                             |
| 閉じタグを書かない空の要素       | `area` `br` `img` `input`ほかと`menuitem`。`basefont` `frame` `isindex`は書く（`minify`が有効なら手順 7 が落とす） | 標準の void。`basefont` `frame`を含み、`menuitem`を含まない。整形が有効なときも書かない（整形器が出力から落とす。整形器のパーサーは void として読まず、直列化で落とすと後ろの要素を子にするため）。`bgsound` `isindex`は書く（パーサーが linkedom と同じ読み方で、void として読まないため） |

`html.entities: "all"`は U+00A0 を`&nbsp;`にする（表の先頭の`NonBreakingSpace`ではなく）。

## 10. CSS と JS

- `styles`: CSS Syntax 3 のトークナイザとパーサ、`@import`の展開（alias は`prefix/`、`url()`と文字列の両方、メディア条件は`@media`で包む、リモート URL は残す、同じファイルの重複は除く、循環は検出）、安全な圧縮（cssnano の既定のうち、空白・コメント（`/*!`は残す）・空ルール・文字列・数値・色・`url()`・フォント値・セレクタの正規化・重複の削除）。`calc`の定数畳み込み（結果が小数 5 桁を超えるときは畳まず、書かれたまま出す。cssnano は 5 桁に丸める）と、隣接する同一ブロックのルールの結合も行う。`mergeLonghand`（長手の結合）、非隣接ルールの結合、`reduceInitial`、`svgo`は対象外。custom property と未知のプロパティの値は加工しない（ブラウザの解釈が変わりうるものは、サイズより安全を優先して縮めない）。サイズは cssnano の出力に近い（数値の目標は置かない。測り方と実測値は`docs/v3/spike-results.md`の「CSS の圧縮サイズ」。`scripts/check-css.mjs`が cssnano の +3% を基準に検査する。基準の詳細は`docs/v3/development.md`）。2 回圧縮しても結果は変わらない。cssnano との意図した差は`crates/kd_css/tests/common/mod.rs`の`DECISIONS`に両側の出力つきで記録する。
  - `@import`の展開は、v2 の postcss-import と同じ構造で、ファイルの文を平らな列にする。参照する仕様は CSS Cascading and Inheritance Level 5（<https://www.w3.org/TR/css-cascade-5/>）。
    - 並び: 先頭の`@charset` 1 つ、次に全ファイルの`@layer`の文と外部 URL の`@import`（文書順。外部の`@import`は、通ってきた取り込みの条件を引き継ぐ）、そのあとにファイルの残りを、取り込みの条件の`@media`/`@supports`/`@layer`で包んで取り込みの位置に置く。同じ外部の`@import`は 1 つにする。
    - 出力に入れないもの: `@layer`の文を挟んで続いていない`@import`、規則のあとの`@import`、読み込むファイルを名指さない`@import`、先頭にない`@charset`。v2 と同じく出力に入れず、`kamado build`の要約に警告を出す（`@import`は仕様（§2）でも無効。v2 は警告を表示しなかった）。警告はスタイルを作り直したときだけ出る（`cached`のスタイルは再掲しない。§9 のページと同じ）。開発サーバーは警告を出さない。
    - v2 と違う点（`MIGRATION.md` §6）: (1) `layer()`が 2 段以上ある取り込みの中の外部`@import`は、外側の条件を外側の`data:`スタイルシートの import に書く（`a.b`。postcss-import は逆で`b.a`。§6.4.2）。(2) レイヤーの宣言の順が、先頭へ上げる前のソースの順と変わるときは、取り込みの位置に`@layer name;`を書き足す（§6.4.3）。(3) 無名の`@layer`は別々のレイヤーなので、隣り合っても結合しない。無名の`layer`で取り込んだファイルの`@layer`の文は、先頭に移さずにファイルのブロックの中へ残す。移すと、文が宣言する名前とファイルの規則が別のレイヤーに入るため。
    - 隣り合う同じ条件のブロックの結合は、v2 の cssnano に合わせる。前のブロックの最後の規則と後ろのブロックの最初の規則が、入れ子の at-rule を挟まずに並ぶとき、後ろのブロックの規則（入れ子の at-rule の手前まで）を前のブロックの末尾へ移す。`@font-face`や`@layer p, q;`などの規則でないものとコメントは、後ろのブロックに残る。
  - `@custom-media`は Media Queries 5 §10（<https://drafts.csswg.org/mediaqueries-5/#custom-mq>）に従って解決し、定義は出力から消す。`styles.minify`によらず解決する。圧縮しないときは、定義を消して参照のある`@media`のプレリュードを置き換えるほかは書いたまま出す。定義は、行に定義と空白しかなければその行ごと消し、行の終わりにあれば前の空白も消す。規則の写しを作るときは、包む`@media … {`を元の規則の最初の行に並べ、閉じ括弧を最後の行に並べて、本体は書いたまま写す。写しの間は、規則が行の頭にあれば改行と元の字下げにし、行の途中なら空白 1 つにする。`(--name)`は、定義のクエリリストが一致するときに真になる。書き方は v2 の postcss-custom-media（`@d-zero/postcss-config`が固定する版）と同じ: クエリが参照だけなら定義のリストに、定義が括弧で囲んだ特性 1 つ（`(width < 1px)`。`not`/`and`/`or`を含まない）ならその場でその特性に置き換える。それ以外は、規則を`@media <定義>`の中（参照を常に真のクエリ`(max-color:2147477350)`にする）と`@media <定義の否定>`の中（常に偽の`(color:2147477350)`にする）に 1 回ずつ書く（その場で置き換えられない参照 1 つごとに、規則の数が倍になる）。未定義の名前と、循環に含まれる定義は、参照を書いたまま残す。定義として数えるのは、トップレベル、`@layer`/`@scope`/`@container`と、スタイル規則の中のもので、同じ名前ではレイヤーによらず最後に書いたものを使う。それ以外の at-rule（`@media`、`@supports`、`@starting-style`など）の中の定義を数えるかは仕様が決めていないので、v2 が数える at-rule に合わせ、定義とせず出力にそのまま残す。名前やクエリのない定義も残す。文法に合わないクエリ（`cannot (--a)`、`and`と`or`の混在、`foo(x)`のような関数を含むもの）は、v2 と同じく展開しない（どう展開してもブラウザでは一致しない）。そういうクエリを定義に書いた名前は偽なので、その否定は常に一致する`all`にする。展開で入れ子が深くなりすぎる（パーサの上限の 256 段を超える）規則は、展開せずに残す。参照として扱うのは、`<media-in-parens>`の位置にある`(--name)`だけで、関数の引数や特性の値の中の名前は扱わない。v2 と違う点は §2 #37。照合は`scripts/check-css-custom-media.mjs`。
  - `<style>`要素・`style`属性・`media`属性も同じ圧縮器を通す（HTML 後処理の一部）。
  - `sourcemap`: `true`、または`onServer`で開発サーバー経由のとき、末尾に inline の source map（`/*# sourceMappingURL=data:application/json;base64,… */`）を付ける。ルールと宣言の単位で、`@import`で取り込んだ元のファイルを指す（トークン単位ではない）。`minify: false`では、行と、`@custom-media`で書き換えた箇所の単位。
- `scripts`: esbuild（固定バージョン）。`alias`/`define`/`target`（既定`es2022`）/`minify`/`sourcemap`/`banner`。esbuild は JavaScript 側で`bundle: true`として呼び、どのファイルを読んだかをコアに返して差分ビルドの依存にする。v2 は`target`と`define`を渡さないので、既定の`es2022`と esnext で出力が違う構文を使うコードでは v2 と一致しない（`scripts.target`に`esnext`を指定すれば揃う）。
- HTML 内の`<script>`の中身とイベントハンドラ属性は、コアが esbuild の実行ファイルを子プロセスとして直接呼んで圧縮する（JavaScript のスレッドを経由しない）。同じ内容は 1 回だけ圧縮し、結果はキャッシュディレクトリに残す（キー: esbuild のバージョンと内容）。esbuild が読めないコードはそのまま残し、`html.onError`に従って報告する（§9 のステージの失敗。読めなかったことも理由と一緒にキャッシュに残すので、次のビルドも同じく報告する）。結果は terser（v2）と同一ではないが意味は同じ。esbuild の実行ファイルが見つからないときは圧縮せず、`kamado build`では 1 回だけ警告する（ページごとの失敗にはしない。開発サーバーは何も言わない）。

## 11. 差分ビルド

- manifest: v2 と同じ場所（`<os.tmpdir()>/kamado/<basename>-<hash>/`、`--cache-dir`で上書き。相対パスの基準は §13）。形式は**バイナリ**（`build-manifest.bin`、version 3）。文字列と（パス、指紋）の組を 1 回だけ書き、エントリは番号で参照する。末尾の SHA-256 で切り詰めや破損を検出し、読めなければ全ビルド。10 万ページでも数十 MB に収まる（JSON では数百 MB になる）。内容を見たいときは`Manifest::to_json`。
- plan cache（`plan-cache.bin`、同じディレクトリ）: ページごとに、ファイルと sidecar の指紋とメタを覚える。ファイルの size と mtime が記録と同じなら、読まず・ハッシュせず・パースせずにキャッシュのメタを使う（本文はそのページをビルドするときに読む）。何も変わらない差分ビルドは、ファイルごとに stat だけで終わる。`--force`は使わない。
- 各入力と依存の指紋は`(size, mtime_ns)`を先に比較し、変わったときだけ SHA-256 を取る（`--force`で全て再計算）。ハッシュが一致すれば（early cutoff）再ビルドしない。同じ依存（レイアウトやコンポーネント）の stat は 1 ビルドで 1 回だけ。ビルド中に変更された入力は（読んだあとに書き換えられた可能性があるので）manifest に「最新」として記録せず、次のビルドでやり直す。
- **既知の限界**: `(size, mtime_ns)`が記録と同じなら、内容は変わっていないとみなす。ファイルシステムの時計の粒度の内に、同じサイズで書き換えられた変更は検出できない（`--force`で全て再計算する）。
- 環境ダイジェスト: 設定ファイルの内容、kamado のバージョン、`pages.overrides`、ページごとに「読んだメタのフィールド」の値。
- 依存ゼロのファイルはスキップしない（v2 と同じ）。manifest の version 不一致・破損は全ビルド。

## 12. 開発サーバー

- **待ち受けるアドレス**: `devServer.host`が`localhost`（ホスト名の検査と同じく、小文字にして末尾の`.`を取って比べる）のときは名前を解決せず、`127.0.0.1`と`::1`の両方の同じポートで待ち受ける。`http://localhost:<port>/`・`http://127.0.0.1:<port>/`・`http://[::1]:<port>/`のどれでも繋がる。Node の`listen`は名前を 1 つのアドレスに解決するので、`localhost`を渡すと OS が最初に返すほう（macOS では`::1`）だけになり、空いたほうのアドレスの同じポートを別のプロセスが取れてしまうため。名前を解決しないのは、`localhost`は loopback（RFC 6761 §6.3）で、hosts ファイルが別のアドレスに向けていてもマシンの外に開かないため。マシンに無いアドレス（IPv6 が無効な環境の`::1`）は飛ばす。どちらかのアドレスでポートが使われていれば起動しない。ほかの値は書いたとおりのアドレスで待ち受ける。`Location`の表示は`devServer.host`のまま（IPv6 アドレスは URL の書き方どおり`[::1]`と括弧で囲む。Host の無い要求もこのホスト宛てとみなす。`::1`を飛ばしたときも変えない。IPv6 が無効なら OS も`localhost`を`::1`では繋がない）。
- hono。`/` → `index.html`、末尾`/` → `index.html`、拡張子なし → `.html`。出力ディレクトリ外は 403。マップにない場合は出力ディレクトリから静的配信（`.html`/`.htm`への`html.inject`は§9.3）、なければ 404、コンパイルの失敗は 500（本文はエラーメッセージ）。
- **要求の検査**: 開発サーバーはソース（inline の source map）や`proxy`の先の API を返す。そのため、どのルートよりも前にすべての要求（`proxy`を含む）を 2 つの検査にかけ、どちらかに当たれば`403`（本文は理由）にする。ログには`blocked`として出し、本文を`error`に載せる。
  - **ホスト名**: 要求の URL のホスト名（`Host`。無い要求は`devServer.host`宛てとみなす。小文字にし、末尾の`.`を取る）が次のどれでもなければ拒否する: `localhost`とそのサブドメイン（RFC 6761 で loopback）・IP リテラル（IPv4 と`[...]`の IPv6）・`devServer.host`・`devServer.allowedHosts`。DNS リバインディング（攻撃者のドメインを 127.0.0.1 に向け直し、そのページから同一オリジンとして読む）への対策で、そのとき`Host`は攻撃者のドメイン名になる。`devServer.host`は待ち受けるアドレス（`0.0.0.0`で全インターフェース）で、その名前の要求も通すが、マシンに届く別の名前（`laptop.local`など）は`allowedHosts`に書く。`allowedHosts`の各値は完全一致で、先頭が`.`の値（`.example.test`）はそのドメインと全サブドメインに一致する。値は ASCII のホスト名（国際化ドメイン名は punycode）か括弧付きの IPv6 アドレスで、スキーム・ポート・パス・`*`を含むものは設定エラー。IP アドレスの値はホスト名の検査では意味を持たない（IP リテラルは常に通る）が、クロスサイトの検査でそのアドレスのページからの要求を通すのに使う。`"all"`のような検査を切る値は無い。本文は`allowedHosts`に足せば通ることと、`host`が待ち受けのアドレスでしかないことを案内する。
  - **クロスサイト**: `Sec-Fetch-Site: cross-site`の要求は、タブで開くトップレベル遷移の GET（`Sec-Fetch-Mode: navigate`かつ`Sec-Fetch-Dest: document`。外部のリンクから開く場合。ブラウザの遷移は GET だけ）だけ通し、ほかは拒否する。防ぐのは次の 3 つ: 別サイトの`<script src>`でバンドルを読まれること・別サイトのフォームから`proxy`へ POST されること（`changeOrigin`は`Origin`を書き換えるので、先の API の CSRF 対策も効かない）・`iframe`/`frame`/`embed`/`object`に埋め込まれること（内容は読めないが、クリックジャッキングの足場になる）。ただし、タブで開く遷移でも`proxy`の接頭辞の下（接頭辞の末尾の`/`は無視する）は拒否する（別サイトのリンクや`window.open`で、先の API の副作用のある GET を踏ませないため）。`cross-site`以外の値（`same-origin`・`same-site`（別ポートの`localhost`など）・`none`（アドレスバーから開く）・未知の値）は通す。`Origin`のホスト名が要求のホスト名と同じなら通す（同一オリジン。LAN の IP で開いた自サイトのフォームや fetch は`Sec-Fetch-*`を持たないため）。ブラウザは`127.0.0.1`と`localhost`を別のサイトと見るので、`cross-site`でも`Origin`のホスト名がホスト名の検査を満たせば通す（同じマシンの別のツールからの fetch やフォーム）。`Origin`の IP リテラルは loopback・`devServer.host`・`allowedHosts`に書いたアドレスだけを通す。公開アドレスに置いたページの`Origin`も IP リテラルになるため。`Sec-Fetch-Site`が無いときは`Origin`だけを見て、同じ規則で判定する。`Origin: null`（`sandbox`属性の iframe・別サイトを経たリダイレクト）は拒否する。自サイトの`sandbox`付き iframe からの送信も通さない（`Sec-Fetch-Site`も`cross-site`になる）。`Sec-Fetch-*`も`Origin`も送らないクライアント（curl など）は通す。本文には`Origin`と`Sec-Fetch-Dest`を載せ、アドレスバーから開くか、自分のツールなら`Origin`のホスト名を`allowedHosts`に足すよう案内する。**限界**: ブラウザは`Sec-Fetch-*`を potentially trustworthy な URL（`https:`、`localhost`、loopback の IP）宛てにしか送らない（Fetch Metadata Request Headers §3）。loopback 以外のホスト（`http://192.168.1.5:3000`や`http://laptop.local:3000`）で平文のまま開いているときは`Origin`だけで判定することになり、`Origin`を持たない GET（`<script src>`・iframe・`proxy`へのリンク）は防げない。フォームの送信と CORS の fetch は防げ、ホスト名の検査は DNS リバインディングを防ぐ。
- MIME は一般的な拡張子の表を持つ（表にない拡張子は`application/octet-stream`）。出力ディレクトリから静的に返すファイル（`html.inject`を入れないもの）の`Content-Type`は、拡張子だけで決め、`charset`を付けない（v2 は静的なファイルに`charset`を付けなかった）。バイトを読まずに返すので、ヘッダーで UTF-8 と断じると、ファイル自身の`<meta charset>`・`@charset`を上書きし、Shift_JIS のファイルが文字化けする。ファイルに宣言があればそれが、なければ読み込む側かブラウザの既定が文字コードを決める（宣言も BOM も無い UTF-8 のファイルは、ブラウザの既定で読まれる）。UTF-8 と確かめられたときだけ`charset=utf-8`を付ける案は採らない（全部のファイルを送る前に読むことになり、ストリームと`Range`を失う）。kamado が作る応答（ページ・スタイル・スクリプト）と、`html.inject`を入れた静的な HTML（UTF-8 と確かめたバイト。§9.3）は、`charset=utf-8`を付ける。ファイルは`Range`（1 つのバイト範囲）に`206`で応える（動画のシークと、Safari の再生のため）。複数の範囲や読めない値は無視して全体を返し、ファイルの終わり以降を指す範囲は`416`。`ETag`/`Last-Modified`は返さないので、`If-Range`付きの要求には全体を返す。プロキシ: 最長一致、`rewrite`、`changeOrigin`、Node の`fetch`（TLS は Node）、リダイレクトは手動、ネットワークエラーは 502。
- ファイル監視とライブリロードは**持たない**（v2 と同じ）。リクエストごとに依存の stat を確認し、変更がなければメモリの出力を返す（何も書き出さない）。
- コアはサイトを起動時に計画し、リクエストを「本文」「出力ディレクトリのファイル」「JavaScript に描画を頼む」「esbuild にビルドを頼む」のどれかに振り分ける。JSX ページの描画は専用のワーカー 1 つが行う。Node はモジュールをアンロードできないので、**コンポーネント（またはそれが import するファイル）が変わったら、ワーカーを作り直して全コンテキストを渡す**（古いワーカーは受け持ちを終えてから止まる）。メタだけが変わったときは、変わったページの差分を渡す。
- ネイティブコアが panic したときは、その要求を 500 にして、コアのサーバーと描画ワーカーを開き直す（プロセスは止めない）。開き直したサーバーは、その時点の設定とページの一覧を読み直す。ただし、ポート、ホスト、`allowedHosts`、`proxy`、`startPath`は、起動したときのまま。
- **計画の作り直し**: 計画（URL → ページの一覧）は、要求の中で次のときだけ作り直す。ファイル監視は持たないので、ページのファイルの追加・削除・移動、`outputPathField`の変更、`pages.overrides`の編集（`kamado ui`が書くものを含む）は、これらで気づく。
  - ページが要求され、`pages.overrides`の size か mtime が前回の計画と違う、または前回の計画の直前（mtime の粒度の内）に書かれたファイルだった（同じサイズの書き換えが同じ mtime になりうるので、その場合は落ち着いたあとに 1 回読み直す）。入力ディレクトリは歩かない。ページのファイルを stat で読み直し、`pages.overrides`と組み合わせ直す（メタのマージ・仮想ページ・並び）。ページ以外の要求（画像・スタイル・スクリプト）は`pages.overrides`を見ない。
  - 要求されたページの入力ファイルが無い。入力ディレクトリを歩き直す。そのページは一覧から外れ、404 になる。
  - 要求されたページの`outputPathField`の値が、計画の値と違う。ページのファイルを stat で読み直し、組み合わせ直す（出力先が重なるページが出うるので、全ページを組み合わせ直す）。
  - ページになりうる URL が一覧に無く、そのファイルを置くディレクトリ（入力ディレクトリまでの各階層）の mtime が、前回の歩きのあと、または前回見たときから変わっている。入力ディレクトリを歩き直す。ページになりうる URL は、出力パスが`outputExtension`で終わる URL（`/dir/`と、拡張子のない`/about`を含む。`outputExtension`が空なら、最後のセグメントに`.`のない URL）で、出力ディレクトリに同じパスのファイルが無いもの。ファイルの追加・削除・改名はそのディレクトリの mtime を変え、ディレクトリの改名はその親の mtime を変える。ファイルの中身の編集は変えない。`/favicon.ico`のようにページになりえない URL の miss は、404 を返すだけで、何も見ない。変わった直後（mtime の粒度の内）のディレクトリは、見たことを覚えない。次の miss が、もう一度歩く。
  - `outputPathField`のあるサイトでは、URL をファイルの中の値が決めるので、ディレクトリの mtime では分からない。ページになりうる URL の miss は、ディレクトリが変わっていなくても、入力ディレクトリを歩き直す。作り直したあと（歩いて見つからなかった場合も）、その URL は 2 秒間覚えていて、その間の同じ URL の miss では作り直さない。壊れたリンクの繰り返しで、大きなサイトを止めないため。
  - 直前の作り直しから 200 ms 以内に来た miss は、その残りの時間を待ってから作り直す。404 にはしない。作ったばかりのページをすぐ開き直せるようにするため。待つ間はコアの状態を持たない（ただし呼び出しは同期なので、Node はその間ほかの要求を処理できない）。作り直しを起こした要求の中では、miss でもう一度作り直さない（ページのファイルは全部読み直した直後で、歩いたなら全ディレクトリを見た直後なので）。作り直せなかった miss は覚えない。次の要求が、もう一度作り直す。
  - 1 つの要求が作り直せるのは 2 回まで（`pages.overrides`、そのあとページのファイルが消えた場合か、`outputPathField`の値が変わった場合）。それでもページのファイルと計画が合わないときは、404 ではなく 500 にする。本文は、もう一度要求するよう案内する。
- **作り直したあと**: 読んだファイルの (size, mtime) をメモリに覚えていて（§11 の plan cache と同じ規則。ファイルには書かない）、変わっていないファイルは読み直さない。ページの番号が変わるので、メモリの出力をすべて捨て、描画ワーカーには次の描画で全コンテキストを渡す（新しいワーカーを作り、描画中の要求は古いワーカーが終える）。描画中のページは入力ファイルで新しい一覧に結びつける。一覧から消えたページの結果は捨てる。スタイル・スクリプト・データ・コンパイル済みのモジュールは計画の外なので、そのまま。計画は同期呼び出しなので、その間はほかの要求も待つ。作り直せないとき（`pages.overrides`が読めない、どれかのページの front matter が不正など）は、その要求を 500 にして、前の計画のまま続ける。ページになりうる URL の miss も同じで、作ったばかりのページの壊れた front matter の理由を、404 が隠さないため。
- 起動後に気づかないもの（再起動が必要）: 設定ファイルと`html.*`の変更、スタイルとスクリプトのファイルの追加と削除。**他のページ**のメタの変更は、そのページ自身のファイルが変わるか、そのページが要求されるまで、ナビゲーションなどに反映されない。
- スタイルは`styles.sourcemap: "onServer"`（既定）で inline の source map つき、バナーは開発中の警告。スクリプトも同様（esbuild は JavaScript 側で呼ぶ）。

## 13. CLI

`kamado build [globs...]`、`kamado server`、`kamado pages`、`kamado ui`、`kamado ui-settings`。`build`・`server`・`pages`・`ui`に共通: `--config/-c`、`--cache-dir <dir>`、`--help/-h`（`ui-settings`は下のとおり）。`--verbose`は`build`と`server`。build: `--incremental`、`--force`、`--skip-unchanged`、`--jobs <n|auto>`（`auto`は設定の`build.jobs`と同じく既定の数）。pages: `--out <file>`、`--incremental`（`--force`、`--jobs`、`--skip-unchanged`、`--verbose`は読まず、渡すとエラー）。ui: `--port <n>`（既定は`devServer.port + 1`）、`--open`/`--no-open`（既定は`devServer.open`）。`--out`、`--force`、`--jobs`、`--skip-unchanged`、`--incremental`、`--verbose`、位置引数は、`ui`に渡すとエラー。`--port`と`--open`は`ui`だけのフラグで、ほかのコマンドに渡すとエラー。ui-settings: `list`、`reset [--config <file>]`、`delete <config-file>`か`delete --all`（`ui`が保存した設定の確認と削除。§14.2）。`--all`は`ui-settings delete`だけのフラグで、ほかのコマンド・サブコマンドに渡すとエラー。`--config`は`reset`だけ。`--cache-dir`、`--port`、`--open`、`--no-open`、`--out`、`--force`、`--jobs`、`--skip-unchanged`、`--incremental`、`--verbose`は、`ui-settings`に渡すとエラー。設定エラーは赤字で表示して exit 1。進捗表示（スピナー、done/total、`Build completed in Xs`）と色分けは v2 に準じる。

`globs`（複数可）は、ビルドするページ・スタイル・スクリプトを、入力ファイルで絞る。相対パスは **cwd 基準**（打った場所からのパス。v2 と同じ）、絶対パスは基準を付けずに使う。`*` `?` `[` `]` `{` `}`を含むものは glob。含まないものはファイルのパスで、そのファイルが無ければエラー（exit 1）。ディレクトリのパスは、その中のすべてのファイル（`dir/**`）。ページ・スタイル・スクリプトを 1 つも選ばなかったもの（当たらない glob、ページでない画像のパスなど）は警告して、ビルドを続ける。先頭が`!`の否定はエラー。基準のディレクトリの名前にある、glob が読む文字（`(`や`|`を含む）はエスケープして照らす。コアは入力ファイルを、設定ファイルのディレクトリ・`dir.input`・たどったパスで名付け、途中のシンボリックリンクを解かない。`globs`も同じく書かれた形のまま照らす。cwd はシンボリックリンクを解いた実体のパスなので、CLI は設定ファイルのパスも実体にそろえる。glob の中の`\`はエスケープなので、Windows でも glob は`/`で区切って書く。

`kamado pages`は、ビルドせずに計画の全ページを JSON の一覧にして書き出す（形は §14.1）。`--out`が無ければ標準出力に、あれば`<file>`に書く（相対パスは**cwd 基準**。親ディレクトリが無ければ作る）。`globs`のような位置引数は受けず、渡すとエラー（exit 1）にする。`build`の`globs`と同じ書き方で絞れると思って打った人が、全ページの一覧を受け取って気づかないのを防ぐため。`--incremental`は`build`と同じ意味で、plan cache を読み、変わっていれば更新する（§11）。端末には、計画の前に`Reading pages...`、終わりに`Wrote map.json (1,234 pages) in 0.8s`（`--out`が無いときは`Listed 1,234 pages in 0.8s`）を、1 行ずつ標準エラーに出す。計画の警告（§14.1 の`warnings`）があれば、終わりの行の前に`warning: <警告>`を 1 件 1 行で出す。`build`と同じ書き出し（色は付けない）で、一覧をファイルに書いたときに、出力先の衝突などを見逃さないため（JSON は変えない）。`--out`は`pages`だけのフラグで、`build`と`server`に渡すとエラーにする（黙って無視しない）。`--out`が空なら、計画を読む前に`--out needs a file name`でエラーにする。書き込めない（既存のディレクトリなど）ときは、`cannot write <out>: <理由>`でエラーにする。計画は Rust の同期呼び出しで、スピナーは回らない。

コマンド名は`kamado`（`packages/kamado/package.json`の`bin`）。

`kamado ui`は、§14.2 の書き戻しを使って、ページの URL とメタをブラウザで編集し、ページを足す・無くす・仮想ページにする（開発サーバーとは別のポートで動く）。`kamado ui-settings`は、`kamado ui`の画面が保存した設定（§14.2）を、プロジェクトごとに見る（`list`）・消す（`reset`・`delete`）。ビルドも描画もせず、設定ファイル以外は読み書きしない。`list`は保存済みのプロジェクト（設定ファイルの実体パス）を、保存した日時と、設定ファイルがもう無いものの印つきで 1 行ずつ出す。`reset`は`--config`（既定`./kamado.config.jsonc`）のプロジェクトの設定を消して、そのプロジェクトを初期値に戻す。`delete <config-file>`は指したプロジェクトの設定を消す（設定ファイルの実体パス、またはそれのあるディレクトリ。もう無いプロジェクトは、`list`に出た書き方のパスで指す。保存が無いプロジェクトはエラー）。設定ファイルが壊れているときと新しい版のときも、何も変えずにエラーにする（壊れたファイルを消すのは`--all`）。`delete --all`は設定ファイルごと消し、全プロジェクトの設定と言語の設定がなくなる。壊れた設定ファイルと新しい版の設定ファイルは、`list`では読めないと言うだけで、移したり書いたりしない。`reset`は、壊れたファイルを退避して新しく作り直す（§14.2）。新しい版のファイルでは、何も変えずにエラーにする。

プログラム API: `build(configPath, options?)`、`start(configPath, options?)`、`pages(configPath, options?)`、`ui(configPath, options?)`。第 1 引数は**設定ファイル（JSONC）の絶対パス**の文字列で、オブジェクトは受け取らない（相対パスの基準になるディレクトリが設定ファイルの場所だから）。`options`は CLI のフラグに対応する（`build`は`incremental`/`force`/`skipUnchanged`/`targets`/`jobs`/`cacheDir`/`onProgress`、`start`は`verbose`/`cacheDir`/`write`、`pages`は`incremental`/`cacheDir`、`ui`は`port`/`open`/`cacheDir`/`write`（ログの行の出し先。`start`と同じ）/`settingsFile`（設定の保存先。既定は§14.2 の場所））。`ui()`は起動した UI の`{ url, close() }`を返す。`pages()`は §14.1 の一覧を`PageMap`として返し、ファイルには書かない（`--out`は CLI のもの。書くなら`JSON.stringify`して自分で書く）。Promise を返すが、計画は同期呼び出しなので、その間はイベントループを止める（`build()`の Promise と同じ形にしてあるだけで、ループが空くことの約束ではない）。`targets`の相対パスは**設定ファイルのディレクトリ基準**（設定と一緒に渡すものなので、設定の中のパスと同じ。CLI の`globs`だけが cwd 基準）。`cacheDir`の相対パスも同じ分け方で、API の`cacheDir`（`build`・`start`・`pages`・`ui`）は**設定ファイルのディレクトリ基準**（設定の`build.cacheDir`と同じ。`/`で始まるパスはそのまま）、CLI の`--cache-dir`は**打った場所（cwd）基準**（CLI が cwd で絶対パスにしてから渡す）。同じ相対パスでも、設定ファイルのディレクトリと cwd が違えば別のキャッシュ（manifest と plan cache）を指し、取り違えても差分ビルドが毎回 cold になるだけでエラーにならない。glob とファイルのパスの扱いは CLI と同じ（当たらない glob は`build.report`の`warnings`、無いファイルは例外）。

## 14. ビルドの出力: `build.report`とページの一覧

`build.report`にパスを指定すると、ビルド結果の JSON を書き出す。postbuild のスクリプトが使う。

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

`status`は`built`/`cached`（差分ビルドで飛ばした）/`unchanged`（`skipUnchanged`で、出力が同じバイト列だった）/`skipped`（`targets`の対象外）/`virtual`（仮想ページ。書き出さない）。`kind`は`style`/`script`。

### 14.1 ページの一覧: `kamado pages`

`kamado pages`と`pages()`（§13）は、描画せずに計画（§5、§6）の全ページを、1 ページ 1 要素のフラットな配列で書き出す。ディレクトリマップをスプレッドシートなどに出すための一覧で、`pages.overrides`（§6）が決める向きの逆（kamado からスプレッドシートへ）にあたる。`build.report`はビルドを完走しないと書かれず、`fileSlug`・`filePathStem`・`extension`と階層を持たない。ページの探索とメタの抽出は描画の前に終わるので、描画に依らない一覧はここで書き、ビルドの完走を待たない。

```jsonc
{
	"version": 1,
	"pages": [
		{
			"url": "/about/history/",
			"inputPath": "/site/src/about/history/index.tsx",
			"outputPath": "/site/htdocs/about/history/index.html",
			"fileSlug": "history",
			"filePathStem": "/about/history/index",
			"extension": ".tsx",
			"depth": 2,
			"parent": "/about/",
			"virtual": false,
			"meta": { "title": "…", "layout": "default" },
		},
	],
	"warnings": [],
}
```

- `url`から`extension`までは §5 の`page`と同じ。`meta`は §4 のマージ後の全キーで、JSX が見るものと一致する。`date`（ビルドを始めた時刻で、ページの情報ではない）は載せない。`breadcrumbs`と`titleList()`が解決するタイトルも載せない（`meta.title`を読む側が使う）。`fileSlug`は §5 のとおり、`index`のページでは親ディレクトリの名前なので、ルートの`index`は入力ディレクトリの名前になる（`dir.input: "."`ならプロジェクトのディレクトリの名前）
- `depth`は`nav()`の木（`pathListToTree`）と同じ数え方で、URL を`/`で区切ったときの、最後のセグメントを除いた数（ディレクトリの数）に、そのページがディレクトリの`index`でなければ 1 を足す。木に載らない拡張子（`.php`など）のページにも、同じ数え方で付く。木は URL を URL として読むので、ファイル名に`?` `#` `\`を含むページでは数え方が違う（木は`?`と`#`の先を捨て、`\`を`/`として読む）。一覧は URL の文字列を`/`で区切る規則に従い、そのファイルがある場所の深さを書く。`index`は、最後のセグメントが空（`/`で終わる）か、拡張子を除いた名前が大文字小文字を区別せずに`index`のもの（`/a/INDEX.html`、`outputExtension: ""`のときの`/a/index`）。`/`は 0、`/about/`と`/a.html`は 1、`/about/history/`と`/about/history.html`は 2
- `parent`は、木でそのページの親になるディレクトリの URL。`index`のページはディレクトリそのものなので、その 1 つ上のディレクトリ（`/about/history/`の親は`/about/`、`/about/`の親は`/`）、ほかのページはそれがあるディレクトリ（`/about/history.html`の親は`/about/`）。`/`は`null`。書き方は`url`と同じで、符号化し直さない。その URL のページが一覧にあるかは、読む側が`url`で引く（ディレクトリの`index`が無いときのほか、`pages.outputExtension`が`.HTML`のように大文字を含み、`index`の URL が`/x/index.HTML`になるときも、`/x/`のページは無い）
- `virtual`は`pages.overrides`の仮想ページ（§6）。入力ファイルが無いので、`inputPath`と`extension`は`null`。計画は仮想ページにも URL から逆算した入力パスを持つが、存在しないファイルのパスを一覧に載せると実在と取り違えるため。`outputPath`は、書き出されないが、そのページがあるはずの場所（URL から決まる）を書く。ディレクトリマップには、kamado が作らない（外部が応える、まだ作っていない）ページの置き場所も要るため。`fileSlug`と`filePathStem`も URL から決まる
- 並びは計画の順で、`pages`と`nav()`と同じ（`pages.overrides`に書いたページが書いた順で先、残りは辞書順。§6）。`targets`は受けず、sitemap（§15）と同じく計画の全ページを書く
- `warnings`は計画の警告（`outputPathConflict`、書き込めなかった plan cache）
- 出力は`build.report`と同じ compact な JSON（読むのはプログラムなので、整形しない）。`kamado pages`は末尾に改行を 1 つ付ける

### 14.2 ページの編集: `kamado ui`

`kamado ui`と`ui()`（§13）は、§14.1 の一覧をブラウザの表で編集し、ソースへ書き戻す。編集するのは URL とメタ（§4）と、ページの有無。ページの有無とは、ページを足す・無くすことと、ファイルのあるページを仮想ページにする・その逆のこと。ページの本文やコンポーネントは編集しない（足したページのファイルは、最小のひな形で作る）。ビルドも描画もしない。この節は、ソースへの書き戻しとコアの API の仕様。

**書く場所（出所）**

- メタのキーは、§4 でその値を決めたソース（出所）に書く: `pages.overrides`（`overrides`）、sidecar `.json`（`sidecar`）、ページファイル内（`inFile`。`.html`は front matter、`.tsx`/`.jsx`は`export const meta`）。新しいキーは`inFile`に書く。仮想ページはファイルが無いので`overrides`にだけ書く（仮想ページは、`pages.overrides`の項目があるから在る）。実在のページに`pages.overrides`の項目を足すことはしない（新しいキーはそのページのファイルに書くので、その必要が無い）。項目を足すのは、仮想ページを足すときと、実在のページを仮想ページにするとき（下の「ページの追加・仮想化・実体化・削除」）。キーを消すと、出所のソースから消え、下のソースに同じキーがあればその値が現れる（キーが空になるのではない）
- 一覧のメタの値は、`{ "value": …, "origin": "inFile" | "sidecar" | "overrides", "editable": true | false, "reason": "…" }`の形で、出所と、編集できるか（できないときは理由）を返す
- `outputPathField`のキー（§5）は、一覧の`meta`には`editable: false`と理由つきで残し、`columns`には入れない。メタのキーとして書こう（set・delete）とすると`notEditable`で拒否し、URL の変更として扱う（URL の検査を通さずに出力先を変えさせないため）。URL がこのキーで決まるかどうかは、計画（§5）と同じく、ページファイルと sidecar だけを見て決める（`pages.overrides`にだけあるキーは、URL を決めない）
- `pages.overrides`は、手で書いても、prebuild が作っても、`kamado ui`が書いてもよい。prebuild が作り直す運用では、元のデータが正で、`kamado ui`が書いた分は次の prebuild で消える

**編集できないもの**（一覧では`editable: false`と`reason`。書こうとすると`notEditable`）

- YAML の front matter のキーのすべて: アンカー・エイリアス・`<<`を含むとき（パーサはこれらを読み込み時に展開して出どころを捨てるので、1 つを書き換えると、同じアンカーを参照するほかのキーの意味が変わる）、マッピングでないとき、ブロックのマッピングでないとき（`{a: 1}`のような flow、1 列目から始まらないもの）。キー`<<`を新しく書くこと（パーサは引用符つきでもマージキーとして読む）
- `export const meta`のキーのすべて: オブジェクトリテラルでないとき（`null`、配列）
- `export const meta`が同じキーを 2 回書いているときの、そのキー。後ろの値が使われるので、どれを書き換えるかが決まらない
- `export const meta`にキー`__proto__`を新しく書くこと。オブジェクトリテラルの`__proto__: v`は、引用符つきでも、プロパティではなくプロトタイプを設定する。キーとして読み戻せても、モジュールを動かすとキーにならない
- `outputPathField`のキー（上）

**書き戻し**: 触らない部分のバイト（コメント・引用符・空白・改行コード・BOM・キーの順）は変えない。編集したキーの値だけを置き換え、追加・削除したエントリの行だけを足し引きする。ファイルは UTF-8 のまま、その場で書く（`fs::write`。シンボリックリンクの先とパーミッションを保つ）。同じ値を set したときは、ファイルのバイトを変えず、書き込みもしない。

- **書く前の確認**: 書く結果を、計画が読むのと同じ読み方で読み直し、意図した値になることを確かめる。意図した値とは、そのキーだけが変わり、ほかのキーとほかのエントリは変わらないこと（HTML のページは本文も変わらないこと）。`pages.overrides`は、全体を読み直さずに、編集したエントリを読み直し、エントリの前と後ろのバイトが元のままであることを確かめる。10 万ページの`pages.overrides`で、全体を読み直す時間が編集の時間の大半になるため。`pages.overrides`の項目そのものを変える編集（項目を足す・消す、仮想ページかどうかを変える）は、全体を読み直して、変えた項目のほかが元のままであることを確かめる。その編集は続けて計画を読み直し（URL の移動と同じ）、計画がファイル全体を読むので、全体を読む時間は増えない。確かめて合わなければ、何も書かずに`invalid`で拒否する。書き戻しの誤りが、ファイルを壊したまま残らないため
- **全部か、1 つも書かないか**: URL の移動のように複数のファイルに及ぶ変更が途中で失敗したら、すべて取り消して`io`で答える。移したファイルは元の名前に戻し、書いたファイルは元の内容に戻す（元が無かったファイルは消す）。移し先のために作ったディレクトリも取り除く（取り消したあとの木は、始める前のまま）。空になった元のディレクトリを消すのは、全部が成功したあとなので、取り消しでは何も消していない（下の「URL の変更」）。ファイルを消す編集（仮想化・削除）は、消すファイルをまず同じディレクトリの別の名前（`.<名前>.kamado-removed`）に移し、ほかの書き込みが全部成功してから消す。途中の失敗は、名前を戻して取り消す（内容を書き戻すのではないので、パーミッションもシンボリックリンクも元のまま）。その名前のファイルがすでにあれば（途中で止まった編集が残したもの）、それには触らず、番号を付けた空いている名前（`.<名前>.kamado-removed.1`…）を使う。最後の「消す」は、取り消しの対象にしない。そのときには変更はすべて済んでいて、消せなかった別名のファイルはそのまま残す（書いたものを取り消すと、すでに消えたファイルが戻らないぶん、サイトが食い違う）。成功の答えに`"warning"`（消せなかったファイルの名前と理由）を添えて知らせる。画面は状態欄に、したことと一緒に出す
- **YAML の front matter**: 対象は一番上の階層のキーだけ。値は丸ごと置き換える。配列とオブジェクトは JSON と同じ書き方の 1 行の flow（`{"a":1}`）で書く。編集したキー自身の元の書き方は保たない。文字列は、plain で書いて同じ文字列に読み戻せるときは plain で書く。そうでなければ double-quoted で書く。double-quoted にするのは次のとおり: 空の文字列。plain で読むと別の型（数値・真偽値・`null`）になるもの。先頭が`- ? : , [ ] { } # & * ! | > ' " % @`かバッククォートのもの。`: `か` #`を含むもの。`:`で終わるもの。前後に空白のあるもの。制御文字（改行とタブを含む）を含むもの。数値は JSON の書き方で、`NaN`と無限大は`null`。新しいキーは、英字か`_`で始まり、英数字・`_`・`-`・`.`だけでできていて、plain で読むと文字列になる名前ならそのまま書く。そうでなければ double-quoted で書く。追加は一番上の階層の末尾に、削除はそのキーの行（複数行の値を含む）だけにする。エントリの範囲は、その値の最後の行まで。あとに続く空行と 1 列目のコメント行は、次のエントリのものとして残す（ブロックスカラーの中のインデントした`#`の行は値）。編集したエントリ自身の行の末尾のコメントは消える。最後のキーを消して残りが空白だけになったら、front matter の fence ごと消す（閉じ fence のあとの改行 1 つも。コメントが残るなら fence を残す）。front matter の無いファイルへの追加は、BOM のすぐ後ろに`---`で囲んだ front matter を作る。改行コードは、既存の front matter の最初の改行に合わせる（front matter の無いファイルは、ファイルの最初の改行に合わせる。無ければ`\n`）
- **JSON（sidecar と`pages.overrides`）**: メンバーの値だけを置き換える。値は compact な JSON で書く。追加は最後のメンバーの後ろに、インデント（タブか空白）と末尾のカンマの有無を、そのオブジェクトの既存のメンバーに合わせて書く。空のオブジェクトへの追加は、1 行なら`{ "k": v }`、複数行ならその行のインデントに 1 段足して書く。追加する行の改行コードは、そのファイルの最初の改行に、1 段のインデントは、最初のインデントした行に合わせる（無ければタブ）。削除は`"key": value`と、その後ろのカンマ（最後のメンバーなら前のメンバーのカンマ）と、同じ行の末尾の`//`コメントを消す。前のメンバーとのあいだのコメントは残す。sidecar が`{}`になっても、ファイルは消さない。`pages.overrides`の`pages`の項目（配列の要素）を足す・消すのも、同じ規則。足す項目は最後の項目の後ろに compact な JSON で書き、インデントと末尾のカンマの有無は既存の項目に合わせる（空の配列は、1 行なら`[v]`、複数行ならその行のインデントに 1 段足す）。キーの追加（`set`）も、`meta`が無い・`null`の項目には、そのキーを最初の 1 つとして`meta`を作る（計画は`null`を空のメタとして読むので、書けなければならない）。消す項目は、その行（複数行の値を含む）とカンマと、同じ行の末尾の`//`コメントを消す。最後の 1 つを消して残りが空白だけになったら`[]`にする
- **`export const meta`**: オブジェクトリテラルのメンバーの値だけを書き換える。値の外側の括弧と符号は値の一部で、置き換えると消える。`meta`全体を囲む括弧と、`as const`/`satisfies`は残る。文字列を置き換えるときは、元の値の引用符を保つ。新しい文字列の引用符は、そのオブジェクトの文字列（キーと、入れ子の中も）が多く使うほう（同数か、文字列が無ければ`"`）。新しいキーは、ASCII の識別子として書ける名前ならそのまま、そうでなければ引用符つきで書く。配列は`[a, b]`、オブジェクトは`{ k: v }`（どちらも 1 行。オブジェクトのキーも同じ規則）、数値は、整数はそのまま、`1e15`以上と、`1e-6`より小さい 0 でない数は指数形式、有限でない数は`null`で書く。追加する行の改行コードとインデントは、JSON と同じく、そのファイルのものに合わせる。テンプレートリテラルの値は、置き換えると引用符つきの文字列になる。`export const meta`が無いモジュールは、最後の`import`文（import 属性と`;`を含む）の直後、無ければ先頭の directive（`'use strict'`）の直後、無ければ最初のトークンの前（先頭のコメントの下。pragma を最初に保つため）に、`export const meta = { … };`を足す。その行に別の文やブロックコメントが続くときは、文の直後に入れる。足す行の改行コードは、そのファイルの最初の改行に合わせる。型の注釈（`meta: Meta`）が付いているとき、足したキーが型検査を通るかは、`kamado`が見ない

**衝突の検出**: 一覧は、ページごとに`input`と`sidecar`、全体で`overrides`の、ファイルの内容の SHA-256（16 進）を返す。編集の要求は、その編集が触るファイルの SHA-256 を、`expect`に添える（キーの編集は、そのキーの出所のファイル。URL の移動は、移すファイルと、あれば sidecar、キーを書き換えるファイル、`pages.overrides`に項目があれば`overrides`。ページの追加・仮想化・実体化・削除は、下のその節）。必要な項目が無い要求は`invalid`で拒否する。コアは書く直前に、そのファイルをディスクから読み直して照合し、1 つでも違えば`conflict`で拒否して、何も書かない。`null`は、そのファイルが無いことを表す。plan cache の指紋（§11）は使わない（同じサイズの書き換えは指紋に現れないため）。書いたあとは、そのページを読み直して一覧と plan cache を更新し、新しい SHA-256 を返す。`pages.overrides`は全ページで 1 つのファイルなので、1 つのページの編集で、`overrides`の SHA-256 は変わる。`conflict`の答えの`current`は、計画を読み直して作るので、今のファイルの SHA-256 を持ち、そのまま次の要求の`expect`に使える

**URL の変更**: 出所に合わせる。

- URL が`outputPathField`の値で決まっているページは、その値を書き換える（出所に書く）
- ファイルの位置で決まっているページは、入力ファイルと、あれば sidecar を移す。移し先は、新しい URL から`pages.outputExtension`で逆算した入力パスに、ページ自身の拡張子を付けたもの。`/a/`を`/b/`にすると、`a/index.*`と sidecar だけが移り、`/a/`の下のページの URL と`parent`は変わらない。`.tsx`/`.jsx`のページは、自分の相対パスの`import`・`export ... from`・`import()`（型だけのもの、`import type`も）を、移し先から、移す前と同じファイルを指すように書き換える（引用符とクエリ・フラグメントはそのまま。パッケージ名などの相対でないものは触らない）。書き換えたページのメタが変わらないことを、書く前に確かめる
- 仮想ページは、`pages.overrides`の`url`を書き換える。`pages.overrides`にそのページの項目があれば、どの場合も`url`を新しいものにする（項目のキーが`url`だから）
- 次のときは、何も書かずに拒否する（`invalid`か`collision`）:
  - 新しい URL が §6 の書き方でない（`?`・`#`・`//`・`.`/`..`のセグメント、`/a/index.html`のような別の URL として読める書き方。読んだ場合の URL をメッセージに添える）
  - 新しい URL が、すでにあるページの URL と重なる（仮想ページと実在のページのあいだは、どちらの向きでも）
  - 出力先が、ほかのページ（仮想を含む）と重なる（`outputPathConflict`の設定に関わらない）
  - ファイルの位置からは作れない URL（最後のセグメントの拡張子が`pages.outputExtension`でもなく、ディレクトリでもない）。`outputPathField`が設定されていれば、メッセージで、そのキーが任意の URL を決められることを案内する
  - 移し先に別のファイルがある。入力ファイルでも sidecar でもよい。ページに sidecar が無くても、移し先に同じ名前の`.json`があれば拒否する。移したページがそれを自分の sidecar として読んでしまうため
  - 移し先が`pages.files`に当たらない、または`pages.ignore`に当たる（計画から消えるため）
  - 移し先が`dir.input`の外（入力ディレクトリの中のシンボリックリンクが指す先を含む）か、出力ディレクトリの中
  - 新しい出力パスが、いずれかの入力ファイルと同じ
- 大文字小文字を区別しないファイルシステムでは、名前の大文字小文字だけを変える移動は拒否しない。移し先の名前が、移すファイル自身を指すため
- `html.*`の`pages`の glob、`sitemap.exclude`、ほかのページの本文のリンク、移したページを`import`しているほかのモジュールは、更新しない
- 移動が全部成功したあとに、移動で空になった元のディレクトリを、`dir.input`の手前までさかのぼって消す。中に何かあるディレクトリは、それより上も含めて残す。`dir.input`そのものと、シンボリックリンクのディレクトリは消さない。消せなかったことは移動の失敗にしない（取り消しの対象は、ファイルの移動と書き込み）。`movePath`も同じ

**パスの変更**（`movePath`）: ファイルの場所そのものを入力にして移す。`moveUrl`は新しい URL から移し先を逆算するが、`movePath`はファイルの位置から URL を決める向き（§5）のまま計算するので、逆算が要らない。

- 入力は`dir.input`からの相対パスとして読む（先頭の`/`も`dir.input`からの意味）。書き方は正規化して受け付ける: `\`は`/`に直し、`./`・`//`・`dir.input`の内側にとどまる`../`は畳む。省いた部分は補う。補う拡張子は、いつも元のファイルの拡張子。末尾が`/`（`.`・`..`で終わるときも）なら`index.<元の拡張子>`、拡張子の無い名前なら`<名前>.<元の拡張子>`（`customer/sending/`は`customer/sending/index.html`、`customer/sending`は`customer/sending.html`）
- 次のときは、何も書かずに`invalid`か`collision`で拒否する:
  - 空のパス、`NUL`を含むパス、正規化した結果が`dir.input`の外
  - 拡張子の変更（`.html`と`.htm`、`.tsx`と`.jsx`も含めてすべて）。補ったあとの最後のセグメントが別の拡張子として読める名前（`v1.2`の`.2`）も同じ
  - 今と同じパス。仮想ページ（ファイルが無い）
  - `moveUrl`のファイルの位置で決まるページと同じ検査に当たるとき。移し先にファイルや sidecar がある。新しい URL・出力先がほかのページと重なる。新しい URL が §6 の書き方でない。移し先が`pages.files`に当たらない、または`pages.ignore`に当たる。出力ディレクトリの中。新しい出力パスがいずれかの入力ファイルと同じ
- URL がファイルの位置で決まるページは、ファイルと、あれば sidecar を移し、URL は新しい場所のものになる。`.tsx`/`.jsx`の相対パスの書き換えと、`pages.overrides`にそのページの項目があるときの`url`の書き換えは`moveUrl`と同じ。URL が`outputPathField`の値で決まるページは、ファイルと sidecar だけを移し、URL は変えない（キーはファイルか sidecar にあるので、一緒に移る。`pages.overrides`の項目も変えない）

**ページの追加・仮想化・実体化・削除**（`create`・`virtualize`・`materialize`・`deletePage`）: ページの有無と、ページがファイルを持つかどうかを変える。ファイルを無くすとページは URL ごと無くなるが、ディレクトリマップを編集しているときは、URL を残して「ここには何も書かれていない」としたいことがある。それが仮想化で、削除とは別の操作にする。どの操作も、書いたあとに計画を読み直す（`version`は 1 増える）。

- **`create`（追加）**: `path`があれば、その場所にページのファイルを作る。`path`は`movePath`と同じ読み方（`dir.input`からの相対、`\`・`./`・`//`・内側の`../`を畳む）で読むが、何も補わない。拡張子を借りる元のファイルが無いので、ファイル名は拡張子まで書く。拡張子は`.html`・`.htm`・`.tsx`・`.jsx`（大文字小文字は区別しない）で、それ以外と、末尾が`/`のパスは`invalid`。ファイルの中身は、`.html`・`.htm`は空、`.tsx`・`.jsx`は何も描かないコンポーネント（`export default function Page() {\n\treturn null;\n}\n`。作った直後のサイトがビルドできる最小の中身）。URL はファイルの位置で決まる（§5）。要求の`url`が`null`ならその URL になり、`url`があって位置の URL と違うときは、`outputPathField`が設定されていればそのキーを作るファイルのメタに書き（書き方はキーの追加と同じ）、設定されていなければ`invalid`
  - `url`があるときは、`path`の有無によらず §6 の書き方でなければ`invalid`。`path`もあるときは、ファイルの位置の URL と違えば（位置から決まる URL が`url`でなければ）上のとおりに扱い、`outputPathField`の値として読んだ結果が`url`と違うときも`invalid`
  - `path`が`null`なら仮想ページを足す。`pages.overrides`の最後の項目の後ろに`{"url":"…","virtual":true}`を足す（その結果、`pages.overrides`に書いたページの最後に並ぶ。§6）。`url`は必須で、§6 の書き方でなければ`invalid`
  - 次のときは、何も書かずに拒否する: 置き場が`movePath`の検査に当たる（`dir.input`の外、出力ディレクトリの中、`pages.files`に当たらない・`pages.ignore`に当たる）。置き場にファイル（シンボリックリンクを含む）か、同じ名前の`.json`がある（`collision`。作ったページがそれを sidecar として読むため）。URL がすでにあるページ（仮想を含む）と同じ、出力先がほかのページか入力ファイルと重なる（`collision`）。`pages.overrides`の無いサイトに仮想ページを足す（`invalid`）
  - `expect`は、仮想ページを足すときの`overrides`だけ。ファイルを作るときは取らない（置き場に何も無いことを、ディスクで直接確かめる）
- **`virtualize`（仮想化）**: ファイルのあるページを仮想ページにする。ページのファイルと sidecar を消し（移動と同じく、空になったディレクトリも消す）、`pages.overrides`の項目にページを残す。項目の`meta`には、ページのファイルと sidecar のメタ（§4 のマージ）を書く。`outputPathField`のキーは書かない（仮想ページの URL は、項目の`url`が決める）。そのページの項目がすでにあれば、その項目に`"virtual": true`を足し、項目の`meta`に無いキーだけを足す（`meta`が無い・`null`の項目には`meta`を作る。項目のキーは §4 で勝っているので、値は変わらない。既存のキーのバイトと項目の場所は変えない）。項目が無ければ、最後の項目の後ろに足す（並び順は、辞書順の側から`pages.overrides`の最後へ移る。§6）。ページの本文は失われる。消したページを`import`しているほかのモジュールは、更新しない
  - 次のときは、何も書かずに`invalid`で拒否する: 仮想ページ。`pages.overrides`の無いサイト。ページのファイルか sidecar が読めない（計画と同じ読み方で失敗する）。URL が仮想ページの URL として読めない（`outputPathField`の値で決まった URL のうち、ファイルの位置からは作れないもの。§6 の「そのまま読むと別の URL になる書き方」）
  - `expect`は`input`・`sidecar`・`overrides`
- **`materialize`（実体化）**: 仮想ページにファイルを持たせる。`path`は`create`と同じ読み方。`path`が`null`なら、URL から`pages.outputExtension`で逆算した場所に作る。拡張子は`.html`・`.tsx`・`.jsx`・`.htm`の順に試し、`pages.files`に当たり`pages.ignore`に当たらず、置き場が空いている（ファイルも同じ名前の`.json`も無い）最初のもの（どれも当たらなければ`invalid`）。ファイルの中身と、位置の URL がページの URL と違うときの扱いは`create`と同じ。項目の`meta`のキーは、作るファイルにキーの追加と同じ書き方で書く。書けないキーがあれば、キーの編集と同じ`code`で拒否して何も書かない。項目は消す。ただし、項目が`lastmod`か、`meta`に`outputPathField`のキーを持つときは残す（このキーは、ファイルに書くと URL を決めてしまうので移さない）。残す項目からは、`virtual`と移したキーだけを消す（`meta`が空になれば`meta`ごと）
  - 仮想ページでなければ`invalid`。置き場と URL の検査は`create`と同じ
  - `expect`は`overrides`だけ
- **`deletePage`（削除）**: ページを無くす。ファイルのあるページは、ファイルと sidecar を消し（空になったディレクトリも消す）、`pages.overrides`に項目があれば項目も消す（残すと、次の計画が「どのページにも一致しない」で失敗する）。仮想ページは、項目を消す。ページの本文は失われ、消したページを`import`しているほかのモジュールは更新しない
  - ページのファイルのディレクトリが、実体では`dir.input`の外にあるとき（途中のディレクトリがシンボリックリンク）は、`virtualize`も`deletePage`も`invalid`で拒否する。そこにファイルを作らない・移さないのと同じく、そこにあるファイルも消さない（消したものは戻せない）。ページのファイルそのものがシンボリックリンクのときは、リンクを消す（指す先は残る）
  - `expect`は、ファイルのあるページは`input`・`sidecar`と、項目があれば`overrides`。仮想ページは`overrides`。項目があるかどうかは、ハンドルが読んだときの内容ではなく、今のファイルで見る（読んだあとに足された項目を、ページの無いまま残さないため）
  - 答えの`page`は`null`（ページが無いので）

**コアの API**（ネイティブ。`packages/kamado`の`ui()`が使う）

```
uiOpen(configPath, optionsJson)    → handle         optionsJson: { cacheDir?, incremental? }
uiPages(handle, queryJson)         → JSON           queryJson:   { offset, limit, q?, sort? }
uiValues(handle, queryJson)        → JSON           queryJson:   { key, limit }
uiRefresh(handle)                  → { version }
uiEdit(handle, editJson)           → JSON
uiServer(handle)                   → { port, open, inputDir, outputDir, overrides }
uiDiffFiles(handle, queryJson)     → JSON           queryJson:   { urls, format }
uiDiff(handle, queryJson)          → JSON           queryJson:   { urls, format, head }
uiClose(handle)                    → { warning }
```

- `uiServer`は、`kamado ui`が待ち受けと表示に使う設定の値を返す。`port`と`open`は`devServer.port`と`devServer.open`（`kamado ui`のポートの既定は`port + 1`）、`inputDir`と`outputDir`は`dir.input`と`dir.output`（絶対パス）、`overrides`は`pages.overrides`のファイル（絶対パス。設定が無ければ`null`）
- `uiOpen`は設定を読んで計画し、`Plan`・`pages.overrides`の内容・各ファイルの SHA-256 をハンドルがメモリに持つ。`incremental`（または`build.incremental`）のときは、前回の plan cache（§11）を読んで計画する。plan cache はハンドルがメモリに持ち続け、`uiClose`で、変わっていれば書く（編集のたびには書かない: 編集は何度も行われ、大きなサイトの cache は数十 MB になる。書かなかった分は、編集したファイルの更新時刻が変わっているので、次に読む側がそのファイルを読み直す）。`uiClose`の`warning`は、cache を書けなかったときの理由で、そうでなければ`null`
- `uiPages`は計画し直さない。窓の各行は、編集できるキーを判断するために、そのページのファイルを（変わるまで 1 回）読む。`q`を渡すと、全ページの URL とメタの文字列値を見て回る。`uiRefresh`は、メモリの plan cache（§11）で計画し直す（ファイルは stat だけ。読めなかったときは、ハンドルは変わらない）
- `uiPages`の`queryJson`は、`offset`と`limit`（どちらも 0 以上の整数。`limit`に上限は無い）で切り出す。`q`があれば、URL かメタの文字列値（一番上の階層）に`q`を含む（大文字小文字は区別しない）ページだけに絞る。返す JSON は次の形。`total`は絞り込み後の件数。`columns`は、メタのキーの和集合（全ページ。`outputPathField`のキーを除く。キー名のバイト順で、大文字が小文字より前）。`version`は、`uiOpen`で 1 になる。計画を読み直すたびに増える（`uiRefresh`、URL の移動、`conflict`を答えるための読み直し）。キーの編集 1 回ごとにも 1 増える。編集 1 回は、どう計画を読み直しても 1 である。拒否された編集は、`conflict`の読み直しのほかには、増やさない。`layouts`は、`pages.layouts.dir`の直下の`.tsx`・`.jsx`のファイルの名前を並べた配列。名前は拡張子なしで、重複なく（`.tsx`と`.jsx`に同じ名前があれば 1 つ）名前のバイト順に並べる。名前の決め方は、レイアウトの解決（§7.3）と同じで、`/`・`\`・`NUL`を含む名前と`.`・`..`は入れない。リンクは辿り、ディレクトリは入れない。`pages.layouts.dir`が無ければ`null`、ディレクトリがまだ無ければ`[]`で、ディレクトリでない・読めないときは`uiOpen`と`uiRefresh`のエラー（`uiRefresh`ではハンドルは変わらない）。読むのは`uiOpen`と`uiRefresh`のときで、`uiPages`のたびには読まない（10 万ページ級でも`readdir`は 1 回）
- `uiPages`の`sort`は`{ "key", "desc"? }`（`null`なら指定なし）で、全ページを並べた順のまま、絞り込んだページを`offset`と`limit`で切り出す（窓の中だけを並べるのではない）。全ページの並びは、計画が変わる（版が上がる）まで、同じ`sort`の問い合わせのあいだ使い回す。`key`は列の識別子で、`url`・`inputPath`・`virtual`・`order`・`outputPath`・`parent`・`depth`、メタのキーは`meta:<key>`（メタのキーが`url`という名前でも`meta:url`なので、取り違えない）。これ以外の`key`と、真偽値でない`desc`（既定は偽）は例外にする
  - 比べ方は`@d-zero/shared`の自然順（`src/sort/`）。`url`・`inputPath`・`outputPath`・`parent`は`pathComparator`（`outputPath`は`dir.output`からの相対パスを`/`で始めて比べる）、メタの値は文字列にして`numericalComparator`。`order`と`depth`は数として比べる（`order`の昇順は計画の順そのもの）。メタの値の文字列は、文字列ならそのまま、数値・真偽値・配列・オブジェクトならコアが JSON を書くときの compact な形（`Value::to_json`。大きな数や小数の書き方は`JSON.stringify`と違うことがあるが、数として読めば同じ値）。`inputPath`は`dir.input`からの相対パスを`/`で始めて比べる。kamado の URL にはホスト・クエリ・ハッシュが無い（§6）ので、`pathComparator`のうちパスの分割、index の優先、basename、拡張子、`href`だけを移す。文字列は JavaScript と同じく UTF-16 コードユニットの順で比べる
  - 値の無いページ（そのキーが無い、`null`、仮想ページの`inputPath`、ルートのページの`parent`）は、昇順でも降順でも末尾。`virtual`は偽が真より先。比べて等しいページは、計画の順を保つ
  - 2 つの値の比べた結果は`@d-zero/shared`と同じで、`crates/kd_core/tests/natural_golden.tsv`（`scripts/generate-natural-golden.mjs`が`@d-zero/shared`から作る）で照合する。ただしこの比べ方は全順序でない: `numericalComparator`は組ごとに共通の接頭辞を除いてから数を読むので、`2a`は`10b`の前、`10b`は`1c`の前、`1c`は`2a`の前、と循環しうる。コアの並べ替えは全順序を前提にしない自前の安定マージソートで、どんな比べ結果でも panic せずに終わる。循環を含む並びは、同じ入力と同じ向きなら同じ出力になるが、V8 の`Array.prototype.sort`と同じ並びは約束しない。循環が無い入力の並び全体を V8 の並びと照合する golden は持たない（2 値の比べ結果が同じで、並べ方は安定ソートなので、並びも同じになるはずのものとして扱う）
- `uiValues`は、メタのキーが全ページで持つ値を数える。`queryJson`は`{ "key": "meta:<key>", "limit" }`（`key`は`meta:`で始まる列の識別子、`limit`は 0 以上の整数。それ以外は例外）。返す JSON は`{ "version", "key", "total", "values": [{ "value", "count" }] }`。`values`は、全ページがそのキーに持つ文字列・数値・真偽値を 1 つずつ、持つページの数（配列の値は項目ごとに数える）とともに並べたもの。件数の多い順で、同じ件数なら計画の順で先に出会ったほうが先。`limit`件までで、`total`は`limit`にかかわらず異なる値の数。`null`・オブジェクト・配列の中の配列は値に数えない。数値の 1 と文字列の`"1"`は別の値。計画は読み直さない（今の計画を 1 回なめる）。列の型を選択肢にするとき、画面が選択肢の初期値を作るために使う

- `uiDiffFiles`と`uiDiff`は、「HEAD との差分」（下の「画面とサーバー」）のためにある。コアは git を呼ばない（子プロセスを起こすのは Node 側）。`format`は`sha1`か`sha256`（`git rev-parse --show-object-format`の答え）。それ以外は例外にする。`urls`の中の知らない URL は飛ばす（画面の窓が、計画より古くなっていることがあるため）
  - `uiDiffFiles`は、`urls`のページ（仮想ページを除く）の入力ファイルと sidecar、あれば`pages.overrides`のファイルについて、今の内容の git blob id を返す: `{ "files": [{ "path", "blob" }], "overrides": { "path", "blob" } | null }`。`path`は設定ファイルのディレクトリからの相対パス（`/`区切り）で、そのディレクトリより上にあるファイル（`dir.input`が`../content`のとき）は`../`で始まる。改行を含むパスは載せない。`blob`は`blob <バイト数>\\0`に内容を続けたもののハッシュ（`git hash-object`と同じ。`core.autocrlf`や`.gitattributes`が効くファイルは、git が持つバイトと違うので、同じ id にならない）で、ファイルが無ければ`null`。blob は、計画が読んだバイトの SHA-256 が変わらないあいだ使い回す（ページと sidecar のファイルを、窓や頁送りのたびに読み直してハッシュしない。全ページで 1 つの大きな`pages.overrides`も同じ）。計画が読んだあとに外で変えられたファイルは、読んで blob を作り、覚えない
  - `uiDiff`の`head`は、`uiDiffFiles`が返した`path`から、HEAD でのそのファイルの状態への対応。状態は次のとおり
    - `null`: HEAD に無い
    - `"ignored"`: HEAD に無く、`.gitignore`に当たる
    - `"skip"`: 比べない（大きすぎる・UTF-8 でない・読めない）
    - `"same"`: blob id が今と同じ
    - `{ "oid", "text"? }`: 違う（`text`は HEAD の内容）
  - ハンドルは、`text`を解析した結果を oid ごとに覚える。`pages.overrides`のものは 1 つで、ページと sidecar のものは 4,096 個まで（満杯のときは、要求の始めに全部捨てる。要求の途中では捨てない）。全ファイルの oid が今と違うサイトで窓が 4,096 個を超えると、窓ごとに解析し直す（そのコストは受け入れる）。覚えていない oid で`text`が無いパスがあれば、比べずに`{ "need": ["<path>", …] }`を返す。呼び手はその分の`text`を足して呼び直す
  - `uiDiff`の答えは`{ "version", "pages": { "<url>": { "url"?: Diff, "inputPath"?: Diff, "meta": { "<key>": Diff } } }, "columns": [...] }`。`Diff`は`{ "kind": "modified" | "added" | "deleted", "head"?: <HEAD の値>, "revertible": true | false, "writes"?: ["inFile" | "sidecar" | "overrides", …] }`（`head`は`deleted`と`modified`にだけ付く。`writes`は`revertible`が真のときの、戻すと書くファイルの出所で、画面が確認のダイアログに書く）。違うページだけを載せる。`columns`は、HEAD にだけあって今はどのページも持たないキー（列が表から消えたもの）で、答えに`deleted`として含まれるものの名前
  - 比べ方は、ページごとに、今のメタと、HEAD のファイルから同じ規則（§4。ページファイル、sidecar、`pages.overrides`の項目をマージする）で作ったメタを、キーごとに比べる。値が違えば`modified`、HEAD に無いキーが今あれば`added`、HEAD にあるキーが今のマージ後に無ければ`deleted`（キーを消して下のソースの値が出ているセルは、値が違えば`modified`）。出所のファイルが変わっても、マージ後の値が同じなら差ではない。オブジェクトの値は、キーの並びが違うだけなら同じ値（フォーマッタやエディタがキーを並べ替えても差にならない）。リストは並びも値のうち。sidecar と`pages.overrides`が`"ignored"`・`"skip"`・`"same"`のときは、今と同じものとして比べる（`"skip"`のときは、戻せないものとして）。ページファイルが`"ignored"`か`"skip"`のページは、そのページのすべて（`pages.overrides`の項目も）を比べない。ページファイルが`null`（HEAD に無い）ページは、`added`として、`url`・`inputPath`・値のあるメタのキー（`pages.overrides`から来た値は`pages.overrides`の HEAD との比べ方に従う）を載せ、`revertible`は偽。`outputPathField`の値は、ページファイルと sidecar の HEAD の値と比べ、違えば`url`の差になる。仮想ページは`outputPathField`のキーを比べず、`url`の差も持たない。仮想ページは、HEAD の`pages.overrides`に同じ URL の項目が無いとき`added`で、`inputPath`の差は持たない。rename は検出しない（ファイルの木全体を HEAD と突き合わせる必要があり、10 万ページで遅いため）。HEAD にあって今は無いページ（ファイルを消したページ）は載せない（HEAD の木全体を計画し直す必要があるため）
  - `revertible`は、`uiEdit`の`revert`が書けるかどうか。偽になるのは次のとき
    - ページファイルが HEAD に無いページのすべての差
    - キーが編集できない（§14.2 の「編集できないもの」）。`outputPathField`の値は、`url`の差としてだけ戻せる
    - HEAD の内容が読めない（§4 の読み方で失敗する）
    - 戻すのに、実在のページへ`pages.overrides`の項目を足す必要がある（足さない規則）
    - sidecar が今無く、戻すのにその sidecar を作る必要がある
    - 今の値がすでに HEAD と同じ（戻すものが無い。ページファイルがキーを 2 回書いているときも、書き換えるキーが決まらないので偽）
  - `uiEdit`の`change`に`{ "op": "revert", "key": "<キー>" | null, "head": { … 上と同じ } }`を足す。`key`が`null`のときは`outputPathField`の値（`url`の差）。ソース（ページファイル・sidecar・`pages.overrides`の項目）のうち、そのキーの値が HEAD と違うものだけを、HEAD の値にする（HEAD に無ければキーを消す）。書き戻しの規則と`expect`は、`set`・`delete`と同じで、複数のファイルに及ぶので「全部か、1 つも書かないか」を通る。`revertible`が偽のものは`notEditable`で拒否する。`head`の`oid`を覚えていなくて`text`も無いパスがあれば、書かずに`{ "ok": false, "code": "need", "need": [...] }`を返す。`version`は 1 増える

```jsonc
{
	"version": 3,
	"total": 1234,
	"columns": ["layout", "title"],
	"layouts": ["sub", "sub-with-side"], // pages.layouts.dir が無ければ null
	"overridesHash": "…", // pages.overrides が無ければ null
	"pages": [
		{
			"url": "/about/",
			"inputPath": "…", // 仮想ページは null
			"outputPath": "…",
			"virtual": false,
			"order": 2, // 計画での並び順（1 から。§6 の順）。絞り込みや sort には依らない
			"depth": 1,
			"parent": "/",
			"hashes": { "input": "…", "sidecar": null }, // 無いファイルは null
			"meta": {
				"title": { "value": "…", "origin": "inFile", "editable": true },
			},
		},
	],
	"warnings": [],
}
```

- `uiEdit`の`editJson`は次の形。ページは`url`で指す（`create`だけは、まだ無いページの URL で、`path`があれば`null`でもよい）。要求がファイルのパスを載せるのは、`movePath`・`create`・`materialize`の`path`だけ。それは`dir.input`からの相対として読み、外に出るものは断る。書く先は、コアが`dir.input`の中と、設定の`pages.overrides`のファイルから決める。`expect`は、`movePath`も`moveUrl`と同じ（移すファイル、あれば sidecar、`pages.overrides`に項目があって URL が変わるなら`overrides`）。`delete`は、そのページに無いキーなら`invalid`

```jsonc
{
	"url": "/about/",
	"expect": { "input": "…", "sidecar": null, "overrides": "…" }, // 触るファイルだけ
	"change": { "op": "set", "key": "title", "value": "…" },
	// または { "op": "delete", "key": "title" }、{ "op": "moveUrl", "url": "/company/" }、
	// { "op": "movePath", "path": "company/index.html" }、{ "op": "revert", "key": "title", "head": { … } }（`/api/edit`は受けない。`/api/revert`だけ）、
	// { "op": "create", "path": "company/index.html" | null }、{ "op": "virtualize" }、
	// { "op": "materialize", "path": "company/index.html" | null }、{ "op": "deletePage" }
}
```

- 結果は`{ "ok": true, "version": …, "overridesHash": …, "page": <pages の 1 要素>, "warning"?: "…" }`。`deletePage`は、ページが無くなるので`"page": null`になる。`warning`が付くのは、編集は済んだが、消すはずのファイルを消せずに別名で残したときだけ。失敗は、`{ "ok": false, "code": …, "message": "…", "current": <pages の 1 要素> }`。`code`は次のいずれか。`conflict`はファイルが読んだあとに変わったとき。`invalid`は値や URL が受け付けられないとき（§6 の書き方でない、キーが無い、`expect`が足りない、書いた結果が意図どおりに読めない）。`collision`は URL・出力先・移し先がほかと重なるとき。`notEditable`は編集できないもの。`notFound`はその URL のページが無いとき（`current`は付かない）。`need`は`revert`が、HEAD の内容を渡されていないファイルを求めるとき（書かずに、求めるパスを`need`に載せて返す）。`io`はファイルの読み書きに失敗したとき（書いたものは取り消してある）。編集の失敗は例外にせず、結果で返す。例外は次のときだけ。設定を読めないとき。計画できないとき。ハンドルが閉じているとき。要求が要求の形でないとき（`url`・`change`が無い、`change.op`が不明、`create`に`url`も`path`も無い、`offset`・`limit`が整数でない、など）
- 計画できないページが 1 つでもあれば（§4 のリテラルでない`export const meta`、不正な front matter）、`uiOpen`はビルドと同じエラーで失敗する

**画面とサーバー**（`packages/kamado`の`ui()`。コアの API ではなく、Node 側の仕様）

- 待ち受けは`localhost`の 2 つのループバックアドレス（§12 と同じ）だけで、ホストを選ぶフラグは無い。要求を受けるのは`localhost`と IP アドレス宛てだけで、別のサイトからと印の付いた要求は`403`（§12 のガードと同じ規則。サイトの`devServer.allowedHosts`は引き継がない）。`GET /`（画面）、`GET /assets/<name>`、`GET /api/pages?offset&limit&q&sort&desc`（`limit`は 1〜5,000。`sort`は列の識別子（`meta:<key>`は 256 文字まで。コアは長さを問わず、この制限はサーバーだけのもの）、`desc`は`true`か`false`。`sort`と`desc`のどちらも渡さないとき（`sort`が空文字で`desc`が無いときを含む）は指定なし。`sort`なしの`desc`、列でない`sort`、長すぎる`meta:<key>`、`true`・`false`以外の`desc`は`400`の`invalidSort`。`offset`と`limit`の誤りは`400`の`invalid`）、`GET /api/values?key&limit`（`key`は`meta:<key>`で 256 文字まで、`limit`は 1〜1,000で既定は 100。誤りは`400`の`invalid`）、`GET /api/git`、`POST /api/diff`、`POST /api/revert`、`POST /api/refresh`、`POST /api/edit`、`GET`と`PUT /api/settings`
- `GET`と`HEAD`以外の要求（`POST`と`PUT`）は、起動のたびに作る 128 bit 以上の乱数のトークンを`X-Kamado-Token`に持たなければならない（`403`）。`POST`と`PUT`は加えて`Content-Type: application/json`（`charset`付きでもよい。`415`）で、`/api/edit`・`/api/diff`・`/api/revert`の本文は 1 MiB 以下（`413`）。トークンは画面の HTML の`<meta name="kamado-token">`にある。すべての答えに`Referrer-Policy: no-referrer`・`X-Content-Type-Options: nosniff`・`Cross-Origin-Resource-Policy: same-origin`と、`Cache-Control: no-store`を付ける。ただし`/assets/`の答えは、プロジェクトのデータを持たず名前が内容で変わらないので、`no-cache`と`ETag`にして、変わっていなければ`304`にする。`GET /`は`default-src 'self'`の CSP も付ける。存在しないルートは`{ "error": "not-found" }`の`404`、コアが例外を投げたときは`{ "error": "failed", "message" }`の`500`
- `GET /api/git`は、サイトのリポジトリの今の branch と commit を`{ "branch": string | null, "sha": string } | null`で返す。設定ファイルのあるディレクトリで`git`を呼んで調べる（`git rev-parse --short=7 HEAD`と`git symbolic-ref --quiet --short HEAD`。引数は固定で、要求の値は渡さない）。`branch`は detached HEAD のとき`null`で、`sha`は短いハッシュ。`git`が無い・リポジトリでない・まだコミットが無い・2 秒以内に答えが来ないときは、エラーにせず本文`null`の`200`で答える。答えは最大 1 秒だけ覚え、続けた要求で`git`を起こし続けない。それより古ければ読み直す（branch は画面を開いたまま切り替わる）。`.git`は自分で読まない（worktree・`packed-refs`・新しい ref の保存形式は`git`に任せる）。ヘッダの表示のために、未コミットの変更の有無は調べない（`git status`は大きなサイトで遅い。セルごとの差分は`POST /api/diff`が、窓のページのファイルだけを調べる）
- `GET /api/pages`の答えは、`overridesFile`（`pages.overrides`のファイル。設定ファイルのディレクトリからの相対パスで、設定が無ければ`null`。絶対パスは載せない）を持つ。画面の凡例とセルの`title`が、ファイルの名前を言うのに使う
- `POST /api/diff`は、窓のページの HEAD との差分を返す（コアの`uiDiffFiles`と`uiDiff`を、`git`で HEAD の状態を調べてつなぐ）。本文は`{ "urls": [...] }`（1〜5,000 件の文字列で、1 つが 4,096 文字まで。形が違えば`400`の`invalid`）で、答えは`{ "head": { "oid" }, "version", "pages": …, "columns": […] } | null`（`pages`と`columns`は`uiDiff`のもの）。`git`が無い・リポジトリでない・まだコミットが無い・時間切れのときは、エラーにせず本文`null`の`200`で答える
  - 最初に`git rev-parse HEAD`で完全な sha（`oid`）を 1 回決め、以降の`git`の呼び出しは`<oid>:<path>`で読む（途中で branch が切り替わっても、別の commit のものが混ざらない）。オブジェクト形式は`git rev-parse --show-object-format`で知る
  - 比べるのは、`uiDiffFiles`が返したファイルだけ。`git cat-file --batch-check`で`<oid>:./<path>`（`./`で、パスは`git`を動かすディレクトリからになる。設定ファイルがリポジトリの途中にあってもよい）の oid を求めて今の blob id と比べ、違うものだけ`git cat-file --batch`で中身を取って`uiDiff`に渡す。HEAD に無いファイルは、`git check-ignore --stdin -z`で`.gitignore`に当たるかを調べる（prebuild が作る`pages.overrides`のように、追跡しないファイルを「追加」にしないため）。パスは stdin で渡し、引数は固定で、要求の値は渡さない（`GIT_OPTIONAL_LOCKS=0`）。使う`git`は`rev-parse HEAD`・`rev-parse --show-object-format`・`rev-parse --show-cdup`（設定ファイルのディレクトリから、リポジトリの先頭までの段数。それより上のファイルは比べない）・`cat-file --batch-check`・`cat-file --batch`・`check-ignore --stdin -z`で、1 回の呼び出しは 10 秒で時間切れにする。1 MiB を超える中身（`pages.overrides`は 256 MiB まで）、UTF-8 でない中身、リポジトリの外のファイル、改行を含むパスは、比べない（`skip`）。symlink のページファイルと、git のサブモジュールの中のファイルは扱わない（既知の制限。symlink は blob の中身がリンク先のパスになり、常に違うものになる。サブモジュールの中は HEAD に無いものとして、追加になる）。`git status`は呼ばず、rename は検出しない（理由は`uiDiff`）
- `POST /api/revert`は、セルを HEAD の値に戻す。本文は`{ "url", "expect", "key", "head" }`（`key`は列のキーで 256 文字まで。`url`の列は`null`。`expect`はオブジェクト。`head`は`POST /api/diff`の答えの`oid`で、40 桁か 64 桁の 16 進数。形が違えば`400`の`invalid`）。サーバーが HEAD の内容を`git`で取り、コアの`uiEdit`の`revert`に渡す（HEAD の内容は要求から受け取らない）。答えと状態は`/api/edit`と同じ。HEAD を読めないときは`409`の`noHead`、今の HEAD の oid が`head`と違うときは何も書かずに`409`の`headMoved`（画面が見せた値と違う値に戻さないため）。`/api/edit`は`op: revert`を`400`の`invalid`で断る
- `POST /api/edit`の本文は`{ "url", "expect", "change" }`（`expect`と`change`はオブジェクト。`url`は文字列で、`change.op`が`create`のときだけ`null`でもよい。形が違えば`400`の`invalid`で、コアは呼ばない）
- 編集の答えは、コアの`code`を HTTP の状態にして返す: `conflict`と`collision`は`409`、`invalid`と`notEditable`は`400`、`notFound`は`404`、`io`は`500`。本文は`{ "error": <code>, "message", "current"? }`。成功した`deletePage`の答えは`"page": null`のまま返す
- `GET /api/settings`は、画面の設定を`{ "global": { "locale" }, "project": { "pageSize", "updatedAt", "sort"?, "columns"?, "kinds"? } | null, "warning": string | null }`で返す（`project`はこのプロジェクトの分だけで、ほかのプロジェクトの項目も、設定ファイルのパスも載せない。まだ保存が無ければ`null`）。`PUT /api/settings`は`{ "global"?: { "locale"?: "auto" | "en" | "ja" }, "project"?: { "pageSize"?: 100 | 500 | 1000 | 5000, "sort"?: { "key", "desc"? } | null, "columns"?: { "order"?, "pinned"?, "widths"? } | null, "kinds"?: { "meta:<key>": { "type": "enum", "options": [...] } } | null } }`（`sort`は`GET /api/pages`の列の識別子。`null`でソートを解く。`columns`は列の並びと固定と幅で、渡すと 3 つをまとめて置き換え、`null`で既定に戻す。`kinds`は列の選択肢で、`columns`とは別に扱う。渡すと全部を置き換え、`null`と`{}`で全部なくす）を保存して、保存後の`GET`と同じ形で返す（本文は 64 KiB 以下で`413`。許されない値は`400`の`invalid`。知らないフィールドは捨てる）。設定ファイルが新しい版のときは`409`の`newer`、ロックが取れないときは`503`の`locked`、ディスクの失敗は`500`の`failed`（メッセージにパスを入れず、エラーコードだけ）。`PUT`もトークンと`Content-Type`の規則（上）に従う
- **画面の設定の保存**: `~/.config/kamado/ui-settings.json`（環境変数`KAMADO_UI_SETTINGS`があればそのファイル。`XDG_CONFIG_HOME`は読まない）に持つ。形は`{ "version": 1, "global": { "locale": "auto" | "en" | "ja" }, "projects": { "<設定ファイルの実体パス>": { "updatedAt", "pageSize", "sort"?, "columns"?, "kinds"? } } }`。画面の設定は、言語（`global.locale`）と 1 画面の行数（`project.pageSize`）と並び（`project.sort`: `{ "key", "desc" }`。無ければ計画の順）と、列の並び・固定・幅（`project.columns`: `{ "order"?, "pinned"?, "widths"? }`）と選択肢の列（`project.kinds`）。画面が足した列（「キーの追加」）そのものは保存しない（その列の並びと固定と幅は保存する）
  - プロジェクトは設定ファイル（`kamado.config.jsonc`）の実体パスで見分け、`projects`のキーはそのパス。許されない値は既定（`auto`と 500）にして、知らないフィールドは捨てる。`sort`では、`key`が列の識別子でなければ`sort`ごと捨て、`desc`が真偽値でなければ偽にする。`columns`では、`order`と`pinned`は列の識別子（`sort`の`key`と同じ）の重複のない配列、`widths`は列の識別子から 48〜2,000 の整数への対応で、識別子でないもの・重複・範囲外の幅は捨てる（どれも 500 件まで。3 つの配列が本文の 64 KiB に収まる大きさで、`PUT`は、許されない形だと全体を`400`にして何も書かない。`columns`が空のオブジェクト`{}`のときは`null`と同じで、既定に戻す）。`pinned`が無いときは`url`だけが固定で、空の配列は固定なし。`sort`・`columns`・`kinds`を足す前の kamado は、それらを知らないフィールドとして捨てるので、次の保存で失う（版は 1 のまま）
  - `kinds`は、列の識別子（`meta:<key>`の列だけ）から`{ "type": "enum", "options": [...] }`への対応。列の識別子は`meta:<key>`で 256 文字まで（`sort`の`key`と同じ）。`options`は 1〜200 個の、200 文字（UTF-16 のコードユニット）以下の文字列・有限の数値・真偽値で、重複しない（数値の 1 と文字列`"1"`は別）。`kinds`全体は JSON で 12 KiB 以下（`columns`の 48 KiB と合わせて、変更の本文の 64 KiB に収まる大きさ）。`PUT`は、許されないものが 1 つでもあると全体を`400`にして何も書かない。ファイルの読み込みは、許されない列・選択肢を捨て、12 KiB に収まるところまで先頭から取る
  - ファイルは所有者だけが読み書きできる（`0600`。ディレクトリは`0700`）。ほかのプロジェクトのパスを持つため
  - 書くときは`<file>.lock`を`wx`で作ってロックを取る。10 秒より古いロックは、落ちたプロセスのものとして取り直す。ロックの中でファイルを読み直し、自分のプロジェクトの項目と`global`だけを置き換えて、一時ファイルを書いて rename する。別のプロジェクトで動く`kamado ui`の保存を消さず、読む側が書きかけを見ないため
  - 壊れたファイルは、`kamado ui`の起動時に`<file>.<YYYYMMDDHHmmss>.bak`へ移して、空から作り直す。端末にはファイルのパスつきで、画面には名前だけで警告する。壊れたとは次のどれか: JSON でない。トップレベルがオブジェクトでない。`version`が 1 以上の整数でない。`global`か`projects`がオブジェクトでない
  - 列の識別子（`sort`の`key`と`columns`の 3 つの一覧）は、その版が知っているものだけを読む。新しい版が足した列（`order`・`outputPath`・`parent`・`depth`）を、古い版が知らずに保存すると、その列の分は消える（`version`を上げない方針の代償で、フィールドを足したときと同じ）
  - `version`が 1 より大きいファイルは、新しい kamado が書いたものなので、読まず・書かず・移さずに、既定値で起動して警告する。古い kamado が新しい kamado の設定を消さないため
- **列の並び・固定・幅**: 画面の列は、どの行も必ず持つ 7 列（ページそのものの`url`・`virtual`・`inputPath`と、計画が決める`order`・`outputPath`・`parent`・`depth`）とメタのキーで、識別子は`url`・`virtual`・`inputPath`・`order`・`outputPath`・`parent`・`depth`・`meta:<key>`（`sort`の`key`と同じ）。`order`・`outputPath`・`parent`・`depth`は読み取り専用（`order`は計画での並び順で、§6 のとおり`pages.overrides`に書いた順が先に来る。ページをほかの値から変えると変わる）。既定の並びはこの 7 列のあとにメタのキーを名前順に並べたもので、既定で固定される（左端に止まる）のは`url`だけ。`order`を設定したあとは、その順に並べ、`order`に無い列（あとから増えたキーなど）を既定の並びで後ろに足す。固定した列は`order`にかかわらず先頭に、固定した順に並び、`position: sticky`で左端に止まる。行は`content-visibility: auto`で画面の外の描画を省くが、固定した列は、描画を省かれた行が画面に入ってくるときも、左端に止まる。並べ替えは固定した列どうし・固定していない列どうしの中だけで行い（越えるには固定か解除をする）、固定を解いた列は`order`に残した元の場所に戻る。幅は 48〜2,000 px の整数で、既定は`url` 448・`virtual` 96・`inputPath` 384・`order` 96・`outputPath` 384・`parent` 320・`depth` 96・メタのキー 224（既定の幅は保存しない）。操作は、見出しの`⋮`ボタン・`Alt+↓`（見出しでもセルでも）・メニューキー・`Shift+F10`で開く列のメニュー（左に固定/解除、左へ/右へ、昇順/降順/解除、幅を広げる/狭める/戻す）。見出しのドラッグで並べ替え、見出しの右端のドラッグで幅を変えられる（ダブルクリックで既定の幅）。変えるたびに`columns`の 3 つ全部を`PUT /api/settings`で保存する。今のサイトに無い列の設定は、表示せずに残す（500 件まで）。メタのキーが固定の列と同じ名前（`url`・`virtual`・`inputPath`・`order`・`outputPath`・`parent`・`depth`）のときは、その列の見出し・列のメニュー・幅や並びの知らせ・編集欄の名前を`<key>`（メタ）にして、固定の列と見分ける（書き込むキーは`<key>`のまま。列の識別子は`meta:<key>`なので、並び・固定・幅の保存には関わらない）
- **値の編集（真偽値・リスト・選択肢）**: セルの編集欄の種類は、値から決める（BurgerEditor v4 に合わせる）。真偽値はセルにチェックボックスを描き、クリック・`Space`・`Enter`で反転する。そのキーを持たないページは、その列のこの画面にある値が真偽値だけなら、空のチェックボックスで見せ、反転で`true`を書く。文字列・数値・真偽値だけの配列（空の配列も）は、項目ごとの入力欄（追加・削除・上下への移動。追加する項目の型は選べる）で編集し、「JSON として編集」で JSON の欄に切り替えられる（オブジェクトを含む配列やオブジェクトは JSON の欄のまま）。列のメニューの「選択肢から選ぶ型にする…」は、メタのキーの列を選択肢の列にする。選択肢の初期値は`uiValues`（上限 200）で作り、ダイアログで足す・消す。選択肢の列のセルは、値が 1 つならセレクトボックス（選ぶと書く）、値が配列（またはその列が配列を持つ画面で値の無いセル）なら選択肢ごとのチェックボックス（`Enter`かセルを出たときに書く。触らずに出たら書かない）で編集する。セルの値が選択肢に無いときも、その値を選択肢に足して見せ、選び直すまで書き換えない。空の選択肢は出さない。キーを消すのはこれまでどおり`Delete`。オブジェクトを含む値は、選択肢の列でも JSON の欄。`meta:layout`の列は、`uiPages`の`layouts`が`null`でなければ、何も設定しなくても選択肢の列になり、選択肢は`layouts`（保存した`kinds`に`meta:layout`があっても`layouts`を使う）。選択肢はファイルで決まり、画面で足す・消すものではないので、この列のメニューには「選択肢から選ぶ型にする…」「選択肢を編集…」「値の型に戻す」を出さない。「読み直す」（`uiRefresh`）で`layouts`も読み直す。`pages.layouts.dir`が無いサイトでは、`layout`の列はほかのキーと同じ扱い
- **ファイルの場所の編集**: `inputPath`のセルは、どのページでも編集できる。編集欄には今の`inputPath`（`dir.input`からの相対パス。仮想ページは空）が入り、Enter で`movePath`を送る。確認のダイアログは出さず（結果は表と git の差分で確かめられる）、今と同じ値なら何も送らない。成功したら、`url`の移動と同じく一覧を読み直して、移したページに移る。仮想ページのセルにパスを書くと、`materialize`を送る（空のままなら何も送らない）
- **ページの追加・仮想化・削除の操作**: ファイルやページが無くなる操作は、ダイアログで確かめてから送る。ダイアログは、消えるファイルの名前（ページのファイルと、あれば sidecar。`dir.input`からの相対パス）と、ページの本文も一緒に失われることを書き、最初のフォーカスを「キャンセル」に置く。`git`の状態（未コミットかどうか）は見ない。ダイアログは、先に頼んだ編集が終わってから開き、そのときの行のハッシュを`expect`として覚える（ダイアログが見せたファイルを消す。開いているあいだに変わったファイルは`conflict`になる）
  - `inputPath`のセルを空にして確定すると（空白だけも空）、ファイルを無くすことになるので、「仮想化」「削除」「キャンセル」を尋ねる。「仮想化」は`virtualize`、「削除」は`deletePage`を送る。`pages.overrides`の無いサイトでは「仮想化」を押せず、その理由を書く
  - `virtual`のセルは編集できるチェックボックス（真偽値の列と同じく、クリック・`Space`・`Enter`で反転する）。ファイルのあるページでチェックを入れると、「仮想化」「キャンセル」を尋ねて`virtualize`を送る（`pages.overrides`の無いサイトでは、尋ねずにその理由を知らせる）。仮想ページでチェックを外すと、`path`が`null`の`materialize`を送る（ファイルを足すだけなので尋ねない。場所を選ぶなら`inputPath`に書く）。チェックボックスを続けて 2 回押したときの 2 つ目は、1 つ目でページがもうその状態になっているので、送らない
  - `url`のセルを空にして確定すると（空白だけも空）、URL の無いページは無いので、「削除」「キャンセル」を尋ねて`deletePage`を送る（仮想ページも）
  - ヘッダの「ページの追加」は、URL と`inputPath`の欄のあるダイアログを開く。どちらか 1 つは要る。`inputPath`があれば`create`を送る（URL の欄が空なら`url`は`null`）。`inputPath`が空なら、ファイルの無い仮想ページになる。「仮想ページとして追加しますか」と尋ねてから、`path`が`null`の`create`を送る（何も消さないので、このダイアログの最初のフォーカスは追加のボタン。`pages.overrides`の無いサイトでは、尋ねずにその理由を知らせる）。ファイルを作る要求がコアに拒否されたとき（置き場に何かある、URL が位置と合わない、など）は、その理由を知らせる
  - 成功したら、一覧をファイルから読み直す（ページの並び順が変わるため）。足した・仮想化した・実体化したページに移り、そのページが画面のこのページに無いとき（別の頁、検索に当たらない）は、そう言い添える
- **ヘッダの git の表示**: ヘッダに`GET /api/git`の`branch @ sha`を出す（detached HEAD は sha だけ。`null`のときは何も出さない。読み上げ用の名前は付ける）。最初の一覧のときと、一覧をファイルから読み直すたび（「読み直す」・画面に戻ったとき・移動のあと）に取り直す。答えが取れなかった・取りやめた（次の一覧を求めた）ときは、次の一覧のときにまた取る。取れなくても一覧の読み込みは失敗にしない
- **出所のラベルと凡例**: メタのセルは、値の出所（§14.2 の「書く場所」）が sidecar か`pages.overrides`のとき、セルの下端に小さな文字で「sidecar」「overrides」と書く（ページのファイルは、いちばん多いので書かない）。全行を同じ高さにして（ラベルの無い行も 1 行分を取る）、行の高さがスクロールで変わらないようにする。セルの`title`は「<出所のファイルの名前>に書いてある値」（`pages.overrides`は設定の実際のファイル名）で言う。表の下のフッター（`<footer>`）に、凡例の`<p>`を 1 つ置く（閉じるボタンは無い。表の上には置かない: 凡例の行は`git`の答えで出入りするので、表の下に置いて、それで表の行が動かないようにする。`<footer>`には、読み上げ用の名前（画面の言語で「印の意味」）を付ける）: ラベルの意味（ラベルなし＝ページのファイル、sidecar＝ページの隣の`.json`、overrides＝`pages.overrides`のファイルの名前。この項目は`pages.overrides`を設定したときだけ）と、`git`が答えたときは、HEAD（`branch @ sha`。ヘッダの`GET /api/git`が答えなかったときは、`HEAD`とだけ）との差の印の意味（変更・追加・削除。クリックか`Alt+Backspace`で戻せること）。`overridesFile`は、設定ファイルのディレクトリの外にあるファイルなら、ファイルの名前だけにする。セルの左端に出所の印（線）は置かず、出所はラベルで示す。左の余白は、帯のために、全セルで 24px にする
- **HEAD との差分の表示と戻す**: セルの左端に、HEAD と違う値のしるしを 5px の罫線で出す。種類は 3 つで、色で分ける: 変更は青、追加は緑、削除は赤（VS Code の`editorGutter.modifiedBackground`・`addedBackground`・`deletedBackground`の慣例）。罫線は、通常・読み取り専用・フォーカス中の 3 つの背景（ライトとダーク）に対して 3:1 以上のコントラストにする。種類の名前は、`title`と`aria-description`の文字でも伝える。罫線の部分は、押せる 24px のボタン（WCAG 2.2 の 2.5.8）で、マウスでだけ使う（`tabindex="-1"`）。キーボードでは、フォーカスのあるセルで`Alt+Backspace`と、列のメニューの「HEAD の値に戻す」で戻す。`revertible`が偽のセルは、罫線だけでボタンにしない。押す（キーを押す）と、「今の値 → HEAD の値」と、戻すと書き込むファイル（`writes`）を見せる確認のダイアログを出し、確かめてから`POST /api/revert`を送る。送る`head`と`expect`は、ダイアログを出した時点（その前の編集が済んだ時点）のもので、確認を押した時点のものではない（見せた値と違うものを書かない）。直しても一覧は読み直さず、答えのページ 1 行を差し替え、そのページの差分を取り直す。HEAD にだけあって今はどのページも持たないキーは、`columns`で列として足し、赤い罫線の空のセルから戻せる。この列は、いま見ている窓のページが消したキーだけなので、ページ送りや検索で窓が変わると出入りする（全ページの HEAD を見ないための、10 万ページでも速くするための選び方）
  - 差分を取るのは、一覧を読むたび（最初・読み直す・移動のあと）の窓の URL と、編集・戻すのあとのそのページ。取れなくても、一覧は失敗にしない。`git`が答えないときは、罫線も凡例の差の項目も出さない
- **画面の言語**: `global.locale`が`ja`か`en`ならその言語。`auto`（既定）は、ブラウザの第一言語（`navigator.languages`の先頭）が`ja`なら日本語、そうでなければ英語。画面は設定を読んでから最初の描画をする（言語を変えて描き直さない）。読めなかったとき（3 秒以内に答えが来ない、エラー）は、待たずに既定値で描いて、「設定を読めなかった」と画面に出す。保存は、その後の変更から使える。翻訳するのは画面の文面（ボタン、ラベル、状態、エラーの説明）で、サーバーとコアの文面（エラーの`message`、警告、編集できない理由）と、列・キーの名前は訳さず、そのまま出す。画面から言語を切り替えると保存する
- ブラウザに絶対パスを渡さない。`inputPath`は`dir.input`から、`outputPath`は`dir.output`からの相対パス（`/`区切り）にし、メッセージと警告の中の設定ファイルのディレクトリ・`dir.input`・`dir.output`は`<root>`・`<input>`・`<output>`に置き換える（ディレクトリの名前が、より長い名前の先頭のときは置き換えない）。`dir.input`の外にあるファイルは、名前だけにする。メタの`reason`も同じ置き換えを通す。この 3 つのディレクトリの外のパスは置き換えない（コアの文面に出ない）。ホームディレクトリやプロジェクトのフォルダ名を、画面に持たせないため
- 画面は`packages/kamado/client`の React で、パッケージのビルドが`dist/ui`にまとめる（実行時の依存は増えない）。表は ARIA の grid で、1 画面に最大 5,000 行を DOM に置き、画面の外の行は`content-visibility: auto`で描画を省く

## 15. sitemap

`sitemap.output`に XML を書く。対象は`include`の glob（出力ディレクトリ基準、既定`**/*.html`）から`exclude`を除いたもの。`index.html`は末尾スラッシュの URL。`lastmod`: `"manifest"`は`pages.overrides`の値、`"mtime"`はファイルの更新時刻、`"none"`は出力しない。URL の起点は`site.baseURL`（`https://example.com/sub/`のように完全な URL）、なければ`https://<site.host>`。どちらもなければ設定エラー。`output`は出力ディレクトリの中でなければならない。仮想ページ（`pages.overrides`）も載り、`lastmod: "mtime"`は入力ファイルの更新時刻（仮想ページは出さない）。差分ビルドや`targets`を指定したビルドでも、計画の全ページから毎回書く。1 ファイルに載せられる URL は 5 万件までなので、超えるときは`sitemap-1.xml`、`sitemap-2.xml`、…（`output`のファイル名に`-番号`を付けたもの）に分け、`output`はそれらを並べたインデックス（`sitemapindex`）にする。URL に空白や日本語があれば`%XX`に符号化する。**分けるのは件数だけ**で、1 ファイル 50MB（非圧縮）の上限は見ない（1 件が 1KB を超えるほど`lastmod`などを付けると超えうる）。**古いファイルは消さない**（§5）ので、ページ数が減って分割がなくなった、または分割数が減ったとき、前のビルドの`sitemap-N.xml`が出力に残る。配信の前に消すのは`build.report`を使う postbuild の仕事。

## 16. 並列モデルと純粋性

- Rust のスレッドプールが、パース・DOM・整形・圧縮・画像・I/O を処理する。JSX の描画は`worker_threads`が並列に行う（`--jobs`で数を指定）。
- コンポーネントは純粋関数（§7.2）。モジュールの変数にページをまたいで状態を貯めない。`ctx.emit`のようなページ間の集計 API は提供しない（集計したいなら`build.report`を使う。描画に依らない、ページの一覧と階層なら§14.1）。

## 17. 論点と決定

| #   | 論点                                                          | 決定                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Q2  | `html.rules`の`pages`は出力 URL か入力パスか                  | 出力 URL（`/a/b/`や`/a/b.html`）。ユーザーが見るのは URL                                                                                                                                                     |
| Q3  | `HTML`ページ（`.html`）での JSX                               | 不可。`.html`は HTML としてのみ扱い、レイアウトだけが JSX                                                                                                                                                    |
| Q4  | `pages.files`の既定に`.md`を含めるか                          | 含めない（v2 にもない）                                                                                                                                                                                      |
| Q5  | `Html`型の実体（文字列のラッパークラス / ブランド型の文字列） | 文字列のラッパークラス（ランタイムの`Markup`）。型は同梱しない。ただし`html()`の戻り値の型`HtmlChild`は除く（§7.2）                                                                                          |
| Q6  | `kamado/jsx`を公開するか                                      | `./jsx`として export する。ユーザー向けの名前は`html`（と、その戻り値の型`HtmlChild`）と`styleOf`だけで、それ以外（コンパイル後の JS が使う`Markup` `el` `k` `c` `a` `render`など）は内部 API で、変更しうる |

Q1 は欠番（番号の飛びで、内容は記録に残っていない）。

| #   | 論点                                                             | 決定                                                                                              |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Q7  | アドオンを、プラットフォーム別のパッケージに分けるか、同梱するか | **同梱する**（§18）。ロックファイルを共有する環境の違いに依存しないことと、公開の単純さを優先した |

## 18. 配布

v3 は`kamado`の 1 パッケージで公開する（v2 は`v2`ブランチで保守していて、公開済みの v2 は npm に残る）。版は`lerna.json`が正本で、Cargo（`Cargo.toml`の`[workspace.package]`と`Cargo.lock`）は`yarn release*`（`scripts/release.mjs`）が`lerna version`のあとに`scripts/sync-cargo-version.mjs`で同じ版に揃え、リリースコミットに含める（アドオンの`version()`は公開した版を返す）。公開のパイプラインは`.github/workflows/publish.yml`。

**アドオンは`kamado`に全プラットフォーム分を同梱する**（プラットフォーム別のパッケージには分けない）。Rust のコアは、プラットフォームごとにビルドした共有ライブラリ（N-API のアドオン、`kd_napi`。`libkd_napi.dylib`/`libkd_napi.so`）で、`kamado`の中に`native/<os>-<arch>/kd_napi.node`として置き、実行時に`process.platform`と`process.arch`で選ぶ。

- 対象のプラットフォームは、macOS（arm64/x64）と Linux（x64/arm64、glibc）。WSL2 は Linux として扱う。Windows のネイティブと musl は対象外（§2 #24）。日常の CI（`.github/workflows/rust.yml`）が確認しているのは macOS arm64、Linux x64、Linux arm64。macOS x64 は公開のワークフロー（`publish.yml`）の実機（`macos-15-intel`）で、公開の前に読み込みを確認する。
- 読み込む場所は、環境変数`KAMADO_NATIVE_ADDON`で指定したファイル（開発用）、同梱した`native/<os>-<arch>/kd_napi.node`、`target/release`、`target/debug`の順（`packages/kamado/src/native.ts`）。
- 公開（`publish.yml`）は、版の検査（Cargo、パッケージ、タグが`lerna.json`と一致）、OS ごとのビルドと読み込み確認、1 つのジョブでの詰め込みと`yarn pack`、できた tarball を 5 つの実機（上の 4 つと Ubuntu 24.04）で展開して読み込む確認（`scripts/check-package-addon.mjs`）、その tarball そのものの`npm publish`（OIDC Trusted Publishing、provenance、dist-tag は版から決める）の順に進む。手で起動（`workflow_dispatch`）すると、公開の手前までの予行になる。npm の信頼設定と provenance は`kamado`の 1 つだけ。
- Linux のアドオンは glibc 2.35 の環境（`ubuntu-22.04`）でビルドする。バイナリはビルドした環境の glibc に依存するので、新しい環境でビルドすると、Ubuntu 22.04 の WSL2 などで読み込めない。macOS は`MACOSX_DEPLOYMENT_TARGET=13.5`（Node 24 の下限）でビルドする。

**なぜ分けないか**: 実際のプロジェクトでは、macOS、WSL2 ほかの環境の人が同じ`package.json`とロックファイルを共有する。プラットフォーム別のパッケージを`optionalDependencies`で参照する方式（esbuild など）では、あるプラットフォームで作ったロックファイルが、別のプラットフォームでの解決に失敗することがある。同梱なら、全員が同じ 1 つのパッケージを取るだけで、ロックファイルに環境の違いが出ない。バイナリは 1 プラットフォームあたり約 2.8 MB で、全部で約 11 MB。分けるとパッケージが 5 つになり、信頼設定と公開の順序、途中で失敗したときの部分的な公開の後始末も要る。

サイズが問題になる（対象のプラットフォームが増える、バイナリが大きくなる）ときは、分割を再検討する。移行しても、利用者の側（`kamado`の`import`や CLI）は変わらない。
