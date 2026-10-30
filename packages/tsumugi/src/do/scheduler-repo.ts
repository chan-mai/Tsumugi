import type { NormalizedSchedule } from '../core/recurring.js';
import { assignments, columnList, placeholders } from './bind.js';
import { applySchedulerSchema, SCHEDULER_COLUMNS, type ScheduleRow } from './scheduler-schema.js';

const SCHEDULE_SELECT = columnList(SCHEDULER_COLUMNS.schedule);

export type FiredPatch = {
	occurrence: number;
	jobId?: string;
	runId?: string;
};

/** SQLite読み書きのみ, 次回時刻計算はcore/recurring.ts(ADR-0018) */
export class SchedulerRepo {
	readonly sql: SqlStorage;

	constructor(storage: DurableObjectStorage) {
		this.sql = storage.sql;
		applySchedulerSchema(storage.sql);
	}

	#all<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: SqlStorageValue[]): T[] {
		return this.sql.exec<T>(query, ...bindings).toArray();
	}

	// nullの次回時刻は既存値維持
	#update(name: string, set: Record<string, SqlStorageValue>, nextOccurrenceAt: number | null, increment = ''): void {
		const columns = nextOccurrenceAt !== null ? { ...set, next_occurrence_at: nextOccurrenceAt } : set;
		this.sql.exec(`UPDATE schedule SET ${assignments(columns)}${increment} WHERE name = ?`, ...Object.values(columns), name);
	}

	readSetting(key: string): string | undefined {
		return this.#all<{ value: string }>(`SELECT value FROM setting WHERE key = ?`, key)[0]?.value;
	}

	writeSetting(key: string, value: string): void {
		this.sql.exec(`INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, value);
	}

	rows(): ScheduleRow[] {
		return this.#all<ScheduleRow>(`SELECT ${SCHEDULE_SELECT} FROM schedule ORDER BY name ASC`);
	}

	find(name: string): ScheduleRow | undefined {
		return this.#all<ScheduleRow>(`SELECT ${SCHEDULE_SELECT} FROM schedule WHERE name = ?`, name)[0];
	}

	insert(spec: NormalizedSchedule, nextOccurrenceAt: number, now: number): void {
		this.sql.exec(
			`INSERT INTO schedule (name, kind, target, every_ms, cron, time_zone, overlap, next_occurrence_at, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			spec.name,
			spec.kind,
			spec.target,
			spec.everyMs,
			spec.cron,
			spec.timeZone,
			spec.overlap,
			nextOccurrenceAt,
			now,
			now,
		);
	}

	updateSpec(spec: NormalizedSchedule, nextOccurrenceAt: number | null, now: number): void {
		this.#update(
			spec.name,
			{
				kind: spec.kind,
				target: spec.target,
				every_ms: spec.everyMs,
				cron: spec.cron,
				time_zone: spec.timeZone,
				overlap: spec.overlap,
				updated_at: now,
			},
			nextOccurrenceAt,
		);
	}

	remove(names: readonly string[]): void {
		if (names.length === 0) return;
		this.sql.exec(`DELETE FROM schedule WHERE name IN (${placeholders(names.length)})`, ...names);
	}

	due(now: number, limit: number): ScheduleRow[] {
		return this.#all<ScheduleRow>(
			`SELECT ${SCHEDULE_SELECT} FROM schedule WHERE next_occurrence_at <= ? AND paused = 0
			ORDER BY next_occurrence_at ASC, name ASC LIMIT ?`,
			now,
			limit,
		);
	}

	minNextRunAt(): number | null {
		return this.#all<{ min: number | null }>(`SELECT min(next_occurrence_at) AS min FROM schedule WHERE paused = 0`)[0]?.min ?? null;
	}

	setPaused(name: string, paused: boolean, nextOccurrenceAt: number | null, now: number): void {
		this.#update(name, { paused: paused ? 1 : 0, updated_at: now }, nextOccurrenceAt);
	}

	markFired(name: string, fired: FiredPatch, nextOccurrenceAt: number | null, now: number): void {
		this.#update(
			name,
			{
				last_occurrence_at: fired.occurrence,
				last_fired_at: now,
				last_job_id: fired.jobId ?? null,
				last_run_id: fired.runId ?? null,
				last_error: null,
				updated_at: now,
			},
			nextOccurrenceAt,
		);
	}

	markSkipped(name: string, nextOccurrenceAt: number, now: number): void {
		this.#update(name, { last_skipped_at: now, updated_at: now }, nextOccurrenceAt, ', skipped_count = skipped_count + 1');
	}

	markError(name: string, message: string, nextOccurrenceAt: number | null, now: number): void {
		this.#update(name, { last_error: message, updated_at: now }, nextOccurrenceAt);
	}
}
