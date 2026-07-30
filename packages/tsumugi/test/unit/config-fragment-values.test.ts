import { describe, expect, it } from 'vitest';
import { requiredAsMissing } from '../../src/config/validate.js';
import { configFragment, configFragmentToml, DEFAULT_MIGRATIONS_DIR } from '../../src/config/fragment.js';

// 断片は起動時検証とCLIの2経路から使われる(ADR-0036)
// 値の埋め込みがプレースホルダ経路を壊すと検証側のメッセージが崩れるので, 両方の出力を検査する

/** initの新規生成が渡す実測値 */
const values = { databaseId: '9945ba53-b1cb-45a2-8f01-c650518c2f2a', databaseName: 'my-jobs', queueName: 'my-jobs', migrationTag: 'v1' };

describe('必須bindingの不足化', () => {
	it('常に要る3つを不足として返す', () => {
		expect(requiredAsMissing()).toEqual([
			{ kind: 'durable-object', name: 'JOB_SHARD', reason: 'absent', className: 'TsumugiJobShard' },
			{ kind: 'd1', name: 'TSUMUGI_DB', reason: 'absent' },
			{ kind: 'queue', name: 'TSUMUGI_QUEUE', reason: 'absent' },
		]);
	});

	it('flowを使う構成ではRUNが加わる', () => {
		const missing = requiredAsMissing(true);
		expect(missing.map((entry) => entry.name)).toEqual(['JOB_SHARD', 'TSUMUGI_DB', 'TSUMUGI_QUEUE', 'RUN']);
		expect(missing[3]).toEqual({ kind: 'durable-object', name: 'RUN', reason: 'absent', className: 'TsumugiRun' });
	});
});

describe('実測値の埋め込み', () => {
	it('database_idをそのまま書き込む', () => {
		// 手で貼り直させると転記の誤りが入る(ADR-0036)
		const fragment = configFragment(requiredAsMissing(), values);
		expect(fragment).toContain(`"database_id": "${values.databaseId}"`);
		expect(fragment).toContain('"database_name": "my-jobs"');
		expect(fragment).not.toContain('<id>');
		expect(fragment).not.toContain('paste database_id');
	});

	it('確定したtagにはrenumberの指示を出さない', () => {
		const fragment = configFragment(requiredAsMissing(), values);
		expect(fragment).toContain('"tag": "v1"');
		expect(fragment).not.toContain('renumber tag');
	});

	it('queue名はproducerとconsumerの両方に入る', () => {
		const fragment = configFragment(requiredAsMissing(), values);
		expect(fragment.match(/"queue": "my-jobs"/g)).toHaveLength(2);
	});

	it('serviceは相手のWorker名とentrypointで完成する', () => {
		const missing = [{ kind: 'service', name: 'SendMail', className: 'SendMail', reason: 'absent' }] as const;
		const fragment = configFragment(missing, { serviceWorker: 'my-mailer' });
		expect(fragment).toContain('"service": "my-mailer"');
		expect(fragment).toContain('"entrypoint": "SendMail"');
		expect(fragment).not.toContain('set service and entrypoint');
	});

	it('省略した項目はプレースホルダと指示コメントのまま', () => {
		// 起動時検証は値を持たないので, 従来の出力が変わらないことを保証する
		const fragment = configFragment(requiredAsMissing());
		expect(fragment).toContain('"database_id": "<id>"');
		expect(fragment).toContain('paste database_id');
		expect(fragment).toContain('"tag": "vN"');
		expect(fragment).toContain('renumber tag');
		expect(fragment).toContain('"queue": "<queue>"');
	});
});

describe('TOML形式の断片', () => {
	it('種別ごとにテーブル配列を出す', () => {
		const fragment = configFragmentToml(requiredAsMissing(), values);
		expect(fragment).toContain('[[durable_objects.bindings]]');
		expect(fragment).toContain('[[migrations]]');
		expect(fragment).toContain('[[d1_databases]]');
		expect(fragment).toContain('[[queues.producers]]');
		expect(fragment).toContain('[[queues.consumers]]');
	});

	it('値の形はJSONC版と同一', () => {
		const fragment = configFragmentToml(requiredAsMissing(), values);
		expect(fragment).toContain(`database_id = "${values.databaseId}"`);
		expect(fragment).toContain('new_sqlite_classes = ["TsumugiJobShard"]');
		expect(fragment).toContain('max_batch_size = 10');
		expect(fragment).toContain(`migrations_dir = "${DEFAULT_MIGRATIONS_DIR}"`);
	});

	it('指示コメントは#で出す', () => {
		const fragment = configFragmentToml(requiredAsMissing());
		expect(fragment).toContain('# paste database_id');
		expect(fragment).toContain('# renumber tag');
		expect(fragment).not.toContain('//');
	});

	it('serviceもテーブル配列になる', () => {
		const missing = [{ kind: 'service', name: 'SendMail', className: 'SendMail', reason: 'absent' }] as const;
		const fragment = configFragmentToml(missing, { serviceWorker: 'my-mailer' });
		expect(fragment).toContain('[[services]]');
		expect(fragment).toContain('binding = "SendMail"');
		expect(fragment).toContain('service = "my-mailer"');
		expect(fragment).toContain('entrypoint = "SendMail"');
	});
});
