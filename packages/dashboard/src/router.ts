import { ChartColumn, Clock, ListTodo, Plug, Workflow } from '@lucide/vue';
import type { Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import DefaultLayout from './layouts/DefaultLayout.vue';
import BindingsPage from './pages/BindingsPage.vue';
import JobsPage from './pages/JobsPage.vue';
import MetricsPage from './pages/MetricsPage.vue';
import RunsPage from './pages/RunsPage.vue';
import SchedulesPage from './pages/SchedulesPage.vue';

declare module 'vue-router' {
	interface RouteMeta {
		/** i18nのキー */
		title?: string;
		icon?: Component;
		/** 構成依存のページ, 未構成ならナビゲーションから除外 */
		feature?: 'flows' | 'schedules' | 'metrics';
	}
}

export const router = createRouter({
	history: createWebHistory(),
	routes: [
		{
			path: '/',
			component: DefaultLayout,
			children: [
				{ path: '', redirect: { name: 'jobs' } },
				// NOTE: 詳細の開閉で一覧を再生成しないよう同一ルート
				{ path: 'jobs/:jobId?', name: 'jobs', component: JobsPage, meta: { title: 'nav.jobs', icon: ListTodo } },
				{ path: 'runs/:runId?', name: 'runs', component: RunsPage, meta: { title: 'nav.runs', icon: Workflow, feature: 'flows' } },
				{
					path: 'schedules',
					name: 'schedules',
					component: SchedulesPage,
					meta: { title: 'nav.schedules', icon: Clock, feature: 'schedules' },
				},
				{ path: 'bindings', name: 'bindings', component: BindingsPage, meta: { title: 'nav.bindings', icon: Plug } },
				{ path: 'metrics', name: 'metrics', component: MetricsPage, meta: { title: 'nav.metrics', icon: ChartColumn, feature: 'metrics' } },
			],
		},
		{ path: '/:pathMatch(.*)*', redirect: { name: 'jobs' } },
	],
});
