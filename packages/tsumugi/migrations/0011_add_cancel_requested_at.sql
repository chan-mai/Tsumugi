-- 取り消し要求の時刻
ALTER TABLE job ADD COLUMN cancel_requested_at INTEGER;
