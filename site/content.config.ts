import { defineCollection, defineContentConfig, z } from '@nuxt/content';

const cwd = import.meta.dirname;
const schema = z.object({ publishedAt: z.string().date(), updatedAt: z.string().date() });

export default defineContentConfig({
	collections: {
		docs_ja: defineCollection({
			type: 'page',
			source: [
				{ cwd, include: 'guide/*.md' },
				{ cwd, include: 'reference/*.md' },
			],
			schema,
		}),
		// translate-docsワークフローが生成
		docs_en: defineCollection({
			type: 'page',
			source: [
				{ cwd, include: 'en/guide/*.md' },
				{ cwd, include: 'en/reference/*.md' },
			],
			schema,
		}),
		docs_ko: defineCollection({
			type: 'page',
			source: [
				{ cwd, include: 'ko/guide/*.md' },
				{ cwd, include: 'ko/reference/*.md' },
			],
			schema,
		}),
	},
});
