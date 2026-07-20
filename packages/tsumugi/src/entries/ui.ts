// 管理ダッシュボード,数百KBの文字列を全利用者のバンドルに載せないため別サブパスにする(ADR-0025)
export type UiOptions = {
	/** ダッシュボードをマウントするパス,配信時にHTMLへ注入される */
	basePath?: string;
};
