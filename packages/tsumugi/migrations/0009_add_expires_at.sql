-- 実行開始の期限
-- 経過後は実行されずCANCELLED, 無期限はNULL
ALTER TABLE job ADD COLUMN expires_at INTEGER;
