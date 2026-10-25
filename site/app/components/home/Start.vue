<script setup lang="ts">
const localePath = useLocalePath();
const commands = ['pnpm add tsumugi', 'npx tsumugi init'];
const copied = ref<string | null>(null);

async function copy(command: string) {
	await navigator.clipboard.writeText(command);
	copied.value = command;
	setTimeout(() => (copied.value = copied.value === command ? null : copied.value), 1500);
}
</script>

<template>
	<HomeSection heading="Getting Started">
		<div
			data-reveal
			class="relative overflow-hidden rounded-[2rem] border border-glass-border bg-glass-bg p-8 shadow-[0_12px_48px_-24px_rgb(0_0_0/0.18)] backdrop-blur-xl sm:p-12"
		>
			<ol class="grid gap-3">
				<li
					v-for="command in commands"
					:key="command"
					class="flex items-center gap-3 rounded-2xl bg-bg-alt px-5 py-4 font-mono text-sm sm:text-base"
				>
					<span class="text-text-3 select-none">$</span>
					<span class="flex-1 text-text-1">{{ command }}</span>
					<button
						type="button"
						class="grid size-8 place-items-center rounded-lg border-none text-text-2 transition hover:bg-default-soft hover:text-text-1"
						:aria-label="$t('home.start.copy', { command })"
						@click="copy(command)"
					>
						<AppIcon :name="copied === command ? 'check' : 'copy'" class="size-4" />
					</button>
				</li>
			</ol>
			<div class="mt-10 flex flex-wrap gap-3">
				<NuxtLink
					:to="localePath('/guide/getting-started')"
					class="rounded-full bg-button-brand-bg px-6 py-2.5 text-sm font-semibold text-button-brand-text transition hover:bg-button-brand-hover-bg"
				>
					Getting Started
				</NuxtLink>
				<NuxtLink
					:to="localePath('/guide/overview')"
					class="rounded-full bg-default-3 px-6 py-2.5 text-sm font-semibold text-text-1 transition hover:bg-default-2"
				>
					{{ $t('home.overview') }}
				</NuxtLink>
			</div>
		</div>
	</HomeSection>
</template>
