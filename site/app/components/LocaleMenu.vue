<script setup lang="ts">
import { Menu, MenuButton, MenuItem, MenuItems } from '@headlessui/vue';

const { locale, locales } = useI18n();
const switchLocalePath = useSwitchLocalePath();
</script>

<template>
	<Menu as="div" class="relative">
		<MenuButton class="flex items-center gap-1.5 border-none text-sm text-text-1 transition hover:text-brand-1">
			<AppIcon name="languages" class="size-4" />
			{{ $t('nav.language') }}
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
				<MenuItem v-for="item in locales" :key="item.code" v-slot="{ active, close }">
					<NuxtLink
						:to="switchLocalePath(item.code)"
						:hreflang="item.language"
						:lang="item.language"
						:aria-current="item.code === locale ? 'true' : undefined"
						class="flex w-full items-center rounded-md px-3 py-2 text-sm"
						:class="[active ? 'bg-default-soft' : '', item.code === locale ? 'text-brand-1' : 'text-text-2']"
						@click="close"
					>
						{{ item.name }}
					</NuxtLink>
				</MenuItem>
			</MenuItems>
		</transition>
	</Menu>
</template>
