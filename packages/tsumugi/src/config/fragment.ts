import type { BindingKind, MissingBinding } from './validate.js';

/**
 * 不足したbindingからwrangler設定の断片を作る(ADR-0036)
 *
 * `examples/basic/wrangler.jsonc`の構成をそのまま雛形にする
 * 値は利用者が埋める箇所だけを空にし,残りは貼ればそのまま通る形にする
 * 起動時検証とCLIの両方が使う, 断片の実装はここに一本化する
 */

/** D1のマイグレーションの既定の置き場所, パッケージが持つSQLを指す */
export const DEFAULT_MIGRATIONS_DIR = './node_modules/tsumugi/migrations';

/** Durable Objectのmigrationsのtagは順に増やす, 既存と衝突しない番号を利用者が振り直す */
const DO_MIGRATION_TAG = 'vN';

/** CLIが実測値を埋めるための指定, 省略した項目はプレースホルダのまま */
export type FragmentValues = {
	/** `wrangler d1 create`が出力したdatabase_id */
	databaseId?: string;
	databaseName?: string;
	queueName?: string;
	/** Durable Objectのmigrationsのtag, 新規生成ではv1で確定できる */
	migrationTag?: string;
	/** service bindingが指す相手のWorker名 */
	serviceWorker?: string;
};

/** 形式に依存しない断片のかたまり, レンダラがJSONCとTOMLへ変換する */
type FragmentBlock = {
	comment?: string;
	key: string;
	value: unknown;
};

const durableObjects = (entries: MissingBinding[], values: FragmentValues): FragmentBlock[] => {
	if (entries.length === 0) return [];
	const bindings = entries.map((entry) => ({ name: entry.name, class_name: entry.className ?? entry.name }));
	return [
		{ key: 'durable_objects', value: { bindings } },
		{
			...(values.migrationTag ? {} : { comment: 'renumber tag so it does not collide with existing ones' }),
			key: 'migrations',
			value: [{ tag: values.migrationTag ?? DO_MIGRATION_TAG, new_sqlite_classes: bindings.map((b) => b.class_name) }],
		},
	];
};

const d1 = (entries: MissingBinding[], values: FragmentValues): FragmentBlock[] =>
	entries.map((entry) => ({
		...(values.databaseId ? {} : { comment: 'paste database_id from the output of `wrangler d1 create <name>`' }),
		key: 'd1_databases',
		value: [
			{
				binding: entry.name,
				database_name: values.databaseName ?? '<database>',
				database_id: values.databaseId ?? '<id>',
				migrations_dir: DEFAULT_MIGRATIONS_DIR,
			},
		],
	}));

const queues = (entries: MissingBinding[], values: FragmentValues): FragmentBlock[] =>
	entries.map((entry) => ({
		key: 'queues',
		value: {
			producers: [{ binding: entry.name, queue: values.queueName ?? '<queue>' }],
			consumers: [{ queue: values.queueName ?? '<queue>', max_batch_size: 10, max_retries: 5 }],
		},
	}));

const analytics = (entries: MissingBinding[]): FragmentBlock[] =>
	entries.map((entry) => ({ key: 'analytics_engine_datasets', value: [{ binding: entry.name, dataset: '<dataset>' }] }));

const services = (entries: MissingBinding[], values: FragmentValues): FragmentBlock[] => {
	if (entries.length === 0) return [];
	const list = entries.map((entry) => ({
		binding: entry.name,
		service: values.serviceWorker ?? '<worker>',
		entrypoint: entry.className ?? '<PerformerClass>',
	}));
	const filled = values.serviceWorker !== undefined && entries.every((entry) => entry.className);
	const comment = filled ? {} : { comment: 'set service and entrypoint to the target Worker name and class name' };
	return [{ ...comment, key: 'services', value: list }];
};

const BUILDERS: Record<BindingKind, (entries: MissingBinding[], values: FragmentValues) => FragmentBlock[]> = {
	'durable-object': durableObjects,
	d1,
	queue: queues,
	analytics,
	service: services,
};

const ORDER: readonly BindingKind[] = ['durable-object', 'd1', 'queue', 'analytics', 'service'];

const blocksOf = (missing: readonly MissingBinding[], values: FragmentValues): FragmentBlock[] =>
	ORDER.flatMap((kind) =>
		BUILDERS[kind](
			missing.filter((entry) => entry.kind === kind),
			values,
		),
	);

const jsonc = (value: unknown): string => JSON.stringify(value, null, 2);

/** durable_objectsだけbindingsを同じ行の`{}`で包む, 従来の出力を保つ */
const renderJsonc = (block: FragmentBlock): string => {
	const body =
		block.key === 'durable_objects'
			? `"durable_objects": { "bindings": ${jsonc((block.value as { bindings: unknown }).bindings)} }`
			: `"${block.key}": ${jsonc(block.value)}`;
	return block.comment ? `// ${block.comment}\n${body}` : body;
};

const tomlValue = (value: unknown): string => {
	if (typeof value === 'string') return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(tomlValue).join(', ')}]`;
	return String(value);
};

const tomlTables = (path: string, items: Record<string, unknown>[]): string[] =>
	items.map((item) => [`[[${path}]]`, ...Object.entries(item).map(([key, value]) => `${key} = ${tomlValue(value)}`)].join('\n'));

/** 配列は`[[key]]`, 配列を持つオブジェクトは`[[key.prop]]`のテーブル配列にする */
const renderToml = (block: FragmentBlock): string => {
	const tables = Array.isArray(block.value)
		? tomlTables(block.key, block.value as Record<string, unknown>[])
		: Object.entries(block.value as Record<string, Record<string, unknown>[]>).flatMap(([prop, items]) =>
				tomlTables(`${block.key}.${prop}`, items),
			);
	const body = tables.join('\n\n');
	return block.comment ? `# ${block.comment}\n${body}` : body;
};

/** 貼り付けられるJSONCの断片, 種別ごとにまとめる */
export function configFragment(missing: readonly MissingBinding[], values: FragmentValues = {}): string {
	return blocksOf(missing, values).map(renderJsonc).join(',\n');
}

/** wrangler.tomlの利用者向け, 内容はJSONC版と同一 */
export function configFragmentToml(missing: readonly MissingBinding[], values: FragmentValues = {}): string {
	return blocksOf(missing, values).map(renderToml).join('\n\n');
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
		const detail = entry.reason === 'invalid' ? 'has no performer' : 'is not configured';
		return `✗ ${entry.name} (${LABELS[entry.kind]}) ${detail}`;
	});

	const next = ['append the following fragment to wrangler.jsonc'];
	if (missing.some((entry) => entry.kind === 'd1')) {
		next.push('run wrangler d1 create <database> to create the database');
		next.push('run wrangler d1 migrations apply <database> --remote to set up the read model');
	}
	if (missing.some((entry) => entry.kind === 'queue')) next.push('run wrangler queues create <queue> to create the queue');

	return [
		'tsumugi: the wrangler configuration is incomplete',
		...lines,
		'',
		...next.map((step, index) => `${index + 1}. ${step}`),
		'',
		configFragment(missing),
	].join('\n');
}
