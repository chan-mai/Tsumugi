import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { API_VERSION, openapiDocument } from '../../src/api/openapi.js';
import { createRest } from '../../src/api/rest.js';
import { SORTABLE_COLUMNS } from '../../src/api/sort.js';

/**
 * OpenAPI定義の網羅
 *
 * 他言語の利用者はこの定義からクライアントを生成するので, 経路が欠けると存在しないことと同じになる
 * 実装との突き合わせを自動にしないと, 経路を足した時に定義だけ古いまま残る
 */

const packageJson = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

/** Honoの`:id`をOpenAPIの`{id}`へ, 比較のために表記を揃える */
const toTemplate = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/** 実装が登録した経路, ミドルウェアとSPAへの受け皿は除く */
function registeredRoutes(): string[] {
	const noop = async (_c: unknown, next: () => Promise<void>) => {
		await next();
	};
	// 任意の経路を全て有効にする, 渡さないと501を返す経路が登録されない
	const app = createRest(noop as never, {
		bindings: ['MAIL'],
		enqueue: async () => 'MAIL#0:x',
		flows: ['report'],
		start: async () => 'report:x',
		runFor: () => ({ cancel: async () => ({ ok: true }), retry: async () => ({ ok: true }) }),
	});

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
	it('実装した経路を全て載せている', () => {
		expect(documentedRoutes()).toEqual(registeredRoutes());
	});

	it('D1を読む経路が全て503を載せている', () => {
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
		// $refの綴り違いは生成時に初めて落ちる, ここで拾う
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

	it('版がpackage.jsonと一致する', () => {
		// 実行時にpackage.jsonを読めないので写しを持っている, 上げ忘れると古い版の仕様が配られる
		const { version } = JSON.parse(readFileSync(packageJson, 'utf8')) as { version: string };
		expect(API_VERSION).toBe(version);
	});
});
