<script setup lang="ts">
const props = defineProps<{ page: number; pageSize: number; total: number }>();
const emit = defineEmits<{ 'update:page': [value: number]; 'update:pageSize': [value: number] }>();

const pageCount = () => Math.max(1, Math.ceil(props.total / props.pageSize));
const go = (value: number) => emit('update:page', Math.min(Math.max(value, 0), pageCount() - 1));
</script>

<template>
	<div class="flex flex-wrap items-center justify-between gap-3 px-2">
		<p class="text-sm text-muted-foreground">{{ total }} jobs</p>

		<div class="flex flex-wrap items-center gap-3 sm:gap-6">
			<div class="flex items-center gap-2">
				<!-- 狭い画面では文言を落として選択欄だけ残す -->
				<span class="hidden text-sm font-medium sm:inline">Rows per page</span>
				<select
					class="h-8 rounded-card border border-border bg-background px-2 text-sm"
					:value="pageSize"
					@change="emit('update:pageSize', Number(($event.target as HTMLSelectElement).value))"
				>
					<option v-for="size in [10, 20, 30, 50]" :key="size" :value="size">{{ size }}</option>
				</select>
			</div>

			<span class="text-sm font-medium whitespace-nowrap">Page {{ page + 1 }} of {{ pageCount() }}</span>

			<div class="flex items-center gap-2">
				<button
					v-for="control in [
						{ label: 'First', to: 0, disabled: page === 0, path: 'M10 3.5L5.5 8l4.5 4.5M6 3.5v9' },
						{ label: 'Previous', to: page - 1, disabled: page === 0, path: 'M10 3.5L5.5 8l4.5 4.5' },
						{ label: 'Next', to: page + 1, disabled: page >= pageCount() - 1, path: 'M6 3.5L10.5 8 6 12.5' },
						{ label: 'Last', to: pageCount() - 1, disabled: page >= pageCount() - 1, path: 'M6 3.5L10.5 8 6 12.5M10 3.5v9' },
					]"
					:key="control.label"
					type="button"
					:aria-label="control.label"
					:disabled="control.disabled"
					class="flex size-8 items-center justify-center rounded-card border border-border bg-background hover:bg-accent disabled:opacity-40"
					@click="go(control.to)"
				>
					<svg viewBox="0 0 16 16" class="size-4" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round">
						<path :d="control.path" />
					</svg>
				</button>
			</div>
		</div>
	</div>
</template>
