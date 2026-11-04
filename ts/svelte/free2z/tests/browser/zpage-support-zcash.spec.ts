//  -- direct creator support pays the page's EFFECTIVE address with a
// supporter-controlled memo, and never a Free2Z routing command.
//
// The old dialog built `zcash:<creator.p2paddr>?memo=<{"act":"page_fund",
// "id":<uuid>}>`: it ignored `article.p2paddr` (a page can route support to a
// campaign wallet) and attached a legacy instruction that only ever meant
// something to a Free2Z-controlled wallet. This decodes the URI the dialog
// hands to the wallet -- the same one QR, "Open wallet" and "Copy link"
// share -- and checks recipient, amount and memo the way a wallet would.
import { expect, test, type Page } from "@playwright/test";

// The first zPage navigation on a cold dev server compiles the route and can
// take ~25s by itself; the flow under test is a few seconds.
test.setTimeout(90_000);

const PAGE_ADDRESS =
  "u1pagecampaign7x4k2m9v0d3q8lz5w6n1t7r2y9c4h6b8f0p3s5a7e9g1j3l5n7q9s1u3w5y7z9b2d4f6h8k0m2p4r6t8v0x2z4c6e8g0j2l4n6p8r0t2v4x6";
const CREATOR_ADDRESS =
  "u18vffksp4zjra0c8aqzyxvvhmxqmr2rk8j7x9m2q0lhq3wgs6tqk9v4zn7l3xd8fpq5j2m6c0rtyv9wq8hn3lz7kx4mv2p6gd9sr0tqy5h";
const TRANSPARENT_ADDRESS = "t1KbeGmXH8Rc4qEeTU1fgjF5HqjgtxdSTE";

function decodeZcashUri(uri: string) {
  expect(uri.startsWith("zcash:")).toBe(true);
  const rest = uri.slice("zcash:".length);
  const [address, query = ""] = rest.split("?");
  const params = new Map<string, string>();
  for (const pair of query.split("&").filter(Boolean)) {
    const [key, value = ""] = pair.split("=");
    params.set(key, value);
  }
  const memo64 = params.get("memo");
  const memo =
    memo64 === undefined
      ? null
      : Buffer.from(
          memo64.replaceAll("-", "+").replaceAll("_", "/"),
          "base64",
        ).toString("utf8");
  return { address, amount: params.get("amount") ?? null, memo, params };
}

// Same harness as zpage-boost-score.spec.ts: an authenticated non-owner, so
// the actions rail renders Support (the owner sees Edit instead) and the root
// layout's auth check settles into network idle.
async function installSupportSession(page: Page) {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "support-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.route("**/api/auth/user/", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: 863,
        username: "support-tester",
        full_name: "Support Tester",
        tuzis: "10",
      }),
    });
  });
}

/**
 * `page.goto` with a cold-start retry. The first navigation after the dev
 * server boots can be aborted by Vite's dependency re-optimisation reload
 * (`net::ERR_ABORTED`); the load after that is fine. Same Vite artifact
 * `editor-media-access-gate.spec.ts` documents, handled the same way.
 */
async function gotoZpage(page: Page, path: string) {
  const trigger = page.locator(".page-action-trigger");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(path);
      await trigger.waitFor({ timeout: 10_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(1_000);
    }
  }
}

async function openZcashSupport(page: Page, path: string) {
  await installSupportSession(page);
  await gotoZpage(page, path);
  const trigger = page.locator(".page-action-trigger");
  await page.waitForLoadState("networkidle");
  await page.mouse.move(0, 0);
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("aria-expanded", "true");

  await page.getByRole("button", { name: "Support", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("tab", { name: "Zcash" }).click();
  return dialog;
}

// Located by its accessible name, which the dialog had before this change
// too: the negative control must fail on what the wallet would RECEIVE, not
// on a selector this change introduced.
async function walletUri(page: Page) {
  const href = await page
    .getByRole("link", { name: "Open wallet" })
    .getAttribute("href");
  expect(href, "the Open wallet link must carry a zcash: URI").toBeTruthy();
  return href as string;
}

test("zPage support pays the page override, with a human-readable memo the supporter controls", async ({
  page,
}) => {
  const dialog = await openZcashSupport(page, "/support-author/support-zec");

  // What the wallet receives: the page's effective address, not the
  // creator's profile address, and a default memo that is the localized page
  // title -- no page_fund, no id, no JSON.
  let decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.address).toBe(PAGE_ADDRESS);
  expect(decoded.address).not.toBe(CREATOR_ADDRESS);
  expect(decoded.amount).toBeNull();
  expect(decoded.memo).toBe("Why Zcash matters — a field guide");
  expect(decoded.memo).not.toMatch(/page_fund|"act"|"id"|0000-4000-8000/);
  expect([...decoded.params.keys()].sort()).toEqual(["memo"]);

  // The recipient is visible and verifiable BEFORE the wallet handoff.
  await expect(page.getByTestId("zec-recipient-address")).toHaveText(
    PAGE_ADDRESS,
  );
  await expect(
    dialog.getByText("Paying the support address for"),
  ).toBeVisible();

  // The supporter edits the memo and sets an amount; Unicode survives.
  await page.getByLabel("Amount in ZEC (optional)").fill("0.25");
  const memo = page.getByLabel("Memo to the creator (optional)");
  await memo.fill("¡Gracias! 谢谢 🎉");
  await expect(page.getByTestId("zec-memo-bytes")).toHaveText("22 / 512");
  decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.address).toBe(PAGE_ADDRESS);
  expect(decoded.amount).toBe("0.25");
  expect(decoded.memo).toBe("¡Gracias! 谢谢 🎉");

  // Over the 512-byte limit: counted in bytes, and no URI is offered.
  await memo.fill("🎉".repeat(170));
  await expect(page.getByTestId("zec-memo-bytes")).toHaveText("680 / 512");
  await expect(dialog.getByText(/at most 512 bytes/)).toBeVisible();
  // Without a URI the control renders as a disabled <button>, not a link.
  await expect(page.getByTestId("zec-open-wallet")).toBeDisabled();
  await expect(page.getByTestId("zec-open-wallet")).not.toHaveAttribute(
    "href",
    /.*/,
  );

  // Cleared: the memo parameter is omitted entirely.
  await memo.fill("");
  decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.address).toBe(PAGE_ADDRESS);
  expect(decoded.amount).toBe("0.25");
  expect(decoded.memo).toBeNull();
  expect(decoded.params.has("memo")).toBe(false);

  // The smallest amount survives the INPUT (codex adversarial review): a
  // number input would hand the builder `1e-8` and the amount would vanish.
  const amount = page.getByLabel("Amount in ZEC (optional)");
  await amount.fill("0.00000001");
  decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.amount).toBe("0.00000001");

  // A populated but invalid amount disables the handoff rather than sending
  // the wallet an unspecified amount.
  await amount.fill("abc");
  await expect(dialog.getByText(/Enter a ZEC amount/)).toBeVisible();
  await expect(page.getByTestId("zec-open-wallet")).toBeDisabled();
  await amount.fill("");
  decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.amount).toBeNull();
});

test("a transparent page address gets no memo field and no memo parameter", async ({
  page,
}) => {
  const dialog = await openZcashSupport(page, "/support-author/support-zec-t");
  const initial = decodeZcashUri(await walletUri(page));
  expect(initial.address).toBe(TRANSPARENT_ADDRESS);
  expect(initial.params.has("memo")).toBe(false);
  await expect(page.getByTestId("zec-recipient-address")).toHaveText(
    TRANSPARENT_ADDRESS,
  );
  await expect(dialog.getByText("This is a transparent address")).toBeVisible();
  await expect(page.getByLabel("Memo to the creator (optional)")).toHaveCount(
    0,
  );
  await page.getByLabel("Amount in ZEC (optional)").fill("1");
  const decoded = decodeZcashUri(await walletUri(page));
  expect(decoded.address).toBe(TRANSPARENT_ADDRESS);
  expect(decoded.amount).toBe("1");
  expect(decoded.params.has("memo")).toBe(false);
});
