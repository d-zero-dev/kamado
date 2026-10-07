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
| `pageList(fn)`（スプレッドシート由来など）                    | `pages.overrides`（prebuild が JSON に書く。§2.1）                                                        |

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

### 2.1 `pageList` と、それにぶら下がる設定

v2 の `pageList()` と `transformBreadcrumbItem` / `filterNavigationNode` を使う構成は、次のように置き換える。

- **一覧は prebuild で JSON にする**（`pages.overrides`、RFC §6）。`meta` には**シートに値があるキーだけ**を書く。`null` を書くと、ページ自身の front matter の同じキーを隠す（v2 は一覧のメタをナビゲーション用にだけ使い、ページ自身の変数は front matter から取った）。ファイルに書いたページが、書いた順で `pages` の先頭に並び、`nav()` の表示順になる。
- **一覧にないページ**: v2 は一覧に載らないページを `nav()` と `breadcrumbs` に出さなかった。v3 は常にすべてのページを索引に入れる。ナビゲーションから隠すなら、そのページに `{ "url": "/x/", "meta": { "navHidden": true } }` を書く。ページのタイトル（`<title>` とパンくず）は v3 では自分の front matter の値になる（v2 は一覧になければサイト名）。
- **`transformBreadcrumbItem`** はコンポーネントに書く（`link.href` を `link.meta.realHref ?? link.href` に）。**`filterNavigationNode`** は `nav()` の結果を再帰で絞るヘルパーを書く（子から先に絞り、`keep(node)` が偽なら捨てる）。
- **`<!-- @include(...) -->` のコメントを出力する transform** は `html.includes` の `includeComment`（`root` は `/` 始まりの基準ディレクトリ）に、**BurgerEditor の `importBlock`** は `burgerEditorImport`（`root` は入力ディレクトリ）に、`data-bgi-ver` を消す正規表現は `html.rules` の `removeAttr` に、`©` などを実体参照にする transform は `html.entities` に置き換える。`manipulateDOM` が全ページから要素を消していたなら `html.rules` の `remove`。
- **Pug のページだけ幅 90**: `.html` は prettier の設定が 100000、`.pug` は 90 だったので、Pug だったページの出力 URL を `html.overrides` に並べて `{ "format": { "printWidth": 90 } }` にする。幅の計測は、属性を圧縮した後の長さで行う（v2 は圧縮前）。
- **別のコンパイラ設定が同じファイルを別の transform で処理していたとき**（サブサイトだけ `manipulateDOM` と include を外していた、など）は `html.overrides` の `pages` に URL の glob を書いて、`includes` / `rules` を `[]` にする。
- **ビルド出力を `include` していた Pug**（出力の `header.html` を別の Pug が読む）は、v3 では出力の順序に依存させず、元のコンポーネントを直接呼ぶ。

## 3. ページ: Pug → JSX

v3 のページは **`.html`（front matter 付き）と `.tsx` の 2 種類**です。Pug は廃止しました。

### 3.1 ファイルの置き換え

- `foo.pug` → `foo.tsx`。同じ場所に置く。出力パスは変わりません（拡張子だけ `.html` になる）。
- `foo.pug` のメタ（Pug 内の変数や front matter）→ `export const meta = { ... }`（**リテラルのみ**。式や変数は書けない）。
- 同名の `foo.json`（sidecar）はそのまま使える。優先順位は高い順に、`pages.overrides`、sidecar `.json`、ファイル内の `meta`。
- ページは `export default` でコンポーネントを書く。props の型は同梱しない（必要なら使う側で宣言する）。

```tsx
export const meta = { title: 'About', layout: 'default' };

export default ({ meta }: { meta: { title: string } }) => (
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

`node scripts/pug-to-tsx.mjs <project> <out>` は、`__assets` の `.pug` をコンポーネント（`.tsx`）に直す。`include` はコンポーネントの呼び出し（include する側の props とスコープの変数を渡す）、`each` は `map`、`if` は `&&` / `?:`、`pkg.production.*` は `site.*`、`filters.date` は `formatDate` になる。`mixin` は大文字で始まるコンポーネント、`else if` は入れ子の `?:`、`include` したテキスト（生の HTML）は `html()` になる。表現できないもの（唯一の子でない `!{}` など）は止まるので、手で直す。出力は必ず読む。実案件（Pug のスキャフォールド）で試して見つかった点:

- **属性名は React の綴り**: `charset` → `charSet`、`itemprop` → `itemProp`、`itemtype` → `itemType`、`itemid` → `itemID`。小文字のままだと、`<meta charset>` は先頭に置かれず、`<meta itemprop>`（パンくずの `position`）が `<head>` に持ち上げられる。
- **`&nbsp;` などの実体参照は、そのままテキストに書く**（`{"&nbsp;"}` と文字列にすると `&amp;nbsp;` になる）。
- **他の子と並ぶ生の HTML**は、`kamado-v3/jsx` の `html()` で書く（`import { html } from 'kamado-v3/jsx'`、`{html(markup)}`）。Pug の `!{}` と `include` したテキストの置き換え先。
- **`<option selected>`** は React が無視する。`<select defaultValue="...">` に書く。
- **`<link media="all">`** は空にならず `all` のまま出る（v2 と同じ）。
- **JSX に書けない属性名**（絵文字など、`⚠️="..."` のような印）は React が出力しない。静的なマークアップなら `html.inject` に HTML 文字列として書く。
- **React 19 は `<img>` ごとに `<link rel="preload" as="image">` を `<head>` に足す**（Pug では出ない）。`<html static>` のページでは出ない。それ以外のページで要らなければ `html.rules` で消す: `{ "selector": "link[rel=preload][as=image]", "action": "remove" }`。
- **Pug の `pretty`**（`createCompileHooks` の既定は `true`）は、インラインでないタグの前と、ブロックを含むタグの閉じタグの前に改行を入れる。これは空白として出力に残り、インライン要素の隣では見た目も変わる。変換スクリプトに `--pretty` を付けると、同じ規則で `{"\n"}` を書き出す（付けなければ空白は入らない）。v2 の出力と揃えるなら `--pretty`、`pretty: false` の基準と比べるなら付けない。
- **Pug の出力順をそのまま保つ**: 変換スクリプトは `<html static>` を出す。React の持ち上げ（`<head>` の `async` な `script` が `title` の前に出る）と、`form` / `input` / `button` の属性の並べ替え（`action` と `name` が後ろへ）をやめ、書いた順で出す。`<html>` を持たない、`--pages=<ディレクトリ>`（既定 `htdocs`）で指したディレクトリの下のページ（フラグメント）と `extends` したページには `export const meta = { kdStatic: true }` を出す（`<html static>` の外で評価される子を持つページは、手で書くときも `kdStatic` が要る。レイアウトの外側で評価される子や、`k('html', ...)` 経由の `html` は対象外）。
- **`on*` 属性の文字列**（`oncontextmenu="return false;"`）は、`<html static>`（`kdStatic` のページ）の中でだけ出る。React と同じく、ふだんは `on*` をすべて捨てる（データ由来の props が実行可能な属性にならないように）。
- **`style` を CSS の文字列で渡す**（`style=\`anchor-name: ${x}\``）は、`kamado-v3/jsx`の`styleOf()` を通してオブジェクトにする。
- **`data-*` / `aria-*` に `false`**: Pug は属性を出さず、React は `"false"` と書く。変換スクリプトは `false` を `undefined` にして出す。
- **`if (x)` が `0` を返す式**: Pug は何も出さず、JSX の `x && <b/>` は `0` を出す。変換スクリプトは `!!` を付ける。
- **未宣言の変数への代入**（`- isHome = false`）は、変換スクリプトが `let` を足す。
- **`#{tag}`（動的なタグ名）** は大文字の変数に入れたコンポーネントとして書く（文字列の型を `k()` が受け取る）。
- **`extends` / `block`**: レイアウトは `slots` の props を受け取るコンポーネント、ページは `slots={{ content: (...) }}` を渡す。`block vars` の `var opts = ...` は props の既定値と、ページから渡す値になる。
- **変換スクリプトが止まるもの**: `block append` / `block prepend`、`&attributes`、引数が仮引数より多い `+mixin`、自分自身を読む宣言（`var title = title || "x"`）。止まったら手で書く。コード中の `if` / ループは、読む変数を props から取って変換する。`--pretty` は `pre` / `textarea` の中の字下げを再現しないので、その中身は出力を見て確かめる。
- **mixin と本文が同じファイル**（`header.c-header ...` と `mixin ...` が並ぶ）は、mixin は名前つき export、本文は `export default` のコンポーネント（`〜Body`）になる。**mixin に渡すブロック**（`+pSub` の下に書いた中身と、mixin の中の `block` / `if block`）は `children` になる。`locals["blocks-v2"]` はデータファイルの値（`props.data`）。データファイルの名前（`blog_news.yml` なら `blog_news`）は、Pug の変数として読んでいた箇所が `data.blog_news` になる。
- **Pug の代入**（`- breadcrumbs = pageBreadcrumbs`、`- x = true` ... `- x = false`）は、その位置で実行され、props の名前への代入はローカルの変数（初期値は props の値）になる。include したファイルと mixin には、その変数が渡る。
- **`//` のコメント**（Pug が HTML コメントにする）は JSX に書けないので消える。
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
- **PostCSS のプラグインのうち、`@custom-media` は組み込み**です（D-ZERO の `@d-zero/postcss-config` の `postcss-custom-media`）。定義はどのファイルにあっても使え、定義は出力から消え、`@media (--name)` が定義の条件に置き換わります（`and` で並べた条件、リストの定義、ネストした `@media` も）。定義が別の定義を使っていても、`true` / `false` の定義も使えます。未定義の名前と、リストの定義への `not (--x)` は置き換えません。定義が media type で始まるもの（`screen and (...)`）は、他の条件と並べると不正なクエリになりえます。**ほかのプラグイン**（autoprefixer、`postcss-extend-rule`、`postcss-base64`、`postcss-math` / `postcss-calc`、`postcss-color-mod-function`、`postcss-clip-path-polyfill`）は使えません。案件の CSS がそれらを使っているかは、`@extend`、`base64(`、`color-mod(`、`math(` を検索して確かめます。autoprefixer だけは、最新ブラウザ向けの browserslist なら足すプレフィックスが数個（`-webkit-box-decoration-break` など）なので、書いておけば済みます。
- postcss-import と同じ扱い: `@import` のあとに書いた `@layer a, b;`（順序の宣言）は、取り込んだ内容より前、バナーより前に移る。取り込んだファイルの `@charset` は先頭に 1 つだけ残り、値が違えばエラーになる。
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

## 8.5 d-zero/builder（11ty）からの移行

kamado の前身の `@d-zero/builder`（Eleventy ベース）で作られた案件も、同じ手順（変換スクリプトで Pug → TSX、`.html` はそのまま）で v3 に移せる。Shift_JIS と CRLF で配信するサイトでも、下の対応表の設定で builder の出力に揃えられる。builder の設定と v3 の対応:

| builder（`eleventy.config.mjs`）                                                 | v3                                                                                                                                                |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `charset: { encoding: 'shift_jis', overrides: [{ paths, encoding: 'utf8' }] }`   | `html.encoding: "shift_jis"` と、`html.overrides` の `{ "pages": [...], "encoding": "utf8" }`。`pages` は**出力 URL**（`/a/index.html` は `/a/`） |
| `lineBreak: '\r\n'`                                                              | `html.lineBreak: "crlf"`                                                                                                                          |
| `prettier: { tabWidth: 4, useTabs: true }`                                       | `html.format: { "tabWidth": 4, "useTabs": true }`                                                                                                 |
| `minifier: { minifyCSS: false }`（HTML Minifier の他の機能は何も有効にならない） | `html.minify: { "redundantAttributes": false, "css": false }`（空の `class=""` を残し、`style` 属性を圧縮しない）                                 |
| `characterEntities: true`                                                        | `html.entities: "all"`                                                                                                                            |
| builder が DOM を jsdom で書き戻す（属性の `&amp;`、`<path></path>`、`&nbsp;`）  | `html.serializer: "spec"`                                                                                                                         |
| `autoDecode`（入力が Shift_JIS）                                                 | **未対応**（入力は UTF-8）                                                                                                                        |
| `ssi`（開発サーバーで `<!--#include virtual-->` を展開）                         | ビルドでは何もしない（コメントのまま残る）。展開が要るなら `html.includes` の `ssi`                                                               |
| `banner()`                                                                       | `styles.banner` / `scripts.banner` の文字列（`{{date:YYYY-MM-DD}}` `{{year}}`）                                                                   |
| `eleventy-pug-plugin` の `filters.cjs`（`:name` が `data/<name>.html` を返す）   | `data/<name>.html` を置く。変換スクリプトは `:name` を `html(data[name])` にする                                                                  |

builder の出力と揃えるときの違い（実案件で見つけたもの）:

- **インラインの `<script>`**: builder は terser、v3 は esbuild で圧縮する。意味は同じで、バイトは違う（GTM のスニペットなど）。
- **画像の寸法**: builder は属性に書いた `height` があっても画像の実寸で上書きすることがある。v3 の `html.imageSizes`（既定）は v2 と同じ（書いてあれば残す）。SVG の寸法の丸めも違う。画像は出力ディレクトリから読むので、出力ディレクトリに画像が要る。
- **`<pre>` の中の字下げ**: 変換スクリプトの `--pretty` は再現しない。
- **`.html` に混ざった SSI のコメント**: そのまま残る（HTML のコメントは消えない）。
- **Pug が `include` する出力ディレクトリのファイル**（`../../../<出力ディレクトリ>/img/icon.svg` のような SVG）: 変換スクリプトはその時点のファイルを読んで文字列にする。
- **生の HTML を書いた Pug**（`<meta ...>` の行、`| <!--#include ... -->`）は `html("...")` になる。`//` のコメントも HTML のコメントとして残る。
- 参照できないパッケージ（`node_modules` が無い）の TS は、`scripts.files` を絞って後回しにできる。

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
- どれかのページのメタ（front matter、sidecar、`pages.overrides`）を直すと、`pages` / `nav` などを読むかどうかにかかわらず、JSX で描画する全ページが再ビルドされる（`.html` ページは再ビルドされない）。

### 9.3 開発サーバー

`kamado server` を起動し、ページ・CSS・JS・出力ディレクトリの静的ファイルを開く。コンポーネントを 1 つ直して再読み込みし、反映を確かめる。プロキシを使うなら `devServer.proxy` の経路も確かめる。

## 10. 出力に差が出る既知の点

意図した差です（`docs/v3/RFC.md` §2 の番号つき）。これ以外の差は、v3 の不具合か移行の誤りです。

| 内容                                                                                                                                         | RFC  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 本文中の `<?php ... ?>` を v2 は**削除**した。v3 は保持する                                                                                  | #21  |
| `<title>` 中の `&amp;` と `&lt;` の扱い（展開すると意味が変わる並びだけ、展開しない）                                                        | #27  |
| `<script>` の開始タグの属性値に `><` を含むとき、v2 は本文が壊れた                                                                           | #28  |
| `characterEntities` を v2 は `<script>` / `<style>` の中も置換した。v3 は置換しない                                                          | #29  |
| 断片の途中の `<!doctype>` で v2 は内容を落とした                                                                                             | #30  |
| `breadcrumbs` の起点（`site.baseURL` のパス部分）                                                                                            | §7.3 |
| YAML の日付が文字列                                                                                                                          | #19  |
| CSS の圧縮結果（cssnano と同じ意味で、バイトは違いうる。サイズは近い。`initial` を `normal` に縮める `reduce-initial` などは移植していない） | §10  |
| `<script>` の圧縮結果（terser と esbuild）                                                                                                   | §10  |
| prettier の幅（入力ごとから統一へ）                                                                                                          | #15  |
| HTML のコメント（JSX には書けない）。`<head>` 内の並び（React 19 の持ち上げ）                                                                | §7.1 |
| フォームの属性の並び（`action` と `method` は React が最後に出す）                                                                           | §7.1 |

## 11. 困ったとき

- 設定エラーは、キーのパスと理由を出して止まります。
- ページのビルド失敗（JSX の構文エラー、存在しないレイアウト、`meta` に式を書いた）は、ファイルと行・列を出します。
- 描画の途中で落ちたときは `Failed to render <path>: <message>`。`<path>` のコンポーネントを見ます。
- 速度の確認: `KAMADO_TIMING=1`（JavaScript 側）と `KD_TIMING=1`（コア側）を付けて実行すると、フェーズごとの時間が出ます。
