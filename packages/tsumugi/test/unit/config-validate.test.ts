import { describe, expect, it } from 'vitest';
import { Performer, remote } from '../../src/core/api.js';
import { cachedValidate, validateConfig } from '../../src/config/validate.js';
import { configErrorMessage, configFragment, DEFAULT_MIGRATIONS_DIR } from '../../src/config/fragment.js';

class Noop extends Performer<unknown, void> {
	async perform(): Promise<void> {}
}

/** 必須bindingが揃った`env`, 個々のテストで欠けさせる */
const complete = () => ({
	JOB_SHARD: {},
	TSUMUGI_DB: {},
	TSUMUGI_QUEUE: {},
	TSUMUGI_METRICS: {},
	RUN: {},
	MAIL_SERVICE: { perform: () => {} },
});

const performers = { LOCAL: Noop };
const withRemote = { LOCAL: Noop, MAIL: remote('MAIL_SERVICE') };
const flows = { GREETINGS: { nodes: [] } };

const names = (status: ReturnType<typeof validateConfig>) => (status.ok ? [] : status.missing.map((entry) => entry.name).sort());

describe('必須bindingの検証', () => {
	it('揃っていれば通る', () => {
		expect(validateConfig(complete(), { performers })).toEqual({ ok: true });
	});

	it('欠けたbindingを種別付きで列挙する', () => {
		const status = validateConfig({}, { performers });
		expect(status.ok).toBe(false);
		if (status.ok) return;
		expect(status.missing).toEqual([
			{ kind: 'durable-object', name: 'JOB_SHARD', reason: 'absent', className: 'TsumugiJobShard' },
			{ kind: 'd1', name: 'TSUMUGI_DB', reason: 'absent' },
			{ kind: 'queue', name: 'TSUMUGI_QUEUE', reason: 'absent' },
		]);
	});

	it('TSUMUGI_METRICSは求めない', () => {
		// 未設定でもメトリクスが書かれないだけで実行は成立する(ADR-0036)
		const env = complete();
		delete (env as Record<string, unknown>).TSUMUGI_METRICS;
		expect(validateConfig(env, { performers })).toEqual({ ok: true });
	});

	it('flowを使わない構成ではRUNを求めない', () => {
		const env = complete();
		delete (env as Record<string, unknown>).RUN;
		expect(validateConfig(env, { performers })).toEqual({ ok: true });
	});

	it('flowを使う構成ではRUNも求める', () => {
		const env = complete();
		delete (env as Record<string, unknown>).RUN;
		expect(names(validateConfig(env, { performers, flows }))).toEqual(['RUN']);
	});

	it('flowが空なら求めない', () => {
		const env = complete();
		delete (env as Record<string, unknown>).RUN;
		expect(validateConfig(env, { performers, flows: {} })).toEqual({ ok: true });
	});
});

describe('リモートperformerの整合(ADR-0026)', () => {
	it('service bindingが無ければ不足に載る', () => {
		const env = complete();
		delete (env as Record<string, unknown>).MAIL_SERVICE;
		expect(names(validateConfig(env, { performers: withRemote }))).toEqual(['MAIL_SERVICE']);
	});

	it('名前は在るがperformerでない場合も弾く', () => {
		// 実行時までずれに気付けないので, 起動時に同じ扱いにする
		const status = validateConfig({ ...complete(), MAIL_SERVICE: {} }, { performers: withRemote });
		expect(status.ok).toBe(false);
		if (status.ok) return;
		expect(status.missing).toEqual([{ kind: 'service', name: 'MAIL_SERVICE', reason: 'invalid' }]);
	});

	it('同じbindingを指すperformerが複数でも1件にまとめる', () => {
		// 重複するとエラー本文にも設定断片にも同じserviceが並ぶ
		const env = complete();
		delete (env as Record<string, unknown>).MAIL_SERVICE;
		const shared = { A: remote('MAIL_SERVICE'), B: remote('MAIL_SERVICE') };
		expect(names(validateConfig(env, { performers: shared }))).toEqual(['MAIL_SERVICE']);
	});

	it('揃っていれば通る', () => {
		expect(validateConfig(complete(), { performers: withRemote })).toEqual({ ok: true });
	});
});

describe('検証結果のキャッシュ', () => {
	it('成功は使い回す', () => {
		const check = cachedValidate({ performers });
		expect(check(complete())).toEqual({ ok: true });
		// 2回目は`env`を空にしても再判定しない, 同じisolateでbindingは変わらない
		expect(check({})).toEqual({ ok: true });
	});

	it('不足はキャッシュしない', () => {
		// 設定を足した後に再デプロイせず自力で復帰させる
		const check = cachedValidate({ performers });
		expect(check({}).ok).toBe(false);
		expect(check(complete())).toEqual({ ok: true });
	});
});

describe('設定断片の生成', () => {
	const fragmentOf = (env: Record<string, unknown>, input = { performers: withRemote, flows }) => {
		const status = validateConfig(env, input);
		return status.ok ? '' : configFragment(status.missing);
	};

	it('種別ごとのキーを出す', () => {
		const fragment = fragmentOf({});
		expect(fragment).toContain('"durable_objects"');
		expect(fragment).toContain('"migrations"');
		expect(fragment).toContain('"d1_databases"');
		expect(fragment).toContain('"queues"');
		expect(fragment).toContain('"services"');
	});

	it('Durable Objectはbindingとクラス名を対にする', () => {
		const fragment = fragmentOf({});
		expect(fragment).toContain('"class_name": "TsumugiJobShard"');
		expect(fragment).toContain('"class_name": "TsumugiRun"');
		expect(fragment).toContain('"new_sqlite_classes"');
	});

	it('D1のmigrations_dirはパッケージのSQLを指す', () => {
		expect(fragmentOf({})).toContain(DEFAULT_MIGRATIONS_DIR);
	});

	it('Queuesはproducerとconsumerの両方を出す', () => {
		const fragment = fragmentOf({});
		expect(fragment).toContain('"producers"');
		expect(fragment).toContain('"consumers"');
	});

	it('service bindingはリモートperformerの名前を反映する', () => {
		const env = complete();
		delete (env as Record<string, unknown>).MAIL_SERVICE;
		expect(fragmentOf(env)).toContain('"binding": "MAIL_SERVICE"');
	});

	it('揃っている種別の断片は出さない', () => {
		const env = complete();
		delete (env as Record<string, unknown>).TSUMUGI_QUEUE;
		const fragment = fragmentOf(env);
		expect(fragment).toContain('"queues"');
		expect(fragment).not.toContain('"d1_databases"');
	});
});

describe('設定漏れの説明', () => {
	it('不足の一覧と次に実行するコマンドを含む', () => {
		const status = validateConfig({}, { performers });
		if (status.ok) throw new Error('expected a missing binding');
		const message = configErrorMessage(status.missing);

		expect(message).toContain('✗ TSUMUGI_DB (D1) is not configured');
		expect(message).toContain('wrangler d1 create');
		expect(message).toContain('wrangler d1 migrations apply');
		expect(message).toContain('wrangler queues create');
		expect(message).toContain('"d1_databases"');
	});

	it('関係の無いコマンドは出さない', () => {
		const env = complete();
		delete (env as Record<string, unknown>).TSUMUGI_QUEUE;
		const status = validateConfig(env, { performers });
		if (status.ok) throw new Error('expected a missing binding');

		const message = configErrorMessage(status.missing);
		expect(message).toContain('wrangler queues create');
		expect(message).not.toContain('wrangler d1 create');
	});

	it('performerを持たないservice bindingは理由を分ける', () => {
		const status = validateConfig({ ...complete(), MAIL_SERVICE: {} }, { performers: withRemote });
		if (status.ok) throw new Error('expected a missing binding');
		expect(configErrorMessage(status.missing)).toContain('has no performer');
	});
});
