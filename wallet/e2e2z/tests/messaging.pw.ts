// The ported messaging surface, in a real browser.
//
// `src/features/messages/*.test.tsx` drive the components through mocked
// bridges. This run drives the whole app — the i18n kernel, the Tailwind
// layer, the real `mock.ts` fixtures and the real reconciliation — so a port
// that type-checks but renders nothing cannot pass.

import { expect, test } from "@playwright/test";

test.describe("messaging surface", () => {
  test("renders the engine, the handle and a conversation", async ({ page }) => {
    await page.goto("/");

    await expect(
      page.getByRole("heading", { name: "Messages", level: 1 }),
    ).toBeVisible();

    // §6.1's engine summary, which is the bridge answering through the mock.
    await expect(page.getByText("Engine", { exact: true })).toBeVisible();
    await expect(page.getByText("Relays", { exact: true })).toBeVisible();
    await expect(page.getByText("Witnesses", { exact: true })).toBeVisible();

    // The fixture is enrolled and merged, so first contact and the transcript
    // are both reachable.
    await expect(
      page.getByRole("heading", { name: "Start a conversation" }),
    ).toBeVisible();
    await expect(page.getByText("Handle active")).toBeVisible();
    await expect(page.getByText("@fixturecreator")).toBeVisible();

    // §9 rule 5: one witness cannot witness itself, and the fixture says so.
    await expect(
      page.getByText("The directory is not independently witnessed yet"),
    ).toBeVisible();

    const conversations = page.getByRole("navigation", {
      name: "Conversations",
    });
    await expect(conversations.getByRole("button").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  });

  test("sends a message through the composer", async ({ page }) => {
    await page.goto("/");
    const composer = page.getByLabel("Message", { exact: true });
    await composer.fill("hello from the port");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("hello from the port")).toBeVisible();
  });

  test("never ships a CSS ellipsis clip at runtime", async ({ page }) => {
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "Messages", level: 1 }),
    ).toBeVisible();
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("body *")]
        .filter(
          (element) =>
            getComputedStyle(element).textOverflow === "ellipsis" &&
            !element.hasAttribute("data-user-content"),
        )
        .map((element) => element.tagName + "." + element.className)
        .slice(0, 10),
    );
    expect(clipped).toEqual([]);
  });
});
