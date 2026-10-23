<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { saveToken } from '../api';
import { button, INPUT } from '../ui';

const emit = defineEmits<{ saved: [] }>();
const { t } = useI18n();
const value = ref('');

function submit() {
	if (!value.value) return;
	saveToken(value.value);
	emit('saved');
}
</script>

<template>
	<div class="mx-auto mt-24 max-w-sm px-4">
		<div class="mb-6 flex items-center gap-2.5">
			<h1 class="text-sm font-bold tracking-tight">Tsumugi</h1>
		</div>
		<form class="rounded-2xl border border-line bg-surface p-6" @submit.prevent="submit">
			<label class="mb-1 block text-sm font-medium" for="access-token">{{ t('token.placeholder') }}</label>
			<div class="flex gap-2">
				<input id="access-token" v-model="value" type="password" autocomplete="off" :class="INPUT" />
				<button type="submit" :class="button('primary')">{{ t('token.signIn') }}</button>
			</div>
		</form>
	</div>
</template>
