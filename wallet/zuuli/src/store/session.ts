import { create } from "zustand";
import { auth } from "@/lib/api/free2z";
import { ApiError, isAuthed, setToken } from "@/lib/api/http";
import {
  discardPaidIntent,
  discardPaidIntentForAccountTransition,
} from "@/lib/auth/paid-intent";
import type { AuthUser } from "@/lib/api/types";
import { allowExplicitAccountTransition } from "@/lib/unsaved-transition";

/**
 * `GET /api/auth/user/` 403s (some deployments 401) for anonymous requests —
 * that's an expected "you're logged out" response, not a real failure, so we
 * never want it surfacing as an uncaught console error. Anything else (a
 * network blip, a 5xx) is transient and shouldn't nuke a valid session.
 */
function isSessionExpired(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 403);
}

interface SessionState {
  user: AuthUser | null;
  loading: boolean;
  /** 2Z balance, kept in sync with the backend / optimistic updates. */
  tuzis: number;

  bootstrap: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** Optimistically adjust the local 2Z balance (e.g. after an AI charge). */
  adjustTuzis: (delta: number) => void;
  /** Replace local money state with a validated authoritative API balance. */
  setTuzis: (balance: number) => void;
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  loading: true,
  tuzis: 0,

  async bootstrap() {
    // No knox token → we're logged out; resolve without ever hitting
    // `/api/auth/user/` (it 403s for anonymous requests).
    if (!isAuthed()) {
      discardPaidIntent();
      set({ loading: false });
      return;
    }
    try {
      const user = await auth.me();
      set({ user, tuzis: user.tuzis ?? 0, loading: false });
    } catch (err) {
      if (isSessionExpired(err)) {
        setToken(null);
        discardPaidIntent();
      }
      set({ user: null, loading: false });
    }
  },

  setUser(user) {
    discardPaidIntentForAccountTransition(
      get().user?.username ?? null,
      user?.username ?? null,
    );
    set({ user, tuzis: user?.tuzis ?? 0, loading: false });
  },

  async refresh() {
    // Same guard as `bootstrap` — logged-out callers must never probe
    // `/api/auth/user/` (see `isSessionExpired` above).
    if (!isAuthed()) return;
    try {
      const user = await auth.me();
      set({ user, tuzis: user.tuzis ?? 0 });
    } catch (err) {
      if (isSessionExpired(err)) {
        setToken(null);
        discardPaidIntent();
        set({ user: null, tuzis: 0 });
      }
      /* otherwise a transient/network error — keep the current session */
    }
  },

  async logout() {
    if (!allowExplicitAccountTransition()) return;
    // Clear private pending input before awaiting a network logout. Even if
    // that request fails, the draft must not survive for another account.
    discardPaidIntent();
    set({ user: null, tuzis: 0 });
    await auth.logout();
  },

  adjustTuzis(delta) {
    set({ tuzis: Math.max(0, get().tuzis + delta) });
  },

  setTuzis(balance) {
    set((state) => ({
      tuzis: balance,
      user: state.user ? { ...state.user, tuzis: balance } : null,
    }));
  },
}));
