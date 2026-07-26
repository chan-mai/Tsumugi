import type { BindingKind, MissingBinding } from './validate.js';

/**
 * 不足したbindingからwrangler設定の断片を作る(ADR-0036)
 *
 * `examples/basic/wrangler.jsonc`の構成をそのまま雛形にする
 * 値は利用者が埋める箇所だけを空にし,残りは貼ればそのまま通る形にする
 */

/** D1のマイグレーションの既定の置き場所, パッケージが持つSQLを指す */
export const DEFAULT_MIGRATIONS_DIR = './node_modules/tsumugi/migrations';

/** Durable Objectのmigrationsのtagは順に増やす, 既存と衝突しない番号を利用者が振り直す */
const DO_MIGRATION_TAG = 'vN';

const jsonc = (value: unknown): string => JSON.stringify(value, null, 2);

const durableObjects = (entries: MissingBinding[]): string[] => {
	if (entries.length === 0) return [];
	const bindings = entries.map((entry) => ({ name: entry.name, class_name: entry.className ?? entry.name }));
	return [
		`"durable_objects": { "bindings": ${jsonc(bindings)} }`,
		`// tagは既存と衝突しない番号へ振り直す\n"migrations": ${jsonc([{ tag: DO_MIGRATION_TAG, new_sqlite_classes: bindings.map((b) => b.class_name) }])}`,
	];
};

const d1 = (entries: MissingBinding[]): string[] =>
	entries.map(
		(entry) =>
			`// database_idは\`wrangler d1 create <name>\`の出力を貼る\n"d1_databases": ${jsonc([
				{
					binding: entry.name,
					database_name: '<database>',
					database_id: '<id>',
					migrations_dir: DEFAULT_MIGRATIONS_DIR,
				},
			])}`,
	);

const queues = (entries: MissingBinding[]): string[] =>
	entries.map(
		(entry) =>
			`"queues": ${jsonc({
				producers: [{ binding: entry.name, queue: '<queue>' }],
				consumers: [{ queue: '<queue>', max_batch_size: 10, max_retries: 5 }],
			})}`,
	);

const analytics = (entries: MissingBinding[]): string[] =>
	entries.map((entry) => `"analytics_engine_datasets": ${jsonc([{ binding: entry.name, dataset: '<dataset>' }])}`);

const services = (entries: MissingBinding[]): string[] => {
	if (entries.length === 0) return [];
	const list = entries.map((entry) => ({ binding: entry.name, service: '<worker>', entrypoint: '<PerformerClass>' }));
	return [`// serviceとentrypointは相手のWorkerの名前とクラス名に合わせる\n"services": ${jsonc(list)}`];
};

const BUILDERS: Record<BindingKind, (entries: MissingBinding[]) => string[]> = {
	'durable-object': durableObjects,
	d1,
	queue: queues,
	analytics,
	service: services,
};

const ORDER: readonly BindingKind[] = ['durable-object', 'd1', 'queue', 'analytics', 'service'];

/** 貼り付けられるJSONCの断片, 種別ごとにまとめる */
export function configFragment(missing: readonly MissingBinding[]): string {
	const blocks = ORDER.flatMap((kind) => BUILDERS[kind](missing.filter((entry) => entry.kind === kind)));
	return blocks.join(',\n');
}

const LABELS: Record<BindingKind, string> = {
	'durable-object': 'Durable Object',
	d1: 'D1',
	queue: 'Queues',
	analytics: 'Analytics Engine',
	service: 'service binding',
};

/**
 * 読んだ人がそのまま直せる説明を作る
 * `migrations.ts`の`migrationErrorMessage`に倣い,断片と次に実行するコマンドまで含める
 */
export function configErrorMessage(missing: readonly MissingBinding[]): string {
	const lines = missing.map((entry) => {
		const detail = entry.reason === 'invalid' ? 'performerを持たない' : '未設定';
		return `✗ ${entry.name} (${LABELS[entry.kind]}) が${detail}`;
	});

	const next = ['wrangler.jsonc へ次の断片を追記する'];
	if (missing.some((entry) => entry.kind === 'd1')) {
		next.push('wrangler d1 create <database> でデータベースを作る');
		next.push('wrangler d1 migrations apply <database> --remote で読み取りモデルを用意する');
	}
	if (missing.some((entry) => entry.kind === 'queue')) next.push('wrangler queues create <queue> でキューを作る');

	return [
		'tsumugi: wranglerの設定が足りない',
		...lines,
		'',
		...next.map((step, index) => `${index + 1}. ${step}`),
		'',
		configFragment(missing),
	].join('\n');
}
