export function useLocaleHtmlAttrs() {
	const head = useLocaleHead();
	useHead(() => ({ htmlAttrs: { lang: head.value.htmlAttrs.lang }, link: head.value.link, meta: head.value.meta }));
}
