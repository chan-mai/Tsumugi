// バッククォート, `${`のエスケープ漏れ回避でJSON.stringify
import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

const html = readFileSync(new URL('../dist/index.html', import.meta.url), 'utf8');

// U+2028/U+2029はJSON.stringify未エスケープかつJSでは行終端子
const literal = JSON.stringify(html)
	.replace(/\u2028/g, '\\u2028')
	.replace(/\u2029/g, '\\u2029');

writeFileSync(new URL('../dist/index.js', import.meta.url), `export const DASHBOARD_HTML = ${literal};\n`);
writeFileSync(new URL('../dist/index.d.ts', import.meta.url), 'export declare const DASHBOARD_HTML: string;\n');

const raw = Buffer.byteLength(html);
const gzip = gzipSync(html).length;
console.log(`  dashboard: ${(raw / 1024).toFixed(1)}KB (gzip ${(gzip / 1024).toFixed(1)}KB)`);
