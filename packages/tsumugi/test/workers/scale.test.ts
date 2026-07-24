import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { DispatchMessage } from '../../src/do/job-shard.js';

const T0 = 2_000_000_000_000;

function captureQueue() {
	const sent: DispatchMessage[] = [];
	const batches: number[] = [];
	return {
		sent,
		batches,
		queue: {
			send: async (body: DispatchMessage) => void sent.push(body),
			sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
				const items = [...batch];
				// プロデューサ側の100件上限, 超えると本番のsendBatchも失敗する
				if (items.length > 100) throw new Error(`sendBatch上限100件を超過: ${items.length}`);
				batches.push(items.length);
				for (const m of items) sent.push(m.body);
			},
		},
	};
}

const shard = (name: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(name));

async function install(name: string, now: number, queue: unknown) {
	await runInDurableObject(shard(name), (instance) => {
		(instance as any).clock = { now: () => now };
		(instance as any).env.TSUMUGI_QUEUE = queue;
	});
}

const stateOf = (name: string, jobId: string) =>
	runInDurableObject(shard(name), (instance) => (instance as any).repo.find(jobId)?.state as string | undefined);

const writesOf = (name: string) => runInDurableObject(shard(name), (instance) => (instance as any).repo.writes as number);

describe('uniqueKeyによる重複排除(ADR-0021 / ADR-0022)', () => {
	it('衝突すると既存のジョブIDが返る', async () => {
		const { queue } = captureQueue();
		await install('UNIQ#0', T0, queue);

		const first = await shard('UNIQ#0').enqueue({ binding: 'UNIQ', payload: { n: 1 }, uniqueKey: 'daily-report' });
		const second = await shard('UNIQ#0').enqueue({ binding: 'UNIQ', payload: { n: 2 }, uniqueKey: 'daily-report' });

		// 衝突を正常系として扱うので呼び出し側は例外処理を書かずに済む
		expect(second).toBe(first);
	});

	it('別のキーなら別のジョブになる', async () => {
		const { queue } = captureQueue();
		await install('UNIQ2#0', T0, queue);

		const a = await shard('UNIQ2#0').enqueue({ binding: 'UNIQ2', payload: {}, uniqueKey: 'a' });
		const b = await shard('UNIQ2#0').enqueue({ binding: 'UNIQ2', payload: {}, uniqueKey: 'b' });
		expect(a).not.toBe(b);
	});

	it('予約期間を過ぎれば新しいジョブになる', async () => {
		const { queue } = captureQueue();
		await install('UNIQ3#0', T0, queue);
		const first = await shard('UNIQ3#0').enqueue({ binding: 'UNIQ3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });

		// キーだけを一定期間残す方式なので,期限を過ぎれば同じキーでも通る
		await install('UNIQ3#0', T0 + 1_001, queue);
		const second = await shard('UNIQ3#0').enqueue({ binding: 'UNIQ3', payload: {}, uniqueKey: 'k', uniqueForMs: 1_000 });

		expect(second).not.toBe(first);
	});
});

describe('concurrencyKey単位の同時実行上限(ADR-0009)', () => {
	it('同じキーのジョブは上限までしか投入されない', async () => {
		const { sent, queue } = captureQueue();
		await install('CKEY#0', T0, queue);
		await shard('CKEY#0').configure({ policy: { concurrency: 100, perKeyConcurrency: 1 } });

		const inputs = Array.from({ length: 100 }, (_, i) => ({
			binding: 'CKEY',
			payload: { i },
			concurrencyKey: 'cust-1',
		}));
		await shard('CKEY#0').enqueueMany(inputs);
		await runDurableObjectAlarm(shard('CKEY#0'));

		expect(sent).toHaveLength(1);
	});

	it('別のキーは巻き添えにならない', async () => {
		const { sent, queue } = captureQueue();
		await install('CKEY2#0', T0, queue);
		await shard('CKEY2#0').configure({ policy: { concurrency: 100, perKeyConcurrency: 1 } });

		// 実装がcontinueではなくbreakしていると,先頭のキーが詰まった時点で全体が止まる
		await shard('CKEY2#0').enqueueMany([
			{ binding: 'CKEY2', payload: {}, concurrencyKey: 'a' },
			{ binding: 'CKEY2', payload: {}, concurrencyKey: 'a' },
			{ binding: 'CKEY2', payload: {}, concurrencyKey: 'b' },
		]);
		await runDurableObjectAlarm(shard('CKEY2#0'));

		expect(sent).toHaveLength(2);
	});
});

describe('ポリシーの永続化', () => {
	it('configureした値がtickに反映される', async () => {
		const { sent, queue } = captureQueue();
		await install('POL#0', T0, queue);
		await shard('POL#0').configure({ policy: { concurrency: 2, perKeyConcurrency: 100 } });

		await shard('POL#0').enqueueMany(Array.from({ length: 10 }, () => ({ binding: 'POL', payload: {} })));
		await runDurableObjectAlarm(shard('POL#0'));

		expect(sent).toHaveLength(2);
	});

	it('同じ内容のポリシーを渡し続けても書き込みが増えない', async () => {
		const { queue } = captureQueue();
		await install('POL2#0', T0, queue);
		const settings = { policy: { concurrency: 5 } };

		await shard('POL2#0').enqueueMany([{ binding: 'POL2', payload: {} }], settings);
		const before = await writesOf('POL2#0');
		await shard('POL2#0').enqueueMany([{ binding: 'POL2', payload: {} }], settings);
		const after = await writesOf('POL2#0');

		// 増えるのはジョブのinsertとアウトボックス追記の2回だけ,ポリシーの再書き込みは起きない
		expect(after - before).toBe(2);
	});

	it('実行時のconfigure()が次のenqueueの静的設定で上書きされない(#6)', async () => {
		const { sent, queue } = captureQueue();
		await install('PAUSE#0', T0, queue);

		// 実行時にconcurrency=0で止める, 現状で唯一のpause手段
		await shard('PAUSE#0').configure({ policy: { concurrency: 0 } });
		// 静的設定を同梱したenqueue, 従来はこれがpauseを解除していた
		await shard('PAUSE#0').enqueueMany([{ binding: 'PAUSE', payload: {} }], { policy: { concurrency: 100 } });
		await runDurableObjectAlarm(shard('PAUSE#0'));

		// pauseが保持され1件も投入されない
		expect(sent).toHaveLength(0);
	});

	it('configure()の後は実行時のconfigure()で解除できる(#6)', async () => {
		const { sent, queue } = captureQueue();
		await install('PAUSE2#0', T0, queue);

		await shard('PAUSE2#0').configure({ policy: { concurrency: 0 } });
		await shard('PAUSE2#0').enqueueMany([{ binding: 'PAUSE2', payload: {} }], { policy: { concurrency: 100 } });
		// 静的設定ではなく実行時のconfigure()なら解除できる
		await shard('PAUSE2#0').configure({ policy: { concurrency: 100 } });
		await runDurableObjectAlarm(shard('PAUSE2#0'));

		expect(sent).toHaveLength(1);
	});
});

describe('運用診断(#10)', () => {
	it('バックログの深さと投入が止まった制約を返す', async () => {
		const { queue } = captureQueue();
		await install('DIAG#0', T0, queue);
		// 枠1に対して2件, 1件は枠待ちで止まる
		await shard('DIAG#0').configure({ policy: { concurrency: 1, perKeyConcurrency: 1 } });
		await shard('DIAG#0').enqueueMany([
			{ binding: 'DIAG', payload: {} },
			{ binding: 'DIAG', payload: {} },
		]);
		await runDurableObjectAlarm(shard('DIAG#0'));

		const diag = await shard('DIAG#0').diagnostics();
		// QUEUED1件+SCHEDULED1件, どちらも稼働中
		expect(diag.active).toBe(2);
		// 枠が尽きて投入が止まったことが外から分かる
		expect(diag.blocked.capacity).toBe(true);
	});

	it('止まった制約をDOに永続化する', async () => {
		const { queue } = captureQueue();
		await install('DIAGP#0', T0, queue);
		await shard('DIAGP#0').configure({ policy: { concurrency: 1, perKeyConcurrency: 1 } });
		await shard('DIAGP#0').enqueueMany([
			{ binding: 'DIAGP', payload: {} },
			{ binding: 'DIAGP', payload: {} },
		]);
		await runDurableObjectAlarm(shard('DIAGP#0'));

		const raw = await runInDurableObject(
			shard('DIAGP#0'),
			(instance) => (instance as any).repo.readSetting('last_blocked') as string | undefined,
		);
		expect(raw).toBeDefined();
		expect(JSON.parse(raw as string)).toMatchObject({ capacity: true });
	});

	it('退避で消えても永続化したblockedをdiagnosticsが返す', async () => {
		// tick前のshardはblockedがfalse既定,退避後の再ロードを模して直接書く
		await runInDurableObject(shard('DIAGR#0'), (instance) =>
			(instance as any).repo.writeSetting('last_blocked', JSON.stringify({ capacity: true, tokens: false, perKey: false })),
		);

		const diag = await shard('DIAGR#0').diagnostics();
		expect(diag.blocked.capacity).toBe(true);
	});
});

describe('enqueueMany', () => {
	it('1回のRPCで大量に投入でき, IDの並びが入力に対応する', async () => {
		const { queue } = captureQueue();
		await install('BULK#0', T0, queue);

		const inputs = Array.from({ length: 1_000 }, (_, i) => ({ binding: 'BULK', payload: { i } }));
		const ids = await shard('BULK#0').enqueueMany(inputs);

		expect(ids).toHaveLength(1_000);
		expect(new Set(ids).size).toBe(1_000);
		expect(await stateOf('BULK#0', ids[0]!)).toBe('SCHEDULED');
		expect(await stateOf('BULK#0', ids[999]!)).toBe('SCHEDULED');
	});

	it('tickは有界で,上限を超える分は次のtickへ送る', async () => {
		const { sent, queue } = captureQueue();
		await install('BOUND#0', T0, queue);
		await shard('BOUND#0').configure({ policy: { concurrency: 10_000, perKeyConcurrency: 10_000 } });

		await shard('BOUND#0').enqueueMany(Array.from({ length: 300 }, () => ({ binding: 'BOUND', payload: {} })));
		await runDurableObjectAlarm(shard('BOUND#0'));

		// TICK_LIMITは200, alarmのwall time上限15分に当たらないための構造
		expect(sent).toHaveLength(200);
		const alarm = await runInDurableObject(shard('BOUND#0'), (_i, state) => state.storage.getAlarm());
		expect(alarm).toBe(T0);
	});

	it('concurrencyが100を超えてもsendBatchは100件ずつに分割される', async () => {
		const { sent, batches, queue } = captureQueue();
		await install('SPLIT#0', T0, queue);
		await shard('SPLIT#0').configure({ policy: { concurrency: 150, perKeyConcurrency: 150 } });

		await shard('SPLIT#0').enqueueMany(Array.from({ length: 150 }, () => ({ binding: 'SPLIT', payload: {} })));
		await runDurableObjectAlarm(shard('SPLIT#0'));

		// 分割前は1回で150件送りcaptureQueueがthrowする
		// 100件単位で分割し, 過分割でないことも固定する
		expect(sent).toHaveLength(150);
		expect(batches).toEqual([100, 50]);
	});
});

describe('投入候補の窓(ADR-0019 / ADR-0020, #4)', () => {
	it('稼働中がTICK_LIMITを埋めても後から入った実行可能ジョブが投入される', async () => {
		const { sent, queue } = captureQueue();
		await install('WIN#0', T0, queue);
		// 枠は空けたまま作成順の窓を実行中で埋める
		await shard('WIN#0').configure({ policy: { concurrency: 400, perKeyConcurrency: 400 } });

		// 200件を投入してtickでQUEUEDにする(実行中の在庫)
		await shard('WIN#0').enqueueMany(Array.from({ length: 200 }, () => ({ binding: 'WIN', payload: {} })));
		await runDurableObjectAlarm(shard('WIN#0'));
		expect(sent).toHaveLength(200);

		// 実行中200件より後に実行可能ジョブを入れる, 作成順では201件目に落ちる
		sent.length = 0;
		await install('WIN#0', T0 + 1_000, queue);
		const late = await shard('WIN#0').enqueue({ binding: 'WIN', payload: { late: true }, priority: 10 });
		await runDurableObjectAlarm(shard('WIN#0'));

		// 作成順の単一窓だと201件目は選考へ入らず投入されない
		expect(sent.map((m) => m.jobId)).toContain(late);
		expect(await stateOf('WIN#0', late)).toBe('QUEUED');
	});
});
