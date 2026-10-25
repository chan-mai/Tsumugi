<script setup lang="ts">
const { t } = useI18n();
const localePath = useLocalePath();
const actions = computed(() => [
	{ text: 'Getting Started', link: localePath('/guide/getting-started'), primary: true },
	{ text: t('home.overview'), link: localePath('/guide/overview') },
	{ text: 'GitHub', link: 'https://github.com/chan-mai/Tsumugi' },
	{ text: 'npm', link: 'https://www.npmjs.com/package/tsumugi' },
]);

const sceneReady = ref(false);
const root = ref<HTMLElement | null>(null);

useMotion(({ gsap }) => {
	const shown = { opacity: 1, y: 0, clearProps: 'opacity,transform,translate' };
	gsap
		.timeline({ defaults: { ease: 'power3.out' } })
		.fromTo('[data-hero-name]', { y: 32, opacity: 0 }, { ...shown, duration: 1 }, 0.15)
		.fromTo('[data-hero-tagline]', { y: 16, opacity: 0 }, { ...shown, duration: 0.8 }, 0.4)
		.fromTo('[data-hero-action]', { y: 12, opacity: 0 }, { ...shown, duration: 0.6, stagger: 0.06 }, 0.55);
}, root);

function isExternal(link: string) {
	return /^https?:\/\//.test(link);
}
</script>

<template>
	<section ref="root" class="relative flex h-[min(92vh,900px)] min-h-[600px] items-center justify-center overflow-hidden bg-hero-bg px-6">
		<ClientOnly>
			<LazyHeroScene
				class="transition-opacity duration-1000"
				:class="sceneReady ? 'opacity-100' : 'opacity-0'"
				@ready="sceneReady = true"
			/>
		</ClientOnly>
		<div class="relative text-center text-hero-text">
			<h1 data-hero-name class="text-7xl font-semibold tracking-tight [text-shadow:0_2px_24px_rgb(0_0_0/0.12)] sm:text-9xl">Tsumugi</h1>
			<p data-hero-tagline class="mt-6 text-lg tracking-wide [text-shadow:0_1px_12px_rgb(0_0_0/0.15)] sm:text-xl">
				A job management system designed for the Cloudflare stack.
			</p>
			<div class="mt-12 flex flex-wrap justify-center gap-3">
				<NuxtLink
					v-for="action in actions"
					:key="action.link"
					data-hero-action
					:to="action.link"
					:target="isExternal(action.link) ? '_blank' : undefined"
					:rel="isExternal(action.link) ? 'noopener' : undefined"
					class="rounded-full px-6 py-2.5 text-sm font-semibold backdrop-blur-md transition"
					:class="
						action.primary
							? 'bg-button-brand-bg text-button-brand-text hover:bg-button-brand-hover-bg'
							: 'bg-hero-text/20 text-hero-text ring-1 ring-hero-text/40 hover:bg-hero-text/30'
					"
				>
					{{ action.text }}
				</NuxtLink>
			</div>
		</div>
		<div class="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-b from-transparent to-bg" aria-hidden="true" />
	</section>
</template>
