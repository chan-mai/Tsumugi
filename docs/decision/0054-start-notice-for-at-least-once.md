# ADR-0054: at-least-onceのジョブも実行開始時にRUNNINGへ遷移させる

## 状況

ADR-0007によりclaimを取るのはat-most-onceのジョブのみで、at-least-onceのジョブは実行中もQUEUEDのまま表示される(#121)
heartbeatの進捗は増えるが状態はQUEUEDのままで、未開始と実行中を区別できない
実行保証によって実行中の表示が異なり、ADR-0012でQUEUEDを分離した目的を満たさない

## 決定

consumerはat-least-onceのジョブの実行前に、Job DOの`start`で実行開始を通知する
`start`はQUEUEDのジョブをRUNNINGへ遷移させる
claimと異なり実行権を排他的に取得する処理ではなく、遷移しなかった場合もperformerを実行する
重複配送の2回目や、reap後に届いた前試行の通知は、状態とattemptが一致しないため遷移させない

consumerは`start`の応答を待たずにperformerを実行する
heartbeat, log, 完了報告は`start`の完了後に送信する
`start`の遷移はheartbeatの記録を初期化するため、先に届いたheartbeatの進捗を消さない順序とする
`start`の失敗はログのみで、実行と完了報告は継続する

## 帰結

実行保証によらず、実行中のジョブはRUNNINGと表示される
at-least-onceのジョブもJob DOへのRPC呼び出し, Job DOのSQLiteへの書き込み, D1への投影が1回ずつ増える
応答を待たないため、at-least-onceのジョブの実行開始までの時間は増えない
`start`が失敗したジョブは、完了までQUEUEDのまま表示される
