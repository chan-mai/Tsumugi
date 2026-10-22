-- 既定一覧のフィルタ無しupdated_at降順用
CREATE INDEX IF NOT EXISTS job_updated ON job (updated_at, id);
-- 参照クエリなし
DROP INDEX IF EXISTS run_created;
