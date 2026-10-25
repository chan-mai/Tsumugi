export function usePageTitle(title?: MaybeRefOrGetter<string | undefined>) {
	const site = useSiteConfig();
	const full = () => {
		const value = toValue(title);
		return value ? `${value} | ${site.name}` : site.name;
	};
	useSeoMeta({ title: full, ogTitle: full });
}
