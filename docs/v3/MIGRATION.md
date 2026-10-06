# kamado v2 → v3 移行手順

この文書は **AI が上から順に実行できる手順書**です。各ステップに「やること」「確認すること」を書いてあります。仕様の根拠は `docs/v3/RFC.md`（破壊的変更の一覧は §2）。

v3 は v2 と**出力（HTML）がバイト一致**することを目標にしています。移行の合格条件は「同じ入力から、v2 と v3 の出力ディレクトリを比べて差がない（差があるなら §10 の意図した差だけ）」ことです。

## 0. 進め方

1. v2 のままビルドして、**基準の出力**を残す（§1）。
2. v3 の設定とソースを用意する（§2〜§8）。ソースは**コピー**して直す。v2 のツリーは壊さない。
3. v3 でビルドして、基準と比べる（§9）。差が出たら §10 の表で意図した差か確かめ、違えば原因を直す。
4. 開発サーバーと差分ビルドを確かめる（§9）。

迷ったら、まず出力の差を見ます。ソースを見て推測するより、差のある 1 ページを小さくして原因を探すほうが速く確実です。

## 1. 基準の出力を作る

```sh
# v2 のプロジェクトで
yarn kamado build --force
cp -R <output dir> /tmp/baseline-v2   # 出力ディレクトリを丸ごと保存
```

- 確認: 出力ディレクトリのファイル数を控える。
- v2 の prettier 設定が入力の種類で違う（`.pug` / `.tsx` は幅 90、`.html` は幅 100000 など）場合、v3 は**入力によらず 1 つの幅**です。合わせるには v3 の `html.format.printWidth` を v2 の値にします（`.pug` と `.tsx` が多数なら 90）。幅を超えない小さなページでは差が出ません。

## 2. 設定ファイル（TS / JS → `kamado.config.jsonc`）

v3 の設定は **JSONC のみ**（関数は書けない）。ファイルは `package.json` と同じディレクトリに置く。相対パスは設定ファイルのディレクトリ基準です。

| v2                                                            | v3                                                                                                        |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `dir: { root, input, output }`                                | `dir: { input, output }`（root は設定ファイルの場所）。**`input` と `output` は異なる**                   |
| `pkg.production.{host,baseURL,siteName,siteNameEn}`           | `site.{host,baseURL,siteName,siteNameEn}`（未指定なら `package.json` の `production` から読む）           |
| `compilers: (def) => [def(createPageCompiler(), {...}), ...]` | `pages` / `styles` / `scripts` の 3 セクション                                                            |
| `createPageCompiler` の `files` / `ignore`                    | `pages.files` / `pages.ignore`（既定 `**/*.{html,tsx}`）                                                  |
| `layouts: { dir }`                                            | `pages.layouts.dir`                                                                                       |
| `globalData: { dir, data }`                                   | `data: { dir, values }`                                                                                   |
| `outputPathField` / `outputPathConflict`                      | `pages.outputPathField` / `pages.outputPathConflict`                                                      |
| `createScriptCompiler` の `alias` / `minifier`                | `scripts.alias` / `scripts.minify`                                                                        |
| `createStyleCompiler` の `alias`                              | `styles.alias`                                                                                            |
| `banner`（文字列または関数）                                  | `styles.banner` / `scripts.banner`（文字列。`{{date:YYYY-MM-DD}}` `{{year}}` `{{version}}`。`""` で無効） |
| `devServer: { port, host, open, startPath }`                  | 同じ名前                                                                                                  |
| `devServer.proxy[prefix].pathRewrite: (p) => ...`             | `rewrite: { from: "^/api", to: "" }`（`from` は正規表現）                                                 |
| `onBeforeBuild` / `onAfterBuild`                              | §7                                                                                                        |

例:

```jsonc
{
	"$schema": "./node_modules/kamado/schema.json",
	"dir": { "input": "src", "output": "htdocs" },
	"pages": {
		"ignore": ["_libs/**"],
		"layouts": { "dir": "src/_libs/layouts" },
		"alias": { "@": "./src/_libs" },
	},
	"data": { "dir": "src/_libs/data" },
	"html": { "format": { "printWidth": 90 } },
	"scripts": { "alias": { "@": "./src/js" } },
	"styles": { "alias": { "@": "./src/css" } },
}
```

**未知のキーはエラー**です。エラーメッセージのパス（`pages.files` など）を見て直します。

## 3. ページ: Pug → JSX

v3 のページは **`.html`（front matter 付き）と `.tsx` の 2 種類**です。Pug は廃止しました。

### 3.1 ファイルの置き換え

- `foo.pug` → `foo.tsx`。同じ場所に置く。出力パスは変わりません（拡張子だけ `.html` になる）。
- `foo.pug` のメタ（Pug 内の変数や front matter）→ `export const meta = { ... }`（**リテラルのみ**。式や変数は書けない）。
- 同名の `foo.json`（sidecar）はそのまま使える。優先順位は高い順に、`pages.overrides`、sidecar `.json`、ファイル内の `meta`。
- ページは `export default` でコンポーネントを書く。

```tsx
export const meta = { title: 'About', layout: 'default' };

export default ({ page, meta, data }: PageProps) => (
	<main>
		<h1>{meta.title}</h1>
	</main>
);
```

### 3.2 Pug の構文 → JSX

| Pug                                 | JSX                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `div.card(data-x='1')`              | `<div className="card" data-x="1">`                                                                                                 |
| `#id` / `.a.b`                      | `id="..."` / `className="a b"`                                                                                                      |
| `p= text`（エスケープあり）         | `<p>{text}</p>`                                                                                                                     |
| `p!= html`（エスケープなし）        | `<p dangerouslySetInnerHTML={{ __html: html }} />`                                                                                  |
| `if cond` / `else`                  | `{cond ? <A /> : <B />}`、または `{cond && <A />}`                                                                                  |
| `each item in items`                | `{items.map((item) => <li>{item}</li>)}`（`key` は不要）                                                                            |
| `mixin card(title)` と `+card('x')` | コンポーネント `const Card = ({ title }) => ...` と `<Card title="x" />`                                                            |
| `include ./header`                  | `import { Header } from './_libs/Header'` と `<Header />`                                                                           |
| `extends layout` と `block content` | レイアウトのコンポーネント。`meta.layout` に `layouts.dir` のファイル名（拡張子なし）を書く。レイアウトは `content` prop を受け取る |
| `:markdown` などのフィルター        | 事前に HTML にして `.html` / データにする、または JS で変換して `dangerouslySetInnerHTML`                                           |
| `- const x = ...`（コード）         | コンポーネントの本文の JS                                                                                                           |
| コメント `//` / `//-`               | `{/* ... */}`                                                                                                                       |
| `doctype html`                      | 書かない（`html.doctype` が出力する）                                                                                               |
| `pretty` オプション                 | 書かない（整形は `html.format`）                                                                                                    |
| `script.` / `style.` のブロック     | `<script dangerouslySetInnerHTML={{ __html: code }} />`                                                                             |

注意:

- JSX の空白は React と同じ規則（行頭行末の空白と改行は消える。意図した空白は `{' '}`）。Pug の空白との差は、出力の比較で見つかります。
- `<br>` などの空要素は `<br />` と書く。
- 関数の props（`onClick` など）は無視されます（警告）。
- hooks（`useState` など）と Context は使えません。コンポーネントは**純粋関数**（同じ props から同じ出力。モジュールの変数を書き換えない）。ワーカーが並列に描画するので、破ると結果が不定になります。
- `import` できるもの: 相対パスと `pages.alias` の別名の TS / TSX / JSON、npm パッケージ（ESM）。CSS の import はできません。
- TS は **erasable な構文だけ**（`enum` / `namespace` / パラメータプロパティは不可。`const` オブジェクトで置き換える）。

### 3.3 ページに渡されるもの

`page`、`meta`、`site`、`data`、`pages`、`nav(options)`、`breadcrumbs`、`titleList(options)`、`formatDate(value, format)`。レイアウトは加えて `content`。v2 の `pageList` は `pages`、`filters.date` は `formatDate`、`pkg` は `site` です（`pkg.production.*` の値は `site.*`）。

- `nav` の `filter` / `comparator`、`breadcrumbs` の変換（`transformBreadcrumbItem`）は廃止。返ってきた配列を JSX 側で加工する。
- `breadcrumbs` の起点は `site.baseURL` の**パス部分**（`https://example.com/sub/` なら `/sub/`）。v2 は値をそのまま数えたので、フル URL を書くと上位 2 階層が欠けていた（出力が変わる）。
- YAML の日付（`date: 2026-01-02`）は**文字列のまま**渡る（v2 は front matter だけ `Date`）。`formatDate()` に渡せば同じ表示になる。

### 3.4 変換スクリプトと、変換で見つかった注意点

`node scripts/pug-to-tsx.mjs <project> <out>` は、`__assets` の `.pug` をコンポーネント（`.tsx`）に直す。`include` はコンポーネントの呼び出し（include する側の props とスコープの変数を渡す）、`each` は `map`、`if` は `&&` / `?:`、`pkg.production.*` は `site.*`、`filters.date` は `formatDate` になる。表現できないもの（テキスト中の生の HTML、唯一の子でない `!{}`）は止まるので、手で直す。出力は必ず読む。実案件（Pug のスキャフォールド）で試して見つかった点:

- **属性名は React の綴り**: `charset` → `charSet`、`itemprop` → `itemProp`、`itemtype` → `itemType`、`itemid` → `itemID`。小文字のままだと、`<meta charset>` は先頭に置かれず、`<meta itemprop>`（パンくずの `position`）が `<head>` に持ち上げられる。
- **`&nbsp;` などの実体参照は、そのままテキストに書く**（`{"&nbsp;"}` と文字列にすると `&amp;nbsp;` になる）。
- **JSX に書けない属性名**（絵文字など、`⚠️="..."` のような印）は React が出力しない。静的なマークアップなら `html.inject` に HTML 文字列として書く。
- **React 19 は `<img>` ごとに `<link rel="preload" as="image">` を `<head>` に足す**（Pug では出ない）。要らなければ `html.rules` で消す: `{ "selector": "link[rel=preload][as=image]", "action": "remove" }`。
- **Pug の `pretty`** は要素の間に空白を入れる（v2 の既定は `true` かもしれない）。インライン要素の中のブロックの整形が JSX と変わるので、比較の基準にするときは `pretty: false` で出す。
- **データ**: `data.yml` と `blocks.js` のようなファイルは、Pug ではファイル名がそのまま変数（`data`、`blocks`）だった。v3 では `data.<ファイル名>`（`data.data`、`data.blocks`）。`.js` のデータは文字列を返すだけなら、中身の HTML をそのままデータのディレクトリに置く（`blocks.html`）。
- **レイアウトの指定**は拡張子なし（`"layout": "sub.pug"` → `"sub"`）。
- `scripts.files` は、ページ以外の入力に合わせて絞っておくと意図が明確になる（`"js/**/*.ts"` など）。`alias` の相対パスは `__assets/_libs` のように `.` なしでも、プロジェクトにあるパスならパスとして扱う。

## 4. データ

- `globalData.dir` の `.json` / `.yml` / `.yaml`（v2 は `.yaml` を無視）と、文字列として読む `.html` / `.txt` が使える。キーはファイル名（拡張子なし）。
- `.js` のデータ（default export、関数）は**廃止**。値を計算する処理は、prebuild のスクリプトで JSON に書き出す（`"prebuild": "node scripts/build-data.mjs"`）。
- `globalData.data`（設定内のリテラル）は `data.values`。同じキーは設定が優先。

## 5. HTML 後処理（transforms / manipulateDOM / injectToHead / SSI）

v2 の既定の transform（doctype → prettier → minifier → lineBreak）は v3 の既定のままです。独自のものは宣言的オプションに置き換えます。

| v2                                                           | v3                                                                                                                                |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `manipulateDOM` で要素を削除                                 | `html.rules`: `{ "selector": "...", "action": "remove" }`                                                                         |
| 属性の追加・変更・削除、クラスの追加・削除                   | `setAttr` / `removeAttr`（名前は `/regex/` も可）/ `addClass` / `removeClass`                                                     |
| 要素を包む・外す、HTML の挿入                                | `wrap` / `unwrap` / `insert`                                                                                                      |
| `ctx.getHref` / `ctx.baseURL` で URL を書き換え              | `rewriteUrl`（`absolute` / `rootRelative`、`origin`）                                                                             |
| `injectToHead({ content, position, filter })`                | `html.inject`: `{ "html": "...", "position": "head-end", "pages": [...], "mode": "build" }`（`mode: "serve"` は開発サーバー限定） |
| `devServer.transforms`（開発サーバーの応答の変換）           | `html.inject` の `mode: "serve"`                                                                                                  |
| `createSSIShim`                                              | `html.includes`: `{ "preset": "ssi", "dir": "..." }`                                                                              |
| `<!-- @include(...) -->` の独自実装                          | `{ "preset": "includeComment", "root": "..." }`                                                                                   |
| BurgerEditor の import ブロック                              | `{ "preset": "burgerEditorImport" }`                                                                                              |
| `characterEntities`                                          | `html.entities`: `"all"` または `{ "©": "&copy;" }`                                                                               |
| imageSizes                                                   | `html.imageSizes`: `{ "enabled": true, "exclude": [...], "keepAuthored": false }`                                                 |
| 特定ページだけ整形・圧縮を切る                               | `html.overrides`: `[{ "pages": ["/php/**"], "format": false, "minify": false }]`                                                  |
| `formatOptions.parseError`（`silent` / `warning` / `error`） | `html.onError`（同じ 3 値）                                                                                                       |

`html.rules` などの `pages` は**出力 URL**に対する glob です（入力パスではない）。

## 6. スタイルとスクリプト

- スタイル（`styles.files`、既定 `**/*.css`）は v3 が自前で処理します（`@import` の展開、alias、圧縮、バナー、source map）。**postcss.config のプラグインは使えません**。autoprefixer などが要るなら、npm scripts で別に処理してから kamado に渡します。
- `@import` の解決: alias（`@/x.css`）、importing ファイルからの相対パス、`node_modules`（パッケージの `style` → `.css` の `main` → `index.css`）の順。
- スクリプト（`scripts.files`、既定 `**/*.{js,ts,jsx,tsx,mjs,cjs}`）は esbuild（`bundle: true`）です。`alias` / `define` / `target`（既定 `es2022`）/ `minify` / `sourcemap` / `banner` が使えます。**`pages.files` に一致するファイルはスクリプトとして扱いません**（`.tsx` はページ）。
- **v2 と出力を揃えたいとき**: v2 は esbuild に `target` を渡さない（esnext）。構文が `es2022` で変わるコードでは `"scripts": { "target": "esnext" }` にする。
- `<script>` の中身とイベントハンドラは esbuild で圧縮されます。v2（terser）とバイトは違いますが意味は同じです。

## 7. onBeforeBuild / onAfterBuild

廃止です。ビルド全体で 1 回だけの処理は kamado の外に出します。

- 前処理（データ生成、ファイルのコピー）→ `package.json` の `"prebuild"`。
- 後処理（古い出力の削除、別サイトへのコピー、通知）→ `"postbuild"`。何が出力されたかは **`build.report`** に書かれた JSON（`version` / `pages` / `assets` / `warnings`）で分かる。`"build": { "report": "build-report.json" }` を設定する。
- sitemap.xml は組み込み: `"sitemap": { "exclude": [...], "lastmod": "manifest" }`。URL の起点は `site.baseURL`（なければ `https://<site.host>`）。
- 古い出力は削除されません（v2 と同じ）。削除は `build.report` を使う postbuild で。

## 8. 開発サーバー

`kamado server`（設定は `devServer`）。v2 との違い:

- ファイルを監視しません（v2 と同じ）。リクエストごとに依存の stat を確かめ、変更がなければメモリの出力を返します。
- ページファイルの**追加と削除**、設定ファイル・`pages.overrides` の変更は、**再起動**すると反映されます。
- コンポーネントを直すと、次のリクエストで描画用のワーカーが作り直されます（初回は少し遅い）。
- ブラウザのライブリロードはありません。

## 9. 検証

### 9.1 出力の比較

```sh
yarn kamado build --force
node benchmarks/v3/compare-outputs.ts /tmp/baseline-v2 <v3 output dir>
```

- `identical`（バイト一致）の割合を見る。`different` のファイルを 1 つ選び、差を見て §10 の表と照らす。
- `extra`（v3 だけにあるファイル）: v2 の設定でビルドしていなかったスタイル / スクリプトが v3 では出力されている場合。意図したものか確かめる。

### 9.2 差分ビルド

```sh
yarn kamado build --incremental        # 初回: すべて built
yarn kamado build --incremental        # 2 回目: すべて cached
# ページを 1 つ直して
yarn kamado build --incremental        # そのページだけ built
```

- 共有のレイアウトやコンポーネントを直すと、それを使うページだけが再ビルドされる。
- データファイル（`data.dir`）を直すと、JSX で描画するページが再ビルドされる。

### 9.3 開発サーバー

`kamado server` を起動し、ページ・CSS・JS・出力ディレクトリの静的ファイルを開く。コンポーネントを 1 つ直して再読み込みし、反映を確かめる。プロキシを使うなら `devServer.proxy` の経路も確かめる。

## 10. 出力に差が出る既知の点

意図した差です（`docs/v3/RFC.md` §2 の番号つき）。これ以外の差は、v3 の不具合か移行の誤りです。

| 内容                                                                                  | RFC  |
| ------------------------------------------------------------------------------------- | ---- |
| 本文中の `<?php ... ?>` を v2 は**削除**した。v3 は保持する                           | #21  |
| `<title>` 中の `&amp;` と `&lt;` の扱い（展開すると意味が変わる並びだけ、展開しない） | #27  |
| `<script>` の開始タグの属性値に `><` を含むとき、v2 は本文が壊れた                    | #28  |
| `characterEntities` を v2 は `<script>` / `<style>` の中も置換した。v3 は置換しない   | #29  |
| 断片の途中の `<!doctype>` で v2 は内容を落とした                                      | #30  |
| `breadcrumbs` の起点（`site.baseURL` のパス部分）                                     | §7.3 |
| YAML の日付が文字列                                                                   | #19  |
| CSS の圧縮結果（cssnano と同じ意味で、バイトは違いうる。サイズは近い）                | §10  |
| `<script>` の圧縮結果（terser と esbuild）                                            | §10  |
| prettier の幅（入力ごとから統一へ）                                                   | #15  |
| HTML のコメント（JSX には書けない）。`<head>` 内の並び（React 19 の持ち上げ）         | §7.1 |
| フォームの属性の並び（`action` と `method` は React が最後に出す）                    | §7.1 |

## 11. 困ったとき

- 設定エラーは、キーのパスと理由を出して止まります。
- ページのビルド失敗（JSX の構文エラー、存在しないレイアウト、`meta` に式を書いた）は、ファイルと行・列を出します。
- 描画の途中で落ちたときは `Failed to render <path>: <message>`。`<path>` のコンポーネントを見ます。
- 速度の確認: `KAMADO_TIMING=1`（JavaScript 側）と `KD_TIMING=1`（コア側）を付けて実行すると、フェーズごとの時間が出ます。
