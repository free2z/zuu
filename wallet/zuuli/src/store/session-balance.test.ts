import { afterEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/lib/api/free2z";
import type { AuthUser } from "@/lib/api/types";
import { useSession } from "./session";

const user: AuthUser = {
  username: "sender",
  display_name: "Sender",
  tuzis: 1_000,
};

afterEach(() => {
  vi.restoreAllMocks();
  useSession.setState({ user: null, tuzis: 0, loading: true });
});

describe("authoritative session balance", () => {
  it("replaces both the balance selector and cached user snapshot", () => {
    useSession.setState({ user, tuzis: user.tuzis, loading: false });
    useSession.getState().setTuzis(875.5);

    expect(useSession.getState().tuzis).toBe(875.5);
    expect(useSession.getState().user?.tuzis).toBe(875.5);
  });

  it("clears private renderer state before remote revocation settles", async () => {
    let finishRevocation!: () => void;
    vi.spyOn(auth, "logout").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRevocation = resolve;
        }),
    );
    useSession.setState({ user, tuzis: user.tuzis, loading: false });

    const logout = useSession.getState().logout();

    expect(useSession.getState().user).toBeNull();
    expect(useSession.getState().tuzis).toBe(0);
    finishRevocation();
    await logout;
  });
});
