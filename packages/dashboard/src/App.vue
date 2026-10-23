<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { tokenCookie, unauthorized } from './api';
import ConfirmDialog from './components/ConfirmDialog.vue';
import TokenPrompt from './components/TokenPrompt.vue';
import { MUTED_TEXT } from './ui';

const { t } = useI18n();
const canPromptToken = tokenCookie() !== null;

const session = ref(0);

function reload() {
	unauthorized.value = false;
	session.value++;
}
</script>

<template>
	<TokenPrompt v-if="unauthorized && canPromptToken" @saved="reload" />

	<div v-else-if="unauthorized" class="mx-auto mt-24 max-w-sm px-4">
		<div class="mb-4 flex items-center gap-2.5">
			<h1 class="text-sm font-bold tracking-tight">Tsumugi</h1>
		</div>
		<p :class="MUTED_TEXT">{{ t('app.notAuthorized') }}</p>
	</div>

	<RouterView v-else :key="session" />
	<ConfirmDialog />
</template>
