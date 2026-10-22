import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	bulkAction,
	getMetrics,
	isMetricsUnavailable,
	isUnauthorized,
	listSchedules,
	retryJob,
	saveToken,
	unauthorized,
} from '../../src/api';

describe('共通の応答処理', () => {
	afterEach(() => void vi.unstubAllGlobals());

	it('501: 機能未設定エラー', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ error: 'not configured' }, { status: 501 }));
		await expect(getMetrics({ hours: 24 })).rejects.toSatisfy(isMetricsUnavailable);
		await expect(listSchedules()).rejects.toSatisfy(isMetricsUnavailable);
	});

	it('401: トークン再入力エラー', async () => {
		vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
		await expect(bulkAction('retry', { ids: ['MAIL#0:a'] })).rejects.toSatisfy(isUnauthorized);
	});

	it('401でトークン入力への切替フラグが立つ', async () => {
		unauthorized.value = false;
		vi.stubGlobal('fetch', async () => new Response(null, { status: 401 }));
		await expect(retryJob('MAIL#0:a')).rejects.toSatisfy(isUnauthorized);
		expect(unauthorized.value).toBe(true);
	});

	it('トークン保存前に発行した要求の401ではフラグを立てない', async () => {
		unauthorized.value = false;
		let respond: (res: Response) => void = () => {};
		vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => (respond = resolve)));
		vi.stubGlobal('window', { __TSUMUGI__: { tokenCookie: null } });
		const pending = listSchedules();
		saveToken('new-token');
		respond(new Response(null, { status: 401 }));
		await expect(pending).rejects.toSatisfy(isUnauthorized);
		expect(unauthorized.value).toBe(false);
	});

	it('欠けた項目は空補完', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ ok: ['MAIL#0:a'] }));
		await expect(bulkAction('retry', { ids: ['MAIL#0:a'] })).resolves.toEqual({ ok: ['MAIL#0:a'], failed: [] });
		await expect(listSchedules()).resolves.toEqual([]);
	});
});
