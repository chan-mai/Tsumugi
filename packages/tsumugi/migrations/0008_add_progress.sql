-- 実行中のジョブが報告した進捗
-- 0以上1以下, 報告が無ければNULL
ALTER TABLE job ADD COLUMN progress REAL;
