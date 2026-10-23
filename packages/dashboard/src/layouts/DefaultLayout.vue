<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue';
import { Menu } from '@lucide/vue';
import { onMounted, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import RefreshMenu from '../components/RefreshMenu.vue';
import SideNav from '../components/SideNav.vue';
import { refreshMs, useAutoRefresh } from '../composables/useAutoRefresh';
import { detectFeatures, loadDefinitions } from '../composables/useDefinitions';
import { button } from '../ui';

const { t } = useI18n();
const navigationOpen = ref(false);

const REPOSITORY = 'https://github.com/chan-mai/Tsumugi';
const year = new Date().getFullYear();
const FOOTER_LINK = 'text-ink-subtle underline-offset-2 hover:text-ink hover:underline';

useAutoRefresh();

onMounted(() => {
	void loadDefinitions().catch(() => {});
	void detectFeatures();
});
</script>

<template>
	<div class="h-dvh overflow-hidden">
		<aside class="fixed inset-y-0 left-0 hidden w-64 px-4 py-5 lg:block">
			<SideNav />
		</aside>

		<TransitionRoot :show="navigationOpen" as="template">
			<Dialog class="relative z-40 lg:hidden" @close="navigationOpen = false">
				<TransitionChild
					as="template"
					enter="duration-200 ease-out"
					enter-from="opacity-0"
					enter-to="opacity-100"
					leave="duration-150 ease-in"
					leave-from="opacity-100"
					leave-to="opacity-0"
				>
					<div class="fixed inset-0 bg-ink/40" aria-hidden="true" />
				</TransitionChild>
				<TransitionChild
					as="template"
					enter="duration-300 ease-out"
					enter-from="-translate-x-full"
					enter-to="translate-x-0"
					leave="duration-200 ease-in"
					leave-from="translate-x-0"
					leave-to="-translate-x-full"
				>
					<DialogPanel class="fixed inset-y-0 left-0 w-64 bg-canvas px-4 py-5">
						<SideNav @navigate="navigationOpen = false" />
					</DialogPanel>
				</TransitionChild>
			</Dialog>
		</TransitionRoot>

		<div class="flex h-full flex-col lg:pl-64">
			<header class="flex h-16 shrink-0 items-center gap-3 px-4 md:px-6 lg:px-8">
				<button
					type="button"
					:class="button('ghost')"
					class="size-9 p-0 lg:hidden"
					:aria-label="t('app.openNavigation')"
					@click="navigationOpen = true"
				>
					<Menu class="size-5" aria-hidden="true" />
				</button>
				<div class="ml-auto">
					<RefreshMenu v-model:interval="refreshMs" />
				</div>
			</header>

			<main
				class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain border-t border-line bg-surface px-4 pt-6 md:px-8 md:pt-8 lg:rounded-tl-4xl lg:border-l lg:px-10 lg:pt-9"
			>
				<div class="w-full">
					<RouterView />
				</div>
				<footer class="mt-auto flex w-full flex-wrap items-center gap-x-4 gap-y-1 pt-10 pb-6 text-xs text-ink-subtle">
					<span>&copy; 2026{{ year > 2026 ? `-${year}` : '' }} chan-mai</span>
					<a :href="`${REPOSITORY}/blob/develop/LICENSE`" target="_blank" rel="noopener noreferrer" :class="FOOTER_LINK">MIT License</a>
					<a :href="REPOSITORY" target="_blank" rel="noopener noreferrer" :class="FOOTER_LINK">GitHub</a>
				</footer>
			</main>
		</div>
	</div>
</template>
