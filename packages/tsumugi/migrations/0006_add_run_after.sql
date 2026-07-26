-- 予約済みジョブの実行予定時刻
-- 実行時刻を変更できるようになったので, 変更後の予定を読み取りモデルからも参照できるようにする
-- 既存行はNULL, 投影が一度行われた時点で値が入る
ALTER TABLE job ADD COLUMN run_after INTEGER;
