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
| `data`      | JSON / YAML / HTML / テキスト、実行するスクリプト（`.ts`/`.js`等）のデータと、設定内のリテラル |
| `html`      | doctype・整形・圧縮・文字参照・画像寸法・DOM ルール・取り込み・head への挿入・ページ別の上書き |
| `sitemap`   | `sitemap.xml`（`false`で無効）                                                                 |
| `styles`    | `@import`の展開、alias、banner、sourcemap、圧縮                                                |
| `scripts`   | esbuild でのバンドル（alias / define / target / banner / sourcemap / 圧縮）                    |
| `devServer` | `port` / `host` / `allowedHosts` / `open` / `startPath` / `proxy`                              |
| `build`     | `jobs` / `incremental` / `cacheDir` / `skipUnchanged` / `report`                               |

## コマンド

```sh
kamado build [globs...] [--incremental] [--force] [--skip-unchanged] [--verify-deps]
                         [--jobs <n|auto>] [--cache-dir <dir>] [-c, --config <file>] [--verbose]
kamado server           [--cache-dir <dir>] [-c, --config <file>] [--verbose]
kamado pages            [--out <file>] [--incremental] [--cache-dir <dir>] [-c, --config <file>]
kamado ui               [--port <n>] [--open | --no-open] [--cache-dir <dir>] [-c, --config <file>]
kamado sync <name|path> [-y, --yes] [--cache-dir <dir>] [-c, --config <file>]
kamado ui-settings      list | reset [-c, --config <file>] | delete <config-file> | delete --all
kamado --help           (-h)
```

- `--config`/`-c`を省略すると、カレントディレクトリの`kamado.config.jsonc`を使う。`--cache-dir`は差分ビルドの manifest や plan cache の置き場を変える（`build`・`server`・`pages`・`ui`・`sync`。`sync`では、ページの一覧を作るための plan cache の置き場）。相対パスは**打った場所（cwd）基準**。
- **実行するデータファイル**: `data.dir`の`.ts`/`.mts`/`.js`/`.mjs`は default export の値、または`{ readFile, signal }`を受け取る関数（`await`できる）で、値は JSON にできるものに限る。`export const maxAge = <秒>`（開発サーバーが時間でも再実行）と`export const timeout = <秒>`（既定 60 秒）が書ける。`build`は 1 つでも失敗したら exit 1。仕様は`docs/v3/RFC.md` §3.2。`build()`の`report.data`には、`--verbose`のためのデータファイルごとの 1 行（実行した・所要時間・値のハッシュの先頭）が入る。
- `build`は設定の対象を全部出力する。`globs`を渡すとその入力だけ（相対パスは打った場所からのパス。ディレクトリはその中のすべて。無いファイルと、先頭が`!`の否定はエラー。何も選ばなかったものは警告）。`--incremental`は前回から変わっていないものを飛ばす（`--force`で無視）。`--jobs`は並列度（JSX の描画のワーカーと Rust のスレッドの数）で、`auto`（既定）は使える CPU の数から決める。JSX のページは、読んだ`data`のキーが変わったときだけ描き直す（`--verbose`が理由を書く）。`--verify-deps`は、描いたページを新しいワーカーで描き直して HTML を比べ、モジュールの変数にデータを貯めたページを見つけて失敗にする。重い計算を全ページで 1 回にしたいときは、`kamado/jsx`の`memo(fn)`を使う（引数を`Object.is`で比べる。`props.data`を渡すと、読んだキーが呼び出したページの依存になる）。
- `pages`は、ビルドせずに全ページの一覧を JSON で書き出す（標準出力か`--out`。相対パスは打った場所からのパス）。1 ページが 1 要素で、URL・入出力のパス・`fileSlug`・`filePathStem`・`extension`・階層（`depth`と、親のディレクトリの`parent`）・仮想ページかどうか・マージ後の`meta`を持つ。ディレクトリマップをスプレッドシートに写すためのもの（形は`docs/v3/RFC.md` §14.1）。入力ファイルのない仮想ページ（`pages.overrides`）は`inputPath`と`extension`が`null`で、`outputPath`は書き出されないがあるはずの場所。`globs`と、読まないフラグ（`--force`・`--jobs`・`--skip-unchanged`・`--verbose`）は、渡すとエラー。`--incremental`は plan cache を読んで更新する。端末には、読み始めと終わり（と、計画の警告があれば`warning: ...`）を標準エラーに出す。
- `server`はリクエストごとに依存ファイルを stat し、変わっていなければ前回の結果を返す。ファイルは書き出さない。ライブリロードはない。変更したコンポーネントはワーカーを作り直して反映する。応えるのは`localhost`・IP アドレス・`devServer.host`・`devServer.allowedHosts`宛ての要求だけで、別のサイトからの要求は`403`（`docs/v3/RFC.md` §12）。`devServer.host`が`localhost`（既定）なら`127.0.0.1`と`::1`の両方で待ち受ける。位置引数と、読まないフラグ（`--force`・`--incremental`・`--jobs`・`--skip-unchanged`・`--out`・`--port`など）は、渡すとエラー。
- `ui`は、ページの URL とメタ（front matter など）をブラウザの表で編集し、元のファイルへ書き戻す。ページを足す・無くす・仮想ページにすることもできる。ページを表示するものではなく、ビルドも描画もしない（詳しくは下の「`kamado ui`」）。`globs`と、読まないフラグ（`--out`・`--force`・`--jobs`・`--skip-unchanged`・`--incremental`・`--verbose`）は、渡すとエラー。`--port`と`--open`/`--no-open`は`ui`だけのフラグで、ほかのコマンドに渡すとエラー。
- `sync`は、プロジェクトのスクリプトを実行する（`ui.syncFunctions`の`name`か、ファイルのパスで指す）。返した「あるべき全ページの一覧」との差を見せて、確認のうえローカルリポジトリのファイルに適用する（`--yes`で確認を省く。端末でなければ`--yes`が要る）。スクリプトが失敗したときと、返した内容が適用できないときは、何も適用しない。書き方は下の「同期スクリプトの書き方」。位置引数は 1 つ。`--yes`は`sync`だけのフラグで、ほかのコマンドに渡すとエラー。
- `ui-settings`は、`kamado ui`の画面が保存した設定を、プロジェクトごとに見る・消す（下の「画面の設定」）。ビルドも描画もしない。`--all`は`ui-settings delete`だけのフラグで、ほかのコマンドに渡すとエラー。

## `kamado ui`

```sh
kamado ui            # http://localhost:<devServer.port + 1>/ を開く
kamado ui --port 4000 --no-open
```

- 待ち受けるのは`localhost`（`127.0.0.1`と`::1`）だけで、ほかのホストや別のサイトからの要求は`403`。LAN に公開する指定は無い。ポートの既定は`devServer.port`に 1 を足したもの、`--open`の既定は`devServer.open`。開発サーバー（`kamado server`）とは別のプロセスで、同時に動かせる。
- ファイルを書き換える要求（`POST`と、設定を保存する`PUT`）は、起動のたびに作る秘密の値（トークン。画面の HTML に入っている）を持つものだけを受ける。画面と、画面が使う API の外からは書けない。
- 画面は 1 ページ 1 行の表で、1 画面に最大 5,000 行（100・500・1,000・5,000 から選ぶ。ページ送りあり）。検索欄は URL とメタの文字列値に部分一致で絞る。列は、どの行も持つ固定の 6 列と、メタのキーすべて（既定の並びは、固定の 6 列のあとにキー名の順）。固定の 6 列は、`url`・`virtual`・`inputPath`と、読み取り専用の`outputPath`・`parent`・`depth`。並びを決めるメタの`order`（下の「並び順」）は、どのページにも書かれていなくても、いつも列として出る（この列では並べ替えができない）。列の並びを保存したあとに増えた列は、保存した並びの最後に出る（並び替えで動かせる）。古い版の kamado が同じ設定ファイルを保存すると、その版が知らない列（`outputPath`・`parent`・`depth`）の並び・固定・幅と、それによる並べ替えは消える。`outputPath`は出力ファイル（`dir.output`からの相対パス）、`parent`は 1 つ上のページの URL、`depth`は階層の深さ。`inputPath`は`dir.input`からの相対パスで見せる。メタのキーが固定の列と同じ名前（`url`・`virtual`・`inputPath`・`outputPath`・`parent`・`depth`）のときは、メタのほうの列を「url（メタ）」のように見分けられる名前で出す。ヘッダには、サイトのリポジトリの branch と短い commit hash が`main @ 51df987`の形で出る（detached HEAD は hash だけ。リポジトリでないときは何も出ない。一覧をファイルから読み直すたびに取り直す）。並べ替えは、列のメニュー（下）から、その列の昇順・降順・解除（計画の順）を選ぶ。並べ替えは見えている 1 画面ではなく全ページに対して行い、1 ページ目に戻る。順は`@d-zero/shared`と同じ自然順（`page2`は`page10`より前。`url`・`inputPath`・`outputPath`・`parent`はディレクトリ・index・ファイル名の順）で、値の無いページ（そのキーが無い、`null`、仮想ページの`inputPath`、ルートのページの`parent`）は昇順でも降順でも末尾。値を編集しても行はその場に残り、読み直すまで並べ直さない（並べ替えを解除しているときに`order`を編集すると、一覧を取り直して、行が並びの中で移った場所を開く。別のページ送りへ移るときは、そのページを開き、フォーカスは同じ行の同じ列に残る）。列は、見出しの`⋮`ボタン（キーボードでは、見出しかセルで`Alt+↓`かメニューキー）で開くメニューから、左に固定・左右へ移動・並べ替え・幅の変更ができる。キーボードでは、`Tab`で見出しの行（`⋮`ボタン）に移り、`←`・`→`で列を選んで`Enter`・`Space`・`↓`でメニューを開く。見出しの名前は列をドラッグする持ち手で、クリックしても何も起きない。見出しのドラッグで並べ替え、見出しの右端のドラッグで幅を変えることもできる。固定した列は横にスクロールしても左端に残り、既定で固定されるのは`url`だけ（固定した列どうし、固定していない列どうしの中で並べ替える）。マシンの絶対パスは、画面にも、エラーメッセージにも出さない（設定ファイルの場所、`dir.input`、`dir.output`は`<root>`・`<input>`・`<output>`に置き換える。ほかの場所のパスは置き換えない）。画面の表記は、ブラウザの言語が日本語なら日本語、それ以外は英語で、画面の「Language/言語」で切り替えられる（訳すのは画面の文面だけ。サーバーとコアが返すエラーや警告、編集できない理由、列とキーの名前は英語のまま）。`<dialog>`・`content-visibility`・ARIA の grid が使える現行のブラウザが要る。
- キーボードで操作できる（ARIA の grid）。矢印で移動、`Home`/`End`（`Ctrl`で表の端）、`PageUp`/`PageDown`。編集は`Enter`・`F2`・ダブルクリックで始める。保存は`Enter`かセルを出たとき、取り消しは`Escape`。JSON の欄だけは`Ctrl`/`⌘` + `Enter`で保存する。真偽値と`virtual`は`Enter`・`Space`・チェックボックスのクリックで反転する。`Delete`はそのキーを消す。`Alt+Backspace`は、そのセルの値を HEAD の値に戻す（下の「値の書き場所と、HEAD との差」）。
- 値の編集は BurgerEditor v4 に合わせてある。入力の型は値から決める（真偽値はチェックボックス（そのキーの無いページは、その列のこの画面の値が真偽値だけなら空のチェックボックスで見せ、反転で`true`を書く）、数値は数値、`2026-01-02`や`2026-01-02T03:04:05Z`のように全体が日付の文字列は日付（書かれた日にそろえる。時刻は保存すると消える）、文字列・数値・真偽値だけの配列（空の配列も）はリスト（項目ごとの入力欄に追加・削除・上下への移動があり、「JSON として編集」で JSON の欄に切り替えられる）。それ以外の配列とオブジェクトは JSON の欄、それ以外と`null`は文字列。`+09:00`の付いた文字列や空白の入った文字列は日付にしない）。開いて何も変えずに閉じたセルは書かない。`null`は空に見え、編集すると文字列になる。数値の欄を空にすると`null`。JSON の欄は、JSON として正しくなるまで保存しない（`5`と書けば数値になる）。`Enter`では、正しくないあいだは編集欄が開いたまま理由を知らせる。正しくないまま（数値の欄で数値でない文字が入ったままも同じ）セルを出ると、保存せずに編集を捨てて、理由を知らせる。日本語入力の変換を確定する`Enter`は、保存にならない。「キーの追加」は名前と型を選ぶ。すでにある名前は無視する。追加した列のセルを編集すると、そのページにキーができる（文字列のキーは、空のままではできない。値を入れる）。
- **選択肢の列**: 列のメニューの「選択肢から選ぶ型にする…」で、メタのキーの列を、値を選択肢から選ぶ列にできる。選択肢は、全ページがその列に持つ値（文字列・数値・真偽値。配列は項目ごと）を多い順に並べたものから始まり、ダイアログで足したり消したりする（最大 200 個。数値の 1 と文字列の`"1"`は別の選択肢）。セルは、値が 1 つならセレクトボックス（選ぶとすぐ保存）、値が配列なら選択肢ごとのチェックボックス（`Enter`かセルを出たときに保存。触らずに出たら書かない）で編集する。ページが持つ値が選択肢に無くても、その値は選べる形で見せ、選び直すまで書き換えない。やめるには、メニューの「値の型に戻す」。選択肢はプロジェクトの設定（`kinds`）に保存する。`pages.layouts.dir`を設定したサイトでは、`layout`の列は何も設定しなくても選択肢の列になり、選択肢は`layouts.dir`の直下の`.tsx`・`.jsx`のファイル名（拡張子なし）。ファイルを足したら「読み直す」で選択肢に出る。この列のメニューには、型を変える項目は出ない。
- URL の欄を編集すると、ページのファイル（と sidecar）を新しい URL の場所へ移す。`outputPathField`で URL が決まるページは、そのキーの値を書き換える。`/a/`を`/b/`にしても、`/a/`の下のページは動かない。`inputPath`の欄を編集しても、ファイルを移せる（`dir.input`からの相対パスで、`customer/sending/`なら`customer/sending/index.html`。拡張子は変えられない。`outputPathField`で URL が決まるページは、ファイルだけが動いて URL は変わらない）。どちらの移動でも、空になった元のディレクトリは消える（中に何かあれば残る）。編集できないセルは読み取り専用で、理由が付く。規則と一覧は`docs/v3/RFC.md` §14.2。
- **ページを足す・仮想ページにする・無くす**: ヘッダの「ページの追加」は、URL と`inputPath`を書くダイアログを開く。`inputPath`を書くと、その場所にページのファイルを作る（ファイル名は拡張子まで書く。拡張子は`.html`・`.htm`・`.tsx`・`.jsx`で、`.html`・`.htm`は空のファイル、`.tsx`・`.jsx`は何も描かないコンポーネント。URL を空にすると、ファイルの位置の URL になる）。`inputPath`が空なら、確かめたうえで、ファイルの無い仮想ページを`pages.overrides`に足す。`inputPath`のセルを空にすると、ファイルが無くなる: ページは URL ごと無くなるので、「仮想化」（URL とメタを`pages.overrides`に残して、ファイルだけ消す）か「削除」（ページごと無くす）かを尋ねる。`virtual`のセルはチェックボックスで、入れると仮想化（確かめてから）、外すと URL の場所にファイルを作って実在のページにする（メタはファイルへ移る）。仮想ページの`inputPath`にパスを書いても、その場所にファイルを作れる。`url`のセルを空にすると、確かめたうえでページを削除する（仮想ページも）。仮想化と削除は、ページのファイルと sidecar を消す。**本文も一緒に失われ**、画面からは戻せない（コミットしてあれば git から戻せる。未コミットかどうかは確かめない）。確認のダイアログに、消えるファイルの名前が出る。仮想ページを書くには、設定に`pages.overrides`が要る。ファイルを消す編集は、消すファイルを先に`.<名前>.kamado-removed`の名前に移してから、ほかの書き込みが済んだあとで消す（途中で失敗すれば、名前を戻して元のまま）。最後の削除だけが失敗したときは、その別名のファイルが`dir.input`に残り（編集は成功として、状態欄にそのファイルの名前を知らせる）、次の編集は残ったものを避けて番号を付けた名前を使う。
- 値は、そのキーを決めているソース（front matter・sidecar `.json`・`pages.overrides`）に書く。キーを消すと、下のソースの値が現れる。`pages.overrides`は、prebuild が毎回作り直す運用では元のデータが正で、`kamado ui`が書いた分は次の prebuild で消える。YAML のアンカー・エイリアス・`<<`を使った front matter は、そのファイルのキーをすべて編集できない。
- **値の書き場所と、HEAD との差**: 値が sidecar か`pages.overrides`に書いてあるセルには、下端に小さく「sidecar」「overrides」と出る（ページのファイルの値には出ない）。表の下の 1 行に、ラベルの意味（`pages.overrides`のファイルの名前も）が書いてある。サイトが git のリポジトリにあるときは、HEAD（今チェックアウトしているコミット）と値が違うセルの左端に、5px の帯が出る: 変更は青、追加は緑、削除は赤。色のほかに、`title`と読み上げの文字で種類を伝える。帯を押すか、セルで`Alt+Backspace`を押すと、確認のダイアログが出る。今の値と HEAD の値、書き込むファイルを見せるので、確かめたら戻す（列のメニューにも同じ項目がある）。戻すのは、値が HEAD と違うファイルのそのキーだけで、`pages.overrides`に項目を足すことも、sidecar を作ることもしない。HEAD に無いページ（新しいファイル）と、編集できないキーは戻せない。git が無い・リポジトリでない・まだコミットが無いときは、何も出ない。比べるのは表示している行のファイルだけで、`git status`は使わない。`.gitignore`に当たるファイル（prebuild が作る`pages.overrides`など）は比べない。`core.autocrlf`などでファイルの内容が git に入っているものと違うリポジトリでは、全ファイルを違うものとして比べるので、重くなる。
- 読み込みは、画面を開いたとき、別のタブから戻ったとき、「Read again」のボタン、URL やファイルの場所を変えたあと、ページを足した・仮想化した・無くしたあと。ファイルを監視はしない。読んだあとでファイルが変わっていたら、書かずに「別の場所で変更された」と知らせて読み直す。書いた内容は、`kamado server`を再読み込みすれば反映される（開発サーバーは要求のときに一覧を作り直す）。
- **画面の設定**: 表示言語と 1 画面の行数と並び順と列の並び・固定・幅と列の選択肢は、`~/.config/kamado/ui-settings.json`に保存して、次に開くときに使う。言語はどのプロジェクトでも同じ、行数と並び順と列の設定と選択肢はプロジェクトごと（設定ファイルの実体パスで見分ける）。ファイルは所有者だけが読み書きでき、ほかのプロジェクトのパスも持つので、リポジトリには置かない。並び順・列の設定・選択肢を足す前の kamado が同じファイルを保存すると、それらの設定は消える（設定ファイルの版は 1 のまま）。壊れたファイルは`ui-settings.json.<日時>.bak`へ移して作り直し、新しい版の kamado が書いたファイルは、使わず・書き換えずに既定値で動く（どちらも端末と画面に警告する）。環境変数`KAMADO_UI_SETTINGS`で別のファイルを指せる（試すとき用）。
  - `kamado ui-settings list`は、保存のあるプロジェクトを一覧する（設定ファイルがもう無いものには印が付く）。
  - `kamado ui-settings reset`は、`--config`（既定`./kamado.config.jsonc`）のプロジェクトの設定を消して、初期値に戻す。言語の設定は変えない。
  - `kamado ui-settings delete <config-file>`は、指したプロジェクトの設定を消す（設定ファイルか、それのあるディレクトリ。もう無いプロジェクトは`list`に出たパスで指す）。設定ファイルが壊れているときと新しい版のときは、何も変えずにエラーにする。`delete --all`は、設定ファイルごと消して、全プロジェクトと言語の設定がなくなる。
- **列の名前と説明**: `kamado.config.jsonc`の`ui.keys`で、メタのキーの列に名前（`label`）と説明（`description`）を付けられる。個人の画面の設定とは違い、リポジトリでチームと共有する。`ui`を読むのは`kamado ui`だけで、ビルドと開発サーバーは読まない。
  - `label`と`description`は、文字列か、言語をキーにした文字列のオブジェクト。言語名は検査せず、画面が読むのは画面の言語（`en`・`ja`）と`en`だけで、それ以外の名前は書いても出ない。
  - 画面の言語、`en`の順に探す。どちらも無いとき、`label`はキーの名前のまま、`description`は出さない。`null`と空の文字列は、書かないのと同じ。
  - セルヘッドに`label`を出し、キーの名前と`description`はヘッダーのホバーと列メニューの先頭に出す。メニューの名前と選択肢のダイアログ、保存や失敗のメッセージが列を指すときも`label`で言う。
  - 編集・検索・並べ替えと、保存した列の設定は、これまでどおりキーで動く。固定の列には効かず、どのページも持たないキーの列は足さない。
  - 設定ファイルは起動時に 1 回だけ読む。`ui.keys`を変えたら`kamado ui`を起動し直す（「Read again」はページを読み直すが、設定は読み直さない）。
  - 例: `{ "ui": { "keys": { "title": { "label": { "ja": "タイトル", "en": "Title" }, "description": "<title>とパンくずに使う" } } } }`は、`title`の列を、日本語の画面では「タイトル」、英語の画面では「Title」と呼ぶ。
- **同期**: `ui.syncFunctions`に操作があると、ヘッダーに緑の「同期」ボタンが出る。押すと操作の一覧が開き、選ぶとスクリプトを実行する（実行中のダイアログにログとキャンセル。表は編集できない）。終わると、同じダイアログが差分の確認（件数と、削除・URL の移動・ページの追加・メタの変更ごとの一覧。ほかに、ファイルの移動・仮想化・実体化があれば）に変わり、「適用」で適用する。失敗したときは、メッセージと詳細とログを出して、「もう一度実行」できる。スクリプトを実行するのは、この操作と`kamado sync`だけで、`kamado ui`を開いただけでは実行しない。詳しくは「同期スクリプトの書き方」。
- 画面の部品（`packages/kamado/client`）は、パッケージのビルド（`yarn build`）で`dist/ui`にまとまる。`yarn dev`（`tsc --watch`）は画面を作り直さない。

## 並び順

ナビゲーション（`nav()`）と`pages`の並びは、メタの`order`で決まる。front matter・`export const meta`・sidecar `.json`・`pages.overrides`の`meta`のどれにも書けて、優先順位はほかのキーと同じ。`pages.overrides`の項目の順は、並びに関係しない。

- 並びは兄弟の中だけで効く。兄弟は、`parent`（`kamado pages`の一覧にある）が同じページ。ディレクトリの`index`のページは、そのディレクトリとして、ほかの兄弟と並ぶ。
- 兄弟は`order`の昇順で、`order`が無いページは 0。同じ値どうしは URL の自然順（`index`が先で、数は数として比べる）。`pages`は、この順に木をたどった並び（親が先、続けて子）。
- ディレクトリの位置は、その`index`のページ（実在でも仮想でも）の`order`で決まる。`index`のページが無いディレクトリは 0 で、並べたいときは、そのディレクトリを仮想ページにして`order`を書く。
- 値は、数値か、`parseFloat`で読める文字列（`"03"`は 3）。数にならない値は 0 で、エラーにはしない。書いた値そのものは変わらない。
- `order`を書かないページは 0 なので、正の値を書いたページは、書かないページの後ろに並ぶ。先頭に出すには負の値を書く。

```html
---
title: 会社情報
order: -1
---
```

スプレッドシートなどの行の順を取り込むときは、行の番号を`meta.order`に書いて返す（`kamado sync`は、`order`をほかのメタのキーと同じに適用する。下の「同期スクリプトの書き方」）。戻り値の配列の順は、並びに関係しない。

## 同期スクリプトの書き方

スプレッドシートなど、kamado の外にあるデータと、サイトのディレクトリマップ（ページの一覧）を同期するための仕組み。**スクリプトを 1 つ書いて設定に登録**すると、`kamado sync`と、`kamado ui`の画面の「同期」ボタンから実行できる。

- **書き出し**（kamado → 外）: スクリプトが渡された一覧を外のデータに書く。何も返さない。kamado は何も変えない。
- **取り込み**（外 → kamado）: スクリプトが外のデータから「あるべき全ページの一覧」を作って返す。kamado が今の一覧との差（追加・削除・URL の移動・仮想化・メタの変更）を見つけ、確認を経て、ローカルリポジトリのファイルに適用する。**差分を判定するのはスクリプトではなく kamado**。

### 登録と実行

`kamado.config.jsonc`の`ui.syncFunctions`に、操作ごとに`name`・`label`・`script`を書く。

```jsonc
{
	"ui": {
		"syncFunctions": [
			{
				"name": "export-sheet",
				"label": { "ja": "シートへ書き出す", "en": "Export to the sheet" },
				"script": "./scripts/sheet-export.mjs",
			},
			{
				"name": "import-sheet",
				"label": { "ja": "シートから取り込む", "en": "Import from the sheet" },
				"script": "./scripts/sheet-import.mjs",
			},
		],
	},
}
```

- `name`は空でなく、操作ごとに違う文字列（文字の制限は無い）。`kamado sync <name>`で指す。
- `label`は画面に出す名前。文字列か、言語（`en`・`ja`）をキーにした文字列のオブジェクト（画面の言語、`en`、`name`の順に探す）。必須。
- `script`は、設定ファイルのあるディレクトリからの相対パス（絶対パスも可）。
- 実行するのは同期を実行したときだけ。`kamado build`・`kamado server`・`kamado pages`と、`kamado ui`の起動・読み込みは、スクリプトを実行しない。

```sh
kamado sync import-sheet          # 差分を見せて、y と答えると適用する
kamado sync import-sheet --yes    # 確認なしで適用する（端末でないと確認できないので、そのときはこちら）
kamado sync ./scripts/sheet-import.mjs   # 登録していないスクリプトを、パスで指す（打った場所からの相対パス）
```

`--yes`（`-y`）を付けると、差分の要約は出ず、適用した件数だけが出る。適用せずに差分を見たいときは、`--yes`を付けずに、端末でない場所（標準入力をつながないなど）で実行する。要約を出して、適用せずにエラーで終わる。

`kamado sync <引数>`は、引数が`name`に一致すればその操作を、一致しなければパスとして読む。ログと差分の要約は標準エラーに出る。終了コードは、終わったとき（適用した・差分が無い・確認で`n`と答えた）が 0、失敗したときと、適用できなかったときが 1、`Ctrl-C`でのキャンセル（実行中でも、確認の質問の途中でも）が 130。`kamado ui`では、ヘッダーの「同期」ボタンから操作を選ぶ。実行中はログが出て、終わると差分の確認が出る。

**同期は、あなたのスクリプトを、あなたの権限で実行する。** 認証情報（API のキーなど）は環境変数で渡し、スクリプトやリポジトリに書かない。スクリプトは、`kamado`を実行したプロセスの環境変数をそのまま受け取る。

### スクリプトの形

ESM のモジュールで、default export が関数。`kamado`は変換しないので、Node がそのまま読み込める JavaScript（`.mjs`、または`"type": "module"`のパッケージの`.js`）にする。

```js
// scripts/sheet-import.mjs
/** @type {import('kamado').SyncScript} */
export default async (pages, ctx) => {
	ctx.log('info', `${pages.length} pages now`);
	return rows; // あるべき全ページ（下の「戻り値」）
};
```

型は`kamado`から読める。`SyncScript`・`SyncPage`・`SyncContext`・`SyncResult`・`Label`（TypeScript なら`import type { SyncScript } from 'kamado'`）。

**第 1 引数`pages`**は、同期を始めた時点のローカルリポジトリのファイルから作った、全ページの配列。`kamado pages`が書き出す一覧と同じ形・同じ順で、1 件は次のとおり（型は`PageMapEntry`）。

| フィールド                              | 意味                                                                                                                                                                                                       |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`                                   | ページの URL（`/`、`/about/`、`/about/history.html`）。`/`で始まる                                                                                                                                         |
| `inputPath`                             | ページのファイルの**絶対パス**。ファイルの無い仮想ページは`null`                                                                                                                                           |
| `outputPath`                            | 書き出される場所の絶対パス（仮想ページは書き出されないが、あるはずの場所）                                                                                                                                 |
| `fileSlug`・`filePathStem`・`extension` | ファイル名から決まる値（`extension`は`.html`・`.tsx`など。仮想ページは`null`）。`index`のページの`fileSlug`は親のディレクトリの名前で、ルートでは入力ディレクトリの名前（`src`など）になる。同期は読まない |
| `depth`・`parent`                       | URL の階層の深さと、親のディレクトリの URL（ルートは`null`）                                                                                                                                               |
| `virtual`                               | `pages.overrides`だけにあるページ（ファイルの無い、URL だけのページ）なら`true`                                                                                                                            |
| `meta`                                  | ページのメタ（front matter・sidecar・`pages.overrides`をマージした全キー）。値は JSON                                                                                                                      |

**第 2 引数`ctx`**:

- `ctx.log(type, message)`は、`type`が`'info'`・`'warn'`・`'error'`の 1 行を、実行中の画面と`kamado sync`の標準エラーに出す。1 行が 2,000 文字を超えると切られる。画面は新しい 1,000 行だけを持ち、古い行は捨てて、捨てた数を出す。`kamado sync`の標準エラーには、全部の行が出る。制御文字は文字として見える形に直して出る。標準エラーの行は`[info] メッセージ`の形。
- `ctx.inputDir`は、`dir.input`の絶対パス。シートに載せるパスを、マシンに依らない相対パスにするために使う（`path.relative(ctx.inputDir, page.inputPath)`）。

スクリプトの標準出力・標準エラーは端末にそのまま出る。標準入力は読めない。スクリプトは設定ファイルのあるディレクトリで動く。相対パス（`readFile('./data.csv')`）は、`kamado`をどこから実行しても、そこからのパスになる。スクリプトの隣のファイルは`new URL('./data.json', import.meta.url)`でも指せる。

### 戻り値

| 返すもの                            | 意味                                                         |
| ----------------------------------- | ------------------------------------------------------------ |
| `undefined`・`null`（何も返さない） | 何も適用しない。書き出しのスクリプトはこれ                   |
| ページの配列                        | **あるべき全ページ**。今あって、配列に無いページは削除される |

配列の 1 件（`SyncPage`）は`{ url, inputPath?, virtual?, meta? }`。`pages`の 1 件をそのまま返してもよい（この 4 つだけを読み、ほかのフィールドは無視する）。配列の順は意味を持たない。

- `url`: 必須。`/`で始まる文字列。同じ`url`は 2 回書けない。
- `inputPath`: ページのファイルの場所。`dir.input`からの相対パス（`/`区切り。`about/index.html`）か、`dir.input`の中の絶対パス。`null`か省略は「言わない」。同じ`inputPath`は 2 回書けない。`virtual: true`の行に書けない。
- `virtual`: ファイルの無いページなら`true`、ファイルのあるページなら`false`。今あるページでは、省略は「変えない」。**新しいページでは必須**。
- `meta`: そのページのメタの**全体**。書いたキーは、値が違えば書き換え、無かったキーは足し、**書かなかったキーは消す**。`meta`ごと省略すると、メタに触らない。値は JSON（文字列・数値・真偽値・`null`・配列・オブジェクト）。`"1"`と`1`は別の値で、型を合わせるのはスクリプトの仕事。空の文字列`''`と、キーが無いことも別（`title: ''`と書けば、空の`title`を持つ）。シートの空のセルをキーが無いこととして扱うなら、そのキーを`meta`に入れない。

#### どのページのことか（突き合わせ）

kamado は、返された行が今のどのページかを、次の順で**決める**（ページの中身の似ていることからは推測しない）。

1. 行の`inputPath`が、今のページのファイルと同じなら、同じページ。`url`が違えば、**URL の移動**（ファイルも新しい URL の場所へ移る）。
2. 1 で当たらず、行の`url`が、まだ当たっていない今のページの`url`と同じなら、同じページ。
3. どちらにも当たらない行は、**新しいページ**。`virtual: true`なら仮想ページを作り、`virtual: false`なら、`inputPath`があればその場所に、無ければ URL の場所にファイルを作る（`.html`は空のファイル。メタはそのファイルに書く）。
4. どの行にも当たらない今のページは、**削除**（ファイルも消える）。

だから、**URL を書き換えても本文を残したいなら、`inputPath`の列を残して返す**。`inputPath`を返さないと、URL を変えた行は、古いページの削除と、空の新しいページの作成になる。`inputPath`を変えても、URL がファイルの場所で決まるページ（ほとんどのページ）では何も移さない（ファイルを移すと URL が変わるため。ページを動かすには`url`を変える）。URL を変えたあと、古い`inputPath`のまま同じ戻り値をもう一度返しても、何も変わらない。URL が`pages.outputPathField`のキーで決まるページだけは、`inputPath`を変えるとファイルが移る。

仮想ページを実体にする（ファイルを持たせる）には`virtual: false`を、ファイルのあるページを仮想ページにする（ファイルと sidecar は消え、メタは`pages.overrides`に残る）には`virtual: true`を返す（仮想ページにするには`pages.overrides`の設定が要る）。

#### 返してはいけないもの（全件まとめて報告され、何も適用されない）

報告の`row N (<url>)`の N は、返した配列の N 番目の行（1 から数える）。並びは、行そのものの誤り（行の順）が先で、そのあとに、ページの突き合わせで見つかったもの（新しいページの`virtual`の省略、編集できないキーの変更）が続く。

次のどれか。

- 戻り値が、配列でも`null`でもない。行がオブジェクトでない。
- `url`が無い。`url`が`/`で始まらない。同じ`url`が 2 回ある。
- 同じ`inputPath`が 2 回ある。`inputPath`が文字列か`null`でない。`inputPath`が`dir.input`の外にある。
- `virtual`が真偽値でない。`virtual: true`の行に`inputPath`がある。**新しいページの`virtual`を省略している**。
- `meta`がオブジェクトでない。
- 今あるページが仮想ページで、行が`inputPath`を持つのに`virtual: false`を書いていない（ファイルを持たせたいのかどうかを、`virtual`で言わせる）。
- 編集できないキー（YAML のアンカーを使った front matter など）の値を、変更・削除している。

### 例

外部パッケージなしで試せるように、JSON のファイルを「外のデータ」に見立てる。

```js
// scripts/export.mjs（書き出し）
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// the file next to the script: a relative path would be relative to where kamado was run
const SHEET = new URL('./sheet.json', import.meta.url);

export default async (pages, ctx) => {
	const rows = pages.map((page) => ({
		url: page.url,
		// マシンに依らない、dir.input からの相対パス。仮想ページは null
		inputPath:
			page.inputPath === null ? null : path.relative(ctx.inputDir, page.inputPath),
		virtual: page.virtual,
		// メタの全体。実際のシートでは、よく見るキー（title など）を列にし、残りのキーを 1 つの列に JSON で入れる
		meta: page.meta,
	}));
	writeFileSync(SHEET, JSON.stringify(rows, null, '\t'));
	ctx.log('info', `wrote ${rows.length} rows`);
	// 何も返さない: kamado は何も変えない
};
```

```js
// scripts/import.mjs（取り込み）
import { readFileSync } from 'node:fs';

const SHEET = new URL('./sheet.json', import.meta.url);

export default async (pages, ctx) => {
	const rows = JSON.parse(readFileSync(SHEET, 'utf8'));
	ctx.log('info', `${rows.length} rows in the sheet`);
	return rows.map((row) => ({
		url: row.url,
		// 書き出した inputPath を残す。URL を書き換えた行が、移動として扱われる
		inputPath: row.inputPath,
		virtual: row.virtual,
		// メタの全体。ここに無いキーは消える（書き出したメタをそのまま返せば、何も変わらない）
		meta: row.meta,
	}));
};
```

Google Sheets を使うなら、骨子は次のとおり（`googleapis`はこのプロジェクトで入れる。認証情報は環境変数で渡し、リポジトリには入れない）。

```js
import path from 'node:path';

import { google } from 'googleapis';

// GOOGLE_APPLICATION_CREDENTIALS（サービスアカウントの鍵のパス）と SHEET_ID を環境変数に置く
const auth = new google.auth.GoogleAuth({
	scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

export default async (pages, ctx) => {
	const header = ['url', 'inputPath', 'virtual', 'title'];
	const values = pages.map((page) => [
		page.url,
		page.inputPath === null ? '' : path.relative(ctx.inputDir, page.inputPath),
		page.virtual,
		page.meta.title ?? '',
	]);
	await sheets.spreadsheets.values.update({
		spreadsheetId: process.env.SHEET_ID,
		range: 'pages!A1',
		valueInputOption: 'RAW',
		requestBody: { values: [header, ...values] },
	});
	ctx.log('info', `wrote ${values.length} rows`);
};
```

取り込みは、`sheets.spreadsheets.values.get`で行を読み、上の取り込みの例と同じ形（`url`・`inputPath`・`virtual`・`meta`）に直して返す。シートの空のセルは空の文字列で届くので、`inputPath`は空なら`null`にし、`virtual`は文字列`"TRUE"`・`"FALSE"`を真偽値に直す。メタのキーの空のセルは、キーを入れないか、空の文字列を値にするかを決める（上のとおり、別の値になる）。

### 往復で崩さない書き方

- シートに`url`と`inputPath`の列を**残す**。取り込みでは、書き出したときの`inputPath`をそのまま返す。
- 値の型はスクリプトで合わせる。シートから来る数値や真偽値は、文字列で届くことが多い。メタの`1`と`"1"`は別の値として比べられ、違えば書き換わる。
- 取り込みの前にコミットしておく。結果は`git diff`で確かめ、不要なら`git reset`で戻し、シートを直して取り込み直す。同期は、シートとリポジトリの変更を突き合わせない（マージしない）。書き出したあとにリポジトリで足したページや値は、次に返した一覧に無ければ消える。
- 2 つのページが互いの URL を取る行（入れ替え）は、適用の前後で`url`と`inputPath`の組の一覧が同じになるので、同じ戻り値をもう一度返すと、また入れ替える。取り込みのたびに、そのとき渡された一覧から作り直す使い方では起きない。

### 確認と、失敗したとき

- 差分があると、適用の前に要約（削除・URL の移動・ファイルの移動・仮想化・実体化・追加・メタの変更。件数と一覧）が出る。承認は全体に対して 1 回。警告の対象は、削除・仮想化・移動で消えるファイルと、同期が書き換える`pages.overrides`。`pages.overrides`を書き換えるのは、仮想ページを消す・足す・仮想化する・実体化するときと、仮想ページのキーを変えるとき。これらに**コミットされていない変更**（まだコミットしていない新しいファイルと、git の対象外のファイルも含む）があると、その名前が警告に出る。git が使えないときは「git で戻せない」と出る。差分が無ければ、確認なしで「変更なし」。
- 適用は、全部か、1 つもか。スクリプトの実行中や確認を待つあいだにファイルが変わっていたら、何も適用せずに知らせる（もう一度実行する）。
- スクリプトの失敗は、**何も適用しない**。次のどれも失敗: 例外を投げた・Promise が reject した、捕まえられなかった例外、**戻り値を返す前に終わった**（`process.exit()`は、終了コードが 0 でも失敗）、読み込みに失敗した・default export が関数でない、戻り値が`undefined`・`null`・配列のどれでもない（JSON にできない値を含む）。画面は「同期に失敗しました」と、メッセージと詳細（スタック）とログを出し、「もう一度実行」できる。`kamado sync`は標準エラーに出して終了コード 1。失敗までにスクリプトが外にしたこと（シートへの書き込みの途中）は、kamado は戻さない。実行にタイムアウトは無い（止めるのはキャンセル）。
- 画面の「キャンセル」と`kamado sync`の`Ctrl-C`は、スクリプトのプロセスを止める。

### よくある間違い

- 行の順を並びにしたいのに、配列の順だけで返す（配列の順は並びに関係しない）。`meta.order`に行の番号を書く。
- 変えたいページだけを返してしまう。**返さなかったページは削除される**。変えないページも返す（`pages`の`map`で作るのが安全）。
- `meta`に変えたいキーだけを書いてしまう。**書かなかったキーは消える**。`{ ...page.meta, title: '…' }`のように、元のメタに足す。
- 新しいページに`virtual`を書き忘れる（エラーになる）。
- URL を書き換えたのに`inputPath`を返さない（削除と空のページの作成になり、本文が消える）。
- `inputPath`に絶対パスを載せたシートをチームで共有する（マシンごとに違う）。`ctx.inputDir`からの相対パスにする。
- 書き出しのスクリプトが何かの配列を返してしまう（それが「あるべき全ページ」として適用される）。書き出しは何も返さない。
- スクリプトの中で`process.exit()`を呼ぶ（失敗になる）。

## プログラムから

```ts
import path from 'node:path';

import { build, pages, start, sync, ui } from 'kamado';

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

// Runs a sync script (an operation of ui.syncFunctions by its name, or a file) and applies what it
// returns. Without `yes: true` it applies nothing and throws when there are changes.
const { applied, summary } = await sync(config, 'import-sheet', { yes: true });
console.log(applied, summary.counts);
```

`sync(config, target, options?)`は`kamado sync`と同じ（第 2 引数は`name`かスクリプトのパス（打った場所ではなく、プロセスのカレントディレクトリからの相対パス））。オプションは`yes`（確認なしで適用する。無いと、差分があれば何も適用せずに例外）・`cacheDir`・`write`（`ctx.log`の行の出し先。既定は標準エラー）で、`{ applied, summary }`を返す。失敗したとき（スクリプトの失敗、適用できない戻り値、適用の拒否、確認されない差分）は`SyncError`で reject し、`kind`（`failed`・`invalid`・`cancelled`・`refused`・`unconfirmed`）と、`problems`・`failures`・`summary`・`scriptStack`を持つ。

`ui()`のオプションは`port`・`open`・`cacheDir`・`write`（ログの行の出し先）・`uiDir`（画面の配布物。既定はパッケージの`dist/ui`）・`settingsFile`（画面の設定の保存先。既定は上の場所）で、`{ url, close() }`を返す。`close()`は待ち受けをやめる（`build.incremental`のときは、plan cache も書く）。

`build()`・`start()`・`pages()`・`ui()`の第 1 引数は、設定ファイルの**絶対パス**（相対パスの基準になるディレクトリが設定ファイルの場所のため）。取らないオプションのキー（タイプミスを含む）を渡すと`unknown option: <key>`で例外にする。`pages()`のオプションは`incremental`と`cacheDir`で、`PageMap`（`docs/v3/RFC.md` §14.1）を返す。ファイルには書かない（書くなら`JSON.stringify`して自分で書く）。`build()`のオプションは CLI のフラグと同じ（`incremental`/`force`/`skipUnchanged`/`targets`/`jobs`/`cacheDir`）。`cacheDir`の相対パスは、設定ファイルのディレクトリからのパス（CLI の`--cache-dir`は cwd 基準なので、同じ相対パスでも別のキャッシュを指す。`/`で始まるパスは同じ）。`targets`の相対パスは、設定ファイルのディレクトリからのパス（glob とパスの扱いは CLI と同じ。無いファイルは例外、何も選ばなかったものは`report.warnings`）。`report`は各ページの URL・入出力のパス・状態（`built`/`cached`/…）・メタデータを持つ。差分ビルドで`cached`になったページやスタイルの警告は、原因が残っている間は要約に再掲される。

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
