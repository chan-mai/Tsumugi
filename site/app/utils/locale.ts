export const docsCollections = { ja: 'docs_ja', en: 'docs_en', ko: 'docs_ko' } as const;

export type SiteLocale = keyof typeof docsCollections;

export function toSiteLocale(locale: string): SiteLocale {
	return locale in docsCollections ? (locale as SiteLocale) : 'ja';
}
