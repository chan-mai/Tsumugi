import { DASHBOARD_HTML } from '@tsumugi/dashboard';

export type UiOptions = {
	/**
	 * ダッシュボードをマウントするパス
	 * ビルド時には決められないので配信時にHTMLへ注入する
	 */
	basePath?: string;
	/**
	 * トークンを保存するcookie名, `bearerAuth`の`cookie`と揃える
	 * 指定するとAPIが401を返した時に入力欄を出す
	 * Cloudflare Accessのようにブラウザが自力で認証できる構成では不要
	 */
	tokenCookie?: string;
};

export type Ui = {
	basePath: string;
	render(): string;
};

/** 注入済みHTMLの使い回し, リクエストごとに数十KBの置換をしない */
const rendered = new Map<string, string>();

function inject(basePath: string, tokenCookie: string | undefined): string {
	const key = `${basePath}\u0000${tokenCookie ?? ''}`;
	const cached = rendered.get(key);
	if (cached !== undefined) return cached;

	const config = JSON.stringify({ base: basePath, tokenCookie: tokenCookie ?? null });
	const html = DASHBOARD_HTML.replace('<head>', `<head><script>window.__TSUMUGI__=${config}</script>`);
	rendered.set(key, html);
	return html;
}

export function ui(options: UiOptions = {}): Ui {
	const basePath = (options.basePath ?? '').replace(/\/$/, '');
	const tokenCookie = options.tokenCookie;
	return {
		basePath,
		render: () => inject(basePath, tokenCookie),
	};
}

/** テストや設定変更時に注入済みHTMLを捨てる */
export function clearUiCache(): void {
	rendered.clear();
}
