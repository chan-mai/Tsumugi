import type { BindingKind, MissingBinding } from './validate.js';

// 雛形は`examples/basic/wrangler.jsonc`の構成

export const DEFAULT_MIGRATIONS_DIR = './node_modules/tsumugi/migrations';

const DO_MIGRATION_TAG = 'vN';

/** CLIの実測値指定, 省略項目はプレースホルダ */
export type FragmentValues = {
	databaseId?: string;
	databaseName?: string;
	queueName?: string;
	/** DO migrationsのtag, 新規生成時はv1で確定 */
	migrationTag?: string;
	/** service bindingの接続先Worker名 */
	serviceWorker?: string;
};

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

const renderToml = (block: FragmentBlock): string => {
	const tables = Array.isArray(block.value)
		? tomlTables(block.key, block.value as Record<string, unknown>[])
		: Object.entries(block.value as Record<string, Record<string, unknown>[]>).flatMap(([prop, items]) =>
				tomlTables(`${block.key}.${prop}`, items),
			);
	const body = tables.join('\n\n');
	return block.comment ? `# ${block.comment}\n${body}` : body;
};

export function configFragment(missing: readonly MissingBinding[], values: FragmentValues = {}): string {
	return blocksOf(missing, values).map(renderJsonc).join(',\n');
}

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

/** `migrationErrorMessage`と同形式 */
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
