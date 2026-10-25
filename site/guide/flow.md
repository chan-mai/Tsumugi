---
title: Flow
description: 依存関係を持つ複数のジョブを有向非巡回グラフ(DAG)で定義するFlowの定義, fan-out, 条件分岐, 失敗時の動作について
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# Flow

Flowは、依存関係を持つ複数のジョブを有向非巡回グラフ(DAG)で定義する仕組みです。
Runは、Flowを1回実行した単位です。

## 定義

`createFlow`は、`performers`を受け取り、Flowを定義する関数を戻り値とします。
binding名とpayloadの型は、単独のジョブと同様に型検査されます。

```ts
import { createFlow, defineTsumugi } from 'tsumugi';

const performers = { ListNames, Greet, Report };
const flow = createFlow(performers);

const flows = {
  GREETINGS: flow<{ prefix: string }>((f) => {
    const list = f.node('list', 'ListNames', {
      input: (i) => ({ prefix: i.prefix }),
    });

    const each = f.fanOut('greet', 'Greet', {
      after: { list },
      over: (_i, d) => d.list.names,
      input: (name) => ({ name }),
    });

    f.node('report', 'Report', {
      after: { each },
      input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
    });
  }),
};

const tsumugi = defineTsumugi({ performers, flows, auth: /* ... */ });
```

`f.node`の第1引数にはノードIDを、第2引数にはbinding名を指定します。
binding名は、[exportした名前](/guide/performer#binding名)と一致させてください。
ノードIDは、英数字、ハイフン、アンダースコアで構成します。

`input`には、Flowの入力と前段の戻り値からpayloadを生成する関数を指定します。
第2引数は、`after`に渡したオブジェクトのキーをプロパティ名とするオブジェクトです。
ノードの定義には、ジョブの投入時と同じオプション(`maxAttempts`, `backoff`, `timeoutMs`, `priority`, `concurrencyKey`など)を任意で指定します。

## 開始

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

`input`の型は、Flowの型引数から導出されます。
`start`の第4引数に`{ id }`を渡すと、runIdは`<flow>:<id>`に固定されます。
同じIDで2回目に開始した場合は、新しいRunが作成されず、既存のrunIdが戻り値です。
リトライされるHTTPハンドラから呼んでも、Runは重複しません。
第4引数の`{ deadlineMs }`が、Run全体の[期限](#期限)です。

## fan-out

配列の要素数に応じた並列処理は、`f.fanOut`で定義します。
`over`の戻り値の要素ごとに、子ノードが1つずつ作成されます。
子ノードのIDは、要素の添字です。たとえば`greet:0`, `greet:1`となります。
`key`を渡した場合は、`key`の戻り値が添字の代わりに使われます。
使える文字は、ノードIDと同様です。

後続のノードが受け取るのは、次の形式の集計値です。

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

子ノードごとの戻り値は、後続のノードに渡されません。
個別の結果が必要な場合は、performerがR2やD1などに書き込み、その参照を戻り値にしてください。
子ノードが失敗しても、fan-outのノード自体は失敗しません。
失敗の有無は、後続のノードが受け取る`failed`の値で判断します。

## perform内からのノード追加

`ctx.spawn`を呼ぶと、実行中のノードに子ノードが追加されます。

```ts
class Crawl extends Performer<{ url: string }, void, {}, Env> {
  async perform(payload: { url: string }, ctx: JobContext): Promise<void> {
    for (const found of await this.discover(payload.url)) {
      ctx.spawn(found.id, 'CRAWL', { url: found.url });
    }
  }
}
```

第1引数のIDは必須です。
子ノードのIDは`<親のノードID>:<指定したID>`で構成され、使用できる文字はノードIDと同一です。
同一のIDで複数回呼び出しても、子ノードは重複して作成されません。
`perform`が失敗した試行で追加された子ノードは、作成されません。
再実行時の`perform`で、改めて追加してください。

`spawn`には、型検査が適用されません。
binding名とpayloadは、実行時の値として渡します。
別Workerのperformerから呼ぶ場合は、[`await`が必要](/guide/performer#別workerに配置した場合の制約)です。

## subflow

`f.subflow`は、別のFlowをRunとして開始します。
ノードは、そのRunが終了した時点で完了します。

```ts
const REPORTING = flow<{ ids: string[] }>((f) => {
  // ...
});

const PIPELINE = flow<{ prefix: string }>((f) => {
  const list = f.node('list', 'LIST', { input: (i) => ({ prefix: i.prefix }) });
  const reported = f.subflow('report', REPORTING, { input: (_i, d) => ({ ids: d.list.ids }) });
  f.node('notify', 'NOTIFY', { after: { reported }, input: () => ({}) });
});
```

第2引数には、Flowの定義そのものを渡します。
`input`の型は、渡したFlowの型引数から導出されます。
開始するFlowは、`flows`に登録してください。
未登録の場合は、開始時にエラーが発生します。

子のRunのrunIdは、`<子のFlow名>:<親のrunIdのローカル部>-<ノードID>`です。
子のRunの状態が、そのままノードの状態として反映されます。
状態は、`COMPLETED`, `FAILED`, `CANCELLED`のいずれかです。
親のRunを取り消すと、子のRunも取り消されます。

親のノードは、子のRunの戻り値を受け取りません。
結果が必要なら、performerがR2やD1などに書き込みます。
入れ子の上限は、[制約](#制約)を参照してください。

## 待ち合わせ

ノードは、自身と子孫のノードがすべて終了した時点で完了します。
`after`で指定したノードに依存する後続のノードは、fan-outの子ノードと`spawn`で追加された子孫のノードが終了した後に実行されます。

## 実行条件

既定では、依存するノードがすべて成功したときに限り、ノードが実行されます。
`trigger`は、依存するノードが失敗した場合の挙動を指定します。

| 値 | 実行される条件 |
| --- | --- |
| `'success'` | 依存するノードがすべて成功。既定値 |
| `'failure'` | 依存するノードのうち1つ以上が`FAILED`, `STALLED`, `CANCELLED`のいずれか |
| `'always'` | 依存するノードがすべて終了。成否は不問 |

```ts
const flows = {
  BACKUP: flow<{ target: string }>((f) => {
    const dump = f.node('dump', 'DUMP', { input: (i) => ({ target: i.target }) });

    // 失敗時のみ実行
    f.node('alert', 'ALERT', {
      after: { dump },
      trigger: 'failure',
      input: (i) => ({ message: `backup failed: ${i.target}` }),
    });

    // 成否によらず実行
    f.node('unlock', 'UNLOCK', { after: { dump }, trigger: 'always', input: (i) => ({ target: i.target }) });
  }),
};
```

`after`のないノードに`trigger`を指定すると、エラーが発生します。
`'failure'`の条件に数えるのは、実際に失敗したノードに限られます。
`trigger`や`when`の条件を満たさず`SKIPPED`になったノードは、失敗に数えません。
依存するノードがすべて`SKIPPED`の場合、`'failure'`のノードは実行されません。

`'failure'`と`'always'`では、失敗したノードの戻り値がありません。
`input`の第2引数の型は`undefined`を含むため、値がない場合の処理を記述してください。

```ts
f.node('alert', 'ALERT', {
  after: { dump },
  trigger: 'always',
  // d.dumpはundefinedの可能性あり
  input: (_i, d) => ({ size: d.dump?.size ?? 0 }),
});
```

## 条件分岐

`when`は、Flowの入力や前段の結果に基づき、ノードの実行可否を決定します。
`when`が`false`を返した場合、そのノードは`SKIPPED`に遷移し、依存する後続のノードも実行されません。
`when`内で例外が発生したときは、ノードは`FAILED`に遷移します。

```ts
f.node('detail', 'DETAIL', {
  after: { list },
  when: (i, d) => i.verbose && d.list.items.length > 0,
  input: (_i, d) => ({ items: d.list.items }),
});
```

`when`と`input`の評価では、引数の値のみを使用し、外部への問い合わせは行わないでください。

## 失敗時の動作

ノードが失敗した場合、`'success'`で依存する後続のノードは`SKIPPED`へ遷移します。
`trigger`が`'failure'`または`'always'`の後続のノードは、実行されます。
失敗したノードに依存しないノードは、最後まで実行されます。
すべてのノードが終了すると、Runは`FAILED`へ遷移します。

Runが`FAILED`になるのは、失敗したノードがある場合に限られます。
`trigger`や`when`の条件で実行されなかったノードは、失敗に数えません。
`trigger: 'failure'`のノードが成功しても、前段のノードが失敗していれば、Runは`FAILED`で終了します。
`SKIPPED`になった理由は、ノードの`error`に記録され、ダッシュボードのRunの詳細に表示されます。

`FAILED`のRunは、ダッシュボードまたはREST APIで再開します。
成功したノードの結果はそのまま使われ、それ以外のノードは未実行として改めて実行されます。

## 取り消し

Runを取り消すと、未実行のノードは開始されません。
実行中のノードには、[取り消しの要求](/guide/execution#実行中の取り消し)が送信されます。
実行中のジョブは停止されません。
performerが要求を確認して終了するか、要求から`reaperGraceMs`(既定30秒)が過ぎても結果が報告されないと、Runは`CANCELLED`へ遷移します。

## 期限

Run全体の期限は、Flowの定義の第2引数で指定します。

```ts
const GREETINGS = flow<{ prefix: string }>(
  (f) => {
    // ...
  },
  { deadlineMs: 10 * 60 * 1000 },
);
```

`deadlineMs`は、正の整数(ミリ秒)で指定します。
`start`の第4引数に`{ deadlineMs }`を渡した場合は、その値が優先されます。

期限を過ぎたRunは、取り消しと同じ手順で中断されます。
未実行のノードは、`run deadline exceeded`のエラーにより`FAILED`へ遷移します。
実行中のジョブは停止されず、そのジョブが終了した時点でRunは`FAILED`へ遷移します。
実行中の子のRunは、取り消されます。

期限までに終了しなかったRunは、残りのノードがすべて成功しても`FAILED`へ遷移します。
このRunは、通常の失敗と同様に再開の対象です。
再開した場合、期限は再開した時点から改めて計測されます。

## 保持期間

終了したRunは、`runs.sweepAfterMs`(既定5分)の経過後に削除されます。
`FAILED`のRunは、`runs.failedRetentionMs`(既定7日)の経過後に削除されます。
詳細は[RunSettings](/reference/config#runsettings)を参照してください。

## デプロイと実行中のRun

実行中のRunは、開始時点のノード構成で継続されます。
`input`などの関数を変更しても、反映は次に開始されるノードからです。

定義からノードを削除すると、そのノードを含む実行中のRunは、そのノードで失敗します。
ノードを削除する場合は、実行中のすべてのRunが終了してからデプロイします。

## テスト

`simulateFlow`は、指定された入力に対するノードの実行順序と、各ノードに渡されるpayloadを検証します。
performerの実際の処理は実行されません。

```ts
import { simulateFlow } from 'tsumugi/testing';

const result = simulateFlow(flows.GREETINGS, { prefix: 'hello' }, { results: { list: { names: ['a', 'b'] } } });

expect(result.nodes.map((node) => node.id)).toEqual(['list', 'greet:0', 'greet:1', 'greet', 'report']);
expect(result.nodes[1].payload).toEqual({ name: 'a' });
```

各ノードの戻り値は、`results`にノードIDをキーとして渡します。
値は、戻り値そのものと、戻り値を作る関数のどちらも受け付けます。
渡さなかったノードの戻り値は、`undefined`です。
`fails`に渡したノードは失敗し、後続のノードは`SKIPPED`へ遷移します。
Runは`FAILED`へ遷移します。
fan-outの子ノードは`over`の戻り値から作成されますが、`ctx.spawn`で追加される子ノードは含まれません。

## 制約

ノードでは`uniqueKey`を使用できません。
`uniqueKey`を必須にしたperformerをノードに指定すると、型エラーが発生します。

ノードの戻り値が8,192文字を超える場合、または直列化できない場合、その試行は失敗として扱われます。
失敗後は、`maxAttempts`まで再試行が行われます。
大きな結果はR2などに書き込み、その参照を戻り値にしてください。

1つのRunに含められるノード数は、既定で10,000件です。
subflowの入れ子は、既定で3段です。
上限は、`defineTsumugi`の`runs.maxNodes`と`runs.maxDepth`で変更します。

## 設定

`flows`を指定する場合は、wranglerの設定に次の2箇所を追記してください。
指定しない場合は、これらの設定は不要です。

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "JOB_SHARD", "class_name": "TsumugiJobShard" },
      { "name": "RUN", "class_name": "TsumugiRun" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] },
    { "tag": "v2", "new_sqlite_classes": ["TsumugiRun"] },
  ],
}
```

`TsumugiRun`は、`defineTsumugi`の戻り値に含まれる`runClass`を継承してexportしてください。
D1のマイグレーションは、再度適用が必要です。

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```
