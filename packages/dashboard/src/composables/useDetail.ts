import { useRoute, useRouter } from 'vue-router';

/** 詳細はリソースのURI, 一覧ページの上にパネル表示 */
export function useDetail() {
	const route = useRoute();
	const router = useRouter();

	// 同じ一覧内の移動はフィルタ条件維持
	const queryFor = (list: 'jobs' | 'runs') => (route.name === list ? route.query : {});

	const openJob = (jobId: string) => router.push({ name: 'jobs', params: { jobId }, query: queryFor('jobs') });
	const openRun = (runId: string) => router.push({ name: 'runs', params: { runId }, query: queryFor('runs') });

	// アプリ内遷移で開いた場合は直前の画面, 直接開いた場合は一覧
	const close = (list: 'jobs' | 'runs') => (window.history.state?.back ? router.back() : router.push({ name: list, query: route.query }));

	return { openJob, openRun, close };
}
