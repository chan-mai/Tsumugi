import { computed, ref, type Ref } from 'vue';
import { cancelJob, retryJob } from './api';

export function useJobActions(source: Ref<{ state: string; retryable?: boolean } | null>) {
	const busy = ref(false);
	// 410受信後は操作不可, D1由来の一覧は再読込後も行が残存
	const gone = ref(false);

	const canRetry = computed(() => !gone.value && !busy.value && source.value?.retryable !== false);
	// QUEUED, RUNNINGは協調的な取り消し要求(ADR-0052)
	const canCancel = computed(() => !gone.value && !busy.value && ['SCHEDULED', 'QUEUED', 'RUNNING'].includes(source.value?.state ?? ''));

	// retryableはサーバ側の近似値, 実際の削除有無は410で判明
	const goneReason = computed(() =>
		gone.value || source.value?.retryable === false ? 'Removed from the coordinator after the retention period' : undefined,
	);

	async function act(kind: 'retry' | 'cancel', jobId: string): Promise<string> {
		busy.value = true;
		try {
			const result = await (kind === 'retry' ? retryJob(jobId) : cancelJob(jobId));
			if (result.gone) gone.value = true;
			return result.message;
		} catch {
			return 'Request failed';
		} finally {
			busy.value = false;
		}
	}

	return { busy, canRetry, canCancel, goneReason, act, reset: () => (gone.value = false) };
}
