// ビルド済みの単一HTMLをTSモジュールとしてemitする(ADR-0025)
// テンプレートリテラルはバッククォートと`${`のエスケープ漏れを起こすのでJSON.stringifyを使う
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

// JSON.stringifyはU+2028/U+2029をエスケープしない
// JS上では行終端子として扱われるため, 混入した瞬間に構文エラーになる
const literal = JSON.stringify(html)
	.replace(/\u2028/g, '\\u2028')
	.replace(/\u2029/g, '\\u2029');

writeFileSync(new URL('../dist/index.js', import.meta.url), `export const DASHBOARD_HTML = ${literal};\n`);
writeFileSync(new URL('../dist/index.d.ts', import.meta.url), 'export declare const DASHBOARD_HTML: string;\n');

const raw = Buffer.byteLength(html);
const gzip = gzipSync(html).length;
console.log(`  dashboard: ${(raw / 1024).toFixed(1)}KB (gzip ${(gzip / 1024).toFixed(1)}KB)`);
