export const LOG_MIN_INTERVAL_MS = 1_000;
export const LOG_MAX_CHARS = 2_000;
export const LOG_KEEP = 20;

export type JobLogEntry = {
	attempt: number;
	timestamp: number;
	message: string;
};
