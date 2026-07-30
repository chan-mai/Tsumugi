import { describe, expect, it } from 'vitest';
import { addPerformer, performerNames } from '../../src/cli/add-performer.js';
import { makeDeps, type Harness } from './cli-harness.js';

// バレルは利用者の手書き行と同居する
// 追記が既存行を壊すと全performerが解決不能になるので, 不変条件をここで検査する

const BARREL = "export { Hello } from './hello.js';\n";

const withProject = (): Harness => {
	const harness = makeDeps();
	harness.fs.mkdir('/proj/src/performers');
	harness.fs.write('/proj/src/performers/index.ts', BARREL);
	return harness;
};

describe('performerの生成', () => {
	it('クラスとバレルへの追記を行う', () => {
		const { deps, fs } = withProject();
		expect(addPerformer('send-mail', deps)).toBe(0);

		expect(fs.read('/proj/src/performers/send-mail.ts')).toContain('export class SendMail extends Performer');
		expect(fs.read('/proj/src/performers/index.ts')).toBe(`${BARREL}export { SendMail } from './send-mail.js';\n`);
	});

	it('末尾に改行が無いバレルにも1行として足す', () => {
		const { deps, fs } = withProject();
		fs.write('/proj/src/performers/index.ts', BARREL.trimEnd());
		expect(addPerformer('send-mail', deps)).toBe(0);
		expect(fs.read('/proj/src/performers/index.ts')).toBe(`${BARREL}export { SendMail } from './send-mail.js';\n`);
	});

	it('バレルが無ければ定型のコメントから作る', () => {
		const { deps, fs } = makeDeps();
		fs.mkdir('/proj/src/performers');
		expect(addPerformer('send-mail', deps)).toBe(0);
		const barrel = fs.read('/proj/src/performers/index.ts');
		expect(barrel).toContain('// performerのバレル');
		expect(barrel).toContain("export { SendMail } from './send-mail.js';");
	});
});

describe('名前の変換', () => {
	it.each([
		['send-mail', 'SendMail', 'send-mail'],
		['sendMail', 'SendMail', 'send-mail'],
		['SendMail', 'SendMail', 'send-mail'],
		['SEND_MAIL', 'SendMail', 'send-mail'],
		['HTTPFetch', 'HttpFetch', 'http-fetch'],
		['hello', 'Hello', 'hello'],
	])('%sをクラス名%sとファイル名%sにする', (raw, className, fileBase) => {
		expect(performerNames(raw)).toEqual({ className, fileBase });
	});

	it.each([[''], ['9lives'], ['hello/world'], ['---']])('%sは変換できない', (raw) => {
		expect(performerNames(raw)).toBeUndefined();
	});

	it('変換できない名前では何も書かない', () => {
		const { deps, fs, errors } = withProject();
		expect(addPerformer('9lives', deps)).toBe(1);
		expect(fs.files.size).toBe(1);
		expect(errors.join('\n')).toContain('cannot derive a class name');
	});
});

describe('重複と前提の検査', () => {
	it('src/performers/が無ければinitへ誘導する', () => {
		const { deps, errors } = makeDeps();
		expect(addPerformer('send-mail', deps)).toBe(1);
		expect(errors.join('\n')).toContain('tsumugi init');
	});

	it('ファイルが既に在れば何も書かない', () => {
		const { deps, fs } = withProject();
		fs.write('/proj/src/performers/send-mail.ts', 'original');
		expect(addPerformer('send-mail', deps)).toBe(1);
		expect(fs.read('/proj/src/performers/send-mail.ts')).toBe('original');
		expect(fs.read('/proj/src/performers/index.ts')).toBe(BARREL);
	});

	it('バレルに同じ名前が在ればファイルを作らない', () => {
		const { deps, fs } = withProject();
		fs.write('/proj/src/performers/index.ts', "export { SendMail } from './mailer.js';\n");
		expect(addPerformer('send-mail', deps)).toBe(1);
		expect(fs.files.has('/proj/src/performers/send-mail.ts')).toBe(false);
	});
});

describe('service bindingの断片', () => {
	it('自分のWorker名を相手側の断片へ埋める', () => {
		// 別のWorkerから使う場合のみ要る, 自分の設定には何も足さない(ADR-0037)
		const { deps, fs, logs } = withProject();
		fs.write('/proj/wrangler.jsonc', '{ "name": "my-jobs" }');
		expect(addPerformer('send-mail', deps)).toBe(0);

		const output = logs.join('\n');
		expect(output).toContain('"services"');
		expect(output).toContain('"binding": "SendMail"');
		expect(output).toContain('"service": "my-jobs"');
		expect(output).toContain('"entrypoint": "SendMail"');
	});

	it('wrangler.tomlのプロジェクトにはTOMLで出す', () => {
		const { deps, fs, logs } = withProject();
		fs.write('/proj/wrangler.toml', 'name = "my-jobs"\n');
		expect(addPerformer('send-mail', deps)).toBe(0);

		const output = logs.join('\n');
		expect(output).toContain('[[services]]');
		expect(output).toContain('service = "my-jobs"');
	});

	it('設定が無ければWorker名はプレースホルダのまま', () => {
		const { deps, logs } = withProject();
		expect(addPerformer('send-mail', deps)).toBe(0);
		expect(logs.join('\n')).toContain('"service": "<worker>"');
	});
});
