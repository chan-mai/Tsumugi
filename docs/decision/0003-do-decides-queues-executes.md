# ADR-0003: DOが判断しQueuesが実行する

## 状況

DOがperformerを直接awaitする案もあったが, DOの課金はwall-clock durationベース

## 決定

DOはスケジューリングの判断のみを行い,実行はCloudflare Queuesに委譲する

## 帰結

10分かかるジョブの間ずっとDOのリクエストが生存して課金される事態を避けられる
DOは投入した瞬間に手を離せる
