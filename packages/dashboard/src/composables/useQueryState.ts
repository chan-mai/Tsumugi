import { useRouteQuery } from '@vueuse/router';
import { fromDateInput, toDateInput } from '../dates';

// 既定値はクエリ省略
const OPTIONS = { mode: 'push' } as const;

const first = (raw: unknown): string => (Array.isArray(raw) ? String(raw[0] ?? '') : typeof raw === 'string' ? raw : '');

export const useQueryText = (name: string) => useRouteQuery<string, string>(name, '', { ...OPTIONS, transform: { get: first } });

export const useQueryChoice = <T extends string>(name: string, choices: readonly T[], fallback: T) =>
	useRouteQuery<string, T>(name, fallback, {
		...OPTIONS,
		transform: { get: (raw) => choices.find((choice) => choice === first(raw)) ?? fallback },
	});

export const useQueryInteger = (name: string, fallback: number, min: number) =>
	useRouteQuery<string, number>(name, String(fallback), {
		...OPTIONS,
		transform: {
			get: (raw) => {
				const value = Number(first(raw));
				return Number.isInteger(value) && value >= min ? value : fallback;
			},
			set: String,
		},
	});

/** YYYY-MM-DD, 値は日の始端または終端のepochミリ秒 */
export const useQueryDate = (name: string, edge: 'start' | 'end') =>
	useRouteQuery<string, number | null>(name, '', {
		...OPTIONS,
		transform: { get: (raw) => fromDateInput(first(raw), edge), set: (value) => toDateInput(value) },
	});
