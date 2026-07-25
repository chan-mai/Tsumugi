import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { Performer } from '../../src/core/api.js';
import type { JobContext } from '../../src/core/api.js';
import type { DispatchMessage } from '../../src/do/job-shard.js';
import type { TsumugiRunInstance } from '../../src/do/run.js';
import { handleBatch, type ConsumerEnv } from '../../src/queue/consumer.js';

/**
 * 縦串: runの開始からノードの完了まで
 *
 * flowの定義はexamples/basicが持つ(GREETINGS), Run DOはそこから引く(ADR-0030)
 * performerはconsumerへ渡す`performers`で差し替える, 実行結果をテストから確認するため
 */

const performed: { binding: string; payload: unknown }[] = [];

class ListNames extends Performer<{ prefix: string }, { names: string[] }, {}, ConsumerEnv> {
	async perform(payload: { prefix: string }) {
		performed.push({ binding: 'LIST', payload });
		return { names: [`${payload.prefix}-1`, `${payload.prefix}-2`, `${payload.prefix}-3`] };
	}
}

class Greet extends Performer<{ name: string }, { greeted: string }, {}, ConsumerEnv> {
	async perform(payload: { name: string }) {
		performed.push({ binding: 'GREET', payload });
		return { greeted: payload.name };
	}
}

class Report extends Performer<{ total: number; failed: number }, void, {}, ConsumerEnv> {
	async perform(payload: { total: number; failed: number }): Promise<void> {
		performed.push({ binding: 'REPORT', payload });
	}
}

/** 自分の内側に子を1つ足すperformer, spawnの経路を見る(ADR-0032) */
class GreetAndSpawn extends Performer<{ name: string }, { greeted: string }, {}, ConsumerEnv> {
	async perform(payload: { name: string }, ctx: JobContext) {
		performed.push({ binding: 'GREET', payload });
		// 子は孫を作らない, 際限なく増えるので印で止める
		if (!payload.name.endsWith('-child')) ctx.spawn('child', 'GREET', { name: `${payload.name}-child` });
		return { greeted: payload.name };
	}
}

const registry = { LIST: ListNames, GREET: Greet, REPORT: Report };
const spawningRegistry = { LIST: ListNames, GREET: GreetAndSpawn, REPORT: Report };
const BINDINGS = ['LIST', 'GREET', 'REPORT'] as const;

const consumerEnv: ConsumerEnv = env;

const shard = (binding: string) => env.JOB_SHARD.get(env.JOB_SHARD.idFromName(`${binding}#0`));
// `any`のまま持つと型の展開が深くなりTS2589に触れる, 公開している面で受ける
const runNamespace = env.RUN as unknown as DurableObjectNamespace<TsumugiRunInstance>;
const runStub = (runId: string) => runNamespace.get(runNamespace.idFromName(runId));

/** DOが送ったメッセージを溜めてconsumerへ手で渡す, Queuesの配送自体はここでの関心ではない */
const sent: DispatchMessage[] = [];
const queue = {
	send: async (body: DispatchMessage) => {
		sent.push(body);
	},
	sendBatch: async (batch: Iterable<{ body: DispatchMessage }>) => {
		for (const m of batch) sent.push(m.body);
	},
};

function makeBatch(bodies: DispatchMessage[]) {
	const messages = bodies.map((body, i) => ({
		id: String(i),
		timestamp: new Date(0),
		body,
		attempts: 1,
		ack: () => {},
		retry: () => {
			throw new Error('consumerはretryを呼んではならない(ADR-0004)');
		},
	}));
	return { queue: 'test', messages, ackAll: () => {}, retryAll: () => {} } as unknown as MessageBatch<DispatchMessage>;
}

/**
 * Job DOの投入先を差し替える
 * 実キューへ出すとconsumerが自動で走り, 完了通知が割り込んで手で作った状況が壊れる
 */
async function installQueues(): Promise<void> {
	for (const binding of BINDINGS) {
		await runInDurableObject(shard(binding), (instance) => {
			(instance as any).env.TSUMUGI_QUEUE = queue;
		});
	}
}

/** Job DOとRun DOのalarmを交互に発火させ, 進みが止まるまで回す */
async function settle(runId: string, performers: Record<string, any> = registry, rounds = 14): Promise<void> {
	for (let i = 0; i < rounds; i++) {
		await installQueues();
		for (const binding of BINDINGS) {
			await runDurableObjectAlarm(shard(binding));
		}
		if (sent.length > 0) {
			const batch = makeBatch([...sent]);
			sent.length = 0;
			await handleBatch(batch, consumerEnv, performers);
		}
		await runDurableObjectAlarm(runStub(runId));
	}
}

const jobIdOf = (runId: string, nodeId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findNode(nodeId)?.job_id as string | null);

const nodesOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) =>
		((instance as any).repo.views() as { id: string; state: string }[]).map((node) => [node.id, node.state] as const),
	);

/**
 * ノードの状態が変わらなくなるまでtickを回す
 * 掃除のalarmは終端後も張られ続けるので, alarmの枯渇では収束を判定できない
 * 収束させてから読むことで, 自然発火したtickと重なって値がずれるのを防ぐ
 */
async function settleRun(runId: string, rounds = 8): Promise<void> {
	let previous = '';
	for (let i = 0; i < rounds; i++) {
		const current = JSON.stringify(await nodesOf(runId));
		if (current === previous) return;
		previous = current;
		await runDurableObjectAlarm(runStub(runId));
	}
	throw new Error(`${rounds}回のtickでノードの状態が収束しない`);
}

const stateOf = (runId: string) =>
	runInDurableObject(runStub(runId), (instance) => (instance as any).repo.findRun()?.state as string | undefined);

describe('縦串: runの開始から完了まで', () => {
	it('fan-outを含むflowが最後まで進む', async () => {
		performed.length = 0;
		const runId = 'GREETINGS:slice1';
		const stub = runStub(runId);
		// 投入先を先に差し替える, 実キューへ出るとconsumerが自動で実行し, 差し替えたperformerが使われない
		await installQueues();

		const started = await stub.start({ flow: 'GREETINGS', input: { prefix: 'hello' } });
		expect(started).toEqual({ id: runId, created: true });
		// 同じrunIdの二度目は新しく作らない(ADR-0029)
		expect(await stub.start({ flow: 'GREETINGS', input: { prefix: 'hello' } })).toEqual({ id: runId, created: false });

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'PENDING', greet: 'PENDING', report: 'PENDING' });

		await settle(runId);

		expect(await stateOf(runId)).toBe('COMPLETED');
		const nodes = Object.fromEntries(await nodesOf(runId));
		// fan-outノードは展開され, 子は項番でIDが決まる(ADR-0032)
		expect(nodes).toMatchObject({
			list: 'COMPLETED',
			greet: 'COMPLETED',
			'greet:0': 'COMPLETED',
			'greet:1': 'COMPLETED',
			'greet:2': 'COMPLETED',
			report: 'COMPLETED',
		});

		// 前段の戻り値が後段のpayloadへ渡る, 子は並列に走るので順序は問わない
		const greeted = performed.filter((p) => p.binding === 'GREET').map((p) => (p.payload as { name: string }).name);
		expect([...greeted].sort()).toEqual(['hello-1', 'hello-2', 'hello-3']);
		// fan-outノードが渡すのは集計値のみ(ADR-0035)
		expect(performed.find((p) => p.binding === 'REPORT')?.payload).toEqual({ total: 3, failed: 0 });
	});

	it('performの中で足した子を親が待つ(ADR-0032)', async () => {
		performed.length = 0;
		const runId = 'GREETINGS:spawn1';
		await installQueues();
		await runStub(runId).start({ flow: 'GREETINGS', input: { prefix: 'sp' } });
		await settle(runId, spawningRegistry);

		const nodes = Object.fromEntries(await nodesOf(runId));
		// 子は`親:名前`に入り, fan-outノードの子孫として数えられる
		expect(nodes['greet:0:child']).toBe('COMPLETED');
		expect(nodes['report']).toBe('COMPLETED');
		expect(await stateOf(runId)).toBe('COMPLETED');
		// 3件の展開それぞれが子を1つ持つので6回走る
		expect(performed.filter((p) => p.binding === 'GREET')).toHaveLength(6);
	});

	it('ノードの失敗で下流が打ち切られrunがFAILEDになる', async () => {
		const runId = 'GREETINGS:fail1';
		const stub = runStub(runId);
		// 実際の完了通知が割り込むと失敗の検査にならないので, 投入先を先に差し替える
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'ng' } });

		// 先頭ノードを投入まで進めてから, 失敗の通知だけを手で届ける
		await settleRun(runId);
		// 投入されたメッセージは配送しない, 実行されると完了報告が返る
		sent.length = 0;
		const jobId = await jobIdOf(runId, 'list');
		// 通知はジョブIDで宛先を照合するので, 確定していなければ検査自体が成り立たない
		if (jobId === null) throw new Error('先頭ノードにジョブIDが入っていない');
		await stub.notify([{ nodeId: 'list', jobId, state: 'FAILED', result: null, error: '意図的な失敗' }]);
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'FAILED', greet: 'SKIPPED', report: 'SKIPPED' });
		expect(await stateOf(runId)).toBe('FAILED');

		// 再開すると打ち切ったノードが起動前へ戻る(ADR-0034)
		expect(await stub.retry()).toEqual({ ok: true });
		expect(await stateOf(runId)).toBe('RUNNING');
		await settle(runId);
		expect(await stateOf(runId)).toBe('COMPLETED');
	});

	it('取り消しは未起動を止めて終端を待つ', async () => {
		const runId = 'GREETINGS:cancel1';
		const stub = runStub(runId);
		await installQueues();
		await stub.start({ flow: 'GREETINGS', input: { prefix: 'ca' } });

		expect(await stub.cancel()).toEqual({ ok: true });
		await settleRun(runId);

		expect(Object.fromEntries(await nodesOf(runId))).toEqual({ list: 'CANCELLED', greet: 'CANCELLED', report: 'CANCELLED' });
		expect(await stateOf(runId)).toBe('CANCELLED');
		// 終端に達したrunは取り消せない
		expect(await stub.cancel()).toEqual({ ok: false, reason: 'invalid-state' });
	});

	it('runとノードがD1へ投影される(ADR-0008)', async () => {
		const runId = 'GREETINGS:slice2';
		await installQueues();
		await runStub(runId).start({ flow: 'GREETINGS', input: { prefix: 'proj' } });
		await settle(runId);

		const row = await env.TSUMUGI_DB.prepare('SELECT state, node_total, node_done FROM run WHERE id = ?')
			.bind(runId)
			.first<{ state: string; node_total: number; node_done: number }>();
		expect(row).toMatchObject({ state: 'COMPLETED', node_total: 6, node_done: 6 });

		const nodes = await env.TSUMUGI_DB.prepare('SELECT node_id, state, container FROM run_node WHERE run_id = ? ORDER BY position')
			.bind(runId)
			.all<{ node_id: string; state: string; container: number }>();
		expect(nodes.results.map((n) => n.node_id)).toEqual(['list', 'greet', 'report', 'greet:0', 'greet:1', 'greet:2']);
		expect(nodes.results.find((n) => n.node_id === 'greet')?.container).toBe(1);

		// ジョブ側にも宛先が入り, 画面から相互に辿れる(ADR-0015)
		const job = await env.TSUMUGI_DB.prepare('SELECT run_id, node_id FROM job WHERE run_id = ? AND node_id = ?')
			.bind(runId, 'list')
			.first<{ run_id: string; node_id: string }>();
		expect(job).toEqual({ run_id: runId, node_id: 'list' });
	});
});
