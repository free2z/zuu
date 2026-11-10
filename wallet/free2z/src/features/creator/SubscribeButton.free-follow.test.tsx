// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  creatorFollow: vi.fn(),
  mySubscriptions: vi.fn(),
}));
const notices = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/lib/api/free2z", () => ({ discover: {}, tuzi: api }));
vi.mock("sonner", () => ({ toast: notices }));
vi.mock("@/store/session", () => ({
  useSession: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        user: { username: "fan", free2zaddr: "fan" },
        loading: false,
        tuzis: 0,
        adjustTuzis: vi.fn(),
      }),
    {
      getState: () => ({ user: { username: "fan" } }),
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
        "creator.follow.following": "Following",
        "creator.follow.unfollow": `Unfollow ${values?.name ?? ""}`,
        "creator.follow.success": `Following ${values?.name ?? ""}. Free creator follow only; no paid membership or renewal started.`,
        "creator.follow.unfollowSuccess": `Unfollowed ${values?.name ?? ""}. Free creator follow only; no paid membership or renewal started.`,
        "creator.follow.unavailable": "Membership price unavailable",
        "creator.follow.retry": "Retry follow status",
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
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  api.creatorFollow
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce({ following: true })
    .mockResolvedValueOnce(true);
  api.mySubscriptions.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("SubscribeButton free follow", () => {
  it("confirms Following from the authoritative GET after a successful Follow", async () => {
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    expect(host.querySelector("button")?.textContent).toContain("Follow");
    await act(async () => {
      host.querySelector("button")?.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(
      api.creatorFollow.mock.calls.map(([name, method]) => [name, method]),
    ).toEqual([
      ["creator", "state"],
      ["creator", "follow"],
      ["creator", "state"],
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Following");
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(notices.success).toHaveBeenCalledWith(
      expect.stringMatching(/Following Creator Name/),
    );
    expect(notices.success.mock.calls[0]?.[0]).not.toMatch(
      /unlocked|subscriber posts|livestream access/i,
    );
    expect(notices.success).toHaveBeenCalledTimes(1);
  });

  it("unfollows through DELETE and confirms Follow from GET", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => host.querySelector("button")?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(api.creatorFollow.mock.calls.map(([, method]) => method)).toEqual([
      "state",
      "unfollow",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Follow");
  });

  it("recovers a recorded mutation with a GET-only retry after refresh failure", async () => {
    api.creatorFollow
      .mockReset()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(true);
    await act(async () =>
      root.render(<SubscribeButton creator={creator} restored={null} />),
    );
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    await act(async () => host.querySelector("button")?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(notices.error).toHaveBeenCalledWith(
      expect.stringContaining("recorded"),
    );
    await act(async () => host.querySelector("button")?.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(api.creatorFollow.mock.calls.map(([, method]) => method)).toEqual([
      "state",
      "follow",
      "state",
      "state",
    ]);
    expect(host.querySelector("button")?.textContent).toContain("Following");
  });
});
