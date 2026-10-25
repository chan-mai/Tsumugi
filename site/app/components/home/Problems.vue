<script setup lang="ts">
const problems = [
	{
		title: 'ジョブの状態を管理しづらく、成功したジョブが残らない',
		queues: 'Queuesは、投入したメッセージの状態を問い合わせるAPIを提供していません。',
		tsumugi: 'TsumugiのダッシュボードとREST APIは、実行中のジョブと終了したジョブの両方について、一覧表示, 検索, 集計を提供します。',
	},
	{
		title: '排他制御と重複排除を実装しづらい',
		queues: 'Queuesは、メッセージ間の依存関係や関連性を管理しません。',
		tsumugi: 'Tsumugiでは、`concurrencyKey`を指定したジョブは、同じキーのものから1件ずつ順に実行されます。',
	},
	{
		title: 'ジョブの種類が増えるほど分岐が増える',
		queues: 'Queuesでは、1つのキューに対してconsumerを1つしか設定できません。',
		tsumugi: 'Tsumugiは、performerのexport名をbinding名としてジョブの種類を区別するため、consumerに分岐を書く必要がありません。',
	},
	{
		title: 'まれにメッセージが失われる',
		queues: 'Queuesは、処理されずに失われたメッセージを検出する手段を提供していません。',
		tsumugi: 'Tsumugiは、実行を開始したジョブから結果が報告されない場合、そのジョブを無応答と判定します。',
	},
];

// バッククォートで囲んだ部分をコードとして表示
function segments(text: string) {
	return text.split('`').map((value, index) => ({ value, code: index % 2 === 1 }));
}
</script>

<template>
	<HomeSection heading="何を解決するの" lead="Cloudflare Queuesをジョブキューとして直接使うといくつかの問題が生じます。">
		<ol class="grid gap-5 md:grid-cols-2">
			<li
				v-for="(problem, index) in problems"
				:key="problem.title"
				data-reveal
				class="rounded-3xl border border-glass-border bg-glass-bg p-8 shadow-[0_12px_48px_-24px_rgb(0_0_0/0.18)] backdrop-blur-xl"
			>
				<p class="font-mono text-sm text-text-3">{{ String(index + 1).padStart(2, '0') }}</p>
				<h3 class="mt-3 text-xl font-semibold leading-snug text-text-1">{{ problem.title }}</h3>
				<dl class="mt-6 grid gap-4 text-sm leading-relaxed">
					<div class="grid grid-cols-[5.5rem_1fr] gap-3">
						<dt class="flex items-center gap-1.5 font-semibold text-text-3"><AppIcon name="close" class="size-3.5" />Queues</dt>
						<dd class="text-text-2">{{ problem.queues }}</dd>
					</div>
					<div class="grid grid-cols-[5.5rem_1fr] gap-3">
						<dt class="flex items-center gap-1.5 font-semibold text-brand-1"><AppIcon name="check" class="size-3.5" />Tsumugi</dt>
						<dd class="text-text-1">
							<template v-for="(segment, i) in segments(problem.tsumugi)" :key="i">
								<code v-if="segment.code" class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1">{{
									segment.value
								}}</code>
								<template v-else>{{ segment.value }}</template>
							</template>
						</dd>
					</div>
				</dl>
			</li>
		</ol>
		<div class="text-end">
			<NuxtLink data-reveal to="/guide/overview" class="mt-10 inline-flex items-center gap-1 text-brand-1 hover:underline">
				概要を見る<AppIcon name="chevron-right" class="size-4" />
			</NuxtLink>
		</div>
	</HomeSection>
</template>
