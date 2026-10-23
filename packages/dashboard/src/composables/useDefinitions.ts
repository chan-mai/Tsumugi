import { ref } from 'vue';
import { getBindings, getFlows, getMetrics, isMetricsUnavailable, isUnauthorized, listSchedules } from '../api';


export const bindings = ref<string[]>([]);
export const flows = ref<string[]>([]);
export const definitionsReady = ref(false);
export const hasMetrics = ref(false);
export const hasSchedules = ref(false);

let definitions: Promise<void> | null = null;

export function loadDefinitions(): Promise<void> {
	definitions ??= Promise.all([getBindings(), getFlows()]).then(
		([available, defined]) => {
			bindings.value = available.bindings;
			flows.value = defined.flows;
			definitionsReady.value = true;
		},
		(error: unknown) => {
			// 401等の失敗はトークン入力後に再取得
			definitions = null;
			if (!isUnauthorized(error)) throw error;
		},
	);
	return definitions;
}

// 未設定は501, 認証前の401はトークン入力後に再確認
export async function detectFeatures() {
	const [metrics, schedules] = await Promise.allSettled([getMetrics({ hours: 24 }), listSchedules()]);
	// 501, 401以外の失敗は表示, 理由は各ページで表示
	const available = (result: PromiseSettledResult<unknown>) =>
		result.status === 'fulfilled' || (!isMetricsUnavailable(result.reason) && !isUnauthorized(result.reason));
	hasMetrics.value = available(metrics);
	hasSchedules.value = available(schedules);
}
