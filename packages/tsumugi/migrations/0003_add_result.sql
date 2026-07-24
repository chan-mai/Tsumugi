-- performの戻り値(#9)
-- 成功時にJSON文字列で入る, 上限超過や非直列化はnull
-- 投影はジョブのスナップショットに同梱して運ぶので, 冪等性の判定はseqのまま1つで足りる
ALTER TABLE job ADD COLUMN result TEXT;
