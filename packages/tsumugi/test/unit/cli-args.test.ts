import { describe, expect, it } from 'vitest';
import { main } from '../../src/cli/index.js';
import { makeDeps } from './cli-harness.js';

// 引数の解釈はCLIの入口, 誤った起動で書き込みが走らないことをここで保証する

describe('引数の解釈', () => {
	it('引数なしはusageを出して失敗する', () => {
		const { deps, errors, fs } = makeDeps();
		expect(main([], deps)).toBe(1);
		expect(errors.join('\n')).toContain('usage: tsumugi');
		expect(fs.files.size).toBe(0);
	});

	it('--helpはusageを出して成功する', () => {
		const { deps, logs } = makeDeps();
		expect(main(['--help'], deps)).toBe(0);
		expect(logs.join('\n')).toContain('add-performer');
	});

	it('--versionは渡した版をそのまま出す', () => {
		const { deps, logs } = makeDeps();
		expect(main(['--version'], deps)).toBe(0);
		expect(logs).toEqual(['0.0.0-test']);
	});

	it('未知のコマンドは失敗する', () => {
		const { deps, errors } = makeDeps();
		expect(main(['frobnicate'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('unknown command');
	});

	it('未知のオプションは失敗する', () => {
		const { deps, errors } = makeDeps();
		expect(main(['init', '--frobnicate'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('usage: tsumugi');
	});

	it('initのformatはjsoncとtoml以外を弾く', () => {
		const { deps, errors, fs } = makeDeps();
		expect(main(['init', '--format', 'yaml'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('unknown format');
		expect(fs.files.size).toBe(0);
	});

	it('add-performerは名前が無ければ失敗する', () => {
		const { deps, errors } = makeDeps();
		expect(main(['add-performer'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('requires exactly one name');
	});

	it('initは余分な位置引数を拒否する', () => {
		// 誤った起動でリソース作成まで進めない
		const { deps, errors, calls, fs } = makeDeps();
		expect(main(['init', 'extra'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('does not accept positional arguments');
		expect(calls).toEqual([]);
		expect(fs.files.size).toBe(0);
	});

	it('add-performerは複数の名前を拒否する', () => {
		const { deps, errors } = makeDeps();
		expect(main(['add-performer', 'a', 'b'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('requires exactly one name');
	});

	it('add-performerはinit専用のオプションを拒否する', () => {
		const { deps, errors, fs } = makeDeps();
		fs.mkdir('/proj/src/performers');
		expect(main(['add-performer', 'send-mail', '--format', 'toml'], deps)).toBe(1);
		expect(main(['add-performer', 'send-mail', '--name', 'x'], deps)).toBe(1);
		expect(errors.join('\n')).toContain('only valid with init');
		expect(fs.files.size).toBe(0);
	});
});
