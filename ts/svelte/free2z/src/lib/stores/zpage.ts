import { writable } from 'svelte/store';
import type { ZPageListItem } from '$lib/types/zpage';
import { fetchUserZPages } from '$lib/api/zpage';

interface ZPageStoreState {
  userZPages: ZPageListItem[];
  loading: boolean;
  error: string | null;
  totalCount: number;
}

const initialState: ZPageStoreState = {
  userZPages: [],
  loading: false,
  error: null,
  totalCount: 0,
};

function createZPageStore() {
  const { subscribe, set, update } = writable(initialState);

  return {
    subscribe,

    // Load user's zPages for dashboard
    loadUserZPages: async (options?: {
      published?: boolean;
      refresh?: boolean;
    }) => {
      try {
        update((state) => ({ ...state, loading: true, error: null }));

        const response = await fetchUserZPages({
          published: options?.published,
          limit: 50, // Start with reasonable limit
        });

        update((state) => ({
          ...state,
          userZPages: response.results,
          totalCount: response.count,
          loading: false,
        }));
      } catch (error: any) {
        console.error('Failed to load user zPages:', error);
        update((state) => ({
          ...state,
          error: error.message || 'Failed to load articles',
          loading: false,
        }));
      }
    },

    // Add new zPage to store after creation
    addZPage: (zpage: ZPageListItem) => {
      update((state) => ({
        ...state,
        userZPages: [zpage, ...state.userZPages],
        totalCount: state.totalCount + 1,
      }));
    },

    // Update existing zPage in store
    updateZPage: (updatedZPage: ZPageListItem) => {
      update((state) => ({
        ...state,
        userZPages: state.userZPages.map((zpage) =>
          zpage.free2zaddr === updatedZPage.free2zaddr ? updatedZPage : zpage
        ),
      }));
    },

    // Remove zPage from store after deletion
    removeZPage: (identifier: string) => {
      update((state) => ({
        ...state,
        userZPages: state.userZPages.filter(
          (zpage) =>
            zpage.free2zaddr !== identifier && zpage.vanity !== identifier
        ),
        totalCount: Math.max(0, state.totalCount - 1),
      }));
    },

    // Clear store
    clear: () => {
      set(initialState);
    },

    // Clear error
    clearError: () => {
      update((state) => ({ ...state, error: null }));
    },
  };
}

export const zpageStore = createZPageStore();
