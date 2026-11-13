import { afterEach, describe, expect, it, vi } from "vitest";
import * as notifications from "@/lib/notifications/bridge";
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
  it("waits for native disable even if independent account revocation fails", async () => {
    let finishDisable!: (value: { state: "revocation-pending"; wake: boolean }) => void;
    vi.spyOn(notifications, "notificationCommand").mockImplementation(() => new Promise((resolve) => { finishDisable = resolve; }));
    const failure = new Error("account logout failed");
    const revokeAccount = vi.spyOn(auth, "logout").mockRejectedValue(failure);
    useSession.setState({ user, tuzis: user.tuzis, loading: false });
    let settled = false;
    const result = useSession.getState().logout().then(() => null, (error: unknown) => error).finally(() => { settled = true; });
    expect(revokeAccount).toHaveBeenCalledOnce();
    expect(notifications.notificationCommand).toHaveBeenCalledWith("disable");
    expect(useSession.getState().user).toBeNull();
    await Promise.resolve();
    expect(settled).toBe(false);
    finishDisable({ state: "revocation-pending", wake: false });
    expect(await result).toBe(failure);
  });

});
