import { expect, test, type Page } from "@playwright/test";

const PHONE = { width: 320, height: 568 };

async function openCreator(page: Page, username: string, delayMs = 0) {
  await page.setViewportSize(PHONE);
  await page.addInitScript(({ delay }) => {
    localStorage.setItem("zuuli.knox.token", "mock-knox-token");
    localStorage.setItem("zuuli.mock.send-proposal-delay-ms", String(delay));
  }, { delay: delayMs });
  await page.goto(`/creator/${username}`);
  await page.getByRole("button", { name: new RegExp(`Tip ${username}`, "i") }).click();
}

async function chooseZec(page: Page) {
  await expect(page.getByRole("group", { name: "Tip currency" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^2Z Platform credits$/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.getByLabel("Amount (2Z)")).toBeVisible();
  await page.getByRole("button", { name: /^ZEC Zcash wallet$/ }).click();
  await page.getByRole("button", { name: "Continue with ZEC" }).click();
  await expect(page).toHaveURL(/\/wallet\/send\/creator-tip$/);
}

test("a 320px creator ZEC tip locks the issued destination through native review", async ({
  page,
}) => {
  await openCreator(page, "zooko", 600);
  await chooseZec(page);

  const recipient = page.getByLabel("Recipient address");
  const exactRecipient = await recipient.inputValue();
  expect(exactRecipient).toMatch(/^u1mockzooko/);
  await expect(recipient).toHaveAttribute("readonly", "");
  await expect(page.getByTestId("creator-tip-context")).toContainText(
    "@zooko",
  );
  await expect(page.getByText(/Valid unified address/)).toBeVisible();

  await page.getByLabel("Amount").fill("0.0001");
  await page.getByLabel(/^Memo/).fill("chosen by the payer");
  await page.getByRole("button", { name: "Review payment" }).click();

  // Simulate a compromised renderer mutating both browser route state and the
  // read-only DOM while the native proposal is pending. Neither is the source
  // used by the in-memory intent snapshot or the proposal assertion.
  await page.evaluate(() => {
    const current = window.history.state as {
      usr?: { creatorTip?: Record<string, unknown> };
    } | null;
    window.history.replaceState(
      {
        ...current,
        usr: {
          ...current?.usr,
          creatorTip: {
            ...current?.usr?.creatorTip,
            username: "attacker",
            label: "Attacker",
            recipient: "t1substituteddestination",
          },
        },
      },
      "",
    );

    const input = document.querySelector<HTMLInputElement>("#to");
    input?.removeAttribute("readonly");
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, "t1substituteddestination");
    input?.dispatchEvent(new InputEvent("input", { bubbles: true }));
  });

  const dialog = page.getByRole("dialog", { name: "Confirm payment" });
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId("creator-tip-review-context")).toContainText(
    "@zooko",
  );
  await expect(page.getByTestId("send-review-recipient")).toHaveText(
    exactRecipient,
  );
  await expect(page.getByTestId("send-review-amount")).toHaveText("0.0001 ZEC");
  await expect(page.getByTestId("send-review-memo")).toHaveText(
    "chosen by the payer",
  );
  await expect(dialog.getByText("mainnet", { exact: true })).toBeVisible();
  await expect(page.getByTestId("send-review-change-policy")).toHaveAttribute(
    "title",
    "zip317-shielded-auto",
  );

  const geometry = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      viewportWidth: document.documentElement.scrollWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(PHONE.width);
  expect(geometry.viewportWidth).toBeLessThanOrEqual(PHONE.width);

  const leaked = await page.evaluate(
    (address) =>
      [...Object.entries(localStorage), ...Object.entries(sessionStorage)].filter(
        ([key, value]) =>
          value.includes(address) ||
          /creatorTip|proposalToken|reviewDigest|chosen by the payer/i.test(
            `${key}:${value}`,
          ),
      ),
    exactRecipient,
  );
  expect(leaked).toEqual([]);
});

test("an unissued creator-tip route fails closed without an editable recipient", async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto("/wallet/send/creator-tip");

  await expect(page.getByRole("alert")).toContainText(
    "payment details could not be verified",
  );
  await expect(page.getByLabel("Recipient address")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Review payment" })).toHaveCount(0);
});

test("reloading destroys the in-memory creator intent and fails closed", async ({
  page,
}) => {
  await openCreator(page, "zooko");
  await chooseZec(page);
  await expect(page.getByLabel("Recipient address")).toHaveAttribute("readonly", "");

  await page.reload();

  await expect(page.getByRole("alert")).toContainText(
    "payment details could not be verified",
  );
  await expect(page.getByLabel("Recipient address")).toHaveCount(0);
});

test("an accepted creator intent cannot be reused from browser history", async ({
  page,
}) => {
  await openCreator(page, "zooko");
  await chooseZec(page);
  await expect(page.getByText(/Valid unified address/)).toBeVisible();
  await page.getByLabel("Amount").fill("0.0001");
  await page.getByRole("button", { name: "Review payment" }).click();
  await page.getByRole("button", { name: "Confirm & send" }).click();
  await expect(page).toHaveURL(/\/wallet\/history$/);

  await page.goBack();

  await expect(page.getByRole("alert")).toContainText(
    "payment details could not be verified",
  );
  await expect(page.getByLabel("Recipient address")).toHaveCount(0);
});

test("a wrong-network creator intent stays locked and cannot be proposed", async ({
  page,
}) => {
  await openCreator(page, "testnet_creator");
  await chooseZec(page);

  await expect(page.getByLabel("Recipient address")).toHaveAttribute("readonly", "");
  await expect(
    page.getByText("Address belongs to a different Zcash network"),
  ).toBeVisible();
  await page.getByLabel("Amount").fill("0.0001");
  await expect(page.getByRole("button", { name: "Review payment" })).toBeDisabled();
});

test("transparent creator destinations warn before proposal and prohibit memos", async ({
  page,
}) => {
  await openCreator(page, "transparent_creator");
  await chooseZec(page);

  await expect(page.getByTestId("creator-tip-privacy-warning")).toContainText(
    "publicly visible on-chain",
  );
  await expect(page.getByLabel(/^Memo/)).toBeDisabled();
  await expect(page.getByLabel(/^Memo/)).toHaveValue("");
  await page.getByLabel("Amount").fill("0.0001");
  await page.getByRole("button", { name: "Review payment" }).click();
  await expect(page.getByTestId("send-review-memo")).toHaveText("None");
});
