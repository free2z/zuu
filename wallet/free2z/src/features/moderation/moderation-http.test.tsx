// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TestI18nProvider } from "@/i18n/test-provider";
import { setToken } from "@/lib/api/http";
import { useSession } from "@/store/session";
import { useModeration } from "@/store/moderation";
import { BlockedContent, ModerationControls } from "./Moderation";

it("renders a real HTTP contract failure and rejects a delayed old-session result", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let finish: ((response: Response) => void) | undefined;
  let delay = false;
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("blocks/mine"))
      return new Response(
        JSON.stringify({ count: 0, next: null, results: [] }),
      );
    if (delay)
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    return new Response(JSON.stringify({ username: "wrong", active: true }));
  });
  vi.stubGlobal("fetch", fetch);
  window.fetch = fetch as typeof window.fetch;
  setToken("token-a");
  useSession.getState().setUser({ username: "alice", tuzis: 0 });
  await act(async () => {
    await useModeration.getState().load();
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <TestI18nProvider>
        <BlockedContent username="bob">
          <span>content</span>
        </BlockedContent>
        <ModerationControls username="bob" kind="creator" targetId="bob" />
      </TestI18nProvider>,
    ),
  );
  const block = () =>
    [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Block",
    )!;
  await act(async () => {
    block().click();
  });
  expect(container.textContent).toContain("Request failed. Try again.");
  expect(container.textContent).toContain("content");
  expect(useModeration.getState().names).not.toContain("bob");
  delay = true;
  await act(async () => {
    block().click();
  });
  expect(finish).toBeDefined();
  await act(async () => {
    setToken(null);
    useSession.getState().setUser(null);
    setToken("token-a");
    useSession.getState().setUser({ username: "alice", tuzis: 0 });
    finish?.(new Response(JSON.stringify({ username: "bob", active: true })));
  });
  expect(useModeration.getState().names).not.toContain("bob");
  expect(container.textContent).toContain("content");
  await act(async () => root.unmount());
  container.remove();
  useSession.getState().setUser(null);
  setToken(null);
  vi.unstubAllGlobals();
});
