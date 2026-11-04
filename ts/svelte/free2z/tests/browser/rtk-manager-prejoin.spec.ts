import { expect, test } from "@playwright/test";

test("host and private meetings wait for pre-join while viewers route join failures", async ({
  page,
}) => {
  await page.goto("/?lang=en");
  const result = await page.evaluate(async () => {
    const managerPath = "/src/lib/utils/rtk-manager.ts";
    const source = await (await fetch(managerPath)).text();
    const sdkPath = source.match(
      /from "([^\"]*cloudflare_realtimekit[^\"]*)"/,
    )?.[1];
    if (!sdkPath) throw new Error("RealtimeKit SDK import was not found");
    const { default: SDK } = await import(sdkPath);
    const { initRtkMeeting } = await import(managerPath);
    const loadModule = new Function("path", "return import(path)");
    const { liveStreamStore } = await loadModule(
      "/src/lib/stores/liveStreamStore.ts",
    );
    let joins = 0;
    let leaves = 0;
    let rejectViewerJoin = false;
    SDK.init = async () => ({
      meta: {},
      join: async () => {
        joins++;
        if (rejectViewerJoin) throw new Error("synthetic viewer join failure");
      },
      self: { on: () => {}, off: () => {} },
      participants: {
        on: () => {},
        off: () => {},
        joined: { on: () => {}, off: () => {}, toArray: () => [] },
      },
      leave: async () => {
        leaves++;
      },
    });
    try {
      const host = await initRtkMeeting({
        authToken: "host-token",
        streamType: "broadcast",
        isHost: true,
        defaults: { audio: true, video: true },
      });
      const hostJoins = joins;
      await host.cleanup();
      const privateCall = await initRtkMeeting({
        authToken: "private-token",
        streamType: "private",
        isHost: false,
        defaults: { audio: true, video: true },
      });
      const privateJoins = joins;
      await privateCall.cleanup();

      rejectViewerJoin = true;
      let viewerError: string | null = null;
      try {
        await initRtkMeeting({
          authToken: "viewer-token",
          streamType: "broadcast",
          isHost: false,
        });
      } catch (error) {
        viewerError = (error as Error).name;
      }
      let state: any;
      liveStreamStore.subscribe((value: any) => (state = value))();
      return {
        hostJoins,
        privateJoins,
        joins,
        leaves,
        viewerError,
        status: state.connectionStatus,
        hasError: Boolean(state.error),
      };
    } finally {
      liveStreamStore.reset();
    }
  });

  expect(result).toEqual({
    hostJoins: 0,
    privateJoins: 0,
    joins: 1,
    leaves: 3,
    viewerError: "LocalizedError",
    status: "failed",
    hasError: true,
  });
});
