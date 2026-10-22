<script setup lang="ts">
import { computed } from 'vue';
import type { Job } from '../api';
import { at, columnClass, HEAD, visible } from '../columns';
import CheckBox from './CheckBox.vue';
import RowActions from './RowActions.vue';
import SortHeader from './SortHeader.vue';
import StatusCell from './StatusCell.vue';

const props = defineProps<{ jobs: Job[]; picked: string[]; sort: string; desc: boolean }>();
const emit = defineEmits<{
	select: [id: string];
	sort: [column: string];
	changed: [];
	message: [text: string];
	'update:picked': [ids: string[]];
}>();

const allPicked = computed(() => props.jobs.length > 0 && props.jobs.every((job) => props.picked.includes(job.id)));

function togglePick(id: string) {
	emit('update:picked', props.picked.includes(id) ? props.picked.filter((value) => value !== id) : [...props.picked, id]);
}

function toggleAll() {
	emit('update:picked', allPicked.value ? [] : props.jobs.map((job) => job.id));
}

const durationOf = (job: Job) =>
	job.dispatched_at && job.updated_at > job.dispatched_at ? `${job.updated_at - job.dispatched_at} ms` : '';
</script>

<template>
	<div class="relative w-full overflow-x-auto rounded-card border border-border">
		<table class="w-full caption-bottom text-sm">
			<thead class="[&_tr]:border-b [&_tr]:border-border">
				<tr>
					<th class="h-12 w-10 pl-4">
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded-sm border-none hover:bg-accent"
							aria-label="Select all rows"
							@click="toggleAll"
						>
							<CheckBox :checked="allPicked" />
						</button>
					</th>
					<th :class="HEAD">
						<SortHeader label="Binding" column="binding" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[HEAD, columnClass('id')]">ID</th>
					<th :class="HEAD">
						<SortHeader label="Status" column="state" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[HEAD, columnClass('startedAt')]">Started at</th>
					<th :class="[HEAD, columnClass('updatedAt')]">
						<SortHeader label="Updated at" column="updated_at" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[HEAD, columnClass('attempts')]">
						<SortHeader label="Attempts" column="attempts" :sort="sort" :desc="desc" @sort="emit('sort', $event)" />
					</th>
					<th :class="[HEAD, columnClass('processingTime')]">Processing time</th>
					<th class="h-12 w-12 px-4" />
				</tr>
			</thead>
			<tbody class="[&_tr:last-child]:border-0">
				<tr
					v-for="job in jobs"
					:key="job.id"
					class="cursor-pointer border-b border-border transition-colors hover:bg-muted"
					@click="emit('select', job.id)"
				>
					<td class="pl-4 align-middle" @click.stop>
						<button
							type="button"
							class="flex size-6 items-center justify-center rounded-sm border-none hover:bg-accent"
							:aria-label="`Select ${job.id}`"
							@click="togglePick(job.id)"
						>
							<CheckBox :checked="props.picked.includes(job.id)" />
						</button>
					</td>
					<td class="p-4 align-middle">
						{{ job.binding }}
						<!-- ID列非表示の幅での行識別用 -->
						<span v-if="visible.id" class="block font-mono text-xs break-all text-muted-foreground lg:hidden">{{ job.id }}</span>
					</td>
					<td class="p-4 align-middle font-mono text-xs text-muted-foreground" :class="columnClass('id')">{{ job.id }}</td>
					<td class="p-4 align-middle"><StatusCell :state="job.state" /></td>
					<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('startedAt')">{{ at(job.dispatched_at) }}</td>
					<td class="p-4 align-middle whitespace-nowrap" :class="columnClass('updatedAt')">{{ at(job.updated_at) }}</td>
					<td class="p-4 align-middle tabular-nums" :class="columnClass('attempts')">{{ job.attempts }} / {{ job.max_attempts }}</td>
					<td class="p-4 align-middle tabular-nums" :class="columnClass('processingTime')">{{ durationOf(job) }}</td>
					<td class="p-4 align-middle" @click.stop>
						<RowActions
							:job-id="job.id"
							:state="job.state"
							:retryable="job.retryable"
							@changed="emit('changed')"
							@message="emit('message', $event)"
						/>
					</td>
				</tr>
				<tr v-if="jobs.length === 0">
					<td colspan="9" class="h-24 text-center text-muted-foreground">No results.</td>
				</tr>
			</tbody>
		</table>
	</div>
</template>
