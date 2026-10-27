import { expect, test, type Page } from "@playwright/test";

test.describe.configure({ timeout: 90_000 });

const ARTICLE = "/ssr-body-user/ssr-body-fixture";
const EXTERNAL_HREF = "https://external.example/next?from=markdown";

async function stubExternalDestination(page: Page) {
  await page.context().route("https://external.example/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>external fixture</title>",
    }),
  );
}

test("SSR opens off-site author links in a new tab and keeps internal ones local", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();

  try {
    await page.goto(ARTICLE);
    const content = page.locator(".markdown-content").first();
    const authorLinks = content.locator("a.markdown-author-link");

    await expect(authorLinks).toHaveCount(2);

    // Off-site only. Both anchors are marked so the hydrated handler
    // classifies both, but the new tab is for the destination that leaves
    // Free2Z. See `renderer.link` in src/lib/utils/markdown.ts for how this
    // reconciles with  required behaviour 1.
    const external = content.locator(
      `a.markdown-author-link[href="${EXTERNAL_HREF}"]`,
    );
    await expect(external).toHaveAttribute("target", "_blank");
    await expect(external).toHaveAttribute("rel", "noopener noreferrer");

    const internal = content.locator(
      `a.markdown-author-link[href="${ARTICLE}"]`,
    );
    await expect(internal).not.toHaveAttribute("target");
    await expect(internal).not.toHaveAttribute("rel");

    const generatedAttributes = await content
      .locator("a[data-footnote-ref], a[data-footnote-backref]")
      .evaluateAll((links) =>
        links.map((link) => ({
          target: link.getAttribute("target"),
          rel: link.getAttribute("rel"),
        })),
      );
    expect(generatedAttributes).toHaveLength(2);
    expect(generatedAttributes).toEqual([
      { target: null, rel: null },
      { target: null, rel: null },
    ]);
  } finally {
    await context.close();
  }
});

test("unknown external links warn for pointer and keyboard activation", async ({
  page,
}) => {
  await page.goto(ARTICLE);

  const content = page.locator(".markdown-content").first();
  const externalLink = content.locator(
    `a.markdown-author-link[href="${EXTERNAL_HREF}"]`,
  );
  const headingAnchor = content.locator("a.heading-anchor").first();

  await expect(headingAnchor).toBeAttached();

  await expect(headingAnchor).not.toHaveAttribute("target");
  await expect(headingAnchor).not.toHaveAttribute("rel");

  // A same-origin author link navigates IN PLACE, with no warning and no
  // popup. Requirement 6 already exempts same-origin links from the
  // external-site warning; the second tab was the part that made an in-page
  // table of contents unusable and pushed internal cross-links out of the
  // client router.
  const sameOriginLink = content.locator(
    `a.markdown-author-link[href="${ARTICLE}"]`,
  );
  // The listener is armed BEFORE the click and given a real window to fire in.
  // A `page.on("popup")` flag read straight after `waitForURL` is not a
  // control: the fixture's same-origin link points at the article itself, so
  // the URL already matches and the assertion runs before the popup event can
  // arrive. Measured -- that version stayed green with `target="_blank"` back
  // on every author link.
  const popupPromise = page
    .waitForEvent("popup", { timeout: 3000 })
    .catch(() => null);
  await sameOriginLink.click();
  const sameOriginPopup = await popupPromise;
  expect(sameOriginPopup).toBeNull();
  await expect(page).toHaveURL(new RegExp(`${ARTICLE}$`));
  await expect(page.getByTestId("outbound-link-warning")).toHaveCount(0);

  const headingHref = await headingAnchor.getAttribute("href");
  await headingAnchor.click();
  expect(new URL(page.url()).hash).toBe(headingHref);

  await externalLink.click();
  const dialog = page.getByTestId("outbound-link-warning");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(EXTERNAL_HREF);
  await expect(dialog).toContainText("external.example");
  await expect(dialog).toContainText("https:");
  await expect(
    dialog.getByRole("checkbox", { name: "Always trust this domain" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("checkbox", {
      name: "Don't warn for any external links",
    }),
  ).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Continue once" }),
  ).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await expect(externalLink).toBeFocused();

  await externalLink.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(externalLink).toBeFocused();

  await externalLink.click({ button: "middle" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).not.toBeVisible();
});

test("Continue once opens a no-opener popup and does not persist trust", async ({
  page,
}) => {
  await stubExternalDestination(page);
  await page.goto(ARTICLE);
  await expect(
    page
      .locator(".markdown-content")
      .first()
      .locator("a.heading-anchor")
      .first(),
  ).toBeAttached();
  const externalLink = page.locator(
    `.markdown-content a.markdown-author-link[href="${EXTERNAL_HREF}"]`,
  );

  await externalLink.click();
  const dialog = page.getByTestId("outbound-link-warning");
  await expect(dialog).toBeVisible();

  const popupPromise = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Continue once" }).click();
  const popup = await popupPromise;
  try {
    await expect.poll(() => popup.url()).toContain(EXTERNAL_HREF);
    expect(await popup.evaluate(() => window.opener)).toBeNull();
  } finally {
    await popup.close();
  }

  const preferences = await page.evaluate(() => ({
    trustedDomains: localStorage.getItem("trustedExternalDomains"),
    globalWarning: localStorage.getItem("dontShowExternalLinkWarning"),
  }));
  expect(preferences).toEqual({
    trustedDomains: null,
    globalWarning: null,
  });

  await externalLink.click();
  await expect(dialog).toBeVisible();
});

test("normalized domain and global preferences bypass warnings independently", async ({
  page,
}) => {
  await stubExternalDestination(page);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "trustedExternalDomains",
      JSON.stringify(["EXTERNAL.EXAMPLE."]),
    );
  });
  await page.goto(ARTICLE);
  await expect(
    page
      .locator(".markdown-content")
      .first()
      .locator("a.heading-anchor")
      .first(),
  ).toBeAttached();

  const trustedLink = page.locator(
    `.markdown-content a.markdown-author-link[href="${EXTERNAL_HREF}"]`,
  );
  const trustedPopupPromise = page.waitForEvent("popup");
  await trustedLink.click();
  const trustedPopup = await trustedPopupPromise;
  await expect.poll(() => trustedPopup.url()).toContain(EXTERNAL_HREF);
  await trustedPopup.close();
  await expect(page.getByTestId("outbound-link-warning")).not.toBeVisible();

  await page.evaluate(() => {
    localStorage.removeItem("trustedExternalDomains");
    localStorage.setItem("dontShowExternalLinkWarning", "true");
  });
  await page.reload();

  const globalPopupPromise = page.waitForEvent("popup");
  await page
    .locator(
      `.markdown-content a.markdown-author-link[href="${EXTERNAL_HREF}"]`,
    )
    .click();
  const globalPopup = await globalPopupPromise;
  await expect.poll(() => globalPopup.url()).toContain(EXTERNAL_HREF);
  await globalPopup.close();
  await expect(page.getByTestId("outbound-link-warning")).not.toBeVisible();
});

test("settings exposes revocation for outbound-link preferences", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "billing-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.setItem(
      "trustedExternalDomains",
      JSON.stringify(["EXTERNAL.EXAMPLE."]),
    );
    localStorage.setItem("dontShowExternalLinkWarning", "true");
  });
  await page.goto("/fixtureowner/dashboard/settings");

  const settings = page.getByTestId("outbound-link-settings");
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId("outbound-trusted-domains")).toContainText(
    "external.example",
  );

  await settings.getByRole("button", { name: "Revoke" }).click();
  await expect(
    settings.getByTestId("outbound-no-trusted-domains"),
  ).toBeVisible();
  expect(
    await page.evaluate(() => localStorage.getItem("trustedExternalDomains")),
  ).toBe("[]");

  const globalSwitch = settings.getByRole("switch", {
    name: "Don't warn for any external links",
  });
  await globalSwitch.click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("dontShowExternalLinkWarning"),
    ),
  ).toBeNull();
  await globalSwitch.click();
  expect(
    await page.evaluate(() =>
      localStorage.getItem("dontShowExternalLinkWarning"),
    ),
  ).toBe("true");
});
