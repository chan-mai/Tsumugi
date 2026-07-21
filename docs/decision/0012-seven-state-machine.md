# ADR-0012:状態を7つにしQUEUEDを分離する

## 状況

投入済み未開始と実行中を1つの状態にまとめると, performerが動いていないのか遅いだけなのかを区別できず固着の診断ができない

## 決定

SCHEDULED / QUEUED / RUNNING / COMPLETED / FAILED / CANCELLED / STALLEDの7状態
待ち状態はattemptsで区別できるのでSCHEDULEDに統合する

## 帰結

performerが動いていないのか遅いだけなのかをUIで区別できる
STALLEDはADR-0006の帰結として必要
