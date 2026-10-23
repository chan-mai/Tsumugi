import { useConfirmDialog } from '@vueuse/core';
import { shallowRef } from 'vue';

export type ConfirmOptions = {
	title: string;
	message?: string;
	confirmLabel: string;
	danger?: boolean;
};

const dialog = useConfirmDialog<ConfirmOptions>();
export const confirmRequest = shallowRef<ConfirmOptions | null>(null);
export const { isRevealed, confirm: accept, cancel: dismiss } = dialog;

dialog.onReveal((options) => (confirmRequest.value = options ?? null));

// 確定でtrue
export async function confirmAction(options: ConfirmOptions): Promise<boolean> {
	if (isRevealed.value) dismiss();
	const { isCanceled } = await dialog.reveal(options);
	return !isCanceled;
}
