import { writable, derived } from "svelte/store";
import { browser } from "$app/env";

// Types
export interface CreatorsFilterState {
  searchQuery: string;
  debouncedSearch: string;
  verifiedFilter: "all" | "verified" | "unverified";
  membershipFilter: "all" | "free" | "paid";
  onlyZcash: boolean;
  minPosts: number | null;
  minFollowers: number | null;
  sortBy: string;
}

// Configuration options (static)
export const sortOptions = [
  // Popular/Trending
  { value: "popular", label: "Most Popular", group: "trending" },
  { value: "updated", label: "Recently Updated", group: "trending" },
  { value: "recent_activity", label: "Recent Activity", group: "trending" },
  // Followers
  { value: "followers_desc", label: "Most Followers", group: "followers" },
  { value: "followers_asc", label: "Fewest Followers", group: "followers" },
  // Content
  { value: "content_desc", label: "Most Content", group: "content" },
  { value: "content_asc", label: "Least Content", group: "content" },
  // Membership
  { value: "newest", label: "Newest Members", group: "membership" },
  { value: "oldest", label: "Oldest Members", group: "membership" },
  // Price
  { value: "price_asc", label: "Cheapest First", group: "price" },
  { value: "price_desc", label: "Premium First", group: "price" },
  // Alphabetical
  { value: "alphabetical_asc", label: "A → Z", group: "alpha" },
  { value: "alphabetical_desc", label: "Z → A", group: "alpha" },
] as const;

export const sortGroups = [
  { key: "trending", label: "Trending" },
  { key: "followers", label: "By Followers" },
  { key: "content", label: "By Content" },
  { key: "membership", label: "By Join Date" },
  { key: "price", label: "By Price" },
  { key: "alpha", label: "Alphabetical" },
] as const;

export const verifiedOptions = [
  { value: "all", label: "All Creators" },
  { value: "verified", label: "Verified Only" },
  { value: "unverified", label: "Not Yet Verified" },
] as const;

export const membershipOptions = [
  { value: "all", label: "Any Price" },
  { value: "free", label: "Free to Follow" },
  { value: "paid", label: "Paid Subscription" },
] as const;

// Default state
const defaultState: CreatorsFilterState = {
  searchQuery: "",
  debouncedSearch: "",
  verifiedFilter: "all",
  membershipFilter: "all",
  onlyZcash: false,
  minPosts: null,
  minFollowers: null,
  sortBy: "popular",
};

// "At least N" thresholds are non-negative whole numbers or nothing at all.
//
// This is load-bearing for minFollowers as of: it is sent to the API as
// `min_followers`, which rejects a negative with a 400, and the number input
// accepts `-1` regardless of its `min="0"` attribute. Without this, typing a
// minus sign replaces the whole directory with "Could not load creators" —
// and because the value is persisted, a reload restores the broken state
// rather than clearing it. Sanitising once, here, covers the input, the
// localStorage round-trip and every future caller.
function sanitizeThreshold(value: number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value)) return null;
  const n = Math.trunc(value);
  return n > 0 ? n : null;
}

// Load from localStorage
function loadFromStorage(): Partial<CreatorsFilterState> {
  if (!browser) return {};

  const state: Partial<CreatorsFilterState> = {};

  const savedVerified = localStorage.getItem("creators_verified_status");
  if (
    savedVerified &&
    ["all", "verified", "unverified"].includes(savedVerified)
  ) {
    state.verifiedFilter = savedVerified as "all" | "verified" | "unverified";
  }

  const savedMembership = localStorage.getItem("creators_membership_filter");
  if (savedMembership && ["all", "free", "paid"].includes(savedMembership)) {
    state.membershipFilter = savedMembership as "all" | "free" | "paid";
  }

  const savedP2P = localStorage.getItem("creators_p2p_filter");
  if (savedP2P) {
    state.onlyZcash = savedP2P === "true";
  }

  const savedMinPosts = localStorage.getItem("creators_minPosts");
  if (savedMinPosts) {
    const v = sanitizeThreshold(parseInt(savedMinPosts));
    if (v !== null) state.minPosts = v;
  }

  const savedMinFollowers = localStorage.getItem("creators_minFollowers");
  if (savedMinFollowers) {
    // Sanitised on the way OUT of storage too, not only on the way in:
    // a value persisted by an older bundle is still in browsers today.
    const v = sanitizeThreshold(parseInt(savedMinFollowers));
    if (v !== null) state.minFollowers = v;
  }

  const savedSort = localStorage.getItem("creators_sortBy");
  if (savedSort && sortOptions.some((o) => o.value === savedSort)) {
    state.sortBy = savedSort;
  }

  return state;
}

// Save to localStorage
function saveToStorage(state: CreatorsFilterState) {
  if (!browser) return;

  localStorage.setItem("creators_verified_status", state.verifiedFilter);
  localStorage.setItem("creators_membership_filter", state.membershipFilter);
  localStorage.setItem("creators_p2p_filter", String(state.onlyZcash));
  localStorage.setItem("creators_minPosts", String(state.minPosts ?? ""));
  localStorage.setItem(
    "creators_minFollowers",
    String(state.minFollowers ?? ""),
  );
  localStorage.setItem("creators_sortBy", state.sortBy);
}

// Create the store
function createCreatorsFilterStore() {
  const initialState = { ...defaultState, ...loadFromStorage() };
  const { subscribe, set, update } =
    writable<CreatorsFilterState>(initialState);

  let debounceTimer: ReturnType<typeof setTimeout>;

  return {
    subscribe,

    setSearchQuery: (query: string) => {
      update((state) => ({ ...state, searchQuery: query }));

      // Debounce the search
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        update((state) => {
          const newState = { ...state, debouncedSearch: query };
          return newState;
        });
      }, 500);
    },

    setVerifiedFilter: (filter: "all" | "verified" | "unverified") => {
      update((state) => {
        const newState = { ...state, verifiedFilter: filter };
        saveToStorage(newState);
        return newState;
      });
    },

    setMembershipFilter: (filter: "all" | "free" | "paid") => {
      update((state) => {
        const newState = { ...state, membershipFilter: filter };
        saveToStorage(newState);
        return newState;
      });
    },

    setOnlyZcash: (value: boolean) => {
      update((state) => {
        const newState = { ...state, onlyZcash: value };
        saveToStorage(newState);
        return newState;
      });
    },

    setMinPosts: (value: number | null) => {
      update((state) => {
        const newState = { ...state, minPosts: sanitizeThreshold(value) };
        saveToStorage(newState);
        return newState;
      });
    },

    setMinFollowers: (value: number | null) => {
      update((state) => {
        const newState = { ...state, minFollowers: sanitizeThreshold(value) };
        saveToStorage(newState);
        return newState;
      });
    },

    setSortBy: (sort: string) => {
      update((state) => {
        const newState = { ...state, sortBy: sort };
        saveToStorage(newState);
        return newState;
      });
    },

    clearFilters: () => {
      update((state) => {
        const newState = {
          ...defaultState,
          searchQuery: "",
          debouncedSearch: "",
        };
        saveToStorage(newState);
        return newState;
      });
    },

    // Reinitialize from localStorage (useful for onMount)
    initFromStorage: () => {
      update((state) => ({
        ...state,
        ...loadFromStorage(),
      }));
    },
  };
}

export const creatorsFilterStore = createCreatorsFilterStore();

// Derived stores for convenience
export const activeFilterCount = derived(
  creatorsFilterStore,
  ($store) =>
    [
      $store.verifiedFilter !== "all",
      $store.membershipFilter !== "all",
      $store.onlyZcash,
      $store.minPosts,
      $store.minFollowers,
      $store.searchQuery,
    ].filter(Boolean).length,
);

// Drives the "auto-fetch another page because filters emptied the grid" loop
// on /creators. `minFollowers` is deliberately NOT in here: it is applied by
// the API (`min_followers`) as of, so the server already returns a full
// page of matching creators and there is nothing for the client to refill.
export const hasClientSideFilters = derived(
  creatorsFilterStore,
  ($store) =>
    $store.membershipFilter !== "all" || $store.onlyZcash || !!$store.minPosts,
);

// Trigger content helpers
export const sortTriggerContent = derived(
  creatorsFilterStore,
  ($store) =>
    sortOptions.find((o) => o.value === $store.sortBy)?.label ?? "Sort by...",
);

export const verifiedTriggerContent = derived(
  creatorsFilterStore,
  ($store) =>
    verifiedOptions.find((o) => o.value === $store.verifiedFilter)?.label ??
    "Verification",
);

export const membershipTriggerContent = derived(
  creatorsFilterStore,
  ($store) =>
    membershipOptions.find((o) => o.value === $store.membershipFilter)?.label ??
    "Membership",
);

// Compute API sort params from sortBy
export function getApiSortParams(sort: string): {
  ordering?: string;
  homeSort?: string;
} {
  switch (sort) {
    case "updated":
      return { homeSort: "updated" };
    case "newest":
      return { ordering: "-date_joined" };
    case "oldest":
      return { ordering: "date_joined" };
    case "alphabetical_asc":
      return { ordering: "username" };
    case "alphabetical_desc":
      return { ordering: "-username" };
    case "popular":
      // `total` is `Creator.cache_total()`: Sum(zpage.total) + tuzis/1000,
      // a ZEC-denominated page-support score. That is a fair proxy for
      // "popular" — it is just not a follower count (issue ).
      return { ordering: "-total" };
    case "followers_desc":
      return { ordering: "-fans_count" };
    case "followers_asc":
      return { ordering: "fans_count" };
    default:
      // For client-side only sorts (content_*, recent_activity, price_*), fetch by default order
      return {};
  }
}
