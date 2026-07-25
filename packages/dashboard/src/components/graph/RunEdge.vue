<script setup lang="ts">
import { BaseEdge } from '@vue-flow/core';
import { computed } from 'vue';
import type { Point } from './runLayout';

/**
 * 直交の辺
 * 水平と垂直だけで走り, 角は円弧で丸める
 */
const props = defineProps<{
	markerEnd?: string;
	data: { route: Point[] };
}>();

/** 角の丸め, 短い区間では半分までに抑える */
const RADIUS = 8;

const path = computed(() => {
	const points = props.data.route;
	if (points.length < 2) return '';

	let d = `M${points[0]!.x} ${points[0]!.y}`;
	for (let i = 1; i < points.length - 1; i++) {
		const previous = points[i - 1]!;
		const corner = points[i]!;
		const next = points[i + 1]!;
		const incoming = Math.hypot(corner.x - previous.x, corner.y - previous.y);
		const outgoing = Math.hypot(next.x - corner.x, next.y - corner.y);
		const r = Math.min(RADIUS, incoming / 2, outgoing / 2);
		if (r <= 0) continue;
		const enter = { x: corner.x + (Math.sign(previous.x - corner.x) * r || 0), y: corner.y + (Math.sign(previous.y - corner.y) * r || 0) };
		const leave = { x: corner.x + (Math.sign(next.x - corner.x) * r || 0), y: corner.y + (Math.sign(next.y - corner.y) * r || 0) };
		d += ` L${enter.x} ${enter.y} Q${corner.x} ${corner.y} ${leave.x} ${leave.y}`;
	}
	const last = points[points.length - 1]!;
	return `${d} L${last.x} ${last.y}`;
});
</script>

<template>
	<BaseEdge :path="path" :marker-end="markerEnd" />
</template>
