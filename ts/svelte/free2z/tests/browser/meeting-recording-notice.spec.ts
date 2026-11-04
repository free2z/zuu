import { expect, test, type Page } from "@playwright/test";

import { devSourceModuleLoader } from "./dev-source-module";

const NOTICE_LOADER = devSourceModuleLoader(
  "/src/lib/components/stream/MeetingRecordingNotice.svelte",
);

async function mountNotice(page: Page) {
  await page.goto("/search");
  await page.evaluate(async (loader) => {
    class Emitter {
      listeners = new Map<string, Set<(...args: unknown[]) => void>>();
      addListener(event: string, fn: (...args: unknown[]) => void) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(fn);
        return this;
      }
      removeListener(event: string, fn: (...args: unknown[]) => void) {
        this.listeners.get(event)?.delete(fn);
        return this;
      }
      emit(event: string, ...args: unknown[]) {
        for (const fn of this.listeners.get(event) ?? []) fn(...args);
      }
    }

    const recording = Object.assign(new Emitter(), { recordingState: "IDLE" });
    const stage = Object.assign(new Emitter(), { status: "OFF_STAGE" });
    const meeting = {
      recording,
      stage,
      meta: { viewType: "WEBINAR" as string },
    };
    Object.assign(window, { __recordingNotice: { meeting } });

    document.body.innerHTML =
      '<main id="harness" style="position:relative;width:100%;height:640px;background:#060f06"></main>';
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const [{ default: MeetingRecordingNotice }, { mount }] = await Promise.all([
      new Function(loader)(),
      import(/* @vite-ignore */ svelteModule),
    ]);
    mount(MeetingRecordingNotice, {
      target: document.querySelector("#harness")!,
      props: { meeting },
    });
  }, NOTICE_LOADER);
}

async function setRecording(
  page: Page,
  recordingState: string,
  stageStatus = "OFF_STAGE",
  viewType = "WEBINAR",
) {
  await page.evaluate(
    ({ recordingState, stageStatus, viewType }) => {
      const meeting = (window as any).__recordingNotice.meeting;
      meeting.meta.viewType = viewType;
      meeting.stage.status = stageStatus;
      meeting.recording.recordingState = recordingState;
      meeting.stage.emit("stageStatusUpdate", stageStatus);
      meeting.recording.emit("recordingUpdate", recordingState);
    },
    { recordingState, stageStatus, viewType },
  );
}

test("an idle meeting shows no recording notice", async ({ page }) => {
  await mountNotice(page);
  await expect(page.getByTestId("meeting-recording-notice")).toHaveCount(0);
});

test("participants see a persistent notice, and the stage copy is stronger", async ({
  page,
}) => {
  await mountNotice(page);
  const notice = page.getByTestId("meeting-recording-notice");

  await setRecording(page, "STARTING");
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute("data-emphasis", "audience");
  await expect(notice).toHaveAttribute("data-on-stage", "false");
  await expect(notice.getByRole("status")).toHaveText("Recording is starting.");

  await setRecording(page, "RECORDING", "ON_STAGE");
  await expect(notice).toHaveAttribute("data-emphasis", "stage");
  await expect(notice).toHaveAttribute("data-on-stage", "true");
  await expect(notice.getByRole("status")).toHaveText(
    "You are on stage and this meeting is being recorded.",
  );

  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(notice.getByRole("status")).toBeVisible();
  await expect(notice.getByRole("status")).toHaveText(
    "You are on stage and this meeting is being recorded.",
  );

  await setRecording(page, "PAUSED", "OFF_STAGE", "LIVESTREAM");
  await expect(notice).toHaveAttribute("data-emphasis", "audience");
  await expect(notice.getByRole("status")).toHaveText("Recording is paused.");

  await setRecording(page, "RECORDING", "OFF_STAGE", "GROUP_CALL");
  await expect(notice).toHaveAttribute("data-emphasis", "stage");
  await expect(notice).toHaveAttribute("data-on-stage", "false");
  await expect(notice.getByRole("status")).toHaveText(
    "This meeting is being recorded.",
  );

  await setRecording(page, "IDLE");
  await expect(notice).toHaveCount(0);
});
