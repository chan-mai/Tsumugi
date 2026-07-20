<script setup lang="ts">
import { ref } from 'vue';
import { saveToken } from '../api';

const emit = defineEmits<{ saved: [] }>();
const value = ref('');

function submit() {
	if (!value.value) return;
	saveToken(value.value);
	emit('saved');
}
</script>

<template>
	<div class="mx-auto mt-24 max-w-sm">
		<h1 class="mb-2 text-2xl font-bold">Tsumugi</h1>
		<p class="mb-4 text-sm opacity-60">Enter your access token to continue.</p>
		<form class="flex gap-2" @submit.prevent="submit">
			<input
				v-model="value"
				type="password"
				autocomplete="off"
				placeholder="Access token"
				class="flex-1 rounded border px-3 py-2 text-sm"
			/>
			<button type="submit" class="rounded border-none bg-slate-900 px-4 py-2 text-sm text-white">Sign in</button>
		</form>
	</div>
</template>
