<script setup lang="ts">
function onKeydown(event: KeyboardEvent) {
	if (
		(event.key === 'k' && (event.metaKey || event.ctrlKey)) ||
		(event.key === '/' && !(event.target as HTMLElement).closest('input, textarea, [role="listbox"]'))
	) {
		event.preventDefault();
		navigateTo({ path: '/search', query: { focus: '1' } });
	}
}

onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
	<NuxtLink
		to="/search"
		class="flex h-9 items-center gap-1.5 rounded-full bg-default-soft px-3.5 text-sm font-semibold text-text-1 transition hover:bg-default-3"
	>
		<AppIcon name="search" class="size-4 shrink-0" />
		検索
	</NuxtLink>
</template>
