<script setup lang="ts">
import { Dialog, DialogPanel, TransitionChild, TransitionRoot } from '@headlessui/vue';

const route = useRoute();
const site = useSiteConfig();
const { sections } = useNavigation();
const localePath = useLocalePath();
const menuOpen = ref(false);
watch(
	() => route.fullPath,
	() => (menuOpen.value = false),
);

// リンク先と同じ区分のページで強調
function isActive(link: string) {
	return route.path.startsWith(link.slice(0, link.lastIndexOf('/') + 1));
}
</script>

<template>
	<header class="fixed inset-x-0 top-0 z-40 h-(--header-h) border-b border-divider bg-bg/90 backdrop-blur">
		<div class="mx-auto flex h-full max-w-[1440px] items-center gap-6 px-4 sm:px-6">
			<NuxtLink :to="localePath('/')" class="text-xl font-bold tracking-tight text-text-1">{{ site.name }}</NuxtLink>

			<nav class="ml-auto hidden items-center gap-8 text-sm lg:flex" :aria-label="$t('nav.global')">
				<NuxtLink
					v-for="item in sections"
					:key="item.link"
					:to="item.link"
					class="transition"
					:class="isActive(item.link) ? 'font-semibold text-brand-1' : 'text-text-1 hover:text-brand-1'"
				>
					{{ item.text }}
				</NuxtLink>
				<span class="h-4 w-px bg-border" aria-hidden="true" />
				<a
					v-for="social in socialLinks"
					:key="social.name"
					:href="social.link"
					target="_blank"
					rel="noopener"
					class="flex items-center gap-1.5 text-text-1 transition hover:text-brand-1"
				>
					<AppIcon :name="social.icon" class="size-4" />
					{{ social.name }}
				</a>
			</nav>

			<div class="ml-auto flex items-center gap-6 lg:ml-0">
				<LocaleMenu class="hidden sm:block" />
				<ThemeMenu class="hidden sm:block" />
				<SiteSearch />
				<button
					type="button"
					class="flex items-center gap-2 border-none text-sm text-text-1 transition hover:text-brand-1"
					@click="menuOpen = true"
				>
					<AppIcon name="menu" class="size-5" />
					<span class="hidden sm:inline">{{ $t('nav.allMenus') }}</span>
					<span class="sr-only sm:hidden">{{ $t('nav.menu') }}</span>
				</button>
			</div>
		</div>
	</header>

	<TransitionRoot :show="menuOpen" as="template">
		<Dialog class="relative z-50" @close="menuOpen = false">
			<TransitionChild as="template" enter="duration-200 ease-out" enter-from="opacity-0" leave="duration-150 ease-in" leave-to="opacity-0">
				<div class="fixed inset-0 bg-backdrop" aria-hidden="true" />
			</TransitionChild>
			<TransitionChild
				as="template"
				enter="duration-200 ease-out"
				enter-from="translate-x-full"
				leave="duration-150 ease-in"
				leave-to="translate-x-full"
			>
				<DialogPanel class="fixed inset-y-0 right-0 flex w-96 max-w-[90vw] flex-col overflow-y-auto bg-bg-elv px-6 py-5 shadow-xl">
					<div class="mb-6 flex items-center justify-between">
						<NuxtLink :to="localePath('/')" class="text-xl font-bold text-text-1">{{ site.name }}</NuxtLink>
						<button
							type="button"
							class="flex items-center gap-1.5 border-none text-sm text-text-1 hover:text-brand-1"
							@click="menuOpen = false"
						>
							<AppIcon name="close" class="size-5" />
							{{ $t('nav.close') }}
						</button>
					</div>
					<SiteSidebar @navigate="menuOpen = false" />
					<div class="mt-auto flex flex-col gap-4 border-t border-divider pt-6 text-sm">
						<LocaleMenu class="sm:hidden" />
						<ThemeMenu class="sm:hidden" />
						<a
							v-for="social in socialLinks"
							:key="social.name"
							:href="social.link"
							target="_blank"
							rel="noopener"
							class="flex items-center gap-2 text-text-1 hover:text-brand-1"
						>
							<AppIcon :name="social.icon" class="size-4" />
							{{ social.name }}
						</a>
					</div>
				</DialogPanel>
			</TransitionChild>
		</Dialog>
	</TransitionRoot>
</template>
