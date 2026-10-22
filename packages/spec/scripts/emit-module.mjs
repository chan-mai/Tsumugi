// `@tsumugi/dashboard`のemit-module.mjsと同じ配布方式(ADR-0038)
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const document = JSON.parse(readFileSync(new URL('../dist/openapi.json', import.meta.url), 'utf8'));

// 生成器出力を公開済み文書の表現へ正規化, 利用者のクライアント生成物の差分防止
// `additionalProperties`は対応生成器が多い
const isNullUnion = (value) =>
	Array.isArray(value?.anyOf) &&
	value.anyOf.length === 2 &&
	value.anyOf.some((entry) => entry?.type === 'null' && Object.keys(entry).length === 1) &&
	value.anyOf.some((entry) => typeof entry?.type === 'string' && entry.type !== 'null');

// explodeは配列, オブジェクトの直列化に影響, スカラーのみ削除
const scalarSchema = (schema) => typeof schema?.type === 'string' && schema.type !== 'array' && schema.type !== 'object';

const normalize = (value) => {
	if (Array.isArray(value)) return value.map(normalize);
	if (value === null || typeof value !== 'object') return value;

	const out = {};
	for (const [key, entry] of Object.entries(value)) {
		if (key === 'explode' && entry === false && scalarSchema(value.schema)) continue;
		if (key === 'required' && entry === false) continue;
		if (key === 'parameters' && Array.isArray(entry) && entry.length === 0) continue;
		if (key === 'anyOf' && isNullUnion(value)) {
			const { type, ...rest } = entry.find((option) => option.type !== 'null');
			out.type = [type, 'null'];
			for (const [name, constraint] of Object.entries(rest)) out[name] = normalize(constraint);
			continue;
		}
		out[key === 'unevaluatedProperties' ? 'additionalProperties' : key] = normalize(entry);
	}
	return out;
};

const normalized = normalize(document);
delete normalized.tags;
// 公開済み文書と同じ小文字のscheme名
normalized.components.securitySchemes.bearerAuth.scheme = 'bearer';

const source = JSON.stringify(normalized);
writeFileSync(new URL('../dist/index.js', import.meta.url), `export const OPENAPI_DOCUMENT = ${source};\n`);
writeFileSync(
	new URL('../dist/index.d.ts', import.meta.url),
	`export declare const OPENAPI_DOCUMENT: {
	openapi: string;
	info: { title: string; version: string; description?: string };
	paths: Record<string, Record<string, unknown>>;
	components: { schemas: Record<string, unknown>; securitySchemes?: Record<string, unknown> };
	security?: Record<string, string[]>[];
};\n`,
);

console.log(`spec: ${(source.length / 1024).toFixed(1)}KB (gzip ${(gzipSync(Buffer.from(source)).length / 1024).toFixed(1)}KB)`);
