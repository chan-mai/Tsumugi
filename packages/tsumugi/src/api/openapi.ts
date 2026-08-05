import { OPENAPI_DOCUMENT } from '@tsumugi/spec';

/**
 * REST APIのOpenAPI定義
 *
 * 定義の源泉は`packages/spec`のTypeSpecで, ビルドが文書を`@tsumugi/spec`へ焼き込む(ADR-0038)
 * ここは版の注入だけを行う, `/api/openapi.json`が返す内容そのもの
 */

/**
 * 定義に載せる版
 * package.jsonは実行時に読めないので写しを持つ, ずれは単体テストで突き合わせる
 */
export const API_VERSION = '0.6.0';

/** 3.1のJSON Schemaに沿う最小の型, 生成器へそのまま渡すので構造は緩く保つ */
export type OpenApiDocument = {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
	security?: Record<string, string[]>[];
};

/** 生成した文書は版を持たないので, ここで実際の版を埋める */
export function openapiDocument(): OpenApiDocument {
	return { ...OPENAPI_DOCUMENT, info: { ...OPENAPI_DOCUMENT.info, version: API_VERSION } };
}
