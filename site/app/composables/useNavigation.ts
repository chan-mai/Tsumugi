export function useNavigation() {
	const { t } = useI18n();
	const localePath = useLocalePath();

	const groups = computed<NavGroup[]>(() =>
		sidebar.map((group) => ({
			text: t(`nav.${group.key}`),
			items: group.items.map((item) => ({ text: t(`nav.pages.${item.key}`), link: localePath(item.link) })),
		})),
	);
	const sections = computed<NavItem[]>(() => topNav.map((item) => ({ text: t(`nav.${item.key}`), link: localePath(item.link) })));

	function groupOf(path: string) {
		return groups.value.find((group) => group.items.some((item) => item.link === normalizePath(path)));
	}

	function surroundings(path: string): { prev?: NavItem; next?: NavItem } {
		const items = groups.value.flatMap((group) => group.items);
		const index = items.findIndex((item) => item.link === normalizePath(path));
		if (index < 0) return {};
		return { prev: items[index - 1], next: items[index + 1] };
	}

	function breadcrumbs(path: string, title: string): BreadcrumbItem[] {
		const group = groupOf(path);
		return [
			{ text: t('nav.home'), link: localePath('/') },
			...(group ? [{ text: group.text, link: group.items[0]!.link }] : []),
			{ text: title },
		];
	}

	return { groups, sections, groupOf, surroundings, breadcrumbs };
}
