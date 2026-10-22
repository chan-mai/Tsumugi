import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type { NormalizedSchedule } from '../core/recurring.js';
import { applySchedulerSchema, type ScheduleRow } from './scheduler-schema.js';
import { schedule, schedulerSetting, type ScheduleRecord } from './scheduler-tables.js';

export type FiredPatch = {
	occurrence: number;
	jobId?: string;
	runId?: string;
};

/** SQLite読み書きのみ, 次回時刻計算はcore/recurring.ts(ADR-0018) */
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

	insert(spec: NormalizedSchedule, nextOccurrenceAt: number, now: number): void {
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
				nextOccurrenceAt,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	}

	updateSpec(spec: NormalizedSchedule, nextOccurrenceAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({
				kind: spec.kind,
				target: spec.target,
				everyMs: spec.everyMs,
				cron: spec.cron,
				timeZone: spec.timeZone,
				overlap: spec.overlap,
				...(nextOccurrenceAt !== null ? { nextOccurrenceAt } : {}),
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

	due(now: number, limit: number): ScheduleRow[] {
		return this.db
			.select()
			.from(schedule)
			.where(and(lte(schedule.nextOccurrenceAt, now), eq(schedule.paused, 0)))
			.orderBy(asc(schedule.nextOccurrenceAt), asc(schedule.name))
			.limit(limit)
			.all()
			.map(this.#toRow);
	}

	minNextRunAt(): number | null {
		const row = this.db
			.select({ min: sql<number | null>`min(${schedule.nextOccurrenceAt})` })
			.from(schedule)
			.where(eq(schedule.paused, 0))
			.get();
		return row?.min ?? null;
	}

	setPaused(name: string, paused: boolean, nextOccurrenceAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({ paused: paused ? 1 : 0, ...(nextOccurrenceAt !== null ? { nextOccurrenceAt } : {}), updatedAt: now })
			.where(eq(schedule.name, name))
			.run();
	}

	markFired(name: string, fired: FiredPatch, nextOccurrenceAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({
				lastOccurrenceAt: fired.occurrence,
				lastFiredAt: now,
				lastJobId: fired.jobId ?? null,
				lastRunId: fired.runId ?? null,
				lastError: null,
				...(nextOccurrenceAt !== null ? { nextOccurrenceAt } : {}),
				updatedAt: now,
			})
			.where(eq(schedule.name, name))
			.run();
	}

	markSkipped(name: string, nextOccurrenceAt: number, now: number): void {
		this.db
			.update(schedule)
			.set({
				lastSkippedAt: now,
				skippedCount: sql`${schedule.skippedCount} + 1`,
				nextOccurrenceAt,
				updatedAt: now,
			})
			.where(eq(schedule.name, name))
			.run();
	}

	markError(name: string, message: string, nextOccurrenceAt: number | null, now: number): void {
		this.db
			.update(schedule)
			.set({ lastError: message, ...(nextOccurrenceAt !== null ? { nextOccurrenceAt } : {}), updatedAt: now })
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
			next_occurrence_at: record.nextOccurrenceAt,
			last_occurrence_at: record.lastOccurrenceAt,
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
