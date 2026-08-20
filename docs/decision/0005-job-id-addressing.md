# ADR-0005:ジョブIDに`<binding>#<shard>:<localId>`を使う

## 状況

ジョブがbinding単位DOに分散して保存されるため、IDからどのDOに在るかを知る必要がある

## 決定

IDにbindingとshardを埋め込む
DO名は`<binding>#<shard>`

## 帰結

IDからDO stubをO(1)で解決できるためグローバル索引が不要
逆にshard数を後から変えると既存IDの解決先が変わるため旧shardを残す必要がある
