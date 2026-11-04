import {
  page as currentPage,
  navigating as currentNavigation,
} from "$app/state";
import { toStore, type Readable } from "svelte/store";
import type { Page } from "$app/state";
import type { Navigation } from "$app/navigation";

/**
 * Legacy components subscribe during initialization, preserving request-local
 * SSR state. Each subscription reads SvelteKit's reactive state in its own
 * effect; no user data or navigation snapshot is cached at module scope.
 */
type LegacyPage = Omit<Page, "url"> & { url: URL };

export const page: Readable<LegacyPage> = {
  subscribe(run, invalidate) {
    return toStore(() => ({
      data: currentPage.data,
      error: currentPage.error,
      form: currentPage.form,
      params: currentPage.params,
      route: currentPage.route,
      state: currentPage.state,
      status: currentPage.status,
      shallow: currentPage.shallow,
      url: new URL(currentPage.url.href),
    })).subscribe(run, invalidate);
  },
};

export const navigating: Readable<Navigation | null> = {
  subscribe(run, invalidate) {
    let previous: Navigation | null = null;
    return toStore(() => {
      const { from, to, type, complete } = currentNavigation;
      if (type === null) return (previous = null);
      // Preserve identity for the duration of a navigation: components use it
      // to prevent a completed request from affecting a later navigation.
      if (previous?.complete === complete) return previous;
      return (previous = {
        ...currentNavigation,
        from,
        to,
        type,
        complete,
      } as Navigation);
    }).subscribe(run, invalidate);
  },
};
