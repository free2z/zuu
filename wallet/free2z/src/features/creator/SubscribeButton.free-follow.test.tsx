// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  creatorFollow: vi.fn(),
  mySubscriptions: vi.fn(),
  subscribe: vi.fn(),
  unsubscribe: vi.fn(),
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
const session = vi.hoisted(() => ({
  user: { username: "fan", free2zaddr: "fan" },
  loading: false,
  tuzis: 1000,
}));
vi.mock("@/lib/api/free2z", () => ({ discover: {}, tuzi: api }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/store/session", () => ({
  useSession: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        ...session,
        adjustTuzis: vi.fn(),
      }),
    {
      getState: () => ({ user: session.user }),
      subscribe: () => () => {},
    },
  ),
}));
vi.mock("@/hooks/useAsync", () => ({
  useAsync: () => ({ data: [], reload: vi.fn() }),
}));
vi.mock("@/hooks/usePaidIntent", () => ({ usePaidIntent: () => null }));
vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/creator" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      ({
        "creator.follow.action": "Follow",
        "creator.follow.actionAccessible": `Follow ${values?.name ?? ""}`,
        "creator.follow.following": "Following",
        "creator.follow.unfollow": `Unfollow ${values?.name ?? ""}`,
        "creator.follow.retry": "Retry follow status",
        "creator.follow.unavailable": "Membership price unavailable",
        "creator.follow.readError": "Could not read follow status.",
        "creator.follow.mutationError": "Could not update your free follow.",
        "creator.follow.unknown":
          "We couldn't confirm whether your free follow change was applied. Check follow status before trying again.",
        "creator.follow.success": `You're following ${values?.name}. This free follow does not start a paid membership or renewal.`,
        "creator.follow.unfollowSuccess": `You unfollowed ${values?.name}. This free follow does not change any paid membership or renewal.`,
      })[key] ?? key,
  }),
}));

import { SubscribeButton } from "./index";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const creator = {
  username: "creator",
  display_name: "Creator Name",
  free2zaddr: "creator",
  member_price: 0,
} as any;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.resetAllMocks();
  session.user = { username: "fan", free2zaddr: "fan" };
  session.loading = false;
  session.tuzis = 1000;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.creatorFollow.mockResolvedValue({ following: false });
  api.mySubscriptions.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function flush() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("free creator follow", () => {
  it("loads state from the backend and reconciles a follow without membership claims", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce({ following: false })
      .mockResolvedValueOnce({ following: true })
      .mockResolvedValueOnce({ following: true });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    expect(host.querySelector("button")?.textContent).toContain("Follow");
    await act(async () => host.querySelector("button")?.click());
    await flush();

    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "follow",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Following");
    expect(host.querySelector("[role=dialog]")).toBeNull();
    expect(notices.success).toHaveBeenCalledWith(
      expect.stringContaining("You're following Creator Name"),
    );
    expect(notices.success.mock.calls[0]?.[0]).not.toMatch(
      /unlocked|subscriber posts|livestream access/i,
    );
    expect(api.subscribe).not.toHaveBeenCalled();
    expect(api.unsubscribe).not.toHaveBeenCalled();
  });

  it("unfollows through the free graph and confirms the authoritative state", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce({ following: true })
      .mockResolvedValueOnce({ following: false })
      .mockResolvedValueOnce({ following: false });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Unfollow Creator Name",
    );
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "unfollow",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Follow");
    expect(notices.success).toHaveBeenCalledWith(
      expect.stringContaining("You unfollowed Creator Name"),
    );
  });

  it("requires a status refresh after a successful mutation whose read failed", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce({ following: false })
      .mockResolvedValueOnce({ following: true })
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce(new Error("still offline"))
      .mockResolvedValueOnce({ following: true });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(host.querySelector("button")?.textContent).toContain(
      "Retry follow status",
    );
    expect(notices.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "couldn't confirm whether your free follow change was applied",
      ),
    );
    expect(notices.error.mock.calls[0]?.[0]).not.toMatch(/recorded|saved/i);
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "follow",
      "state",
      "state",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Following");
  });

  it("reports unknown outcome when the write and reconciliation read both fail", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce({ following: false })
      .mockRejectedValueOnce(new Error("write rejected before commit"))
      .mockRejectedValueOnce(new Error("status unavailable"))
      .mockResolvedValueOnce({ following: false });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(host.querySelector("button")?.textContent).toContain(
      "Retry follow status",
    );
    expect(notices.success).not.toHaveBeenCalled();
    expect(notices.error).toHaveBeenCalledWith(
      "We couldn't confirm whether your free follow change was applied. Check follow status before trying again.",
    );
    expect(notices.error.mock.calls[0]?.[0]).not.toMatch(/recorded|saved/i);

    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(host.querySelector("button")?.textContent).toContain("Follow");
    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "follow",
      "state",
      "state",
    ]);
  });

  it("reconciles an ambiguous mutation before reporting success or failure", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce({ following: false })
      .mockRejectedValueOnce(new Error("response lost after write"))
      .mockResolvedValueOnce({ following: true });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "follow",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Following");
    expect(notices.success).toHaveBeenCalledWith(
      expect.stringContaining("You're following Creator Name"),
    );
  });

  it("keeps the initial status read from racing a manual retry", async () => {
    const initialRead = deferred<{ following: boolean }>();
    api.creatorFollow.mockReset().mockReturnValueOnce(initialRead.promise);
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    const initialButton = host.querySelector("button")!;
    expect(initialButton.textContent).toContain("Follow");
    expect(initialButton.disabled).toBe(true);
    await act(async () => initialButton.click());
    expect(api.creatorFollow).toHaveBeenCalledTimes(1);

    await act(async () => initialRead.resolve({ following: false }));
    await flush();
    expect(host.querySelector("button")?.disabled).toBe(false);
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Follow Creator Name",
    );
  });

  it("resets busy state and suppresses stale results after switching creators", async () => {
    const pendingFollow = deferred<{ following: boolean }>();
    api.creatorFollow.mockImplementation((username: string, action: string) => {
      if (username === "creator" && action === "state")
        return Promise.resolve({ following: false });
      if (username === "creator" && action === "follow")
        return pendingFollow.promise;
      if (username === "other" && action === "state")
        return Promise.resolve({ following: false });
      throw new Error(`Unexpected follow request: ${username} ${action}`);
    });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    await act(async () => host.querySelector("button")?.click());
    await flush();
    expect(host.querySelector("button")?.disabled).toBe(true);

    await act(async () =>
      root.render(
        <SubscribeButton
          creator={{ ...creator, username: "other", display_name: "Other" }}
          restored={null}
        />,
      ),
    );
    await flush();
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Follow Other",
    );
    expect(host.querySelector("button")?.disabled).toBe(false);
    pendingFollow.resolve({ following: true });
    await flush();
    expect(host.querySelector("button")?.textContent).toContain("Follow");
    expect(notices.success).not.toHaveBeenCalled();
    expect(
      api.creatorFollow.mock.calls.map(([username, action]) => [
        username,
        action,
      ]),
    ).toEqual([
      ["creator", "state"],
      ["creator", "follow"],
      ["other", "state"],
    ]);
  });

  it("resets busy state and suppresses stale results after switching accounts", async () => {
    const pendingFollow = deferred<{ following: boolean }>();
    api.creatorFollow
      .mockResolvedValueOnce({ following: false })
      .mockReturnValueOnce(pendingFollow.promise)
      .mockResolvedValueOnce({ following: true });
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    await act(async () => host.querySelector("button")?.click());
    await flush();
    session.user = { username: "second-fan", free2zaddr: "second-fan" };
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await flush();
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBe(
      "Unfollow Creator Name",
    );
    expect(host.querySelector("button")?.disabled).toBe(false);
    pendingFollow.resolve({ following: true });
    await flush();
    expect(host.querySelector("button")?.textContent).toContain("Following");
    expect(notices.success).not.toHaveBeenCalled();
    expect(api.creatorFollow.mock.calls.map(([, action]) => action)).toEqual([
      "state",
      "follow",
      "state",
    ]);
  });

  it("preserves the paid Subscribe dialog only for a positive finite price", async () => {
    await act(async () =>
      root.render(
        <SubscribeButton
          creator={{ ...creator, member_price: 250 }}
          restored={null}
        />,
      ),
    );
    const subscribe = host.querySelector("button")!;
    expect(subscribe.textContent).toContain("Subscribe · 250 2Z/mo");
    expect(subscribe.getAttribute("aria-label")).toBe(
      "Subscribe to Creator Name · 250 2Z/mo",
    );
    expect(subscribe.disabled).toBe(false);
    expect(api.creatorFollow).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, "bad"])(
    "keeps malformed member price %s from showing a paid or free action",
    async (member_price) => {
      await act(async () =>
        root.render(
          <SubscribeButton
            creator={{ ...creator, member_price } as any}
            restored={null}
          />,
        ),
      );
      const button = host.querySelector("button")!;
      expect(button.textContent).toContain("Membership price unavailable");
      expect(button.disabled).toBe(true);
      expect(api.subscribe).not.toHaveBeenCalled();
      expect(api.creatorFollow).not.toHaveBeenCalled();
    },
  );
});
