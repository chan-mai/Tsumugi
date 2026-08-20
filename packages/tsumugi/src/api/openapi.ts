import { OPENAPI_DOCUMENT } from '@tsumugi/spec';

/**
 * REST APIのOpenAPI定義
 *
 * 定義の原本は`packages/spec`のTypeSpecで、ビルドが文書を`@tsumugi/spec`へ出力(ADR-0038)
 * ここは版の注入のみ, `/api/openapi.json`が返す内容そのもの
 */

/**
 * 定義に載せる版
 * package.jsonは実行時に読めず写しを保持, ずれは単体テストで検査
 */
export const API_VERSION = '0.7.1';

/** 3.1のJSON Schemaに沿う最小の型, 生成器へそのまま渡す前提で構造は緩いまま維持 */
export type OpenApiDocument = {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
	security?: Record<string, string[]>[];
};

/** 生成した文書は版を持たず, ここで実際の版を設定 */
export function openapiDocument(): OpenApiDocument {
	return { ...OPENAPI_DOCUMENT, info: { ...OPENAPI_DOCUMENT.info, version: API_VERSION } };
}
