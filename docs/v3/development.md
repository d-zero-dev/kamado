# v3 の開発手順

Rust のワークスペース（`crates/`）とベンチマーク・比較ツール（`benchmarks/v3/`）の使い方。仕様は `RFC.md`、設計判断の根拠は `spike-results.md` を参照。

## Rust

Rust のクレートはすべて標準ライブラリのみに依存する。外部クレートを追加してはいけない（CI が検証する）。

```sh
cargo fmt --all -- --check
cargo clippy --locked --offline --all-targets -- -D warnings
cargo test --locked --offline --workspace
node scripts/check-rust-no-external-crates.mjs
```

**前提**: `cargo test` の前に、リポジトリのルートで `yarn install` を済ませておく。一部のテストが `node_modules` の esbuild の実行ファイル（`node_modules/@esbuild/<os>-<arch>`、`crates/kd_core/src/minifiers.rs` の `esbuild_for_tests`）を呼び、無ければ「run `yarn install`」で失敗する。Node の標準機能や prettier などを比較対象（oracle）にして実行時に比べるテストもあるので、Node も要る。

ツールチェーンの版は `.github/workflows/rust.yml` で固定している。`rust-toolchain.toml` は置かない。置くと、ローカルの `stable` とは別のツールチェーンが再インストールされ、環境によっては中途半端な状態で失敗する。

## クレートの構成

| クレート    | 担当                                                                                             | 依存するクレート               |
| ----------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| `kd_hash`   | SHA-256                                                                                          | なし                           |
| `kd_jsonc`  | JSONC のパーサと決定的な JSON 出力（`Value` 型）                                                 | なし                           |
| `kd_glob`   | glob のマッチと、探索を枝刈りするための判定                                                      | なし                           |
| `kd_yaml`   | YAML のサブセットと front matter の分割                                                          | `kd_jsonc`                     |
| `kd_pool`   | スレッドプール                                                                                   | なし                           |
| `kd_image`  | 画像（png / jpeg / webp / avif / svg）の寸法の読み取り                                           | なし                           |
| `kd_css`    | CSS のトークナイザ・パーサ・圧縮（cssnano 相当）                                                 | なし                           |
| `kd_js`     | TS / TSX / JSX のパーサ、型の除去、JSX → 文字列連結へのコンパイル、静的な meta の抽出            | なし                           |
| `kd_html`   | HTML のパーサ、DOM、セレクタ、宣言的ルール、取り込み、画像寸法の付与、整形と圧縮（融合した印字） | `kd_image`                     |
| `kd_site`   | 出力パス・URL の写像、`outputPathField`、衝突、探索、メタデータのマージ、overrides               | `kd_glob` `kd_jsonc`           |
| `kd_build`  | 差分ビルドの manifest（バイナリ形式、stat 先行の指紋）                                           | `kd_hash` `kd_jsonc`           |
| `kd_config` | `kamado.config.jsonc` の型・既定値・検証                                                         | `kd_glob` `kd_jsonc` `kd_site` |
| `kd_core`   | ビルドの組み立て（設定 → 探索 → メタ → 差分判定 → HTML・CSS・JS → 書き出し）と開発サーバーの核   | 上のすべて                     |
| `kd_napi`   | Node-API の接続層とアロケータ。`unsafe` はここだけ                                               | `kd_core` `kd_hash` `kd_jsonc` |

依存の向きは上から下の一方向で、`kd_napi` が一番上位にある。パース系のクレート（`kd_jsonc` `kd_glob` `kd_yaml`）は、ユーザーが書くファイルを読むので、入れ子の深さや計算量を制限している。

## N-API アドオン（`crates/kd_napi`）

```sh
cargo build --locked --offline --release -p kd_napi
node --test crates/kd_napi/check/load.check.mjs
```

`*.check.mjs` は、ネイティブのビルドが必要なので vitest の対象にしていない（`yarn test` では動かない）。

## Node 側のパッケージ（`packages/kamado-v3`）

v2 の `kamado` パッケージと同じワークスペースに置くため、v2 を取り除くまでの間は `kamado-v3` という名前で開発する（公開時に `kamado` に戻す）。中身は CLI、`build()` / `start()`、JSX の描画ワーカー、開発サーバー（hono）、esbuild の呼び出し、アドオンの読み込みで、ランタイム依存は `esbuild` と `hono` / `@hono/node-server` だけ。使い方は `packages/kamado-v3/README.md`、設定の補完用に `schema.json` を同梱している（キーは `kd_config` のテストが双方向に照合する）。

```sh
cargo build --release -p kd_napi   # アドオンを先に作る
yarn build                         # TypeScript をコンパイル
node packages/kamado-v3/dist/cli.js build --config path/to/kamado.config.jsonc --verbose --incremental
```

アドオンは `KAMADO_NATIVE_ADDON` で指定したファイル、なければ `target/release`、`target/debug` の順に探す。

## 何を更新したら、何を作り直すか

テーブルと golden ファイルは、v2 が使っていたライブラリ（oracle）の出力から作ってコミットしている。実行時はその依存を持たない。oracle の版を上げたら、次のスクリプトを実行して差分を確かめる（スクリプトの先頭のコメントに詳細がある）。

| 契機                                                      | 実行するスクリプト                     | 書き出すもの                                                                  |
| --------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------- |
| `character-entities` を上げた                             | `scripts/generate-entities.mjs`        | `crates/kd_html/src/entities_table.rs`                                        |
| `prettier` を上げた                                       | `scripts/generate-prettier-tables.mjs` | `crates/kd_html/src/print/tables.rs`（構造が変わると失敗する）                |
| `html-minifier-terser` を上げた                           | `scripts/generate-minifier-tables.mjs` | `crates/kd_html/src/minify/tables.rs`                                         |
| 同上                                                      | `scripts/generate-minify-golden.mjs`   | `crates/kd_html/tests/minify_golden/`                                         |
| `cssnano` を上げた（v2 の style-compiler 経由で入る）     | `scripts/generate-css-golden.mjs`      | `crates/kd_css/tests/golden/`                                                 |
| 同上                                                      | `scripts/generate-css-rule-tests.mjs`  | `crates/kd_css/tests/rules.rs`                                                |
| 同上、または色名・プロパティ名の元データ（`mdn-data` 等） | `scripts/generate-css-tables.mjs`      | `crates/kd_css/src/color_table.rs`、`property_table.rs`                       |
| `esbuild` を上げた                                        | `scripts/generate-jsx-entities.mjs`    | `crates/kd_js/src/jsx_entities.rs`                                            |
| `react` / `react-dom` を上げた                            | `scripts/generate-jsx-tables.mjs`      | `packages/kamado-v3/src/jsx/attr-table.ts`、`crates/kd_js/src/react_attrs.rs` |
| Node を上げた（型の除去の挙動が変わりうる）               | `scripts/generate-kd-js-golden.mjs`    | `crates/kd_js/tests/ts_golden/`                                               |
| Node を上げた（Shift_JIS のデコーダ）                     | `scripts/gen-cp932-table.mjs`          | `crates/kd_html/src/cp932_table.rs`                                           |
| HTML の golden のケースを足した（`linkedom` が oracle）   | `scripts/generate-html-golden.mjs`     | `crates/kd_html/tests/golden/`                                                |

生成したファイルをコミットする前に、`git diff` で変化が oracle の更新によるものか確かめる。生成したあとに `cargo test --locked --offline --workspace` を通す。

ランダム入力の差分テスト（`scripts/fuzz-*.mjs`）は、コーパスをコミットしない（シードで決まる）。上のテーブルを作り直したとき、または `kd_html` / `kd_css` / `kd_js` の挙動を変えたときに、その分野のものを回す。各スクリプトの先頭に、対応する `--ignored` のテストと環境変数がある。

| 分野                  | スクリプト                                                                               | 対応する検証                                  |
| --------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------- |
| HTML のパース・直列化 | `fuzz-html-differential.mjs`（`html-fuzz.mjs` が生成器）                                 | `crates/kd_html/tests/differential.rs`        |
| prettier の印字       | `fuzz-html-print.mjs` / `fuzz-html-json.mjs` / `fuzz-html-pipeline.mjs`                  | `crates/kd_html/tests/print_differential.rs`  |
| 圧縮                  | `fuzz-html-minify.mjs` / `fuzz-html-minify-attrs.mjs`                                    | `crates/kd_html/tests/minify_differential.rs` |
| HTML の連鎖全体       | `fuzz-html-chain.mjs`                                                                    | `crates/kd_core` の `chain_matches_v2`        |
| CSS                   | `fuzz-css.mjs` と `generate-css-oracle.mjs`、`check-css.mjs`                             | `crates/kd_css/tests/differential.rs`         |
| JS / TS / JSX         | `check-kd-js-js.mjs` / `check-kd-js-types.mjs` / `check-kd-js-jsx.mjs`（`jsx-fuzz.mjs`） | 各スクリプトを直接実行                        |

`scripts/` と `benchmarks/` は、ルートの `yarn lint:eslint` の対象外（prettier と cspell だけが見る）。

## 比較ハーネスとベンチマーク

```sh
# JSX の fixture を生成（シードと件数が同じなら同じ木になる）
node benchmarks/v3/generate-jsx-fixtures.ts --pages=1000 --out=/tmp/fixtures

# 2 つの出力ディレクトリを比較（差分があれば終了コード 1）
node benchmarks/v3/compare-outputs.ts <baselineDir> <candidateDir> --json=report.json
```

比較の判定は `benchmarks/v3/compare-trees.ts` に書いてある。`.css` / `.js` / `.map` はサイズが増えないことを、それ以外はバイト一致を求める。

v2 の `yarn bench` は、10 万ページ級では生成器がファイルを一斉に開いて `EMFILE` になる（macOS の上限は約 6 万）。v2 の基準値は 5 万ページまでで取る。

## JSX コンパイラの検証

`kd_js` が出力する JS を、esbuild と React 19 の `renderToStaticMarkup`（v2 の jsx-compiler がやっていたこと）と比べる。ビルドはページを「チャンクの関数」としてコンパイルするので、その形（`KD_JS_FUNCTION=1`）でも同じ比較をする。

```sh
cargo build --release --offline -p kd_js --example compile
node scripts/check-kd-js-jsx.mjs                 # 手書きのケース
node scripts/check-kd-js-jsx.mjs fuzz 3000 7     # ランダムなコンポーネント
KD_JS_FUNCTION=1 node scripts/check-kd-js-jsx.mjs fuzz 3000 7   # 関数形式
```

`KD_PAGE_CHUNKS=0` を付けると `build` もチャンクを使わずに、ページを 1 ファイルのモジュールとして書き出す。出力が同じことを比べるときに使う。

## 性能の見方

`KD_TIMING=1 KAMADO_TIMING=1 node packages/kamado-v3/dist/cli.js build ...` で、段階ごとの時間（Rust 側と JS 側）が標準エラーに出る。`sample`（macOS）や `perf`（Linux）で見るときは、`strip = "symbols"` を外したビルド（`CARGO_PROFILE_RELEASE_STRIP=none CARGO_PROFILE_RELEASE_DEBUG=1 cargo build --release -p kd_napi --target-dir <別の場所>`）を `KAMADO_NATIVE_ADDON` で指す。HTML 段だけの時間は `cargo run --release -p kd_html --example stage_bench -- <出力ディレクトリ>`。

ページごとの時間の大半は、`open` やファイルの作成に費やされる環境がある（開発に使っている macOS では `open` が 70〜200µs）。ファイルの数を減らすことが、CPU の最適化より効く。
