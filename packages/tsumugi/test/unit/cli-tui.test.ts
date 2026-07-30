import { describe, expect, it } from 'vitest';
import { runTui, type Prompts } from '../../src/cli/tui.js';
import { makeDeps, ok } from './cli-harness.js';

// 対話モードは入力を集めて同じinit / addPerformerを呼ぶだけの層
// 確認より前に書き込みやwranglerの実行が走らないことをここで保証する

const DATABASE_ID = '9945ba53-b1cb-45a2-8f01-c650518c2f2a';
const d1Script = (args: readonly string[]) => (args[0] === 'd1' && args[1] === 'create' ? ok(`{ "database_id": "${DATABASE_ID}" }`) : ok());

type Script = { selects?: string[]; texts?: (string | undefined)[]; confirms?: (boolean | undefined)[] };

/** 台本の値を順に返す, textの空文字は既定値の受け入れとして扱う */
const scripted = (script: Script): Prompts => {
	const selects = [...(script.selects ?? [])];
	const texts = [...(script.texts ?? [])];
	const confirms = [...(script.confirms ?? [])];
	return {
		select: async <T extends string>() => selects.shift() as T | undefined,
		text: async (_message, initial) => {
			const value = texts.shift();
			return value === '' ? initial : value;
		},
		confirm: async () => confirms.shift(),
	};
};

describe('対話モードのinit', () => {
	it('確認の後にinitを実行する', async () => {
		const { deps, fs } = makeDeps(d1Script);
		const prompts = scripted({ selects: ['init', 'jsonc'], texts: [''], confirms: [true] });

		expect(await runTui(prompts, deps)).toBe(0);

		// 名前の既定値はディレクトリ名(/projのbasename)
		expect(fs.read('/proj/wrangler.jsonc')).toContain('"name": "proj"');
		expect(fs.read('/proj/wrangler.jsonc')).toContain(DATABASE_ID);
	});

	it('形式にtomlを選べる', async () => {
		const { deps, fs } = makeDeps(d1Script);
		const prompts = scripted({ selects: ['init', 'toml'], texts: [''], confirms: [true] });

		expect(await runTui(prompts, deps)).toBe(0);
		expect(fs.files.has('/proj/wrangler.toml')).toBe(true);
	});

	it('既存の設定があれば形式を聞かない', async () => {
		// 台本のselectは1回分しか無い, 形式を聞くとundefinedになりこのテストが落ちる
		const { deps, fs, logs } = makeDeps(d1Script);
		fs.write('/proj/wrangler.toml', 'name = "existing-app"\n');
		const prompts = scripted({ selects: ['init'], texts: [''], confirms: [true] });

		expect(await runTui(prompts, deps)).toBe(0);
		expect(logs.join('\n')).toContain('[[d1_databases]]');
	});

	it('確認で止めれば何も書かずwranglerも実行しない', async () => {
		const { deps, fs, calls } = makeDeps(d1Script);
		const prompts = scripted({ selects: ['init', 'jsonc'], texts: [''], confirms: [false] });

		expect(await runTui(prompts, deps)).toBe(1);
		expect(fs.files.size).toBe(0);
		expect(calls).toEqual([]);
	});
});

describe('対話モードのadd-performer', () => {
	it('確認の後にperformerを追加する', async () => {
		const { deps, fs } = makeDeps();
		fs.mkdir('/proj/src/performers');
		const prompts = scripted({ selects: ['add-performer'], texts: ['send-mail'], confirms: [true] });

		expect(await runTui(prompts, deps)).toBe(0);
		expect(fs.read('/proj/src/performers/send-mail.ts')).toContain('class SendMail');
	});

	it('変換できない名前は確認の前に止める', async () => {
		const { deps, fs, errors } = makeDeps();
		fs.mkdir('/proj/src/performers');
		const prompts = scripted({ selects: ['add-performer'], texts: ['9lives'], confirms: [true] });

		expect(await runTui(prompts, deps)).toBe(1);
		expect(errors.join('\n')).toContain('cannot derive a class name');
		expect(fs.files.size).toBe(0);
	});
});

describe('対話モードの終了', () => {
	it('exitを選べば0で終わる', async () => {
		const { deps, fs } = makeDeps();
		expect(await runTui(scripted({ selects: ['exit'] }), deps)).toBe(0);
		expect(fs.files.size).toBe(0);
	});

	it('キャンセル(undefined)も0で終わる', async () => {
		const { deps } = makeDeps();
		expect(await runTui(scripted({}), deps)).toBe(0);
	});
});
