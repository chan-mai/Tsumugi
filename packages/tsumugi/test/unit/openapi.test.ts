import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_VERSION, openapiDocument } from '../../src/api/openapi.js';
import { createRest } from '../../src/api/rest.js';
import { SORTABLE_COLUMNS } from '../../src/api/sort.js';

// 他言語の利用者はこの定義からクライアント生成, 経路の欠落は存在しないことと同義

const packageJson = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

const toTemplate = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

function registeredRoutes(): string[] {
	const noop = async (_c: unknown, next: () => Promise<void>) => {
		await next();
	};
	// 未指定時は501を返す経路が未登録
	const app = createRest(noop as never, {
		bindings: ['MAIL'],
		enqueue: async () => 'MAIL#0:x',
		flows: ['report'],
		start: async () => 'report:x',
		runFor: () => ({ cancel: async () => ({ ok: true }), retry: async () => ({ ok: true }) }),
		schedulerFor: () => ({
			list: async () => [],
			setPaused: async () => ({ ok: true }),
			trigger: async () => ({ ok: true, kind: 'job', id: 'MAIL#0:x' }),
		}),
		shardsOf: () => 1,
	});

	// ALLはミドルウェアとSPAのフォールバック
	return app.routes
		.filter((route) => route.method !== 'ALL')
		.map((route) => `${route.method} ${toTemplate(route.path)}`)
		.sort();
}

function documentedRoutes(): string[] {
	const document = openapiDocument();
	return Object.entries(document.paths)
		.flatMap(([path, operations]) => Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`))
		.sort();
}

describe('OpenAPI定義', () => {
	it('実装した経路を全て含んでいる', () => {
		expect(documentedRoutes()).toEqual(registeredRoutes());
	});

	it('D1を読む経路が全て503を含んでいる', () => {
		// マイグレーション未適用とD1障害はcheckSchemaが返す, 記載漏れは生成物に現れない
		const missing = Object.entries(openapiDocument().paths)
			.filter(([path]) => path !== '/api/openapi.json')
			.flatMap(([path, operations]) =>
				Object.entries(operations)
					.filter(([, operation]) => !('503' in (operation as { responses: Record<string, unknown> }).responses))
					.map(([method]) => `${method.toUpperCase()} ${path}`),
			);

		expect(missing).toEqual([]);
	});

	it('参照した名前が全てcomponentsに在る', () => {
		// $refの綴り違いは生成時まで未発覚, ここで検出
		const document = openapiDocument();
		const names = new Set(Object.keys(document.components.schemas));
		const referenced = [...JSON.stringify(document).matchAll(/#\/components\/schemas\/([A-Za-z]+)/g)].map((m) => m[1] as string);

		expect(referenced.length).toBeGreaterThan(0);
		expect([...new Set(referenced)].filter((name) => !names.has(name))).toEqual([]);
	});

	it('並べ替えの選択肢が実装と一致する', () => {
		const sort = (
			openapiDocument().paths['/api/jobs']?.get as { parameters: { name: string; schema: { enum?: string[] } }[] }
		).parameters.find((parameter) => parameter.name === 'sort');
		expect(sort?.schema.enum).toEqual([...SORTABLE_COLUMNS]);
	});

	it('scheduleがIANAタイムゾーンを公開する', () => {
		const schema = openapiDocument().components.schemas.Schedule as {
			required: string[];
			properties: Record<string, { type?: string; description?: string }>;
		};
		expect(schema.required).toContain('time_zone');
		expect(schema.properties.time_zone).toMatchObject({ type: 'string' });
		expect(schema.properties.time_zone?.description).toContain('IANA time zone');
	});

	it('版がpackage.jsonと一致する', () => {
		// 実行時はpackage.json読込不可、写しの更新漏れは旧バージョンの仕様配布
		const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
		expect(API_VERSION).toBe(version);
	});

	it('生成器の表現差が正規化されている', () => {
		// 正規化漏れは利用者のクライアント生成物を変更(ADR-0038)
		// これらの表現の意図的な使用時はemit-module.mjsの正規化と本テストを併せて更新
		const text = JSON.stringify(openapiDocument());
		expect(text).not.toContain('"unevaluatedProperties"');
		expect(text).not.toContain('"anyOf"');
		expect(text).not.toContain('"explode":false');
	});
});
