<script setup lang="ts">
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from '@lucide/vue';
import { useI18n } from 'vue-i18n';

const props = withDefaults(defineProps<{ page: number; pageSize: number; total: number; unit?: 'jobs' | 'runs' }>(), { unit: 'jobs' });
const emit = defineEmits<{ 'update:page': [value: number]; 'update:pageSize': [value: number] }>();
const { t } = useI18n();

const pageCount = () => Math.max(1, Math.ceil(props.total / props.pageSize));
const go = (value: number) => emit('update:page', Math.min(Math.max(value, 0), pageCount() - 1));
</script>

<template>
	<div class="flex flex-wrap items-center justify-between gap-3">
		<p class="text-sm text-ink-muted">{{ t(`pagination.${unit}`, { count: total }) }}</p>

		<div class="flex flex-wrap items-center gap-3 sm:gap-6">
			<div class="flex items-center gap-2">
				<span class="hidden text-sm text-ink-muted sm:inline">{{ t('pagination.rowsPerPage') }}</span>
				<select
					class="h-8 rounded-lg border border-line-strong bg-surface px-2 text-sm outline-none focus:border-accent-strong"
					:value="pageSize"
					@change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
				>
					<option v-for="size in [10, 20, 30, 50]" :key="size" :value="size">{{ size }}</option>
				</select>
			</div>

			<span class="text-sm whitespace-nowrap text-ink-muted tabular-nums">{{
				t('pagination.page', { page: page + 1, count: pageCount() })
			}}</span>

			<div class="flex items-center gap-1">
				<button
					v-for="control in [
						{ key: 'first', to: 0, disabled: page === 0, icon: ChevronsLeft },
						{ key: 'previous', to: page - 1, disabled: page === 0, icon: ChevronLeft },
						{ key: 'next', to: page + 1, disabled: page >= pageCount() - 1, icon: ChevronRight },
						{ key: 'last', to: pageCount() - 1, disabled: page >= pageCount() - 1, icon: ChevronsRight },
					]"
					:key="control.key"
					type="button"
					:aria-label="t(`pagination.${control.key}`)"
					:disabled="control.disabled"
					class="flex size-8 items-center justify-center rounded-lg border border-line-strong bg-surface text-ink hover:bg-canvas disabled:cursor-not-allowed disabled:text-ink-subtle"
					@click="go(control.to)"
				>
					<component :is="control.icon" class="size-4" aria-hidden="true" />
				</button>
			</div>
		</div>
	</div>
</template>
