import { DASHBOARD_HTML } from '@tsumugi/dashboard';

export type UiOptions = {
	/**
	 * トークンを保存するcookie名, `bearerAuth`の`cookie`と同一
	 * 指定するとAPIが401を返した時に入力欄を表示
	 * Cloudflare Accessのようにブラウザが自力で認証できる構成では不要
	 */
	tokenCookie?: string;
};

export type Ui = {
	render(): string;
};

/** 注入済みHTMLの再利用, リクエストごとの数十KBの置換を回避 */
const rendered = new Map<string, string>();

function inject(tokenCookie: string | undefined): string {
	const key = tokenCookie ?? '';
	const cached = rendered.get(key);
	if (cached !== undefined) return cached;

	// JSON.stringifyは`/`をエスケープせず、`</script>`を含む値でタグが閉じる
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

/** テストや設定変更時の注入済みHTMLの破棄 */
export function clearUiCache(): void {
	rendered.clear();
}
