-- runとノードの読み取りモデル(ADR-0008 / ADR-0029)
-- Run DOはrunごとに独立しているので, 横断的な一覧はここにしか作れない
CREATE TABLE IF NOT EXISTS run (
  id TEXT PRIMARY KEY,
  -- 投影元のアウトボックス連番,古い投影による上書きを防ぐために使う
  seq INTEGER NOT NULL,
  flow TEXT NOT NULL,
  state TEXT NOT NULL,
  input TEXT NOT NULL,
  -- 一覧に進捗を出すための集計,ノードを引き直さずに済ませる
  node_total INTEGER NOT NULL,
  node_done INTEGER NOT NULL,
  node_failed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS run_state ON run (state, updated_at);
CREATE INDEX IF NOT EXISTS run_flow ON run (flow, updated_at);
CREATE INDEX IF NOT EXISTS run_created ON run (created_at);
CREATE INDEX IF NOT EXISTS run_updated ON run (updated_at, id);

CREATE TABLE IF NOT EXISTS run_node (
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  binding TEXT NOT NULL,
  state TEXT NOT NULL,
  container INTEGER NOT NULL,
  parent TEXT,
  origin TEXT NOT NULL,
  after TEXT NOT NULL,
  job_id TEXT,
  -- fan-outノードの集計値のみが入る,通常ノードの戻り値はjob表に投影済み(ADR-0035)
  result TEXT,
  error TEXT,
  -- 画面の並び順,定義順と生成順を保つ
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, node_id)
);

CREATE INDEX IF NOT EXISTS run_node_run ON run_node (run_id, position);
