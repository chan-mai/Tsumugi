<script setup lang="ts">
import type { Run } from '../api';
import { at, columnClass, HEAD } from '../columns';
import StatusCell from './StatusCell.vue';

defineProps<{ runs: Run[] }>();
const emit = defineEmits<{ select: [id: string] }>();

const progressOf = (run: Run) => `${run.node_done} / ${run.node_total}`;
</script>

<template>
	<div class="relative w-full overflow-x-auto rounded-card border border-border">
		<table class="w-full caption-bottom text-sm">
			<thead class="[&_tr]:border-b [&_tr]:border-border">
				<tr>
					<th :class="HEAD">Flow</th>
					<th :class="[HEAD, columnClass('id')]">ID</th>
					<th :class="HEAD">Status</th>
					<th :class="HEAD">Nodes</th>
					<th :class="[HEAD, columnClass('updatedAt')]">Updated at</th>
				</tr>
			</thead>
			<tbody class="[&_tr:last-child]:border-0">
				<tr
					v-for="run in runs"
					:key="run.id"
					class="cursor-pointer border-b border-border transition-colors hover:bg-muted"
					@click="emit('select', run.id)"
				>
					<td class="p-4 align-middle">
						{{ run.flow }}
						<!-- ID列非表示の幅での行識別用 -->
						<span class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ run.id }}</span>
					</td>
					<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ run.id }}</td>
					<td class="p-4 align-middle"><StatusCell :state="run.state" /></td>
					<td class="p-4 align-middle tabular-nums">
						{{ progressOf(run) }}
						<span v-if="run.node_failed > 0" class="text-destructive">({{ run.node_failed }})</span>
					</td>
					<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(run.updated_at) }}</td>
				</tr>
				<tr v-if="runs.length === 0">
					<td colspan="5" class="h-24 text-center text-muted-foreground">No results.</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
