# DAG(flowとrun)

複数のジョブを依存関係付きで実行する場合はflowを定義します
flowは静的なグラフの定義であり、それを1回実行した単位がrunです

## 定義

`createFlow`にperformerの登録簿を渡すと、flowを定義するための関数が返ります
binding名とpayloadの型はこの登録簿から決まるため、単発のジョブと同じ型検査が適用されます

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

依存は変数参照で指定するため、宣言前のノードは参照できません
循環する定義を記述できないので、実行時の循環検査は不要です

## 開始

```ts
const runId = await tsumugi.start(env, 'GREETINGS', { prefix: 'hello' });
```

`input`の型はflowの型引数から決まります
`start`の第4引数に`{ id }`を指定するとrunIdが`<flow>:<id>`に固定され、同じIDでの2回目の開始は既存のrunIdを返します
リトライを行うHTTPハンドラから呼び出してもrunは増えません

## fan-out

実行時に件数が決まる並列処理は`f.fanOut`で定義します
`over`が返した配列の要素ごとに子ノードが1つ作成され、子のノードIDには要素の添字が使われます(`greet:0`, `greet:1`)
`key`を指定した場合は添字の代わりにその戻り値を使います

後続のノードが受け取るのは集計値のみです

```ts
{ total: 3, succeeded: 2, failed: 1 }
```

子ノードごとの戻り値は渡しません
展開数は最大10,000件まで増えるため、全件を後続のpayloadに含める形式では上限が定まらないという理由です
個別の結果が必要な場合は、performerからR2やD1へ書き込み、参照のみを戻り値としてください

子ノードの失敗は親ノードの失敗として扱いません。後続のノードは集計値の`failed`を見て判断します

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

第1引数のIDは必須です
at-least-onceでは`perform`が再実行されるため、同じIDの再要求を既存の子ノードとして扱うことで重複作成を防いでいます

`spawn`にはfan-outと異なり型検査が適用されません。binding名もpayloadも実行時の値として渡します

追加の要求は`perform`の完了報告に同梱して送られます
失敗した試行の要求は破棄され、再実行時に改めて要求されます
service binding越しのリモートperformerでは使用できません

## 待ち合わせ

ノードは、自身と子孫のすべてが終端状態に達した時点で完了として扱われます
`after`で親ノードを指定した後続のノードは、fan-outで展開された子ノードと`spawn`で追加された子孫の完了も待ちます

## 失敗時の動作

ノードが失敗した場合、その下流のノードのみが`SKIPPED`になります
依存関係のないノードは最後まで実行され、すべてのノードが終端状態に達した時点でrunが`FAILED`になります

`FAILED`のrunはダッシュボードとREST APIから再開できます
失敗したノードは新しいジョブとして再作成され、`SKIPPED`にした下流は未実行の状態に戻ります
成功済みのノードは再実行しません

## 取り消し

`cancel`は未実行のノードを停止し、実行中のジョブが終端状態に達するのを待ちます
Queuesへ投入済みのジョブは取り消せないため、取り消せない場合に成功を返すことはありません

## 制約

- ノードでは`uniqueKey`を指定できません。runIdとnodeIdの組が一意性を担保しているためで、`uniqueKey`を必須と宣言したperformerはノードに使用できません
- ノードの戻り値が8,192文字を超えた場合、そのノードは失敗になります。後続のpayloadの材料が欠落した状態で成功を返さないための動作です
- 1つのrunに含められるノード数は既定で10,000件です。`defineTsumugi`の`runs.maxNodes`で変更できます

## 設定

`flows`を指定する場合はRun DOが必要です。wranglerの設定に2箇所追記します

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

Run DOのクラスはflow定義を参照するため、パッケージから直接エクスポートできません
`defineTsumugi`の戻り値から取得してエクスポートします

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiRun extends tsumugi.runClass {}
```

読み取りモデルのマイグレーションも追加されているため、適用し直してください

```bash
pnpm wrangler d1 migrations apply my-jobs --remote
```

`flows`を指定しない構成では、Run DOのエクスポートもbindingも不要です

## デプロイと実行中のrun

Run DOが保存するのはノードIDと依存関係のみで、`input`の変換関数はコードから参照します
デプロイによってflowの構造が変わっても、実行中のrunは開始時の構造のまま進行し、関数の修正は次に実行されるノードから反映されます

定義からノードを削除した場合、実行中のrunはそのノードで失敗します
構造を変更する場合は、実行中のrunがすべて終了してから削除してください
