import type { CliDeps, CliFs, RunResult } from '../../src/cli/index.js';

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

/** undefinedは成功 */
export type WranglerScript = (args: readonly string[]) => RunResult | undefined;

export type Harness = {
	deps: CliDeps;
	fs: MemoryFs;
	logs: string[];
	errors: string[];
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
