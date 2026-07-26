-- キーによる絞り込み用の索引
-- 障害の調査はunique_keyやconcurrency_keyから入ることが多い
-- 既存の索引はstate/binding/created_atのみで, キーでの検索は全表走査になる
-- updated_atを含めるのは一覧の既定の並び順に合わせるため
CREATE INDEX IF NOT EXISTS job_unique_key ON job (unique_key, updated_at);
CREATE INDEX IF NOT EXISTS job_concurrency_key ON job (concurrency_key, updated_at);
