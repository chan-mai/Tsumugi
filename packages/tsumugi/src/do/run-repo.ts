import { asc, eq, getTableColumns, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { NodeOrigin, NodeState, NodeView, RunState } from '../core/run.js';
import type { NodeTrigger } from '../core/flow.js';
import { chunk } from './bind.js';
import { applyRunSchema, type NodeRow, type RunRow } from './run-schema.js';
import { node, run, runOutbox } from './run-tables.js';

const NODE_COLUMNS = Object.keys(getTableColumns(node)).length;
const OUTBOX_COLUMNS = Object.keys(getTableColumns(runOutbox)).length;

export const deadlineErrorOf = (deadlineMs: number | null) => `run deadline exceeded: ${deadlineMs}ms`;

export type NewNode = {
	id: string;
	binding: string;
	container: boolean;
	parent: string | null;
	origin: NodeOrigin;
	after: readonly string[];
	trigger?: NodeTrigger;
	seq: number;
	subflow?: string;
	payload?: string;
	options?: string;
};

export type NodePatch = {
	state?: NodeState;
	jobId?: string | null;
	childRunId?: string | null;
	result?: string | null;
	error?: string | null;
};

/** D1へのUPSERT内容そのもの, 投影側の追加読み取り不要(ADR-0008) */
export type RunSnapshot = {
	id: string;
	flow: string;
	state: string;
	input: string;
	created_at: number;
	updated_at: number;
	// 投影側のノード再読不要
	node_total: number;
	node_done: number;
	node_failed: number;
	parent_run_id: string | null;
	parent_node_id: string | null;
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
	child_run_id: string | null;
	// 通常ノードの戻り値はジョブ側で投影済み(ADR-0035)
	result: string | null;
	error: string | null;
	position: number;
	created_at: number;
	updated_at: number;
};

/** SQLite読み書きのみ, 進行判断は`core/run.ts`(ADR-0018) */
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

	// 同一runIdは同一DOで検査と挿入が不可分(ADR-0029)
	insertRun(input: {
		id: string;
		flow: string;
		input: string;
		shape: string;
		now: number;
		parent?: { runId: string; nodeId: string } | undefined;
		depth?: number;
		deadlineMs?: number;
	}): boolean {
		const inserted = this.db
			.insert(run)
			.values({
				id: input.id,
				flow: input.flow,
				state: 'RUNNING',
				input: input.input,
				shape: input.shape,
				cancelling: 0,
				parentRunId: input.parent?.runId ?? null,
				parentNodeId: input.parent?.nodeId ?? null,
				depth: input.depth ?? 0,
				parentNotified: 0,
				deadlineMs: input.deadlineMs ?? null,
				deadlineAt: input.deadlineMs !== undefined ? input.now + input.deadlineMs : null,
				expired: 0,
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

	markParentNotified(id: string, now: number): void {
		this.db.update(run).set({ parentNotified: 1, updatedAt: now }).where(eq(run.id, id)).run();
	}

	markCancelling(id: string, now: number): void {
		this.db.update(run).set({ cancelling: 1, updatedAt: now }).where(eq(run.id, id)).run();
	}

	markExpired(id: string, now: number): void {
		this.db.update(run).set({ expired: 1, updatedAt: now }).where(eq(run.id, id)).run();
	}

	insertNodes(nodes: readonly NewNode[], now: number): void {
		for (const part of chunk(nodes, NODE_COLUMNS)) {
			this.#insertNodeChunk(part, now);
		}
	}

	#insertNodeChunk(nodes: readonly NewNode[], now: number): void {
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
					trigger: n.trigger ?? 'success',
					payload: n.payload ?? null,
					options: n.options ?? null,
					subflow: n.subflow ?? null,
					jobId: null,
					childRunId: null,
					result: null,
					error: null,
					seq: n.seq,
					createdAt: now,
					updatedAt: now,
				})),
			)
			// 同一IDのspawnは既存維持(ADR-0032)
			.onConflictDoNothing()
			.run();
	}

	// result, errorは毎tick全件読み取りの負荷で除外
	views(): NodeView[] {
		const rows = this.db
			.select({
				id: node.id,
				state: node.state,
				container: node.container,
				subflow: node.subflow,
				parent: node.parent,
				origin: node.origin,
				after: node.after,
				trigger: node.trigger,
			})
			.from(node)
			.orderBy(asc(node.seq), asc(node.id))
			.all();
		return rows.map((row) => ({
			id: row.id,
			state: row.state as NodeState,
			container: row.container === 1,
			subflow: row.subflow !== null,
			parent: row.parent,
			origin: row.origin as NodeOrigin,
			after: JSON.parse(row.after) as string[],
			trigger: row.trigger as NodeTrigger,
		}));
	}

	findNode(id: string): NodeRow | undefined {
		const row = this.db.select().from(node).where(eq(node.id, id)).get();
		return row ? this.#toNodeRow(row) : undefined;
	}

	resultsOf(ids: readonly string[]): Map<string, unknown> {
		const results = new Map<string, unknown>();
		for (const part of chunk(ids, 1)) {
			const rows = this.db
				.select({ id: node.id, result: node.result })
				.from(node)
				.where(inArray(node.id, [...part]))
				.all();
			for (const row of rows) results.set(row.id, row.result === null ? undefined : (JSON.parse(row.result) as unknown));
		}
		return results;
	}

	updateNode(id: string, patch: NodePatch, now: number): void {
		const set: Record<string, unknown> = { updatedAt: now };
		if (patch.state !== undefined) set.state = patch.state;
		if (patch.jobId !== undefined) set.jobId = patch.jobId;
		if (patch.childRunId !== undefined) set.childRunId = patch.childRunId;
		if (patch.result !== undefined) set.result = patch.result;
		if (patch.error !== undefined) set.error = patch.error;
		this.db.update(node).set(set).where(eq(node.id, id)).run();
	}

	nextSeq(): number {
		const row = this.sql.exec<{ next: number | null }>(`SELECT max(seq) + 1 AS next FROM node`).one();
		return row.next ?? 0;
	}

	/**
	 * fan-outノードは子を再作成せず集約待ちへ, 再作成では成功済みの子も消失(ADR-0034)
	 * 子runIDも解除, 残すと旧い子の遅延通知が再開後を上書き
	 * fan-outの子は期限超過で中断分のみ, 実行済み失敗は集計値で後段へ反映済み
	 */
	resetForRetry(now: number, aborted: string | null): string[] {
		// 親への通知済みフラグ解除, 未解除では再開後の終端が親へ未通知
		// 期限の再計算と超過フラグ解除, 未解除では再開直後に再超過(ADR-0039)
		this.sql.exec(
			`UPDATE run SET
				state = 'RUNNING',
				parent_notified = 0,
				deadline_at = CASE WHEN deadline_ms IS NULL THEN deadline_at ELSE ? + deadline_ms END,
				expired = 0,
				updated_at = ?`,
			now,
			now,
		);
		// 子を戻すコンテナは集約待ちへ, COMPLETEDのままでは集計値が古いまま
		const containers = this.sql.exec<{ id: string }>(
			`UPDATE node SET state = 'RUNNING', updated_at = ?
			WHERE container = 1 AND state = 'COMPLETED' AND EXISTS(
				SELECT 1 FROM node child
				WHERE child.parent = node.id AND child.origin = 'fanOut' AND child.state = 'FAILED' AND child.error = ?
			)
			RETURNING id`,
			now,
			aborted,
		);
		const reopened = containers.toArray().map((row) => row.id);
		const cursor = this.sql.exec<{ id: string }>(
			`UPDATE node SET
				state = CASE WHEN container = 1 AND EXISTS(SELECT 1 FROM node child WHERE child.parent = node.id) THEN 'RUNNING' ELSE 'PENDING' END,
				job_id = CASE WHEN container = 1 THEN job_id ELSE NULL END,
				child_run_id = NULL,
				error = NULL,
				updated_at = ?
			WHERE state IN ('FAILED', 'STALLED', 'SKIPPED', 'CANCELLED')
				AND (origin <> 'fanOut' OR (state = 'FAILED' AND error = ?))
			RETURNING id`,
			now,
			aborted,
		);
		return [...reopened, ...cursor.toArray().map((row) => row.id)];
	}

	countNodes(): number {
		const row = this.db
			.select({ c: sql<number>`count(*)` })
			.from(node)
			.get();
		return row?.c ?? 0;
	}

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
			parent_run_id: row.parent_run_id,
			parent_node_id: row.parent_node_id,
		};
		this.db
			.insert(runOutbox)
			.values({ kind: 'run', target: row.id, snapshot: JSON.stringify(snapshot) })
			.run();
	}

	appendNodeOutbox(runId: string, ids: readonly string[]): void {
		// 追記側の列数で分割, 読み取り側のIDも上限内
		for (const part of chunk(ids, OUTBOX_COLUMNS)) {
			this.#appendNodeOutboxChunk(runId, part);
		}
	}

	#appendNodeOutboxChunk(runId: string, ids: readonly string[]): void {
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
						child_run_id: row.childRunId,
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

	hasOutbox(): boolean {
		return this.db.select({ seq: runOutbox.seq }).from(runOutbox).limit(1).get() !== undefined;
	}

	#toRunRow(row: typeof run.$inferSelect): RunRow {
		return {
			id: row.id,
			flow: row.flow,
			state: row.state,
			input: row.input,
			shape: row.shape,
			cancelling: row.cancelling,
			parent_run_id: row.parentRunId,
			parent_node_id: row.parentNodeId,
			depth: row.depth,
			parent_notified: row.parentNotified,
			deadline_ms: row.deadlineMs,
			deadline_at: row.deadlineAt,
			expired: row.expired,
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
			trigger: row.trigger,
			payload: row.payload,
			options: row.options,
			subflow: row.subflow,
			job_id: row.jobId,
			child_run_id: row.childRunId,
			result: row.result,
			error: row.error,
			seq: row.seq,
			created_at: row.createdAt,
			updated_at: row.updatedAt,
		};
	}
}
