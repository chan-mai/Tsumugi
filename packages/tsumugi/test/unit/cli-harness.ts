import type { CliDeps, CliFs, RunResult } from '../../src/cli/index.js';

/**
 * CLIテスト用の依存の偽物
 * `vi.mock`を使わず, 記録するだけの実装をDIで渡す(`config-validate.test.ts`の`Noop`と同じ方針)
 */

/** パス→内容のMapで代用する, ディレクトリはmkdirと書き込み済みパスから導く */
export class MemoryFs implements CliFs {
	readonly files = new Map<string, string>();
	readonly dirs = new Set<string>();

	exists(path: string): boolean {
		if (this.files.has(path) || this.dirs.has(path)) return true;
		const prefix = `${path}/`;
		return [...this.files.keys(), ...this.dirs].some((key) => key.startsWith(prefix));
	}

	read(path: string): string {
		const content = this.files.get(path);
		if (content === undefined) throw new Error(`not found: ${path}`);
		return content;
	}

	write(path: string, content: string): void {
		this.files.set(path, content);
	}

	mkdir(path: string): void {
		this.dirs.add(path);
	}
}

export const ok = (stdout = ''): RunResult => ({ ok: true, stdout, stderr: '' });
export const fail = (stderr = ''): RunResult => ({ ok: false, stdout: '', stderr });

/** 引数列から応答を決める台本, undefinedは成功扱い */
export type WranglerScript = (args: readonly string[]) => RunResult | undefined;

export type Harness = {
	deps: CliDeps;
	fs: MemoryFs;
	logs: string[];
	errors: string[];
	/** wranglerへ渡った引数列の記録 */
	calls: string[][];
};

export function makeDeps(script: WranglerScript = () => ok()): Harness {
	const fs = new MemoryFs();
	const logs: string[] = [];
	const errors: string[] = [];
	const calls: string[][] = [];
	const deps: CliDeps = {
		fs,
		wrangler: (args) => {
			calls.push([...args]);
			return script(args) ?? ok();
		},
		log: (line) => logs.push(line),
		error: (line) => errors.push(line),
		cwd: '/proj',
		version: '0.0.0-test',
		isTty: false,
	};
	return { deps, fs, logs, errors, calls };
}
