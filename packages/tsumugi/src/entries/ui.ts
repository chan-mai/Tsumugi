// 管理ダッシュボード用別サブパス, 数百KB文字列の全利用者バンドル混入回避(ADR-0025)
export { clearUiCache, ui } from '../ui/serve.js';
export type { Ui, UiOptions } from '../ui/serve.js';
