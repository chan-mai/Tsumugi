<script setup lang="ts">
const root = ref<HTMLElement | null>(null);

useMotion(({ gsap }) => {
	gsap.fromTo('[data-showcase-back]', { y: 60 }, { y: -40, ease: 'none', scrollTrigger: { trigger: root.value, scrub: true } });
	gsap.fromTo('[data-showcase-front]', { y: 120 }, { y: -20, ease: 'none', scrollTrigger: { trigger: root.value, scrub: true } });
}, root);
</script>

<template>
	<div ref="root">
		<HomeSection :heading="$t('home.showcase.heading')">
			<div class="relative pb-24 lg:pb-40">
				<img
					data-showcase-back
					src="/dashboard-jobs.jpg"
					:alt="$t('home.showcase.jobsAlt')"
					loading="lazy"
					class="w-full rounded-3xl border border-glass-border shadow-[0_24px_80px_-32px_rgb(0_0_0/0.35)] lg:w-4/5"
				/>
				<img
					data-showcase-front
					src="/dashboard-run.jpg"
					:alt="$t('home.showcase.runAlt')"
					loading="lazy"
					class="relative mt-6 w-full rounded-3xl border border-glass-border shadow-[0_24px_80px_-32px_rgb(0_0_0/0.35)] lg:absolute lg:right-0 lg:bottom-0 lg:mt-0 lg:w-3/5"
				/>
			</div>
		</HomeSection>
	</div>
</template>
