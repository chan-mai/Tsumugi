import { attemptsOf } from '../core/attempts.js';
import { nodeTiming } from '../core/node-timing.js';
import type { Run, RunListItem, RunNode } from '../core/entity/run.entity.js';
import { parseAttempts, parseJson } from './job.repository.js';
import { and, condition, whereOf } from './where.js';

export type RunListQuery = { state: string | null; flow: string | null; limit: number; offset: number };

export interface RunRepository {
	list(query: RunListQuery): Promise<{ runs: RunListItem[]; total: number }>;
	find(id: string): Promise<{ run: Run; nodes: RunNode[] } | null>;
}

export class RunReadRepository implements RunRepository {
	readonly #db: D1Database;

	constructor(db: D1Database) {
		this.#db = db;
	}

	async list({ state, flow, limit, offset }: RunListQuery): Promise<{ runs: RunListItem[]; total: number }> {
		const where = whereOf(and(state ? condition('state = ?', state) : undefined, flow ? condition('flow = ?', flow) : undefined));

		const [page, total] = await this.#db.batch([
			this.#db
				.prepare(
					`SELECT id, flow, state, node_total AS "nodeTotal", node_done AS "nodeDone", node_failed AS "nodeFailed",
						created_at AS "createdAt", updated_at AS "updatedAt"
					FROM run${where.sql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
				)
				.bind(...where.params, limit, offset),
			this.#db.prepare(`SELECT count(*) AS total FROM run${where.sql}`).bind(...where.params),
		]);
		return { runs: page!.results as RunListItem[], total: (total!.results[0] as { total: number } | undefined)?.total ?? 0 };
	}

	// グラフは1クエリで返却, 段組み描画に全ノード必要
	async find(id: string): Promise<{ run: Run; nodes: RunNode[] } | null> {
		const [runs, nodes] = await this.#db.batch([
			this.#db
				.prepare(
					`SELECT id, flow, state, input, node_total AS "nodeTotal", node_done AS "nodeDone", node_failed AS "nodeFailed",
						created_at AS "createdAt", updated_at AS "updatedAt", parent_run_id AS "parentRunId", parent_node_id AS "parentNodeId"
					FROM run WHERE id = ? LIMIT 1`,
				)
				.bind(id),
			this.#db
				.prepare(
					`SELECT n.node_id, n.binding, n.state, n.container, n.parent, n.origin, n."after", n.job_id, n.child_run_id,
						n.result, n.error, n.position, n.created_at, n.updated_at,
						j.state AS job_state, j.attempts AS job_attempts, j.created_at AS job_created_at, j.updated_at AS job_updated_at,
						j.dispatched_at AS job_dispatched_at, j.run_after AS job_run_after, j.attempts_log AS job_attempts_log,
						c.state AS child_state, c.created_at AS child_created_at, c.updated_at AS child_updated_at
					FROM run_node n
					LEFT JOIN job j ON j.id = n.job_id
					LEFT JOIN run c ON c.id = n.child_run_id
					WHERE n.run_id = ?
					ORDER BY n.position ASC`,
				)
				.bind(id),
		]);

		const found = runs!.results[0] as Run | undefined;
		if (!found) return null;
		return {
			run: found,
			nodes: (nodes!.results as JoinedNode[]).map((node) => {
				// 結合先なしは全列null
				const job =
					node.job_state != null
						? {
								state: node.job_state,
								attempts: node.job_attempts!,
								createdAt: node.job_created_at!,
								updatedAt: node.job_updated_at!,
								dispatchedAt: node.job_dispatched_at,
								runAfter: node.job_run_after,
							}
						: null;
				const child =
					node.child_state != null
						? { state: node.child_state, createdAt: node.child_created_at!, updatedAt: node.child_updated_at! }
						: null;
				return {
					id: node.node_id,
					binding: node.binding,
					state: node.state,
					container: node.container === 1,
					parent: node.parent,
					origin: node.origin,
					after: parseJson<string>(node.after),
					jobId: node.job_id,
					childRunId: node.child_run_id,
					result: node.result,
					error: node.error,
					position: node.position,
					createdAt: node.created_at,
					updatedAt: node.updated_at,
					...nodeTiming(job, child),
					attempts: job ? attemptsOf(job, parseAttempts(node.job_attempts_log)) : [],
				};
			}),
		};
	}
}

type JoinedNode = {
	node_id: string;
	binding: string;
	state: string;
	container: number;
	parent: string | null;
	origin: string;
	after: string;
	job_id: string | null;
	child_run_id: string | null;
	result: string | null;
	error: string | null;
	position: number;
	created_at: number;
	updated_at: number;
	job_state: string | null;
	job_attempts: number | null;
	job_created_at: number | null;
	job_updated_at: number | null;
	job_dispatched_at: number | null;
	job_run_after: number | null;
	job_attempts_log: string | null;
	child_state: string | null;
	child_created_at: number | null;
	child_updated_at: number | null;
};
