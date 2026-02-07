---
name: monorepo-architect-skill
description: 'Node.jsモノレポ環境でのメンテナンス、機能追加、コード設計を統括します。プロジェクト固有の厳格なアーキテクチャ・ルールを遵守させたい時に使用します。'
---

# **Monorepo Architect Skill**

このスキルは、プロフェッショナルなNode.jsモノレポ開発において、プロジェクトの整合性と保守性を極限まで高めるための思考プロトコルです。

## **1. Command Constraints (Strictly Yarn)**

AIエージェントは、以下のコマンド制約を例外なく守らなければなりません。

- **Use yarn ONLY**: パッケージのインストール、ビルド、スクリプト実行には必ず yarn を使用してください。npm の使用はあらゆる状況で**厳禁**です。
- **No cd**: 作業ディレクトリを移動（cd）しないでください。常にルートディレクトリを起点とし、`yarn workspace <package-name> <command>` または `--cwd` フラグを使用して操作を完結させてください。
- **Targeted Operations**: ビルドや検証は、常に影響を受けるパッケージに限定して行います（例: `yarn build --scope <package-name>`）。
- **Testing**: ユニットテストの実行には `npx vitest run` を使用してください。

## **2. Directory & Structure Rules**

- **One Function per File**: 原則として、1つのファイルには1つのエクスポート関数のみを記述します。
- **No index.ts**: `index.ts`ファイルの使用は禁止です。各モジュールには、モジュール名に基づいた具体的なエントリファイル（例: `compiler/compiler.ts`、`config/config.ts`）を使用し、再エクスポートを行います。外部パッケージはパッケージ固有の名前のエントリファイル（例: `page-compiler.ts`、`script-compiler.ts`）を使用します。
- **Type Segregation**: 処理やモデルのカテゴリごとにフォルダを分けて管理することを推奨します。その際、各フォルダ内に必ず types.ts を作成し、関連する型定義をそこに集約してください。

## **3. TypeScript Coding Standards**

### **Function Signature**

すべての関数は、以下の標準的な引数パターンに従って定義されなければなりません：

```ts
/**
 * @param context - 必須の依存関係やコンテキスト（Required）
 * @param options - 任意の設定やパラメータ（Partial）
 */
export function functionName(
	context: Required<ContextType>,
	options?: Partial<OptionsType>,
): Promise<ReturnType>;
```

#### **例外ケース**

以下の場合は、context+optionsパターンを**適用しない**でください：

1. **すべてのパラメータがoptionalな場合**

   ```ts
   // ❌ 悪い例: 空のcontextを強制
   export function createPageCompiler(
   	context: {}, // 中身がない！
   	options?: PageCompilerOptions,
   );

   // ✅ 良い例: 単一のoptionalパラメータ
   export function createPageCompiler(options?: PageCompilerOptions);
   ```

2. **公開API関数（特にbuilder/factory functions）**
   - ユーザー向けの公開API関数は、利便性を優先
   - 内部API関数のみcontext+optionsパターンを適用
   - 例: `createPageCompiler()`, `createScriptCompiler()` などのビルダー関数

3. **シンプルな関数（1-2個の必須パラメータのみ）**

   ```ts
   // ✅ 良い例: そのまま維持
   export function compile(template: string, data?: object): string;

   // ❌ 悪い例: 過度に冗長化
   export function compile(
   	context: { template: string },
   	options?: { data?: object },
   ): string;
   ```

**適用の判断基準**:

- 必須パラメータが2個以上ある → context+optionsパターンを適用
- すべてoptional → 適用しない
- 公開API → 適用しない（内部APIのみ）

### **Type Definitions**

- **Interface Over Type**: 型定義には、拡張性と一貫性の観点から type ステートメントではなく、可能な限り interface 宣言を使用してください。
- **Strict Exports**: package.json の exports フィールドを直接編集し、外部に公開するAPI（各 /src/dir/sub.ts など）を厳選して定義してください。一括公開は避けてください。

## **4. Workflow Examples**

### **❌ Bad Workflow**

- npm install を叩く。
- `packages/pkg/src/index.ts` を作成して複数の関数をエクスポートする。
- 関数に3つ以上の独立した引数を定義する。

### **✅ Good Workflow**

1. ルートからパッケージ構造を把握（`ls -R`）。
2. `packages/core/src/billing/calculate-tax.ts` を作成。
3. 同ディレクトリの `types.ts` に interface で型を定義。
4. モジュール用のエントリファイル `packages/core/src/billing/billing.ts` を作成し、再エクスポートを記述。
5. `packages/core/package.json` の exports に `"./billing": "./dist/billing/billing.js"` を追記。
6. `yarn workspace @repo/core build` でビルド確認。

## **5. Operational Protocol for AI**

1. **Scan Before Action**: 修正を開始する前に、必ず `ls -R` や `cat package.json` を行い、リポジトリの依存関係と `exports` の現状を完全に把握してください。
2. **Preserve Exports**: `package.json` の `exports` を更新する際は、既存の定義を削除したり壊したりしないよう、差分のみを正確に追記してください。
3. **Architecture Guard**: あなたの提案が「1関数1ファイル」や「`index.ts`使用禁止（代わりにモジュール名ベースのエントリファイルを使用）」に違反していないか、常にセルフチェックを行ってください。
