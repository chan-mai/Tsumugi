import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

let registered = false;

export function useMotion(
	setup: (ctx: { gsap: typeof gsap; ScrollTrigger: typeof ScrollTrigger }) => void,
	scope?: Ref<HTMLElement | null>,
) {
	let mm: gsap.MatchMedia | undefined;
	onMounted(() => {
		if (!registered) {
			gsap.registerPlugin(ScrollTrigger);
			registered = true;
		}
		mm = gsap.matchMedia(scope?.value ?? undefined);
		mm.add('(prefers-reduced-motion: no-preference)', () => setup({ gsap, ScrollTrigger }));
	});
	onBeforeUnmount(() => mm?.revert());
}
