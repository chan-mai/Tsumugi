<script setup lang="ts">
const steps = [
	{
		title: 'ジョブの処理をperformerとして定義',
		filename: 'src/performers/send-mail.ts',
		source: [
			"import { Performer } from 'tsumugi/performer';",
			'',
			'export class SendMail extends Performer<{ to: string }, void, {}, Env> {',
			'  async perform(payload: { to: string }): Promise<void> {',
			'    await this.env.MAILER.send(payload.to);',
			'  }',
			'}',
		].join('\n'),
	},
	{
		title: 'ジョブの投入',
		filename: 'src/index.ts',
		source: [
			"import { defineTsumugi } from 'tsumugi';",
			"import { SendMail } from './performers/send-mail.js';",
			'',
			'const tsumugi = defineTsumugi({ performers: { SendMail } });',
			'',
			"const id = await tsumugi.enqueue(env, { binding: 'SendMail', payload: { to: 'a@example.com' } });",
		].join('\n'),
	},
];

// prerender時に限りハイライト
const { data: highlighted } = await useAsyncData('home-code', async () => {
	const { codeToHtml } = await import('shiki');
	return Promise.all(
		steps.map(async (step) => {
			const html = await codeToHtml(step.source, {
				lang: 'ts',
				themes: { default: 'github-light', dark: 'github-dark' },
				defaultColor: false,
			});
			// 行はdisplay: blockのため行間の改行を除去
			return (/<code>([\s\S]*)<\/code>/.exec(html)?.[1] ?? '').replaceAll('\n', '');
		}),
	);
});
</script>

<template>
	<HomeSection heading="利用者が記述するコード" lead="記述するのはジョブの処理の定義と投入のたった2箇所だけです。">
		<ol class="grid gap-6 lg:grid-cols-2">
			<li v-for="(step, index) in steps" :key="step.title" data-reveal class="min-w-0">
				<p class="flex items-center gap-3 text-lg font-semibold text-text-1">
					<span class="grid size-8 place-items-center rounded-full bg-brand-soft font-mono text-sm text-brand-1">{{ index + 1 }}</span>
					{{ step.title }}
				</p>
				<ProsePre :filename="step.filename" class="shiki">
					<code v-html="highlighted?.[index]" />
				</ProsePre>
			</li>
		</ol>
	</HomeSection>
</template>
