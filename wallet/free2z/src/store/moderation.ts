import { create } from "zustand";
import {
  getTokenSnapshot,
  onTokenChange,
  type TokenSnapshot,
} from "@/lib/api/http";
import { moderation } from "@/lib/api/moderation";
import { useSession } from "./session";

interface Owner {
  username: string;
  token: TokenSnapshot;
}
function currentOwner(): Owner | null {
  const username = useSession.getState().user?.username;
  const token = getTokenSnapshot();
  return username && token.token
    ? { username: username.toLowerCase(), token }
    : null;
}
function sameOwner(a: Owner | null, b: Owner | null): boolean {
  return (
    !!a &&
    !!b &&
    a.username === b.username &&
    a.token.token === b.token.token &&
    a.token.generation === b.token.generation
  );
}
interface State {
  owner: Owner | null;
  names: string[];
  status: "idle" | "loading" | "ready" | "error";
  revision: number;
  sync: () => void;
  load: () => Promise<void>;
  toggle: (username: string, blocked: boolean) => Promise<void>;
}
export const useModeration = create<State>((set, get) => ({
  owner: null,
  names: [],
  status: "idle",
  revision: 0,
  sync() {
    const owner = currentOwner();
    if (sameOwner(owner, get().owner)) return;
    set({ owner, names: [], status: "idle", revision: get().revision + 1 });
    if (owner) void get().load();
  },
  async load() {
    const owner = currentOwner();
    if (!sameOwner(owner, get().owner) || !owner) return;
    const revision = get().revision;
    set({ status: "loading" });
    try {
      const names = await moderation.list(owner.token, owner.username);
      if (
        sameOwner(owner, currentOwner()) &&
        sameOwner(owner, get().owner) &&
        get().revision === revision
      ) {
        set({ names, status: "ready" });
      }
    } catch {
      if (
        sameOwner(owner, currentOwner()) &&
        sameOwner(owner, get().owner) &&
        get().revision === revision
      )
        set({ status: "error" });
    }
  },
  async toggle(username, blocked) {
    const owner = currentOwner();
    if (!sameOwner(owner, get().owner) || !owner)
      throw new Error("Session changed");
    await moderation.setBlocked(username, blocked, owner.token, owner.username);
    if (!sameOwner(owner, currentOwner()) || !sameOwner(owner, get().owner))
      throw new Error("Session changed");
    const normalized = username.toLowerCase();
    set((state) => ({
      names: blocked
        ? [...new Set([...state.names, normalized])]
        : state.names.filter((name) => name.toLowerCase() !== normalized),
      status: "ready",
      revision: state.revision + 1,
    }));
    if (!blocked) window.dispatchEvent(new Event("free2z-moderation-refresh"));
  },
}));

// A token change can precede the matching user update. Clear synchronously;
// only the session store's subsequent user update may establish an owner.
onTokenChange(() =>
  useModeration.setState((state) => ({
    owner: null,
    names: [],
    status: "idle",
    revision: state.revision + 1,
  })),
);
useSession.subscribe(() => useModeration.getState().sync());
useModeration.getState().sync();
