import { expect, test } from "@playwright/test";
import { captureState, installMockCapture } from "./helpers/mock-capture";

async function signInAndOpen(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await installMockCapture(page);
  await page.goto("/live");
  await page.getByRole("button", { name: "Go Live" }).click();
}

test("capture needs explicit intent and a distinct ready confirmation before start", async ({
  page,
}) => {
  await signInAndOpen(page);
  await page.getByLabel("Title").fill("A deliberate stream");

  expect((await captureState(page)).requests).toHaveLength(0);
  await expect(page.getByRole("button", { name: "Confirm and start" })).toBeDisabled();
  await expect(page).toHaveURL(/\/live$/);

  await page.getByRole("button", { name: "Set up camera and microphone" }).click();
  await expect(page.getByRole("heading", { name: "Preview ready" })).toBeVisible();
  expect((await captureState(page)).requests).toEqual([{ audio: true, video: true }]);
  await expect(page.getByRole("status")).toContainText("Camera on. Microphone muted.");
  await expect(page.getByRole("button", { name: "Turn on microphone" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(page.getByRole("button", { name: "Turn off camera" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await page.getByRole("button", { name: "Confirm and start" }).click();
  await expect(page).toHaveURL(/\/live\/demo-creator$/);
  await expect.poll(async () => (await captureState(page)).stoppedTracks).toBe(2);
});

for (const closeMethod of ["Cancel", "Close", "Escape", "outside"] as const) {
  test(`${closeMethod} closes the dialog, releases capture, and keeps live unstarted`, async ({
    page,
  }) => {
    await signInAndOpen(page);
    await page.getByRole("button", { name: "Set up camera and microphone" }).click();
    await expect(page.getByRole("heading", { name: "Preview ready" })).toBeVisible();
    if (closeMethod === "Escape") await page.keyboard.press("Escape");
    else if (closeMethod === "outside") await page.mouse.click(2, 2);
    else await page.getByRole("button", { name: closeMethod, exact: true }).click();

    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page).toHaveURL(/\/live$/);
    await expect.poll(async () => (await captureState(page)).stoppedTracks).toBe(2);
  });
}

test("preflight is keyboard operable, touch sized, motion-safe, and fits 320px", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 320, height: 760 });
  await signInAndOpen(page);
  await page.getByRole("button", { name: "Set up camera and microphone" }).click();
  await expect(page.getByRole("heading", { name: "Preview ready" })).toBeVisible();

  await page.getByRole("button", { name: "Turn on microphone" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Mute microphone" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const geometry = await page.getByRole("dialog").evaluate((dialog) => {
    const rect = dialog.getBoundingClientRect();
    const targets = [...dialog.querySelectorAll<HTMLElement>("button, input, select")]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      })
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { width: box.width, height: box.height };
      });
    const animated = getComputedStyle(dialog);
    return {
      left: rect.left,
      right: rect.right,
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      targets,
      animationDuration: animated.animationDuration,
      transitionDuration: animated.transitionDuration,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.viewport);
  for (const target of geometry.targets) {
    expect(target.width).toBeGreaterThanOrEqual(43.5);
    expect(target.height).toBeGreaterThanOrEqual(43.5);
  }
  expect(Number.parseFloat(geometry.animationDuration)).toBeLessThanOrEqual(0.00001);
  expect(Number.parseFloat(geometry.transitionDuration)).toBeLessThanOrEqual(0.00001);
});
