# ADR-0052: 実行中のジョブの取り消しは協調的な要求として扱う

## 状況

`cancel()`が受け付けるのはSCHEDULEDのみで、実行中のジョブを止める手段がbindingの`paused`しかない(#95)
`paused`は投入を止めるだけで、既に実行中のものには作用しない
performerはRPC越しに実行され`AbortSignal`を渡せないため(ADR-0037)、外部からの強制停止は原理的に不可能

## 決定

QUEUED / RUNNINGへの`cancel()`は遷移させず、取り消しの要求として`cancel_requested_at`列に記録する
戻り値は`{ ok: true, requested: true }`として即時のCANCELLEDと区別し、重複した要求は冪等に受理する
SCHEDULEDへの`cancel()`は従来どおり即時CANCELLEDとする

performerは取り消し要求の有無を`heartbeat`の戻り値(`{ cancelRequested }`)から取得する
`deadlineAt`と同じ協調的な中断であり、応じるかは実装依存とする
中断に応じる場合はthrowで終え、失敗報告はリトライせずCANCELLEDへ確定する
成功報告はCOMPLETEDのまま残す
要求が間に合わなかっただけで処理は完了しており、結果を破棄する理由が無い
報告が受理されない状態(回収済みや終端)もconsumerは`cancelRequested: true`の扱いとし、この試行の継続に意味が無いことを示す

応答が無いまま要求から`reaperGraceMs`が経過したら、tickがCANCELLEDへ確定する
取り消しは明示的な意思で手動の判断を待つ理由が無く、STALLEDにはしない(期限切れADR-0047と同じ帰結)
実行自体は停止できず継続し得るが、遅れた報告は終端の行へ適用されず破棄される

要求はreap等の遷移の後も残り、SCHEDULEDへ戻った場合も投入せずCANCELLEDへ確定する
手動リトライ(FAILED / STALLEDから)だけが要求をクリアする
クリアしないと再投入の直後に取り消しが確定する
要求済みのジョブはrunAfterの後ろ倒しで確定が遅延するため、`reschedule`を拒否する
at-most-onceの`claim`は要求済みなら実行権を付与せずCANCELLEDへ遷移する

Run DOの取り消しは投入済みのノードへ同じ要求を送り、ノードはジョブの終端通知で確定する
runの期限超過による中断でも、要求後の終端がCANCELLEDの場合はノードへ理由付きFAILED(ADR-0039)ではなくCANCELLEDが記録される

## 帰結

期限切れ(ADR-0047)との区別は`cancel_requested_at`列から可能になり、`expires_at`だけに依存しない
`heartbeat`を実行しないperformerは要求を取得できないが、その場合も要求から`reaperGraceMs`で確定する
consumerの送信間隔に下限(5秒)があるため、performerが要求を観測するまで数秒の遅延がある
