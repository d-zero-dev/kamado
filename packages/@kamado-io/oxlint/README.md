# @kamado-io/oxlint

[kamado](https://github.com/d-zero-dev/kamado)の TSX（`kamado/jsx`）に向けた、oxlint の規則。

kamado は、ページを 1 回だけ HTML に描画して、JavaScript を送らない。そのため React で書けても意味を持たない書き方がある。hooks は動かず、関数の`onClick`は HTML から消え、`async`のコンポーネントは待たれない。それらを lint でエラーにする。kamado 本体はビルドで検査しないので、hooks のように実行時に落ちるものも、`onClick`のように黙って消えるものも、ここで見つける。規則は oxlint と ESLint が共有する API で書いてあり、どちらでも動く。

## 使い方

```sh
yarn add -D @kamado-io/oxlint oxlint
```

`oxlint` 1.77.0 以上が要る（それより古い版は確かめていない）。`eslint`は、ESLint で使うときと、型の宣言を TypeScript から読むときだけ要る（9 以上）。

プラグインを読み込んで、規則を有効にする。`.oxlintrc.json`に書くなら、次のようになる。oxlint の既定の規則（`correctness`）も、そのまま有効になる。

```json
{
	"jsPlugins": ["@kamado-io/oxlint"],
	"rules": {
		"@kamado-io/no-async-component": "error",
		"@kamado-io/no-client-directive": "error",
		"@kamado-io/no-function-event-handler": "error",
		"@kamado-io/no-ignored-props": "error",
		"@kamado-io/no-module-state": "error",
		"@kamado-io/no-react-runtime": "error",
		"@kamado-io/no-untracked-input": "error"
	},
	"overrides": [
		{
			"files": ["data/**"],
			"rules": {
				"@kamado-io/no-async-component": "off",
				"@kamado-io/no-untracked-input": "off"
			}
		}
	]
}
```

TypeScript の設定ファイル（`oxlint.config.mts`）も、同じキーで書ける。

```ts
// oxlint.config.mts
export default {
	jsPlugins: ['@kamado-io/oxlint'],
	rules: {
		'@kamado-io/no-async-component': 'error',
		// …
	},
};
```

規則の名前は`@kamado-io/<規則>`。

**どのファイルに当てるか**は、設定の`files`で決める。ページとレイアウト、それらが import するコンポーネント（`.tsx`）が基本で、コンポーネントから import する`.ts`にも当てるとよい。`data.dir`のファイルには、`no-untracked-input`と`no-async-component`を外す。データのファイル（`.ts`等）は、ページより前に動いて、読み込み・`fetch`・環境変数・時刻・乱数・待つ処理を書けるため。

## 規則

報告のメッセージは英語で出る（oxlint と ESLint の出力に合わせている）。

| 規則                                   | 止めるもの                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 直し方                                                                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `@kamado-io/no-react-runtime`          | `react`と`react-dom`（`react/jsx-runtime`などの下も）の値の`import`、`export … from`、`require()`、`import()`、`import x = require()`。`import type`と、型だけの`import { type X }`・`export { type X } from`は許可する                                                                                                                                                                                                                                                                                                  | 消す。型は`import type`で読む。fragment は`<>…</>`で書く                                                                                   |
| `@kamado-io/no-function-event-handler` | HTML の要素（小文字のタグ。`<my-button>`も含む）の`on*`属性に、文字列と分からない値を渡すこと（関数、名前、呼び出し、`a ?? b`など）。文字列（リテラル、テンプレート、`'a(' + id + ')'`）、`undefined`、`null`、`false`と、両枝がそうである三項は許可する。コンポーネント（`<List onRender={fn} />`）の props は対象外                                                                                                                                                                                                    | 消す。文字列（`onClick="go()"`）は`<html static>`の中でだけ属性として出る                                                                  |
| `@kamado-io/no-client-directive`       | `'use client'`と`'use server'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 消す。kamado のコンポーネントは、すべて 1 回だけ描画される                                                                                 |
| `@kamado-io/no-ignored-props`          | HTML の要素の`ref`、`suppressHydrationWarning`、`suppressContentEditableWarning`                                                                                                                                                                                                                                                                                                                                                                                                                                         | 消す。クライアントのコードが無いので、何も起きない                                                                                         |
| `@kamado-io/no-async-component`        | JSX を返す`async`の関数と、default export にした`async`の関数（`export default async function`のほか、`export default Page;`と`export { Page as default }`で名前を渡す形も）                                                                                                                                                                                                                                                                                                                                             | `async`を外して、データは描画の前に`data.dir`へ置く                                                                                        |
| `@kamado-io/no-module-state`           | 関数の中から、そのファイルで宣言した変数（`let`・`const`・関数・クラス）を書き換えること。代入（分割代入と`for…of`の左辺も）、`++`、`delete`、`o.a = 1`、変更メソッド（`push`・`set`・`add`・`sort`・`delete`・`clear`など。名前で判定する）、`Object.assign(o, …)`と`Reflect.set(o, …)`。TypeScript の`as`・`!`・`?.`で包んでいても見つける                                                                                                                                                                             | 値を関数の中で持つか、props から計算する。ページ間で使い回す結果は`kamado/jsx`の`memo`で持つ。ページは並列に描画されるので、順序に依存する |
| `@kamado-io/no-untracked-input`        | `fs`・`node:fs`・`fs/promises`・`node:fs/promises`・`fs-extra`の読み込み。`http`・`https`（`node:`付きも）・`axios`・`undici`の import。`child_process`の import。`fetch`（呼び出しも、`urls.map(fetch)`のような参照も、`globalThis.fetch`と`const { fetch } = globalThis`も）と`XMLHttpRequest`。モジュールのトップレベルの`await`（`for await`も）。`process.env`、引数なしの`new Date()`と`Date.now()`、`Math.random()`。`import`・`export … from`・`require()`・`import()`・`import x = require()`のどれでも見つける | 必要なデータを`data.dir`のデータファイル（`.ts`）で読んで、props から受け取る。差分ビルドが変更を見つける                                  |

`no-module-state`は、モジュールの読み込みで実行されるものを許す。トップレベルの文、すぐに呼ぶ関数（`(() => { … })()`）、トップレベルの`forEach`・`map`などのコールバックである（`ITEMS.forEach((i) => { byId[i] = i; })`で表を作る書き方）。それ以外の関数の中は、いつ呼ばれても報告する。`register(() => { n++; })`のように渡した関数は、あとで描画から呼ばれるかもしれないからである。

`no-module-state`が import した値を見るのは、書き換えだと分かるものだけである（`config.a = 1`、`delete config.a`、`Object.assign(config, …)`）。`items.sort()`のようなメソッドは、ライブラリの関数（`_.set(o, 'a', 1)`）と区別できないので報告しない。

## 見つからないもの

規則はソースを読むだけで、実行しない。型も持たない。次は見つけられない。

- props の展開で渡る関数（`<button {...rest}>`の`rest.onClick`）
- JSX を変数に入れてから返す`async`の関数（`const el = <b />; return el;`）、`memo(async () => …)`のような包み、default export でない名前で渡す`async`の関数
- モジュールの外の変数や、`globalThis`への書き込み
- import した値のメソッドによる書き換え（`items.sort()`）
- ここに挙げたもの以外のライブラリによる読み込みと通信（`got`、`node-fetch`、`graceful-fs`、`node:net`、`node:dns`など）、環境変数、日時、乱数

次は、確実でないときに報告する（誤検出がありうる）。

- `onClick={handler}`のように、文字列かもしれない名前。文字列なら、リテラルをその場に書く
- 変更メソッドと同じ名前のメソッドを持つ別の値（`const d = dayjs(); d.add(1, 'day')`）。ファイルで宣言した変数のメソッドは、名前だけで書き込みと見なす
- `on`で始まる属性は、すべてイベントとして扱う（React と、kamado のランタイムの判定と同じ）

## ESLint で使う

同じプラグインを、ESLint の flat config でも読める。

```js
import kamado from '@kamado-io/oxlint';

export default [
	{
		files: ['**/*.tsx'],
		plugins: { '@kamado-io': kamado },
		rules: { '@kamado-io/no-react-runtime': 'error' },
	},
];
```

## ライセンス

MIT
