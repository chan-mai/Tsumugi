<script setup lang="ts">
const props = defineProps<{ links: TocLink[] }>();

const flat = computed(() => props.links.flatMap((link) => [link, ...(link.children ?? [])]));
const active = ref('');

let observer: IntersectionObserver | undefined;

function observe() {
	observer?.disconnect();
	observer = new IntersectionObserver(
		(entries) => {
			const visible = entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target.id);
			if (visible.length) active.value = visible[0]!;
		},
		{ rootMargin: '-80px 0px -70% 0px' },
	);
	for (const link of flat.value) {
		const element = document.getElementById(link.id);
		if (element) observer.observe(element);
	}
}

onMounted(observe);
watch(flat, () => nextTick(observe));
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<nav v-if="flat.length" aria-label="このページの内容">
		<p class="mb-3 text-sm font-bold text-text-1">このページの内容</p>
		<ul class="text-sm">
			<li v-for="link in flat" :key="link.id">
				<a
					:href="`#${link.id}`"
					class="block py-1 transition"
					:class="[link.depth === 3 ? 'pl-3' : '', active === link.id ? 'text-brand-1' : 'text-text-3 hover:text-text-1']"
				>
					{{ link.text }}
				</a>
			</li>
		</ul>
	</nav>
</template>
