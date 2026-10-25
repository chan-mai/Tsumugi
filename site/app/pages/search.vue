<script setup lang="ts">
import { Listbox, ListboxButton, ListboxOption, ListboxOptions } from '@headlessui/vue';

const scopes: SearchScope[] = [
	{ value: 'all', label: '全て', prefix: '/' },
	{ value: 'guide', label: 'ガイド', prefix: '/guide/' },
	{ value: 'reference', label: 'リファレンス', prefix: '/reference/' },
];
const perPage = 50;

usePageTitle('サイト内検索');
defineOgImage('Page', { title: 'サイト内検索' });

const route = useRoute();
const router = useRouter();

const q = computed(() => String(route.query.q ?? '').trim());
const scope = computed(() => scopes.find((item) => item.value === route.query.scope) ?? scopes[0]!);
const requestedPage = computed(() => Math.max(1, Number(route.query.page) || 1));

const draft = ref(q.value);
const draftScope = ref<SearchScope>(scope.value);
watch(q, (value) => (draft.value = value));
watch(scope, (value) => (draftScope.value = value));

const sections = ref<SearchSection[]>([]);
const loaded = ref(false);
const input = ref<HTMLInputElement | null>(null);
const resultHeading = ref<HTMLElement | null>(null);

onMounted(async () => {
	if (route.query.focus) input.value?.focus();
	sections.value = mergePageSections(await queryCollectionSearchSections('docs'));
	loaded.value = true;
});

// ページ自体の項目とh1見出しの項目を1件に統合
function mergePageSections(list: SearchSection[]): SearchSection[] {
	const roots = new Map(list.filter((s) => !s.id.includes('#')).map((s) => [s.id, s]));
	const merged: SearchSection[] = [];
	for (const section of list) {
		const path = section.id.split('#')[0]!;
		const root = roots.get(path);
		if (section.level === 1 && section.id.includes('#') && root) {
			root.content = [root.content, section.content].filter(Boolean).join(' ');
			continue;
		}
		merged.push(section);
	}
	return merged;
}

const pageTitles = computed(() => new Map(sections.value.filter((s) => !s.id.includes('#')).map((s) => [s.id, s.title])));

const terms = computed(() => q.value.toLowerCase().split(/\s+/).filter(Boolean));

const matches = computed(() => {
	if (!terms.value.length) return [];
	return sections.value.filter((section) => {
		if (!section.id.startsWith(scope.value.prefix)) return false;
		const text = `${section.titles.join(' ')} ${section.title} ${section.content}`.toLowerCase();
		return terms.value.every((term) => text.includes(term));
	});
});

const pageCount = computed(() => Math.max(1, Math.ceil(matches.value.length / perPage)));
const page = computed(() => Math.min(requestedPage.value, pageCount.value));
const from = computed(() => (page.value - 1) * perPage);
const results = computed(() =>
	matches.value.slice(from.value, from.value + perPage).map((section) => {
		const pageTitle = pageTitles.value.get(section.id.split('#')[0]!);
		return {
			id: section.id,
			title: highlight(pageTitle && pageTitle !== section.title ? `${section.title} | ${pageTitle}` : section.title),
			excerpt: highlight(excerpt(section.content)),
		};
	}),
);

function escapeRegExp(value: string) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function highlight(text: string): HighlightSegment[] {
	if (!terms.value.length) return [{ text, hit: false }];
	const pattern = new RegExp(`(${terms.value.map(escapeRegExp).join('|')})`, 'gi');
	return text
		.split(pattern)
		.filter(Boolean)
		.map((part) => ({ text: part, hit: terms.value.includes(part.toLowerCase()) }));
}

// 一致箇所の前後を最大3か所連結
function excerpt(content: string): string {
	const lower = content.toLowerCase();
	const windows: [number, number][] = [];
	for (const term of terms.value) {
		let index = lower.indexOf(term);
		while (index >= 0 && windows.length < 3) {
			const start = Math.max(0, index - 40);
			const end = Math.min(content.length, index + term.length + 60);
			const last = windows.at(-1);
			if (last && start <= last[1]) last[1] = Math.max(last[1], end);
			else windows.push([start, end]);
			index = lower.indexOf(term, end);
		}
	}
	if (!windows.length) return content.slice(0, 160) + (content.length > 160 ? '…' : '');
	windows.sort((a, b) => a[0] - b[0]);
	return windows
		.map(([start, end]) => `${start > 0 ? '…' : ''}${content.slice(start, end)}${end < content.length ? '…' : ''}`)
		.join('')
		.replace(/……/g, '…');
}

function submit() {
	router.push({
		query: {
			q: draft.value.trim() || undefined,
			scope: draftScope.value.value,
		},
	});
}

function pageLink(n: number) {
	return { query: { ...route.query, focus: undefined, page: n > 1 ? String(n) : undefined } };
}

watch(page, () => nextTick(() => resultHeading.value?.scrollIntoView({ block: 'start' })));
</script>

<template>
	<div class="mx-auto max-w-4xl px-6 pb-24 pt-14">
		<SiteBreadcrumb :items="[{ text: 'ホーム', link: '/' }, { text: 'サイト内検索' }]" class="mb-10" />
		<h1 class="text-4xl font-bold tracking-tight">サイト内検索</h1>

		<form class="mt-8" role="search" @submit.prevent="submit">
			<p id="search-scope-label" class="mb-2 text-sm font-bold">検索対象</p>
			<div class="flex gap-3">
				<div class="flex min-w-0 flex-1 rounded-lg has-[input:focus]:ring-4 has-[input:focus]:ring-brand-soft">
					<Listbox v-model="draftScope" by="value" as="div" class="relative">
						<ListboxButton
							aria-labelledby="search-scope-label"
							class="flex h-12 min-w-36 items-center justify-between gap-3 whitespace-nowrap rounded-l-lg border border-border bg-bg px-4 text-left"
						>
							<span>{{ draftScope.label }}</span>
							<AppIcon name="chevron-down" class="size-4 text-text-2" />
						</ListboxButton>
						<ListboxOptions
							class="absolute z-20 mt-1 w-full min-w-max overflow-hidden rounded-lg border border-divider bg-bg py-1 shadow-lg outline-none"
						>
							<ListboxOption v-for="item in scopes" :key="item.value" v-slot="{ active, selected }" :value="item" as="template">
								<li
									class="cursor-pointer whitespace-nowrap px-4 py-2"
									:class="[active ? 'bg-default-soft' : '', selected ? 'font-bold text-brand-1' : '']"
								>
									{{ item.label }}
								</li>
							</ListboxOption>
						</ListboxOptions>
					</Listbox>
					<input
						ref="input"
						v-model="draft"
						type="search"
						aria-label="検索キーワード"
						autocomplete="off"
						class="h-12 min-w-0 flex-1 rounded-r-lg border border-l-0 border-border bg-bg px-4 text-text-1 outline-none placeholder:text-text-3"
					/>
				</div>
				<button
					type="submit"
					class="flex h-12 shrink-0 items-center gap-2 rounded-lg border-none bg-button-brand-bg px-6 font-bold text-button-brand-text transition hover:bg-button-brand-hover-bg"
				>
					<AppIcon name="search" class="size-4" />
					検索
				</button>
			</div>
		</form>

		<section v-if="q" class="mt-16" aria-live="polite">
			<h2 ref="resultHeading" class="scroll-mt-24 text-3xl font-bold tracking-tight">{{ q }} の検索結果</h2>
			<template v-if="loaded">
				<p class="mt-4 text-text-2">
					<template v-if="matches.length">
						{{ matches.length }}件中、{{ from + 1 }}〜{{ from + results.length }}件を表示しています。
					</template>
					<template v-else>「{{ q }}」に一致するページはありません。</template>
				</p>

				<ul class="mt-6">
					<li v-for="result in results" :key="result.id" class="border-b border-divider py-6">
						<NuxtLink
							:to="result.id"
							class="text-lg font-bold text-brand-1 underline decoration-1 underline-offset-4 transition hover:decoration-2"
						>
							<template v-for="(segment, i) in result.title" :key="i">
								<mark v-if="segment.hit" class="bg-brand-soft text-inherit">{{ segment.text }}</mark>
								<template v-else>{{ segment.text }}</template>
							</template>
						</NuxtLink>
						<p class="mt-3 text-sm leading-relaxed text-text-2">
							<template v-for="(segment, i) in result.excerpt" :key="i">
								<mark v-if="segment.hit" class="bg-brand-soft text-text-1">{{ segment.text }}</mark>
								<template v-else>{{ segment.text }}</template>
							</template>
						</p>
					</li>
				</ul>

				<nav v-if="pageCount > 1" class="mt-10 flex flex-wrap items-center justify-center gap-2" aria-label="ページ送り">
					<NuxtLink
						v-if="page > 1"
						:to="pageLink(page - 1)"
						class="grid size-10 place-items-center rounded-lg text-text-2 hover:bg-default-soft"
						aria-label="前のページ"
					>
						<AppIcon name="chevron-left" class="size-4" />
					</NuxtLink>
					<NuxtLink
						v-for="n in pageCount"
						:key="n"
						:to="pageLink(n)"
						:aria-current="n === page ? 'page' : undefined"
						class="grid size-10 place-items-center rounded-lg text-sm font-semibold"
						:class="n === page ? 'bg-button-brand-bg text-button-brand-text' : 'text-text-2 hover:bg-default-soft'"
					>
						{{ n }}
					</NuxtLink>
					<NuxtLink
						v-if="page < pageCount"
						:to="pageLink(page + 1)"
						class="grid size-10 place-items-center rounded-lg text-text-2 hover:bg-default-soft"
						aria-label="次のページ"
					>
						<AppIcon name="chevron-right" class="size-4" />
					</NuxtLink>
				</nav>
			</template>
		</section>
	</div>
</template>
