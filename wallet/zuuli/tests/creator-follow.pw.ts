import { expect, test, type Page } from "@playwright/test";

async function openSignedInCreator(page: Page, username: string) {
  await page.addInitScript(() => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
  });
  await page.goto(`/creator/${username}`);
  await page.locator("[data-creator-profile]").waitFor();
  await expect(
    page.getByRole("button", { name: "Account menu" }),
  ).toBeVisible();
}

async function expectNoPaidRelationshipCopy(page: Page) {
  const actions = page.locator("[data-creator-actions]");
  await expect(actions.getByText(/subscribe|member|renew/i)).toHaveCount(0);
  await expect(
    page.getByText(/subscriber posts|subscriber livestreams|unlocked/i),
  ).toHaveCount(0);
}

test("free creator actions consistently follow and unfollow without paid claims", async ({
  page,
}) => {
  await openSignedInCreator(page, "shielded_sam");

  const follow = page.getByRole("button", {
    name: "Follow Antidisestablishmentarianismsam",
  });
  await expect(follow).toHaveText("Follow");
  await expectNoPaidRelationshipCopy(page);

  await follow.click();
  await expect(
    page.getByText("Followed Antidisestablishmentarianismsam", { exact: true }),
  ).toBeVisible();

  const unfollow = page.getByRole("button", {
    name: "Following Antidisestablishmentarianismsam · Unfollow",
  });
  await expect(unfollow).toHaveText("Following");
  await expectNoPaidRelationshipCopy(page);

  await unfollow.click();
  await expect(
    page.getByText("Unfollowed Antidisestablishmentarianismsam", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(follow).toHaveText("Follow");
  await expectNoPaidRelationshipCopy(page);
});

test("an existing free relationship is restored from the backend after reload", async ({
  page,
}) => {
  await openSignedInCreator(page, "f2z");

  const unfollow = page.getByRole("button", {
    name: "Following Free2Z · Unfollow",
  });
  await expect(unfollow).toHaveText("Following");
  await expectNoPaidRelationshipCopy(page);

  await page.reload();
  await page.locator("[data-creator-profile]").waitFor();
  await expect(unfollow).toHaveText("Following");
  await expectNoPaidRelationshipCopy(page);
});

test("subscribe and membership language remains on a priced creator", async ({
  page,
}) => {
  await openSignedInCreator(page, "zooko");

  const subscribe = page.getByRole("button", {
    name: "Subscribe to Zooko · 500 2Z/mo",
  });
  await expect(subscribe).toHaveText("Subscribe · 500 2Z/mo");
  await subscribe.click();
  await expect(
    page.getByRole("dialog", { name: "Subscribe to Zooko" }),
  ).toBeVisible();
  await expect(page.getByText("Membership · monthly")).toBeVisible();
});
