# ADR-0004: Queuesのretryを使わず常に即ackする

## 状況

Queuesのretry機構を使うと`maxRetries`が`wrangler.jsonc`の`max_retries`に制約され、製品仕様がインフラ設定に現れる

## 決定

consumerはperformerの例外を捕捉してDOに報告し必ずackする
リトライ回数/バックオフ/ジッタは全てDOのalarmが持つ

## 帰結

`max_retries`と`delaySeconds`の上限が製品仕様に現れなくなる
Queuesが担うのは配送保証ではなく実行のスケーリングとDOの解放
