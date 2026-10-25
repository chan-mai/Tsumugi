---
title: 定期実行
publishedAt: 2026-07-22
updatedAt: 2026-10-25
---

# 定期実行

`schedules`に定義したジョブとFlowを、Tsumugiは一定間隔で、またはcron式で指定した時刻に実行します。

## 定義

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules: {
    'poll-inbox': { binding: 'PollInbox', payload: {}, everyMs: 5 * 60 * 1000 },
    nightly: {
      flow: 'REPORT',
      input: ({ scheduledAt }) => ({ until: scheduledAt }),
      cron: '0 9 * * *',
      timeZone: 'Asia/Tokyo',
    },
  },
  auth: /* ... */,
});
```

スケジュールの名前は、キーで指定します。
使用できる文字は英数字、ハイフン、アンダースコアで、長さは64文字以内です。
`binding`を指定するとジョブを投入し、`flow`を指定するとRunを開始します。
どちらか一方を指定してください。
`payload`と`input`の型は、単独のジョブの投入やRunの開始と同様に、`performers`と`flows`から導出されます。
shard数が2以上のbindingを対象にする場合は、`partitionKey`も必須です。

`payload`と`input`は、値の代わりに関数も受け付けます。
関数を指定した場合は、実行のたびに呼び出され、戻り値が使われます。
引数の`scheduledAt`は、その回の実行予定時刻です。

```ts
{ binding: 'Sync', payload: ({ scheduledAt }) => ({ since: scheduledAt - 60_000 }), everyMs: 60_000 }
```

ジョブを投入するスケジュールの定義には、`maxAttempts`, `backoff`, `timeoutMs`, `priority`, `concurrencyKey`などのオプションを任意で指定します。
Runを開始するスケジュールの定義には、`deadlineMs`を任意で指定します。
スケジュールの定義では、`uniqueKey`, `delayMs`, `runAt`を使用できません。

定義に誤りがあると、`defineTsumugi`の呼び出し時に例外が発生します。
名前の規則に反する場合や、`binding`と`flow`の両方が指定されている、またはどちらも指定されていない場合が該当します。
対象のbindingのshard数が2以上で`partitionKey`を省略した場合や、使用できないオプションを指定した場合も、同様に例外が発生します。

## 実行間隔

`everyMs`と`cron`は、どちらか一方を指定してください。
両方を指定した場合、またはどちらも指定しない場合、定義エラーが発生します。

### everyMs

`everyMs`には、1000以上の整数(ミリ秒)を指定してください。
1000未満の値を指定した場合、定義エラーが発生します。
最初の実行は、スケジュールの登録から1間隔後に行われます。
その後は、最初の予定時刻に1間隔ずつ加算した時刻に実行されます。

### cron

`cron`は、分、時、日、月、曜日の5フィールドで指定します。
精度は分単位で、秒と年のフィールドは含みません。

```text
0 3 * * *     毎日3:00
*/15 * * * *  15分ごと
0 0 1 * *     毎月1日の0:00
0 9 * * 1-5   月曜から金曜の9:00
```

使える記法は、数値, `*`, `,`, `-`, `/`です。
`JAN`や`MON`のような名前は使用できません。
2月31日のように実行機会のない式を指定すると、定義エラーが発生します。
日と曜日を両方指定した場合は、一方が一致すれば実行されます。
`*/2`など`*`で始まる日や曜日は、未指定として扱われます。
この場合、日と曜日が両方一致する日に実行されます。

### timeZone

`timeZone`にIANAタイムゾーンを指定すると、`cron`の解釈にそのタイムゾーンが適用されます。
省略した場合、`UTC`が使用されます。
`+09:00`のような固定オフセットの指定は、定義エラーを引き起こします。

```ts
{ binding: 'OpenShop', payload: {}, cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' }
```

`timeZone`は、`cron`と組み合わせて使用してください。
`everyMs`と同時に指定すると、定義エラーが発生します。
`everyMs`は時刻の差で計算されるため、タイムゾーンの影響を受けません。

夏時間の切り替えで存在しなくなったローカル時刻の回は、実行されません。
同じローカル時刻が2回ある場合は、1回目に限って実行されます。

## 前回の実行が終了していない場合

`overlap`は、前回の実行が完了する前に次回の予定時刻となった場合の動作を指定します。
値は`'skip'`または`'overlap'`のいずれかで、既定値は`'skip'`です。
これら以外の値を設定した場合、定義エラーが発生します。

| 値 | 動作 |
| --- | --- |
| `'skip'` | その回の実行を省略。既定値 |
| `'overlap'` | 前回の状態にかかわらない実行 |

前回のジョブが`SCHEDULED`, `QUEUED`, `RUNNING`のいずれかの状態である場合、その実行は未終了とみなされます。
Runの場合、前回のRunが`RUNNING`であれば未終了です。
実行されなかった回数は、ダッシュボードの一覧に表示されます。

```ts
{ binding: 'Crawl', payload: {}, everyMs: 60_000, overlap: 'overlap' }
```

## 実行の遅れ

負荷やデプロイの影響で、実行が予定時刻より遅れる可能性があります。
遅れが複数の間隔にまたがる場合、最も古い予定の回が1回実行され、残りの回は実行されません。
次の予定時刻は、現在時刻より後の最初の予定時刻です。
遅れた後も、予定時刻は最初の予定時刻に間隔を加算した時刻のままです。

## 重複実行の防止

同じ予定時刻の回が重複して実行されることはありません。
2回目の実行では、新しいジョブやRunは作成されず、既存のジョブまたはRunのIDが再利用されます。

スケジュールの定義で`uniqueKey`を使用できないのは、この仕組みのためです。
指定すると、重複を判定する期間内のすべての回が、最初の1件と同じジョブとして扱われます。

## 失敗

`payload`または`input`の関数で例外が発生した回は、実行されません。
ジョブの投入やRunの開始に失敗した回も、同様に実行されません。
失敗の理由は記録され、その回は再試行されません。
ほかのスケジュールの実行には、影響しません。

## 一覧

ダッシュボードの`schedules`タブに、定義したスケジュールの一覧が表示されます。
同じ一覧は、`GET /api/schedules`で取得します。
次の予定時刻, 前回の実行, 実行されなかった回数, 失敗の理由, 一時停止の状態が含まれます。

![スケジュールの一覧](/dashboard-schedules.jpg)

時刻は、スケジュールに設定されたIANAタイムゾーンと、その時点のGMTオフセットとともに表示されます。

## 一時停止と再開

ダッシュボードの`schedules`タブ、または`POST /api/schedules/:name/pause`と`POST /api/schedules/:name/resume`で、スケジュールごとに定期実行の一時停止と再開を制御します。
一時停止中は、そのスケジュールの実行が抑制されます。
停止中に予定時刻が経過した回は、再開後に実行されません。
再開後の最初の実行は、再開時点より後に来る最初の予定時刻です。
停止前に投入されたジョブの実行には、影響がありません。

スケジュールの一時停止は、bindingの`paused`とは別の設定です。
bindingを一時停止すると、そのbindingへ投入されるすべてのジョブの実行が停止します。
スケジュールの一時停止が止めるのは、そのスケジュールの実行です。

## 手動実行

ダッシュボードの`schedules`タブの「今すぐ実行」と、`POST /api/schedules/:name/trigger`で、スケジュールを任意の時点で1回実行します。
一時停止中のスケジュールも対象です。
`overlap`は判定されず、次の定期の実行時刻も変わりません。
`payload`と`input`の関数が受け取る`scheduledAt`は、手動実行した時刻です。

## 開始条件

定期実行は、デプロイ後にWorkerがHTTPリクエスト、キューのメッセージ、cronトリガーのいずれかを初めて受信した時点で開始します。
その後は、外部からの呼び出しがなくても実行されます。
外部からのアクセスがない構成では、一覧の保持期間のために設定したcronトリガーがその役割を果たします。
定義を変更してデプロイした場合、変更は次の回から反映されます。

## 設定

`schedules`を指定する場合は、wranglerの設定に次の2箇所を追記してください。
指定しない場合は、これらの設定は不要です。

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "JOB_SHARD", "class_name": "TsumugiJobShard" },
      { "name": "SCHEDULER", "class_name": "TsumugiScheduler" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["TsumugiJobShard"] },
    { "tag": "v3", "new_sqlite_classes": ["TsumugiScheduler"] },
  ],
}
```

`TsumugiScheduler`は、`defineTsumugi`の戻り値の`schedulerClass`を継承してexportしてください。
クラス名は、wranglerの設定と一致させます。

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiScheduler extends tsumugi.schedulerClass {}
```
