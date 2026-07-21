# ADR-0010:キーはenqueue時に明示指定し型で必須化する

## 状況

DOとperformerは別isolateなので,キー導出のユーザー関数をDO内で実行できない

## 決定

呼び出し側がconcurrencyKey/uniqueKeyを文字列として渡す
performerの型で必須と宣言でき,渡し忘れはコンパイルエラーになる

## 帰結

ランタイムのDSLを作らず型システムに解かせる
DOは不透明なキーとして扱うだけで済み追加RPCもレイテンシも発生しない
