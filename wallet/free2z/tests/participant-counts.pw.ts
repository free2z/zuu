import { expect, test, type Page } from "@playwright/test";
import { installMockCapture } from "./helpers/mock-capture";

const privateSecret = "123e4567-e89b-42d3-a456-426614174000";

async function signIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

/**
 * ZUULI's version of this test also asserts the same two counts on its Home
 * feature's live rail. free2z mounts no Home: its index route forwards to
 * `/articles`, and `features/home` was never ported (#912/#920). The home half
 * is dropped rather than aimed at `/articles`, where no live card renders and
 * every assertion would have been about an element that does not exist. The
 * redirect is asserted so the omission stays a stated fact rather than a
 * silent one — if a Home surface with a live rail ever lands here, this fails
 * and the dropped coverage has to be restored.
 */
test("known and unavailable counts stay truthful in discovery cards", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/articles$/);
  await expect(page.locator('a[href^="/live/"]')).toHaveCount(0);

  await page.goto("/live");

  const discoveryKnown = page.locator('a[href="/live/nine"]');
  await expect(discoveryKnown).toHaveAccessibleName(/214 people watching/);
  await expect(discoveryKnown.getByText("214", { exact: true })).toBeVisible();

  const discoveryUnknown = page.locator('a[href="/live/mining_maya"]');
  await expect(discoveryUnknown).toHaveAccessibleName(
    /Participant count unavailable/,
  );
  await expect(
    discoveryUnknown.getByText("Unavailable", { exact: true }),
  ).toBeVisible();
  // Carried over from the dropped home block: an unknown count must read as
  // unavailable, never as a confident zero.
  await expect(discoveryUnknown).not.toContainText("0 watching");
});

test("local host and guest tickets never synthesize themselves into the count", async ({
  page,
}) => {
  await signIn(page);
  await installMockCapture(page);
  await page.goto("/live");
  await page.getByRole("button", { name: "Go Live" }).click();
  await page.getByRole("radio", { name: /Private/ }).click();
  await page.getByLabel("Title").fill("Count-safe private room");
  await page.getByRole("button", { name: "Set up camera and microphone" }).click();
  await expect(page.getByRole("heading", { name: "Preview ready" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm and start" }).click();

  await expect(
    page.getByText("Participant count unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("1 person watching", { exact: true }),
  ).toHaveCount(0);

  await page.goto(`/live/alice#private=${privateSecret}`);
  await expect(page.getByText("participant", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Participant count unavailable", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("1 person watching", { exact: true }),
  ).toHaveCount(0);
});

test("joining a public room leaves its known count unchanged", async ({
  page,
}) => {
  await page.goto("/live/nine");
  await expect(page.getByText("214 people watching", { exact: true })).toHaveCount(
    1,
  );

  await page.getByRole("button", { name: "Join free" }).click();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByText("214 people watching", { exact: true })).toHaveCount(
    2,
  );
  await expect(page.getByText("215 people watching", { exact: true })).toHaveCount(
    0,
  );
});
