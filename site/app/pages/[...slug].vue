<script setup lang="ts">
definePageMeta({ layout: 'docs' });

const route = useRoute();
const config = useRuntimeConfig();
const { locale, locales } = useI18n();
const { groupOf, surroundings, breadcrumbs } = useNavigation();
const path = computed(() => normalizePath(route.path));
const siteLocale = computed(() => toSiteLocale(locale.value));
const sourcePath = computed(() => path.value.replace(new RegExp(`^/${siteLocale.value}(?=/)`), ''));

const { data } = await useAsyncData(
	() => `docs:${path.value}`,
	async () => {
		if (siteLocale.value !== 'ja') {
			const translated = await queryCollection(docsCollections[siteLocale.value]).path(path.value).first();
			if (translated) return { page: translated, untranslated: false };
		}
		const page = await queryCollection('docs_ja').path(sourcePath.value).first();
		return page ? { page, untranslated: siteLocale.value !== 'ja' } : null;
	},
);
if (!data.value) throw createError({ statusCode: 404, statusMessage: 'Page not found', fatal: true });
const page = computed(() => data.value?.page);
const untranslated = computed(() => data.value?.untranslated ?? false);

const description = computed(() => page.value?.description?.replaceAll('\n', ''));
usePageTitle(() => page.value?.title);
useSeoMeta({
	description,
	ogDescription: description,
});
defineOgImage('Page', {
	title: data.value.page.title,
	section: groupOf(path.value)?.text,
	description: description.value,
});

const pager = computed(() => surroundings(path.value));
const editLink = computed(() => `${config.public.repo}/edit/main/site${sourcePath.value}.md`);
const dateFormat = computed(
	() => new Intl.DateTimeFormat(locales.value.find((item) => item.code === locale.value)?.language, { dateStyle: 'long', timeZone: 'UTC' }),
);
const publishedAt = computed(() => (page.value ? dateFormat.value.format(new Date(page.value.publishedAt)) : ''));
const updatedAt = computed(() => (page.value ? dateFormat.value.format(new Date(page.value.updatedAt)) : ''));
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
			<Callout v-if="untranslated" type="info"
				><p>{{ $t('doc.untranslated') }}</p></Callout
			>
			<ContentRenderer :value="page" class="leading-[1.9] wrap-anywhere" />

			<div class="mt-16 flex flex-wrap items-center justify-between gap-4 text-sm text-text-3">
				<a
					:href="editLink"
					target="_blank"
					rel="noopener"
					class="inline-flex items-center gap-1.5 font-medium text-brand-1 hover:underline"
				>
					<AppIcon name="edit" class="size-4" />
					{{ $t('doc.edit') }}
				</a>
				<p class="flex flex-wrap gap-x-4">
					<span
						>{{ $t('doc.publishedAt') }}: <time :datetime="page.publishedAt">{{ publishedAt }}</time></span
					>
					<span
						>{{ $t('doc.updatedAt') }}: <time :datetime="page.updatedAt">{{ updatedAt }}</time></span
					>
				</p>
			</div>

			<nav class="mt-8 grid gap-4 border-t border-divider pt-8 sm:grid-cols-2" :aria-label="$t('doc.pager')">
				<NuxtLink
					v-if="pager.prev"
					:to="pager.prev.link"
					class="rounded-lg border border-divider px-4 py-3 transition hover:border-brand-3"
				>
					<span class="block text-xs text-text-3">{{ $t('doc.prev') }}</span>
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
					<span class="block text-xs text-text-3">{{ $t('doc.next') }}</span>
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
