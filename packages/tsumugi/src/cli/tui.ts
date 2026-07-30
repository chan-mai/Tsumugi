import { addPerformer, performerNames } from './add-performer.js';
import { detectWranglerConfig, type ConfigFormat } from './config-file.js';
import type { CliDeps } from './index.js';
import { init, resolveWorkerName } from './init.js';

/**
 * 引数なし起動の対話モード
 *
 * 入力を集めて`init` / `addPerformer`を呼ぶだけの薄い層にする
 * 対話の口は`Prompts`で受け取り, テストは台本を返す偽物で検査する
 */

/** キャンセルはundefinedで返す */
export type Prompts = {
	select<T extends string>(message: string, options: readonly { value: T; label: string }[]): Promise<T | undefined>;
	text(message: string, initial: string): Promise<string | undefined>;
	confirm(message: string): Promise<boolean | undefined>;
};

const canceled = (deps: CliDeps): number => {
	deps.log('canceled, nothing was written');
	return 1;
};

async function tuiInit(prompts: Prompts, deps: CliDeps): Promise<number> {
	const name = await prompts.text('worker name?', resolveWorkerName(deps));
	if (name === undefined || name.trim().length === 0) return canceled(deps);

	const existing = detectWranglerConfig(deps);
	let format: ConfigFormat = 'jsonc';
	if (existing === undefined) {
		const picked = await prompts.select('config format?', [
			{ value: 'jsonc', label: 'wrangler.jsonc' },
			{ value: 'toml', label: 'wrangler.toml' },
		] as const);
		if (picked === undefined) return canceled(deps);
		format = picked;
	}

	// 書き込みとリソース作成の前に必ず確認を挟む
	const summary = existing
		? `create a queue and a D1 database named "${name.trim()}" and print a config fragment?`
		: `create a queue and a D1 database named "${name.trim()}" and write wrangler.${format} and src/?`;
	const proceed = await prompts.confirm(summary);
	if (proceed !== true) return canceled(deps);

	return init({ name: name.trim(), format }, deps);
}

async function tuiAddPerformer(prompts: Prompts, deps: CliDeps): Promise<number> {
	const raw = await prompts.text('performer name? (e.g. send-mail)', '');
	if (raw === undefined || raw.trim().length === 0) return canceled(deps);

	const names = performerNames(raw.trim());
	if (names === undefined) {
		deps.error(`tsumugi: cannot derive a class name from "${raw.trim()}"`);
		deps.error('use a name like send-mail, sendMail or SendMail');
		return 1;
	}

	const proceed = await prompts.confirm(`create src/performers/${names.fileBase}.ts with class ${names.className}?`);
	if (proceed !== true) return canceled(deps);

	return addPerformer(raw.trim(), deps);
}

export async function runTui(prompts: Prompts, deps: CliDeps): Promise<number> {
	const action = await prompts.select('what do you want to do?', [
		{ value: 'init', label: 'set up tsumugi in this project (init)' },
		{ value: 'add-performer', label: 'add a performer (add-performer)' },
		{ value: 'exit', label: 'exit' },
	] as const);
	if (action === undefined || action === 'exit') return 0;
	if (action === 'init') return tuiInit(prompts, deps);
	return tuiAddPerformer(prompts, deps);
}
