import { defineOxlintConfig } from '@chan-mai/oxc-config';

export default defineOxlintConfig({
	features: {
		nuxt: true,
		vitest: true,
		workers: true,
	},
});
