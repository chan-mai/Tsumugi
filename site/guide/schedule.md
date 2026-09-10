# 定期実行

一定の間隔や決まった時刻にジョブやRunを起動する場合は`schedules`を定義します。

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

キーがスケジュールの名前です。使用できる文字は英数字/ハイフン/アンダースコアに限定され、64文字を上限としています。

`binding`を指定するとジョブを投入し、`flow`を指定するとRunを開始します。
`payload`と`input`の型は、単発のジョブやRunの開始と同じように`performers`と`flows`から決定されます。

`payload`と`input`には関数も指定できます。引数の`scheduledAt`は発火の予定時刻です。

```ts
{ binding: 'Sync', payload: ({ scheduledAt }) => ({ since: scheduledAt - 60_000 }), everyMs: 60_000 }
```

ジョブの場合は`maxAttempts`、`backoff`、`timeoutMs`、`priority`、`concurrencyKey`など投入時と同じオプションを指定できます。
Runの場合は`deadlineMs`を指定できます。

## 間隔

`everyMs`か`cron`のどちらか一方が必須です。

`everyMs`はミリ秒の固定間隔で、1000以上の整数です。
最初の発火は登録した時刻から1間隔後で、以降は最初の予定を基準に進みます。

`cron`は5つのフィールド(分 時 日 月 曜日)です。保証される精度は分です。

```text
0 3 * * *     毎日3:00
*/15 * * * *  15分ごと
0 0 1 * *     毎月1日の0:00
0 9 * * 1-5   月曜から金曜の9:00
```

使用できる記法は数値、`*`、`,`、`-`、`/`です。`JAN`や`MON`のような名前は使用できません。
日と曜日の両方を指定した場合は、どちらかが一致する日に発火します。

`timeZone`にはIANAタイムゾーンを指定します。省略時は`UTC`として扱われ、`+09:00`のような固定オフセット識別子は指定できません。

```ts
{ binding: 'OpenShop', payload: {}, cron: '0 9 * * 1-5', timeZone: 'Asia/Tokyo' }
```

`timeZone`は`cron`だけに指定できます。`everyMs`はUTCインスタント間の固定間隔であり、タイムゾーンによる補正はありません。
存在しないローカル時刻は発火しません。DST終了で同じローカル時刻が2回存在する場合は、最初のUTC時刻だけで発火します。
最初の時刻より後に次回を計算する場合、同じローカル時刻の2回目ではなく次のローカル候補へ進みます。

## 前回が終わっていない場合

`overlap`で、前回の発火が終わっていない時刻に次回が来た場合の扱いを指定できます。

| 値          | 動作                             |
| ----------- | -------------------------------- |
| `'skip'`    | その回を発火しません。既定値です |
| `'overlap'` | 前回の状態に関わらず発火します   |

```ts
{ binding: 'Crawl', payload: {}, everyMs: 60_000, overlap: 'overlap' }
```

`'skip'`の場合、前回のジョブが`SCHEDULED` `QUEUED` `RUNNING`のいずれかであれば発火しません。
Runの場合は`RUNNING`であれば発火しません。発火しなかった回数は一覧に表示されます。

## 遅延と未発火

負荷やデプロイの影響で、発火が予定より遅れることがあります。

複数の周期にまたがって遅れた場合、最も古い未発火の予定を1回だけ発火し、残りは発火しません。
次回の予定は現在時刻から見た次の境界になるため、間隔の位相は保証されます。

時刻にはスケジュールのIANAタイムゾーンと、その時点のGMTオフセットが表示されます。

## 重複

発火するジョブのIDとrunIdは、スケジュール名と予定時刻から決定されます。
同じ予定が二度発火した場合、2回目は既存のジョブとRunを返すため、重複して実行されることはありません。

このため`uniqueKey`は指定できません。予約が残っている間の発火が、すべて最初の1件と同じジョブになるためです。
`delayMs`と`runAt`も指定できません。

## 失敗

`payload`と`input`の関数で例外が発生した場合と、投入とRunの開始に失敗した場合、その回は発火しません。
理由を記録して次回の予定へ進みます。同じ回を再試行することはありません。

1つのスケジュールの失敗が他のスケジュールの発火を止めることはありません。

## 一覧

定義したスケジュールはダッシュボードの`schedules`タブと`GET /api/schedules`で確認することができます。
次回の実行時刻、直近の発火、発火しなかった回数、失敗の理由、一時停止の状態が表示されます。

![スケジュールの一覧](/dashboard-schedules.jpg)

## 一時停止と再開

スケジュール単位で定期の発火を一時停止することが可能です。
ダッシュボードの`schedules`タブの操作、あるいは`POST /api/schedules/:name/pause`と`POST /api/schedules/:name/resume`を使用します。

一時停止中のスケジュールは発火しません。停止中に経過した回は再開時にすべて破棄され、次回は再開時点から次の境界になります。
停止前の発火で投入済みのジョブには影響しません。

bindingの`paused`とは独立です。bindingの一時停止は同じbindingへ投入される単発のジョブも停止しますが、スケジュールの一時停止はそのスケジュールの発火だけを対象として停止します。

## 手動発火

`POST /api/schedules/:name/trigger`とダッシュボードの`schedules`タブで、任意の時点で1回だけ単発で発火させることができます。

一時停止中であっても可能で、`overlap`の判定は行いません。次回の定期の発火時刻への影響はありません。
`payload`と`input`の関数が受け取る`scheduledAt`は手動発火の時刻です。
発火するジョブのIDは`<binding>#<shard>:<ローカルID>`、runIdは`<Flow名>:<ローカルID>`、ローカルIDは`<スケジュール名>-<発火時刻>-<連番>-manual`の形式です。定期の発火のIDとは重複しません。

## 起動

定期実行が始まるのは、デプロイ後にWorkerがリクエスト、キューの配送、cronトリガーのいずれかを最初に受け取った時点であり、それ以降は外部からの呼び出しがなくても発火します。

デプロイして定義を変更した場合、変更は次回の発火から反映されます。
外部からのアクセスが無い構成では、一覧の保持のために設定するcronトリガーが起点になります。

## 設定

`schedules`を指定する場合、wranglerの設定に2箇所追記します。

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

`TsumugiScheduler`は`defineTsumugi`の戻り値から取り出してエクスポートします。

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiScheduler extends tsumugi.schedulerClass {}
```

`schedules`を指定しない構成では、どちらも不要です。

## 制約

- 名前は英数字とハイフンとアンダースコアの64文字までです
- `everyMs`は1000以上の整数です
- `cron`は分精度で、秒と年のフィールドはありません
- `timeZone`はIANAタイムゾーンで、`cron`にだけ指定できます。既定は`UTC`です
- 定義の誤りは`defineTsumugi`の呼び出し時に例外になります
