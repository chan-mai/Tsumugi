import type { NodeOrigin, NodeState, NodeView, RunState } from '../core/run.js';
import type { NodeTrigger } from '../core/flow.js';
import { assignments, chunk, columnList, placeholders, valuesOf } from './bind.js';
import { applyRunSchema, RUN_COLUMNS, type NodeRow, type RunRow } from './run-schema.js';

const RUN_SELECT = columnList(RUN_COLUMNS.run);
const NODE_SELECT = columnList(RUN_COLUMNS.node);

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

type NodePatch = {
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
	readonly sql: SqlStorage;

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applyRunSchema(storage.sql);
	}

	#all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...bindings).toArray();
	}

	findRun(): RunRow | undefined {
		return this.#all<RunRow>(`SELECT ${RUN_SELECT} FROM run LIMIT 1`)[0];
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
		const inserted = this.#all(
			`INSERT INTO run (${RUN_SELECT}) VALUES (${placeholders(RUN_COLUMNS.run.length)}) ON CONFLICT DO NOTHING RETURNING id`,
			...valuesOf(RUN_COLUMNS.run, {
				id: input.id,
				flow: input.flow,
				state: 'RUNNING',
				input: input.input,
				shape: input.shape,
				cancelling: 0,
				parent_run_id: input.parent?.runId ?? null,
				parent_node_id: input.parent?.nodeId ?? null,
				depth: input.depth ?? 0,
				parent_notified: 0,
				deadline_ms: input.deadlineMs ?? null,
				deadline_at: input.deadlineMs !== undefined ? input.now + input.deadlineMs : null,
				expired: 0,
				created_at: input.now,
				updated_at: input.now,
			}),
		);
		return inserted.length > 0;
	}

	setRunState(id: string, state: RunState, now: number): void {
		this.sql.exec(`UPDATE run SET state = ?, updated_at = ? WHERE id = ?`, state, now, id);
	}

	markParentNotified(id: string, now: number): void {
		this.sql.exec(`UPDATE run SET parent_notified = 1, updated_at = ? WHERE id = ?`, now, id);
	}

	markCancelling(id: string, now: number): void {
		this.sql.exec(`UPDATE run SET cancelling = 1, updated_at = ? WHERE id = ?`, now, id);
	}

	markExpired(id: string, now: number): void {
		this.sql.exec(`UPDATE run SET expired = 1, updated_at = ? WHERE id = ?`, now, id);
	}

	insertNodes(nodes: readonly NewNode[], now: number): void {
		for (const part of chunk(nodes, RUN_COLUMNS.node.length)) {
			this.#insertNodeChunk(part, now);
		}
	}

	#insertNodeChunk(nodes: readonly NewNode[], now: number): void {
		const row = `(${placeholders(RUN_COLUMNS.node.length)})`;
		this.sql.exec(
			// 同一IDのspawnは既存維持(ADR-0032)
			`INSERT INTO node (${NODE_SELECT}) VALUES ${nodes.map(() => row).join(', ')} ON CONFLICT DO NOTHING`,
			...nodes.flatMap((n) =>
				valuesOf(RUN_COLUMNS.node, {
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
					job_id: null,
					child_run_id: null,
					result: null,
					error: null,
					seq: n.seq,
					created_at: now,
					updated_at: now,
				}),
			),
		);
	}

	// result, errorは毎tick全件読み取りの負荷で除外
	views(): NodeView[] {
		const rows = this.#all<Pick<NodeRow, 'id' | 'state' | 'container' | 'subflow' | 'parent' | 'origin' | 'after' | 'trigger'>>(
			`SELECT id, state, container, subflow, parent, origin, "after", "trigger" FROM node ORDER BY seq ASC, id ASC`,
		);
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
		return this.#all<NodeRow>(`SELECT ${NODE_SELECT} FROM node WHERE id = ?`, id)[0];
	}

	resultsOf(ids: readonly string[]): Map<string, unknown> {
		const results = new Map<string, unknown>();
		for (const part of chunk(ids, 1)) {
			const rows = this.#all<{ id: string; result: string | null }>(
				`SELECT id, result FROM node WHERE id IN (${placeholders(part.length)})`,
				...part,
			);
			for (const row of rows) results.set(row.id, row.result === null ? undefined : (JSON.parse(row.result) as unknown));
		}
		return results;
	}

	updateNode(id: string, patch: NodePatch, now: number): void {
		const set: Record<string, SqlStorageValue> = { updated_at: now };
		if (patch.state !== undefined) set.state = patch.state;
		if (patch.jobId !== undefined) set.job_id = patch.jobId;
		if (patch.childRunId !== undefined) set.child_run_id = patch.childRunId;
		if (patch.result !== undefined) set.result = patch.result;
		if (patch.error !== undefined) set.error = patch.error;
		this.sql.exec(`UPDATE node SET ${assignments(set)} WHERE id = ?`, ...Object.values(set), id);
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
		return this.sql.exec<{ c: number }>(`SELECT count(*) AS c FROM node`).one().c;
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
		this.sql.exec(`INSERT INTO run_outbox (kind, target, snapshot) VALUES (?, ?, ?)`, 'run', row.id, JSON.stringify(snapshot));
	}

	appendNodeOutbox(runId: string, ids: readonly string[]): void {
		// 追記側の列数で分割, 読み取り側のIDも上限内
		for (const part of chunk(ids, RUN_COLUMNS.run_outbox.length)) {
			this.#appendNodeOutboxChunk(runId, part);
		}
	}

	#appendNodeOutboxChunk(runId: string, ids: readonly string[]): void {
		const rows = this.#all<NodeRow>(`SELECT ${NODE_SELECT} FROM node WHERE id IN (${placeholders(ids.length)})`, ...ids);
		if (rows.length === 0) return;
		this.sql.exec(
			`INSERT INTO run_outbox (kind, target, snapshot) VALUES ${rows.map(() => '(?, ?, ?)').join(', ')}`,
			...rows.flatMap((row) => {
				const snapshot: NodeSnapshot = {
					run_id: runId,
					node_id: row.id,
					binding: row.binding,
					state: row.state,
					container: row.container,
					parent: row.parent,
					origin: row.origin,
					after: row.after,
					job_id: row.job_id,
					child_run_id: row.child_run_id,
					result: row.container === 1 ? row.result : null,
					error: row.error,
					position: row.seq,
					created_at: row.created_at,
					updated_at: row.updated_at,
				};
				return ['node', row.id, JSON.stringify(snapshot)];
			}),
		);
	}

	outboxBatch(limit: number): { seq: number; kind: string; target: string; snapshot: string }[] {
		return this.#all<{ seq: number; kind: string; target: string; snapshot: string }>(
			`SELECT seq, kind, target, snapshot FROM run_outbox ORDER BY seq ASC LIMIT ?`,
			limit,
		);
	}

	deleteOutboxThrough(seq: number): void {
		this.sql.exec(`DELETE FROM run_outbox WHERE seq <= ?`, seq);
	}

	hasOutbox(): boolean {
		return this.#all(`SELECT seq FROM run_outbox LIMIT 1`).length > 0;
	}
}
