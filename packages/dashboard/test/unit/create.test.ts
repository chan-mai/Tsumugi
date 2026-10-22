import { afterEach, describe, expect, it, vi } from 'vitest';
import { createJob, startRun } from '../../src/api';

// 502や503はWorkerの手前でHTMLが返り得る, 本文がJSONでなくても状態コードで失敗を示す
const htmlResponse = (status: number) => new Response('<html>Bad Gateway</html>', { status, headers: { 'content-type': 'text/html' } });

describe('投入と開始の失敗', () => {
	afterEach(() => void vi.unstubAllGlobals());

	it('JSONでない本文でも状態コードを理由にする', async () => {
		vi.stubGlobal('fetch', async () => htmlResponse(502));
		await expect(createJob({ binding: 'MAIL', payload: {} })).rejects.toThrow('502');
		await expect(startRun({ flow: 'report', input: {} })).rejects.toThrow('502');
	});

	it('サーバが返した理由をそのまま使う', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ error: 'unknown binding: NOPE' }, { status: 400 }));
		await expect(createJob({ binding: 'NOPE', payload: {} })).rejects.toThrow('unknown binding: NOPE');
	});

	it('成功時は作成したIDを返す', async () => {
		vi.stubGlobal('fetch', async () => Response.json({ id: 'MAIL#0:x' }, { status: 201 }));
		await expect(createJob({ binding: 'MAIL', payload: {} })).resolves.toEqual({ id: 'MAIL#0:x' });
	});
});
