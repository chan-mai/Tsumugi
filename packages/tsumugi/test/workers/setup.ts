import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import { applyD1Migrations, env } from 'cloudflare:test';

// 本番と同じマイグレーションSQLでD1の読み取りモデルを用意する
await applyD1Migrations(env.TSUMUGI_DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
