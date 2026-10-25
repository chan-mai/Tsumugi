<script setup lang="ts">
defineProps<{ heading: string; lead?: string }>();

const root = ref<HTMLElement | null>(null);

useMotion(({ gsap }) => {
	gsap.fromTo(
		root.value!.querySelectorAll('[data-reveal]'),
		{ y: 28, opacity: 0 },
		{
			y: 0,
			opacity: 1,
			duration: 0.8,
			ease: 'power3.out',
			stagger: 0.08,
			clearProps: 'opacity,transform,translate',
			scrollTrigger: { trigger: root.value, start: 'top 78%' },
		},
	);
}, root);
</script>

<template>
	<section ref="root" class="relative mx-auto max-w-6xl px-6 py-28">
		<h2 data-reveal class="text-4xl font-semibold tracking-tight text-text-1 sm:text-5xl">
			{{ heading }}
		</h2>
		<p v-if="lead" data-reveal class="mt-5 max-w-2xl text-lg text-text-2">{{ lead }}</p>
		<div class="mt-14">
			<slot />
		</div>
	</section>
</template>
