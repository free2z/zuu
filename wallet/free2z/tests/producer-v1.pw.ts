import { test, expect } from "@playwright/test";
test("content app exposes v1 producer readiness and refuses unavailable paid/private starts", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  const writes: string[] = [];
  await page.route("**/api/dyte/producer/v1**", (route) => {
    if (route.request().method() === "POST") writes.push(route.request().url());
    return route.fulfill({
      json: route.request().url().endsWith("history")
        ? []
        : { ready: false, eligible: true },
    });
  });
  await page.goto("/live");
  await page
    .getByRole("button", { name: "Producer controls", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Backend unavailable");
  await page.getByLabel("Title", { exact: true }).fill("Public API preflight");
  await page.getByLabel("Audience", { exact: true }).selectOption("private");
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "Paid and restricted audiences are unavailable",
  );
  await page.getByLabel("Audience", { exact: true }).selectOption("public");
  await page.getByLabel("Access", { exact: true }).selectOption("paid");
  await expect(
    page.getByRole("button", { name: "Prepare stream", exact: true }),
  ).toBeDisabled();
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("closing content producer controls cancels delayed capture without restoring media", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("zuuli.knox.token", "mock-knox-token"),
  );
  await page.route("**/api/dyte/producer/v1**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("history")
        ? []
        : { ready: false, eligible: true },
    }),
  );
  await page.goto("/live");
  await page
    .getByRole("button", { name: "Producer controls", exact: true })
    .click();
  await expect(page.getByRole("status")).toContainText("Backend unavailable");
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    const stream = canvas.captureStream(1);
    let release!: () => void;
    let started = false;
    navigator.mediaDevices.getUserMedia = async () => {
      started = true;
      await new Promise<void>((done) => {
        release = done;
      });
      return stream;
    };
    (window as unknown as { producerCapture: unknown }).producerCapture = {
      started: () => started,
      release: () => release(),
      states: () => stream.getTracks().map((track) => track.readyState),
    };
  });
  await page
    .getByRole("button", { name: "Set up camera and microphone" })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { producerCapture: { started(): boolean } }
        ).producerCapture.started(),
      ),
    )
    .toBe(true);
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() =>
    (
      window as unknown as { producerCapture: { release(): void } }
    ).producerCapture.release(),
  );
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as { producerCapture: { states(): string[] } }
        ).producerCapture.states(),
      ),
    )
    .toEqual(["ended"]);
  await expect(page.locator(".f2z-producer video")).toHaveCount(0);
});
