import { create } from "zustand";
import { auth } from "@/lib/api/free2z";
import { ApiError, getTokenSnapshot, isAuthed, setToken } from "@/lib/api/http";
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

let identityGeneration = 0;
function sameAccount(a: AuthUser | null, b: AuthUser | null): boolean {
  return a?.id === b?.id && a?.username === b?.username;
}

/** Includes token rotation and A -> B -> A renderer identity transitions. */
export function captureSessionOwnership(): () => boolean {
  const token = getTokenSnapshot();
  const identity = identityGeneration;
  return () => {
    const current = getTokenSnapshot();
    return (
      current.token === token.token &&
      current.generation === token.generation &&
      identity === identityGeneration
    );
  };
}

interface SessionState {
  user: AuthUser | null;
  loading: boolean;
  /** 2Z balance, kept in sync with the backend / optimistic updates. */
  tuzis: number;

  bootstrap: () => Promise<void>;
  setUser: (user: AuthUser | null) => void;
  refresh: (options?: { isCurrent?: () => boolean }) => Promise<void>;
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

  async refresh(options) {
    if (!isAuthed()) return;
    const token = getTokenSnapshot();
    const owner = get().user;
    const ownsSession = captureSessionOwnership();
    const current = () => ownsSession() && (options?.isCurrent?.() ?? true);
    try {
      // Pin the request credential, then fence actual state publication. A
      // check by the caller AFTER refresh cannot undo a foreign publication.
      const user = await auth.me(token.token ?? undefined);
      if (!current() || (owner !== null && !sameAccount(owner, user))) return;
      set({ user, tuzis: user.tuzis ?? 0 });
    } catch (err) {
      if (!current()) return;
      if (isSessionExpired(err)) {
        setToken(null);
        discardPaidIntent();
        set({ user: null, tuzis: 0 });
      }
      /* otherwise keep the current authoritative session */
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

// Observe identity changes even through store adapters; a final A identity does
// not make an earlier A request current again after an intervening B identity.
useSession.subscribe((state, previous) => {
  if (!sameAccount(state.user, previous.user)) identityGeneration += 1;
});
