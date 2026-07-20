// 管理ダッシュボード,数百KBの文字列を全利用者のバンドルに載せないため別サブパスにする(ADR-0025)
export { clearUiCache, ui } from '../ui/serve.js';
export type { Ui, UiOptions } from '../ui/serve.js';
