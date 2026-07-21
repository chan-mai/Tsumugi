# ADR-0007: at-most-onceのジョブだけclaimを取る

## 状況

Cloudflare Queues自体がat-least-onceなので, reaperの再投入を止めただけではat-most-onceを名乗れない

## 決定

at-most-onceのジョブのみ,実行前にDOへclaimを取りに行く
同一トークンの2回目は拒否される

## 帰結

重複配送が来ても実行は1回に抑えられる
コストを払うのは保証を選んだジョブだけで,既定のat-least-onceはDO往復が増えない
