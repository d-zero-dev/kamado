# kamado v2 → v3 移行手順

この文書は **AI が上から順に実行できる手順書**です。各ステップに「やること」「確認すること」を書いてあります。仕様の根拠は`docs/v3/RFC.md`（破壊的変更の一覧は §2）。

v3 はこのリポジトリの`packages/kamado`（npm 名`kamado`、bin は`kamado`、JSX のランタイムは`kamado/jsx`）です。alpha の開発中で、dist-tag `alpha`で公開します（`docs/v3/RFC.md` §18）。v2 は`v2`ブランチで保守しています。公開済みの v2（`kamado@2.0.0-alpha.17`など）は npm に残っています。`@kamado-io/*`の 5 つのパッケージ（page/script/style/pug/jsx のコンパイラ）は v3 にはなく、機能は`kamado`に組み込まれています（RFC §2 の #3、#22）。

v3 は v2 と**出力（HTML）がバイト一致**することを目標にしています。移行の合格条件は「同じ入力から、v2 と v3 の出力ディレクトリを比べて差がない（差があるなら §11 の意図した差だけ）」ことです。

## 0. 進め方

1. v2 のままビルドして、**基準の出力**を残す（§1）。
2. v3 の設定とソースを用意する（§2〜§9）。ソースは**コピー**して直す。v2 のツリーは壊さない。
3. v3 でビルドして、基準と比べる（§10）。差が出たら §11 の表で意図した差か確かめ、違えば原因を直す。
4. 開発サーバーと差分ビルドを確かめる（§10）。

迷ったら、まず出力の差を見ます。ソースを見て推測するより、差のある 1 ページを小さくして原因を探すほうが速く確実です。

## 1. 基準の出力を作る

```sh
# v2 のプロジェクトで
yarn kamado build --force
cp -R <output dir> /tmp/baseline-v2   # 出力ディレクトリを丸ごと保存
```

- 確認: 出力ディレクトリのファイル数を控える。
- 出力をリポジトリにコミットしているなら、それも基準になります。上とは別のディレクトリに取り出します（`<ブランチ>:<output dir>`と書くと、`<output dir>/`を付けずに取り出せる）。

  ```sh
  mkdir -p /tmp/baseline-v2-committed
  git archive <ブランチ>:<output dir> | tar -x -C /tmp/baseline-v2-committed
  ```

  公開中の出力が古い v2 の版でビルドされているときは、今の v2 でビルドし直したもの（`/tmp/baseline-v2`）と、コミット済みのものの両方と比べます。v2 の版の違いで出力が変わっていることがあります。

- v3 の整形に**幅の設定はありません**（`html.format.printWidth`は廃止。書くと設定エラー）。長い行も折り返さず、折れるのは強制改行のときだけです。v2 が幅 100000 で整形していた出力（`.html`の既定）とは、100000 桁を超える行（巨大な`data:` URI を持つ属性など）を除いて、バイトまで一致します。v2 の prettier 設定が入力の種類で違い（`.pug`/`.tsx`は幅 90、など）、幅 90 で折り返された出力は、長い行の折り返しの位置が一致しません（意味は同じ）。基準の出力で、属性が 1 行ずつに折り返されていないかを見て確かめます。

## 2. 設定ファイル（TS / JS → `kamado.config.jsonc`）

v3 の設定は **JSONC のみ**（関数は書けない）。ファイルは`package.json`と同じディレクトリに置く。相対パスは設定ファイルのディレクトリ基準です。

| v2                                                            | v3                                                                                                       |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `dir: { root, input, output }`                                | `dir: { input, output }`（root は設定ファイルの場所）。**`input`と`output`は異なる**                     |
| `pkg.production.{host,baseURL,siteName,siteNameEn}`           | `site.{host,baseURL,siteName,siteNameEn}`（未指定なら`package.json`の`production`から読む）              |
| `compilers: (def) => [def(createPageCompiler(), {...}), ...]` | `pages` / `styles` / `scripts`の 3 セクション                                                            |
| `createPageCompiler`の`files` / `ignore`                      | `pages.files` / `pages.ignore`（既定`**/*.{html,tsx}`）                                                  |
| `createPageCompiler`を使わない（CSS / JS だけを出す）設定     | `"pages": { "files": [] }`（ページなし。何にも一致しない glob を書かない。RFC §3.1）                     |
| `layouts: { dir }`                                            | `pages.layouts.dir`                                                                                      |
| `globalData: { dir, data }`                                   | `data: { dir, values }`                                                                                  |
| `outputPathField` / `outputPathConflict`                      | `pages.outputPathField` / `pages.outputPathConflict`                                                     |
| `createScriptCompiler`の`alias` / `minifier`                  | `scripts.alias` / `scripts.minify`                                                                       |
| `createStyleCompiler`の`alias`                                | `styles.alias`                                                                                           |
| `banner`（文字列または関数）                                  | `styles.banner` / `scripts.banner`（文字列。`{{date:YYYY-MM-DD}}` `{{year}}` `{{version}}`。`""`で無効） |
| `devServer: { port, host, open, startPath }`                  | 同じ名前。`allowedHosts`が加わる（§8）                                                                   |
| `devServer.proxy[prefix].pathRewrite: (p) => ...`             | `rewrite: { from: "^/api", to: "" }`（`from`は正規表現）                                                 |
| `onBeforeBuild` / `onAfterBuild`                              | §7                                                                                                       |
| `pageList(fn)`（スプレッドシート由来など）                    | `pages.overrides`（prebuild が JSON に書く。§2.1）                                                       |

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
	"html": { "format": { "useTabs": false } },
	"scripts": { "alias": { "@": "./src/js" } },
	"styles": { "alias": { "@": "./src/css" } },
}
```

**未知のキーはエラー**です。エラーメッセージのパス（`pages.files`など）を見て直します。

### 2.1 `pageList`と、それにぶら下がる設定

`pageList()`でページ一覧を返し、`transformBreadcrumbItem`/`filterNavigationNode`で整える構成は、次のように置き換える。

- **一覧は prebuild で JSON にする**（`pages.overrides`、RFC §6）。`url`はページの URL と同じ書き方（`/a/index.html`ではなく`/a/`、ファイルは`/a.html`）で、違う書き方は設定エラーになる。`meta`には**一覧に値があるキーだけ**を書く。`null`を書くと、ページ自身の front matter の同じキーを隠す（v2 は一覧のメタをナビゲーション用にだけ使い、ページ自身の変数は front matter から取った）。ファイルに書いたページが、書いた順で`pages`の先頭に並び、`nav()`の表示順になる。
- **一覧にないページ**: v2 は一覧に載らないページを`nav()`と`breadcrumbs`に出さなかった。v3 は常にすべてのページを索引に入れる。ナビゲーションから隠すなら、そのページに`{ "url": "/x/", "meta": { "navHidden": true } }`を書く。ページのタイトル（`<title>`とパンくず）は v3 では自分の front matter の値になる（v2 は一覧になければサイト名）。
- **`transformBreadcrumbItem`** はコンポーネントに書く（`link.href`を`link.meta.realHref ?? link.href`に）。**`filterNavigationNode`** は`nav()`の結果を再帰で絞るヘルパーを書く（子から先に絞り、`keep(node)`が偽なら捨てる）。
- **`<!-- @include(...) -->`のコメントを出力する transform** は`html.includes`の`includeComment`（`root`は`/`始まりの基準ディレクトリ）に、**BurgerEditor の`importBlock`** は`burgerEditorImport`（`root`は入力ディレクトリ）に、`data-bgi-ver`を消す正規表現は`html.rules`の`removeAttr`に、`©`などを実体参照にする transform は`html.entities`に置き換える。`manipulateDOM`が全ページから要素を消していたなら`html.rules`の`remove`。
- **別のコンパイラ設定が同じファイルを別の transform で処理していたとき**（サブサイトだけ`manipulateDOM`と include を外していた、など）は`html.overrides`の`pages`に URL の glob を書いて、`includes`/`rules`を`[]`にする。
- **ビルド出力を`include`していた Pug**（出力の`header.html`を別の Pug が読む）は、v3 では出力の順序に依存させず、元のコンポーネントを直接呼ぶ。

**`pageList`を`pages.overrides`に書き出す prebuild の例**。v2 の`pageList(pageAssetFiles, config)`の本体を`scripts/page-list.mjs`に移し（引数と戻り値の形は v2 のまま。`kamado-v2`には依存させない）、`"prebuild"`が呼ぶ`scripts/prebuild.mjs`でその結果を JSON にする。`pageList`に渡す一覧は、入力ディレクトリのページファイルから、v2 の`pageAssetFiles`と同じ`url`の書き方で作る。`pageList`が`fileSlug`などほかのフィールドや`config`の値を読むなら、同じ規則で足して渡す。v2 の`date`は読んだ時刻（`new Date()`）なので、`lastmod`には写さない。

```js
// scripts/prebuild.mjs
import { readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { pageList } from './page-list.mjs';

const input = 'src';
const ignore = ['_libs/**']; // pages.ignore と同じ

// ページの URL（RFC §6）。`index.html`は`/dir/`、それ以外は拡張子`.html`付き
// （`pages.outputExtension`が既定のとき。`""`なら`.html`を付けない）
const urlOf = (file) =>
	`/${file.replace(/\.(?:html|tsx)$/, '.html').replace(/(?<=\/|^)index\.html$/, '')}`;

// v2 の`pageAssetFiles`にあたる、入力ディレクトリのページファイルの一覧
const files = readdirSync(input, { recursive: true, withFileTypes: true })
	.filter((entry) => entry.isFile())
	.map((entry) =>
		path
			.relative(input, path.join(entry.parentPath, entry.name))
			.split(path.sep)
			.join('/'),
	)
	.filter(
		(file) =>
			/\.(?:html|tsx)$/.test(file) &&
			!ignore.some((glob) => path.matchesGlob(file, glob)),
	)
	.toSorted()
	.map((file) => ({ inputPath: path.join(input, file), url: urlOf(file) }));
const existing = new Set(files.map((file) => file.url));

const pages = (await pageList(files, { dir: { input, output: 'htdocs' } })).map(
	({ url, metaData }) => {
		// `/a/index.html`と書かれた URL は、v3 では`/a/`
		const normalized = url.replace(/(?<=\/)index\.html$/, '');
		// `null`を書くと、ページ自身の front matter の同じキーを隠すので、一覧に値があるキーだけを書く
		const meta = Object.fromEntries(
			Object.entries(metaData ?? {}).filter(([, value]) => value != null && value !== ''),
		);
		return {
			url: normalized,
			// 入力ファイルが無い URL は仮想ページ
			...(existing.has(normalized) ? {} : { virtual: true }),
			...(Object.keys(meta).length > 0 ? { meta } : {}),
		};
	},
);

writeFileSync(
	'pages.overrides.json',
	`${JSON.stringify({ version: 1, pages }, null, '\t')}\n`,
);
```

`package.json`に`"prebuild": "node scripts/prebuild.mjs"`、`kamado.config.jsonc`に`"pages": { "overrides": "pages.overrides.json" }`を書く。`pageList`が`/`、`/a/index.html`、`/a/b.html`、`/ext/`を返し、`/ext/`の入力ファイルが無いなら、書き出される JSON は次のとおりで、`kamado build`は`1 virtual`と数える。

```json
{
	"version": 1,
	"pages": [
		{ "url": "/", "meta": { "title": "Home" } },
		{ "url": "/a/", "meta": { "title": "A", "navHidden": true } },
		{ "url": "/a/b.html", "meta": { "title": "B" } },
		{
			"url": "/ext/",
			"virtual": true,
			"meta": { "title": "External", "realHref": "https://example.com/" }
		}
	]
}
```

## 3. ページ: Pug → JSX

v3 のページは **`.html`（front matter 付き）と`.tsx`の 2 種類**です。Pug は廃止しました。

### 3.1 ファイルの置き換え

- `foo.pug` → `foo.tsx`。同じ場所に置く。出力パスは変わりません（拡張子だけ`.html`になる）。
- `foo.pug`のメタ（Pug 内の変数や front matter）→ `export const meta = { ... }`（**リテラルのみ**。式や変数は書けない）。
- 同名の`foo.json`（sidecar）はそのまま使える。優先順位は高い順に、`pages.overrides`、sidecar `.json`、ファイル内の`meta`。
- ページは`export default`でコンポーネントを書く。props の型は同梱しない（必要なら使う側で宣言する）。

```tsx
export const meta = { title: 'About', layout: 'default' };

export default ({ meta }: { meta: { title: string } }) => (
	<main>
		<h1>{meta.title}</h1>
	</main>
);
```

### 3.2 Pug の構文 → JSX

| Pug                               | JSX                                                                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `div.card(data-x='1')`            | `<div className="card" data-x="1">`                                                                                             |
| `#id` / `.a.b`                    | `id="..."` / `className="a b"`                                                                                                  |
| `p= text`（エスケープあり）       | `<p>{text}</p>`                                                                                                                 |
| `p!= html`（エスケープなし）      | `<p dangerouslySetInnerHTML={{ __html: html }} />`                                                                              |
| `if cond` / `else`                | `{cond ? <A /> : <B />}`、または`{cond && <A />}`                                                                               |
| `each item in items`              | `{items.map((item) => <li>{item}</li>)}`（`key`は不要）                                                                         |
| `mixin card(title)`と`+card('x')` | コンポーネント`const Card = ({ title }) => ...`と`<Card title="x" />`                                                           |
| `include ./header`                | `import { Header } from './_libs/Header'`と`<Header />`                                                                         |
| `extends layout`と`block content` | レイアウトのコンポーネント。`meta.layout`に`layouts.dir`のファイル名（拡張子なし）を書く。レイアウトは`content` prop を受け取る |
| `:markdown`などのフィルター       | 事前に HTML にして`.html` / データにする、または JS で変換して`dangerouslySetInnerHTML`                                         |
| `- const x = ...`（コード）       | コンポーネントの本文の JS                                                                                                       |
| コメント`//` / `//-`              | `{/* ... */}`                                                                                                                   |
| `doctype html`                    | 書かない（`html.doctype`が出力する）                                                                                            |
| `pretty`オプション                | 書かない（整形は`html.format`）                                                                                                 |
| `script.` / `style.`のブロック    | `<script dangerouslySetInnerHTML={{ __html: code }} />`                                                                         |

注意:

- JSX の空白は React と同じ規則（行頭行末の空白と改行は消える。意図した空白は`{' '}`）。Pug の空白との差は、出力の比較で見つかります。
- `<br>`などの空要素は`<br />`と書く。
- 関数の props（`onClick`など）は無視されます（警告）。
- hooks（`useState`など）と Context は使えません。コンポーネントは**純粋関数**（同じ props から同じ出力。モジュールの変数を書き換えない）。ワーカーが並列に描画するので、破ると結果が不定になります。
- `import`できるもの: 相対パスと`pages.alias`の別名の TS/TSX/JSON、npm パッケージ（ESM）。CSS の import はできません。
- TS は **erasable な構文だけ**（`enum`/`namespace`/パラメータプロパティは不可。`const`オブジェクトで置き換える）。

### 3.3 ページに渡されるもの

`page`、`meta`、`site`、`data`、`pages`、`nav(options)`、`breadcrumbs`、`titleList(options)`、`formatDate(value, format)`。レイアウトは加えて`content`。v2 の`pageList`は`pages`、`filters.date`は`formatDate`、`pkg`は`site`です（`pkg.production.*`の値は`site.*`）。`titleList`は v2 と同じで、トップページを titles から除き、`fallback`（既定は siteName）に`suffix`（既定は siteName）を区切りなしで続けるので、トップページは既定で`siteName`が 2 回並びます（`SITESITE`）。v2 のサイトでこれを避けていたなら、v3 でも同じ引数を渡せば同じ`<title>`になります（1 回にするなら`suffix: ''`）。

- `nav`の`filter`/`comparator`、`breadcrumbs`の変換（`transformBreadcrumbItem`）は廃止。返ってきた配列を JSX 側で加工する。
- `breadcrumbs`の起点は`site.baseURL`の**パス部分**（`https://example.com/sub/`なら`/sub/`）。v2 は値をそのまま数えたので、フル URL を書くと上位 2 階層が欠けていた（出力が変わる）。
- YAML の日付（`date: 2026-01-02`）は**文字列のまま**渡る（v2 は front matter だけ`Date`）。`formatDate()`に渡せば同じ表示になる。

### 3.4 変換スクリプトと、変換で見つかった注意点

変換スクリプト（`scripts/pug-to-tsx.mjs`）と改行を消すツール（`scripts/prune-jsx-newlines.mjs`）は、npm パッケージ`kamado`に入っていない。案件ごとに読んで直しながら使う道具なので、このリポジトリを clone して使う。clone には Node 26 と Yarn 4（Volta か corepack）が要る。

```sh
# プロジェクトで、入っている kamado の版を見る（例: 3.0.0-alpha.2）
node -p "require('kamado/package.json').version"

git clone https://github.com/d-zero-dev/kamado.git
cd kamado
git checkout v<その版>
yarn install
yarn build
```

- 変換スクリプトは、clone の`packages/kamado/dist`（`yarn build`が作る）を読む。版によって変換の規則が違うので、この節も、checkout したタグの`docs/v3/MIGRATION.md`を読む。
- Pug と JavaScript のパーサ（`pug-lexer`、`pug-parser`、`acorn` 8 以上）は、**変換するプロジェクト**から読む。v2 の Pug の構成なら、`pug-lexer`と`pug-parser`は、たいてい依存の依存として入っている。`acorn`は、Pug が引く 7 系しか無いことがあり、それでは新しい構文を読めない。その場合は、プロジェクトの devDependencies に`acorn` 8 以上を足す。pnpm や Yarn の PnP のように依存の依存を`node`から見せない構成では、3 つとも devDependencies に足す。PnP なら`nodeLinker: node-modules`にするか、`yarn node`で実行する。
- 変換スクリプトは、書き出した TSX を読むのに**clone**の`typescript`を使う（clone の`yarn install`で入る）。プロジェクトに TypeScript は要らない。
- 改行を消すツールが動かす kamado は、既定で**プロジェクト**の`node_modules/kamado`（`--cli`で変えられる）。
- この節の`scripts/...`は clone の中のパスで、`<clone>`は clone したディレクトリ。

`node <clone>/scripts/pug-to-tsx.mjs <project> <out>`は、`__assets`の`.pug`をコンポーネント（`.tsx`）に直す。`include`はコンポーネントの呼び出し（include する側の props とスコープの変数を渡す）、`each`は`_eachOf(...).map`（配列は index、オブジェクトは key で回す Pug と同じ。補助関数`_eachOf`は`each`のあるファイルの中に出る。手で書くなら配列は`.map`、オブジェクトは`Object.entries`でよい）、`if`は`&&`/`?:`、`pkg.production.*`は`site.*`、`filters.date`は`formatDate`になる。`mixin`は大文字で始まるコンポーネント（要素や`block`、分岐、ほかの mixin の中で定義したものも、同じモジュールの export しないコンポーネントになり、呼ぶ側がその場の変数を渡す。どこからも呼ばないものは書かない。Pug の mixin は定義した場所の変数を読み書きするので、それと結果が変わるものは止まる: 宣言していない変数に代入するもの（`- n++`）、呼ぶ場所の`each`が同じ名前の変数を持つもの。名前がぶつかるもの（同じファイルで 2 度定義した名前、include したファイルの mixin の名前、ファイル自身のコンポーネントの名前）も止まる。止めずに変換するので、出力を読んで直すもの: 呼ぶ側の mixin の引数やローカル変数が、mixin が定義した場所で読む変数と同じ名前のとき（呼ぶ側の値が渡る）、トップレベルの mixin が外の変数に書き込むとき（コンポーネントのローカルになる）。同じ`each`の中で定義して呼ぶ mixin も、そのループの変数を読むと止まる（結果は変わらないが、見分けない））、`else if`は入れ子の`?:`になる。`include`した Pug でないファイルは`html()`で出す。データのディレクトリのファイルは`props.data`の値を読む。それ以外は、変換した時点の中身を文字列として書き、あとでファイルを直しても出力に入らないことを`warning:`で知らせる。`--include-comment=<root>`（プロジェクトからの相対パス）を付けると、`<root>`の下のファイルは`<!-- @include(/<root>からのパス>) -->`になり、同じ`root`の`html.includes`の`includeComment`がビルドのたびに読む。設定の`root`は設定ファイルのあるディレクトリが基準なので、設定ファイルがプロジェクトの直下にないときは、同じディレクトリをプロジェクトからのパスで書く。データのディレクトリのファイルは、`<root>`の下にあっても`props.data`を読む。`pre`/`textarea`の中で呼んだ`mixin`と`include`は、改行と字下げを文字列で残す別のコンポーネント（`Sample`に対する`SamplePre`）を同じファイルに足して使う。`foo`と`foo-pre`のように名前がぶつかるときは止まる。表現できないもの（唯一の子でない`!{}`など）は止まるので、手で直す。出力は必ず読む。変換で見つかった点:

- **属性名は React の綴り**: `charset` → `charSet`、`itemprop` → `itemProp`、`itemtype` → `itemType`、`itemid` → `itemID`。小文字のままだと、`<meta charset>`は先頭に置かれず、`<meta itemprop>`（パンくずの`position`）が`<head>`に持ち上げられる。上のほかの属性（`datetime` → `dateTime`、`srcset` → `srcSet`など）も、`@types/react`の型が求める綴りで出す。対応表は react-dom の`possibleStandardNames`から`scripts/generate-react-prop-names.mjs`が作る。出力の HTML は、どちらの綴りでも同じになる。
- **型検査と lint に通す**: 変換結果は、`@d-zero/tsconfig`（strictest）の型検査と、型付きの eslint に通る。project の`tsconfig.json`に次を足す。
  - `"jsx": "preserve"`と`"allowImportingTsExtensions": true`。`include`に`**/*.tsx`を足す（`**/*.ts`が`.d.ts`も拾う）。型付きの eslint は、その`tsconfig.json`を`parserOptions.project`に使う。
  - `@types/react`は`kamado`の peerDependency（版はパッケージに合わせる）。プロジェクトの devDependency にも固定で足してよい。`react`自体は要らない（型だけを読む）。`html()`の戻り値の型`HtmlChild`と、`<html static>`の`static`は`kamado/jsx`が宣言する。ページ／レイアウトの props 型（`PageProps`等）と`basePathOf`も`kamado/jsx`から import する。
  - 変換スクリプトは`<out>/__assets/kamado-jsx.d.ts`も書く。中身は`command`/`commandfor`（Invoker Commands）の補強だけ（`static`は`kamado/jsx`側）。`__assets`に置きます。
  - 数字の文字列（`maxlength="255"`）は、`maxLength={255}`のように数値で出す。`on*`の文字列属性（`oncontextmenu="return false;"`）は、型が関数なので、型のつかない展開（`{...{ oncontextmenu: "..." }}`）で出す。
  - Pug の JavaScript の無名関数の引数は`(item: any) =>`と型を付け、オブジェクトリテラルの定数は`Record<string, any>`にする。使わない`props`の引数は`_props`にする。
  - Pug で宣言して、どこからも読まない変数と関数（`- const url = ...`だけで`url`を使わない、`- function helper() {}`を呼ばない）は書かない。属性の値の文字列（`property="og:url"`）の中の名前は、読んでいるとは数えない。初期値が何かをしうるもの（関数の呼び出し、`new`、代入、`x++`、タグ付きテンプレート、`await`など。`- const x = track()`）は、消すと動きが変わりうるので書き、`warning:`を出す。手で直す。
  - `style`の CSS の文字列と、`hidden="until-found"`（`@types/react`の型に無い値）は`as any`を付けて出す。条件式の枝の`false`と`null`（`cond ? "_blank" : false`、`cond ? "noopener" : null`）は`undefined`にする。Pug は、`false`や`null`の属性を出さず、`undefined`と同じに扱う。`disabled`のような真偽値の prop は、`false`に意味があるので残し、`null`だけを`undefined`にする。
  - 型を通すために`any`が入る。出力は必ず読み、必要なら型を付け直す。
  - import は`@d-zero/eslint-config`の`import-x/order`の並び（組み込み、パッケージ、`../`、`./`、index の順で、グループの間は空行、中はパスの昇順。index は`.`/`./`/`./index`/`./index.js`だけで、`./index.tsx`は`./`に入る）で出し、`import type { PageProps } from 'kamado/jsx'`を同じ規則で混ぜる。分割代入は、再代入される名前だけを`let`にして`const`と分ける（オブジェクトパターンの引数も同じ。プロパティごとに分け、`...rest`を含む階層や、分けられない塊は、`let`にする名前を別名で受けて後から`let a = _a;`と宣言する）。
  - eslint には、変換結果の TSX にだけ当てる設定を足す（flat config）。次の規則は、変換結果と合わない。
    - `@typescript-eslint/no-explicit-any`: 外す。`--fix`（lint-staged の pre-commit も）が`any`を`unknown`に書き換えて、型が通らなくなる。
    - `@typescript-eslint/no-unused-vars`: `argsIgnorePattern: '^_'`にする。使わない`props`の引数は`_props`で出る。あとから`props`を使わなくなった部品も、`_props`に直す。
    - `unicorn/no-unreadable-iife`: 外す。条件式を含む出力が、即時実行関数になる。
    - `unicorn/filename-case`: ページ（`__assets/htdocs/`の下）だけ外す。ファイル名が出力の URL になるので、変えられない。
    - `no-irregular-whitespace`: `skipJSXText: true`にする。全角空白がテキストに入る。
    - Pug のコードの書き方に当たる規則（`unicorn/explicit-length-check`、`unicorn/no-array-for-each`、`regexp/no-unused-capturing-group`など）: 案件に合わせて外すか、コードを直す。変換前は lint の対象外だった。

```js
{
	files: ['__assets/**/*.tsx'],
	rules: {
		'@typescript-eslint/no-explicit-any': 'off',
		'@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
		'unicorn/no-unreadable-iife': 'off',
		'no-irregular-whitespace': ['error', { skipJSXText: true }],
	},
},
{
	files: ['__assets/htdocs/**/*.tsx'],
	rules: { 'unicorn/filename-case': 'off' },
},
```

- **`&nbsp;`などの実体参照は、そのままテキストに書く**（`{"&nbsp;"}`と文字列にすると`&amp;nbsp;`になる）。
- **他の子と並ぶ生の HTML**は、`kamado/jsx`の`html()`で書く（`import { html } from 'kamado/jsx'`、`{html(markup)}`）。Pug の`!{}`と`include`したテキストの置き換え先。
- **`<option selected>`**: 変換スクリプトは`selected`をそのまま残す。`<html static>`（`kdStatic`のページ）では書いた位置に出る（Pug と同じ順）。static でないページでは、React と同じく属性の最後に出る。囲む`<select>`に`value`/`defaultValue`を書いたときは、`select`が選ぶ`option`を決める（`option`の`selected`は無視され、選ばれた`option`の最後に`selected`が付く）。値なしの`selected`（`option(selected)`）と`checked`（`input(checked)`）は、`selected`、`checked`と裸の属性で出す（`checked=""`にすると、空文字が偽なので描画から消える）。属性名と同じ文字列の真偽値属性（`disabled="disabled"`、`selected="selected"`、`checked="checked"`。型が boolean なので文字列は通らない）も、`disabled`などの裸の属性で出す。
- **`<link media="all">`** は空にならず`all`のまま出る（v2 と同じ）。
- **JSX に書けない属性名**（絵文字など、`⚠️="..."`のような印）は React が出力しない。静的なマークアップなら`html.inject`に HTML 文字列として書く。`@click`や`[x]`のように XML の Name でない名前は、変換スクリプトが`warning:`を出す（変換結果は spread のまま残るが、描画では属性が消える）。`:foo`や`日本語`は XML の Name なので書かれる。
- **React 19 は`<img>`ごとに`<link rel="preload" as="image">`を`<head>`に足す**（Pug では出ない）。`<html static>`のページでは出ない。それ以外のページで要らなければ`html.rules`で消す: `{ "selector": "link[rel=preload][as=image]", "action": "remove" }`。
- **Pug の`pretty`**（`createCompileHooks`の既定は`true`）は、インラインでないタグの前と、ブロックを含むタグの閉じタグの前に改行を入れる。これは空白として出力に残り、インライン要素の隣では見た目も変わる。変換スクリプトに`--pretty`を付けると、同じ規則で`{"\n"}`を書き出す（付けなければ空白は入らない）。v2 の出力と揃えるなら`--pretty`、`pretty: false`の基準と比べるなら付けない。
  - `--pretty`が出す`{"\n"}`の大半は要らない。ブロックどうしの間は、kamado の HTML 整形（`html.format`）が改行を入れるためです。
  - 要る`{"\n"}`は 2 種類ある。Pug がインラインとしない`button`/`input`/`label`/`select`/`time`/`svg`/`picture`/`iframe`などが、テキストやインラインの隣にある箇所（描画上の空白になる）。インラインの親の中のブロックのように、整形が詰める箇所（バイトが変わる）。どちらも**規則では見分けられない**。
  - 要らない行は`scripts/prune-jsx-newlines.mjs`が消す。**`--pretty`で変換して基準と一致させてから**、`node <clone>/scripts/prune-jsx-newlines.mjs <project> --output <出力ディレクトリ> <TSX のあるディレクトリ>...`を実行する。ビルドの出力を基準にして、ファイルごとにすべて消し、ビルドして比べる。出力が変わるなら半分ずつに分け、必要な行だけを残す。`pretty: false`の基準と比べるときは`--pretty`を付けないので、このツールは要らない。
  - 使うときの前提と注意:
    - `<project>`は`kamado.config.jsonc`のあるディレクトリで、`--output`と各パスはそこからの相対で書く。動かす kamado は、既定ではプロジェクトの`node_modules/kamado`（npm から入れたもので、native addon も入っている）。clone の kamado を使うなら`--cli <clone>/packages/kamado/dist/cli.js`で指し、clone で`yarn build`に加えて native addon も作っておく（Rust が要る。`cargo build --locked --offline --release -p kd_napi`。`docs/v3/development.md`）。その場合も、変換した TSX は`kamado/jsx`をプロジェクトから読むので、プロジェクトに同じ版の`kamado`が要る。オプションは`scripts/prune-jsx-newlines.mjs`の先頭の説明を読む。
    - ソースを書き換える。作業ツリーをきれいにして実行する。エラーや中断（Ctrl-C）のときは元に戻る。
    - 基準は実行時点の出力で、移行前の出力ではない。すでにある差は残る。ビルドが決定的でない（日時や乱数が出力に入る）と、基準にできないので止まる。
    - ビルドに使われないファイル（未使用の部品など）は、出力が変わらないので全部消える。そのようなファイルは手で見る。
    - ビルドの回数に比例して時間がかかる（必要な行が多いファイルほど増える）。`--incremental`は試行を速くするが、キャッシュを信頼するので、使うと必要な行を消してしまうことがある。最後の確認は常に全体のビルドで行い、一致しなければ失敗して元に戻る。
    - プロジェクトのコードと`--cli`のコードを実行する。信頼できるプロジェクトだけで実行する。
  - 消した結果が基準と一致するかは案件の HTML による。インラインの隣にそれらの要素が無い案件では全部消えて一致し、フォームやヘッダーに多い案件では必要な行が残る。`--pretty`なしで変換すると、描画が変わる箇所を見落とすので勧めない（`pretty: false`が基準のときを除く）。
- **Pug の出力順をそのまま保つ**: 変換スクリプトは`<html static>`を出す。React の持ち上げ（`<head>`の`async`な`script`が`title`の前に出る）と、`form`/`input`/`button`の属性の並べ替え（`action`と`name`が後ろへ）をやめ、書いた順で出す。`<html>`を持たない、`--pages=<ディレクトリ>`（既定`htdocs`）で指したディレクトリの下のページ（フラグメント）と`extends`したページには`export const meta = { kdStatic: true }`を出す（`<html static>`の外で評価される子を持つページは、手で書くときも`kdStatic`が要る。レイアウトの外側で評価される子や、`k('html', ...)`経由の`html`は対象外）。
- **`on*`属性の文字列**（`oncontextmenu="return false;"`）は、`<html static>`（`kdStatic`のページ）の中でだけ出る。React と同じく、ふだんは`on*`をすべて捨てる（データ由来の props が実行可能な属性にならないように）。
- **`style`を CSS の文字列で渡す**（`style=\`anchor-name: ${x}\``）は、`kamado/jsx`の`styleOf()` を通してオブジェクトにする。
- **`data-*` / `aria-*`と`draggable` / `spellcheck` / `contenteditable`に`true`と`false`**: Pug は`true`を空の属性（`data-x=""`）で出し、`false`は属性を出さない。React は`"true"`と`"false"`と書く。変換スクリプトは`true`を`""`、`false`を`undefined`にして出し、最終の HTML を移行前に合わせる。
- **`if (x)`が`0`を返す式**: Pug は何も出さず、JSX の`x && <b/>`は`0`を出す。変換スクリプトは`!!`を付ける（`!x`や比較のように、条件がすでに真偽値の式なら付けない）。
- **未宣言の変数への代入**（`- isHome = false`）は、変換スクリプトが`let`を足す。
- **`#{tag}`（動的なタグ名）** は大文字の変数に入れたコンポーネントとして書く（文字列の型を`k()`が受け取る）。
- **`extends` / `block`**: レイアウトは`slots`の props を受け取るコンポーネント、ページは`slots={{ content: (...) }}`を渡す。`block vars`の`var opts = ...`は props の既定値と、ページから渡す値になる。
- **変換スクリプトが止まるもの**: `block append`/`block prepend`、`&attributes`、引数が仮引数より多い`+mixin`、自分自身を読む宣言（`var title = title || "x"`）。止まったら手で書く。コード中の`if`/ループは、読む変数を props から取って変換する。
- **mixin と本文が同じファイル**（`header.c-header ...`と`mixin ...`が並ぶ）は、mixin は名前つき export、本文は`export default`のコンポーネント（`〜Body`）になる。**mixin に渡すブロック**（`+pSub`の下に書いた中身と、mixin の中の`block`/`if block`）は`children`になる。`locals["blocks-v2"]`はデータファイルの値（`props.data`）。データファイルの名前（`blog_news.yml`なら`blog_news`）は、Pug の変数として読んでいた箇所が`data.blog_news`になる。
- **mixin だけのファイルの先頭にある宣言**（`- const TABLE = { ... }`）は、モジュールのトップレベルの定数になり、どの mixin からも読める。どの mixin も読まない宣言は書かない。ページが渡す値や`locals`/`block`を読む宣言（`- const t = pageTitle`）は定数にできないので、`warning:`を出して書かない。手で書く。mixin がその定数に代入する（`- X = ...`）ときも`warning:`を出す。
- **Pug の代入**（`- breadcrumbs = pageBreadcrumbs`、`- x = true` ... `- x = false`）は、その位置で実行され、props の名前への代入はローカルの変数（初期値は props の値）になる。include したファイルと mixin には、その変数が渡る。
- **`//`のコメント**（Pug が HTML コメントにする）は JSX に書けないので消える。
- **データ**: `data.yml`と`blocks.js`のようなファイルは、Pug ではファイル名がそのまま変数（`data`、`blocks`）だった。v3 では`data.<ファイル名>`（`data.data`、`data.blocks`）。`.js`のデータは文字列を返すだけなら、中身の HTML をそのままデータのディレクトリに置く（`blocks.html`）。名前が重なるときは §4 の注意を見る。
- **レイアウトの指定**は拡張子なし（`"layout": "sub.pug"` → `"sub"`）。変換スクリプトは、`__assets`の下の sidecar（同じ場所に同名のページ`.pug`/`.html`/`.tsx`/`.jsx`がある`.json`。ページと対でない JSON はデータなので読まない）の最上位の`layout`と、`.html`の front matter にある`layout`が`.pug`で終わるものを、拡張子を外した写しにして`<out>`の同じパスに書く（ソースは書き換えない）。書いたファイルは`layout rewritten: <パス>`で出る。`warning:`が出るのは 3 つの場合: 名前に一致する変換済みの`.pug`が無い（レイアウトを手で書くなら、その名前の`.tsx`を置く）、`.json`が不正で読めない（写しは書かない）、`layout`が最上位の文字列として取れない（写しは書かない）。`layout`をページの`export const meta`に書いた`.tsx`は、手で書くものなので対象外。
- `scripts.files`は、ページ以外の入力に合わせて絞っておくと意図が明確になる（`"js/**/*.ts"`など）。`alias`の相対パスは`__assets/_libs`のように`.`なしでも、プロジェクトにあるパスならパスとして扱う。

## 4. データ

- `globalData.dir`の`.json`/`.yml`/`.yaml`（v2 は`.yaml`を無視）と、文字列として読む`.html`/`.txt`が使える。キーはファイル名（拡張子なし）。
- `.js`のデータ（default export、関数）は**廃止**。値を計算する処理は、prebuild のスクリプトで JSON に書き出す（`"prebuild": "node scripts/build-data.mjs"`）。
- **`.js`を`.html`に置き換えるときは、名前の衝突を先に確かめる**。データのディレクトリに同じ名前の`.html`がすでにあると、v3 は警告なしにその`.html`を`data.<名前>`として読む。たとえば`blocks.js`が`bge-blocks.html`を読み、別の`blocks2.js`が`blocks.html`を読む構成を考える。`blocks.js`を消して、`bge-blocks.html`の中身を`blocks.html`に置くと、既存の`blocks.html`が`data.blocks`になり、別の中身になる。置き換える前に、同じ名前の`.html`が無いかを調べる。ぶつかるときは、どちらかのデータの名前を付け替える（`blocks2.js`の出力は`blocks2.html`にする）。参照するページの`data.<名前>`も直す。
- `globalData.data`（設定内のリテラル）は`data.values`。同じキーは設定が優先。

## 5. HTML 後処理（transforms / manipulateDOM / injectToHead / SSI）

v2 の既定の transform（doctype → prettier → minifier → lineBreak）は v3 の既定のままです。独自のものは宣言的オプションに置き換えます。

| v2                                                           | v3                                                                                                                               |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `manipulateDOM`で要素を削除                                  | `html.rules`: `{ "selector": "...", "action": "remove" }`                                                                        |
| 属性の追加・変更・削除、クラスの追加・削除                   | `setAttr` / `removeAttr`（名前は`/regex/`も可）/ `addClass` / `removeClass`                                                      |
| 要素を包む・外す、HTML の挿入                                | `wrap` / `unwrap` / `insert`                                                                                                     |
| `ctx.getHref` / `ctx.baseURL`で URL を書き換え               | `rewriteUrl`（`absolute` / `rootRelative`、`origin`）                                                                            |
| `injectToHead({ content, position, filter })`                | `html.inject`: `{ "html": "...", "position": "head-end", "pages": [...], "mode": "build" }`（`mode: "serve"`は開発サーバー限定） |
| `devServer.transforms`（開発サーバーの応答の変換）           | `html.inject`の`mode: "serve"`（出力ディレクトリの静的な`.html`/`.htm`にも入る。§8）                                             |
| `createSSIShim`                                              | `html.includes`: `{ "preset": "ssi", "dir": "..." }`                                                                             |
| `<!-- @include(...) -->`の独自実装                           | `{ "preset": "includeComment", "root": "..." }`                                                                                  |
| BurgerEditor の import ブロック                              | `{ "preset": "burgerEditorImport" }`                                                                                             |
| `characterEntities`                                          | `html.entities`: `"all"`または`{ "©": "&copy;" }`                                                                                |
| imageSizes                                                   | `html.imageSizes`: `{ "enabled": true, "exclude": [...], "keepAuthored": false }`                                                |
| 特定ページだけ整形・圧縮を切る                               | `html.overrides`: `[{ "pages": ["/php/**"], "format": false, "minify": false }]`                                                 |
| `formatOptions.parseError`（`silent` / `warning` / `error`） | `html.onError`（同じ 3 値）                                                                                                      |

`html.rules`などの`pages`は**出力 URL**に対する glob です（入力パスではない）。

`setAttr`/`removeAttr`/`addClass`/`removeClass`は、`manipulateDOM`で書いた`setAttribute`/`removeAttribute`/`classList`と同じ結果になります。足す属性は要素の先頭に入ります（`RFC.md` §9.1）。違うのは、属性名を大文字小文字を区別せず照合する点です（`RFC.md` §2 の #35）。`onclick`を消す`removeAttr`は`ONCLICK`と書かれた属性も消します。`<p CLASS=c>`への`addClass`は、v2 では 2 つ目の`class`を先頭に足していましたが、v3 は`CLASS`に書き足します。`{{attr:href}}`も`HREF`と書かれた属性を読みます。ただし`/regex/`の名前は、書かれた名前に対する正規表現のままです。

## 6. スタイルとスクリプト

- スタイル（`styles.files`、既定`**/*.css`）は v3 が自前で処理します（`@import`の展開、alias、圧縮、バナー、source map）。**postcss.config のプラグインは使えません**。autoprefixer などが要るなら、npm scripts で別に処理してから kamado に渡します。
- `@import`の解決: alias（`@/x.css`）、importing ファイルからの相対パス、`node_modules`（パッケージの`style` → `.css`の`main` → `index.css`）の順。
- **PostCSS のプラグインのうち、`@custom-media`は組み込み**です（D-ZERO の`@d-zero/postcss-config`の`postcss-custom-media`）。定義はどのファイルにあっても使え（`@layer`/`@scope`/`@container`とスタイル規則以外の at-rule、たとえば`@media`/`@supports`の中に書いた定義は、v2 と同じく使わずに出力に残します）、定義は出力から消えます。`@media (--name)`のようにクエリが参照だけなら定義のリストに、定義が括弧で囲んだ特性 1 つ（`(width < 1px)`。`not`/`and`/`or`を含まない）なら、`and`の隣でも`(not (--name))`のような括弧の中でも、その場でその特性に置き換わります。それ以外の定義（リスト、media type、`(a) and (b)`や`not (a)`）をほかの条件と並べるか`not`の後や括弧の中に書いたときは、v2 と同じく規則を`@media <定義>`の中と`@media <定義の否定>`の中に 1 回ずつ書きます。その場で置き換えられない参照 1 つごとに、その規則の CSS は倍になります。定義が別の定義を使っていても、`true`/`false`の定義も使えます。未定義の名前と、循環する定義（Media Queries 5 では、循環に含まれる定義はすべて未定義）は置き換えません。`styles.minify: false`でも置き換えます（v2 は常に展開していて、ブラウザは`@custom-media`を解釈しないため）。圧縮しないときは、定義を消し（行に定義のほかに何もなければ行ごと）、参照を置き換えるほかは書いたまま出し、規則の写しを作るときは包む`@media`を元の規則の最初の行に並べます。v2 との差は §11 にあります。**ほかのプラグイン**（autoprefixer、`postcss-extend-rule`、`postcss-base64`、`postcss-math`/`postcss-calc`、`postcss-color-mod-function`、`postcss-clip-path-polyfill`）は使えません。案件の CSS がそれらを使っているかは、`@extend`、`base64(`、`color-mod(`、`math(`を検索して確かめます。autoprefixer だけは、最新ブラウザ向けの browserslist なら足すプレフィックスが数個（`-webkit-box-decoration-break`など）なので、書いておけば済みます。
- postcss-import と同じ扱い:
  - `@import`のあとに書いた`@layer a, b;`（順序の宣言）は、取り込んだ内容より前、バナーより前に移る。取り込んだファイルの中の外部 URL の`@import`と`@layer`の文も同じく先頭に移る。
  - 取り込んだファイルの`@charset`は先頭に 1 つだけ残り、値が違えばエラーになる。
  - 外部 URL の`@import`は、取り込みの条件（`layer()`、`supports()`、メディア条件）を引き継いで書く（`@import url("f.css") layer(y)`）。同じ外部 URL の`@import`は 1 つにまとまる。
  - `@layer`の文を挟んで続いていない`@import`、規則のあとの`@import`、読み込むファイルを名指さない`@import`、先頭にない`@charset`は、v2 と同じく出力に入れません。v3 は`kamado build`の要約に警告を出します（v2 は何も表示しませんでした）。
- **v2 と違う点（レイヤー）**:
  - `layer()`が 2 段以上ある取り込みの中の外部 URL の`@import`は、外側の条件を外側に書きます（`layer(a)`の中の`layer(b)`は`a.b`）。v2 の postcss-import は逆に書いて`b.a`になり、レイヤーの並びも変わります。
  - `@layer`の文や外部 URL の`@import`を先頭に移すと、レイヤーが最初に宣言される順がソースの順と変わるときは、取り込みの位置に`@layer one;`を書き足します（`@import "a.css" layer(one); @import "b.css" layer(two); @layer two, one;`は`one`、`two`の順。v2 は`two`、`one`）。変わらないときは何も書き足しません（`@layer one, two;`なら v2 と同じ）。順は同じ親を持つレイヤーの間で比べます。
    - 取り込んだファイルの本文にある`@layer x { … }`と`@layer x;`（`@media`/`@supports`の中のものはその条件のもとで）も、取り込みの位置で宣言されたものとして数えます（`@import "a.css"; @layer w, z;`で`a.css`が`@layer z { … }`を持つなら`@layer z;`を書き足す。v2 は`w`、`z`の順）。
    - 外部 URL の`@import`は、読み込むシートが何を宣言するかが分からないので、その手前で宣言されたレイヤーは手前に残します（`@import "b.css" layer(b); @import url(x.css); @import "a.css" layer(a);`は`@layer b;`を`@import url(x.css)`の前に書く。`x.css`が`@layer a, b;`を持っていても`b`が先）。
  - 隣り合う無名の`@layer`ブロックは、v2 の cssnano は 1 つにまとめますが、別のレイヤーなのでまとめません。無名の`layer`で取り込んだファイルの`@layer`の文は、v2 と違い、先頭に移さずそのファイルのブロックの中に残します。
- スクリプト（`scripts.files`、既定`**/*.{js,ts,jsx,tsx,mjs,cjs}`）は esbuild（`bundle: true`）です。`alias`/`define`/`target`（既定`es2022`）/`minify`/`sourcemap`/`banner`が使えます。**`pages.files`に一致するファイルはスクリプトとして扱いません**（`.tsx`はページ）。
- **v2 と出力を揃えたいとき**: v2 は esbuild に`target`を渡さない（esnext）。構文が`es2022`で変わるコードでは`"scripts": { "target": "esnext" }`にする。
- `<script>`の中身とイベントハンドラは esbuild で圧縮されます。v2（terser）とバイトは違いますが意味は同じです。

## 7. onBeforeBuild / onAfterBuild

廃止です。ビルド全体で 1 回だけの処理は kamado の外に出します。

- 前処理（データ生成、ファイルのコピー）→ `package.json`の`"prebuild"`。
- 後処理（古い出力の削除、別サイトへのコピー、通知）→ `"postbuild"`。何が出力されたかは **`build.report`** に書かれた JSON（`version`/`pages`/`assets`/`warnings`）で分かる。`"build": { "report": "build-report.json" }`を設定する。
- sitemap.xml は組み込み: `"sitemap": { "exclude": [...], "lastmod": "manifest" }`。URL の起点は`site.baseURL`（なければ`https://<site.host>`）。
- 古い出力は削除されません（v2 と同じ）。削除は`build.report`を使う postbuild で。

## 8. 開発サーバー

`kamado server`（設定は`devServer`）。v2 との違い:

- ファイルを監視しません（v2 と同じ）。リクエストごとに依存の stat を確かめ、変更がなければメモリの出力を返します。
- `html.inject`の`mode: "serve"`と`"both"`は、ページだけでなく、出力ディレクトリにあって対応するページのない`.html`/`.htm`にも入ります（v2 の`devServer.transforms`と同じ。kamado がビルドしない静的なサイトの開発時に、CSS などを足す使い方）。文字列の挿入で、`includes`・`rules`・整形・圧縮は当たらず、挿入以外のバイトは変わりません。入れる先の開始タグと終了タグの両方が書かれていないファイル（終了タグを省略した文書、`<head>`のない文書、断片）、UTF-8 でないファイル、すでに同じマークアップがあるファイルはそのまま返します。入れたファイルは`Content-Type: text/html; charset=utf-8`で、そのまま返すファイルは`charset`を付けません（RFC §9.3、§12）。`pages`の glob と`html.overrides`の`pages`はファイルのパス（`index<outputExtension>`は`/dir/`）に照らします（RFC §9.3）。
- ページファイルの追加・削除・移動、`outputPathField`の変更、`pages.overrides`の編集は、再起動なしで、次の要求から反映されます（RFC §12）。ページになりうる URL を要求したとき、そのファイルを置くディレクトリが前回の計画から変わっていれば、入力ディレクトリを歩き直します（`outputPathField`を使うサイトは、ページになりうる URL が見つからないたびに歩き直します。同じ URL は 2 秒間覚えます）。`/favicon.ico`のようなページになりえない URL では何もしません。作り直しを起こした要求は、そのぶん遅くなります（手元の計測で、1,000 ページで約 0.2 秒、10 万ページで約 1.5 秒）。直前の作り直しから 0.2 秒以内の要求は、残りの時間を待ってから作り直します。`pages.overrides`が壊れていると、ページの要求だけが 500 になり、画像やスタイルの要求は影響を受けません。
- 設定ファイル・`html.*`の変更と、スタイル・スクリプトのファイルの追加と削除は、**再起動**すると反映されます。
- コンポーネントを直すと、次のリクエストで描画用のワーカーが作り直されます（初回は少し遅い）。
- ブラウザのライブリロードはありません。
- `devServer.host`が`localhost`（既定）のときは、`127.0.0.1`と`::1`の両方で待ち受けます。`http://127.0.0.1:<port>/`でも`http://[::1]:<port>/`でも開けます（v2 は OS が最初に返すほう、macOS では`::1`だけでした）。そのぶん、どちらかのアドレスで同じポートを別のツールが使っていると、`port <port> is already in use on <アドレス> (devServer.port)`で起動しません。そのツールを止めるか、`devServer.port`を変えてください。
- `localhost`（とそのサブドメイン）、IP アドレス、`devServer.host`以外のホスト名で開くと`403`になります。`laptop.local`やトンネルのドメインで開くなら、`devServer.allowedHosts`に足してください（`".example.test"`のように先頭が`.`の値はサブドメインにも一致します）。`devServer.host`は待ち受けるアドレスで、`0.0.0.0`にしても名前で開けるようにはなりません。別のサイトからの要求（`<script src>`、フォームの送信、`iframe`への埋め込み）も`403`です。外部のリンクからタブで開くのは通りますが、`devServer.proxy`の接頭辞の下へのリンクは通りません（アドレスバーから開けば通ります）。同じマシンの別のツール（`http://127.0.0.1:5173`など）からの要求は通ります。別のマシンのツールからの要求を通すには、そのホスト名か IP アドレスを`allowedHosts`に足してください。DNS リバインディングと、別サイトからソースや`proxy`の先の API を読まれることへの対策です。ブラウザは判定に使う`Sec-Fetch-*`ヘッダーを`https:`と`localhost`宛てにしか送らないので、`localhost`以外のホスト（LAN の IP アドレスや`laptop.local`）で平文のまま開いているときは、フォームの送信と fetch だけが検査され、`<script src>`や`iframe`は通ります。

## 9. d-zero/builder（11ty）からの移行

kamado の前身の`@d-zero/builder`（Eleventy ベース）で作られた案件も、同じ手順（変換スクリプトで Pug → TSX、`.html`はそのまま）で v3 に移せます。Shift_JIS と CRLF で配信するサイトでも、下の対応表の設定で builder の出力に揃えられます。builder の設定と v3 の対応:

| builder（`eleventy.config.mjs`）                                                 | v3                                                                                                                                          |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `charset: { encoding: 'shift_jis', overrides: [{ paths, encoding: 'utf8' }] }`   | `html.encoding: "shift_jis"`と、`html.overrides`の`{ "pages": [...], "encoding": "utf8" }`。`pages`は**出力 URL**（`/a/index.html`は`/a/`） |
| `lineBreak: '\r\n'`                                                              | `html.lineBreak: "crlf"`                                                                                                                    |
| `prettier: { tabWidth: 4, useTabs: true }`                                       | `html.format: { "tabWidth": 4, "useTabs": true }`                                                                                           |
| `minifier: { minifyCSS: false }`（HTML Minifier の他の機能は何も有効にならない） | `html.minify: { "redundantAttributes": false, "css": false }`（空の`class=""`を残し、`style`属性を圧縮しない）                              |
| `characterEntities: true`                                                        | `html.entities: "all"`                                                                                                                      |
| builder が DOM を jsdom で書き戻す（属性の`&amp;`、`<path></path>`、`&nbsp;`）   | `html.serializer: "spec"`                                                                                                                   |
| `autoDecode`（開発サーバーが Shift_JIS の出力を UTF-8 に戻す機能）               | 不要。開発サーバーが作るページは常に UTF-8 で返す。出力ディレクトリの静的なファイルはそのまま返す（RFC §9.5）                               |
| ソースが Shift_JIS の HTML・JSX・CSS（builder の`autoDecode`の対象外）           | **未対応**。`<path>: file is not valid UTF-8`で失敗する（lossy 変換はしない）。`iconv -f CP932 -t UTF-8`等で UTF-8 にしてから移す           |
| `ssi`（開発サーバーで`<!--#include virtual-->`を展開）                           | ビルドでは何もしない（コメントのまま残る）。展開が要るなら`html.includes`の`ssi`                                                            |
| `banner()`                                                                       | `styles.banner` / `scripts.banner`の文字列（`{{date:YYYY-MM-DD}}` `{{year}}`）                                                              |
| `eleventy-pug-plugin`の`filters.cjs`（`:name`が`data/<name>.html`を返す）        | `data/<name>.html`を置く。変換スクリプトは`:name`を`html(data[name])`にする                                                                 |

builder の出力と揃えるときの違い:

- **インラインの`<script>`**: builder は terser、v3 は esbuild で圧縮する。意味は同じで、バイトは違う（GTM のスニペットなど）。
- **画像の寸法**: builder は属性に書いた`height`があっても画像の実寸で上書きすることがある。v3 の`html.imageSizes`（既定）は v2 と同じ（書いてあれば残す）。SVG の寸法の丸めも違う。画像は出力ディレクトリから読むので、出力ディレクトリに画像が要る。
- **`.html`に混ざった SSI のコメント**: そのまま残る（HTML のコメントは消えない）。
- **Pug が`include`する出力ディレクトリのファイル**（`../../../<出力ディレクトリ>/img/icon.svg`のような SVG）: 変換スクリプトはその時点のファイルを読んで文字列にする。
- **生の HTML を書いた Pug**（`<meta ...>`の行、`| <!--#include ... -->`）は`html("...")`になる。`//`のコメントも HTML のコメントとして残る。
- 参照できないパッケージ（`node_modules`が無い）の TS は、`scripts.files`を絞って後回しにできる。

## 10. 検証

### 10.1 出力の比較

```sh
yarn kamado build --force   # v3 のプロジェクトで（§1 の `kamado` は v2、ここは v3）
node <clone>/benchmarks/v3/compare-outputs.ts /tmp/baseline-v2 <v3 output dir> --semantic
node <clone>/benchmarks/v3/compare-outputs.ts /tmp/baseline-v2 <v3 output dir> --diff=<ページの相対パス>
```

`<clone>`は §3.4 で clone して`yarn install`したこのリポジトリ（比較のスクリプトは npm パッケージに入っていない）。比べる相手は、§1 で作った基準（コミット済みの出力を取り出したなら、`/tmp/baseline-v2-committed`とも比べる）。

`--semantic`を付けると、バイトが違うページ（`.html`/`.htm`）を、意味の変わらない差をそろえてから比べます。そろえるのは次のものです。prettier の幅の違い（§1）で折り返しの位置が違うだけのページは、ここで一致します。

- 描画されない空白: 連続する空白、ブロックの要素の境目の空白、続く空白（コメント、表示されない要素、インラインのタグをまたいでも 1 つにする）、`button`・`select`・`textarea`の内側の端、`head`の要素の間と`title`の前後。`pre`・`listing`・`textarea`の中は書かれたまま比べる（開始タグの直後の改行 1 つはパーサーと同じく落とす）
- 属性の順と引用符、タグ名と属性名の大文字小文字、空の値と値なし（`disabled=""`と`disabled`）、`class`の値の中の空白
- 文字参照の書き方（`&nbsp;`と`&#160;`、`&amp;`と`&`）、doctype の大文字小文字、自己終了の`/`、省略した`</head>`
- UTF-8 でないページ（Shift_JIS など）は、バイトのまま比べる（文字参照と空白はそろえる）

結果の見方:

- `identical`（バイト一致）と`equivalent`（そろえると一致）の割合を見る。`different`のページは、`--diff=<ページの相対パス>`で、そろえたあとの差を行単位で見て、§11 の表と照らす。`--diff`はページだけを比べ、差が無ければ終了コード 0、あれば 1 を返す。
- `smaller`/`larger`は CSS/JS/ソースマップで、サイズだけを比べる。`smaller`は合格、`larger`は終了コードを 1 にする。v3 の CSS が大きくなるのは、§11 の CSS の圧縮結果の差（custom property を書かれたまま出す、v2 の autoprefixer が消した古いプレフィックスが残るなど）で起きる。中身を見て、意図した差か確かめる。
- `equivalent`のうち、そろえる対象から外したものが違うページは、「equivalent pages left to check」に種類ごとの件数が出る（終了コードは 1）。そのページも`--diff`で、外したものの差を見られる。
  - `inline-script`: `<script>`の中身。§11 の圧縮器の違い（terser と esbuild）で、処理の内容が同じかを確かめる。
  - `inline-style`: `<style>`の中身と`style`属性の値。§11 の CSS の圧縮結果と引用符の差か確かめる。
  - `empty-class`: 空の`class=""`が付いている要素。`class=""`は CSS の`[class]`と`:not([class])`に当たり、属性が無い要素には当たらない。候補の出力の CSS ファイルと、そのページの`<style>`から、当たり方が変わりうるセレクタ（`[class]`、`:not([class])`、`[class=""]`）が「selectors that test the class attribute」に一覧で出る。増減した要素に当たるものがあるかを確かめる。`[class^=icon-]`のように値の中身を見るものは、空の値に当たらないので一覧に出ない。
- 違う`.css`は、ベンダープレフィックスの付いた宣言（プロパティ、値、セレクタ、at-rule のどこかにプレフィックスがあるもの）のうち、片方にだけあるものが「prefixes」に出る（`-`は v2 だけ、`+`は v3 だけ）。v3 はプレフィックスを足しも消しもしない（§11 の注）。`-`が 1 つでもあると終了コードは 1 になる。`-`のうち対象のブラウザで要るものは、ソースに書く。`+`（v2 の autoprefixer が消していた古いプレフィックスが残ったもの）は一覧に出るだけ。空白の書き方はそろえるが、値の書き方が違う宣言（`#fff`と`#ffffff`）は両方に出る。
- 一覧（差のあるファイル、prefixes、セレクタ）は、それぞれ`--show`（既定 20）の件数まで出る。
- そろえ方の限界: 空白は要素の既定の`display`と`white-space`で判断する。CSS でこれを変えている要素（`div`を`display: inline`にする、`white-space: pre`を付けるなど）では、同じ表示でも`different`になることも、境目の空白の違いが`equivalent`に紛れることもある。ほかにも、同じ表示が`different`になることがある（次の文字が空白で始まるときの、インラインの要素の中の末尾の空白、`</p>`・`<body>`・`<tbody>`などの省略、`noscript`の中）。HTML のコメント、`<?php ?>`、`xmp`・`iframe`・`noembed`・`noframes`の中は書かれたまま比べる。
- `extra`（v3 だけにあるファイル）: v2 の設定でビルドしていなかったスタイル/スクリプトが v3 では出力されている場合。意図したものか確かめる。
- 一部だけをビルドする`kamado build <パス>`のパスは、v2 と同じく打った場所から書く（`yarn kamado build src/css/style.css`）。v2 と違い、無いファイルはエラーになり、ディレクトリを渡すとその中をすべてビルドし、何も選ばなかったパスは警告が出る（RFC §2 の #40）。スクリプトや手順書に書いたパスは、ここで確かめる。

### 10.2 差分ビルド

```sh
yarn kamado build --incremental        # 初回: すべて built
yarn kamado build --incremental        # 2 回目: すべて cached
# ページを 1 つ直して
yarn kamado build --incremental        # そのページだけ built
```

- 共有のレイアウトやコンポーネントを直すと、それを使うページだけが再ビルドされる。
- データファイル（`data.dir`）を直すと、JSX で描画するページが再ビルドされる。
- どれかのページのメタ（front matter、sidecar、`pages.overrides`）を直すと、`pages`/`nav`などを読むかどうかにかかわらず、JSX で描画する全ページが再ビルドされる（`.html`ページは再ビルドされない）。

### 10.3 開発サーバー

`kamado server`を起動し、ページ・CSS・JS・出力ディレクトリの静的ファイルを開く。コンポーネントを 1 つ直して再読み込みし、反映を確かめる。プロキシを使うなら`devServer.proxy`の経路も確かめる。`mode: "serve"`の`html.inject`を書いているなら、静的な HTML にも入っていることを確かめる。

## 11. 出力に差が出る既知の点

意図した差です（`docs/v3/RFC.md` §2 の番号つき）。これ以外の差は、v3 の不具合か移行の誤りです。

| 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                           | RFC  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 本文中の`<?php ... ?>`を v2 は**削除**した。v3 は保持する                                                                                                                                                                                                                                                                                                                                                                                                      | #21  |
| `<title>`中の`&amp;`と`&lt;`の扱い（展開すると意味が変わる並びだけ、展開しない）                                                                                                                                                                                                                                                                                                                                                                               | #27  |
| `<script>`の開始タグの属性値に`><`を含むとき、v2 は本文が壊れた                                                                                                                                                                                                                                                                                                                                                                                                | #28  |
| `characterEntities`を v2 は`<script>` / `<style>`の中も置換した。v3 は置換しない                                                                                                                                                                                                                                                                                                                                                                               | #29  |
| 断片の途中の`<!doctype>`で v2 は内容を落とした                                                                                                                                                                                                                                                                                                                                                                                                                 | #30  |
| 先頭の`<?xml ... ?>`を v2 は**削除**した。v3 は先頭に保持し、そのあとに doctype を補う                                                                                                                                                                                                                                                                                                                                                                         | #33  |
| `outputPathField`が`.html`以外の拡張子（`.htm`など）を指すページを、v2 は処理せず front matter 付きの入力のまま書いた。v3 は処理する                                                                                                                                                                                                                                                                                                                           | #34  |
| `breadcrumbs`の起点（`site.baseURL`のパス部分）                                                                                                                                                                                                                                                                                                                                                                                                                | §7.3 |
| YAML の日付が文字列                                                                                                                                                                                                                                                                                                                                                                                                                                            | #19  |
| `@custom-media`の循環する定義、`not screen and (...)`のような定義の否定、別々の`@layer`にある同じ名前の定義、定義を消して空になった`@layer`、定義の中の`var(--x)`、`--`だけの名前、一致しない定義への`not (--x)`（v2 は循環ごとに 1 つの名前だけを未定義にして残りを展開し、否定を`screen, (...)`と誤り、優先度の高いレイヤーの定義を使い、空の`@layer`を消し、`var(--x)`の名前も参照に数え、`--`も定義し、一致しない定義への`not (--x)`を効かない形に書いた） | #37  |
| CSS の圧縮結果（cssnano と同じ意味で、バイトは違いうる。サイズは近い。`initial`を`normal`に縮める`reduce-initial`などは移植していない）。値の形、隣り合う`@media`の結合、custom property の値、プレフィックス（autoprefixer の足し引きをしない）は下の注                                                                                                                                                                                                       | §10  |
| HTML 内の CSS（`<style>`と`style`属性）の引用符。下の注を参照                                                                                                                                                                                                                                                                                                                                                                                                  | #32  |
| `<script>`の圧縮結果（terser と esbuild）                                                                                                                                                                                                                                                                                                                                                                                                                      | §10  |
| prettier の幅（入力ごとから統一へ）                                                                                                                                                                                                                                                                                                                                                                                                                            | #15  |
| minify を有効にしたとき、属性の引用符の選び方（値に`"`があると v2 は`'`で囲むことがあり、v3 は`"`と`&quot;`）、minify のパーサによる壊れたマークアップの補正（`<col>`に`<colgroup>`、閉じ忘れの補完）、続く`<?php ?>` / `<% %>`の間の空白（v2 は詰める）は再現しない                                                                                                                                                                                           | §9   |
| minify を切ったとき（`minify: false`、`minify.js: false`、esbuild が見つからない）、v2 は整形済みの JS / CSS を出し、v3 は書かれたまま出す（CSS ファイルの`styles.minify: false`でも`@custom-media`は §6 のとおり置き換える）                                                                                                                                                                                                                                  | #32  |
| `calc()`の結果が小数 5 桁を超えるとき、v3 は畳まず書かれたまま出す（`calc(60/17*1em)`は、v2 が`3.52941em`にする）。5 桁以内の定数畳み込みは同じ                                                                                                                                                                                                                                                                                                                | §10  |
| cssnano が行い kd_css が行わない結合は 3 つ: 共通の宣言を持つ離れた規則の結合、`:is()`へのまとめ、隣り合う同名の`@layer`ブロックの結合。kd_css が行うのは、隣り合う同一ブロックのルールの結合だけ。意味は同じで、バイトが違う                                                                                                                                                                                                                                  | §10  |
| v2 の minify（html-minifier-terser）が壊れたマークアップで投げ、そのページが圧縮されずに出ていたとき、v3 は圧縮する。v2 の出力は整形済みのまま`<meta charset="UTF-8" />`が残り、v3 は`<meta charset="UTF-8">`になる                                                                                                                                                                                                                                            | §9   |
| `pageList`を設定していない v2 では、`breadcrumbs`と`titleList()`のタイトルが`__NO_TITLE__`になった（v2 のページ一覧はメタを持たない。front matter や sidecar に`title`があっても出ない）。v3 はページのメタのタイトルを出す。例（`/a/b/c.html`とその祖先の`index`の sidecar に`title`がある）: v2 `<title>__NO_TITLE__ \| __NO_TITLE__ \| __NO_TITLE__Site</title>`、v3 `<title>C \| B \| ASite</title>`。`pageList`を設定した v2 との違いは §2.1              | #41  |
| HTML のコメント（JSX には書けない）。`<head>`内の並び（React 19 の持ち上げ）                                                                                                                                                                                                                                                                                                                                                                                   | §7.1 |
| フォームの属性の並び（`action`と`method`は React が最後に出す）                                                                                                                                                                                                                                                                                                                                                                                                | §7.1 |

HTML 内の CSS の引用符（上の表）: v2 は prettier で整形してから html-minifier-terser（clean-css）で圧縮する。prettier が引用符を`'`から`"`に変える（属性内は`&quot;`）ので、`url('x')`は`url(&quot;x&quot;)`に変わり、`style="font-family:'Helvetica Neue', Arial"`は`font-family:&quot`に壊れる。v3 は Rust の圧縮器で、引用符が要らない値は外す（`url(x)`、`font-family:Helvetica Neue,Arial`、`<style>`内は`font-family:Foo Bar`）。v3 は元の CSS の意味を保つ。v2 の出力と比べて差が出たら、まずこの差かを確かめる（v2 で壊れていたものは、v3 では直る）。

CSS の圧縮結果の違い（表の「CSS の圧縮結果」の行）は、値の形の違いで、意味は同じです。v2 の出力と比べて見つかる例: `border: #ccc solid 1px`は`1px solid #ccc`に、`animation: spin 1s infinite linear`は`1s linear infinite`に、`rotate(360deg)`は`rotate(1turn)`に、`unicode-range: U+0000-00FF`は`u+00??`になる。ほかに次の違いが出る。

- `display: block flow`は`block`に、`display: inline flow-root`は`inline-block`になる。v3 はどこに書かれていても（CSS ファイル、`<style>`、`style`属性）この形にする。v2 は HTML の`<style>`の中では、書かれたまま残した。
- 間にほかのルールがなく隣り合う、同じ条件の`@media`は 1 つにまとめる（`@media screen and (min-width:769px){A}@media screen and (min-width:769px){B}`は`{AB}`）。規則の順序は変わらない。間にルールがあるものはまとめない（RFC §10 の、隣接する同一ブロックのルールの結合と同じ）。
- custom property の値は、v3 は書かれたまま出す（`--x: rgba(0, 0, 0, 0.24)`、`calc(3 / 18 * 1em)`）。v2 は値を縮める（`#0000003d`、`0.16667em`）。
- プレフィックス: v2 は autoprefixer が、依存パッケージの CSS に書かれた古いもの（`-moz-column-gap`、`-o-object-fit`、`-moz-appearance: auto`）を消し、足りないもの（`-webkit-text-decoration-skip-ink`など）を足した。v3 は書かれたまま出し、足しも消しもしない。**移行の作業**: ソースの CSS が v2 の autoprefixer に頼ってプレフィックスを書いていなかったなら、v3 の出力からプレフィックスが消える。対象のブラウザで要るものは、ソースに書くか、別の工程（npm scripts）で足す（§6）。

`.htm`のページ（表の #34 の行）: v2 は、出力の拡張子で処理を選ぶので、`.html`以外の出力（`.htm`など）は処理せず、入力をそのまま書く。v2 の出力に`---`で囲んだ front matter が残っているページがそれにあたる。v3 は拡張子によらずページとして処理するので、front matter が消え、doctype の規則と、整形と圧縮が働く。`.htm`をほかのテンプレートエンジンの入力にしているときは、出力を確かめる。なお、`<style>`の中の`<![CDATA[ ... ]]>`は、ブラウザもスタイルシート全体を捨てる。`[`の中に`{}`が入り、規則が閉じないためで、v3 は`<style></style>`にする。

v1（kamado 1.x）から直接移すと、基準が v2 の出力ではないので、v2 の挙動に合わせた次の差も出ます。

- `class`の値は、解析時に正規化されます。重複するクラスと連続する空白が 1 つになり、`class="a a"`は`class="a"`に、`class="a  b"`は`class="a b"`になります。v2 が使っていた DOM 実装（linkedom）と同じ挙動で、描画には影響しません。

## 12. 困ったとき

- 設定エラーは、キーのパスと理由を出して止まります。
- ページのビルド失敗（JSX の構文エラー、存在しないレイアウト、`meta`に式を書いた）は、ファイルと行・列を出します。
- 描画の途中で落ちたときは`Failed to render <path>: <message>`。`<path>`のコンポーネントを見ます。
- 速度の確認: `KAMADO_TIMING=1`（JavaScript 側）と`KD_TIMING=1`（コア側）を付けて実行すると、フェーズごとの時間が出ます。
