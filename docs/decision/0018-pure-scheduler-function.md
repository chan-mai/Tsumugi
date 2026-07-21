# ADR-0018:判断ロジックを純粋関数に分離しDOを薄い殻にする

## 状況

難所(alarm発火/reaper境界/claim競合/投影)が全て時間依存
Workersには時間を進めるAPIが無く, fake timersはDOに効かない

## 決定

`schedule(now, jobs, policy, bucket) -> Decision[]`を純粋関数として切り出す
時刻も乱数も引数で受け取り, core内で`Date.now()`と`Math.random()`を呼ばない

## 帰結

境界条件を時間操作なしで網羅テストできる
coreがworkerd型を読まないことを`tsconfig.core.json`で機械的に強制する
