import { confirm, isCancel, select, text, type Option } from '@clack/prompts';
import type { Prompts } from './tui.js';

export const clackPrompts = (): Prompts => ({
	select: async <T extends string>(message: string, options: readonly { value: T; label: string }[]) => {
		// Option<T>は条件型, 未解決Tへ代入不可でキャスト
		const result = await select<T>({ message, options: [...options] as Option<T>[] });
		return isCancel(result) ? undefined : result;
	},
	text: async (message, initial) => {
		const result = await text({ message, placeholder: initial, defaultValue: initial });
		return isCancel(result) ? undefined : result;
	},
	confirm: async (message) => {
		const result = await confirm({ message });
		return isCancel(result) ? undefined : result;
	},
});
