import { basename, join } from 'node:path';
import { configFragment, configFragmentToml, type FragmentValues } from '../config/fragment.js';
import { requiredAsMissing } from '../config/validate.js';
import { detectWranglerConfig, readWorkerName, type ConfigFormat } from './config-file.js';
import type { CliDeps } from './index.js';
import { BARREL_HEADER, devVarsFile, exportLine, indexFile, performerFile, wranglerConfigFile } from './templates.js';

/**
 * `tsumugi init`(ADR-0036)
 *
 * D1とキューを作り, wrangler設定とWorkerの雛形を生成し, 読み取りモデルのマイグレーションを適用する
 * 既存ファイルは書き換えず, 設定が在る場合は追記する断片の出力に留める
 */

export type InitOptions = {
	name?: string | undefined;
	format?: ConfigFormat | undefined;
};

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

/** `wrangler d1 create`の出力からdatabase_idを拾う, 形式の揺れに備えて3段で見る */
export function extractDatabaseId(stdout: string): string | undefined {
	const json = stdout.match(new RegExp(`"database_id"\\s*:\\s*"(${UUID.source})"`));
	if (json?.[1] !== undefined) return json[1];
	const toml = stdout.match(new RegExp(`database_id\\s*=\\s*"(${UUID.source})"`));
	if (toml?.[1] !== undefined) return toml[1];
	return stdout.match(UUID)?.[0];
}

const packageName = (deps: CliDeps): string | undefined => {
	const path = join(deps.cwd, 'package.json');
	if (!deps.fs.exists(path)) return undefined;
	try {
		const parsed = JSON.parse(deps.fs.read(path)) as { name?: string };
		return parsed.name?.replace(/^@[^/]+\//, '');
	} catch {
		return undefined;
	}
};

/** Workerの名前の既定値, 既存設定 → package.json → ディレクトリ名の順で引く */
export function resolveWorkerName(deps: CliDeps): string {
	const existing = detectWranglerConfig(deps);
	const configName = existing ? readWorkerName(deps.fs.read(existing.path), existing.format) : undefined;
	return configName ?? packageName(deps) ?? basename(deps.cwd);
}

export function init(options: InitOptions, deps: CliDeps): number {
	const existing = detectWranglerConfig(deps);
	const name = options.name ?? resolveWorkerName(deps);

	const probe = deps.wrangler(['--version']);
	if (!probe.ok) {
		deps.error('tsumugi: wrangler is not available');
		deps.error('install it with `npm install --save-dev wrangler` and run init again');
		return 1;
	}

	// 設定より先にリソースを作る, d1 createが出すdatabase_idをそのまま設定へ書くため
	const queue = deps.wrangler(['queues', 'create', name]);
	if (!queue.ok) deps.error(`warning: \`wrangler queues create ${name}\` failed, create the queue yourself if it does not exist`);

	const database = deps.wrangler(['d1', 'create', name]);
	const databaseId = database.ok ? extractDatabaseId(database.stdout) : undefined;
	if (databaseId === undefined) {
		deps.error(`warning: could not read database_id from \`wrangler d1 create ${name}\`, fill in <id> yourself`);
	}

	const values: FragmentValues = { databaseName: name, queueName: name, migrationTag: 'v1', ...(databaseId ? { databaseId } : {}) };
	const missing = requiredAsMissing(false);

	let wroteConfig = false;
	if (existing) {
		const fragment = existing.format === 'toml' ? configFragmentToml(missing, values) : configFragment(missing, values);
		deps.log(`${existing.file} already exists and is left as is, append the missing bindings yourself:`);
		deps.log('');
		deps.log(fragment);
		deps.log('');
	} else {
		const format = options.format ?? 'jsonc';
		const file = format === 'toml' ? 'wrangler.toml' : 'wrangler.jsonc';
		const fragment = format === 'toml' ? configFragmentToml(missing, values) : configFragment(missing, values);
		deps.fs.write(join(deps.cwd, file), wranglerConfigFile(name, fragment, format));
		deps.log(`created ${file}`);
		wroteConfig = true;
	}

	// 雛形は個別に見る, 在るものは書き換えない(ADR-0036)
	const writeNew = (relative: string, content: string): void => {
		const path = join(deps.cwd, ...relative.split('/'));
		if (deps.fs.exists(path)) {
			deps.log(`skipped ${relative} (already exists)`);
			return;
		}
		deps.fs.write(path, content);
		deps.log(`created ${relative}`);
	};

	deps.fs.mkdir(join(deps.cwd, 'src', 'performers'));
	writeNew('src/performers/hello.ts', performerFile('Hello'));
	writeNew('src/performers/index.ts', BARREL_HEADER + exportLine('Hello', 'hello'));
	writeNew('src/index.ts', indexFile());
	writeNew('.dev.vars', devVarsFile());

	if (wroteConfig) {
		for (const target of ['--local', '--remote']) {
			const apply = deps.wrangler(['d1', 'migrations', 'apply', name, target]);
			if (!apply.ok) deps.error(`warning: \`wrangler d1 migrations apply ${name} ${target}\` failed, run it again yourself`);
		}
		// 生成したコードが参照する大域のEnvを成立させる
		const types = deps.wrangler(['types']);
		if (!types.ok) deps.error('warning: `wrangler types` failed, run it again yourself');
	}

	deps.log('');
	deps.log('next steps:');
	if (!wroteConfig) {
		deps.log('  1. append the fragment above to your wrangler config');
		deps.log(`  2. npx wrangler d1 migrations apply ${name} --local && npx wrangler d1 migrations apply ${name} --remote`);
		deps.log('  3. npx wrangler types');
		deps.log('  4. npx wrangler secret put TSUMUGI_TOKEN');
		deps.log('  5. npx wrangler dev (dashboard: http://localhost:8787/)');
	} else {
		deps.log('  1. npx wrangler secret put TSUMUGI_TOKEN (the local token is in .dev.vars)');
		deps.log('  2. npx wrangler dev (dashboard: http://localhost:8787/)');
	}

	// database_idが埋まらなかった場合は残作業がある印として非0を返す
	return databaseId === undefined ? 1 : 0;
}
