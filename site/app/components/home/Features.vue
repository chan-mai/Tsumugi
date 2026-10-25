<script setup lang="ts">
const builtin = ['リトライ', 'バックオフ', '予約実行', '定期実行', '優先度', '同時実行数', 'レート制限', '重複排除', 'ダッシュボード'];
const card =
	'flex flex-col overflow-hidden rounded-3xl border border-glass-border bg-glass-bg p-6 sm:p-8 shadow-[0_12px_48px_-24px_rgb(0_0_0/0.18)] backdrop-blur-xl';
</script>

<template>
	<HomeSection heading="機能">
		<div class="grid gap-5 lg:grid-cols-6">
			<article data-reveal :class="[card, 'lg:col-span-3']">
				<HomeVisualCompose />
				<h3 class="mt-8 text-xl font-semibold text-text-1">performerとenqueueで構成</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					利用者は、ジョブの処理をperformerとして定義し、投入する箇所でenqueueを呼び出します。ジョブの配送, 実行,
					状態の記録は、Tsumugiが処理します。
				</p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-3']">
				<ul class="flex flex-wrap gap-2">
					<li v-for="name in builtin" :key="name" class="rounded-full bg-brand-soft px-3.5 py-1.5 text-sm font-medium text-brand-1">
						{{ name }}
					</li>
				</ul>
				<h3 class="mt-8 text-xl font-semibold text-text-1">ジョブ管理機能を標準搭載</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					リトライ, バックオフ, 予約実行, 定期実行, 優先度, 同時実行数とレートの制限, 重複排除,
					ダッシュボードを、Tsumugiの標準機能として提供します。
				</p>
			</article>

			<article data-reveal :class="[card, 'p-0 lg:col-span-4 lg:row-span-2']">
				<div class="p-6 sm:p-8">
					<h3 class="text-xl font-semibold text-text-1">終了したジョブの参照</h3>
					<p class="mt-3 max-w-xl leading-relaxed text-text-2">
						ダッシュボードとREST APIは、成功と失敗を含むすべてのジョブについて、状態の一覧表示と検索を提供します。<code
							class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1"
							>TSUMUGI_METRICS</code
						>のbindingを設定すると、失敗率と実行時間のメトリクスも記録します。
					</p>
				</div>
				<img
					src="/dashboard-jobs.jpg"
					alt="ジョブの一覧ページ"
					loading="lazy"
					class="mx-6 mt-auto mb-6 w-[calc(100%-3rem)] rounded-2xl border border-divider object-cover object-left-top shadow-xl sm:mx-8 sm:mb-8 sm:w-[calc(100%-4rem)]"
				/>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2 lg:row-span-2']">
				<HomeVisualFlow class="flex-1" />
				<h3 class="mt-8 text-xl font-semibold text-text-1">依存関係を持つ処理</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					ノードと依存関係を宣言すると、前段ノードの戻り値が後続ノードのpayloadとして渡されます。fan-outを定義すると、配列の要素ごとに子ノードが作成され、並列に実行されます。
				</p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualAsync />
				<h3 class="mt-8 text-xl font-semibold text-text-1">メソッド呼び出しによる非同期処理</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					<code class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1">enqueue(env, { binding, payload })</code
					>を呼び出すと、Tsumugiはジョブを投入します。戻り値はジョブIDであり、呼び出しは即時に完了します。
				</p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualGuarantee />
				<h3 class="mt-8 text-xl font-semibold text-text-1">ジョブ単位の実行保証</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					<code class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1">guarantee</code>に<code
						class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1"
						>at-most-once</code
					>を指定したジョブは、二重に実行されません。<code class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1"
						>guarantee</code
					>の既定値は<code class="rounded bg-default-soft px-1 font-mono text-[0.9em] text-brand-1">at-least-once</code>です。
				</p>
			</article>

			<article data-reveal :class="[card, 'lg:col-span-2']">
				<HomeVisualRemote />
				<h3 class="mt-8 text-xl font-semibold text-text-1">performerの別Worker配置</h3>
				<p class="mt-3 leading-relaxed text-text-2">
					performerをService Bindingで接続した別のWorkerに配置した場合も、Tsumugiはperformerを実行します。
				</p>
			</article>
		</div>
	</HomeSection>
</template>
