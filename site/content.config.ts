import { defineCollection, defineContentConfig, z } from '@nuxt/content';

const cwd = import.meta.dirname;

export default defineContentConfig({
	collections: {
		docs: defineCollection({
			type: 'page',
			source: [
				{ cwd, include: 'guide/*.md' },
				{ cwd, include: 'reference/*.md' },
			],
			schema: z.object({ publishedAt: z.string().date(), updatedAt: z.string().date() }),
		}),
	},
});
