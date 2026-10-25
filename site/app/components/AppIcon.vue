<script setup lang="ts">
defineProps<{ name: IconName }>();
</script>

<template>
	<svg v-if="name === 'github'" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2-.1-.3-.5-1.5.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 4.6 18.3 5 18.3 5c.6 1.7.2 2.9.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3"
		/>
	</svg>
	<svg v-else-if="name === 'npm'" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
		<path
			d="M0 7.3v8h6.7v1.4H12v-1.4h12v-8zm6.7 6.7H5.3v-4H4v4H1.3V8.7h5.4zm4 0v1.3H8V8.7h5.3V14h-2.6zm12 0h-1.4v-4H20v4h-1.3v-4h-1.4v4h-2.6V8.7h8z"
		/>
		<path d="M10.7 10H12v2.7h-1.3z" />
	</svg>
	<svg
		v-else
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		stroke-width="2"
		stroke-linecap="round"
		stroke-linejoin="round"
		aria-hidden="true"
	>
		<template v-if="name === 'search'">
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</template>
		<template v-else-if="name === 'menu'"><path d="M4 6h16M4 12h16M4 18h16" /></template>
		<template v-else-if="name === 'check'"><path d="M20 6 9 17l-5-5" /></template>
		<template v-else-if="name === 'copy'">
			<rect x="9" y="9" width="13" height="13" rx="2" />
			<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
		</template>
		<template v-else-if="name === 'close'"><path d="M6 6l12 12M18 6 6 18" /></template>
		<template v-else-if="name === 'sun'">
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
		</template>
		<template v-else-if="name === 'moon'"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8" /></template>
		<template v-else-if="name === 'languages'">
			<path d="m5 8 6 6M4 14l6-6 2-3M2 5h12M7 2h1M22 22l-5-10-5 10M14 18h6" />
		</template>
		<template v-else-if="name === 'monitor'">
			<rect x="2" y="3" width="20" height="14" rx="2" />
			<path d="M8 21h8M12 17v4" />
		</template>
		<template v-else-if="name === 'chevron-left'"><path d="m15 18-6-6 6-6" /></template>
		<template v-else-if="name === 'chevron-down'"><path d="m6 9 6 6 6-6" /></template>
		<template v-else-if="name === 'chevron-right'"><path d="m9 18 6-6-6-6" /></template>
		<template v-else-if="name === 'edit'"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></template>
	</svg>
</template>
