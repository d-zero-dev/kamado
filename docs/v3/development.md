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

ツールチェーンの版は `.github/workflows/rust.yml` で固定している。`rust-toolchain.toml` は置かない。置くと、ローカルの `stable` とは別のツールチェーンが再インストールされ、環境によっては中途半端な状態で失敗する。

## N-API アドオン（`crates/kd_napi`）

```sh
cargo build --locked --offline --release -p kd_napi
node --test crates/kd_napi/check/load.check.mjs
```

`*.check.mjs` は、ネイティブのビルドが必要なので vitest の対象にしていない（`yarn test` では動かない）。

## Node 側のパッケージ（`packages/kamado-v3`）

v2 の `kamado` パッケージと同じワークスペースに置くため、v2 を取り除くまでの間は `kamado-v3` という名前で開発する（公開時に `kamado` に戻す）。中身は CLI、`build()` の薄いラッパー、アドオンの読み込みだけで、ランタイム依存はない。

```sh
cargo build --release -p kd_napi   # アドオンを先に作る
yarn build                         # TypeScript をコンパイル
node packages/kamado-v3/dist/cli.js build --config path/to/kamado.config.jsonc --verbose --incremental
```

アドオンは `KAMADO_NATIVE_ADDON` で指定したファイル、なければ `target/release`、`target/debug` の順に探す。

## 比較ハーネスとベンチマーク

```sh
# JSX の fixture を生成（シードと件数が同じなら同じ木になる）
node benchmarks/v3/generate-jsx-fixtures.ts --pages=1000 --out=/tmp/fixtures

# 2 つの出力ディレクトリを比較（差分があれば終了コード 1）
node benchmarks/v3/compare-outputs.ts <baselineDir> <candidateDir> --json=report.json
```

比較の判定は `benchmarks/v3/compare-trees.ts` に書いてある。`.css` / `.js` / `.map` はサイズが増えないことを、それ以外はバイト一致を求める。

v2 の `yarn bench` は、10 万ページ級では生成器がファイルを一斉に開いて `EMFILE` になる（macOS の上限は約 6 万）。v2 の基準値は 5 万ページまでで取る。
