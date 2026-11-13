import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
const labels = JSON.parse(
  readFileSync(
    new URL("../../src/lib/locales/en.json", import.meta.url),
    "utf8",
  ),
);

// The actual shared panel with controlled SDK/HTTP promises and real synthetic
// MediaStreamTracks. This proves cancellation, not provider/device acceptance.
async function mount(page: Page, stage: string, draft = false) {
  await page.route("**/__producer_lifecycle", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<div id="producer"></div>',
    }),
  );
  await page.goto("/__producer_lifecycle");
  await page.evaluate(
    async ({ stage, draft, labels, moduleUrl }) => {
      const { mountProducer } = await import(/* @vite-ignore */ moduleUrl);
      const root = document.querySelector("#producer") as HTMLElement;
      const owner = "49aa6f7c-d27e-47f4-a28e-8685af4ea4e9";
      sessionStorage.setItem(
        "free2z.producer.v1.784",
        JSON.stringify({ owner, pending: null }),
      );
      let current = true;
      let pending = "";
      let armed = stage;
      let resolve: (() => void) | undefined;
      let visibility = "visible";
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => visibility,
      });
      const tracks: MediaStreamTrack[] = [];
      const sdk: Array<{
        joined: boolean;
        leaves: number;
        tracks: MediaStreamTrack[];
      }> = [];
      const actions: string[] = [];
      const stream = () => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 16;
        const result = canvas.captureStream(1);
        result.addTrack(result.getVideoTracks()[0].clone());
        tracks.push(...result.getTracks());
        return result;
      };
      const wait = async (point: string) => {
        if (armed !== point) return;
        armed = "";
        pending = point;
        await new Promise<void>((done) => {
          resolve = done;
        });
        pending = "";
      };
      const available = ["first", "second"].map((deviceId) => ({
        deviceId,
        kind: "videoinput",
        label: deviceId,
        groupId: "fixture",
        toJSON: () => ({}),
      }));
      navigator.mediaDevices.getUserMedia = async () => {
        const captured = stream();
        await wait("capture");
        return captured;
      };
      navigator.mediaDevices.enumerateDevices = async () => {
        await wait("enumerate");
        return available as MediaDeviceInfo[];
      };
      let state: any = draft
        ? null
        : {
            id: owner,
            owner,
            state: "ready",
            version: 1,
            title: "Controlled stream",
            description: "Lifecycle fixture",
            audience: "public",
            access: "free",
            room_id: owner,
            participants: null,
            error_code: "",
            ended_at: null,
          };
      const dispose = mountProducer(root, {
        actor: 784,
        labels,
        current: () => current,
        transport: async (method: string, path: string, body: any) => {
          if (method === "GET")
            return path.endsWith("history")
              ? state
                ? [state]
                : []
              : { ready: true, eligible: true };
          actions.push(body.action);
          await wait(body.action);
          state = {
            ...state,
            ...body,
            id: owner,
            owner,
            room_id: owner,
            participants: null,
            error_code: "",
            ended_at: null,
            version: (state?.version ?? 0) + 1,
            state: body.action === "interrupt" ? "interrupted" : "ready",
          };
          return {
            stream: state,
            auth_token: body.action === "refresh" ? "fixture-host" : null,
          };
        },
        connect: async () => {
          const item = {
            joined: false,
            leaves: 0,
            tracks: [] as MediaStreamTrack[],
          };
          sdk.push(item);
          let audio = false,
            video = false;
          let sink: HTMLVideoElement | undefined;
          let output = new MediaStream();
          const allocate = () => {
            output = stream();
            item.tracks.push(...output.getTracks());
            if (sink) sink.srcObject = output;
          };
          const instance = {
            join: async () => {
              await wait("join");
              item.joined = true;
              allocate();
            },
            leave: async () => {
              item.leaves++;
              item.joined = audio = video = false;
              item.tracks.forEach((track) => track.stop());
              if (sink) sink.srcObject = null;
            },
            device: async () => {
              await wait("device");
              allocate();
            },
            audio: async (on: boolean) => {
              await wait("audio");
              audio = on;
              if (on) allocate();
            },
            video: async (on: boolean) => {
              await wait("video");
              video = on;
              if (on) allocate();
            },
            preview: (element: HTMLVideoElement) => {
              sink = element;
              sink.srcObject = output;
            },
            media: () => ({ audio, video }),
            onLeft: () => () => {},
            onMedia: () => () => {},
          };
          await wait("init");
          return instance;
        },
      });
      (window as any).producerRace = {
        arm: (point: string) => {
          armed = point;
        },
        release: () => {
          resolve?.();
        },
        cancel: (reason: string) => {
          if (reason === "dispose") dispose();
          else if (reason === "actor") current = false;
          else if (reason === "hidden") {
            visibility = "hidden";
            document.dispatchEvent(new Event("visibilitychange"));
            visibility = "visible";
            document.dispatchEvent(new Event("visibilitychange"));
          } else {
            window.dispatchEvent(new Event(reason));
            window.dispatchEvent(new Event("online"));
          }
        },
        snapshot: () => ({
          pending,
          tracks: tracks.map((t) => t.readyState),
          sdk: sdk.map((s) => ({
            joined: s.joined,
            leaves: s.leaves,
            tracks: s.tracks.map((t) => t.readyState),
          })),
          preview: !!root.querySelector("video")?.srcObject,
          actions,
          connected: root.isConnected,
          disposed: root.childElementCount === 0,
        }),
        close: () => {
          dispose();
          resolve?.();
          tracks.forEach((t) => t.stop());
        },
      };
    },
    {
      stage,
      draft,
      labels: labels.producer,
      moduleUrl: "/src/lib/producer/panel.ts",
    },
  );
  await expect(page.getByRole("status")).toContainText("Backend ready");
}

const snapshot = (page: Page) =>
  page.evaluate(() => (window as any).producerRace.snapshot());
async function cancelAndRelease(page: Page, reason: string) {
  await page.evaluate((reason) => {
    (window as any).producerRace.cancel(reason);
    (window as any).producerRace.release();
  }, reason);
  await expect.poll(async () => (await snapshot(page)).pending).toBe("");
  await expect
    .poll(async () =>
      (await snapshot(page)).tracks.every((s: string) => s === "ended"),
    )
    .toBe(true);
  await expect
    .poll(async () =>
      (await snapshot(page)).sdk.every((s: any) => !s.joined && s.leaves > 0),
    )
    .toBe(true);
  expect((await snapshot(page)).preview).toBe(false);
  expect((await snapshot(page)).actions).not.toContain("publish");
}
test.afterEach(async ({ page }) => {
  await page
    .evaluate(() => (window as any).producerRace?.close())
    .catch(() => {});
});

for (const reason of ["offline", "hidden", "pagehide", "dispose", "actor"]) {
  test(`late capture is stopped after ${reason}, even after visibility/network return`, async ({
    page,
  }) => {
    await mount(page, "capture", true);
    await page
      .getByRole("button", { name: "Set up camera and microphone" })
      .click();
    await expect
      .poll(async () => (await snapshot(page)).pending)
      .toBe("capture");
    await cancelAndRelease(page, reason);
    expect((await snapshot(page)).actions).toEqual([]);
  });
}
for (const [stage, reason] of [
  ["init", "offline"],
  ["join", "pagehide"],
  ["join", "dispose"],
  ["device", "hidden"],
  ["audio", "actor"],
  ["video", "offline"],
  ["enumerate", "pagehide"],
]) {
  test(`late SDK ${stage} is retired after ${reason}`, async ({ page }) => {
    await mount(page, stage);
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).pending).toBe(stage);
    await cancelAndRelease(page, reason);
    const item = (await snapshot(page)).sdk[0];
    expect(item.leaves).toBeGreaterThanOrEqual(stage === "init" ? 1 : 2);
  });
}
for (const control of ["device", "camera", "microphone"]) {
  test(`pending connected ${control} cannot re-enable media after interruption`, async ({
    page,
  }) => {
    await mount(page, "");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await expect.poll(async () => (await snapshot(page)).preview).toBe(true);
    if (control === "camera")
      await page.getByRole("button", { name: "Camera", exact: true }).click();
    await page.evaluate(
      (stage) => (window as any).producerRace.arm(stage),
      control === "camera"
        ? "video"
        : control === "microphone"
          ? "audio"
          : "device",
    );
    if (control === "device")
      await page
        .getByLabel("Camera device", { exact: true })
        .selectOption("second");
    else
      await page
        .getByRole("button", {
          name: control === "camera" ? "Camera" : "Microphone",
          exact: true,
        })
        .click();
    await expect.poll(async () => (await snapshot(page)).pending).not.toBe("");
    await cancelAndRelease(page, "offline");
    expect((await snapshot(page)).sdk[0].leaves).toBeGreaterThanOrEqual(2);
  });
}
test("late preview device replacement stops every returned track", async ({
  page,
}) => {
  await mount(page, "", true);
  await page
    .getByRole("button", { name: "Set up camera and microphone" })
    .click();
  await expect.poll(async () => (await snapshot(page)).preview).toBe(true);
  await page.evaluate(() => (window as any).producerRace.arm("capture"));
  await page
    .getByLabel("Camera device", { exact: true })
    .selectOption("second");
  await expect.poll(async () => (await snapshot(page)).pending).toBe("capture");
  await cancelAndRelease(page, "pagehide");
});
test("late host-ticket response requires explicit resume before SDK initialization", async ({
  page,
}) => {
  await mount(page, "refresh");
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).pending).toBe("refresh");
  await cancelAndRelease(page, "offline");
  expect((await snapshot(page)).sdk).toHaveLength(0);
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Reconnect", exact: true }).click();
  await expect.poll(async () => (await snapshot(page)).preview).toBe(true);
  expect((await snapshot(page)).sdk).toHaveLength(1);
});

test("explicit preparation after canceled preflight starts a fresh media generation", async ({
  page,
}) => {
  await mount(page, "capture", true);
  await page
    .getByRole("button", { name: "Set up camera and microphone" })
    .click();
  await expect.poll(async () => (await snapshot(page)).pending).toBe("capture");
  await cancelAndRelease(page, "offline");
  await page
    .getByRole("button", { name: "Set up camera and microphone" })
    .click();
  await expect.poll(async () => (await snapshot(page)).preview).toBe(true);
  await page
    .getByLabel("Title", { exact: true })
    .fill("Explicit fresh preparation");
  await page
    .getByRole("button", { name: "Prepare stream", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Confirm go live", exact: true }),
  ).toBeEnabled();
  expect((await snapshot(page)).sdk[0].joined).toBe(true);
  expect((await snapshot(page)).actions).not.toContain("interrupt");
});
