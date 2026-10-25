<template>
	<div class="min-h-dvh">
		<SiteHeader />
		<div class="mx-auto flex max-w-[1440px] pt-(--header-h)">
			<aside
				class="sticky top-(--header-h) hidden h-[calc(100dvh-var(--header-h))] w-72 shrink-0 overflow-y-auto border-r border-divider px-6 py-8 lg:block"
			>
				<SiteSidebar />
			</aside>
			<main class="min-w-0 flex-1">
				<slot />
			</main>
		</div>
	</div>
</template>
