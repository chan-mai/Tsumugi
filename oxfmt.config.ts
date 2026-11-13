import { defineOxfmtConfig } from '@chan-mai/oxc-config';

export default defineOxfmtConfig({
	overrides: {
		ignorePatterns: [
			'dist/',
			'package-lock.json',
			'pnpm-lock.yaml',
			// wrangler typesの生成物
			'examples/*/worker-configuration.d.ts',
			'*.md',
		],
		overrides: [
			{
				files: ['*.json', '*.jsonc', '*.yaml', '*.yml', '*.md'],
				options: { useTabs: false, tabWidth: 2 },
			},
		],
	},
});
