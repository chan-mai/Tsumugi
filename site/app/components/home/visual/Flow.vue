<script setup lang="ts">
const nodes = [
	{ x: 30, y: 110 },
	{ x: 120, y: 40 },
	{ x: 120, y: 90 },
	{ x: 120, y: 140 },
	{ x: 120, y: 190 },
	{ x: 210, y: 110 },
];
const edges = [
	[0, 1],
	[0, 2],
	[0, 3],
	[0, 4],
	[1, 5],
	[2, 5],
	[3, 5],
	[4, 5],
] as const;

function path(from: number, to: number) {
	const a = nodes[from]!;
	const b = nodes[to]!;
	const mid = (a.x + b.x) / 2;
	return `M${a.x} ${a.y} C${mid} ${a.y} ${mid} ${b.y} ${b.x} ${b.y}`;
}
</script>

<template>
	<svg viewBox="0 0 240 230" class="w-full" aria-hidden="true">
		<path v-for="([from, to], index) in edges" :key="index" :d="path(from, to)" fill="none" class="stroke-brand-3" stroke-width="2" />
		<circle
			v-for="(node, index) in nodes"
			:key="index"
			:cx="node.x"
			:cy="node.y"
			:r="index === 0 || index === 5 ? 14 : 10"
			:class="index === 0 || index === 5 ? 'fill-brand-1' : 'fill-bg stroke-brand-1'"
			stroke-width="2"
		/>
	</svg>
</template>
