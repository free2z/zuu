import { create } from "zustand";
import { auth } from "@/lib/api/free2z";
import { isAuthed, setToken } from "@/lib/api/http";
import type { AuthUser } from "@/lib/api/types";

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
}

export const useSession = create<SessionState>((set, get) => ({
  user: null,
  loading: true,
  tuzis: 0,

  async bootstrap() {
    if (!isAuthed()) {
      set({ loading: false });
      return;
    }
    try {
      const user = await auth.me();
      set({ user, tuzis: user.tuzis ?? 0, loading: false });
    } catch {
      setToken(null);
      set({ user: null, loading: false });
    }
  },

  setUser(user) {
    set({ user, tuzis: user?.tuzis ?? 0, loading: false });
  },

  async refresh() {
    try {
      const user = await auth.me();
      set({ user, tuzis: user.tuzis ?? 0 });
    } catch {
      /* ignore */
    }
  },

  async logout() {
    await auth.logout();
    set({ user: null, tuzis: 0 });
  },

  adjustTuzis(delta) {
    set({ tuzis: Math.max(0, get().tuzis + delta) });
  },
}));
