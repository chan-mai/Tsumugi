# ADR-0049:投入候補の読み取り範囲を到来順にする

## 状況

tickは実行可能なジョブ(`SCHEDULED`且つ`run_after <= now`)を`ORDER BY created_at, id LIMIT 200`で読み、投入候補としていた(#4)
索引は`job_active (state, run_after)`のみで並び順を解決できず、SQLiteは条件に合う全行を読んで整列した後にLIMITを適用する

```
SEARCH job USING INDEX job_active (state=? AND run_after<?)
USE TEMP B-TREE FOR ORDER BY
```

tick1回あたりの読み取り行数は滞留件数に比例する
tickは投入, 完了報告, トークン補充ごとに発生するため、N件の滞留を`rate`や`concurrency`で処理し終えるまでの読み取り行数はおよそN²/2になる
約11,000件の一括投入で、1回あたり1億〜1.3億行の読み取りを計測した(#104)
Durable Objectsの読み取り行数の課金に直接影響する

`(state, created_at, id)`の索引を追加すれば作成順を維持できるが、先に作成された未到来のジョブ(遅延投入やバックオフ待ち)をtickごとに読み飛ばす
未到来のジョブが多い場合、読み取り行数が件数に比例する状態が残る

## 決定

投入候補の読み取り範囲を`ORDER BY run_after, id`とし、索引を`job_due (state, run_after, id)`へ置き換える
並び順を索引で解決し、読み取り行数をlimit程度にする

範囲内の投入順は変更しない
スケジューラは従来通り実効優先度(ADR-0020), 作成順, IDの順で整列する

既存のDOは`applySchema`で`job_due`を作成し`job_active`を削除する
`job_due`は`job_active`の列を先頭に含み、`job_active`を使っていたクエリを代替する

sweepの次回時刻も終端ジョブ全件からMINを求めており、同じ傾向にあった
`job_terminal (state, updated_at)`を追加し、状態ごとのMINへ分割する

## 帰結

滞留件数に関係なく、tick1回の投入候補の読み取りはlimit程度になる

実行可能ジョブがlimitを超えて滞留した場合に範囲へ入るジョブは、作成の早いものから到来の早いものに変わる
バックオフ待ちから戻ったジョブは、作成が早くても到来時刻の順で範囲へ入る
到来済みのジョブは後から到来したジョブより先に範囲へ入り、範囲内ではエージングが従来通り機能する

一括投入で`run_after`が同じ場合の範囲はID順となる
