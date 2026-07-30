import { join } from 'node:path';
import { configFragment, configFragmentToml } from '../config/fragment.js';
import type { MissingBinding } from '../config/validate.js';
import { detectWranglerConfig, readWorkerName } from './config-file.js';
import type { CliDeps } from './index.js';
import { BARREL_HEADER, exportLine, performerFile } from './templates.js';

/**
 * `tsumugi add-performer <NAME>`(ADR-0036)
 *
 * performerのファイルを生成し, バレルへexport行を追記する
 * バレルの既存行は書き換えない, wrangler設定にも触れない(ADR-0037)
 */

/** 引数からクラス名とファイル名を導く, kebab / camel / Pascal / SNAKEを受ける */
export function performerNames(raw: string): { className: string; fileBase: string } | undefined {
	const words = raw
		.split(/[-_\s]+/)
		.flatMap((part) =>
			part
				.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
				.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
				.split(' '),
		)
		.filter((word) => word.length > 0);
	if (words.length === 0) return undefined;
	const className = words.map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join('');
	if (!/^[A-Z][A-Za-z0-9]*$/.test(className)) return undefined;
	return { className, fileBase: words.map((word) => word.toLowerCase()).join('-') };
}

/** 同じ名前が既に並んでいるかを見る, クラス名かimport元のどちらかが重なれば止める */
const barrelHas = (barrel: string, names: { className: string; fileBase: string }): boolean =>
	new RegExp(`\\b${names.className}\\b`).test(barrel) || barrel.includes(`'./${names.fileBase}.js'`);

export function addPerformer(rawName: string, deps: CliDeps): number {
	const names = performerNames(rawName);
	if (names === undefined) {
		deps.error(`tsumugi: cannot derive a class name from "${rawName}"`);
		deps.error('use a name like send-mail, sendMail or SendMail');
		return 1;
	}

	const dir = join(deps.cwd, 'src', 'performers');
	if (!deps.fs.exists(dir)) {
		deps.error('tsumugi: src/performers/ does not exist, run `tsumugi init` first');
		return 1;
	}

	const file = join(dir, `${names.fileBase}.ts`);
	if (deps.fs.exists(file)) {
		deps.error(`tsumugi: src/performers/${names.fileBase}.ts already exists`);
		return 1;
	}

	const barrelPath = join(dir, 'index.ts');
	const barrel = deps.fs.exists(barrelPath) ? deps.fs.read(barrelPath) : BARREL_HEADER;
	if (barrelHas(barrel, names)) {
		deps.error(`tsumugi: ${names.className} is already exported from src/performers/index.ts`);
		return 1;
	}

	deps.fs.write(file, performerFile(names.className));
	const separated = barrel.length === 0 || barrel.endsWith('\n') ? barrel : `${barrel}\n`;
	deps.fs.write(barrelPath, separated + exportLine(names.className, names.fileBase));
	deps.log(`created src/performers/${names.fileBase}.ts`);
	deps.log(`added ${names.className} to src/performers/index.ts`);

	// 別のWorkerから使う場合に呼び出し側が足すservice bindingの断片, 自分の設定には何も要らない
	const config = detectWranglerConfig(deps);
	const worker = config ? readWorkerName(deps.fs.read(config.path), config.format) : undefined;
	const missing: MissingBinding[] = [{ kind: 'service', name: names.className, className: names.className, reason: 'absent' }];
	const values = worker === undefined ? {} : { serviceWorker: worker };
	const fragment = config?.format === 'toml' ? configFragmentToml(missing, values) : configFragment(missing, values);
	deps.log('');
	deps.log('to call this performer from another Worker, append this to the caller wrangler config:');
	deps.log('');
	deps.log(fragment);
	return 0;
}
