import { expect, test, type Page } from "@playwright/test";
import { PSEUDO_ABOUT_MESSAGES } from "../src/lib/about-copy";

declare global {
  interface Window {
    __feedbackOpenedUrl?: string;
  }
}

async function captureExternalOpen(page: Page, succeeds = true) {
  await page.addInitScript((allowOpen) => {
    window.__feedbackOpenedUrl = undefined;
    window.open = (() => {
      if (!allowOpen) return null;
      return {
        opener: window,
        location: {
          replace(url: string | URL) {
            window.__feedbackOpenedUrl = String(url);
          },
        },
      } as unknown as Window;
    }) as typeof window.open;
  }, succeeds);
}

async function openComposer(page: Page, pageTitle = "About & Feedback") {
  await page.goto("/about");
  await expect(
    page.getByRole("heading", { name: pageTitle }),
  ).toBeVisible();
}

async function chooseGithubWithKeyboard(page: Page) {
  const email = page.getByRole("radio", { name: /Private email/ });
  const github = page.getByRole("radio", { name: /Public GitHub issue/ });
  await email.focus();
  await expect(email).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(github).toBeChecked();
}

test("320px keyboard flow previews and hands off exactly the reviewed public draft", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await captureExternalOpen(page);
  await openComposer(page);
  await chooseGithubWithKeyboard(page);

  const diagnostics = page.getByRole("switch", {
    name: "Include sanitized diagnostics",
  });
  await expect(diagnostics).not.toBeChecked();
  await expect(diagnostics).toBeDisabled();
  await expect(page.getByText(/does not collect logs or tracebacks/)).toBeVisible();

  await page.getByLabel("What happened?").fill("The save action stopped responding.");
  await page.getByRole("button", { name: "Review report" }).click();

  await expect(
    page.getByRole("heading", { name: "Review the complete outgoing draft" }),
  ).toBeFocused();
  const subject = page.getByLabel("Outgoing subject or title");
  const body = page.getByLabel("Outgoing body");
  await expect(subject).toHaveValue("ZUULI feedback");
  await expect(body).toContainText("The save action stopped responding.");
  await expect(body).toContainText("ZUULI\nVersion:");
  await expect(body).not.toContainText("Diagnostics");
  await expect(page.getByRole("button", { name: "Remove diagnostics" })).toBeDisabled();

  const buttons = page.getByRole("button");
  const undersized = await buttons.evaluateAll((items) =>
    items
      .filter((item) => !item.hasAttribute("disabled"))
      .map((item) => item.getBoundingClientRect())
      .filter(({ width, height }) => width < 44 || height < 44).length,
  );
  expect(undersized).toBe(0);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(320);

  const reviewedSubject = await subject.inputValue();
  const reviewedBody = await body.inputValue();
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  await expect(page.getByRole("region", { name: /Review the complete outgoing/ }).getByRole("status")).toContainText(
    "ZUULI cannot know whether you submit it",
  );

  const opened = await page.evaluate(() => window.__feedbackOpenedUrl);
  expect(opened).toBeTruthy();
  const url = new URL(opened!);
  expect(url.origin + url.pathname).toBe("https://github.com/free2z/zuu/issues/new");
  expect(url.searchParams.get("title")).toBe(reviewedSubject);
  expect(url.searchParams.get("body")).toBe(reviewedBody);
});

test("preview edits are scrubbed and require fresh confirmation", async ({ page }) => {
  await captureExternalOpen(page);
  await openComposer(page);
  await page.getByRole("radio", { name: /Public GitHub issue/ }).check();
  await page.getByLabel("What happened?").fill("A safe description.");
  await page.getByRole("button", { name: "Review report" }).click();

  const body = page.getByLabel("Outgoing body");
  await body.fill(`${await body.inputValue()}\npassword: added-after-preview`);
  await page.getByRole("button", { name: "Continue to chosen app" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "Potential private data was removed",
  );
  await expect(body).not.toContainText("added-after-preview");
  expect(await page.evaluate(() => window.__feedbackOpenedUrl)).toBeUndefined();

  const reviewedBody = await body.inputValue();
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  const opened = await page.evaluate(() => window.__feedbackOpenedUrl);
  expect(new URL(opened!).searchParams.get("body")).toBe(reviewedBody);
});

test("over-limit and platform failures keep the same report available to copy", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await captureExternalOpen(page, false);
  await openComposer(page);
  await page.getByRole("radio", { name: /Public GitHub issue/ }).check();
  await page.getByLabel("What happened?").fill("Long report start. " + "💡".repeat(700));
  await page.getByRole("button", { name: "Review report" }).click();

  const subject = await page.getByLabel("Outgoing subject or title").inputValue();
  const body = await page.getByLabel("Outgoing body").inputValue();
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "too long for a safe app handoff",
  );
  expect(await page.evaluate(() => window.__feedbackOpenedUrl)).toBeUndefined();

  await page.getByRole("button", { name: "Copy reviewed report" }).click();
  await expect(page.getByRole("region", { name: /Review the complete outgoing/ }).getByRole("status")).toContainText("Nothing was sent");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Subject: ${subject}\n\n${body}`,
  );

  await page.getByLabel("Outgoing body").fill("Short safe report.");
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "chosen app could not be opened",
  );
  await expect(page.getByLabel("Outgoing body")).toHaveValue("Short safe report.");
});

test("private email remains explicit and uses the same reviewed subject and body", async ({
  page,
}) => {
  await captureExternalOpen(page);
  await openComposer(page);
  await page.getByRole("radio", { name: /Private email/ }).check();
  await page.getByLabel("What happened?").fill("Private feedback body.");
  await page.getByRole("button", { name: "Review report" }).click();
  await expect(page.getByText(/Only that support inbox can read/)).toBeVisible();

  const subject = await page.getByLabel("Outgoing subject or title").inputValue();
  const body = await page.getByLabel("Outgoing body").inputValue();
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  const opened = await page.evaluate(() => window.__feedbackOpenedUrl);
  expect(opened!.startsWith("mailto:help@free2z.com?")).toBe(true);
  const parameters = new URLSearchParams(opened!.slice(opened!.indexOf("?") + 1));
  expect(parameters.get("subject")).toBe(subject);
  expect(parameters.get("body")).toBe(body);
});

test("real Chromium popup receives the exact online GitHub draft without a false failure", async ({
  context,
  page,
}) => {
  await context.route("https://github.com/free2z/zuu/issues/new**", async (route) => {
    await route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Captured GitHub draft</title>",
    });
  });
  await openComposer(page);
  await page.getByRole("radio", { name: /Public GitHub issue/ }).check();
  await page.getByLabel("What happened?").fill("Real popup parity report.");
  await page.getByRole("button", { name: "Review report" }).click();
  const reviewedSubject = await page
    .getByLabel("Outgoing subject or title")
    .inputValue();
  const reviewedBody = await page.getByLabel("Outgoing body").inputValue();

  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue to chosen app" }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  const opened = new URL(popup.url());
  expect(opened.origin + opened.pathname).toBe(
    "https://github.com/free2z/zuu/issues/new",
  );
  expect(opened.searchParams.get("title")).toBe(reviewedSubject);
  expect(opened.searchParams.get("body")).toBe(reviewedBody);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page
      .getByRole("region", { name: /Review the complete outgoing/ })
      .getByRole("status"),
  ).toContainText("ZUULI cannot know whether you submit it");
});

test("offline handoff failure preserves the exact reviewed report and copy fallback", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openComposer(page);
  await page.getByRole("radio", { name: /Public GitHub issue/ }).check();
  await page
    .getByLabel("What happened?")
    .fill("The report must remain available while offline.");
  await page.getByRole("button", { name: "Review report" }).click();

  const subject = page.getByLabel("Outgoing subject or title");
  const body = page.getByLabel("Outgoing body");
  const reviewedSubject = await subject.inputValue();
  const reviewedBody = await body.inputValue();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Continue to chosen app" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "chosen app could not be opened",
  );
  await expect(page.getByRole("alert")).not.toContainText(/submitted|succeeded/i);
  await expect(subject).toHaveValue(reviewedSubject);
  await expect(body).toHaveValue(reviewedBody);

  await page.getByRole("button", { name: "Copy reviewed report" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `Subject: ${reviewedSubject}\n\n${reviewedBody}`,
  );
});

test("offline mode still hands the exact private draft to a local mail composer", async ({
  context,
  page,
}) => {
  await captureExternalOpen(page);
  await openComposer(page);
  await page.getByRole("radio", { name: /Private email/ }).check();
  await page.getByLabel("What happened?").fill("Queue this private draft offline.");
  await page.getByRole("button", { name: "Review report" }).click();
  const reviewedSubject = await page
    .getByLabel("Outgoing subject or title")
    .inputValue();
  const reviewedBody = await page.getByLabel("Outgoing body").inputValue();
  await context.setOffline(true);
  await page.getByRole("button", { name: "Continue to chosen app" }).click();

  const opened = await page.evaluate(() => window.__feedbackOpenedUrl);
  expect(opened?.startsWith("mailto:help@free2z.com?")).toBe(true);
  const fields = new URLSearchParams(opened!.slice(opened!.indexOf("?") + 1));
  expect(fields.get("subject")).toBe(reviewedSubject);
  expect(fields.get("body")).toBe(reviewedBody);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test.describe("pseudo-expanded shipping locale feedback", () => {
  test.use({ locale: "en-XA", viewport: { width: 320, height: 760 } });

  test("renders the full consent and preview flow at 200%", async ({
    context,
    page,
  }) => {
    await captureExternalOpen(page);
    await openComposer(page, PSEUDO_ABOUT_MESSAGES.pageTitle);
    await page.addStyleTag({ content: "html { font-size: 200% !important; }" });

    await expect(
      page.getByRole("heading", {
        name: PSEUDO_ABOUT_MESSAGES.feedbackHeading,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(PSEUDO_ABOUT_MESSAGES.feedbackEmailPrivacy),
    ).toBeVisible();
    await expect(
      page.getByText(PSEUDO_ABOUT_MESSAGES.feedbackGithubPrivacy),
    ).toBeVisible();
    const diagnostics = page.getByRole("switch", {
      name: PSEUDO_ABOUT_MESSAGES.feedbackDiagnosticsLabel,
    });
    await expect(diagnostics).toBeDisabled();
    await expect(diagnostics).not.toBeChecked();
    await expect(
      page.getByText(PSEUDO_ABOUT_MESSAGES.feedbackDiagnosticsUnavailable),
    ).toBeVisible();

    const email = page.getByRole("radio", {
      name: new RegExp(PSEUDO_ABOUT_MESSAGES.feedbackEmailName),
    });
    await email.focus();
    await page.keyboard.press("ArrowRight");
    await expect(
      page.getByRole("radio", {
        name: new RegExp(PSEUDO_ABOUT_MESSAGES.feedbackGithubName),
      }),
    ).toBeChecked();
    await page
      .getByLabel(PSEUDO_ABOUT_MESSAGES.feedbackDescriptionLabel)
      .fill("Safe pseudo-locale report.");
    await page
      .getByRole("button", {
        name: PSEUDO_ABOUT_MESSAGES.feedbackReviewAction,
      })
      .click();

    await expect(
      page.getByRole("heading", {
        name: PSEUDO_ABOUT_MESSAGES.feedbackPreviewTitle,
      }),
    ).toBeFocused();
    const subject = page.getByLabel(
      PSEUDO_ABOUT_MESSAGES.feedbackSubjectLabel,
    );
    const body = page.getByLabel(PSEUDO_ABOUT_MESSAGES.feedbackBodyLabel);
    await expect(subject).toHaveValue(
      PSEUDO_ABOUT_MESSAGES.feedbackDefaultSubject,
    );
    await expect(body).toContainText(PSEUDO_ABOUT_MESSAGES.versionLabel);

    for (const action of [
      PSEUDO_ABOUT_MESSAGES.feedbackRemoveDiagnosticsAction,
      PSEUDO_ABOUT_MESSAGES.feedbackCopyAction,
      PSEUDO_ABOUT_MESSAGES.feedbackEditAction,
      PSEUDO_ABOUT_MESSAGES.feedbackCancelAction,
      PSEUDO_ABOUT_MESSAGES.feedbackContinueAction,
    ]) {
      const button = page.getByRole("button", { name: action });
      await expect(button).toBeVisible();
      expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    }

    await body.fill("💡".repeat(700));
    await page
      .getByRole("button", {
        name: PSEUDO_ABOUT_MESSAGES.feedbackContinueAction,
      })
      .click();
    await expect(page.getByRole("alert")).toHaveText(
      PSEUDO_ABOUT_MESSAGES.feedbackTooLongWarning,
    );

    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .getByRole("button", {
        name: PSEUDO_ABOUT_MESSAGES.feedbackCopyAction,
      })
      .click();
    await expect(
      page
        .getByRole("region", {
          name: PSEUDO_ABOUT_MESSAGES.feedbackPreviewTitle,
        })
        .getByRole("status"),
    ).toHaveText(PSEUDO_ABOUT_MESSAGES.feedbackCopiedStatus);
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
      `${PSEUDO_ABOUT_MESSAGES.feedbackCopiedSubjectPrefix}:`,
    );

    const geometry = await page.locator("[data-app-frame]").evaluate((frame) => {
      const clipped = [...frame.querySelectorAll<HTMLElement>("*")]
        .filter((element) => {
          const style = getComputedStyle(element);
          return (
            style.textOverflow === "ellipsis" ||
            Number.parseInt(style.webkitLineClamp, 10) > 0
          );
        })
        .map((element) => element.tagName);
      return {
        clientWidth: frame.clientWidth,
        scrollWidth: frame.scrollWidth,
        clipped,
      };
    });
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.clipped).toEqual([]);
  });
});
