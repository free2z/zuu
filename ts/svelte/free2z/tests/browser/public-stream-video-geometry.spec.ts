import { expect, test, type Page } from "@playwright/test";

const VIEWER_URL = "/livefixture/broadcast";
const VIEWPORTS = [
  { label: "desktop", width: 1440, height: 900 },
  { label: "mobile portrait", width: 390, height: 844 },
  { label: "short landscape", width: 844, height: 390 },
];

/**
 * Measure the meeting frame while it is STILL in the real page — under
 * `+layout.svelte`'s `min-h-screen` root and `<main class="flex flex-1
 * flex-col">`. The fixture below detaches a clone of this chain (see the
 * comment there), so without this reading the spec would never exercise the
 * page's real ancestors, and a future ancestor regression — an added
 * `overflow: hidden` or a `contain: size` that clips a correctly sized frame —
 * would pass unnoticed. Every ancestor that can clip is reported with its own
 * rect so the assertion is "nothing above the frame is cutting it off", not
 * merely "the frame has a height".
 */
async function measureAttachedFrame(page: Page) {
  return page.locator("[data-public-meeting-frame]").evaluate((liveFrame) => {
    const rect = liveFrame.getBoundingClientRect();
    const clippers: {
      tag: string;
      overflowX: string;
      overflowY: string;
      contain: string;
      top: number;
      left: number;
      right: number;
      bottom: number;
    }[] = [];
    for (let node = liveFrame.parentElement; node; node = node.parentElement) {
      const style = getComputedStyle(node);
      const contains =
        style.contain !== "none" &&
        /\b(size|inline-size|layout|paint|strict|content)\b/.test(
          style.contain,
        );
      if (
        style.overflowX === "visible" &&
        style.overflowY === "visible" &&
        !contains
      ) {
        continue;
      }
      const box = node.getBoundingClientRect();
      clippers.push({
        tag: node.tagName.toLowerCase(),
        overflowX: style.overflowX,
        overflowY: style.overflowY,
        contain: style.contain,
        top: box.top,
        left: box.left,
        right: box.right,
        bottom: box.bottom,
      });
    }
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      left: rect.left,
      right: rect.right,
      bottom: rect.bottom,
      clippers,
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  });
}

/**
 * Assert that the frame, as the real page lays it out, is both usably tall and
 * not clipped away by anything above it.
 */
function expectHealthyAttachedFrame(
  attached: Awaited<ReturnType<typeof measureAttachedFrame>>,
) {
  expect(attached.height).toBeGreaterThan(150);
  expect(attached.width).toBeGreaterThan(200);
  expect(attached.documentWidth).toBeLessThanOrEqual(attached.viewportWidth);
  for (const clipper of attached.clippers) {
    // A clipping ancestor is allowed to exist; it is not allowed to cut the
    // frame down. Sub-pixel layout rounding is the only slack given.
    expect(
      clipper.bottom - Math.max(clipper.top, attached.top),
      `<${clipper.tag}> (overflow ${clipper.overflowX}/${clipper.overflowY}, contain ${clipper.contain}) clips the meeting frame vertically`,
    ).toBeGreaterThanOrEqual(attached.height - 1);
    expect(
      clipper.right - Math.max(clipper.left, attached.left),
      `<${clipper.tag}> (overflow ${clipper.overflowX}/${clipper.overflowY}, contain ${clipper.contain}) clips the meeting frame horizontally`,
    ).toBeGreaterThanOrEqual(attached.width - 1);
  }
}

async function installRtkFaithfulMeeting(page: Page) {
  await page.locator("[data-public-meeting-frame]").evaluate((liveFrame) => {
    // Detach the fixture from Svelte's keyed viewer block. Its expected failed
    // join can continue updating the removed application tree without tearing
    // down this media fixture between measurements.
    const frame = liveFrame.cloneNode(false) as HTMLElement;
    const renderedViewerSurface = liveFrame.firstElementChild;
    if (!(renderedViewerSurface instanceof HTMLElement)) {
      throw new Error("LiveStreamViewer surface was not rendered");
    }
    // Preserve the real Free2Z frame -> LiveStreamViewer flex chain. Only the
    // provider-owned element is synthetic; detaching this cloned application
    // chain keeps a failed mocked API join from removing it mid-measurement.
    const viewerSurface = renderedViewerSurface.cloneNode(false) as HTMLElement;
    frame.append(viewerSurface);
    document.body.replaceChildren(frame);

    class RtkFaithfulMeeting extends HTMLElement {
      connectedCallback() {
        const root = this.attachShadow({ mode: "open" });
        root.innerHTML = `
          <style>
            :host {
              display: flex;
              width: 100%;
              height: 100%;
              min-height: 0;
              flex-direction: column;
              background: #050505;
              color: white;
            }
            [data-rtk-element="header"] { display: block; flex: 0 0 48px; }
            [data-rtk-element="stage"] { display: flex; flex: 1 1 auto; min-height: 0; }
            [data-rtk-element="grid"] {
              display: grid;
              width: 100%;
              height: 100%;
              min-height: 0;
              position: relative;
              grid-template: minmax(0, 1fr) / minmax(0, 1fr);
            }
            [data-rtk-element="participant-tile"] {
              display: block;
              position: absolute;
              inset: 0;
              min-width: 0;
              min-height: 0;
              overflow: hidden;
            }
            video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
            [data-rtk-element="controlbar"] { display: flex; flex: 0 0 64px; align-items: center; }
          </style>
          <div data-rtk-element="header">Fixture room</div>
          <div data-rtk-element="stage"><div data-rtk-element="grid"><div data-rtk-element="participant-tile"><video autoplay muted playsinline></video></div></div></div>
          <div data-rtk-element="controlbar"><button type="button">Full Screen</button></div>
        `;

        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext("2d")!;
        let frameNumber = 0;
        const draw = () => {
          context.fillStyle = frameNumber++ % 2 ? "#84cc16" : "#2563eb";
          context.fillRect(0, 0, canvas.width, canvas.height);
          requestAnimationFrame(draw);
        };
        draw();
        const stream = canvas.captureStream(30);
        const video = root.querySelector("video")!;
        video.srcObject = stream;

        const state = ((window as any).__rtkGeometryState ??= {
          initialized: 0,
          roomJoined: 0,
          playPromise: null,
        });
        state.initialized += 1;
        this.dispatchEvent(new CustomEvent("participantInitialized"));
        state.roomJoined += 1;
        this.dispatchEvent(new CustomEvent("roomJoined"));
        state.playPromise = video.play();

        root.querySelector("button")!.addEventListener("click", () => {
          void this.requestFullscreen();
        });
      }
    }

    if (!customElements.get("rtk-faithful-meeting")) {
      customElements.define("rtk-faithful-meeting", RtkFaithfulMeeting);
    }
    const meeting = document.createElement("rtk-faithful-meeting");
    meeting.setAttribute("mode", "fill");
    viewerSurface.append(meeting);
  });
  await page.evaluate(async () => {
    await (window as any).__rtkGeometryState.playPromise;
  });
}

async function geometry(page: Page) {
  return page.locator("rtk-faithful-meeting").evaluate((meeting) => {
    const root = meeting.shadowRoot!;
    const pick = (selector: string) => {
      const rect = root.querySelector(selector)!.getBoundingClientRect();
      return {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const video = root.querySelector("video") as HTMLVideoElement;
    const track = (video.srcObject as MediaStream).getVideoTracks()[0];
    const stage = pick('[data-rtk-element="stage"]');
    const videoRect = pick("video");
    return {
      frame: (() => {
        const rect =
          meeting.parentElement!.parentElement!.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })(),
      viewerSurface: (() => {
        const rect = meeting.parentElement!.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })(),
      meeting: (() => {
        const rect = meeting.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      })(),
      stage,
      grid: pick('[data-rtk-element="grid"]'),
      tile: pick('[data-rtk-element="participant-tile"]'),
      video: videoRect,
      intersects:
        Math.min(stage.right, videoRect.right, innerWidth) >
          Math.max(stage.left, videoRect.left, 0) &&
        Math.min(stage.bottom, videoRect.bottom, innerHeight) >
          Math.max(stage.top, videoRect.top, 0),
      controls: Boolean(
        root.querySelector('[data-rtk-element="controlbar"] button'),
      ),
      media: {
        paused: video.paused,
        readyState: video.readyState,
        trackEnabled: track.enabled,
        trackReadyState: track.readyState,
      },
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      initialized: (window as any).__rtkGeometryState.initialized,
      roomJoined: (window as any).__rtkGeometryState.roomJoined,
    };
  });
}

for (const viewport of VIEWPORTS) {
  test(`inline remote video has a visible RTK stage at ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto(VIEWER_URL);

    // Measured on the REAL ancestor chain, before the fixture detaches a clone
    // of it.
    const attached = await measureAttachedFrame(page);
    expectHealthyAttachedFrame(attached);

    await installRtkFaithfulMeeting(page);

    const measured = await geometry(page);
    // The detached clone must be the same HEIGHT the real page produced, or
    // every measurement below describes a frame the visitor never sees. Height
    // is the axis  is about and the axis the fix controls. Width is
    // deliberately not pinned to equality: emptying the body removes the page's
    // scrollbar, so the clone is legitimately the full 390px where the real
    // document laid the frame out at 374px.
    expect(measured.frame.height).toBeCloseTo(attached.height, 0);
    expect(measured.frame.width).toBeGreaterThanOrEqual(attached.width);
    expect(measured.initialized).toBe(1);
    expect(measured.roomJoined).toBe(1);
    expect(measured.media.trackEnabled).toBe(true);
    expect(measured.media.trackReadyState).toBe("live");
    expect(measured.media.paused).toBe(false);
    expect(measured.media.readyState).toBeGreaterThanOrEqual(2);
    expect(measured.controls).toBe(true);
    expect(measured.frame.height).toBeGreaterThan(150);
    expect(measured.viewerSurface.height).toBeGreaterThan(150);
    expect(measured.meeting.width).toBeGreaterThan(200);
    expect(measured.meeting.height).toBeGreaterThan(150);
    expect(measured.stage.height).toBeGreaterThan(80);
    expect(measured.grid.height).toBeGreaterThan(80);
    expect(measured.tile.height).toBeGreaterThan(80);
    expect(measured.video.height).toBeGreaterThan(80);
    expect(measured.intersects).toBe(true);
    expect(measured.documentWidth).toBeLessThanOrEqual(measured.viewportWidth);
  });
}

test("fullscreen exit restores the same healthy inline stage", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === "firefox",
    "Playwright Firefox headless does not expose the Fullscreen API",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(VIEWER_URL);
  expectHealthyAttachedFrame(await measureAttachedFrame(page));
  await installRtkFaithfulMeeting(page);
  const before = await geometry(page);

  // A real pointer activation is required by the Fullscreen API. Click the
  // shadow controlbar button by its measured position inside the host.
  await page.locator("rtk-faithful-meeting").click({
    position: { x: 50, y: before.meeting.height - 32 },
  });
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(true);
  const fullscreen = await geometry(page);
  expect(fullscreen.stage.height).toBeGreaterThan(before.stage.height);

  await page.evaluate(() => document.exitFullscreen());
  await expect
    .poll(() => page.evaluate(() => Boolean(document.fullscreenElement)))
    .toBe(false);
  const restored = await geometry(page);
  expect(restored.stage.height).toBeCloseTo(before.stage.height, 0);
  expect(restored.video.height).toBeGreaterThan(80);
  expect(restored.intersects).toBe(true);
  expect(restored.initialized).toBe(1);
  expect(restored.roomJoined).toBe(1);
  expect(restored.media.trackReadyState).toBe("live");
});
