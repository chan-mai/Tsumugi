import { DASHBOARD_HTML } from '@tsumugi/dashboard';

export type UiOptions = {
	/**
	 * トークン保存cookie名, `bearerAuth`の`cookie`と同一
	 * 指定時はAPIの401で入力欄表示
	 * Cloudflare Access等ブラウザ側で認証完結する構成では不要
	 */
	tokenCookie?: string;
};

export type Ui = {
	render(): string;
};

// 注入済みHTML再利用, リクエスト毎の約440KB置換回避
const rendered = new Map<string, string>();

function inject(tokenCookie: string | undefined): string {
	const key = tokenCookie ?? '';
	const cached = rendered.get(key);
	if (cached !== undefined) return cached;

	// JSON.stringifyは`/`未エスケープ, `</script>`含む値でタグ終了
	const config = JSON.stringify({ tokenCookie: tokenCookie ?? null }).replace(/</g, '\\u003c');
	const html = DASHBOARD_HTML.replace('<head>', `<head><script>window.__TSUMUGI__=${config}</script>`);
	rendered.set(key, html);
	return html;
}

export function ui(options: UiOptions = {}): Ui {
	const tokenCookie = options.tokenCookie;
	return {
		render: () => inject(tokenCookie),
	};
}

/** テスト, 設定変更時の注入済みHTML破棄 */
export function clearUiCache(): void {
	rendered.clear();
}
