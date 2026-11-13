import { applyD1Migrations, env } from 'cloudflare:test';

import type { D1Migration } from '@cloudflare/vitest-plugin';

await applyD1Migrations(env.TSUMUGI_DB, (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS);
