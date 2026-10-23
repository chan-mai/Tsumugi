import { and, asc, desc as sqlDesc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { alias } from 'drizzle-orm/sqlite-core';
import { attemptsOf } from '../core/attempts.js';
import { nodeTiming } from '../core/node-timing.js';
import type { Run, RunListItem, RunNode } from '../core/entity/run.entity.js';
import { parseAttempts, parseJson } from './job.repository.js';
import { job as readModel } from '../projection/tables.js';
import { run as runModel, runNode } from '../projection/run-tables.js';

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
		const d = drizzle(this.#db);
		const filters = [state ? eq(runModel.state, state) : undefined, flow ? eq(runModel.flow, flow) : undefined].filter(
			(f) => f !== undefined,
		);
		const clause = filters.length > 0 ? and(...filters) : undefined;

		const [page, total] = await d.batch([
			d
				.select({
					id: runModel.id,
					flow: runModel.flow,
					state: runModel.state,
					nodeTotal: runModel.nodeTotal,
					nodeDone: runModel.nodeDone,
					nodeFailed: runModel.nodeFailed,
					createdAt: runModel.createdAt,
					updatedAt: runModel.updatedAt,
				})
				.from(runModel)
				.where(clause)
				.orderBy(sqlDesc(runModel.updatedAt), sqlDesc(runModel.id))
				.limit(limit)
				.offset(offset),
			d
				.select({ total: sql<number>`count(*)` })
				.from(runModel)
				.where(clause),
		]);
		return { runs: page, total: total[0]?.total ?? 0 };
	}

	// グラフは1クエリで返却, 段組み描画に全ノード必要
	async find(id: string): Promise<{ run: Run; nodes: RunNode[] } | null> {
		const d = drizzle(this.#db);
		const childRun = alias(runModel, 'child_run');
		const [runs, nodes] = await d.batch([
			d.select().from(runModel).where(eq(runModel.id, id)).limit(1),

			d
				.select({
					node: runNode,
					job: {
						state: sql<string>`${readModel.state}`.as('job_state'),
						attempts: sql<number>`${readModel.attempts}`.as('job_attempts'),
						createdAt: sql<number>`${readModel.createdAt}`.as('job_created_at'),
						updatedAt: sql<number>`${readModel.updatedAt}`.as('job_updated_at'),
						dispatchedAt: sql<number | null>`${readModel.dispatchedAt}`.as('job_dispatched_at'),
						runAfter: sql<number | null>`${readModel.runAfter}`.as('job_run_after'),
						attemptsLog: sql<string | null>`${readModel.attemptsLog}`.as('job_attempts_log'),
					},
					child: {
						state: sql<string>`${childRun.state}`.as('child_state'),
						createdAt: sql<number>`${childRun.createdAt}`.as('child_created_at'),
						updatedAt: sql<number>`${childRun.updatedAt}`.as('child_updated_at'),
					},
				})
				.from(runNode)
				.leftJoin(readModel, eq(readModel.id, runNode.jobId))
				.leftJoin(childRun, eq(childRun.id, runNode.childRunId))
				.where(eq(runNode.runId, id))
				.orderBy(asc(runNode.position)),
		]);

		const found = runs[0];
		if (!found) return null;
		return {
			run: {
				id: found.id,
				flow: found.flow,
				state: found.state,
				input: found.input,
				nodeTotal: found.nodeTotal,
				nodeDone: found.nodeDone,
				nodeFailed: found.nodeFailed,
				createdAt: found.createdAt,
				updatedAt: found.updatedAt,
				parentRunId: found.parentRunId,
				parentNodeId: found.parentNodeId,
			},
			nodes: nodes.map(({ node, job: joined, child: joinedChild }) => {
				// 結合先なしは全列null
				const job = joined?.state != null ? joined : null;
				const child = joinedChild?.state != null ? joinedChild : null;
				return {
					id: node.nodeId,
					binding: node.binding,
					state: node.state,
					container: node.container === 1,
					parent: node.parent,
					origin: node.origin,
					after: parseJson<string>(node.after),
					jobId: node.jobId,
					childRunId: node.childRunId,
					result: node.result,
					error: node.error,
					position: node.position,
					createdAt: node.createdAt,
					updatedAt: node.updatedAt,
					...nodeTiming(job, child),
					attempts: job ? attemptsOf(job, parseAttempts(job.attemptsLog)) : [],
				};
			}),
		};
	}
}
