import { expect, test } from "@playwright/test";

const PHONE = { width: 320, height: 568 };

/**
 * The wallet side of the creator ZEC tip — `/wallet/send/creator-tip`,
 * `src/lib/wallet/creator-tip.ts` and `Send.tsx`'s locked-destination branch —
 * survives #904 phase 4 as the landing point the intent bridge (#905) will
 * drive. Its *issuer* did not: the tip dialog lived in `features/creator`,
 * which moved to `wallet/free2z`.
 *
 * `createCreatorTipRouteState` keeps its issued snapshot in module memory and
 * hands out only a lookup nonce, precisely so a route state cannot authenticate
 * itself. Nothing in this app can mint one any more, so the six tests that
 * entered through the dialog cannot be driven from a browser at all — the
 * route now always fails closed, which is what remains testable here and is
 * exactly the property that matters until #905 lands an authenticated issuer.
 *
 * The validation contract those tests exercised is unit-covered in
 * `src/lib/wallet/creator-tip.test.ts`, which is untouched.
 */

test("an unissued creator-tip route fails closed without an editable recipient", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/wallet/send/creator-tip");

  await expect(page.getByRole("alert")).toContainText(
    "payment details could not be verified",
  );
  await expect(page.getByLabel("Recipient address")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review payment" }),
  ).toHaveCount(0);
});

test("a forged creator-tip route state cannot unlock the destination", async ({
  page,
}) => {
  // The negative control the deleted tests can no longer supply: a caller that
  // fabricates a well-formed route state — the shape a compromised renderer
  // would produce under #367 — must still be refused, because the nonce is a
  // capability into an in-process map, not a claim the state carries.
  await page.setViewportSize(PHONE);
  await page.goto("/wallet/send");
  await page.evaluate(() => {
    const forged = {
      creatorTip: {
        version: 1,
        nonce: "00000000-0000-4000-8000-000000000000",
        username: "zooko",
        label: "Zooko",
        recipient: "u1attackercontrolleddestination",
      },
    };
    const current = window.history.state as Record<string, unknown> | null;
    window.history.pushState(
      { ...current, usr: forged, key: "forged", idx: 1 },
      "",
      "/wallet/send/creator-tip",
    );
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: window.history.state }),
    );
  });

  await expect(page).toHaveURL(/\/wallet\/send\/creator-tip$/);
  await expect(page.getByRole("alert")).toContainText(
    "payment details could not be verified",
  );
  await expect(page.getByLabel("Recipient address")).toHaveCount(0);
  await expect(
    page.getByText("u1attackercontrolleddestination"),
  ).toHaveCount(0);
});
