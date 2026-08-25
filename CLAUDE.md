# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 概要

kamado — オンデマンド静的サイトジェネレータ。Lerna + Yarn Workspaces のモノレポ構成で、コア（`kamado`）と各種コンパイラ（`@kamado-io/*-compiler`）を提供する（fixed バージョンモード）。

## プロジェクト構成

作業前に以下のファイルを確認し、プロジェクトの状態を把握すること:

- `package.json` — scripts、devDependencies、Volta（Node 24 / Yarn 4）
- `lerna.json` — fixed バージョンモード、`packages/*`, `packages/@kamado-io/*`
- `README.md` — リポジトリ概要
- `tsconfig.json` — TypeScript 設定
- 各パッケージの構成は `packages/kamado/package.json` および `packages/@kamado-io/*/package.json` を参照

## コマンド

- `yarn build` — 全パッケージビルド（`lerna run build`）
- `yarn dev` — `lerna run dev`
- `yarn test` — Vitest でテスト（test-timeout 60000）
- `yarn lint` — eslint / prettier / textlint / cspell を直列実行
- `yarn bench` — ビルドベンチマーク（`--pages=N` / `--runs=N` / `--full` / `--incremental`。要事前 `yarn build`。詳細は `packages/kamado/ARCHITECTURE.md` 参照）
- `yarn release` / `yarn release:alpha` 等 — `lerna version`（push なし）。リリース手順は `.claude/skills/npm-publish/SKILL.md` 参照

### コマンド制約

- **yarn のみ使用**: npm / pnpm / bun / deno によるコマンド実行は禁止
- **パッケージディレクトリに cd しない**: 常にリポジトリルートから実行
- **ビルドは `yarn build` のみ**: `npx tsc`、`lerna run build --scope` 等の個別指定は禁止
- **コマンドの連続実行禁止**: `&&`、`;`、改行によるコマンド連結をしない。1回の Bash 呼び出しで1コマンドのみ実行する。連結されたコマンドは settings.json の permissions allow/deny でパターンマッチできず、毎回ユーザーの手動承認が必要になり効率が大幅に低下する

## パッケージ依存関係

- `kamado`（コア） ← `@kamado-io/page-compiler` / `script-compiler` / `style-compiler`
- `kamado` + `@kamado-io/page-compiler` ← `@kamado-io/pug-compiler` / `jsx-compiler`

## 依存関係の追加

- バージョンは固定で追加する（`yarn add foo@1.2.3`）。`^` / `~` を付けない（`.yarnrc.yml` の `defaultSemverRangePrefix: ''` で既定化されている）
- **追加したら `.github/renovate.json` の `packageRules` を確認する**。そのパッケージが既存の `groupName` グループに入るべきか、新しいグループを作るべきかを判断する
  - `config:recommended` は `group:monorepos` を含むため、同一 monorepo から公開されるパッケージ群は設定なしで自動的に束ねられる。手で書く必要はない
  - 手当てが必要なのは Renovate が推測できない**ベンダー横断の結合**:
    - 本体と型定義のペア（`debug` + `@types/debug`）。DefinitelyTyped は別リポジトリで公開されるため自動グループ化されない
    - peer dependency で結ばれた別ベンダーのパッケージ（`hono` + `@hono/node-server`）
    - `resolutions` で固定しているパッケージとその利用側
    - 自前の `@d-zero/*` パッケージ群（configs と runtime で分ける）
    - `typescript` + `@d-zero/tsconfig`
  - 判断基準は「**片方だけバージョンが上がった状態でビルドと型チェックが通るか**」。通らないなら同じ `groupName` にまとめる
- グループ化を怠ると、Renovate が個別に PR を作り、片方だけマージされた中間状態で CI が赤になる。結果として**両方の PR がマージできなくなる**
- グルーピングの現状は `git branch -r --list 'origin/renovate/*'` で確認できる。`*-monorepo` サフィックスのブランチは `group:monorepos` による自動グループ

## ドキュメント原則

情報は置き場で役割が決まる。**コードには How、テストコードには What、コミットログには Why、コードコメントには Why not**（Why が必要なときは Why も書く）。

- **JSDoc = 公開 API（export）の API ユーザー向け文書**: IDE ホバーで実装を読まない読者に届くため、WHAT / HOW / WHY を適切に書き、`@example` を必須とする
- **非公開 API の JSDoc は必須にしない**: ただし複雑な内部モジュールの設計 WHY / Why not はファイルレベル JSDoc が推奨置き場
- **計画相対概念の禁止**: 実装計画に由来する相対概念（Phase/Step 番号、「本 PR」「今回」「旧実装」「導入予定」）を JSDoc・テスト名・ドキュメントに書かない。現在の挙動と意図的な不在（Why not）として自己完結に書く。外部参照は issue / PR 番号のみ可
- **ドキュメントと実装の矛盾**: 実装が正としてドキュメントを直す

## セキュリティ

### 機密情報の取り扱い

- `.env`、`.env.*` 等の機密ファイルを読み取り・編集・コミットしない（機密ファイルの判断は `.gitignore` を参考にすること）
- コミット前に `git diff --staged` で機密情報（API キー、トークン、パスワード、企業名、顧客情報）が含まれていないか確認する
- **サンプル値は予約済み慣例に従う**: ドメインは `example.com` / `*.example` / `*.test` 等（RFC 2606/6761）、IP は TEST-NET。実在の無関係ドメイン、未取得の創作ドメイン、案件識別子、実データ・実コーパスの断片を成果物に残さない（詳細は `.claude/skills/git/SKILL.md` のサンプル値慣例チェック）
- 環境変数やシークレットをコード内にハードコードしない

### サプライチェーン保護

- **yarn dlx は完全禁止**: ローカルパッケージを使わずリモートから直接実行するため、サプライチェーン攻撃に脆弱
- **npx は原則使わない**: package.json の scripts で定義されたコマンドを `yarn <script>` で実行すること
- 新しい依存パッケージの追加は慎重に。既存の依存で解決できないか先に確認する
- `yarn add` する前にパッケージの信頼性（ダウンロード数、メンテナンス状況、既知の脆弱性）を確認する
- `yarn add` する場合はバージョンを固定する（例: `yarn add foo@1.2.3`）
- lockfile（yarn.lock）の手動編集は禁止

## スキル

タスクに応じて `.claude/skills/` 配下のスキルを参照すること。

| スキル          | パス                                      | 用途                                                            |
| --------------- | ----------------------------------------- | --------------------------------------------------------------- |
| Product Manager | `.claude/skills/product-manager/SKILL.md` | リポジトリ分析、ドキュメント整合チェック、PR レビュー           |
| QA Engineer     | `.claude/skills/qa-engineer/SKILL.md`     | コードレビュー、テスト品質チェック、カバレッジ改善              |
| Impl            | `.claude/skills/impl/SKILL.md`            | 合意済み計画の実装・検証・PR 作成までのオーケストレーション     |
| Grill me        | `.claude/skills/grill-me/SKILL.md`        | 計画・設計の前提を掘り下げて合意形成する                        |
| Git             | `.claude/skills/git/SKILL.md`             | コミット規約・コミット前コンテンツチェック                      |
| PR              | `.claude/skills/pr/SKILL.md`              | PR 作成フロー（base 追従・push はユーザー実行・CI 監視）        |
| npm publish     | `.claude/skills/npm-publish/SKILL.md`     | リリース（dev→main マージ・バージョニング・publish 監視・検証） |
