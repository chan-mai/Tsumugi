<script setup lang="ts">
const props = defineProps<ProsePreProps>();

const scrollContainer = useTemplateRef<HTMLElement>('scrollContainer');
const showScrollIndicator = ref(false);
const scrollIndicatorDismissed = ref(false);

function checkOverflow() {
	const element = scrollContainer.value;
	showScrollIndicator.value = Boolean(element && element.scrollWidth > element.clientWidth + 1);
}

let observer: ResizeObserver | undefined;

onMounted(() => {
	observer = new ResizeObserver(checkOverflow);
	if (scrollContainer.value) observer.observe(scrollContainer.value);
	nextTick(checkOverflow);
});

onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
	<div class="code-block">
		<div v-if="props.filename" class="code-header">
			<div class="mac-dots" aria-hidden="true">
				<span />
				<span />
				<span />
			</div>
			<span class="filename">{{ props.filename }}</span>
		</div>
		<div class="code-body">
			<div v-if="showScrollIndicator && !scrollIndicatorDismissed" class="scroll-indicator">{{ $t('code.scrollable') }}</div>
			<pre ref="scrollContainer" :class="props.class" tabindex="0" @scroll="scrollIndicatorDismissed = true"><slot /></pre>
		</div>
	</div>
</template>

<style scoped>
.code-block {
	margin-block: 1.5rem;
	overflow: hidden;
	border: 1px solid var(--color-divider);
	border-radius: 0.75rem;
	background-color: var(--color-bg-alt);
}

.code-header {
	display: flex;
	align-items: center;
	gap: 1rem;
	padding: 0.75rem 1rem;
	border-block-end: 1px solid var(--color-divider);
}

.mac-dots {
	display: flex;
	gap: 0.375rem;
}

.mac-dots span {
	display: block;
	width: 0.75rem;
	height: 0.75rem;
	border: 1px solid rgb(0 0 0 / 0.1);
	border-radius: 9999px;
}

.mac-dots span:nth-child(1) {
	background-color: #ff5f56;
}

.mac-dots span:nth-child(2) {
	background-color: #ffbd2e;
}

.mac-dots span:nth-child(3) {
	background-color: #27c93f;
}

.filename {
	overflow: hidden;
	color: var(--color-text-2);
	font-family: var(--font-mono);
	font-size: 0.75rem;
	font-weight: 500;
	letter-spacing: 0.025em;
	text-overflow: ellipsis;
	white-space: nowrap;
}

.code-body {
	position: relative;
}

pre {
	max-width: 100%;
	margin: 0;
	padding: 1rem 1.5rem;
	overflow-x: auto;
	background-color: transparent !important;
	font-size: 0.875rem;
	line-height: 1.7;
}

pre :deep(code) {
	display: block;
	min-width: max-content;
	padding: 0;
	background-color: transparent;
	color: inherit;
	font-family: var(--font-mono);
	font-size: inherit;
}

pre :deep(.line) {
	display: block;
}

/* 空行の高さを維持 */
pre :deep(.line:empty)::before {
	content: ' ';
}

.scroll-indicator {
	position: absolute;
	top: 0.375rem;
	right: 0.625rem;
	z-index: 10;
	padding: 0.125rem 0.5rem;
	border-radius: 0.25rem;
	background-color: var(--color-button-brand-bg);
	color: var(--color-button-brand-text);
	font-size: 0.75rem;
	pointer-events: none;
	animation: blink 1.5s infinite;
}

@keyframes blink {
	0%,
	100% {
		opacity: 0.4;
	}

	50% {
		opacity: 1;
	}
}
</style>
