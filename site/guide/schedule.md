# 定期実行

一定の間隔や決まった時刻にジョブやRunを起動する場合は`schedules`を定義します

## 定義

```ts
const tsumugi = defineTsumugi({
  performers,
  flows,
  schedules: {
    'poll-inbox': { binding: 'PollInbox', payload: {}, everyMs: 5 * 60 * 1000 },
    nightly: { flow: 'REPORT', input: ({ scheduledAt }) => ({ until: scheduledAt }), cron: '0 3 * * *' },
  },
  auth: /* ... */,
});
```

キーがスケジュールの名前です。使用できる文字は英数字とハイフンとアンダースコアで、64文字までです

`binding`を指定するとジョブを投入し、`flow`を指定するとRunを開始します
`payload`と`input`の型は、単発のジョブやRunの開始と同じように`performers`と`flows`から決まります

`payload`と`input`には関数も指定できます。引数の`scheduledAt`は発火の予定時刻です

```ts
{ binding: 'Sync', payload: ({ scheduledAt }) => ({ since: scheduledAt - 60_000 }), everyMs: 60_000 }
```

ジョブの場合は`maxAttempts`、`backoff`、`timeoutMs`、`priority`、`concurrencyKey`など投入時と同じオプションを指定できます
Runの場合は`deadlineMs`を指定できます

## 間隔

`everyMs`か`cron`のどちらか一方が必須です。両方の指定と、どちらも無い指定はエラーになります

`everyMs`はミリ秒の固定間隔で、1000以上の整数です
最初の発火は登録した時刻から1間隔後で、以降は最初の予定を基準に進みます

`cron`は5つのフィールド(分 時 日 月 曜日)です。時刻はUTCで、精度は分です

```text
0 3 * * *     毎日3:00
*/15 * * * *  15分ごと
0 0 1 * *     毎月1日の0:00
0 9 * * 1-5   月曜から金曜の9:00
```

使用できる記法は数値、`*`、`,`、`-`、`/`です。`JAN`や`MON`のような名前は使用できません
日と曜日の両方を指定した場合は、どちらかが一致する日に発火します

## 前回が終わっていない場合

`overlap`で、前回の発火が終わっていない時刻に次回が来た場合の扱いを選びます

| 値          | 動作                                             |
| ----------- | ------------------------------------------------ |
| `'skip'`    | その回を発火しません。既定値です                 |
| `'overlap'` | 前回の状態に関わらず発火します                   |

```ts
{ binding: 'Crawl', payload: {}, everyMs: 60_000, overlap: 'overlap' }
```

`'skip'`の場合、前回のジョブが`SCHEDULED` `QUEUED` `RUNNING`のいずれかであれば飛ばします
Runの場合は`RUNNING`であれば飛ばします。飛ばした回数は一覧に出ます

## 遅延と取り逃し

発火はDurable Objectのalarmで行われるため、負荷やデプロイの影響で予定より遅れることがあります

遅れて複数の周期を跨いだ場合、最も古い未発火の予定を1回だけ発火し、残りは飛ばします
次回の予定は現在時刻から見た次の境界になり、間隔の位相は保たれます

一覧には予定時刻と実際に発火した時刻の両方が出るため、遅れの大きさが分かります

## 重複

発火するジョブのIDとrunIdは、スケジュール名と予定時刻から決まります
同じ予定が二度発火した場合、2回目は既存のジョブとRunを返すため、重複して実行されることはありません

このため`uniqueKey`は指定できません。予約が残っている間の発火が最初の1件に吸収されてしまうためです
`delayMs`と`runAt`も指定できません

## 失敗

`payload`と`input`の関数が例外を投げた場合と、投入とRunの開始に失敗した場合、その回は発火しません
理由を記録して次回の予定へ進みます。同じ回を粘って再試行することはありません

1つのスケジュールの失敗が他のスケジュールの発火を止めることはありません

## 一覧

定義したスケジュールはダッシュボードの`schedules`タブと`GET /api/schedules`で確認できます
次回の実行時刻、直近の発火、飛ばした回数、失敗の理由が出ます

## 起動

Durable Objectのalarmは一度設定されると自走しますが、最初の1回は外部からの呼び出しが必要です
Workerがリクエスト、キューの配送、cronトリガーのいずれかを受け取った時点で、定義がScheduler Durable Objectへ同期されます

デプロイして定義を変更した場合も、次のalarmの発火時に自動で追随します
外部からのアクセスが無い構成では、読み取りモデルの保持のために設定するcronトリガーが起点になります

## 設定

`schedules`を指定する場合、wranglerの設定に2箇所追記します

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

`TsumugiScheduler`は`defineTsumugi`の戻り値から取り出してエクスポートします

```ts
export { TsumugiJobShard } from 'tsumugi';
export class TsumugiScheduler extends tsumugi.schedulerClass {}
```

`schedules`を指定しない構成では、どちらも不要です

## 制約

- 名前は英数字とハイフンとアンダースコアの64文字までです
- `everyMs`は1000以上の整数です
- `cron`はUTCの分精度で、秒と年のフィールドはありません
- 定義の誤りは`defineTsumugi`の呼び出し時に例外になります
- 手動での発火と一時停止の手段はありません
