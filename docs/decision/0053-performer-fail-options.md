# ADR-0053:失敗した試行の再試行の扱いをperformerが`ctx.fail`で指定する

## 状況

再試行の可否と間隔は投入時の`maxAttempts`と`backoff`のみで決まり、performer側から変更できない
バリデーション不正や404のように再試行しても結果が変わらない失敗も`maxAttempts`まで試行され、同時実行数を消費する
外部APIが429と`Retry-After`を返した場合も、指定された時刻ではなく`backoff`の間隔で再試行される

例外クラスで表す方法は、別Workerのperformerで使えない
RPCで例外を受け取ると、例外クラスの同一性と独自のプロパティが失われる
`perform`の戻り値で表す方法は、結果の値と失敗を示す値が同じ型に混在する

## 決定

`JobContext`に`fail(options: { retry: false } | { retryAt: number }): void | Promise<void>`を追加する
`spawn`(ADR-0032)と同じく、consumerが指定を保持し、失敗の報告に同梱してDOへ送る
関数はRPCのstubとして渡されるため、同一Workerと別Workerのperformerで同じ形で使える(ADR-0037)
別Workerでは`await`が必要とする

指定はthrowで終えた試行にのみ適用し、正常に終了した試行は完了として扱う
複数回の呼び出しは最後の指定を有効とする
形式が不正な値は`fail`の呼び出しで例外とする

`{ retry: false }`は試行回数の残りに関わらず`FAILED`へ遷移させる
区別のための状態は追加せず、7状態の状態遷移(ADR-0012)を維持する
失敗の通知(ADR-0043)と手動リトライは`maxAttempts`を使い切った`FAILED`と同じ扱いとする

`{ retryAt }`はその試行に限り`backoff`の計算に代えて次回の実行時刻とする
試行回数は通常の失敗と同じく数え、`maxAttempts`に達していれば`FAILED`とする
期限(ADR-0047)を越える場合は`CANCELLED`とし、過去の時刻は現在時刻に丸める

## 帰結

再試行しても結果が変わらない失敗を1回の試行で`FAILED`にでき、同時実行数の消費を減らし、終端までの時間を短縮できる
`Retry-After`のような外部から指定された時刻に合わせて再試行できる
恒久的な失敗と試行回数を使い切った失敗は状態では区別できず、試行履歴の例外の本文で判別する
別Workerのperformerで`await`せずにthrowすると、指定が反映されない場合がある
