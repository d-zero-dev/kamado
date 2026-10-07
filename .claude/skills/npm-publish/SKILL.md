---
name: npm-publish
description: npm パッケージのリリース（dev→main マージ、バージョニング、tag push、publish workflow 監視、publish 結果検証、dev への同期）
when_to_use: ユーザーが「リリースして」「publish して」「バージョン上げて」「/npm-publish」と指示した場合
disable-model-invocation: true
---

# 前提

- リリースは `main` ブランチから行う。`dev` の変更を `main` にマージしてから実行する
- `v*` タグ push で `publish.yml` が発火し、npm へ自動 publish される（OIDC Trusted Publishing）
- **publish は取り消せない**。各ステップでユーザーの確認を取る
- **`yarn release` / `git push` 系はユーザーが実行する**。エージェントは実行せず（`.claude/settings.json` で deny されている）`!` プレフィックス付きのコマンドを提示し、完了報告を待つ

# v3 の公開の流れ

v3 は、ネイティブアドオン（Rust の `kd_napi`）をプラットフォームごとにビルドし、`kamado` に全プラットフォーム分（`native/<os>-<arch>/kd_napi.node`）を同梱して公開する（`docs/v3/RFC.md` §18。プラットフォーム別のパッケージには分けない）。`publish.yml` は次の順に進み、どこかで失敗したら公開に進まない。

1. `check`: Cargo の版（`scripts/sync-cargo-version.mjs --check`）、`packages/kamado` の版、タグが `lerna.json` の版と一致しているか。dist-tag を決める
2. `addon`: 4 プラットフォーム（darwin-arm64、darwin-x64、linux-x64、linux-arm64）の実機でアドオンをビルドし、読み込みを確認する
3. `package`: 集めて `native/` に置き、`yarn build` と `yarn pack` で tarball を作る
4. `smoke`: tarball を 5 つの実機で展開し、同梱のアドオンが読み込めることを確認する（`scripts/check-package-addon.mjs`）
5. `publish`: 確認した tarball そのものを `npm publish`（OIDC、provenance）。**タグの push のときだけ**。手で起動（`workflow_dispatch`）したときは 4 までの予行になる

`yarn release*` は `lerna version` のあとに Cargo の版も揃え、リリースコミットに含めてタグを付け直す（`scripts/release.mjs`。lerna のフックは `.yarnrc.yml` の `enableScripts: false` で動かない）。`kamado` の npm 側の信頼設定（リポジトリ、ワークフロー名 `publish.yml`）が合っていることは、初回の公開の前にユーザーが確認する。

v2 のリリースは `v2` ブランチで行う。公開済みの v2（`kamado@2.0.0-alpha.17` など）は npm に残る。

v2 のリリースは `v2` ブランチで行う。公開済みの v2（`kamado@2.0.0-alpha.17` など）は npm に残る。

# 対象パッケージ

v3 の対象は `kamado`（`packages/kamado`）の 1 つで、**無スコープ**で公開する（`npm view` 等のコマンド例でスコープを付けない）。版は Lerna が `lerna.json` の `version` で管理する（Cargo の版も同じ値に揃う）。

# 手順

## 1. ワーキングツリーの状態確認

`git status` で未コミットの変更・未追跡ファイルがないか確認する。

- クリーンなら次へ
- 変更があればユーザーに報告し、`git stash` / コミット / 中断のいずれかを尋ねる。指示に従ってから次へ

汚れたまま先に進むとマージ・バージョニングが意図しない差分を巻き込むため、ここは省略しない。

## 2. main と dev の最新化

```bash
git fetch origin
git checkout main
git pull origin main
git checkout dev
git pull origin dev
git checkout main
```

両ブランチをローカルで最新にしてから `main` に戻る。`dev` を最新にしておくのは、手順 11 の `main` → `dev` 同期でそのまま使うため。

いずれかの `pull` が失敗したらユーザーに報告して指示を仰ぐ。

## 3. 未マージ PR の確認

リリースに含めるべき PR が残っていないか確認し、あればユーザーに提示して続行可否を尋ねる。

```bash
gh pr list --base dev --state open
```

## 4. dev → main マージ

`dev` が `main` より進んでいる場合、差分コミットをユーザーに提示してからマージする。

```bash
git log --oneline main..dev
git merge dev --no-edit
```

コンフリクトが発生したらユーザーに報告して指示を仰ぐ。

## 5. lockfile の同期確認

```bash
yarn install
git diff yarn.lock
```

差分が出たらユーザーに報告し、コミットしてから次へ。CI の `yarn install --immutable` が失敗するのを防ぐため必須。

## 6. 事前チェック

```bash
yarn lint
yarn build
yarn test
```

すべてパスすること。`main` の CI が green かも併せて確認する。

```bash
gh run list --branch main --limit 5
```

## 7. リリース内容の提示

現在のバージョンと前回タグからの差分をユーザーに提示する。

```bash
git describe --tags --abbrev=0
git log --oneline $(git describe --tags --abbrev=0)..HEAD
```

`lerna.json` の `version` が現行バージョンの正。`yarn release` は conventional commits からバージョンを自動決定するため、**リリース種別（graduate / alpha / beta / rc）をユーザーに確認する必要はない**。差分は「何が入るか」の確認材料として提示するだけでよい。

## 8. バージョニングと push（ユーザー実行）

`lerna version` は選択・確認のプロンプトを出すインタラクティブコマンドで、Claude Code の `!` 経由では対話できない（プロンプトが表示されても入力できず止まる）。ユーザーに次の手順を依頼する:

1. Claude Code のセッションを終了する（`exit`）
2. ターミナルで直接 `yarn release` を実行し、プロンプトに対話的に回答する
3. 完了したら `claude --continue` で会話に戻る

```
yarn release          # graduate（正式リリース。通常はこれだけで十分）
```

alpha / beta / rc のプレリリースが必要な場合は、ユーザーが会話の中で明示的に指示したときだけ、上記と同じ exit → 実行 → `--continue` の手順で該当コマンドを案内する。

```
yarn release:alpha    # alpha プレリリース
yarn release:beta     # beta プレリリース
yarn release:rc       # RC プレリリース
```

リリーススクリプトは `--no-push` なので、**コミットとタグの push が別途必要**。ユーザーから完了報告を受けたら、次を提示する。

```
! git push origin main --follow-tags
```

実際にタグが push されたことを確認してから次へ進む。

```bash
git ls-remote --tags origin
```

## 9. publish workflow の監視

`v*` タグ push で `publish.yml` が発火する。バックグラウンド実行で完了を待つ。

```bash
gh run watch --exit-status
```

失敗したらログ URL をユーザーに提示し、「12. 失敗時の対処」へ。

## 10. publish 結果の検証

workflow が success でも publish が意図通りとは限らない。**公開した全パッケージについて**実際の npm 上の状態を確認する。

```bash
npm view kamado version
npm view kamado dist-tags
```

確認項目:

- バージョンが手順 8 で上げた値と一致しているか
- **dist-tag が意図通りか**。正式リリースは `latest`、プレリリースは `alpha` / `beta` / `rc` / `next`。`publish.yml` は `lerna.json` の `version` 文字列から判定する（`-alpha` → `alpha`、`-` を含む → `next`、それ以外 → `latest`）
- provenance が付与されているか（`npm view <package> --json` の `dist.attestations`）

可能なら、公開された tarball に 4 プラットフォーム分の `native/<os>-<arch>/kd_napi.node` が入っているかも確認する（`npm pack kamado@<version>` を一時ディレクトリで展開し、`node scripts/check-package-addon.mjs <展開先>/package`）。

**ここが success の判定点**。npm 上の状態を確認するまでリリース完了と判断してはいけない。

## 11. main → dev の同期

publish の成功を確認した後、バージョン更新コミットを `dev` に取り込む。

```bash
git checkout dev
git merge main --no-edit
```

コンフリクトが発生したらユーザーに報告して指示を仰ぐ。マージできたら push をユーザーに依頼する。

```
! git push origin dev
```

`dev` はブランチ保護がかかっており、`maintain` ロールでは直接 push できない場合がある。push が拒否されたら PR 経由に切り替える（`git checkout -b chore/sync-main` してから `/pr` の手順へ）。

## 12. 失敗時の対処

- **sigstore の transient 409**: `gh run rerun --failed` で失敗したジョブだけ再実行する。公開するのは `kamado` の 1 パッケージだけなので、部分 publish は起きない
- **`check` / `addon` / `smoke` の失敗**: 公開には進んでいない。原因を直す。タグが指すコミットに修正が要るときは、タグの付け直しになるので、ユーザーに確認する（`v*` タグの作成・削除は CODEOWNERS のみ）
- **publish の前に確認したいとき**: `gh workflow run publish.yml --ref <branch>` で予行ができる（publish ジョブは動かない）
- **誤ったバージョンを publish した**: unpublish は原則不可。`npm deprecate <package>@<version> "<理由>"` で非推奨化し、修正版を新バージョンとして publish する。この判断は必ずユーザーに確認を取る
- **publish が失敗したまま中断する場合**: 手順 11 の `dev` 同期は行わない。`main` にバージョン更新コミットだけが残るため、次回リリース時にそこから再開する

# 注意

- **`v*` タグの作成・削除は CODEOWNERS のみ**（GitHub Rulesets で保護）。権限がない場合は手順 8 で失敗するため、実行者がタグ権限者か事前に確認する
- **publish は取り消せない**。手順 5・6 の事前チェックを省略しない
- **`.yarnrc.yml` の `npmMinimalAgeGate` を外していないか確認**: 自社パッケージの依存取り込みで一時的に外した場合、復元忘れがあるとサプライチェーン保護が効かなくなる
