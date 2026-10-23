<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { flows, hasMetrics, hasSchedules } from '../composables/useDefinitions';
import { locale, LOCALES } from '../i18n';

const emit = defineEmits<{ navigate: [] }>();
const { t } = useI18n();
const router = useRouter();

const available = { flows: () => flows.value.length > 0, schedules: () => hasSchedules.value, metrics: () => hasMetrics.value };

const items = computed(() =>
	router.getRoutes().filter((route) => route.name && route.meta.title && (!route.meta.feature || available[route.meta.feature]())),
);
</script>

<template>
	<div class="flex h-full flex-col">
		<div class="mb-7 flex items-center gap-2.5 px-2">
			<span class="truncate text-sm font-bold tracking-tight">Tsumugi</span>
		</div>
		<nav class="flex-1 space-y-1">
			<RouterLink
				v-for="item in items"
				:key="item.path"
				:to="{ name: item.name! }"
				class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-ink-muted no-underline transition-colors hover:bg-surface hover:text-ink"
				active-class="bg-accent-soft text-accent-strong hover:bg-accent-soft hover:text-accent-strong"
				@click="emit('navigate')"
			>
				<component :is="item.meta.icon" class="size-4.5 shrink-0" aria-hidden="true" />
				{{ t(item.meta.title!) }}
			</RouterLink>
		</nav>
		<div class="mt-3 flex gap-1 rounded-xl bg-neutral-soft p-1" role="group" :aria-label="t('app.language')">
			<button
				v-for="option in LOCALES"
				:key="option.key"
				type="button"
				class="h-8 flex-1 rounded-lg border-none text-xs font-medium transition-colors"
				:class="locale === option.key ? 'bg-surface text-ink' : 'bg-transparent text-ink-muted hover:text-ink'"
				:aria-pressed="locale === option.key"
				@click="locale = option.key"
			>
				{{ option.label }}
			</button>
		</div>
	</div>
</template>
