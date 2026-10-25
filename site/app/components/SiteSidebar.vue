<script setup lang="ts">
defineEmits<{ navigate: [] }>();

const route = useRoute();
const current = computed(() => normalizePath(route.path));
</script>

<template>
	<nav aria-label="サイドバー">
		<div v-for="group in sidebar" :key="group.text" class="mb-6">
			<p class="mb-2 text-sm font-bold text-text-1">{{ group.text }}</p>
			<ul>
				<li v-for="item in group.items" :key="item.link">
					<NuxtLink
						:to="item.link"
						class="block border-l py-1.5 pl-4 text-sm transition"
						:class="
							current === item.link
								? 'border-brand-1 font-semibold text-brand-1'
								: 'border-divider text-text-2 hover:border-text-3 hover:text-text-1'
						"
						@click="$emit('navigate')"
					>
						{{ item.text }}
					</NuxtLink>
				</li>
			</ul>
		</div>
	</nav>
</template>
