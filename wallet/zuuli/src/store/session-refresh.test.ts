import { afterEach, expect, it, vi } from "vitest";
import { auth } from "@/lib/api/free2z";
import { ApiError, getTokenSnapshot, setToken } from "@/lib/api/http";
import { useSession } from "./session";
import type { AuthUser } from "@/lib/api/types";
const a: AuthUser = { id: 1, username: "A", tuzis: 100 };
const b: AuthUser = { id: 2, username: "B", tuzis: 200 };
afterEach(() => {
  vi.restoreAllMocks();
  setToken(null);
  useSession.setState({ user: null, tuzis: 0 });
});
it.each(["B", "ABA", "cancel"])(
  "refresh cannot publish a late A response after %s",
  async (transition) => {
    setToken("token-A");
    useSession.getState().setUser(a);
    let resolve!: (user: AuthUser) => void;
    vi.spyOn(auth, "me").mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    let mounted = true;
    const refresh = useSession.getState().refresh({ isCurrent: () => mounted });
    expect(auth.me).toHaveBeenCalledWith("token-A");
    if (transition === "cancel") mounted = false;
    else {
      setToken("token-B");
      useSession.getState().setUser(b);
      if (transition === "ABA") {
        setToken("token-A");
        useSession.getState().setUser(a);
      }
    }
    resolve({ ...a, tuzis: 999 });
    await refresh;
    expect(useSession.getState().user).toEqual(transition === "B" ? b : a);
    expect(useSession.getState().tuzis).toBe(transition === "B" ? 200 : 100);
  },
);
it("stale expired-session failure cannot clear B's token or balance", async () => {
  setToken("token-A");
  useSession.getState().setUser(a);
  let reject!: (error: Error) => void;
  vi.spyOn(auth, "me").mockImplementation(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
  );
  const refresh = useSession.getState().refresh();
  setToken("token-B");
  useSession.getState().setUser(b);
  reject(new ApiError(401, "expired"));
  await refresh;
  expect(getTokenSnapshot().token).toBe("token-B");
  expect(useSession.getState().user).toEqual(b);
});
it("renderer A -> B -> A is fenced even with an unchanged token", async () => {
  setToken("token-A");
  useSession.getState().setUser(a);
  let resolve!: (user: AuthUser) => void;
  vi.spyOn(auth, "me").mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const refresh = useSession.getState().refresh();
  useSession.getState().setUser(b);
  useSession.getState().setUser(a);
  resolve({ ...a, tuzis: 999 });
  await refresh;
  expect(useSession.getState().tuzis).toBe(100);
});
