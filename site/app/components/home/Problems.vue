<script setup lang="ts">
const { tm, rt } = useI18n();
const items = computed(() =>
	(tm('home.problems.items') as Record<'title' | 'queues' | 'tsumugi', string>[]).map((item) => ({
		title: rt(item.title),
		queues: rt(item.queues),
		tsumugi: rt(item.tsumugi),
	})),
);
const localePath = useLocalePath();
</script>

<template>
	<HomeSection :heading="$t('home.problems.heading')" :lead="$t('home.problems.lead')">
		<ol class="grid gap-5 md:grid-cols-2">
			<li
				v-for="(problem, index) in items"
				:key="problem.title"
				data-reveal
				class="rounded-3xl border border-glass-border bg-glass-bg p-8 shadow-[0_12px_48px_-24px_rgb(0_0_0/0.18)] backdrop-blur-xl"
			>
				<p class="font-mono text-sm text-text-3">{{ String(index + 1).padStart(2, '0') }}</p>
				<h3 class="mt-3 text-xl font-semibold leading-snug text-text-1">{{ problem.title }}</h3>
				<dl class="mt-6 grid gap-4 text-sm leading-relaxed">
					<div class="grid grid-cols-[5.5rem_1fr] gap-3">
						<dt class="flex items-center gap-1.5 font-semibold text-text-3"><AppIcon name="close" class="size-3.5" />Queues</dt>
						<dd class="text-text-2">{{ problem.queues }}</dd>
					</div>
					<div class="grid grid-cols-[5.5rem_1fr] gap-3">
						<dt class="flex items-center gap-1.5 font-semibold text-brand-1"><AppIcon name="check" class="size-3.5" />Tsumugi</dt>
						<dd class="text-text-1">
							<HomeRichText :text="problem.tsumugi" />
						</dd>
					</div>
				</dl>
			</li>
		</ol>
		<div class="text-end">
			<NuxtLink data-reveal :to="localePath('/guide/overview')" class="mt-10 inline-flex items-center gap-1 text-brand-1 hover:underline">
				{{ $t('home.problems.more') }}<AppIcon name="chevron-right" class="size-4" />
			</NuxtLink>
		</div>
	</HomeSection>
</template>
