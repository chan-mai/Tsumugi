import { OPENAPI_DOCUMENT } from '@tsumugi/spec';

// 定義原本は`packages/spec`のTypeSpec, ビルドで`@tsumugi/spec`へ出力(ADR-0038)

// package.jsonは実行時読込不可で写しを保持, 差異は単体テストで検査
export const API_VERSION = '0.10.1';

export type OpenApiDocument = typeof OPENAPI_DOCUMENT;

export function openapiDocument(): OpenApiDocument {
	return { ...OPENAPI_DOCUMENT, info: { ...OPENAPI_DOCUMENT.info, version: API_VERSION } };
}
