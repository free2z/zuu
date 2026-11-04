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

      let unrelatedFrameCallback: (() => void) | undefined;
      const unrelatedVideo = document.createElement("video");
      Object.defineProperty(unrelatedVideo, "requestVideoFrameCallback", {
        value: (callback: () => void) => {
          unrelatedFrameCallback = callback;
          return 1;
        },
      });
      document.body.append(unrelatedVideo);

      const meeting = document.createElement("rtk-meeting");
      const meetingShadow =
        meeting.shadowRoot ?? meeting.attachShadow({ mode: "open" });
      const nested = document.createElement("div");
      meetingShadow.append(nested);
      const nestedShadow = nested.attachShadow({ mode: "open" });
      const video = document.createElement("video");
      let frameCallback: (() => void) | undefined;
      let frames = 0;
      let meetingRegistrations = 0;
      Object.defineProperty(video, "requestVideoFrameCallback", {
        value: (callback: () => void) => {
          meetingRegistrations++;
          frameCallback = callback;
          return meetingRegistrations;
        },
      });
      const stopFirstAttempt = observeFirstRtkVideoFrame(
        document,
        () => frames++,
      );
      stopFirstAttempt();
      const stop = observeFirstRtkVideoFrame(document, () => frames++);
      await new Promise((resolve) => setTimeout(resolve, 0));
      nestedShadow.append(video);
      document.body.append(meeting);
      await new Promise((resolve) => setTimeout(resolve, 0));
      frameCallback?.();
      frameCallback?.();
      unrelatedFrameCallback?.();
      const laterVideo = document.createElement("video");
      nestedShadow.append(laterVideo);
      await new Promise((resolve) => setTimeout(resolve, 0));
      stop();
      unrelatedVideo.remove();
      meeting.remove();

      return {
        registered: Boolean(customElements.get("rtk-meeting")),
        frames,
        unrelatedRegistered: Boolean(unrelatedFrameCallback),
        meetingRegistrations,
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
    unrelatedRegistered: false,
    meetingRegistrations: 1,
    livePaths: [true, true, true, true],
    ordinaryPath: false,
  });
});
