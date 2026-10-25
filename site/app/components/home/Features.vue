<script setup lang="ts">
const { tm, rt } = useI18n();
const builtin = computed(() => (tm('home.features.builtin') as string[]).map((name) => rt(name)));
const card =
	'flex flex-col overflow-hidden rounded-3xl border border-glass-border bg-glass-bg p-6 sm:p-8 shadow-[0_12px_48px_-24px_rgb(0_0_0/0.18)] backdrop-blur-xl';
</script>

<template>
	<HomeSection :heading="$t('home.features.heading')">
		<div class="grid gap-5 lg:grid-cols-6">
			<article data-reveal :class="[card, 'lg:col-span-3']">
				<HomeVisualCompose />
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.compose.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.compose.body')" /></p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-3']">
				<ul class="flex flex-wrap gap-2">
					<li v-for="name in builtin" :key="name" class="rounded-full bg-brand-soft px-3.5 py-1.5 text-sm font-medium text-brand-1">
						{{ name }}
					</li>
				</ul>
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.builtinCard.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.builtinCard.body')" /></p>
			</article>

			<article data-reveal :class="[card, 'p-0 lg:col-span-4 lg:row-span-2']">
				<div class="p-6 sm:p-8">
					<h3 class="text-xl font-semibold text-text-1">{{ $t('home.features.history.title') }}</h3>
					<p class="mt-3 max-w-xl leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.history.body')" /></p>
				</div>
				<img
					src="/dashboard-jobs.jpg"
					:alt="$t('home.features.history.alt')"
					loading="lazy"
					class="mx-6 mt-auto mb-6 w-[calc(100%-3rem)] rounded-2xl border border-divider object-cover object-left-top shadow-xl sm:mx-8 sm:mb-8 sm:w-[calc(100%-4rem)]"
				/>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2 lg:row-span-2']">
				<HomeVisualFlow class="flex-1" />
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.flow.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.flow.body')" /></p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualAsync />
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.async.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.async.body')" /></p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualGuarantee />
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.guarantee.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.guarantee.body')" /></p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualRemote />
				<h3 class="mt-8 text-xl font-semibold text-text-1">{{ $t('home.features.remote.title') }}</h3>
				<p class="mt-3 leading-relaxed text-text-2"><HomeRichText :text="$t('home.features.remote.body')" /></p>
			</article>
		</div>
	</HomeSection>
</template>
