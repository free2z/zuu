import { readable } from 'svelte/store';
import { browser } from '$app/environment';

export function createMediaQuery(query: string) {
    return readable(false, (set) => {
        if (!browser) return;
        const mql = window.matchMedia(query);
        set(mql.matches);
        const handler = (e: MediaQueryListEvent) => set(e.matches);
        mql.addEventListener('change', handler);
        return () => mql.removeEventListener('change', handler);
    });
}
