# kamado v3

Rust のコアを持つ、オンデマンドの静的サイトジェネレータ。ページは **HTML（front matter 付き）と TSX** の 2 種類で、ランタイム JavaScript を出力に残さない。

- 10 万ページ級のビルドと開発サーバー応答を速くすることが目的。Rust 側は標準ライブラリだけで書き、npm の依存は`esbuild`と`hono`/`@hono/node-server`だけ。
- 出力の HTML は v2 と**バイト一致**する（意図した差は`docs/v3/RFC.md`）。
- v2 から移るには`docs/v3/MIGRATION.md`（AI が上から順に実行できる手順書）。

> alpha の開発中で、まだ公開していない。v2 は`v2`ブランチで保守している。

## 設定

プロジェクトのルートに`kamado.config.jsonc`を置く。関数は書けない。相対パスは設定ファイルのディレクトリ基準で、未知のキーはエラーになる。

```jsonc
{
	"$schema": "./node_modules/kamado/schema.json",
	"dir": { "input": "src", "output": "htdocs" },
	"site": { "baseURL": "https://example.com/" },
	"pages": { "ignore": ["_libs/**"], "layouts": { "dir": "src/_libs/layouts" } },
	"html": { "format": { "useTabs": false } },
	"sitemap": { "lastmod": "mtime" },
}
```

`schema.json`は、設定のキーの一覧（未知のキーの検出）と、値の型・列挙できる候補を持つ。既定値を書いているのは一部（5 個）だけで、`html.rules`/`html.includes`/`html.inject`/`html.overrides`の項目は型のない`object`として通す（中身の検証は Rust 側の設定の読み込みが行う）。エディタに`$schema`を読ませれば、キーの補完と大まかな検証が効く。オプションの意味と既定値は`docs/v3/RFC.md`の §3 以降にある。

| セクション  | 内容                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `dir`       | 入力と出力のディレクトリ（異なること）                                                         |
| `site`      | `host` / `baseURL` / `siteName` / `siteNameEn`（未指定なら`package.json`の`production`）       |
| `pages`     | 対象の glob、出力パス、レイアウト、`alias` / `define`、メタデータの`overrides`                 |
| `data`      | JSON / YAML / HTML / テキストのデータと、設定内のリテラル                                      |
| `html`      | doctype・整形・圧縮・文字参照・画像寸法・DOM ルール・取り込み・head への挿入・ページ別の上書き |
| `sitemap`   | `sitemap.xml`（`false`で無効）                                                                 |
| `styles`    | `@import`の展開、alias、banner、sourcemap、圧縮                                                |
| `scripts`   | esbuild でのバンドル（alias / define / target / banner / sourcemap / 圧縮）                    |
| `devServer` | `port` / `host` / `allowedHosts` / `open` / `startPath` / `proxy`                              |
| `build`     | `jobs` / `incremental` / `cacheDir` / `skipUnchanged` / `report`                               |

## コマンド

```sh
kamado build [globs...] [--incremental] [--force] [--skip-unchanged]
                         [--jobs <n|auto>] [--cache-dir <dir>] [-c, --config <file>] [--verbose]
kamado server           [--cache-dir <dir>] [-c, --config <file>] [--verbose]
kamado pages            [--out <file>] [--incremental] [--cache-dir <dir>] [-c, --config <file>]
kamado --help           (-h)
```

- `--config`/`-c`を省略すると、カレントディレクトリの`kamado.config.jsonc`を使う。`--cache-dir`は差分ビルドの manifest や plan cache の置き場を変える（`build`・`server`・`pages`）。
- `build`は設定の対象を全部出力する。`globs`を渡すとその入力だけ（相対パスは打った場所からのパス。ディレクトリはその中のすべて。無いファイルと、先頭が`!`の否定はエラー。何も選ばなかったものは警告）。`--incremental`は前回から変わっていないものを飛ばす（`--force`で無視）。`--jobs`は並列度（JSX の描画のワーカーと Rust のスレッドの数）で、`auto`（既定）は使える CPU の数から決める。
- `pages`は、ビルドせずに全ページの一覧を JSON で書き出す（標準出力か`--out`。相対パスは打った場所からのパス）。1 ページが 1 要素で、URL・入出力のパス・`fileSlug`・`filePathStem`・`extension`・階層（`depth`と、親のディレクトリの`parent`）・仮想ページかどうか・マージ後の`meta`を持つ。ディレクトリマップをスプレッドシートに写すためのもの（形は`docs/v3/RFC.md` §14.1）。入力ファイルのない仮想ページ（`pages.overrides`）は`inputPath`と`extension`が`null`で、`outputPath`は書き出されないがあるはずの場所。`globs`と、読まないフラグ（`--force`・`--jobs`・`--skip-unchanged`・`--verbose`）は、渡すとエラー。`--incremental`は plan cache を読んで更新する。端末には、読み始めと終わり（と、計画の警告があれば`warning: ...`）を標準エラーに出す。
- `server`はリクエストごとに依存ファイルを stat し、変わっていなければ前回の結果を返す。ファイルは書き出さない。ライブリロードはない。変更したコンポーネントはワーカーを作り直して反映する。応えるのは`localhost`・IP アドレス・`devServer.host`・`devServer.allowedHosts`宛ての要求だけで、別のサイトからの要求は`403`（`docs/v3/RFC.md` §12）。`devServer.host`が`localhost`（既定）なら`127.0.0.1`と`::1`の両方で待ち受ける。

## プログラムから

```ts
import path from 'node:path';

import { build, pages, start } from 'kamado';

// All take the absolute path of the config file, not an object.
const config = path.resolve('kamado.config.jsonc');

const report = await build(config, { incremental: true });
console.log(report.pages.length);

// The pages of the plan, without building: URL, paths, depth, parent and meta of each.
const map = await pages(config, { incremental: true });
console.log(map.pages.filter((page) => page.depth <= 2).map((page) => page.url));

const server = await start(config);
console.log(server.location);
await server.close();
```

`build()`・`start()`・`pages()`の第 1 引数は、設定ファイルの**絶対パス**（相対パスの基準になるディレクトリが設定ファイルの場所のため）。`pages()`のオプションは`incremental`と`cacheDir`で、`PageMap`（`docs/v3/RFC.md` §14.1）を返す。ファイルには書かない（書くなら`JSON.stringify`して自分で書く）。`build()`のオプションは CLI のフラグと同じ（`incremental`/`force`/`skipUnchanged`/`targets`/`jobs`/`cacheDir`）。`targets`の相対パスは、設定ファイルのディレクトリからのパス（glob とパスの扱いは CLI と同じ。無いファイルは例外、何も選ばなかったものは`report.warnings`）。`report`は各ページの URL・入出力のパス・状態（`built`/`cached`/…）・メタデータを持つ。

## 対応プラットフォーム

Rust のアドオン（`.node`）を使うので、プラットフォームごとにビルドが要る。CI（`.github/workflows/rust.yml`）がビルドとテストをするのは次の 3 つ。

| プラットフォーム          | 状態                                         |
| ------------------------- | -------------------------------------------- |
| macOS arm64               | CI で確認（`macOS-latest`）                  |
| Linux x64（glibc）        | CI で確認（`ubuntu-latest`）                 |
| Linux arm64（glibc）      | CI で確認（`ubuntu-24.04-arm`）              |
| macOS x64                 | 対象だが CI では確認していない               |
| Linux x64 / arm64（musl） | 対象だが CI では確認していない               |
| Windows（ネイティブ）     | 非対応（WSL 上の Linux は Linux として扱う） |

Node は 24.11 以上（`engines`）。

## 開発

ビルド・テスト・ベンチマークの手順は`docs/v3/development.md`。
