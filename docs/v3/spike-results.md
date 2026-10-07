# v3 スパイク結果

v3 の設計判断の根拠にした実測結果。環境: macOS arm64（M 系）、Node 26.7.0、Rust 1.98.1（stable）。

## 手書き N-API（napi-rs なし、リンカフラグなし）

**結果: 成功。** `crates/kd_napi` は外部クレート 0・`build.rs` なし・リンカフラグなしで cdylib としてビルドでき、`.node` として Node から読み込めた。

- `napi_*` は `dlsym(RTLD_DEFAULT)` で起動時に関数表へ解決する（macOS は `RTLD_DEFAULT = -2`、Linux は `NULL`）。`-undefined dynamic_lookup` は不要。
- context-aware: `napi_register_module_v1` が環境ごとに呼ばれる。main スレッドとワーカー 4 つで同じ `.node` を読み込み、プロセス static の `counter()` が 1〜7 と連続した（状態の共有を確認）。
- `Buffer` はコピーなしで読める（`napi_get_buffer_info`）。8 MiB の SHA-256 が `node:crypto` と一致した。

Linux x64 / arm64 での読み込みは、`.github/workflows/rust.yml` の `ubuntu-latest` と `ubuntu-24.04-arm` のジョブが `crates/kd_napi/check/load.check.mjs` で確認している（macOS arm64 も同じジョブ）。CI で確認していないのは、darwin-x64 と Linux の musl。

## Node 内蔵の型除去（`module.stripTypeScriptTypes`）

**結果: TSX は単独では不可。** 型だけの TS（`as const`、ジェネリックのアロー関数 `<T,>`、`satisfies`）は通るが、**JSX 構文を含むと `ERR_INVALID_TYPESCRIPT_SYNTAX`**。`enum` は strip モードで `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`（erasable syntax のみ対応）。

`kd_js`（TSX の変換）への影響:

- Rust が **先に JSX を変換**し（型注釈は残したまま）、その出力を Node の型除去に渡す構成にできる。Rust の字句解析は TSX 規則で `<` の曖昧さ（ジェネリクス / JSX）を扱う必要があるが、型の除去そのものは Node に任せられる。
- `enum` / `namespace` などの非 erasable な構文は、型除去を Node に任せる限り非対応になる。仕様として明記する。
- `stripTypeScriptTypes` は実験的な API（`ExperimentalWarning`）。変更されたときの退避策として、Rust 側の型除去を残す。

## v2 の PHP 記法の扱い

**結果: v2（linkedom）は本文中の `<?php ... ?>` を黙って削除する。**

| 入力                                                       | v2 の DOM 出力 | v2 の既定パイプライン出力 |
| ---------------------------------------------------------- | -------------- | ------------------------- |
| 本文中の `<?php include('x'); ?>`、`<?php if ($x): ?>`     | **削除される** | 削除されたまま整形される  |
| 属性内の `class="<?php echo $c; ?>"`、`href="<?= $url ?>"` | 保持される     | 保持される                |

実サイトでの確認: PHP 風の include（ヘッダー・フッターの読み込み）を本文に持つ静的サイトでも、v2 のビルド済み出力には PHP タグを含むファイルが **0 件**で、v2 がすべて削除していることを確認した。

v3 への影響:

- v3 は `<?...?>` を**処理命令のトークンとして保持**する（データ損失を再現しない）。これは v2 とバイト一致しない**意図的な差分**で、RFC §2 と MIGRATION.md §11 に記載している。
- 本文 PHP と属性 PHP は、`scripts/generate-html-golden.mjs` と `scripts/generate-minify-golden.mjs` のケースに含まれている。
- 旧 CMS のテンプレート変数（`{...}` 形式）が残っているページもあるが、HTML としては普通の文字なので v2 も v3 も何もしない。特別扱いはしない。

## SHA-256 のハードウェア命令

**結果:** aarch64 の `sha2` 拡張（`vsha256hq_u32` など）は Rust 1.98.1 の stable で使え、`is_aarch64_feature_detected!("sha2")` で実行時検出もできた。`crates/kd_hash` は portable 実装で、NIST のベクタ（空、`abc`、448 ビット、896 ビット、100 万個の `a`）と分割更新の境界テストが通っている。

x86_64 の SHA-NI と、命令を使った実装は採用していない（`kd_hash` は portable 実装のみで、CI の Linux x64 でも同じ NIST のベクタが通る）。stat 先行の判定により、ハッシュを取るのは (size, mtime) が変わったファイルだけなので、必要になるまで入れない。

## ツールチェーンの固定

`rust-toolchain.toml` で `channel = "1.98.1"` と `components` を指定すると、ローカルの `stable` と別のツールチェーンとして再インストールが走り、環境によっては中途半端な状態で失敗する（実測で確認）。再現ビルドのための固定は、CI（`.github/workflows/rust.yml`）が `rustup toolchain install 1.98.1` を明示して行う。ローカルは `rust-toolchain.toml` を置かず、同じ版を手で入れる（`development.md`）。

## v2 の基準値（`v2` ブランチの `yarn bench --full`、同一マシン、1 回計測）

| ページ数 | 時間     | pages/s                                                                                                                                                          |
| -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 10,010   | 30.78s   | 324.9                                                                                                                                                            |
| 50,010   | 316.13s  | 158.2                                                                                                                                                            |
| 100,000  | 計測不可 | v2 のベンチ生成器が全ファイルを一斉に開き、macOS のファイル数上限（約 61,440）で `EMFILE` になる（v2 のベンチツールの制約。`ulimit` を上げても上限は変わらない） |

- **規模に対して非線形に遅くなる**（1 万→5 万で pages/s が半分以下）。v3 の目標（10 万ページで cold ≤ 10s）は、v2 の外挿（10 万ページで 10 分超）に対して 60 倍以上の改善にあたる。
- RSS は v2 の `run-bench.ts`（`v2` ブランチ）の出力にこの規模では出なかったので、v3 の比較用の RSS は `benchmarks/v3/` のハーネスで計測する。
- 10 万ページの v2 基準値は、v2 の生成器を使えないので、v3 の fixture 生成器（`benchmarks/v3/generate-jsx-fixtures.ts`、`--target=v2`、ディレクトリを分けて生成）で作った fixture を、`benchmarks/v2-baseline/run.ts`（公開済みの v2 を固定した版で動かす）で処理する形で取る。手順は `docs/v3/development.md` の「v2 の oracle」。

## 構造文字の走査（SIMD）

30 KB の HTML から `<` と `&` を探すマイクロベンチ（aarch64、`rustc -O`）:

| 実装                        | スループット | 30 KB あたり |
| --------------------------- | ------------ | ------------ |
| スカラー（バイトのループ）  | 2.11 GB/s    | 14.3 µs      |
| NEON（16 バイトを一括分類） | 8.41 GB/s    | 3.6 µs       |

- NEON はスカラーの約 4 倍。ただし、スカラーでも 10 万ページ（各 30 KB）の走査は単一スレッドで約 1.4 秒で、全体の目標（cold ≤ 10s）に対して小さい。印字・DOM・書き出しのほうが支配的になる。
- 判断: **トークナイザはスカラーで書き、構造文字の探索を 1 つの関数に分離して置く**。SIMD への差し替えは、実測で必要になってから行う（x86_64 の AVX2 / SSE2 と NEON の両方に portable な実装を残す）。

## Rust プールとワーカーの CPU 配分

ワーカー描画は実装済みで、描画（ワーカー、`--jobs` / `build.jobs` で数を指定）と後処理（Rust のスレッドプール）は同じビルドの中で動く。プールの数とワーカーの数の配分を変えた比較の結果は、この文書にはない（既定は `auto`）。
