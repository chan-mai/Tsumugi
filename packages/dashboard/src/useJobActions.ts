import { computed, ref, type Ref } from 'vue';
import { cancelJob, retryJob } from './api';

/**
 * retry / cancelの可否と実行
 * 一覧と詳細の両方で使用, 判定を2箇所に書くと必ずずれる
 */
export function useJobActions(source: Ref<{ state: string; retryable?: boolean } | null>) {
	const busy = ref(false);
	/** 410を受けたら以後は操作不可, 一覧はD1由来で再読込しても行は残る */
	const gone = ref(false);

	const canRetry = computed(() => !gone.value && !busy.value && source.value?.retryable !== false);
	const canCancel = computed(() => !gone.value && !busy.value && source.value?.state === 'SCHEDULED');

	/** retryableはサーバの近似, 実際に消えているかは操作して410が返って初めて判明 */
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

	return { busy, gone, canRetry, canCancel, goneReason, act, reset: () => (gone.value = false) };
}
