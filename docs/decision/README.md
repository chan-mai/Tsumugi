# 設計判断の記録

コード中の`ADR-NNNN`はここを指す
決定を覆す時は該当ファイルを書き換えず,新しいADRを追加して旧ADRから参照する

- [ADR-0001](0001-cloudflare-native-production-grade.md) — 存在理由をCloudflare特化の本番グレードに置く
- [ADR-0002](0002-durable-object-as-coordinator.md) — binding単位のDurable Objectを調停役に据える
- [ADR-0003](0003-do-decides-queues-executes.md) — DOが判断しQueuesが実行する
- [ADR-0004](0004-retry-authority-in-do.md) — Queuesのretryを使わず常に即ackする
- [ADR-0005](0005-job-id-addressing.md) — ジョブIDに`<binding>#<shard>:<localId>`を使う
- [ADR-0006](0006-per-job-delivery-guarantee.md) — 実行保証をジョブ単位で選択可能にする
- [ADR-0007](0007-claim-for-at-most-once.md) — at-most-onceのジョブだけclaimを取る
- [ADR-0008](0008-outbox-projection-to-d1.md) — 全状態をアウトボックス経由でD1へバッチ投影する
- [ADR-0009](0009-three-axis-throttling.md) — 流量制御を3軸(同時実行数/レート/concurrencyKey)持つ
- [ADR-0010](0010-keys-required-by-type.md) — キーはenqueue時に明示指定し型で必須化する
- [ADR-0011](0011-default-single-shard.md) — 既定shard数を1にし分割は明示的オプトインにする
- [ADR-0012](0012-seven-state-machine.md) — 状態を7つにしQUEUEDを分離する
- [ADR-0013](0013-fail-closed-auth.md) — 認証をfail-closedにする
- [ADR-0014](0014-dag-in-product-vision.md) — DAGを製品ビジョンに含める
- [ADR-0015](0015-run-do-for-dag-v2.md) — DAGはRun DOとして分離しv2で実装する
- [ADR-0016](0016-metrics-in-analytics-engine.md) — 明細はD1,時系列はAnalytics Engineに置く
- [ADR-0017](0017-cli-deferred.md) — 専用CLIを作る方針だがv0.1では後回しにする
- [ADR-0018](0018-pure-scheduler-function.md) — 判断ロジックを純粋関数に分離しDOを薄い殻にする
- [ADR-0019](0019-numeric-priority.md) — 数値優先度をv1から持つ
- [ADR-0020](0020-aging-enabled-by-default.md) — エージングを既定で有効にする
- [ADR-0021](0021-unique-key-returns-existing-id.md) — uniqueKeyの衝突時は既存のジョブIDを返す
- [ADR-0022](0022-dedupe-in-do-not-kv.md) — 重複排除にKVを使わずDO内のテーブルで行う
- [ADR-0023](0023-single-npm-package-subpaths.md) — npmには`tsumugi`を1つだけ公開しサブパスで分ける
- [ADR-0024](0024-ctx-exports-self-reference.md) — `ctx.exports`による自己参照を前提にする
- [ADR-0025](0025-dashboard-inlined-html.md) — ダッシュボードは単一HTML文字列として`tsumugi/ui`から提供する
