import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { NormalizedSchedule } from '../core/recurring.js';
import { applySchedulerSchema, type ScheduleRow } from './scheduler-schema.js';
import { schedule, schedulerSetting, type ScheduleRecord } from './scheduler-tables.js';

/** 発火の記録, jobとflowで使用する列が入れ替わる */
export type FiredPatch = {
	occurrence: number;
	jobId?: string;
	runId?: string;
};

/**
 * Scheduler DOのSQLiteとの仲介
 * 次回時刻の計算はcore/recurring.tsが持ち、ここは読み書きのみ(ADR-0018)
 */
export class SchedulerRepo {
	readonly db: DrizzleSqliteDODatabase<Record<string, never>>;
	readonly sql: SqlStorage;

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applySchedulerSchema(storage.sql);
		this.db = drizzle(storage);
	}

	readSetting(key: string): string | undefined {
		return this.db.select().from(schedulerSetting).where(eq(schedulerSetting.key, key)).get()?.value;
	}

	writeSetting(key: string, value: string): void {
		this.db.insert(schedulerSetting).values({ key, value }).onConflictDoUpdate({ target: schedulerSetting.key, set: { value } }).run();
	}

	rows(): ScheduleRow[] {
		return this.db.select().from(schedule).orderBy(asc(schedule.name)).all().map(this.#toRow);
	}

	find(name: string): ScheduleRow | undefined {
		const record = this.db.select().from(schedule).where(eq(schedule.name, name)).get();
		return record === undefined ? undefined : this.#toRow(record);
	}

	insert(spec: NormalizedSchedule, nextRunAt: number, now: number): void {
		this.db
			.insert(schedule)
			.values({
				name: spec.name,
				kind: spec.kind,
				target: spec.target,
				everyMs: spec.everyMs,
				cron: spec.cron,
				timeZone: spec.timeZone,
				overlap: spec.overlap,
				nextRunAt,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	/** 定義変更の反映, 間隔が変わった場合だけnextRunAtを渡して更新 */
	updateSpec(spec: NormalizedSchedule, nextRunAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({
				kind: spec.kind,
				target: spec.target,
				everyMs: spec.everyMs,
				cron: spec.cron,
				timeZone: spec.timeZone,
				overlap: spec.overlap,
				...(nextRunAt !== null ? { nextRunAt } : {}),
				updatedAt: now,
			})
			.where(eq(schedule.name, spec.name))
			.run();
	}

	remove(names: readonly string[]): void {
		if (names.length === 0) return;
		this.db
			.delete(schedule)
			.where(inArray(schedule.name, [...names]))
			.run();
	}

	/** 発火時刻を迎えた行, 予定の早い順に有界で読む, 一時停止中は対象外 */
	due(now: number, limit: number): ScheduleRow[] {
		return this.db
			.select()
			.from(schedule)
			.where(and(lte(schedule.nextRunAt, now), eq(schedule.paused, 0)))
			.orderBy(asc(schedule.nextRunAt), asc(schedule.name))
			.limit(limit)
			.all()
			.map(this.#toRow);
	}

	/** 次のalarmを設定する時刻, 一時停止中を除き行が無ければnull */
	minNextRunAt(): number | null {
		const row = this.db
			.select({ min: sql<number | null>`min(${schedule.nextRunAt})` })
			.from(schedule)
			.where(eq(schedule.paused, 0))
			.get();
		return row?.min ?? null;
	}

	/** 一時停止の切り替え, 再開で予定が経過済みならnextRunAtで再計算値を受ける */
	setPaused(name: string, paused: boolean, nextRunAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({ paused: paused ? 1 : 0, ...(nextRunAt !== null ? { nextRunAt } : {}), updatedAt: now })
			.where(eq(schedule.name, name))
			.run();
	}

	/** 発火の記録, nextRunAtがnullなら手動発火で予定を進めない */
	markFired(name: string, fired: FiredPatch, nextRunAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({
				lastRunAt: fired.occurrence,
				lastFiredAt: now,
				lastJobId: fired.jobId ?? null,
				lastRunId: fired.runId ?? null,
				lastError: null,
				...(nextRunAt !== null ? { nextRunAt } : {}),
				updatedAt: now,
			})
			.where(eq(schedule.name, name))
			.run();
	}

	markSkipped(name: string, nextRunAt: number, now: number): void {
		this.db
			.update(schedule)
			.set({
				lastSkippedAt: now,
				skippedCount: sql`${schedule.skippedCount} + 1`,
				nextRunAt,
				updatedAt: now,
			})
			.where(eq(schedule.name, name))
			.run();
	}

	/** 失敗の記録, nextRunAtがnullなら行を進めず次のtickで再試行 */
	markError(name: string, message: string, nextRunAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({ lastError: message, ...(nextRunAt !== null ? { nextRunAt } : {}), updatedAt: now })
			.where(eq(schedule.name, name))
			.run();
	}

	#toRow(record: ScheduleRecord): ScheduleRow {
		return {
			name: record.name,
			kind: record.kind,
			target: record.target,
			every_ms: record.everyMs,
			cron: record.cron,
			time_zone: record.timeZone,
			overlap: record.overlap,
			paused: record.paused,
			next_run_at: record.nextRunAt,
			last_run_at: record.lastRunAt,
			last_fired_at: record.lastFiredAt,
			last_job_id: record.lastJobId,
			last_run_id: record.lastRunId,
			last_skipped_at: record.lastSkippedAt,
			skipped_count: record.skippedCount,
			last_error: record.lastError,
			created_at: record.createdAt,
			updated_at: record.updatedAt,
		};
	}
}
