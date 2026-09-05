import { expect, test, type Page } from "@playwright/test";
import { installMockCapture } from "./helpers/mock-capture";

const secret = "123e4567-e89b-42d3-a456-426614174000";

async function signIn(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
}

test("private host creates, displays, refreshes, and ends the opaque invite room", async ({
  page,
}) => {
  await signIn(page);
  await installMockCapture(page);
  await page.goto("/live");
  await page.getByRole("button", { name: "Go Live" }).click();
  await page.getByRole("radio", { name: /Private/ }).click();
  await page.getByLabel("Title").fill("Invite-only call");
  await page.getByRole("button", { name: "Set up camera and microphone" }).click();
  await expect(page.getByRole("heading", { name: "Preview ready" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm and start" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/live/demo-creator#private=${secret}$`),
  );
  const origin = new URL(page.url()).origin;
  const invite = page.getByLabel("Private invite");
  await expect(invite).toHaveValue(
    `${origin}/live/demo-creator#private=${secret}`,
  );
  expect(new URL(await invite.inputValue()).pathname).not.toContain(secret);
  await expect(
    page.getByRole("button", { name: "Copy private invite" }),
  ).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.getByRole("button", { name: "Copy private invite" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${origin}/live/demo-creator#private=${secret}`);
  await expect(
    page.getByText("You're hosting as @demo-creator."),
  ).toBeVisible();

  await page.reload();
  await expect(
    page.getByText("You're hosting as @demo-creator."),
  ).toBeVisible();
  await expect(invite).toHaveValue(
    `${origin}/live/demo-creator#private=${secret}`,
  );

  await page.getByRole("button", { name: "End stream" }).click();
  await expect(page).toHaveURL(/\/live$/);
  expect(page.url()).not.toContain(secret);
  await expect(page.getByLabel("Private invite")).toHaveCount(0);
});

test("cold guest invite joins without discovery and wrong secrets disclose nothing", async ({
  page,
}) => {
  await page.goto(`/live/demo-creator#private=${secret}`);
  await expect(page.getByText("Role")).toBeVisible();
  await expect(page.getByText("participant", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Private call" }),
  ).toBeVisible();
  await expect(page.getByText(/active public stream listed/)).toHaveCount(0);

  const wrong = "123e4567-e89b-42d3-a456-426614174001";
  await page.goto(`/live/demo-creator#private=${wrong}`);
  await expect(
    page.getByText("Private room unavailable", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/No room details were disclosed/)).toBeVisible();
  await expect(page.getByText("Private call")).toHaveCount(0);
  await expect(page.getByText("Demo Creator")).toHaveCount(0);
});

test("an authenticated non-owner remains a guest and never becomes the room creator", async ({
  page,
}) => {
  await signIn(page);
  await page.goto(`/live/alice#private=${secret}`);

  await expect(page.getByText("Role")).toBeVisible();
  await expect(page.getByText("participant", { exact: true })).toBeVisible();
  await expect(page.getByText("alice", { exact: true })).toBeVisible();
  await expect(page.getByText(/^@alice · started /)).toBeVisible();
  await expect(page.getByText("Demo Creator", { exact: true })).toHaveCount(0);
  await expect(page.getByText(/You're hosting as/)).toHaveCount(0);
});
