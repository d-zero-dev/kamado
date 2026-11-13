# v3 の開発手順

Rust のワークスペース（`crates/`）、Node 側のパッケージ（`packages/kamado`と`packages/@kamado-io/oxlint`）、ベンチマーク・比較ツール（`benchmarks/`）の使い方。仕様は`RFC.md`、設計判断の根拠は`spike-results.md`を参照。

このリポジトリの`kamado`は v3 で、npm のワークスペースは`packages/kamado`と`packages/@kamado-io/oxlint`の 2 つ（Lerna は版の管理と公開のために残している。`forcePublish`で、2 つは常に同じ版になる）。v2 は`v2`ブランチで保守していて、このブランチには無い。v2 の出力を比べる必要があるもの（oracle）は、公開済みの v2 を npm から取って使う（「v2 の oracle」）。

## Rust

Rust のクレートはすべて標準ライブラリのみに依存する。外部クレートを追加してはいけない（CI が検証する）。

```sh
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline --workspace
node scripts/check-rust-no-external-crates.mjs
```

**前提**: `cargo test`の前に、リポジトリのルートで`yarn install`を済ませておく。一部のテストが`node_modules`の esbuild の実行ファイル（Node が`esbuild`パッケージから解決する`@esbuild/<os>-<arch>`。`crates/kd_core/src/minifiers.rs`の`esbuild_for_tests`。そのため Node も要る）を呼び、無ければ「run `yarn install`」で失敗する。Rust のテストが`node_modules`に頼るのは、この esbuild の実行ファイルだけで、oracle（prettier など）を実行時に呼ぶテストは無い。oracle の出力は、`scripts/`が事前にコミット済みの表と golden に書く。コミットしないコーパスを読む`--ignored`のテストは、`scripts/fuzz-*.mjs`で先にコーパスを作る（「何を更新したら、何を作り直すか」）。

ツールチェーンの版は`.github/workflows/rust.yml`で固定している。`rust-toolchain.toml`は置かない。置くと、ローカルの`stable`とは別のツールチェーンが再インストールされ、環境によっては中途半端な状態で失敗する。

## クレートの構成

| クレート    | 担当                                                                                                                                     | 依存するクレート               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `kd_hash`   | SHA-256 と SHA-1（git の blob id を作るため。完全性の検査には使わない）                                                                  | なし                           |
| `kd_jsonc`  | JSONC のパーサと決定的な JSON 出力（`Value`型）、書式を保つ書き換え（`edit`）                                                            | なし                           |
| `kd_glob`   | glob のマッチと、探索を枝刈りするための判定                                                                                              | なし                           |
| `kd_yaml`   | YAML のサブセットと front matter の分割、書式を保つ書き換え（`edit`）                                                                    | `kd_jsonc`                     |
| `kd_pool`   | スレッドプール                                                                                                                           | なし                           |
| `kd_image`  | 画像（png / jpeg / webp / avif / svg）の寸法の読み取り                                                                                   | なし                           |
| `kd_css`    | CSS のトークナイザ・パーサ・圧縮（cssnano 相当）・`@custom-media`の解決（圧縮しないときも）                                              | なし                           |
| `kd_js`     | TS / TSX / JSX のパーサ、型の除去、JSX → 文字列連結へのコンパイル、静的な meta の抽出と書式を保つ書き換え（`meta_edit`）                 | なし                           |
| `kd_html`   | HTML のパーサ、DOM、セレクタ、宣言的ルール、取り込み、挿入（DOM と、静的な HTML への文字列）、画像寸法の付与、整形と圧縮（融合した印字） | `kd_image`                     |
| `kd_site`   | 出力パス・URL の写像、URL の階層（`depth`と親）、`outputPathField`、衝突、探索、メタデータのマージ、overrides                            | `kd_glob` `kd_jsonc`           |
| `kd_build`  | 差分ビルドの manifest（バイナリ形式、stat 先行の指紋）                                                                                   | `kd_hash` `kd_jsonc`           |
| `kd_config` | `kamado.config.jsonc`の型・既定値・検証                                                                                                  | `kd_glob` `kd_jsonc` `kd_site` |
| `kd_core`   | ビルドの組み立て（設定 → 探索 → メタ → 差分判定 → HTML・CSS・JS → 書き出し）、開発サーバーの核、ページの編集（`ui`）                     | 上のすべて                     |
| `kd_napi`   | Node-API の接続層とアロケータ。`unsafe`はここだけ                                                                                        | `kd_core` `kd_hash` `kd_jsonc` |

依存の向きは上から下の一方向で、`kd_napi`が一番上位にある。パース系のクレート（`kd_jsonc` `kd_glob` `kd_yaml`）は、ユーザーが書くファイルを読むので、入れ子の深さや計算量を制限している。

## N-API アドオン（`crates/kd_napi`）

```sh
cargo build --locked --offline --release -p kd_napi
node --test crates/kd_napi/check/load.check.mjs
```

`*.check.mjs`は、ネイティブのビルドが必要なので vitest の対象にしていない（`yarn test`では動かない）。

ページの編集（`ui*`。RFC §14.2）は、`yarn build`のあとに`node --test crates/kd_napi/check/ui.check.mjs`で、実物のアドオンを通す。コアの単体テスト（`crates/kd_core/src/ui/tests.rs`）が同じ処理をアドオンなしで確かめ、こちらは JSON がアドオンを越えても RFC の形であることと、編集がディスクのファイルだけを変えることを確かめる。ファイルを書き戻す 3 つの実装（`kd_yaml::edit`の front matter、`kd_jsonc::edit`の JSONC、`kd_js::meta_edit`の`export const meta`）に oracle は無く、YAML と TS は手書きのテストだけで確かめる（書き戻しの規則は「触らない部分のバイトを変えない」で、同じ書式にそろえる oracle が無い）。JSONC は下の表の`jsonc-parser`の golden で、結果の値だけ照合する。

ページの追加・仮想化・実体化・削除と、行が必ず持つ列は`page_tests.rs`が確かめる。一括編集（`uiEditBatch`）は`batch_tests.rs`で、同期のためのコアの答え（`uiSyncPages`・`uiSyncLocked`・`uiServer`の`syncFunctions`）は`sync_tests.rs`で、移動の順序付けの関数は`moves.rs`の中のテストで確かめる。

同期（`ui.syncFunctions`、`kamado sync`、`sync()`。RFC §14.2）は、次のように確かめる。差分（`packages/kamado/src/sync/diff.ts`）・子プロセス（`runner.ts`）・未コミットの確認（`unsaved.ts`。実物の git）・流れ（`session.ts`）・画面のためのサーバー側（`controller.ts`、`ui/app.ts`の`/api/sync...`）・CLI（`command.ts`）は、それぞれの`*.spec.ts`で、スクリプトは本物の子プロセスで動かす。範囲（`select`）と書き出しの差分（`compare.ts`）は`compare.spec.ts`、スクリプトの形と書き出しの一生（確認のあいだ生きている子、`write`の失敗とキャンセル）は`script-shapes.spec.ts`、書き出しの流れ（`session.ts`・`controller.ts`・`command.ts`）は`export-flow.spec.ts`で確かめる。`select`つきの取り込みと書き出しを実物のコアに通すのは、`yarn build`のあと`node --test crates/kd_napi/check/sync-select.check.mjs`（範囲の外のキーとページが変わらないこと。同じ取り込みをもう一度すると変更なしになること。書き出しが確認の前に何も書かず、サイトのファイルを変えないこと。確認のあいだにファイルが変われば書かず、変わらなければ書くこと）。画面（`client/src/sync-view.tsx`）は`sync-view.spec.tsx`で状態ごとの描画を確かめる。**正しさの法則**は、`yarn build`のあと`node --test crates/kd_napi/check/sync.check.mjs`で、実物のコアに書き戻して確かめる。渡された一覧をそのまま返すと、変更なし。適用したあとの一覧は、戻り値と一致する（`url`・`virtual`・`meta`）。適用した直後に同じ戻り値をもう一度渡すと、変更なし（URL の入れ替えを除く）。失敗したスクリプトと、途中で変わったファイルは、1 バイトも変えない。引用符・バッククォート・`${}`・`*/`・改行・`---`・`__proto__`を含む値とキーは、読み戻すと同じ。ケースは固定の種の乱数で作る（失敗した種が分かる）。ページの編集や一覧を変えたときに同期が追従しているかは、`sync/coverage.spec.ts`が、`diff.ts`の`EDIT_OPS`・`ENTRY_FIELDS`の表をコアのソースと比べて見つける（`CLAUDE.md`の「連動して変える箇所」）。画面の配線（`app.tsx`の同期ボタンとダイアログ）にはテストが無く、ブラウザでの確認が守りになる: 同期の操作を設定した git のサイトで`kamado ui`を開き、「同期」ボタンの操作の一覧（言語を替えてラベルが替わること）、実行中のログとキャンセル、差分の確認（件数のタブ。件数が 0 のものが薄く押せないこと。未コミットの変更のあるファイルを消す差分で警告が出ること）、「適用」のあとの一覧と状態欄、失敗（メッセージ・詳細・ログ・「もう一度実行」）、戻り値が不正なときの一覧、実行中の`Escape`とキャンセルのボタンが、止めずに確認（「続ける」と「同期をキャンセルする」。`Escape`でも「続ける」に戻ること）を出すこと、書き出し（差分の確認が「外のデータが変わる」と言うこと、承認の前に何も書かれていないこと、`read`の無い書き出しが対象の件数だけを出すこと、「書き出す」のあと`writing`の表示になり終わると状態欄に出ること、`write`の最中のキャンセルの確認が書きかけの可能性を言うこと、差分の確認の「キャンセル」で、確認を挟まずにすぐ閉じて待っていた子プロセスが止まること。実行中の「キャンセル」は確認を挟むこと）、を見る。`kamado sync <name>`は、端末あり・端末なし・`--yes`の 3 通りで実行する。10 万ページの計測（`benchmarks`の生成器ではなく、front matter だけの HTML を 100 個ずつのディレクトリに置いたサイトでよい）では、一覧の取得（`uiSyncPages`）が 0.2 秒、`pages`を渡して返させるのが約 0.5 秒、差分が約 0.6 秒。編集できないキーの取得（`uiSyncLocked`）は、10 万件で約 25 秒になる。キーを書き換えるページの分だけなので、1,000 ページを変えるなら全体で 2〜3 秒。

相対パスの`cacheDir`の基準（API は設定ファイルのディレクトリ、CLI の`--cache-dir`は cwd。RFC §13）は、`node --test crates/kd_napi/check/cache-dir.check.mjs`で、実物のアドオンと CLI を通す（`yarn build`のあと）。

`data`のキー単位の依存（読んだキーが変わったページだけを描き直すこと、`--verify-deps`が状態を持ち越すページを見つけること。RFC §11）は、`node --test crates/kd_napi/check/data-keys.check.mjs`で、同じく実物を通す。実行するデータファイル（RFC §3.2。実行・`readFile`・`maxAge`・時間制限・失敗・ディスクのキャッシュ・開発サーバー）も、同じ前提（`cargo build --release -p kd_napi`と`yarn build`）で`node --test crates/kd_napi/check/data-scripts.check.mjs`を通す。10 万ページでの計測は、`node benchmarks/v3/generate-jsx-fixtures.ts --pages=100000 --out=<dir>`で作ったサイトを`kamado build --incremental`で 2 回回し、使われていないキーのファイルを`data.dir`に足して変えてもう 1 回回す（全ページが`cached`になること）。

`kamado ui`の画面は`packages/kamado/client`（React）で、`yarn build`が型を検査して、`scripts/build-ui.mjs`が esbuild で`packages/kamado/dist/ui`にまとめる（`yarn dev`は画面を作り直さない）。React は`packages/kamado`の devDependencies で、bundle に入るので、パッケージの実行時の依存は増えない。画面の論理は DOM の無い関数（`client/src/logic/`）に分けて Vitest で、サーバー（`src/ui/`）は`app.request`で確かめる。小さな部品（`column-menu.tsx`・`options-dialog.tsx`）は、`react-dom/server`で HTML にして確かめる（`client/src/*.spec.tsx`。操作は確かめない）。サーバーが実物のコアの答えを正しく中継し、絶対パスを出さないことは、`ui.check.mjs`が実物のアドオンで確かめる（画面が読む JSON の項目もそこで固定する）。配布物に画面が入っていることは、`node scripts/check-package-ui.mjs packages/kamado`（ローカルでは`yarn build`のあと。publish のワークフローは展開したパッケージに対して）が確かめる。

画面の設定の保存（`packages/kamado/src/ui/settings.ts`）は、一時ディレクトリのファイルで Vitest が確かめる（同時に保存して項目が消えないこと、壊れたファイルの退避、新しい版を書かないこと、パスがブラウザに出ないこと）。`kamado ui-settings`は`KAMADO_UI_SETTINGS`を一時ファイルにして動かせる。ルートの`vitest.config.ts`は、同じ環境変数を一時ディレクトリのファイルに向ける。設定ファイルを明示しない`ui()`のテストが、実行する人の`~/.config/kamado/ui-settings.json`を読んだり、壊れているものを退避したりしないため。表示言語の辞書（`client/src/i18n/messages.ts`）は、両言語に同じ項目があることを Vitest が確かめる。

`ui.check.mjs`は、一時のリポジトリを`git init`・`git commit`して、`/api/diff`と`/api/revert`も通す（HEAD との差分。`packages/kamado/src/ui/head*.spec.ts`と同じく、`git`の実行ファイルが要る）。

一括編集（`uiEditBatch`）を呼ぶものは、まだ`packages/kamado`に無い（画面にも CLI にも無い）ので、ブラウザで確かめる手順は無い。呼び出しを足すときに、この節に足す。

画面の描画と操作は、ブラウザで確かめる（操作を確かめるコンポーネントのテストは無い）。ブラウザは、Invoker Commands API（`commandfor`・`command`）に対応した Chrome 135 以降、Firefox 144 以降、Safari 26.2 以降。セルの文字は、透明なボタンを重ねているのでドラッグで範囲選択できない（選びたいときはダブルクリックで編集に入る）。手順: `benchmarks/v3/generate-jsx-fixtures.ts`か、front matter を持つ HTML を数千ページ置いたサイトを作り、`kamado ui --no-open --port <n>`を起動して chrome-devtools で開く。1 画面を 5,000 行にして、初回の表示（目安は 1 秒未満。500 行で約 130 ms）、矢印キーでの移動、セルの編集から表示までを測る。セルを押すと選択されること、ダブルクリックで編集に入ること、真偽値の箱を押すと値が反転することも見る。ソート（列のメニューで昇順・降順・解除）も見る。メタの`order`の列が、どのページにも書かれていなくても出ること、この列では昇順・降順が選べないこと、並びを解除したまま`order`の値を変えると行がその場所へ移ること、ほかの列で並べているときは行が動かないことも見る。1 画面を 100 行にして、別のページ送りへ移る値にすると、そのページが開いてフォーカスが同じ行の同じ列に残る。検索で絞っていて行が外れるときは、頁は移らず「このページには表示されていません」が出る。列の固定・並べ替え・幅（見出しの`⋮`と`Alt+↓`のメニュー、見出しのドラッグ、右端のドラッグ）も見る。固定した列が横にスクロールしても左端に残ること（5,000 行の下のほうまでスクロールしても）、ドラッグの途中で行が描き直されて重くならないこと、開き直しても並びと固定と幅が残ることを確かめる。固定した列と固定していない列の間では、ドラッグでも「左へ」「右へ」でも動かせないこと、メニューをキーボードだけで開いて使えて`Esc`で元の場所にフォーカスが戻ること、並べ替えや幅の変更が状態の表示（`role="status"`）に伝わることも見る。`aria-sort`が変わること、ページ送りしても全件の並びであること、検索と組み合わせられること、開き直しても残ることを確かめる。10 万ページのサイトでは`sort`付きの表示の時間も測る。値の編集（真偽値のチェックボックスのクリックと`Space`、リストの追加・削除・上下への移動・JSON への切り替えで編集欄が閉じないこと、列のメニューで選択肢の列にして選択肢が既存の値から作られること、セレクトボックスと複数選択での保存、選択肢に無い値が書き換えられないこと、開き直しても選択肢が残ること）も見る。10 万ページのサイトでは`uiValues`の時間も測る。HEAD との差分は、`git`のリポジトリにしたサイトで、値を変える・キーを足す・キーを消す・新しいページのファイルを足してから見る。変更・追加・削除の帯が青・緑・赤で出ること（ライトとダークの両方）、帯を押すか`Alt+Backspace`で確認のダイアログが出て、戻すと帯が消えること、戻すと書くファイルがダイアログに出ること、コミットして「読み直す」と帯が消えること、列のメニューの項目、ラベルと凡例が出て全行が同じ高さであること、ブランチを切り替えたあと`headMoved`で何も書かれないことも見る。10 万ページのサイトでは、`POST /api/diff`（5,000 行）の時間と、頁送りのときにファイルを読み直さないことを測る。ページの追加・仮想化・削除は、`pages.overrides`を設定したサイトと、設定していないサイトの両方で見る。「ページの追加」で`inputPath`だけ・URL と`inputPath`・URL だけ（仮想ページの確認が出ること）を足し、足したページに移ること。`inputPath`のセルを空にすると「仮想化」「削除」「キャンセル」が出て、消えるファイルの名前が書いてあり、最初のフォーカスが「キャンセル」にあること（`pages.overrides`の無いサイトでは「仮想化」が押せないこと）。`virtual`のチェックボックスをクリックと`Space`で入り切りできること（入れるときだけ確認が出る）、仮想ページの`inputPath`にパスを書くとファイルができてメタがファイルへ移ること、`url`のセルを空にすると削除の確認が出ること。`order`・`outputPath`・`parent`・`depth`の列が読み取り専用で、列のメニューから並べ替えられること。凡例が表の下にあり、差分の印が出たり消えたりしても表の行が動かないこと。10 万ページのサイトでは、`pages.overrides`に項目を足す・消す編集の時間も測る（計画の読み直しを含む）。表示言語の自動判定（ブラウザの言語を変えて開く）と切り替え、設定が保存されて開き直しても残ること、キーボードだけで編集でき、スクリーンリーダーに grid として伝わること（`take_snapshot`）、保存の失敗（ファイルを外で書き換えて`conflict`を起こす）から回復できることも見る。`ui.keys`を書いたサイトでは、見出しが`label`になること、ホバーにキーの名前と`description`が出ること、列メニューの先頭に同じ文が出ること、選択肢のダイアログと保存・失敗のメッセージが`label`で列を呼ぶこと、言語を`ja`と`en`で切り替えて訳が替わること、`label`の無いキーと固定の列が変わらないことも見る。これらの配線（`app.tsx`）にはテストが無く、この確認が唯一の守りになる。`ui.keys`の項目を足す・変えるときは、`schema.json`・`kd_config`・コアの答え・`ui.check.mjs`・RFC §14.2・README を同じ PR で揃える。 `ui.defaultKeyOrder`・`ui.defaultFixedKeys`（列の既定）も同じ。ページ数の既定 500 は`src/ui/settings.ts`と`client/src/logic/column-defaults.ts`の 2 か所にある。`ColumnDefaults`の型も`src/ui/app.ts`と`client/src/logic/layout.ts`の 2 か所にある。どちらも、片方を変えたらもう片方も変える。列の既定は、2 つを書いたサイトで、次のことをブラウザで見る。保存した設定が無いときに、既定の並びと固定で開くこと。設定を保存した項目だけ（`order`・`pinned`のどちらか）が先に効き、もう一方は既定のままなこと。設定の読み込みに失敗したとき（`KAMADO_UI_SETTINGS`に壊れたファイルを指す）も、既定どおりに描くこと。今のサイトにまだ無いキーを既定に書いても列が出ず、並びを保存してもそのキーが残ること。キーに`"`・`<`・`&`を含む列を既定に書いても、画面が壊れないこと（HTML の属性に埋めるため）。さらに画面が読む HTML の`<meta name="kamado-column-defaults">`（`ui/app.ts`と`client/index.html`）と、`layout.ts`の`stateOf`の第 2 引数を揃える。「既定に戻す」ボタン（フッター。`app.tsx`の`confirmReset`と`reset-dialog.tsx`）は、フッターに凡例と並んで出ること（凡例の無いサイト、凡例が複数行になる狭い幅、日本語の画面でも崩れないこと）、確認のダイアログが出ること（最初のフォーカスが「キャンセル」。確定のときは`onCancel`が呼ばれず、閉じるとフォーカスが表に戻ること）、確定で列・並べ替え・行数・選択肢の列が設定ファイルの既定に戻り、`ui-settings.json`の`columns`・`sort`・`kinds`が消えること、言語が残ることを、ブラウザで見る。

panic の確認（`panic.check.mjs`）だけは、わざと panic する`panicCheck()`を足した別のビルドを使う。出荷するアドオンには、この関数は入れない（Cargo の feature `panic-check`）。

```sh
cargo build --locked --offline --release -p kd_napi --features panic-check --target-dir target/panic-check
node --test crates/kd_napi/check/panic.check.mjs
```

アドオンの関数が panic すると、Node のプロセスごと落ちるのではなく、`kamado: internal error (a panic in the native core): <メッセージ>`という JS の`Error`として投げられる（`crates/kd_napi/src/lib.rs`の`guard`）。そのために、リリースのプロファイルは`panic = "unwind"`で、ハンドラは`extern "C"`ではなく通常の Rust の関数にしてある（`extern "C"`の境界で panic すると、`guard`に届く前に abort する）。`unwind`にしたことによるアドオンのサイズは約 19% 増え（2.85 MB から 3.40 MB、macOS arm64）、3000 ページのビルド時間はばらつきの範囲で変わらなかった。この`Error`の`code`は`KAMADO_PANIC`。

panic は、途中まで更新した状態を残しうる。開発サーバーのハンドルで panic すると「使えない」印が付き、その呼び出しと以降の呼び出しは`code`が`KAMADO_SERVE_POISONED`の`Error`を投げる（`crates/kd_napi/src/serve.rs`。使えないかどうかはここだけが決める）。開発サーバー（`packages/kamado/src/server/app.ts`）は、この`code`を受けると`serveOpen`でハンドルを開き直す。描画ワーカーも止めて、全文脈を送り直させる。その要求は 500 で、同時に失敗した要求があっても、開き直すのは 1 回。開き直せなかったとき（設定を編集中で読めない等）は、1 秒の間は同じ失敗を返し、そのたびにサイトを計画し直すことはしない。ほかのハンドル（別のプロジェクトの開発サーバーやビルド）は、そのまま使える。ビルドのハンドル（`crates/kd_napi/src/session.rs`）には印を付けない。`prepare`は最後に表へ入れ、`finish`は最初に表から外すので、panic で中途半端な状態が残らない。ビルドの JS 側は、失敗したら`abort`で表から外す。

## Node 側のパッケージ（`packages/kamado`）

v3 の本体パッケージ（`packages/kamado`、npm 名`kamado`）。v2 は`v2`ブランチで保守している。中身は CLI、`build()`/`start()`/`pages()`/`ui()`/`sync()`、JSX の描画ワーカー、開発サーバー（hono）、esbuild の呼び出し、アドオンの読み込みで、ランタイム依存は`esbuild`と`hono`/`@hono/node-server`だけ。使い方は`packages/kamado/README.md`、設定の補完用に`schema.json`を同梱している（キーは`kd_config`のテストが双方向に照合する）。

```sh
cargo build --release -p kd_napi   # アドオンを先に作る
yarn build                         # TypeScript をコンパイル
node packages/kamado/dist/cli.js build --config path/to/kamado.config.jsonc --verbose --incremental
```

アドオンは`KAMADO_NATIVE_ADDON`で指定したファイル、なければ`target/release`、`target/debug`の順に探す。

## Node 側のパッケージ（`packages/@kamado-io/oxlint`）

`kamado/jsx`の TSX に向けた oxlint の規則（npm 名`@kamado-io/oxlint`。`kamado`と同じ版で公開する）。kamado は 1 回だけ HTML に描画して JavaScript を送らないので、意味を持たない書き方をエラーにする。対象は、`react`の値、関数の`onClick`、`'use client'`、`async`のコンポーネント、モジュールの変数の書き換え、コンポーネントの中の`fs`と`fetch`である。規則の一覧と使い方は`packages/@kamado-io/oxlint/README.md`。

```sh
yarn build                                    # tsc で dist/ を作る
yarn vitest run packages/@kamado-io/oxlint    # 規則の spec と、実物の oxlint を通す spec
```

テストは 2 層ある。規則ごとの spec（`src/rules/*.spec.ts`）は ESLint の`Linter`で JS と JSX の範囲を確かめる（oxlint と ESLint が共有する API で書いてあるため）。`src/oxlint.spec.ts`は実物の oxlint を子プロセスで動かして、TypeScript の構文（`import type`など）、パッケージ名でのプラグインの解決（`exports`と`dist/`）、`overrides`、設定ファイルの 2 つの形式（`.oxlintrc.json`と`oxlint.config.mts`）を確かめる。

期待は`fixtures/app/`のファイルの`// ✗ 規則名`の注釈が持つ（行末のコメントはその行を、単独のコメントは次の行を指す）。規則を足すときは、規則の spec と、`invalid.tsx`への注釈つきの例を足す（`oxlint.spec.ts`が、全部の規則が`invalid.tsx`に出ることを確かめる）。oxlint は`dist/`を読むので、`yarn build`のあとでないと spec は動かない。

規則の名前は`@kamado-io/<規則>`で、`meta.name`が接頭辞になる（`@d-zero/oxlint-plugin`の`@d-zero/no-click-event`と同じ形）。

**版の上げ方**（安定版から）。規則の追加と、既存の規則が見つけるものの拡大は、マイナーとして扱う。規則の削除、名前や`messageId`の変更、報告の縮小（見つけていたものを見つけなくなること）は、メジャーとして扱う。このパッケージは`recommended`を持たず、利用者が規則を自分で挙げるので、新しい規則は自動では有効にならない。既存の規則の拡大は、同じ名前のまま新しい報告を出すので、利用者の lint が赤くなることがある。そのため、変更の説明（コミットの本文）に、新しく報告されるものを書く。`kamado`と同じ版で公開するので、このパッケージだけの変更でも、版は`kamado`と一緒に上がる。

`eslint`（このパッケージの devDependencies）は、`.github/renovate.json`のグループに入れていない。上がっても、ビルドと型検査は通るため（型と規則の spec にだけ使う）。`oxlint`は、ルートの`oxlint-tsgolint`と同じ`oxlint`のグループに入っている（ルートの lint が使う版とそろえる）。`oxlint`が上がると、`oxlint.spec.ts`の期待（行と規則）が変わることがあり、そのときは Renovate の PR の中で直す。

**最初の公開は手で行う（1 回だけ）。** npm の Trusted Publishing は、まだ npm にないパッケージには設定できない。そのため`@kamado-io/oxlint`の最初の版だけは、次の手順で公開する。**次のタグを push する前に**済ませる（`publish.yml`の`check`ジョブが、npm にこのパッケージがあることを公開の前に確かめる）。

1. 古い成果物が tarball に入らないように、`packages/@kamado-io/oxlint/dist`を消してから`yarn build`し、`yarn workspace @kamado-io/oxlint pack --out "$PWD/kamado-io-oxlint.tgz"`で tarball を作る。版は`package.json`の今の版で、`lerna.json`と同じ。
2. `@kamado-io`に権限のあるアカウントで`npm login`し、`npm publish ./kamado-io-oxlint.tgz --access public --tag <dist-tag>`を実行する。dist-tag は、`publish.yml`が版から決めるものと同じにする（`-alpha`は`alpha`、`-beta`は`beta`、`-rc`は`rc`、それ以外の prerelease は`next`、安定版は`latest`）。tarball は、自分のディレクトリに置いたものだけを使い、公開したら消す。
3. npmjs.com のパッケージの設定（Settings の Trusted Publisher）で、GitHub Actions、リポジトリ`d-zero-dev/kamado`、ワークフロー`publish.yml`を登録する。

手で公開した版には provenance が付かない（npm が付けるのは、CI の OIDC で公開したときだけ）。次の版からは、`kamado`と同じタグの push で、同じワークフローが provenance 付きで公開する。

## lint

`yarn lint`（修正あり）と`yarn lint:check`（修正なし。CI）は、oxlint（型情報つき）、stylelint、markuplint、oxfmt、textlint、rustfmt、clippy をこの順に実行する。ESLint・Prettier・cspell は使わない。

- **型情報つきの oxlint は、`yarn build`のあと**に動かす（`lib/*.d.ts`などの宣言を読む）。pre-commit の oxlint は型情報なしで、型情報の規則は CI で初めて報告される。
- **`oxlint --disable-nested-config`**: `packages/@kamado-io/oxlint/fixtures/app/`は、`.oxlintrc.json`と`oxlint.config.mts`を両方持つ（`oxlint.spec.ts`が、どちらでも同じ報告になることを確かめるため）。oxlint は 1 つのディレクトリに両方あると設定の読み込みで失敗するので、ルートの lint は入れ子の設定を探さない。対象外の指定は`oxlint.config.mts`の`ignorePatterns`。
- **`@d-zero/no-click-event`**: ボタンのクリックは`command`/`commandfor`（Invoker Commands API）で送り、`onClick`・`addEventListener('click')`は書かない。リポジトリ全体で error。`kamado ui`の画面（`packages/kamado/client`）の markuplint も、`security/no-event-handler-attr`を`click`だけに絞って同じことを見張る（`.markuplintrc.json`）。`onChange`・`onKeyDown`などその他のイベントは許可する。markuplint の React の仕様が属性として持たないイベント（`onDoubleClick`・`onPointer*`）は、`no-unknown-attr`の`allowAttrs`に挙げてある。新しいイベントを使うときは、ここに足す。
- **markuplint**: 対象は`packages/kamado/client`。`@d-zero/markuplint-config`の`index`は class の命名（`l-`/`p-`/`c-`）を含むので、`base`と`jsx`だけを extends する。`index.html`は部品を React が描く殻で、`h1`は`app.tsx`が描くので、`a11y/required-h1`をこの 1 ファイルだけ無効にしてある。ポインタ専用のボタン（`aria-hidden="true"`と`tabIndex={-1}`。`grid-row.tsx`の`cell-hit`と`check`）は、設計どおり支援技術に見せないので、`a11y/wai-aria/interaction-in-hidden`をその形のボタンだけ無効にしてある（`nodeRules`）。設定ファイルは JSON でコメントを書けないので、理由はここに置く。
- **stylelint**: 対象は`packages/**/*.css`（今は`kamado ui`の`style.css`だけ）。`@d-zero/stylelint-config`の`base`と`order`を extends する。`base`は論理プロパティ（`margin-inline-start`、`inset-block-start`など）と個別の transform プロパティ（`translate`、`rotate`）を求める。`values`（`display`・`flex`・`z-index`・単位の流儀）と`name`（class の命名）は入れていない。
- **抑制**: oxlint の規則と実装の食い違いで抑制した箇所には、行の抑制（`oxlint-disable-next-line <規則> -- <理由>`）か、ファイルの先頭の抑制に理由を書く。`jsx/runtime.ts`の`typescript/no-base-to-string`は、React の` + value`と同じ変換（`valueOf`が先）を保つために、ファイルごと外してある（`String(value)`は`valueOf`のあるオブジェクトで結果が変わる）。文字列の`[...text]`は、2 単位の文字を割らないために使っている（`unicorn/prefer-spread`と`typescript/no-misused-spread`が食い違うので、後者を行ごとに外してある）。
- **`@d-zero/eslint-config`と`eslint`**: `scripts/pug-to-tsx-types.spec.ts`が、変換器の import の並びを`import-x/order`に通して確かめるので、oracle としてルートの devDependencies に残している（`yarn lint`は使わない。Renovate の対象外。ルートの`eslint`も、設定が固定する版のまま）。ESLint 専用だった規則（`import-x`・`sort-class-members`・`eslint-plugin-regexp`・`#private`の強制）は oxlint に移していない。

## 何を更新したら、何を作り直すか

テーブルと golden ファイルは、v2 が使っていたライブラリ（oracle）の出力から作ってコミットしている。実行時はその依存を持たない。oracle の版は v2 に合わせて固定するのが方針で（「v2 の oracle」。v2 から版が決まらない`mdn-data`と`jsonc-parser`だけは Renovate が上げる。下の段落）、動かしたときは、次のスクリプトを実行して差分を確かめる（スクリプトの先頭のコメントに詳細がある）。oracle の置き場（ルートの`devDependencies`）は「v2 の oracle」を参照。

| 契機                                                                                                                                                                                                                                                                                                                                       | 実行するスクリプト                       | 書き出すもの                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `character-entities`を動かした（「v2 の oracle」の 4。生成のあとに`cargo fmt --all`）                                                                                                                                                                                                                                                      | `scripts/generate-entities.mjs`          | `crates/kd_html/src/entities_table.rs`                                                   |
| `prettier-v2`を動かした（同上。生成のあとに`cargo fmt --all`）                                                                                                                                                                                                                                                                             | `scripts/generate-prettier-tables.mjs`   | `crates/kd_html/src/print/tables.rs`（構造が変わると失敗する）、`entity_names.rs`        |
| `html-minifier-terser`を動かした（同上）                                                                                                                                                                                                                                                                                                   | `scripts/generate-minifier-tables.mjs`   | `crates/kd_html/src/minify/tables.rs`                                                    |
| 同上                                                                                                                                                                                                                                                                                                                                       | `scripts/generate-minify-golden.mjs`     | `crates/kd_html/tests/minify_golden/`                                                    |
| `cssnano`を動かした（「v2 の oracle」の 3。設定は v2 の style-compiler と同じ）                                                                                                                                                                                                                                                            | `scripts/generate-css-golden.mjs`        | `crates/kd_css/tests/golden/`                                                            |
| 同上                                                                                                                                                                                                                                                                                                                                       | `scripts/generate-css-rule-tests.mjs`    | `crates/kd_css/tests/rules.rs`                                                           |
| 同上、または`mdn-data`を上げた（プロパティ名の元データ）                                                                                                                                                                                                                                                                                   | `scripts/generate-css-tables.mjs`        | `crates/kd_css/src/color_table.rs`、`property_table.rs`                                  |
| `esbuild-v2`を動かした（「v2 の oracle」の 4）                                                                                                                                                                                                                                                                                             | `scripts/generate-jsx-entities.mjs`      | `crates/kd_js/src/jsx_entities.rs`                                                       |
| `react` / `react-dom`を上げた                                                                                                                                                                                                                                                                                                              | `scripts/generate-jsx-tables.mjs`        | `packages/kamado/src/jsx/attr-table.ts`、`crates/kd_js/src/react_attrs.rs`               |
| `react-dom`を上げた（Pug から TSX への変換器が使う、小文字の属性名から React の綴りへの対応表）                                                                                                                                                                                                                                            | `scripts/generate-react-prop-names.mjs`  | `scripts/react-prop-names.mjs`（構造が変わると失敗する）                                 |
| Node を上げた（型の除去の挙動が変わりうる）                                                                                                                                                                                                                                                                                                | `scripts/generate-kd-js-golden.mjs`      | `crates/kd_js/tests/ts_golden/`                                                          |
| Node を上げた（Shift_JIS のデコーダ）                                                                                                                                                                                                                                                                                                      | `scripts/gen-cp932-table.mjs`            | `crates/kd_html/src/cp932_table.rs`                                                      |
| HTML の golden のケースを足した、または`kamado-v2`を上げた（v2 の DOM の直列化が oracle）                                                                                                                                                                                                                                                  | `scripts/generate-html-golden.mjs`       | `crates/kd_html/tests/golden/`                                                           |
| 属性・クラスの golden のケースを足した、または`kamado-v2`を上げた（`html.rules`の属性・クラスの操作と`html.imageSizes`の v2 の DOM での結果が oracle）                                                                                                                                                                                     | `scripts/generate-html-attr-golden.mjs`  | `crates/kd_html/tests/attr_golden/`                                                      |
| `path-list-to-tree.ts`か`random.test-util.ts`を変えた（`kamado pages`の`depth`と`parent`を`nav()`の木に合わせる。oracle は`pathListToTree`）                                                                                                                                                                                               | `scripts/generate-page-map-golden.mjs`   | `crates/kd_site/tests/page_map_golden.tsv`                                               |
| `@d-zero/shared`を上げた、または`random.test-util.ts`を変えた（`kamado ui`のソートと計画の並び（RFC §6）の自然順を、`pathComparator`と`numericalComparator`の 2 値の比べ結果に合わせる。並び全体は比べない。循環しない入力の並び全体と V8 の並びを照合する golden は、2 値の比べ結果が同じで安定ソートなら並びも同じになるので、持たない） | `scripts/generate-natural-golden.mjs`    | `crates/kd_core/tests/natural_golden.tsv`                                                |
| Node の`parseFloat`の読み方を変えた、または`random.test-util.ts`を変えた（メタの`order`が文字列のときに数にする読み方を、エンジンの`Number.isFinite(parseFloat(s)) ? parseFloat(s) : 0`に合わせる。並びそのもの（`nav_order.rs`）は golden を持たず、単体テストで確かめる）                                                                | `scripts/generate-order-golden.mjs`      | `crates/kd_core/tests/order_golden.tsv`                                                  |
| `jsonc-parser`を上げた、または JSONC の編集のケースを足した（`kd_jsonc::edit`の結果を、oracle の`modify`が出す値に合わせる。比べるのは値で、バイトではない）                                                                                                                                                                               | `scripts/generate-jsonc-edit-golden.mjs` | `crates/kd_jsonc/tests/edit_golden.json`、`crates/kd_jsonc/tests/edit_array_golden.json` |

生成したファイルをコミットする前に、`git diff`で変化が oracle の更新によるものか確かめる。生成したあとに`cargo test --locked --offline --workspace`を通す（`scripts/react-prop-names.mjs`は Rust が読まないので、`yarn test`の`scripts/pug-to-tsx-types.spec.ts`が、生成物の表が入れた react-dom から作る表と合っているかを確かめる）。生成物の見出しにある元データの版は、最後に生成したときの版の記録で、テストはこれを比べない（`pug-to-tsx-types.spec.ts`、`generate-css-tables.spec.ts`、`generate-prettier-tables.spec.ts`、`generate-jsx-entities.spec.ts`、`generate-jsx-tables.spec.ts`、`generate-entities.spec.ts`、`generate-minifier-tables.spec.ts`は、コミットした見出しの版で作り直して比べる。`cargo fmt`が整える Rust の表は、文字列の外の空白と末尾のカンマを除いて比べる）。これらの表は、表を変えない版の上げでは作り直さなくてよい。golden（`generate-minify-golden.mjs`など、上の表で同じ契機に並ぶもの）は版を比べるテストを持たないので、版を上げたら作り直す。`scripts/generate-jsx-tables.mjs`は実行時の出力（ランタイムと Rust のコンパイラ）が読む表`PROPS`などを作り、`attr-table.ts`だけに、変換器が読む別表`ELEMENT_BOOLEAN_PROPS`（`option`の`selected`と`input`の`checked`。React は`pushAttribute`ではなく、その要素のコードで書く）も作る。`scripts/generate-react-prop-names.mjs`は変換器だけが読む表を作る。`generate-jsx-tables.mjs`のあとは、Rust の表を整形するために`cargo fmt --all`を実行し、変換器が`dist`の`attr-table.js`を読むので`yarn build`で作り直す。

`property_table.rs`は、kd_css が値を書き換えるプロパティの一覧で、ここに無いプロパティの値は空白を詰めるだけになる（RFC §10）。元データの`mdn-data`は、ルートの`devDependencies`に固定し、Renovate が上げる（`.github/renovate.json`の`mdn-data`のグループ）。cssnano はすべてのプロパティの値を書き換え、プロパティの一覧を読まないので、一覧の版は v2 から決まらず、このリポジトリが宣言する。一覧が大きいほど cssnano に近い。新しい版が外したプロパティは、`generate-css-tables.mjs`の`extras`に足して一覧に残す（外すと、cssnano が書き換える値を kd_css が書き換えなくなる）。`color_table.rs`の元データの`@colordx/core`は、cssnano の colormin が引く版のまま（「v2 の oracle」の 3）。`yarn test`の`scripts/generate-css-tables.spec.ts`は、コミットした 2 つの表とインストールされている依存から生成器が作るものが同じか、`mdn-data`が宣言した版かを確かめる。プロパティの一覧を変える版を、作り直さずに上げた PR は、これで落ちる。作り直したら、`cargo test --locked --offline -p kd_css`と、ランダム入力の差分テスト（`fuzz-css.mjs` → `generate-css-oracle.mjs` → `check-css.mjs`）を通す。

`jsonc-parser`（VS Code が JSONC を編集するライブラリ）は、`kd_jsonc::edit`の結果の値を照合する oracle で、v2 は使っていない。ルートの`devDependencies`に固定し、Renovate が上げる（`.github/renovate.json`の`jsonc-parser`のグループ）。版を上げたら、同じ PR で`scripts/generate-jsonc-edit-golden.mjs`を実行して golden を作り直し、`cargo test --locked --offline -p kd_jsonc`を通す。golden は 2 つで、`edit_golden.json`がオブジェクトのメンバー（`set_member`・`delete_member`）、`edit_array_golden.json`が配列の要素（`push_element`・`delete_element`。`pages.overrides`の項目を足す・消すのに使う）。oracle は、`]`の前に空白の無い配列（`[1, 2]`）の最後の要素を消すと、要素を残して区切りだけを消す（`[12]`）。oracle が要素を消せていないケースは、生成器が golden から外す（`kd_jsonc::edit`の単体テストが確かめる）。`scripts/generate-jsonc-edit-golden.spec.ts`は oracle のその振る舞いを表明していて、版を上げて oracle が直ったら落ちるので、そのとき生成器の除外を外す。

ランダム入力の差分テスト（`scripts/fuzz-*.mjs`）は、コーパスをコミットしない（シードで決まる）。上のテーブルを作り直したとき、または`kd_html`/`kd_css`/`kd_js`の挙動を変えたときに、その分野のものを回す。各スクリプトの先頭に、対応する`--ignored`のテストと環境変数がある。`fuzz-html-pipeline.mjs`と`fuzz-html-chain.mjs`は、コード（`<script>` `<style>`、`style`属性、イベントハンドラ）を含むページをコーパスから除く（v3 はコードを整形しない。RFC §2）。そのコードは、圧縮の差分テスト（`fuzz-html-minify.mjs`、`check-kd-js-*.mjs`）で見る。

Pug から TSX への変換器（`scripts/pug-to-tsx.mjs`）は、小さな Pug のプロジェクトを変換して、出力を確かめ、`@d-zero/tsconfig`（strictest）の型検査に通す回帰テスト（`scripts/pug-to-tsx.spec.ts`）を持つ。変換器は、変換するプロジェクトの`pug-lexer`/`pug-parser`/`acorn`を読む。テストのために、このリポジトリはそれらを devDependencies に持つ（変換器そのものは、パッケージに入らない。`docs/v3/MIGRATION.md` §3.4）。書き出した TSX を読む（どこからも読まれない宣言を見つける）のは、このリポジトリの`typescript`のパーサー（`scripts/pug-to-tsx-types.mjs`の`readNames`）で、型検査のためだけの依存ではない。プロジェクトの版を使わないのは、読むのが変換器自身の出力で、プロジェクトが TypeScript を持つとは限らないため。テストは`yarn build`が済んでいるときに動く。済んでいなければ、手元ではスキップし、CI では失敗する。この依存を足す前の`node_modules`のままだと失敗するので、`yarn install`を済ませる。テストが使うのは、このリポジトリが固定した版（`acorn` 8 など）で、利用者のプロジェクトの版ではない。変換器は`acorn` 7（Pug が引く版）なら、理由を出して止まる。

| 分野                  | スクリプト                                                                                                                                                                                                      | 対応する検証                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| HTML のパース・直列化 | `fuzz-html-differential.mjs`（`html-fuzz.mjs`が生成器）                                                                                                                                                         | `crates/kd_html/tests/differential.rs`        |
| prettier の印字       | `fuzz-html-print.mjs` / `fuzz-html-json.mjs` / `fuzz-html-pipeline.mjs`                                                                                                                                         | `crates/kd_html/tests/print_differential.rs`  |
| 圧縮                  | `fuzz-html-minify.mjs` / `fuzz-html-minify-attrs.mjs`                                                                                                                                                           | `crates/kd_html/tests/minify_differential.rs` |
| HTML の連鎖全体       | `fuzz-html-chain.mjs`                                                                                                                                                                                           | `crates/kd_core`の`chain_matches_v2`          |
| CSS                   | `fuzz-css.mjs`と`generate-css-oracle.mjs`、`check-css.mjs`                                                                                                                                                      | `crates/kd_css/tests/differential.rs`         |
| CSS の`@import`       | `check-css-import.mjs`（要`cargo build -p kd_napi`と`yarn build`）                                                                                                                                              | `crates/kd_core/src/style_import.rs`のテスト  |
| CSS の`@custom-media` | `check-css-custom-media.mjs`（要`cargo build --release --offline -p kd_css --example minify`。oracle は v2 の`@d-zero/postcss-config`が固定する`postcss-custom-media`で、devDependencies の版をそれに合わせる） | `crates/kd_css/src/custom_media.rs`のテスト   |
| JS / TS / JSX         | `check-kd-js-js.mjs` / `check-kd-js-types.mjs` / `check-kd-js-jsx.mjs`（`jsx-fuzz.mjs`）                                                                                                                        | 各スクリプトを直接実行                        |

`check-css.mjs`は、次の 5 つの失敗がすべて 0 件のとき通る。

- `rust`: kd_css がエラーを返す
- `parse`: 出力を postcss が読めない
- `equivalence`（レポートでは`unexplained`）: kd_css の出力を cssnano に通した文字列が、元の入力を通した文字列と合わない
- `size`: ファイルが cssnano の出力の +3% と 8 バイトを超える。全ファイルの合計が +3% を超えるときも
- `idempotence`: 2 回圧縮すると変わる

`equivalence`か`size`が出たら、次の 3 つのどれかに分ける。

1. kd_css が意味を変えている: `crates/kd_css/src/`を直す。
2. kd_css が意図して cssnano と違う出力をする: `crates/kd_css/tests/common/mod.rs`の`DECISIONS`に両側の出力つきで記録する。`size`は、違いがこの記録だけでできているファイルを外す（`differential.rs`と同じ。`examples/minify.rs`が`DECISIONS`を読んで理由を返す。cssnano の出力`<n>.out`が`<n>.in`の隣にあるファイルだけが対象で、`generate-css-oracle.mjs`が書く）。外したファイルは`larger than the bound by listed decisions only`として報告する。`equivalence`は、cssnano が意味を変える差（不正な宣言を有効にする cssnano に対して、kd_css は不正なまま残す）だと、記録しても両側が 1 つにならない。そのため合わないときは、kd_css の出力に、入力に当たる記録を逆に当てたもの（`examples/minify.rs`の`undone`）を cssnano に通して比べ直し、合えば`by listed decisions only`として数える（`scripts/css-oracle.mjs`の`matchesWithDecisionsUndone`）。`size`はこの比べ直しを使わないので、そういうファイルが上限を超えれば`size`の失敗として残る（比べ直しで外すと、cssnano が縮める別の取り残しまで隠れる）。
3. cssnano が縮めきれていない書式だけの差で、意味は同じ: `check-css.mjs`の`benign`に名前をつけて足す。`benign`は`equivalence`だけが使い、`size`は使わない。

入れ子の規則を持つ規則の宣言と、規則の中のブロックの宣言は、cssnano が途中までしか縮めない（値の変換だけで、結合しない。展開した長手を戻さない）ので、そのままでは比べられない。`check-css.mjs`は、`benign`で説明できない差のときだけ、次の順に比べ直す（`scripts/css-oracle.mjs`）。(a) 両側の宣言を、cssnano がトップレベルで縮める形にそろえて比べる（値まで見る）。(b) それでも合わないものは、宣言の 1 まとまりを目印 1 つに置き換えて比べる。構造（セレクタ、at-rule、入れ子）と、入れ子の規則に対する宣言の位置は比べるが、値は比べない。(b) は検査の穴で、そこの宣言の値の誤りは見えない。kd_css はその宣言を、ほかの宣言と同じ処理で縮める。cssnano が隣り合う同名のブロックを結合しないために、同じ規則が 2 つ残る差は、結合したものを cssnano にもう一度通して比べる。

`fuzz-html-chain.mjs`の第 4 引数に`on`（圧縮あり）を渡して作ったコーパスは、`chain_matches_v2`に`KD_CHAIN_MINIFY=on`を付けて回す（圧縮の JS/CSS は両側とも切る）。付けない（または`off`）と v3 の圧縮を切る。ほかの値はエラー。

`scripts/`と`benchmarks/`も、`yarn lint`（oxlint と oxfmt）の対象。`benchmarks/v2-baseline/`は単独のプロジェクトなので対象外。

## v2 の oracle

v3 は「v2 と出力がバイト一致する」ことを目標にしているので、v2 の実物と比べる場所が 4 つある。どれも、公開済みの v2 のパッケージ（`2.0.0-alpha.17`）を npm から取り、このリポジトリに v2 のソースは置かない。

**1. DOM の直列化（golden とランダム入力の差分テスト）**: ルートの`devDependencies`の`"kamado-v2": "npm:kamado@2.0.0-alpha.17"`が、v2 の`kamado`に別名を付けたもの。次のスクリプトが`import { domSerialize } from 'kamado-v2/utils/dom'`で使う。

- `scripts/generate-html-golden.mjs`
- `scripts/generate-html-attr-golden.mjs`
- `scripts/fuzz-html-differential.mjs`
- `scripts/fuzz-html-chain.mjs`
- `scripts/v2-print.mjs`

別名なのは、このブランチの`kamado`（v3、ワークスペース）と同じ名前を、同じ`node_modules`に入れられないため。`yarn install`で入る。

**2. ビルド全体の比較（基準の出力）**: `benchmarks/v2-baseline/`は、v2 のビルド（`kamado`、`@kamado-io/page-compiler`、`@kamado-io/jsx-compiler`）を固定した版で動かす、単独の yarn プロジェクト（`package.json`と`yarn.lock`を持ち、ルートのワークスペースには入らない）。初回だけ、そのディレクトリで依存を入れる。

```sh
cd benchmarks/v2-baseline && yarn install
```

そのあと、リポジトリのルートから実行する。fixture は v2 用に作る（`--target=v2`）。

```sh
node benchmarks/v3/generate-jsx-fixtures.ts --pages=1000 --target=v2 --out=/tmp/fixtures-v2
node benchmarks/v2-baseline/run.ts /tmp/fixtures-v2 --out=/tmp/out-v2
```

v3 の出力と比べるには「比較ハーネスとベンチマーク」の`compare-outputs.ts`を使う。

**3. CSS の処理（`kd_css`と`@import`の展開）**: v2 の`@kamado-io/style-compiler`が使う`cssnano`・`postcss`・`postcss-import`を、同じ版でルートの`devDependencies`に固定する（`2.0.0-alpha.17`が固定している版は`npm view @kamado-io/style-compiler@2.0.0-alpha.17 dependencies`で読める）。`cssnano`が引く`cssnano-preset-default`などは、固定せずに範囲の解決に任せる。これは`2.0.0-alpha.17`を今インストールした利用者が受け取る解決と同じで、v2 の開発時の`yarn.lock`とは版が違うことがある。`@custom-media`の oracle である`postcss-custom-media`も、v2 の`@d-zero/postcss-config`が固定する版のまま。これらは Renovate の対象から外してある（`.github/renovate.json`）。使うスクリプトは次のとおり。

- `scripts/css-oracle.mjs`（`cssnano`を v2 の style-compiler と同じ設定で動かす。次のスクリプトが使う）
- `scripts/generate-css-golden.mjs`、`scripts/generate-css-rule-tests.mjs`
- `scripts/fuzz-css.mjs`（コーパスを作る）、`scripts/generate-css-oracle.mjs`、`scripts/check-css.mjs`
- `scripts/check-css-import.mjs`（`postcss-import`を直接読む）、`scripts/check-css-custom-media.mjs`

`crates/kd_css/tests/rules.rs`は`generate-css-rule-tests.mjs`が書くので、手では編集しない。手で書くテストは`crates/kd_css/tests/rules_hand.rs`に置く。

**4. HTML の整形・圧縮と JSX（`kd_html`・`kd_js`のテーブルと、ランダム入力の差分テスト）**: v2 の`@kamado-io/page-compiler`が使う`prettier`・`html-minifier-terser`・`character-entities`と、`@kamado-io/jsx-compiler`が使う`esbuild`を、同じ版でルートの`devDependencies`に固定する（`npm view @kamado-io/page-compiler@2.0.0-alpha.17 dependencies`と`npm view @kamado-io/jsx-compiler@2.0.0-alpha.17 dependencies`で読める）。`esbuild`は、`kamado`のランタイム依存でもあるので、oracle は`kamado-v2`と同じ`npm:`の別名にする: `esbuild-v2`。`prettier`も同じ別名の`prettier-v2`で、ルートに`prettier`は無い。ルートの`esbuild`は oracle ではなく、Renovate が通常どおり上げる。`yarn lint`の整形は oxfmt で、prettier は oracle としてだけ入っている。`html-minifier-terser`（`@types/html-minifier-terser`も）と`character-entities`は別名にしない。これらは Renovate の対象から外してある（`.github/renovate.json`）。使うスクリプトは次のとおり。

- `scripts/generate-prettier-tables.mjs`（`prettier-v2`のプラグインから表を読む）、`scripts/generate-jsx-entities.mjs`（`esbuild-v2`に尋ねる）、`scripts/generate-entities.mjs`、`scripts/generate-minifier-tables.mjs`、`scripts/generate-minify-golden.mjs`
- `scripts/v2-print.mjs`（`prettier-v2`と`html-minifier-terser`を v2 と同じ設定で動かす。`fuzz-html-print.mjs`・`fuzz-html-json.mjs`・`fuzz-html-pipeline.mjs`・`fuzz-html-chain.mjs`・`fuzz-html-minify.mjs`が使う）、`scripts/check-kd-js-jsx.mjs`（`esbuild-v2`で case を bundle する）
- `benchmarks/v3/html-normalize.ts`（比較ハーネスの`--semantic`が、文字参照を展開するのに`character-entities`の表を読む。oracle ではなく、WHATWG の名前付き文字参照の表として使う。移行する利用者が clone で動かすので、oracle を外すときもこの依存は残す）

別名の esbuild を足すと、`yarn install`が`@esbuild/<os>-<arch>`をトップに置くのはどちらの版か決まらない。そのため、`kd_core`のテストが呼ぶ実行ファイルは、Node が`esbuild`パッケージから解決するもの（`esbuild_for_tests`。ランタイムの`findEsbuildBinary`と同じ解決）にしてある。

**oracle の版を動かすとき**:

1. 1 は、ルートの`package.json`の`kamado-v2`の版を上げる（バージョンは固定。`^`は付けない）。`yarn install`のあと、上の 5 つのスクリプトのうち出力を書くもの（`generate-html-golden.mjs`と`generate-html-attr-golden.mjs`）を実行し、`git diff`で`crates/kd_html/tests/golden/`と`crates/kd_html/tests/attr_golden/`の変化が v2 の変更によるものか確かめる。ランダム入力のスクリプトは、差が出ないことを確かめる。
2. 2 は、`benchmarks/v2-baseline/package.json`の 3 つの`@kamado-io/*`・`kamado`を**同じ版**に揃えて上げ、そのディレクトリで`yarn install`して`yarn.lock`を更新する。
3. 3 は、v2 の`@kamado-io/style-compiler`が固定する版が変わったときだけ、ルートの`cssnano`・`postcss`・`postcss-import`をそれに合わせる。`postcss-custom-media`は、v2 の`@d-zero/postcss-config`が固定する版が変わったときに、同じ要領で合わせる。`yarn install`のあと、`generate-css-golden.mjs`と`generate-css-rule-tests.mjs`を実行して`git diff`を確かめ、`cargo test --locked --offline -p kd_css`を通す。ランダム入力（`fuzz-css.mjs` → `generate-css-oracle.mjs` → `check-css.mjs`）と、`check-css-import.mjs`・`check-css-custom-media.mjs`も実行する。`check-css-import.mjs`の`INTENDED`と`check-css-custom-media.mjs`の`INTENDED`は、oracle が書く文字列を含むので、版を動かすと書式の差で落ちることがある。落ちた文字列が書式だけの差か、意味の差かを見分けてから直す。
4. 4 は、v2 の`@kamado-io/page-compiler`が固定する版が変わったときに、ルートの`prettier-v2`・`html-minifier-terser`（と`@types/html-minifier-terser`）・`character-entities`をそれに合わせる。`@kamado-io/jsx-compiler`が固定する版が変わったときは、`esbuild-v2`を合わせる。`yarn install`のあと、動かした依存に当たる「何を更新したら、何を作り直すか」の表のスクリプトを実行する（`print/tables.rs`と`entities_table.rs`は生成のあとに`cargo fmt --all`）。`git diff`で、変化が v2 の版の差によるものか確かめ、`cargo test --locked --offline --workspace`と`yarn test`を通す。`prettier-v2`なら`fuzz-html-print.mjs`・`fuzz-html-json.mjs`・`fuzz-html-pipeline.mjs`・`fuzz-html-chain.mjs`・`fuzz-html-minify.mjs`、`esbuild-v2`なら`check-kd-js-jsx.mjs`（手書きと`fuzz`、`KD_JS_FUNCTION=1`も）を実行して、差が出ないことを確かめる。差が出たら、v2 の版の差か kd_html・kd_js の差かを分け、後者を直す。
5. v2 の API が変わって import が通らなくなったら、スクリプト側を合わせる。v2 の出力が変わったなら、変わった理由が RFC §2 の意図した差に当たるか確かめ、当たらなければ v3 のほうを直す。
6. v2 の保守が止まって oracle を更新しなくなったら、`kamado-v2`の版、`benchmarks/v2-baseline/`、CSS の`cssnano`・`postcss`・`postcss-import`・`postcss-custom-media`の版、`prettier-v2`・`esbuild-v2`・`html-minifier-terser`・`character-entities`の版は固定したままでよい（golden はコミット済みで、kamado の実行時はこの依存を使わない）。`character-entities`は比較ハーネスの`--semantic`も読むので、外さない。

`benchmarks/v2-baseline/.yarn/`は`.gitignore`の対象。

## 比較ハーネスとベンチマーク

```sh
# JSX の fixture を生成（シードと件数が同じなら同じ木になる）
node benchmarks/v3/generate-jsx-fixtures.ts --pages=1000 --out=/tmp/fixtures

# 2 つの出力ディレクトリを比較（差分があれば終了コード 1）
node benchmarks/v3/compare-outputs.ts <baselineDir> <candidateDir> --json=report.json
```

比較の判定は`benchmarks/v3/compare-trees.ts`に書いてある。`.css`/`.js`/`.map`はサイズが増えないことを、それ以外はバイト一致を求める。

`--semantic`（と`--diff=<相対パス>`）は、利用者が v2 からの移行を確かめるためのもの（MIGRATION §10.1）。ページを`benchmarks/v3/html-normalize.ts`でそろえてから比べ、`equivalent`を数える。v3 の開発で v2 との一致を確かめるときは付けない（バイト比較のまま）。

`v2`ブランチにあった`yarn bench`（このブランチには無い）は、10 万ページ級では生成器がファイルを一斉に開いて`EMFILE`になる（macOS の上限は約 6 万）。v2 の基準値は 5 万ページまでで取る。10 万ページの基準は、`benchmarks/v3/generate-jsx-fixtures.ts`の fixture を、上の`benchmarks/v2-baseline/run.ts`で処理して取る。

開発サーバーの応答時間は`benchmarks/v3/serve-latency.ts`で測る（ビルド済みの`dist`と release のアドオンが要る）。fixture を作って`start()`で起動し、ヒット・ページ風の miss・`/favicon.ico`を各 N 回要求して p50 と p99 を出し、計画を作り直す要求（`pages.overrides`の変更、ページファイルの追加と削除）の時間も 1 回ずつ出す。`KAMADO_NATIVE_ADDON=<path>`で変更前のアドオンを指すと、同じ手順で比べられる。`KD_TIMING=1`を付けると、作り直しのたびに`replan (walk)`か`replan (assemble)`の行が出るので、行を数えれば作り直した回数が分かる。

```sh
node benchmarks/v3/serve-latency.ts --pages=1000 --requests=200
```

## JSX コンパイラの検証

`kd_js`が出力する JS を、esbuild と React 19 の`renderToStaticMarkup`（v2 の jsx-compiler がやっていたこと）と比べる。ビルドはページを「チャンクの関数」としてコンパイルするので、その形（`KD_JS_FUNCTION=1`）でも同じ比較をする。

```sh
cargo build --release --offline -p kd_js --example compile
node scripts/check-kd-js-jsx.mjs                 # 手書きのケース
node scripts/check-kd-js-jsx.mjs fuzz 3000 7     # ランダムなコンポーネント
KD_JS_FUNCTION=1 node scripts/check-kd-js-jsx.mjs fuzz 3000 7   # 関数形式
```

`KD_PAGE_CHUNKS=0`を付けると`build`もチャンクを使わずに、ページを 1 ファイルのモジュールとして書き出す。出力が同じことを比べるときに使う。

## 性能の見方

`KD_TIMING=1 KAMADO_TIMING=1 node packages/kamado/dist/cli.js build ...`で、段階ごとの時間（Rust 側と JS 側）が標準エラーに出る。`core finish: summed over N threads`の行は、書き出しの段（`finish: pages and assets`）でページが HTML の段と書き込みに使った時間を、N 本のスレッドで合算した値。壁時計の時間（スレッド数 × 段の時間）と見比べると、ページがどちらで待っているかの目安になる。スレッドがコア数より多いと、実行されていない時間もそのときいた側に数えられるので、CPU の計測ではなく目安として読む。HTML の段には文字コードの変換が含まれる。`sample`（macOS）や`perf`（Linux）で見るときは、`strip = "symbols"`を外したビルド（`CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_DEBUG=1 cargo build --release -p kd_napi --target-dir <別の場所>`）を`KAMADO_NATIVE_ADDON`で指す。HTML 段だけの時間は`cargo run --release -p kd_html --example stage_bench -- <出力ディレクトリ> [件数]`（1 スレッド、1 ページあたりの平均）。件数のあとに 3 行出る: `format`とその内訳（パース・空白の前処理・doc の構築・doc の出力・解放。`steps sum`が`format`と近ければ内訳は合っている）、`minify`、DOM の段（パース・シリアライズ・木の解放。includes などの規則は含まない）と encode（UTF-8 と Shift_JIS）。内訳は`print::format`の中身を写したもので、`format`を変えたら追従させる。`REPEAT=n`は`format`だけを n 回回す（サンプリングプロファイラ用）。

`stage_bench`で変更の前後を比べるには、出力と時間を別々に見る。

- **出力**: `DUMP=<dir>`は、`REPEAT`の最後の回の`format`の出力を、読んだ順に`<dir>/<n>.html`として書き出し、`<dir>/index.txt`に番号と元のパスを書く。変更前後のバイナリで書き出して`diff -r -x index.txt`すれば、出力が変わっていないことをバイト単位で確かめられる。整形に失敗したページは空のファイルになり、失敗した件数が出力に出て、`index.txt`のそのページの行に`(did not format)`が付く（両方の版で同じページが失敗していれば、その分は空同士の一致）
- **時間**: マシンの負荷が高いと時間（µs）がぶれる。`/usr/bin/time -l env REPEAT=n <stage_bench> ...`が出す`instructions retired`（macOS）は負荷に左右されないので、変更の前後はそれで比べる

検査ソフトのない環境で cold を測るには、GitHub Actions の`Bench cold build`（`.github/workflows/bench-cold.yml`、手動実行）を使う。ページ数を指定して fixture を生成し、cold を 2 回、`--incremental`を 2 回（2 回目が warm）ビルドして、段階別の時間をジョブのサマリーに出す。ubuntu（x64/arm64）と macOS で走る。

ページごとの時間の大半は、`open`やファイルの作成に費やされる環境がある（開発に使っている macOS では`open`が 70〜200µs）。ファイルの数を減らすことが、CPU の最適化より効く。
