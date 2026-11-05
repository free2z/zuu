// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import { setToken } from "@/lib/api/http";
import { useSession } from "@/store/session";
import { useModeration } from "@/store/moderation";
import { moderation } from "@/lib/api/moderation";
import {
  BlockedContent,
  BlockManagement,
  ModerationControls,
} from "./Moderation";

vi.mock("@/lib/api/moderation", () => ({
  moderation: { list: vi.fn(), setBlocked: vi.fn(), report: vi.fn() },
}));

const api = vi.mocked(moderation);
const click = async (element: Element | null) => {
  if (!element) throw new Error("Missing control");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};
const button = (label: string) =>
  [...document.querySelectorAll("button")].find(
    (x) => x.textContent?.trim() === label
  ) ?? null;
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockResolvedValue([]);
  api.setBlocked.mockResolvedValue();
  api.report.mockResolvedValue();
  setToken("token-a");
  useSession.getState().setUser({ username: "alice", tuzis: 0 });
  await act(async () => {
    await useModeration.getState().load();
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useSession.getState().setUser(null);
  setToken(null);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["comment", "comment-id"],
  ["zpage", "page-id"],
  ["creator", "bob"],
] as const)("reports %s and blocks its author", async (kind, targetId) => {
  await act(async () =>
    root.render(
      <TestI18nProvider>
        <BlockedContent username="bob">
          <span>content</span>
          <ModerationControls username="bob" kind={kind} targetId={targetId} />
        </BlockedContent>
        <BlockManagement />
      </TestI18nProvider>
    )
  );
  await click(button("Report"));
  await click(button("Send report"));
  expect(api.report).toHaveBeenCalledWith(
    kind,
    targetId,
    "csae",
    "",
    expect.objectContaining({ token: "token-a" }),
    "alice"
  );
  await click(button("Block"));
  expect(document.body.textContent).toContain(
    "Content hidden from a blocked account."
  );
  await click(button("Blocked accounts"));
  expect(document.body.textContent).toContain("@bob");
  await click(button("Unblock"));
  expect(document.body.textContent).toContain("content");
});

it("shows a retry when loading fails", async () => {
  api.list.mockRejectedValueOnce(new Error("offline"));
  await act(async () => {
    await useModeration.getState().load();
  });
  await act(async () =>
    root.render(
      <TestI18nProvider>
        <BlockManagement />
      </TestI18nProvider>
    )
  );
  await click(button("Blocked accounts"));
  expect(document.body.textContent).toContain(
    "Could not load blocked accounts."
  );
  await click(button("Retry"));
  expect(document.body.textContent).toContain("No blocked accounts.");
});

it("shows a mutation failure without hiding the content", async () => {
  api.setBlocked.mockRejectedValueOnce(new Error("offline"));
  await act(async () =>
    root.render(
      <TestI18nProvider>
        <BlockedContent username="bob">
          <span>content</span>
          <ModerationControls username="bob" kind="comment" targetId="id" />
        </BlockedContent>
      </TestI18nProvider>
    )
  );
  await click(button("Block"));
  expect(document.body.textContent).toContain("Request failed. Try again.");
  expect(document.body.textContent).toContain("content");
  expect(useModeration.getState().names).not.toContain("bob");
});

it("drops a late mutation when the token and actor change", async () => {
  let finish!: () => void;
  api.setBlocked.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  await act(async () =>
    root.render(
      <TestI18nProvider>
        <ModerationControls username="bob" kind="creator" targetId="bob" />
      </TestI18nProvider>
    )
  );
  await click(button("Block"));
  await act(async () => {
    setToken("token-b");
    useSession.getState().setUser({ username: "charlie", tuzis: 0 });
  });
  await act(async () => {
    finish();
  });
  expect(useModeration.getState().names).not.toContain("bob");
});

it("drops a late block-list result from the previous account", async () => {
  let finish!: (names: string[]) => void;
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = useModeration.getState().load();
  });
  await act(async () => {
    setToken("token-b");
    useSession.getState().setUser({ username: "charlie", tuzis: 0 });
  });
  await act(async () => {
    finish(["bob"]);
    await pending;
  });
  expect(useModeration.getState().names).not.toContain("bob");
  expect(useModeration.getState().owner?.username).toBe("charlie");
});

it("rejects an old request after the same token returns in a new epoch", async () => {
  let finish!: (names: string[]) => void;
  api.list.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  let pending!: Promise<void>;
  await act(async () => {
    pending = useModeration.getState().load();
  });
  await act(async () => {
    setToken(null);
    useSession.getState().setUser(null);
    setToken("token-a");
    useSession.getState().setUser({ username: "alice", tuzis: 0 });
  });
  await act(async () => {
    finish(["bob"]);
    await pending;
  });
  expect(useModeration.getState().names).not.toContain("bob");
});

describe("localized controls", () => {
  it("renders Spanish and French labels", async () => {
    await act(async () =>
      root.render(
        <TestI18nProvider locale="es">
          <ModerationControls username="bob" kind="creator" targetId="bob" />
        </TestI18nProvider>
      )
    );
    expect(document.body.textContent).toContain("Denunciar");
    await act(async () =>
      root.render(
        <TestI18nProvider locale="fr">
          <ModerationControls username="bob" kind="creator" targetId="bob" />
        </TestI18nProvider>
      )
    );
    expect(document.body.textContent).toContain("Signaler");
  });
});
