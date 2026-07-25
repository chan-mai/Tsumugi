# ADR-0033: runのノードでuniqueKeyを受け付けない

## 状況

uniqueKeyが衝突すると既存のジョブIDが返る(ADR-0021)
その既存ジョブの`run_id`は先行するrun宛であるため,後発のrunには完了通知が届かず進行しなくなる

## 決定

run内のノードではuniqueKeyを受け付けず,型検査で不可とする

## 帰結

runIdとnodeIdの組が一意性を担保しているため,重複排除が二重にならない
uniqueKeyを必須と宣言したperformerはDAGのノードに使用できない
1つのジョブを複数のrunが待つ構成が必要になった場合は, Job DOに待機表を追加してこの決定を覆す
