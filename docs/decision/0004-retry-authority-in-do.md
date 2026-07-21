# ADR-0004: Queuesのretryを使わず常に即ackする

## 状況

Queuesのretry機構に乗ると`maxRetries`が`wrangler.jsonc`の`max_retries`に縛られ,製品仕様がインフラ設定に漏れる

## 決定

consumerはperformerの例外を捕まえてDOに報告し必ずackする
リトライ回数/バックオフ/ジッタは全てDOのalarmが持つ

## 帰結

`max_retries`と`delaySeconds`の上限が製品仕様に漏れなくなる
Queuesが担うのは配送保証ではなく実行のスケーリングとDOの解放
