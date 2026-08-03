// tsp compileが出したdist/openapi.jsonをTSモジュールとして焼き込む
// `@tsumugi/dashboard`のemit-module.mjsと同じ配布方式(ADR-0038)
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const document = JSON.parse(readFileSync(new URL('../dist/openapi.json', import.meta.url), 'utf8'));

/**
 * 生成器の表現差を従来の手書き文書の形へ正規化する
 * 意味は同じでも表現が変わると, 利用者のクライアント生成物が移行だけで変わってしまう
 * - `anyOf: [{type}, {type: 'null'}]`は3.1のtype配列へ畳む。制約が枝の中に在る等の畳めない形はそのまま残す
 * - `unevaluatedProperties`は`additionalProperties`へ(Recordの表現, 対応する生成器が広い)
 * - スカラーのクエリパラメータで意味を持たない`explode: false`, 既定値と同じ`required: false`, 空のparametersは落とす
 */
const isNullUnion = (value) =>
	Array.isArray(value?.anyOf) &&
	value.anyOf.length === 2 &&
	value.anyOf.every((entry) => typeof entry?.type === 'string' && Object.keys(entry).length === 1) &&
	value.anyOf.some((entry) => entry.type === 'null');

// explodeは配列とオブジェクトでは直列化を変えるので, スカラーに限って落とす
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
			const scalar = entry.find((option) => option.type !== 'null');
			if (scalar !== undefined) {
				out.type = [scalar.type, 'null'];
				continue;
			}
		}
		out[key === 'unevaluatedProperties' ? 'additionalProperties' : key] = normalize(entry);
	}
	return out;
};

const normalized = normalize(document);
delete normalized.tags;
// httpのscheme名は小文字で書く, 従来の文書に合わせる
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
