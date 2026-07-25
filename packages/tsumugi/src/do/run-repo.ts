import { asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { NodeOrigin, NodeState, NodeView, RunState } from '../core/run.js';
import { applyRunSchema, type NodeRow, type RunRow } from './run-schema.js';
import { node, run, runOutbox } from './run-tables.js';

export type NewNode = {
	id: string;
	binding: string;
	container: boolean;
	parent: string | null;
	origin: NodeOrigin;
	after: readonly string[];
	seq: number;
	/** 実行時に増えたノードだけが持つ, 静的ノードはflow定義から作る */
	payload?: string;
	options?: string;
};

export type NodePatch = {
	state?: NodeState;
	jobId?: string | null;
	result?: string | null;
	error?: string | null;
};

/** D1へUPSERTする内容そのもの, 投影側が追加の読み取りをしなくて済むようにする(ADR-0008) */
export type RunSnapshot = {
	id: string;
	flow: string;
	state: string;
	input: string;
	created_at: number;
	updated_at: number;
	/** 一覧で進捗を出すための集計, ノードを引き直さずに済ませる */
	node_total: number;
	node_done: number;
	node_failed: number;
};

export type NodeSnapshot = {
	run_id: string;
	node_id: string;
	binding: string;
	state: string;
	container: number;
	parent: string | null;
	origin: string;
	after: string;
	job_id: string | null;
	/**
	 * fan-outノードの集計値のみを持たせる(ADR-0035)
	 * 通常ノードの戻り値はジョブ側で投影済みなので, ここに持つと同じものを二度運ぶ
	 */
	result: string | null;
	error: string | null;
	/** 画面の並び順,投影のアウトボックス連番とは別物 */
	position: number;
	created_at: number;
	updated_at: number;
};

/**
 * Run DOのSQLiteとの橋渡し
 * 進行の判断は`core/run.ts`が持ち, ここは読み書きに徹する(ADR-0018)
 */
export class RunRepo {
	readonly db: DrizzleSqliteDODatabase<Record<string, never>>;
	readonly sql: SqlStorage;

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applyRunSchema(storage.sql);
		this.db = drizzle(storage);
	}

	findRun(): RunRow | undefined {
		const row = this.db.select().from(run).limit(1).get();
		return row ? this.#toRunRow(row) : undefined;
	}

	/** 開始を1回に絞る, 同じrunIdは必ず同じDOに当たるので検査と挿入が不可分になる(ADR-0029) */
	insertRun(input: { id: string; flow: string; input: string; shape: string; now: number }): boolean {
		const inserted = this.db
			.insert(run)
			.values({
				id: input.id,
				flow: input.flow,
				state: 'RUNNING',
				input: input.input,
				shape: input.shape,
				cancelling: 0,
				createdAt: input.now,
				updatedAt: input.now,
			})
			.onConflictDoNothing()
			.returning({ id: run.id })
			.all();
		return inserted.length > 0;
	}

	setRunState(id: string, state: RunState, now: number): void {
		this.db.update(run).set({ state, updatedAt: now }).where(eq(run.id, id)).run();
	}

	markCancelling(id: string, now: number): void {
		this.db.update(run).set({ cancelling: 1, updatedAt: now }).where(eq(run.id, id)).run();
	}

	insertNodes(nodes: readonly NewNode[], now: number): void {
		if (nodes.length === 0) return;
		this.db
			.insert(node)
			.values(
				nodes.map((n) => ({
					id: n.id,
					binding: n.binding,
					state: 'PENDING',
					container: n.container ? 1 : 0,
					parent: n.parent,
					origin: n.origin,
					after: JSON.stringify(n.after),
					payload: n.payload ?? null,
					options: n.options ?? null,
					jobId: null,
					result: null,
					error: null,
					seq: n.seq,
					createdAt: now,
					updatedAt: now,
				})),
			)
			// 同じIDのspawnは新規作成せず既存を残す(ADR-0032)
			.onConflictDoNothing()
			.run();
	}

	/**
	 * 進行判断に渡す射影
	 * resultとerrorは読まない, 全ノードを毎tick読むので本文を載せると展開数に比例して重くなる
	 */
	views(): NodeView[] {
		const rows = this.db
			.select({
				id: node.id,
				state: node.state,
				container: node.container,
				parent: node.parent,
				origin: node.origin,
				after: node.after,
			})
			.from(node)
			.orderBy(asc(node.seq), asc(node.id))
			.all();
		return rows.map((row) => ({
			id: row.id,
			state: row.state as NodeState,
			container: row.container === 1,
			parent: row.parent,
			origin: row.origin as NodeOrigin,
			after: JSON.parse(row.after) as string[],
		}));
	}

	findNode(id: string): NodeRow | undefined {
		const row = this.db.select().from(node).where(eq(node.id, id)).get();
		return row ? this.#toNodeRow(row) : undefined;
	}

	/** 写像関数へ渡す材料, 依存しているノードのぶんだけ引く */
	resultsOf(ids: readonly string[]): Map<string, unknown> {
		if (ids.length === 0) return new Map();
		const rows = this.db
			.select({ id: node.id, result: node.result })
			.from(node)
			.where(inArray(node.id, [...ids]))
			.all();
		return new Map(rows.map((row) => [row.id, row.result === null ? undefined : (JSON.parse(row.result) as unknown)]));
	}

	updateNode(id: string, patch: NodePatch, now: number): void {
		const set: Record<string, unknown> = { updatedAt: now };
		if (patch.state !== undefined) set.state = patch.state;
		if (patch.jobId !== undefined) set.jobId = patch.jobId;
		if (patch.result !== undefined) set.result = patch.result;
		if (patch.error !== undefined) set.error = patch.error;
		this.db.update(node).set(set).where(eq(node.id, id)).run();
	}

	/** 次に作るノードの並び順, 定義順と生成順を1本の連番で保つ */
	nextSeq(): number {
		const row = this.sql.exec<{ next: number | null }>(`SELECT max(seq) + 1 AS next FROM node`).one();
		return row.next ?? 0;
	}

	/**
	 * 再開のために打ち切られたノードを起動前へ戻す(ADR-0034)
	 * fan-outノードは子を作り直さず集約待ちへ戻す, 作り直すと成功済みの子も削除される
	 */
	resetForRetry(now: number): string[] {
		const cursor = this.sql.exec<{ id: string }>(
			`UPDATE node SET
				state = CASE WHEN container = 1 AND EXISTS(SELECT 1 FROM node child WHERE child.parent = node.id) THEN 'RUNNING' ELSE 'PENDING' END,
				job_id = CASE WHEN container = 1 THEN job_id ELSE NULL END,
				error = NULL,
				updated_at = ?
			WHERE state IN ('FAILED', 'STALLED', 'SKIPPED', 'CANCELLED')
			RETURNING id`,
			now,
		);
		return cursor.toArray().map((row) => row.id);
	}

	countNodes(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(node)
			.get();
		return row?.c ?? 0;
	}

	/** fan-outノードの集計値, 子を1文で数える(ADR-0035) */
	childSummary(parent: string): { total: number; succeeded: number; failed: number } {
		const row = this.sql
			.exec<{ total: number; succeeded: number }>(
				`SELECT count(*) AS total, sum(CASE WHEN state = 'COMPLETED' THEN 1 ELSE 0 END) AS succeeded
				 FROM node WHERE parent = ?`,
				parent,
			)
			.one();
		const total = row.total;
		const succeeded = row.succeeded ?? 0;
		return { total, succeeded, failed: total - succeeded };
	}

	/** 一覧の進捗に載せる集計, runのスナップショットに同梱する */
	progress(): { total: number; done: number; failed: number } {
		const row = this.sql
			.exec<{ total: number; done: number; failed: number }>(
				`SELECT count(*) AS total,
					sum(CASE WHEN state IN ('COMPLETED', 'FAILED', 'CANCELLED', 'STALLED', 'SKIPPED') THEN 1 ELSE 0 END) AS done,
					sum(CASE WHEN state IN ('FAILED', 'STALLED') THEN 1 ELSE 0 END) AS failed
				 FROM node`,
			)
			.one();
		return { total: row.total, done: row.done ?? 0, failed: row.failed ?? 0 };
	}

	appendRunOutbox(): void {
		const row = this.findRun();
		if (!row) return;
		const { total, done, failed } = this.progress();
		const snapshot: RunSnapshot = {
			id: row.id,
			flow: row.flow,
			state: row.state,
			input: row.input,
			created_at: row.created_at,
			updated_at: row.updated_at,
			node_total: total,
			node_done: done,
			node_failed: failed,
		};
		this.db
			.insert(runOutbox)
			.values({ kind: 'run', target: row.id, snapshot: JSON.stringify(snapshot) })
			.run();
	}

	appendNodeOutbox(runId: string, ids: readonly string[]): void {
		if (ids.length === 0) return;
		const rows = this.db
			.select()
			.from(node)
			.where(inArray(node.id, [...ids]))
			.all();
		if (rows.length === 0) return;
		this.db
			.insert(runOutbox)
			.values(
				rows.map((row) => {
					const snapshot: NodeSnapshot = {
						run_id: runId,
						node_id: row.id,
						binding: row.binding,
						state: row.state,
						container: row.container,
						parent: row.parent,
						origin: row.origin,
						after: row.after,
						job_id: row.jobId,
						result: row.container === 1 ? row.result : null,
						error: row.error,
						position: row.seq,
						created_at: row.createdAt,
						updated_at: row.updatedAt,
					};
					return { kind: 'node', target: row.id, snapshot: JSON.stringify(snapshot) };
				}),
			)
			.run();
	}

	outboxBatch(limit: number): { seq: number; kind: string; target: string; snapshot: string }[] {
		return this.db.select().from(runOutbox).orderBy(asc(runOutbox.seq)).limit(limit).all();
	}

	deleteOutboxThrough(seq: number): void {
		this.db.delete(runOutbox).where(lte(runOutbox.seq, seq)).run();
	}

	countOutbox(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(runOutbox)
			.get();
		return row?.c ?? 0;
	}

	#toRunRow(row: typeof run.$inferSelect): RunRow {
		return {
			id: row.id,
			flow: row.flow,
			state: row.state,
			input: row.input,
			shape: row.shape,
			cancelling: row.cancelling,
			created_at: row.createdAt,
			updated_at: row.updatedAt,
		};
	}

	#toNodeRow(row: typeof node.$inferSelect): NodeRow {
		return {
			id: row.id,
			binding: row.binding,
			state: row.state,
			container: row.container,
			parent: row.parent,
			origin: row.origin,
			after: row.after,
			payload: row.payload,
			options: row.options,
			job_id: row.jobId,
			result: row.result,
			error: row.error,
			seq: row.seq,
			created_at: row.createdAt,
			updated_at: row.updatedAt,
		};
	}
}
