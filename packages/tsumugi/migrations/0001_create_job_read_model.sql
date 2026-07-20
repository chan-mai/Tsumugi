-- ダッシュボードとREST APIが読む投影先(ADR-0008)
-- 真実の源はDOのSQLite,ここは数秒遅れる読み取りモデル
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  -- 投影元のアウトボックス連番,古い投影が新しい状態を上書きしないための番人
  seq INTEGER NOT NULL,
  binding TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER NOT NULL,
  attempts INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  concurrency_key TEXT,
  unique_key TEXT,
  guarantee TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  dispatched_at INTEGER,
  payload TEXT NOT NULL,
  run_id TEXT,
  node_id TEXT
);

CREATE INDEX IF NOT EXISTS job_state ON job (state, updated_at);
CREATE INDEX IF NOT EXISTS job_binding ON job (binding, updated_at);
CREATE INDEX IF NOT EXISTS job_created ON job (created_at);
