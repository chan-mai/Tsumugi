import { useDocumentVisibility, useIntervalFn, useStorage } from '@vueuse/core';
import { ref, watch } from 'vue';
import { DEFAULT_REFRESH_MS, parseRefresh, REFRESH_KEY } from '../refresh';

export const refreshMs = useStorage(REFRESH_KEY, DEFAULT_REFRESH_MS, undefined, {
	serializer: { read: parseRefresh, write: String },
});

const refreshTick = ref(0);

export function useAutoRefresh() {
	const visibility = useDocumentVisibility();
	const { pause, resume } = useIntervalFn(
		() => {
			if (visibility.value === 'visible') refreshTick.value++;
		},
		refreshMs,
		{ immediate: false },
	);
	watch(refreshMs, (ms) => (ms > 0 ? resume() : pause()), { immediate: true });
}

export function onRefresh(callback: () => void) {
	watch(refreshTick, callback);
}
