# ADR-0023: npmには`tsumugi`を1つだけ公開しサブパスで分ける

## 状況

モノレポで複数パッケージを公開する案もあった

## 決定

公開するのは`tsumugi`のみ
`tsumugi/performer` `tsumugi/client` `tsumugi/ui` `tsumugi/types` `tsumugi/testing`のサブパスで分ける

## 帰結

利用者は1つ入れるだけで済みバージョン整合の問題が起きない
サブパス分割によりperformerだけのWorkerがDO実装をバンドルせずに済む
