<script setup lang="ts">
definePageMeta({ layout: 'docs' });

const route = useRoute();
const config = useRuntimeConfig();
const path = computed(() => normalizePath(route.path));

const { data: page } = await useAsyncData(
	() => `docs:${path.value}`,
	() => queryCollection('docs').path(path.value).first(),
);
if (!page.value) throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true });

const description = computed(() => page.value?.description?.replaceAll('\n', ''));
usePageTitle(() => page.value?.title);
useSeoMeta({
	description,
	ogDescription: description,
});
defineOgImage('Page', {
	title: page.value.title,
	section: sidebar.find((group) => group.items.some((item) => item.link === path.value))?.text,
	description: description.value,
});

const pager = computed(() => surroundings(path.value));
const editLink = computed(() => `${config.public.repo}/edit/main/site/${page.value?.stem}.md`);
const dateFormat = new Intl.DateTimeFormat('ja-JP', { dateStyle: 'long', timeZone: 'UTC' });
const publishedAt = computed(() => (page.value ? dateFormat.format(new Date(page.value.publishedAt)) : ''));
const updatedAt = computed(() => (page.value ? dateFormat.format(new Date(page.value.updatedAt)) : ''));
const crumbs = computed(() => breadcrumbs(path.value, page.value?.title ?? ''));

const article = ref<HTMLElement | null>(null);

useMotion(({ gsap }) => {
	const play = () =>
		gsap.fromTo(article.value, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.35, ease: 'power2.out', clearProps: 'transform' });
	play();
	watch(path, () => nextTick(play));
});
</script>

<template>
	<div v-if="page" class="flex gap-10 px-6 py-10 sm:px-10 xl:pr-6">
		<article ref="article" class="min-w-0 max-w-3xl flex-1">
			<SiteBreadcrumb :items="crumbs" class="mb-8" />
			<ContentRenderer :value="page" class="leading-[1.9] wrap-anywhere" />

			<div class="mt-16 flex flex-wrap items-center justify-between gap-4 text-sm text-text-3">
				<a
					:href="editLink"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-1.5 font-medium text-brand-1 hover:underline"
				>
					<AppIcon name="edit" class="size-4" />
					このページを編集
				</a>
				<p class="flex flex-wrap gap-x-4">
					<span
						>公開日: <time :datetime="page.publishedAt">{{ publishedAt }}</time></span
					>
					<span
						>最終更新: <time :datetime="page.updatedAt">{{ updatedAt }}</time></span
					>
				</p>
			</div>

			<nav class="mt-8 grid gap-4 border-t border-divider pt-8 sm:grid-cols-2" aria-label="前後のページ">
				<NuxtLink
					v-if="pager.prev"
					:to="pager.prev.link"
					class="rounded-lg border border-divider px-4 py-3 transition hover:border-brand-3"
				>
					<span class="block text-xs text-text-3">前のページ</span>
					<span class="flex items-center gap-1 font-semibold text-brand-1"
						><AppIcon name="chevron-left" class="size-4" />{{ pager.prev.text }}</span
					>
				</NuxtLink>
				<span v-else />
				<NuxtLink
					v-if="pager.next"
					:to="pager.next.link"
					class="rounded-lg border border-divider px-4 py-3 text-right transition hover:border-brand-3"
				>
					<span class="block text-xs text-text-3">次のページ</span>
					<span class="flex items-center justify-end gap-1 font-semibold text-brand-1"
						>{{ pager.next.text }}<AppIcon name="chevron-right" class="size-4"
					/></span>
				</NuxtLink>
			</nav>
		</article>

		<aside
			class="sticky top-[calc(var(--header-h)+2.5rem)] hidden max-h-[calc(100dvh-var(--header-h)-5rem)] w-56 shrink-0 self-start overflow-y-auto xl:block"
		>
			<SiteToc :links="page.body.toc?.links ?? []" />
		</aside>
	</div>
</template>
