-- キー無しジョブ投影で索引更新不要
DROP INDEX IF EXISTS job_unique_key;
CREATE INDEX IF NOT EXISTS job_unique_key ON job (unique_key, updated_at) WHERE unique_key IS NOT NULL;
DROP INDEX IF EXISTS job_concurrency_key;
CREATE INDEX IF NOT EXISTS job_concurrency_key ON job (concurrency_key, updated_at) WHERE concurrency_key IS NOT NULL;
