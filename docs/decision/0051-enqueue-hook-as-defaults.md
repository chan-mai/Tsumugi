# ADR-0051: 投入時のフックは既定値の付与として持つ

## 状況

投入時に共通の値を付与する仕組みが無く、`enqueue`の呼び出し側が毎回指定している(#96)

## 決定

`onEnqueue: (input) => EnqueueDefaults | undefined`として持ち、意味は既定値の付与に限定する
呼び出し側が明示した値が常に優先され、フックは未指定のキーだけを補完する
上書きを可能にすると、Run DOが確保したIDやflow定義のオプションをフックが変更できてしまう

付与できるのは実行オプション(traceparent, priority, maxAttempts, backoff, timeoutMs, guarantee, delayMs, runAt, expiresAt, expiresInMs, concurrencyKey)のみ
宛先と識別子(binding, payload, id, runId, nodeId, partitionKey, uniqueKey, uniqueForMs)は対象外とし、列挙に無いキーは実行時にも無視する
排他のオプションの組(delayMs / runAt, expiresAt / expiresInMs)は片方が決まればもう片方の既定値を破棄する

適用は`createClient`の中で行い、worker / Run DO / Scheduler DOの3経路すべてへ同じフックを配る
Run DOとScheduler DOのクラスは`defineTsumugi`のクロージャ内で生成されるため、関数をそのまま渡せる(ADR-0030 / ADR-0040)
適用は宛先の解決とtraceparentの検証より前に行う, フックが付与した値も同じ検証の対象とする

## 帰結

関数のため設定の配送(ADR-0043)には乗らず、コードを持つ経路だけに適用される
Job DO自身が投入する通知ジョブ(onFailure / onSettled)には適用されない
別Workerからの投入は利用者が自分の`createClient`に同じフックを渡す
