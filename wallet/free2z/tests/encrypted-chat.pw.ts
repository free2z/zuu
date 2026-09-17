import { expect, test, type Page } from "@playwright/test";

/**
 * "Start encrypted chat" on the creator page (#1022, Contracts A and B).
 *
 * Runs against the in-process mock (`VITE_MOCK=1`), whose chat request mirrors
 * Contract A: a 1 2Z server-set price, an idempotency-keyed ledger that
 * replays instead of charging twice, and a lowercase handle only for a
 * username that matches `^[a-z0-9_]{1,30}$`. Faults are queued through
 * `zuuli.mock.chat-request`, like the creator-pages scenario.
 *
 * The assertions are on rendered copy on purpose: what the payer reads about
 * their money is the thing under test.
 */

const INTENT_KEY = "zuuli.auth.pending-paid-intent";
const START_BUTTON = "Start encrypted chat with @zooko";
const CHAT_LINK = "https://free2z.com/bridge/e2e2z/chat/#peer=zooko";
const INSTALL_LINK = "https://free2z.com/bridge/e2e2z/chat/";

async function prepare(
  page: Page,
  { signedIn, faults = [] }: { signedIn: boolean; faults?: string[] },
) {
  await page.addInitScript(
    ({ authenticated, queue }) => {
      if (authenticated) localStorage.setItem("zuuli.knox.token", "mock-knox-token");
      else localStorage.removeItem("zuuli.knox.token");
      // Init scripts run on every navigation. Seed the fault queue only once,
      // so a consumed fault stays consumed across the login detour.
      if (sessionStorage.getItem("zuuli.mock.chat-request") === null) {
        sessionStorage.setItem("zuuli.mock.chat-request", queue.join(","));
      }
      const opened: string[] = [];
      Object.defineProperty(window, "__free2zOpened", { value: opened });
      window.open = ((url?: string | URL) => {
        opened.push(String(url));
        return null;
      }) as typeof window.open;
    },
    { authenticated: signedIn, queue: faults },
  );
}

async function openedUrls(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as unknown as { __free2zOpened: string[] }).__free2zOpened,
  );
}

async function openCreator(page: Page, username = "zooko") {
  await page.goto(`/creator/${username}`);
  await page.locator("[data-creator-profile]").waitFor();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

async function expectBalance(page: Page, balance: string) {
  // An open Radix dialog hides the rest of the page from assistive tech, but
  // the balance chip is still on screen behind it.
  await expect(
    page.getByRole("link", {
      name: `Buy 2Zs. Balance ${balance}`,
      includeHidden: true,
    }),
  ).toBeVisible();
}

function sheet(page: Page) {
  return page.getByRole("dialog");
}

async function openConfirmation(page: Page, username = "zooko") {
  await page
    .getByRole("button", { name: `Start encrypted chat with @${username}` })
    .click();
  await expect(
    sheet(page).getByRole("heading", {
      name: `Start an encrypted chat with @${username}`,
    }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      `1 2Z, paid to @${username}. Messages are end-to-end encrypted in the e2e2z app.`,
    ),
  ).toBeVisible();
}

test("a guest's chat request survives sign-in without charging", async ({
  page,
}) => {
  await prepare(page, { signedIn: false });
  await openCreator(page);
  await openConfirmation(page);
  await expect(sheet(page).getByText(/Your balance/)).toHaveCount(0);

  await sheet(page)
    .getByRole("button", { name: "Sign in to start chat" })
    .click();
  await expect(page).toHaveURL(/\/login$/);
  await expect
    .poll(() =>
      page.evaluate((key) => {
        const raw = sessionStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      }, INTENT_KEY),
    )
    .toMatchObject({
      returnTo: "/creator/zooko",
      intent: { kind: "start-encrypted-chat", subject: "zooko" },
    });

  await page.getByRole("button", { name: "Password", exact: true }).click();
  await page.getByLabel("Email or username").fill("reader");
  await page.getByLabel("Password").fill("correct horse");
  await page.getByLabel("Password").press("Enter");

  await expect(page).toHaveURL(/\/creator\/zooko$/);
  // The intent reopens the sheet; the charge still waits for a real tap.
  await expect(
    sheet(page).getByRole("heading", {
      name: "Start an encrypted chat with @zooko",
    }),
  ).toBeVisible();
  await expect(sheet(page).getByText("Your balance: 4,210 2Z")).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Pay 1 2Z and start chat" }),
  ).toBeVisible();
  await expectBalance(page, "4,210 2Z");
  await expect
    .poll(() => page.evaluate((key) => sessionStorage.getItem(key), INTENT_KEY))
    .toBeNull();
});

test("paying opens e2e2z on the Contract B link, and messaging again is free", async ({
  page,
}) => {
  await prepare(page, { signedIn: true });
  await openCreator(page);
  await expectBalance(page, "4,210 2Z");
  await openConfirmation(page);
  await expect(
    sheet(page).getByText(
      "e2e2z opens with @zooko filled in. Nothing is sent until you write it.",
    ),
  ).toBeVisible();

  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();
  await expect(
    sheet(page).getByRole("heading", { name: "Chat ready with @zooko" }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "1 2Z paid to @zooko. Open e2e2z to write your first message. Nothing is sent until you do.",
    ),
  ).toBeVisible();
  await expectBalance(page, "4,209 2Z");

  const openApp = sheet(page).getByRole("button", { name: "Open e2e2z" });
  await expect(openApp).toBeFocused();
  await openApp.click();
  await sheet(page).getByRole("button", { name: "Get e2e2z" }).click();
  await expect.poll(() => openedUrls(page)).toEqual([CHAT_LINK, INSTALL_LINK]);

  await page.keyboard.press("Escape");
  await expect(sheet(page)).toHaveCount(0);
  const again = page.getByRole("button", {
    name: "Message again with @zooko in e2e2z",
  });
  await expect(again).toBeFocused();
  await expect(page.getByRole("button", { name: START_BUTTON })).toHaveCount(0);

  await again.click();
  await expect(sheet(page)).toHaveCount(0);
  await expect
    .poll(() => openedUrls(page))
    .toEqual([CHAT_LINK, INSTALL_LINK, CHAT_LINK]);
  await expectBalance(page, "4,209 2Z");
});

test("an unclaimed recipient gets honest copy and no broken link", async ({
  page,
}) => {
  await prepare(page, { signedIn: true });
  // `zcash-fan` cannot hold the lowercase handle, so it must claim one.
  await openCreator(page, "zcash-fan");
  await openConfirmation(page, "zcash-fan");
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();

  await expect(
    sheet(page).getByRole("heading", {
      name: "@zcash-fan has been notified",
    }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "1 2Z paid to @zcash-fan. They need to claim a messaging handle in e2e2z before a chat can open, so there is no link to follow yet.",
    ),
  ).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Open e2e2z" }),
  ).toHaveCount(0);
  await sheet(page).getByRole("button", { name: "Get e2e2z" }).click();
  await expect.poll(() => openedUrls(page)).toEqual([INSTALL_LINK]);
  await sheet(page).getByRole("button", { name: "Done" }).click();

  // Re-opening shows the same status and never charges again.
  await page
    .getByRole("button", { name: "Message again with @zcash-fan in e2e2z" })
    .click();
  await expect(
    sheet(page).getByRole("heading", {
      name: "@zcash-fan has been notified",
    }),
  ).toBeVisible();
  await expectBalance(page, "4,209 2Z");
  expect(
    (await openedUrls(page)).some((url) => url.includes("#peer=")),
  ).toBe(false);
});

test("a 402 shows the authoritative balance and then gates on it", async ({
  page,
}) => {
  await prepare(page, { signedIn: true, faults: ["insufficient"] });
  await openCreator(page);
  await openConfirmation(page);
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();

  await expect(
    sheet(page).getByRole("heading", { name: "Not enough 2Z" }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "Starting a chat costs 1 2Z, and nothing was charged. Your balance is 0 2Z.",
    ),
  ).toBeVisible();
  await expectBalance(page, "0 2Z");
  await expect(sheet(page).getByRole("button", { name: "Buy 2Zs" })).toBeFocused();

  await sheet(page).getByRole("button", { name: "Done" }).click();
  await openConfirmation(page);
  await expect(sheet(page).getByText("Your balance: 0 2Z")).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Pay 1 2Z and start chat" }),
  ).toHaveCount(0);
  await sheet(page)
    .getByRole("button", { name: "Not enough 2Z — buy more" })
    .click();
  await expect(page).toHaveURL(/\/fund$/);
});

test("a lost response is uncertain, and the retry cannot charge twice", async ({
  page,
}) => {
  await prepare(page, { signedIn: true, faults: ["lost-response"] });
  await openCreator(page);
  await openConfirmation(page);
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();

  await expect(
    sheet(page).getByRole("heading", { name: "free2z did not get an answer" }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "free2z can't tell whether @zooko got your request or whether 1 2Z was charged. Trying again is safe: the same request can only be charged once.",
    ),
  ).toBeVisible();
  await expect(sheet(page).getByText(/nothing was charged/i)).toHaveCount(0);

  // Closing does not turn "we don't know" into a fresh, re-keyed attempt.
  await sheet(page).getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: START_BUTTON }).click();
  await expect(
    sheet(page).getByRole("heading", { name: "free2z did not get an answer" }),
  ).toBeVisible();

  await sheet(page).getByRole("button", { name: "Try again" }).click();
  await expect(
    sheet(page).getByRole("heading", { name: "Chat ready with @zooko" }),
  ).toBeVisible();
  // The mock ledger committed on the lost attempt; the replay did not charge.
  await expectBalance(page, "4,209 2Z");
});

test("a rate limit says nothing was charged and starts a new attempt", async ({
  page,
}) => {
  await prepare(page, { signedIn: true, faults: ["rate-limited"] });
  await openCreator(page);
  await openConfirmation(page);
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();
  await expect(
    sheet(page).getByText(
      "free2z asked you to slow down, so nothing was charged. Wait a minute, then try again.",
    ),
  ).toBeVisible();
  await sheet(page).getByRole("button", { name: "Try again" }).click();
  await expect(
    sheet(page).getByRole("button", { name: "Pay 1 2Z and start chat" }),
  ).toBeVisible();
  await expectBalance(page, "4,210 2Z");
});

test("a sender without a messaging handle is sent to e2e2z, and nothing is charged", async ({
  page,
}) => {
  await prepare(page, {
    signedIn: true,
    faults: ["sender-handle-unavailable"],
  });
  await openCreator(page);
  await openConfirmation(page);
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();

  await expect(
    sheet(page).getByRole("heading", {
      name: "Claim your messaging handle in e2e2z first",
    }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "Encrypted chats go between messaging handles, and your account doesn't have one yet, so nothing was charged. Get e2e2z, claim your handle there, then come back to message @zooko.",
    ),
  ).toBeVisible();
  await expect(
    sheet(page).getByRole("button", { name: "Open e2e2z" }),
  ).toHaveCount(0);
  const getApp = sheet(page).getByRole("button", { name: "Get e2e2z" });
  await expect(getApp).toBeFocused();
  await getApp.click();
  await expect.poll(() => openedUrls(page)).toEqual([INSTALL_LINK]);
  await expectBalance(page, "4,210 2Z");

  // No request succeeded, so the page still offers the paid action and a
  // later try starts from the confirmation.
  await sheet(page).getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: START_BUTTON }).click();
  await expect(
    sheet(page).getByRole("button", { name: "Pay 1 2Z and start chat" }),
  ).toBeVisible();
});

test("a price change is re-confirmed at the new price before anything is charged", async ({
  page,
}) => {
  await prepare(page, { signedIn: true, faults: ["price-changed"] });
  await openCreator(page);
  await openConfirmation(page);
  await sheet(page)
    .getByRole("button", { name: "Pay 1 2Z and start chat" })
    .click();

  const notice = sheet(page).getByRole("status").filter({
    hasText: "The price changed",
  });
  await expect(notice).toBeVisible();
  await expect(notice).toBeFocused();
  await expect(
    notice.getByText(
      "Starting a chat now costs 2 2Z. Your request was not sent at the old price, so nothing was charged. Confirm the new price to continue.",
    ),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "2 2Z, paid to @zooko. Messages are end-to-end encrypted in the e2e2z app.",
    ),
  ).toBeVisible();
  await expectBalance(page, "4,210 2Z");

  await sheet(page)
    .getByRole("button", { name: "Pay 2 2Z and start chat" })
    .click();
  await expect(
    sheet(page).getByRole("heading", { name: "Chat ready with @zooko" }),
  ).toBeVisible();
  await expect(
    sheet(page).getByText(
      "2 2Z paid to @zooko. Open e2e2z to write your first message. Nothing is sent until you do.",
    ),
  ).toBeVisible();
  await expectBalance(page, "4,208 2Z");
});

test("a creator named price has no chat button", async ({ page }) => {
  await prepare(page, { signedIn: true });
  await openCreator(page, "price");
  await expectBalance(page, "4,210 2Z");
  await expect(
    page.locator("[data-creator-actions] button").first(),
  ).toBeVisible();
  await expect(page.locator("[data-creator-chat]")).toHaveCount(0);
});

test("your own profile has no chat button", async ({ page }) => {
  await prepare(page, { signedIn: true });
  // The mock session is `demo-creator`.
  await openCreator(page, "demo-creator");
  await expectBalance(page, "4,210 2Z");
  await expect(
    page.locator("[data-creator-actions] button").first(),
  ).toBeVisible();
  await expect(page.locator("[data-creator-chat]")).toHaveCount(0);
  await expect(page.getByText("Start encrypted chat")).toHaveCount(0);
});

test("the confirmation fits a 320px phone without clipping its copy", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await prepare(page, { signedIn: true });
  await openCreator(page);
  await openConfirmation(page);
  await expect(
    sheet(page).getByRole("button", { name: "Pay 1 2Z and start chat" }),
  ).toBeVisible();
  const overflow = await sheet(page).evaluate((dialog) =>
    [...dialog.querySelectorAll<HTMLElement>("h2, p, button, span")]
      .filter((element) => !element.classList.contains("sr-only"))
      .filter((element) => element.scrollWidth > element.clientWidth + 1)
      .map((element) => element.textContent),
  );
  expect(overflow).toEqual([]);
});
