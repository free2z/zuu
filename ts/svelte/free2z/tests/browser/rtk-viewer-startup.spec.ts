import { expect, test } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";

const RTK_UI_LOADER = devSourceModuleLoader("/src/lib/utils/rtk-ui.ts");
const STREAM_PATH_LOADER = devSourceModuleLoader(
  "/src/lib/utils/stream-path.ts",
);

test("RealtimeKit viewer chunks preload and first-frame timing observes shadow DOM", async ({
  page,
}) => {
  await page.goto("/search");
  const result = await page.evaluate(
    async ({ loader, streamPathLoader }) => {
      const { preloadRtkMeeting, observeFirstRtkVideoFrame } =
        await new Function(loader)();
      const { isLiveStreamPath } = await new Function(streamPathLoader)();
      await preloadRtkMeeting();

      const meeting = document.createElement("div");
      const meetingShadow = meeting.attachShadow({ mode: "open" });
      const nested = document.createElement("div");
      meetingShadow.append(nested);
      const nestedShadow = nested.attachShadow({ mode: "open" });
      const video = document.createElement("video");
      let frameCallback: (() => void) | undefined;
      Object.defineProperty(video, "requestVideoFrameCallback", {
        value: (callback: () => void) => {
          frameCallback = callback;
          return 1;
        },
      });
      let frames = 0;
      const stop = observeFirstRtkVideoFrame(document, () => frames++);
      nestedShadow.append(video);
      document.body.append(meeting);
      await new Promise((resolve) => setTimeout(resolve, 0));
      frameCallback?.();
      frameCallback?.();
      stop();
      meeting.remove();

      return {
        registered: Boolean(customElements.get("rtk-meeting")),
        frames,
        livePaths: [
          isLiveStreamPath("/alice/broadcast"),
          isLiveStreamPath("/live/alice"),
          isLiveStreamPath("/alice/private/secret"),
          isLiveStreamPath("/alice/dashboard/stream"),
        ],
        ordinaryPath: isLiveStreamPath("/alice"),
      };
    },
    { loader: RTK_UI_LOADER, streamPathLoader: STREAM_PATH_LOADER },
  );

  expect(result).toEqual({
    registered: true,
    frames: 1,
    livePaths: [true, true, true, true],
    ordinaryPath: false,
  });
});
