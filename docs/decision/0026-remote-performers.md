# ADR-0026: performerをservice binding越しに置けるようにする

## 状況

登録簿はperformerのクラスを直接持っており,performerは必ずジョブ管理Workerと同一のWorkerに同居する必要があった

同居の強制により次が成立しない

- performerの依存(重いSDK等)をジョブ管理Worker本体から切り離す
- performerだけを別のデプロイ単位・別のチームで運用する
- ランタイム設定の違うWorkerにジョブを配る

## 決定

登録簿の値にクラスの代わりに`remote('SERVICE_BINDING')`を置けるようにする

consumerは印を見てコンストラクタ呼び出しとRPC呼び出しを切り替える
リモート側は`RemotePerformer`(`WorkerEntrypoint`の派生)を継承して`perform`を生やす

## 帰結

performerの配置がジョブ管理Workerの構成から独立する

**`signal`はリモートに渡らない**

RPCの引数が`AbortSignal`非対応のため,リモートが受け取る文脈は`RemoteJobContext`(`JobContext`から`signal`を除いたもの)になる
タイムアウトは呼び出し側の待機打ち切りとしてのみ効き,リモート側の処理は走り続ける
ローカルでも`signal`は協調的な依頼で処理を実際には止められないため(ADR-0006),差は中断を依頼できるか否かに留まる
中断が要る処理はローカルに置く

service binding未設定は例外にする
握り潰すとジョブが黙って失敗し続け,原因が設定漏れだと分からなくなる
