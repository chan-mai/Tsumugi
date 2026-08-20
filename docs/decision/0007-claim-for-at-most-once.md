# ADR-0007: at-most-onceのジョブだけclaimを取る

## 状況

Cloudflare Queues自体がat-least-onceのため、reaperの再投入を止めただけではat-most-onceを保証できない

## 決定

at-most-onceのジョブのみ、実行前にDOからclaimを取得する
同一トークンの2回目は拒否される

## 帰結

重複配送が来ても実行は1回に制限される
コストを負担するのは保証を選んだジョブだけで、既定のat-least-onceはDO往復が増えない
