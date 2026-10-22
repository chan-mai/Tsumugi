import { OPENAPI_DOCUMENT } from '@tsumugi/spec';

// 定義原本は`packages/spec`のTypeSpec, ビルドで`@tsumugi/spec`へ出力(ADR-0038)

// package.jsonは実行時読込不可で写しを保持, 差異は単体テストで検査
export const API_VERSION = '0.10.1';

/** 3.1のJSON Schema準拠の最小型, 生成器へ直接渡す前提で構造は緩く維持 */
export type OpenApiDocument = {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
	security?: Record<string, string[]>[];
};

export function openapiDocument(): OpenApiDocument {
	return { ...OPENAPI_DOCUMENT, info: { ...OPENAPI_DOCUMENT.info, version: API_VERSION } };
}
