-- 試行ごとの記録(ADR-0028)
-- ジョブ行は最新の状態しか持たず,何回目がいつ何で落ちたかが残らない
-- 投影はジョブのスナップショットに同梱して運ぶので,冪等性の判定はseqのみで足りる
ALTER TABLE job ADD COLUMN attempts_log TEXT;
