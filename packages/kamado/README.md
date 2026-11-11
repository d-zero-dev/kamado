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
kamado ui               [--port <n>] [--open | --no-open] [--cache-dir <dir>] [-c, --config <file>]
kamado ui-settings      list | reset [-c, --config <file>] | delete <config-file> | delete --all
kamado --help           (-h)
```

- `--config`/`-c`を省略すると、カレントディレクトリの`kamado.config.jsonc`を使う。`--cache-dir`は差分ビルドの manifest や plan cache の置き場を変える（`build`・`server`・`pages`・`ui`）。相対パスは**打った場所（cwd）基準**。
- `build`は設定の対象を全部出力する。`globs`を渡すとその入力だけ（相対パスは打った場所からのパス。ディレクトリはその中のすべて。無いファイルと、先頭が`!`の否定はエラー。何も選ばなかったものは警告）。`--incremental`は前回から変わっていないものを飛ばす（`--force`で無視）。`--jobs`は並列度（JSX の描画のワーカーと Rust のスレッドの数）で、`auto`（既定）は使える CPU の数から決める。
- `pages`は、ビルドせずに全ページの一覧を JSON で書き出す（標準出力か`--out`。相対パスは打った場所からのパス）。1 ページが 1 要素で、URL・入出力のパス・`fileSlug`・`filePathStem`・`extension`・階層（`depth`と、親のディレクトリの`parent`）・仮想ページかどうか・マージ後の`meta`を持つ。ディレクトリマップをスプレッドシートに写すためのもの（形は`docs/v3/RFC.md` §14.1）。入力ファイルのない仮想ページ（`pages.overrides`）は`inputPath`と`extension`が`null`で、`outputPath`は書き出されないがあるはずの場所。`globs`と、読まないフラグ（`--force`・`--jobs`・`--skip-unchanged`・`--verbose`）は、渡すとエラー。`--incremental`は plan cache を読んで更新する。端末には、読み始めと終わり（と、計画の警告があれば`warning: ...`）を標準エラーに出す。
- `server`はリクエストごとに依存ファイルを stat し、変わっていなければ前回の結果を返す。ファイルは書き出さない。ライブリロードはない。変更したコンポーネントはワーカーを作り直して反映する。応えるのは`localhost`・IP アドレス・`devServer.host`・`devServer.allowedHosts`宛ての要求だけで、別のサイトからの要求は`403`（`docs/v3/RFC.md` §12）。`devServer.host`が`localhost`（既定）なら`127.0.0.1`と`::1`の両方で待ち受ける。
- `ui`は、ページの URL とメタ（front matter など）をブラウザの表で編集し、元のファイルへ書き戻す。ページを表示するものではなく、ビルドも描画もしない（詳しくは下の「`kamado ui`」）。`globs`と、読まないフラグ（`--out`・`--force`・`--jobs`・`--skip-unchanged`・`--incremental`・`--verbose`）は、渡すとエラー。`--port`と`--open`/`--no-open`は`ui`だけのフラグで、ほかのコマンドに渡すとエラー。
- `ui-settings`は、`kamado ui`の画面が保存した設定を、プロジェクトごとに見る・消す（下の「画面の設定」）。ビルドも描画もしない。`--all`は`ui-settings delete`だけのフラグで、ほかのコマンドに渡すとエラー。

## `kamado ui`

```sh
kamado ui            # http://localhost:<devServer.port + 1>/ を開く
kamado ui --port 4000 --no-open
```

- 待ち受けるのは`localhost`（`127.0.0.1`と`::1`）だけで、ほかのホストや別のサイトからの要求は`403`。LAN に公開する指定は無い。ポートの既定は`devServer.port`に 1 を足したもの、`--open`の既定は`devServer.open`。開発サーバー（`kamado server`）とは別のプロセスで、同時に動かせる。
- ファイルを書き換える要求（`POST`と、設定を保存する`PUT`）は、起動のたびに作る秘密の値（トークン。画面の HTML に入っている）を持つものだけを受ける。画面と、画面が使う API の外からは書けない。
- 画面は 1 ページ 1 行の表で、1 画面に最大 5,000 行（100・500・1,000・5,000 から選ぶ。ページ送りあり）。検索欄は URL とメタの文字列値に部分一致で絞る。列は固定の`url`・`virtual`・`inputPath`と、メタのキーすべて（既定の並びは、固定の 3 列のあとにキー名の順）。`inputPath`は`dir.input`からの相対パスで見せる。メタのキーが固定の列と同じ名前（`url`・`virtual`・`inputPath`）のときは、メタのほうの列を「url（メタ）」のように見分けられる名前で出す。ヘッダには、サイトのリポジトリの branch と短い commit hash が`main @ 51df987`の形で出る（detached HEAD は hash だけ。リポジトリでないときは何も出ない。一覧をファイルから読み直すたびに取り直す）。並べ替えは、列のメニュー（下）から、その列の昇順・降順・解除（計画の順）を選ぶ。並べ替えは見えている 1 画面ではなく全ページに対して行い、1 ページ目に戻る。順は`@d-zero/shared`と同じ自然順（`page2`は`page10`より前。`url`と`inputPath`はディレクトリ・index・ファイル名の順）で、値の無いページ（そのキーが無い、`null`、仮想ページの`inputPath`）は昇順でも降順でも末尾。値を編集しても行はその場に残り、読み直すまで並べ直さない。列は、見出しの`⋮`ボタン（キーボードでは、見出しかセルで`Alt+↓`かメニューキー）で開くメニューから、左に固定・左右へ移動・並べ替え・幅の変更ができる。キーボードでは、`Tab`で見出しの行（`⋮`ボタン）に移り、`←`・`→`で列を選んで`Enter`・`Space`・`↓`でメニューを開く。見出しの名前は列をドラッグする持ち手で、クリックしても何も起きない。見出しのドラッグで並べ替え、見出しの右端のドラッグで幅を変えることもできる。固定した列は横にスクロールしても左端に残り、既定で固定されるのは`url`だけ（固定した列どうし、固定していない列どうしの中で並べ替える）。マシンの絶対パスは、画面にも、エラーメッセージにも出さない（設定ファイルの場所、`dir.input`、`dir.output`は`<root>`・`<input>`・`<output>`に置き換える。ほかの場所のパスは置き換えない）。画面の表記は、ブラウザの言語が日本語なら日本語、それ以外は英語で、画面の「Language/言語」で切り替えられる（訳すのは画面の文面だけ。サーバーとコアが返すエラーや警告、編集できない理由、列とキーの名前は英語のまま）。`<dialog>`・`content-visibility`・ARIA の grid が使える現行のブラウザが要る。
- キーボードで操作できる（ARIA の grid）。矢印で移動、`Home`/`End`（`Ctrl`で表の端）、`PageUp`/`PageDown`。編集は`Enter`・`F2`・ダブルクリックで始める。保存は`Enter`かセルを出たとき、取り消しは`Escape`。JSON の欄だけは`Ctrl`/`⌘` + `Enter`で保存する。真偽値は`Enter`・`Space`・チェックボックスのクリックで反転する。`Delete`はそのキーを消す。`Alt+Backspace`は、そのセルの値を HEAD の値に戻す（下の「値の書き場所と、HEAD との差」）。
- 値の編集は BurgerEditor v4 に合わせてある。入力の型は値から決める（真偽値はチェックボックス（そのキーの無いページは、その列のこの画面の値が真偽値だけなら空のチェックボックスで見せ、反転で`true`を書く）、数値は数値、`2026-01-02`や`2026-01-02T03:04:05Z`のように全体が日付の文字列は日付（書かれた日にそろえる。時刻は保存すると消える）、文字列・数値・真偽値だけの配列（空の配列も）はリスト（項目ごとの入力欄に追加・削除・上下への移動があり、「JSON として編集」で JSON の欄に切り替えられる）。それ以外の配列とオブジェクトは JSON の欄、それ以外と`null`は文字列。`+09:00`の付いた文字列や空白の入った文字列は日付にしない）。開いて何も変えずに閉じたセルは書かない。`null`は空に見え、編集すると文字列になる。数値の欄を空にすると`null`。JSON の欄は、JSON として正しくなるまで保存しない（`5`と書けば数値になる）。`Enter`では、正しくないあいだは編集欄が開いたまま理由を知らせる。正しくないまま（数値の欄で数値でない文字が入ったままも同じ）セルを出ると、保存せずに編集を捨てて、理由を知らせる。日本語入力の変換を確定する`Enter`は、保存にならない。「キーの追加」は名前と型を選ぶ。すでにある名前は無視する。追加した列のセルを編集すると、そのページにキーができる（文字列のキーは、空のままではできない。値を入れる）。
- **選択肢の列**: 列のメニューの「選択肢から選ぶ型にする…」で、メタのキーの列を、値を選択肢から選ぶ列にできる。選択肢は、全ページがその列に持つ値（文字列・数値・真偽値。配列は項目ごと）を多い順に並べたものから始まり、ダイアログで足したり消したりする（最大 200 個。数値の 1 と文字列の`"1"`は別の選択肢）。セルは、値が 1 つならセレクトボックス（選ぶとすぐ保存）、値が配列なら選択肢ごとのチェックボックス（`Enter`かセルを出たときに保存。触らずに出たら書かない）で編集する。ページが持つ値が選択肢に無くても、その値は選べる形で見せ、選び直すまで書き換えない。やめるには、メニューの「値の型に戻す」。選択肢はプロジェクトの設定（`kinds`）に保存する。`pages.layouts.dir`を設定したサイトでは、`layout`の列は何も設定しなくても選択肢の列になり、選択肢は`layouts.dir`の直下の`.tsx`・`.jsx`のファイル名（拡張子なし）。ファイルを足したら「読み直す」で選択肢に出る。この列のメニューには、型を変える項目は出ない。
- URL の欄を編集すると、ページのファイル（と sidecar）を新しい URL の場所へ移す。`outputPathField`で URL が決まるページは、そのキーの値を書き換える。`/a/`を`/b/`にしても、`/a/`の下のページは動かない。`inputPath`の欄を編集しても、ファイルを移せる（`dir.input`からの相対パスで、`customer/sending/`なら`customer/sending/index.html`。拡張子は変えられない。`outputPathField`で URL が決まるページは、ファイルだけが動いて URL は変わらない。仮想ページは編集できない）。どちらの移動でも、空になった元のディレクトリは消える（中に何かあれば残る）。編集できないセルは読み取り専用で、理由が付く。規則と一覧は`docs/v3/RFC.md` §14.2。
- 値は、そのキーを決めているソース（front matter・sidecar `.json`・`pages.overrides`）に書く。キーを消すと、下のソースの値が現れる。`pages.overrides`は、prebuild が毎回作り直す運用では元のデータが正で、`kamado ui`が書いた分は次の prebuild で消える。YAML のアンカー・エイリアス・`<<`を使った front matter は、そのファイルのキーをすべて編集できない。
- **値の書き場所と、HEAD との差**: 値が sidecar か`pages.overrides`に書いてあるセルには、下端に小さく「sidecar」「overrides」と出る（ページのファイルの値には出ない）。表の上の 1 行に、ラベルの意味（`pages.overrides`のファイルの名前も）が書いてある。サイトが git のリポジトリにあるときは、HEAD（今チェックアウトしているコミット）と値が違うセルの左端に、5px の帯が出る: 変更は青、追加は緑、削除は赤。色のほかに、`title`と読み上げの文字で種類を伝える。帯を押すか、セルで`Alt+Backspace`を押すと、確認のダイアログが出る。今の値と HEAD の値、書き込むファイルを見せるので、確かめたら戻す（列のメニューにも同じ項目がある）。戻すのは、値が HEAD と違うファイルのそのキーだけで、`pages.overrides`に項目を足すことも、sidecar を作ることもしない。HEAD に無いページ（新しいファイル）と、編集できないキーは戻せない。git が無い・リポジトリでない・まだコミットが無いときは、何も出ない。比べるのは表示している行のファイルだけで、`git status`は使わない。`.gitignore`に当たるファイル（prebuild が作る`pages.overrides`など）は比べない。`core.autocrlf`などでファイルの内容が git に入っているものと違うリポジトリでは、全ファイルを違うものとして比べるので、重くなる。
- 読み込みは、画面を開いたとき、別のタブから戻ったとき、「Read again」のボタン、URL を変えたあと。ファイルを監視はしない。読んだあとでファイルが変わっていたら、書かずに「別の場所で変更された」と知らせて読み直す。書いた内容は、`kamado server`を再読み込みすれば反映される（開発サーバーは要求のときに一覧を作り直す）。
- **画面の設定**: 表示言語と 1 画面の行数と並び順と列の並び・固定・幅と列の選択肢は、`~/.config/kamado/ui-settings.json`に保存して、次に開くときに使う。言語はどのプロジェクトでも同じ、行数と並び順と列の設定と選択肢はプロジェクトごと（設定ファイルの実体パスで見分ける）。ファイルは所有者だけが読み書きでき、ほかのプロジェクトのパスも持つので、リポジトリには置かない。並び順・列の設定・選択肢を足す前の kamado が同じファイルを保存すると、それらの設定は消える（設定ファイルの版は 1 のまま）。壊れたファイルは`ui-settings.json.<日時>.bak`へ移して作り直し、新しい版の kamado が書いたファイルは、使わず・書き換えずに既定値で動く（どちらも端末と画面に警告する）。環境変数`KAMADO_UI_SETTINGS`で別のファイルを指せる（試すとき用）。
  - `kamado ui-settings list`は、保存のあるプロジェクトを一覧する（設定ファイルがもう無いものには印が付く）。
  - `kamado ui-settings reset`は、`--config`（既定`./kamado.config.jsonc`）のプロジェクトの設定を消して、初期値に戻す。言語の設定は変えない。
  - `kamado ui-settings delete <config-file>`は、指したプロジェクトの設定を消す（設定ファイルか、それのあるディレクトリ。もう無いプロジェクトは`list`に出たパスで指す）。設定ファイルが壊れているときと新しい版のときは、何も変えずにエラーにする。`delete --all`は、設定ファイルごと消して、全プロジェクトと言語の設定がなくなる。
- 画面の部品（`packages/kamado/client`）は、パッケージのビルド（`yarn build`）で`dist/ui`にまとまる。`yarn dev`（`tsc --watch`）は画面を作り直さない。

## プログラムから

```ts
import path from 'node:path';

import { build, pages, start, ui } from 'kamado';

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

// The editor of the pages (what `kamado ui` runs): it listens until it is closed.
const editor = await ui(config, { open: false });
console.log(editor.url);
await editor.close();
```

`ui()`のオプションは`port`・`open`・`cacheDir`・`write`（ログの行の出し先）・`settingsFile`（画面の設定の保存先。既定は上の場所）で、`{ url, close() }`を返す。`close()`は待ち受けをやめる（`build.incremental`のときは、plan cache も書く）。

`build()`・`start()`・`pages()`・`ui()`の第 1 引数は、設定ファイルの**絶対パス**（相対パスの基準になるディレクトリが設定ファイルの場所のため）。`pages()`のオプションは`incremental`と`cacheDir`で、`PageMap`（`docs/v3/RFC.md` §14.1）を返す。ファイルには書かない（書くなら`JSON.stringify`して自分で書く）。`build()`のオプションは CLI のフラグと同じ（`incremental`/`force`/`skipUnchanged`/`targets`/`jobs`/`cacheDir`）。`cacheDir`の相対パスは、設定ファイルのディレクトリからのパス（CLI の`--cache-dir`は cwd 基準なので、同じ相対パスでも別のキャッシュを指す。`/`で始まるパスは同じ）。`targets`の相対パスは、設定ファイルのディレクトリからのパス（glob とパスの扱いは CLI と同じ。無いファイルは例外、何も選ばなかったものは`report.warnings`）。`report`は各ページの URL・入出力のパス・状態（`built`/`cached`/…）・メタデータを持つ。

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
