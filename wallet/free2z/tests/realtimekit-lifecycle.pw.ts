import { expect, test } from "@playwright/test";

// Real Stage in Chromium; provider hooks/UI are replaced. This proves wrapper
// lifecycle handling, not signed-token acceptance or SFU/media reconnection.
test("Stage handles joined, disconnected, left, ended, and init rejection", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const listeners = new Map<string, Set<(value?: unknown) => void>>();
    const meeting = {
      self: {
        on(event: string, fn: (value?: unknown) => void) {
          if (!listeners.has(event)) listeners.set(event, new Set());
          listeners.get(event)!.add(fn);
        },
        off(event: string, fn: (value?: unknown) => void) {
          listeners.get(event)?.delete(fn);
        },
      },
    };
    (window as any).__rtk = {
      meeting,
      init: async () => meeting,
      emit: (event: string, value?: unknown) =>
        listeners.get(event)?.forEach((fn) => fn(value)),
    };
  });
  await page.route("**/src/features/live/Stage.tsx*", async (route) => {
    const source = await (await route.fetch()).text();
    const rewritten = source.replace(
      /from "[^"\n]*@cloudflare_realtimekit-react[^"\n]*"/g,
      (match) =>
        match.includes("react-ui")
          ? 'from "/__rtk_ui.js"'
          : 'from "/__rtk_core.js"'
    );
    await route.fulfill({
      contentType: "application/javascript",
      body: rewritten,
    });
  });
  await page.route("**/__rtk_core.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    export const useRealtimeKitClient = () => [window.__rtk.meeting, window.__rtk.init];
    export const RealtimeKitProvider = ({children}) => children;
  `,
    })
  );
  await page.route("**/__rtk_ui.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: `
    import React from '/node_modules/.vite/deps/react.js';
    export const RtkMeeting = () => React.createElement('div', {'data-testid':'mock-meeting'}, 'Provider UI boundary');
  `,
    })
  );
  await page.goto("/");
  await page.evaluate(async () => {
    const load = (path: string) => import(path);
    const { default: React } = await load("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } = await load(
      "/node_modules/.vite/deps/react-dom_client.js"
    );
    const { createRoot } = ReactDOM;
    const { Stage } = await load("/src/features/live/Stage.tsx");
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(
      React.createElement(Stage, {
        ticket: {
          authToken: "fake",
          meetingId: "fake",
          environmentId: "fake",
          as: "host",
        },
      })
    );
  });
  await expect(page.getByTestId("mock-meeting")).toBeVisible();
  const emit = (event: string, value?: unknown) =>
    page.evaluate(
      ({ event, value }) => (window as any).__rtk.emit(event, value),
      { event, value }
    );
  await emit("roomJoined");
  await emit("roomLeft", { state: "disconnected" });
  await expect(page.getByTestId("mock-meeting")).toBeVisible();
  await emit("roomJoined");
  await emit("roomLeft", { state: "left" });
  await expect(page.getByTestId("mock-meeting")).toBeVisible();
  await emit("roomLeft", { state: "ended" });
  await expect(page.getByTestId("mock-meeting")).toHaveCount(0);
  await page.evaluate(async () => {
    (window as any).__rtk.init = async () => {
      throw new Error("Invalid auth token");
    };
    const load = (path: string) => import(path);
    const { default: React } = await load("/node_modules/.vite/deps/react.js");
    const { default: ReactDOM } = await load(
      "/node_modules/.vite/deps/react-dom_client.js"
    );
    const { createRoot } = ReactDOM;
    const { Stage } = await load("/src/features/live/Stage.tsx");
    const el = document.createElement("div");
    document.body.append(el);
    createRoot(el).render(
      React.createElement(Stage, {
        ticket: {
          authToken: "rejected-fake",
          meetingId: "fake",
          environmentId: "fake",
          as: "participant",
        },
      })
    );
  });
  await expect(
    page.getByText("The live service rejected this connection. Try again.")
  ).toBeVisible();
});
