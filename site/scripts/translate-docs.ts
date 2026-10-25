// 日本語の原稿を機械翻訳しsite/<言語>/へ出力
// 使い方: node scripts/translate-docs.ts [--all] [原稿のパス...]
import Anthropic from '@anthropic-ai/sdk';
import GithubSlugger from 'github-slugger';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDirs = ['guide', 'reference'];
const concurrency = 4;

const languages = { en: 'English', ko: 'Korean' } as const;
type Language = keyof typeof languages;

function systemPrompt(language: string): string {
	return `You translate Japanese technical documentation for Tsumugi, a job management system for Cloudflare Workers, into ${language}.

Rules:
- Output only the translated Markdown document. Do not wrap it in a code fence and do not add any commentary.
- Keep the frontmatter keys. Translate the values of title and description, and copy every other value unchanged.
- Headings are HTML tags such as <h2 id="binding名">binding名</h2>. Translate only the text between the tags, and keep the tag and its id attribute exactly as written, including Japanese characters inside the id.
- Keep link URLs, image paths, inline code, and identifiers unchanged. Translate only the link text.
- Inside code blocks, translate Japanese comments and leave all code unchanged.
- Keep MDC component syntax such as ::callout{type="warning"} and the closing :: unchanged, and translate the text inside.
- Keep table structure, list structure, and line breaks. Each Japanese sentence is on its own line; keep one translated sentence per line.
- Keep product and API terms as written in the source: Tsumugi, performer, Performer, enqueue, binding, Flow, Run, node, fan-out, subflow, shard, payload, and names in backticks.
- Write plain, precise technical ${language}.`;
}

type Target = { source: string; output: string; language: Language };

function toTargets(path: string): Target[] {
	const source = relative(siteDir, resolve(process.cwd(), path));
	if (!sourceDirs.some((dir) => source.startsWith(`${dir}/`)) || !source.endsWith('.md')) {
		throw new Error(`Not a source document: ${path}`);
	}
	return (Object.keys(languages) as Language[]).map((language) => ({ source, output: join(language, source), language }));
}

async function listSources(): Promise<string[]> {
	const lists = await Promise.all(
		sourceDirs.map(async (dir) =>
			(await readdir(join(siteDir, dir))).filter((name) => name.endsWith('.md')).map((name) => join(dir, name)),
		),
	);
	return lists.flat();
}

// 見出しIDを日本語版と同じ値で固定, MDCは{#id}非対応のためHTMLの見出し
function annotateHeadingIds(markdown: string): { text: string; ids: string[] } {
	const slugger = new GithubSlugger();
	const ids: string[] = [];
	let fence: string | undefined;
	let frontmatter = markdown.startsWith('---\n');
	const lines = markdown.split('\n').map((line, index) => {
		if (frontmatter) {
			if (index > 0 && line === '---') frontmatter = false;
			return line;
		}
		const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
		if (marker) {
			if (!fence) fence = marker;
			else if (marker.startsWith(fence)) fence = undefined;
			return line;
		}
		const heading = !fence && line.match(/^(#{1,6})\s+(.+?)\s*$/);
		if (!heading) return line;
		const id = slugger.slug(heading[2]!).replace(/-+/g, '-').replace(/^-|-$/g, '').replace(/^(\d)/, '_$1');
		ids.push(id);
		const level = heading[1]!.length;
		return `<h${level} id="${id}">${heading[2]}</h${level}>`;
	});
	return { text: lines.join('\n'), ids };
}

// 原稿内リンクを英語版のパスへ, コードブロックは対象外
function localizeLinks(markdown: string, language: Language): string {
	let fence: string | undefined;
	return markdown
		.split('\n')
		.map((line) => {
			const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
			if (marker) {
				if (!fence) fence = marker;
				else if (marker.startsWith(fence)) fence = undefined;
				return line;
			}
			return fence ? line : line.replace(/\]\(\/(guide|reference)\//g, `](/${language}/$1/`);
		})
		.join('\n');
}

const translatedKeys = new Set(['title', 'description']);

// フロントマターの1行1キーの値を取得
function readFrontmatter(markdown: string): Map<string, string> | undefined {
	if (!markdown.startsWith('---\n')) return undefined;
	const end = markdown.indexOf('\n---\n', 3);
	if (end < 0) return undefined;
	const entries = markdown
		.slice(4, end)
		.split('\n')
		.flatMap((line) => {
			const match = line.match(/^([\w-]+):\s*(.*)$/);
			return match ? [[match[1]!, match[2]!.trim()] as const] : [];
		});
	return new Map(entries);
}

// 原稿の全キーの存在と、翻訳対象外の値の一致を確認
function verifyFrontmatter(source: string, translated: string, output: string): void {
	const expected = readFrontmatter(source);
	const actual = readFrontmatter(translated);
	if (!expected || !actual) throw new Error(`Translation of ${output} lost the frontmatter`);
	for (const [key, value] of expected) {
		const translatedValue = actual.get(key);
		if (!translatedValue) throw new Error(`Translation of ${output} lost frontmatter key: ${key}`);
		if (!translatedKeys.has(key) && translatedValue !== value) {
			throw new Error(`Translation of ${output} changed frontmatter ${key}: ${value} -> ${translatedValue}`);
		}
	}
}

async function translate(client: Anthropic, markdown: string, { source, language }: Target): Promise<string> {
	const stream = client.beta.messages.stream({
		model: 'claude-opus-5-5',
		max_tokens: 64000,
		betas: ['server-side-fallback-2026-07-01'],
		fallbacks: 'default',
		output_config: { effort: 'max' },
		system: systemPrompt(languages[language]),
		messages: [{ role: 'user', content: markdown }],
	});
	const message = await stream.finalMessage();
	if (message.stop_reason !== 'end_turn') {
		throw new Error(`Translation of ${source} into ${language} stopped with ${message.stop_reason}`);
	}
	return message.content
		.flatMap((block) => (block.type === 'text' ? [block.text] : []))
		.join('')
		.trim();
}

async function processTarget(client: Anthropic, target: Target): Promise<void> {
	const { source, output, language } = target;
	const markdown = await readFile(join(siteDir, source), 'utf8').catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return undefined;
		throw error;
	});
	if (markdown === undefined) {
		await rm(join(siteDir, output), { force: true });
		console.log(`removed ${output}`);
		return;
	}

	const { text, ids } = annotateHeadingIds(markdown);
	const translated = localizeLinks(await translate(client, text, target), language);
	verifyFrontmatter(markdown, translated, output);
	const missing = ids.filter((id) => !translated.includes(` id="${id}">`));
	if (missing.length) throw new Error(`Translation of ${output} lost heading ids: ${missing.join(', ')}`);

	await mkdir(dirname(join(siteDir, output)), { recursive: true });
	await writeFile(join(siteDir, output), `${translated}\n`);
	console.log(`translated ${source} -> ${output}`);
}

const args = process.argv.slice(2);
const paths = args.includes('--all')
	? (await listSources()).map((source) => join(siteDir, source))
	: args.filter((arg) => !arg.startsWith('--'));
const targets = paths.flatMap(toTargets);
if (!targets.length) {
	console.log('no documents to translate');
	process.exit(0);
}

const client = new Anthropic();
const queue = [...targets];
const failures: string[] = [];
await Promise.all(
	Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
		for (let target = queue.shift(); target; target = queue.shift()) {
			await processTarget(client, target).catch((error: unknown) => {
				failures.push(target!.output);
				console.error(error);
			});
		}
	}),
);
if (failures.length) {
	console.error(`failed: ${failures.join(', ')}`);
	process.exit(1);
}
