import { afterEach, describe, expect, it } from "vitest";
import type { AuthUser } from "@/lib/api/types";
import { useSession } from "./session";

const user: AuthUser = {
  username: "sender",
  display_name: "Sender",
  tuzis: 1_000,
};

afterEach(() => {
  useSession.setState({ user: null, tuzis: 0, loading: true });
});

describe("authoritative session balance", () => {
  it("replaces both the balance selector and cached user snapshot", () => {
    useSession.setState({ user, tuzis: user.tuzis, loading: false });
    useSession.getState().setTuzis(875.5);

    expect(useSession.getState().tuzis).toBe(875.5);
    expect(useSession.getState().user?.tuzis).toBe(875.5);
  });
});
