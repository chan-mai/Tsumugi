import { useStorage } from '@vueuse/core';
import { watch } from 'vue';
import { createI18n } from 'vue-i18n';
import { timeLocale } from '../time';
import en from './en';
import ja from './ja';

export const LOCALES = [
	{ key: 'ja', label: '日本語', time: 'ja-JP' },
	{ key: 'en', label: 'English', time: 'en-US' },
] as const;
export type Locale = (typeof LOCALES)[number]['key'];

const isLocale = (value: unknown): value is Locale => LOCALES.some((locale) => locale.key === value);

const detected: Locale = navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en';

export const locale = useStorage<Locale>('tsumugi:locale', detected, undefined, {
	serializer: { read: (raw) => (isLocale(raw) ? raw : detected), write: (value) => value },
});

export const i18n = createI18n<[typeof en], Locale, false>({
	legacy: false,
	locale: locale.value,
	fallbackLocale: 'en',
	messages: { en, ja },
});

watch(
	locale,
	(next) => {
		i18n.global.locale.value = next;
		document.documentElement.lang = next;
		timeLocale.value = LOCALES.find((entry) => entry.key === next)?.time;
	},
	{ immediate: true },
);
