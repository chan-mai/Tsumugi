-- subflowノードが起動した子のrunID
-- 画面から子のrunへ辿るために投影する
ALTER TABLE run_node ADD COLUMN child_run_id TEXT;

-- subflowとして起動されたrunの親
-- 子のrunから親を辿るために投影する
ALTER TABLE run ADD COLUMN parent_run_id TEXT;
ALTER TABLE run ADD COLUMN parent_node_id TEXT;
