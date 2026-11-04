import { expect, test } from "@playwright/test";
import { devSourceModuleLoader } from "./dev-source-module";
const loader = devSourceModuleLoader(
  "/src/lib/components/stream/HostRecordingControls.svelte",
);

test("mounted host controls start, stop and show provider processing without SDK events", async ({
  page,
}) => {
  let state = "IDLE";
  const actions: string[] = [];
  await page.route("**/api/dyte/recording-host/recording**", async (route) => {
    const method = route.request().method();
    const action = route.request().url().includes("/recording/stop")
      ? "STOP"
      : method;
    actions.push(action);
    if (action === "POST") state = "RECORDING";
    if (action === "STOP") state = "UPLOADING";
    await route.fulfill({ json: { recording_state: state } });
  });
  await page.goto("/search");
  await page.evaluate(async (loader) => {
    const svelteModule = "/tests/browser/svelte-runtime.ts";
    const [{ default: Controls }, { mount }] = await Promise.all([
      new Function(loader)(),
      import(/* @vite-ignore */ svelteModule),
    ]);
    const target = document.createElement("div");
    target.style.cssText = "position:relative;height:400px";
    document.body.prepend(target);
    mount(Controls, {
      target,
      props: {
        username: "recording-host",
        hostSession: "12345678-1234-4234-8234-123456789abc",
      },
    });
  }, loader);
  await page
    .getByRole("button", { name: "Record livestream", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Stop recording", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Stop recording", exact: true })
    .click();
  await expect(
    page.getByText("Recording is uploading", { exact: true }),
  ).toBeVisible();
  expect(actions.filter((x) => x === "POST")).toHaveLength(1);
  expect(actions.filter((x) => x === "STOP")).toHaveLength(1);
});

test("real UI Kit controlbar removes native record toggle at desktop and mobile sizes; unfiltered private config retains it", async ({
  page,
}) => {
  await page.goto("/search");
  await page.evaluate(async () => {
    const uiLoader = "/@id/@cloudflare/realtimekit-ui/loader";
    const { defineCustomElements } = await import(/* @vite-ignore */ uiLoader);
    await defineCustomElements();
    const module = "/src/lib/utils/recording-controls.ts";
    const { withoutNativeRecording } = await import(/* @vite-ignore */ module);
    const base = {
      root: {
        "rtk-controlbar": ["rtk-recording-toggle", "div#other-control"],
        "rtk-controlbar.sm": ["rtk-recording-toggle", "div#other-control"],
      },
    };
    const meeting = {
      self: { permissions: { canRecord: true } },
      recording: {
        recordingState: "IDLE",
        addListener() {},
        removeListener() {},
      },
    };
    for (const mode of ["public-desktop", "public-mobile", "private"]) {
      const el = document.createElement("rtk-controlbar") as any;
      el.id = mode;
      el.config = mode === "private" ? base : withoutNativeRecording(base);
      el.size = mode === "public-mobile" ? "sm" : "lg";
      el.meeting = meeting;
      el.states = {};
      document.body.prepend(el);
      await el.componentOnReady();
    }
  });
  await expect(page.locator("#private rtk-recording-toggle")).toHaveCount(1);
  await expect(page.locator("#public-desktop #other-control")).toHaveCount(1);
  await expect(page.locator("#public-mobile #other-control")).toHaveCount(1);
  await expect(
    page.locator("#public-desktop rtk-recording-toggle"),
  ).toHaveCount(0);
  await expect(page.locator("#public-mobile rtk-recording-toggle")).toHaveCount(
    0,
  );
});
