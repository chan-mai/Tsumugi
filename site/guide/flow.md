# Flow

複数のジョブを依存関係付きで実行する場合はFlowを定義します
Flowは有向非巡回グラフ(DAG)の定義であり、実行単位はRunです。

## 定義

`createFlow`に`performers`を渡すと、Flowを定義する関数が返ります
binding名とpayloadの型は単発のジョブと同じように検査されます

```ts
import { createFlow, defineTsumugi } from 'tsumugi';

const performers = { LIST: ListNames, GREET: Greet, REPORT: Report };
const flow = createFlow(performers);

const flows = {
  GREETINGS: flow<{ prefix: string }>((f) => {
    const list = f.node('list', 'LIST', {
      input: (i) => ({ prefix: i.prefix }),
    });

    const each = f.fanOut('greet', 'GREET', {
      after: { list },
      over: (_i, d) => d.list.names,
      input: (name) => ({ name }),
    });

    f.node('report', 'REPORT', {
      after: { each },
      input: (_i, d) => ({ total: d.each.total, failed: d.each.failed }),
    });
  }),
};

const tsumugi = defineTsumugi({ performers, flows, auth: /* ... */ });
```

`f.node`の第1引数はノードID、第2引数はbinding、`input`は前段の戻り値からpayloadを組み立てる関数です
`after`に渡したオブジェクトのキーが、`input`の第2引数のプロパティ名になります

依存は変数で指定します。宣言済みのノードしか参照しないので、循環する定義にはなりません

ノードには`maxAttempts`、`backoff`、`timeoutMs`、`priority`、`concurrencyKey`など、投入時と同じオプションの指定が可能です

## 開始

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

`input`の型はFlowの型引数から決まります

`start`の第4引数に`{ id }`を指定するとrunIdが`<flow>:<id>`に固定され、同じIDでの2回目の開始は既存のrunIdを返します
リトライを行うHTTPハンドラから呼び出してもRunは増えません

## fan-out

実行時に件数が決まる並列処理は`f.fanOut`で定義します
`over`が返した配列の要素ごとに子ノードが1つ作成され、子のノードIDには要素の添字が使われます(`greet:0`, `greet:1`)
`key`を指定した場合は添字の代わりにその戻り値を使います

後続のノードが受け取るのは集計値です

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

子ノードごとの戻り値は渡りません。個別の結果が必要な場合は、performerからR2やD1へ書き込み、参照を戻り値としてください

子ノードの失敗は親ノードの失敗として扱いません。後続のノードは`failed`を見て判断します

## perform内からの追加

`ctx.spawn`は、実行中のノードの下に子ノードを追加します

```ts
class Crawl extends Performer<{ url: string }, void, {}, Env> {
  async perform(payload: { url: string }, ctx: JobContext): Promise<void> {
    for (const found of await this.discover(payload.url)) {
      ctx.spawn(found.id, 'CRAWL', { url: found.url });
    }
  }
}
```

第1引数のIDは必須です。同じIDで二度要求しても子ノードは1つだけ作成されます

`spawn`には型検査が適用されません。binding名もpayloadも実行時の値として渡します

`perform`が失敗した場合、その試行で要求した子ノードは作成されません。再実行時に改めて要求してください
service binding越しのリモートperformerには`spawn`が渡されません

## 別のFlowの起動

`f.subflow`は、別のFlowをRunとして起動し、その終端を待ちます

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

第2引数にはFlowの定義そのものを渡します。`input`の型は渡したFlowの型引数から決まります
起動先は`flows`に登録されている必要があります。登録されていない場合は起動時にエラーになります

子のrunIdは`<子のFlow名>:<親のrunIdのローカル部>-<ノードID>`です

子の状態がそのままノードの状態になります。`COMPLETED`、`FAILED`、`CANCELLED`のいずれかです
子の戻り値は受け取りません。結果が必要な場合は、performerからR2やD1へ書き込んでください

親を取り消すと子も取り消されます

入れ子は既定で3段までです。`defineTsumugi`の`runs.maxDepth`で変更可能です

## 待ち合わせ

ノードは、自身と子孫のすべてが終わった時点で完了として扱われます
`after`で親ノードを指定した後続のノードは、fan-outで展開された子ノードと`spawn`で追加された子孫の完了も待ちます

## 失敗時の動作

ノードが失敗した場合、その下流のノードのみが`SKIPPED`になります
依存関係のないノードは最後まで実行され、すべてのノードが終わった時点でRunが`FAILED`になります

`FAILED`のRunはダッシュボードとREST APIから再開可能です
失敗したノードは新しいジョブとして再作成され、`SKIPPED`にした下流は未実行の状態に戻ります
成功済みのノードは再実行しません

## 取り消し

`cancel`は未実行のノードを停止します
実行中のジョブは停止しないので、それらが終わった時点でRunが`CANCELLED`になります

## 制約

- ノードは`uniqueKey`を受け付けません。`uniqueKey`を必須と宣言したperformerをノードに指定すると型エラーになります
- ノードの戻り値が8,192文字を超えた場合、そのノードは失敗になります。大きい結果はR2等へ書き込み、参照を戻り値としてください
- 1つのRunに含められるノード数は既定で10,000件です。`defineTsumugi`の`runs.maxNodes`で変更可能です
- subflowの入れ子は既定で3段までです。`defineTsumugi`の`runs.maxDepth`で変更可能です

## 設定

`flows`を指定する場合、wranglerの設定に2箇所追記します

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

`TsumugiRun`は`defineTsumugi`の戻り値から取り出してエクスポートします

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

読み取りモデルのマイグレーションも適用し直してください

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```

`flows`を指定しない構成では、どちらも不要です

## デプロイと実行中のRun

実行中のRunは開始時の構造のまま進みます
`input`などの関数を修正した場合、次に実行されるノードから反映されます

定義からノードを削除すると、実行中のRunはそのノードで失敗します
構造を変更する場合は、実行中のRunがすべて終わってから削除してください
