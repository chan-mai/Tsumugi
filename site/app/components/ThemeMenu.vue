<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue';

const colorMode = useColorMode();

const options = [
	{ value: 'system', icon: 'monitor' },
	{ value: 'light', icon: 'sun' },
	{ value: 'dark', icon: 'moon' },
] as const;
</script>

<template>
	<Menu as="div" class="relative">
		<MenuButton class="flex items-center gap-1.5 border-none text-sm text-text-1 transition hover:text-brand-1">
			<ClientOnly>
				<AppIcon :name="colorMode.value === 'dark' ? 'moon' : 'sun'" class="size-4" />
				<template #fallback><AppIcon name="sun" class="size-4" /></template>
			</ClientOnly>
			{{ $t('theme.label') }}
			<AppIcon name="chevron-down" class="size-4" />
		</MenuButton>
		<transition
			enter-active-class="transition duration-100 ease-out"
			enter-from-class="scale-95 opacity-0"
			leave-active-class="transition duration-75 ease-in"
			leave-to-class="scale-95 opacity-0"
		>
			<MenuItems
				class="absolute right-0 z-50 mt-2 w-36 origin-top-right rounded-lg border border-divider bg-bg p-1 shadow-lg focus:outline-none"
			>
				<MenuItem v-for="option in options" :key="option.value" v-slot="{ active }">
					<button
						type="button"
						class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm border-none"
						:class="[active ? 'bg-default-soft' : '', colorMode.preference === option.value ? 'text-brand-1' : 'text-text-2']"
						@click="colorMode.preference = option.value"
					>
						<AppIcon :name="option.icon" class="size-4" />
						{{ $t(`theme.${option.value}`) }}
					</button>
				</MenuItem>
			</MenuItems>
		</transition>
	</Menu>
</template>
