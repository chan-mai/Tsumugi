import { describe, expect, it } from 'vitest';
import { readWorkerName } from '../../src/cli/config-file.js';
import { extractDatabaseId, init } from '../../src/cli/init.js';
import { makeDeps, fail, ok } from './cli-harness.js';

// initは唯一ユーザーのファイルとCloudflareのリソースへ触れる
// 壊す方向の誤り(上書き, 転記漏れ)をここで検出する

const DATABASE_ID = '9945ba53-b1cb-45a2-8f01-c650518c2f2a';

/** wrangler d1 createが出すJSONC断片の形 */
const D1_CREATE_STDOUT = `✅ Successfully created DB 'my-jobs'

{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "my-jobs",
      "database_id": "${DATABASE_ID}"
    }
  ]
}
`;

const d1Script = (args: readonly string[]) => (args[0] === 'd1' && args[1] === 'create' ? ok(D1_CREATE_STDOUT) : ok());

/** コメントと末尾カンマを落としてJSONとして読む, 生成物の構文の妥当性を確かめる */
const parseJsonc = (source: string): unknown => JSON.parse(source.replace(/^\s*\/\/.*$/gm, '').replace(/,(\s*[}\]])/g, '$1'));

describe('initの新規生成', () => {
	it('wrangler設定へdatabase_idをそのまま書き込む', () => {
		const { deps, fs } = makeDeps(d1Script);
		fs.write('/proj/package.json', '{ "name": "my-jobs" }');

		expect(init({}, deps)).toBe(0);

		const config = fs.read('/proj/wrangler.jsonc');
		expect(config).toContain(`"database_id": "${DATABASE_ID}"`);
		expect(config).toContain('"name": "my-jobs"');
		expect(config).toContain('"class_name": "TsumugiJobShard"');
		expect(config).toContain('"tag": "v1"');
		expect(config).toContain('./node_modules/tsumugi/migrations');
		expect(config).toContain('"queue": "my-jobs"');
		expect(config).not.toContain('<id>');
		expect(config).not.toContain('paste database_id');
	});

	it('生成したwrangler.jsoncは構文として妥当', () => {
		// 部分一致の検査では構文の破れを検出できないため, パースまで通す
		const { deps, fs } = makeDeps(d1Script);
		expect(init({ name: 'my-jobs' }, deps)).toBe(0);
		const parsed = parseJsonc(fs.read('/proj/wrangler.jsonc')) as { name?: string; d1_databases?: unknown[] };
		expect(parsed.name).toBe('my-jobs');
		expect(parsed.d1_databases).toHaveLength(1);
	});

	it('Workerの雛形と開発用トークンを生成する', () => {
		const { deps, fs } = makeDeps(d1Script);
		expect(init({}, deps)).toBe(0);

		expect(fs.read('/proj/src/performers/hello.ts')).toContain('export class Hello extends Performer');
		expect(fs.read('/proj/src/performers/index.ts')).toContain("export { Hello } from './hello.js';");
		expect(fs.read('/proj/src/index.ts')).toContain("export * from './performers/index.js';");
		expect(fs.read('/proj/.dev.vars')).toContain('TSUMUGI_TOKEN');
	});

	it('リソース作成から適用まで順に実行する', () => {
		// 設定より先にd1 createを実行する, 出力のdatabase_idを設定へ書くため
		const { deps, calls } = makeDeps(d1Script);
		expect(init({ name: 'my-jobs' }, deps)).toBe(0);
		expect(calls).toEqual([
			['--version'],
			['queues', 'create', 'my-jobs'],
			['d1', 'create', 'my-jobs'],
			['d1', 'migrations', 'apply', 'my-jobs', '--local'],
			['d1', 'migrations', 'apply', 'my-jobs', '--remote'],
			['types'],
		]);
	});

	it('--format tomlはwrangler.tomlを生成する', () => {
		const { deps, fs } = makeDeps(d1Script);
		expect(init({ name: 'my-jobs', format: 'toml' }, deps)).toBe(0);

		const config = fs.read('/proj/wrangler.toml');
		expect(config).toContain('name = "my-jobs"');
		expect(config).toContain('[[d1_databases]]');
		expect(config).toContain(`database_id = "${DATABASE_ID}"`);
		expect(fs.files.has('/proj/wrangler.jsonc')).toBe(false);
	});

	it('名前は指定が無ければpackage.json, それも無ければディレクトリ名から取る', () => {
		const first = makeDeps(d1Script);
		first.fs.write('/proj/package.json', '{ "name": "@scope/my-jobs" }');
		init({}, first.deps);
		expect(first.calls[1]).toEqual(['queues', 'create', 'my-jobs']);

		const second = makeDeps(d1Script);
		init({}, second.deps);
		expect(second.calls[1]).toEqual(['queues', 'create', 'proj']);
	});
});

describe('initと既存ファイル', () => {
	it('既存のwrangler.jsoncは書き換えず断片を出力する', () => {
		// 追記の判断は利用者に残す(ADR-0036)
		const original = '{\n  "name": "existing-app"\n}\n';
		const { deps, fs, logs, calls } = makeDeps(d1Script);
		fs.write('/proj/wrangler.jsonc', original);

		expect(init({}, deps)).toBe(0);

		expect(fs.read('/proj/wrangler.jsonc')).toBe(original);
		expect(logs.join('\n')).toContain(`"database_id": "${DATABASE_ID}"`);
		expect(calls[1]).toEqual(['queues', 'create', 'existing-app']);
		// TSUMUGI_DBが設定へ書かれた保証が無いので適用とtypesは実行しない
		expect(calls.some((args) => args.includes('migrations'))).toBe(false);
		expect(calls.some((args) => args[0] === 'types')).toBe(false);
	});

	it('既存のwrangler.tomlにはTOMLの断片を出力する', () => {
		const original = 'name = "toml-app"\n';
		const { deps, fs, logs } = makeDeps(d1Script);
		fs.write('/proj/wrangler.toml', original);

		expect(init({}, deps)).toBe(0);

		expect(fs.read('/proj/wrangler.toml')).toBe(original);
		expect(logs.join('\n')).toContain('[[d1_databases]]');
		expect(logs.join('\n')).toContain(`database_id = "${DATABASE_ID}"`);
	});

	it('既存のsrc/index.tsは上書きしない', () => {
		const { deps, fs, logs } = makeDeps(d1Script);
		fs.write('/proj/src/index.ts', 'original');

		init({ name: 'my-jobs' }, deps);

		expect(fs.read('/proj/src/index.ts')).toBe('original');
		expect(logs.join('\n')).toContain('skipped src/index.ts');
	});
});

describe('initの失敗', () => {
	it('wranglerが無ければ何も書かない', () => {
		const { deps, fs, calls } = makeDeps((args) => (args[0] === '--version' ? fail('not found') : ok()));
		expect(init({ name: 'my-jobs' }, deps)).toBe(1);
		expect(fs.files.size).toBe(0);
		expect(calls).toEqual([['--version']]);
	});

	it('d1 createが失敗したらプレースホルダで生成して非0を返す', () => {
		// 生成自体は続ける, 残作業があることをexit codeで示す
		const { deps, fs, errors } = makeDeps((args) => (args[0] === 'd1' && args[1] === 'create' ? fail('already exists') : ok()));
		expect(init({ name: 'my-jobs' }, deps)).toBe(1);

		const config = fs.read('/proj/wrangler.jsonc');
		expect(config).toContain('"database_id": "<id>"');
		expect(config).toContain('paste database_id');
		expect(errors.join('\n')).toContain('could not read database_id');
	});
});

describe('Worker名の読み取り', () => {
	it('トップレベルのnameを読む', () => {
		expect(readWorkerName('{\n  "name": "my-jobs",\n  "durable_objects": { "bindings": [{ "name": "JOB_SHARD" }] }\n}', 'jsonc')).toBe(
			'my-jobs',
		);
		expect(readWorkerName('name = "my-jobs"\n\n[[d1_databases]]\nbinding = "TSUMUGI_DB"\n', 'toml')).toBe('my-jobs');
	});

	it('入れ子のbindingのnameは拾わない', () => {
		// bindingがトップレベルのnameより前に並ぶ設定で誤った名前を埋めない
		const config = '{\n  "durable_objects": { "bindings": [{ "name": "JOB_SHARD" }] },\n  "name": "my-jobs"\n}';
		expect(readWorkerName(config, 'jsonc')).not.toBe('JOB_SHARD');
	});
});

describe('database_idの抽出', () => {
	it('JSONC断片の形から拾う', () => {
		expect(extractDatabaseId(D1_CREATE_STDOUT)).toBe(DATABASE_ID);
	});

	it('TOMLの形から拾う', () => {
		expect(extractDatabaseId(`[[d1_databases]]\ndatabase_id = "${DATABASE_ID}"\n`)).toBe(DATABASE_ID);
	});

	it('素のUUIDでも拾う', () => {
		expect(extractDatabaseId(`created: ${DATABASE_ID}`)).toBe(DATABASE_ID);
	});

	it('見つからなければundefined', () => {
		expect(extractDatabaseId('nothing here')).toBeUndefined();
	});
});
