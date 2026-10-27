import { expect, test } from "@playwright/test";
import {
  CREATOR,
  ARTICLE_ID,
  SOURCE_TITLE,
  SOURCE_DESCRIPTION,
  SOURCE_CONTENT,
  TARGET_TITLE,
  TARGET_DESCRIPTION,
  TARGET_CONTENT,
  TRANSLATE_WITH_AI,
  TARGET_DRAFT,
  deliveredJob,
  stubApi,
  openAi,
  warmEditorOnce,
} from "./ai-translation-delivery-fixture";

/**
 * AI translation delivery in the editor.
 *
 * This exercises the purchase through the real editor UI. The API returns a
 * queued job, then delivers it through the status endpoint so the regression
 * covers the same hand-off the production poller uses.
 *
 * Negative control: against the unfixed editor, the delivered response only
 * refreshed the Translations panel. The source title remained in the editor,
 * so the target-title assertion below fails. The initial source assertion
 * proves the test did not start with the target already hydrated.
 */

warmEditorOnce();

test("delivered AI translation opens as the draft on Review and saves as that variant", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);

  const title = page.getByPlaceholder("Article title...");
  const description = page.getByPlaceholder(
    "Article subtitle or description...",
  );
  const content = page.locator("textarea.writing-area-textarea");

  await expect(title).toHaveValue(SOURCE_TITLE);
  await expect(description).toHaveValue(SOURCE_DESCRIPTION);
  await expect(content).toHaveValue(SOURCE_CONTENT);

  await page.getByRole("button", { name: /^Translations/ }).click();
  const spanish = page.locator('[data-language="es"]');
  await spanish.getByRole("button", { name: TRANSLATE_WITH_AI }).click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  await page.getByTestId("translate-ai-confirm").click();
  // The editor-created action must still work after client navigation away.
  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toBeVisible();
  await page.context().addCookies([
    {
      name: "sessionid",
      value: "profile-fixture-session",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  await page.evaluate(async () => {
    (window as any).navigationMarker = "same-document";
    const runtime = performance
      .getEntriesByType("resource")
      .map((entry) => entry.name)
      .find((name) =>
        name.includes("@sveltejs/kit/src/runtime/client/client.js"),
      );
    if (!runtime) throw new Error("Loaded navigation runtime missing");
    const { goto } = await import(runtime);
    await goto("/");
  });
  await expect(page).toHaveURL(/\/$/);
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/edit\\?lang=es&id=${ARTICLE_ID}$`));
  expect(await page.evaluate(() => (window as any).navigationMarker)).toBe(
    "same-document",
  );
  await expect(title).toHaveValue(TARGET_TITLE);
  await expect(description).toHaveValue(TARGET_DESCRIPTION);
  await expect(content).toHaveValue(TARGET_CONTENT);
  await expect(page.getByTestId("editor-language-chip")).toContainText(
    "Editing: Spanish",
  );
  await expect(
    page.locator("header").getByText("Draft", { exact: true }),
  ).toBeVisible();

  const editedTitle = `${TARGET_TITLE} — reviewed`;
  await title.fill(editedTitle);
  await expect
    .poll(
      () =>
        writes.some(
          (write) =>
            write.method === "PUT" &&
            write.pathname === `/api/zpage/${ARTICLE_ID}/translations/es/`,
        ),
      { timeout: 30_000 },
    )
    .toBe(true);

  const save = [...writes]
    .reverse()
    .find(
      (write) =>
        write.method === "PUT" &&
        write.pathname === `/api/zpage/${ARTICLE_ID}/translations/es/`,
    );
  expect(save?.body?.title).toBe(editedTitle);
});

test("title-only blank target can quote saved original without saving or losing edits", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My Spanish title");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  // The price screen is a price, a promise and a button. It used to
  // spend a paragraph on what would happen to these unsaved words when the
  // translation landed; that choice is gone, so the paragraph is too.
  const dialog = page.getByTestId("translate-ai-dialog");
  await expect(dialog).toContainText("Free2Z credits");
  await expect(dialog).not.toContainText("keep your edits");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "My Spanish title",
  );
  expect(writes.filter((w) => w.method === "PUT")).toEqual([]);
});

test("edited empty target offers discard or keep editing without impossible save", async ({
  page,
}) => {
  await stubApi(page, { blank: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("Keep this title");
  await page
    .locator('[data-language="en"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("body content");
  await expect(
    page.getByRole("button", { name: "Save and switch", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "Keep this title",
  );
  await page
    .locator('[data-language="en"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Discard and switch", exact: true })
    .click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
});

test("price refusal refreshes quote without another purchase until consent", async ({
  page,
}) => {
  const writes = await stubApi(page, { refusal: "price_changed" });
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("9 2Z");
  expect(writes.filter((w) => w.pathname.endsWith("/translate/")).length).toBe(
    1,
  );
});

test("transient status failure stays visible and recovers without another purchase", async ({
  page,
}) => {
  const writes = await stubApi(page, { pollFailure: true });
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translation-job-status")).toContainText(
    "Spanish",
  );
  await expect(page.getByTestId("translation-job-status")).toContainText(
    /lost the connection/i,
    { timeout: 10000 },
  );
  //recovered and delivered — offered for Review, not switched to.
  const review = page.getByRole("button", { name: "Review", exact: true });
  await review.click({ timeout: 15000 });
  expect(writes.filter((w) => w.pathname.endsWith("/translate/")).length).toBe(
    1,
  );
});

//a translation the WORKER refunds must reach the creator as a failure.
// The server side of that fix makes the refund visible to an operator; this is
// the creator's half. Queued at purchase, refunded by the job, found by the
// poll -- the path six of thirteen production runs took on 2026-09-18, where
// the other refund specs here answer the purchase POST itself.
test("a translation the worker refunds is reported as failed, not silently dropped", async ({
  page,
}) => {
  const writes = await stubApi(page, { workerRefund: true });
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();

  const status = page.getByTestId("translation-job-status");
  await expect(status).toContainText("The Spanish translation failed", {
    timeout: 15000,
  });
  await expect(status).toContainText("All 7 2Z are back in your balance");
  // The transient notice says the same, for a creator with the panel closed.
  await expect(
    page.getByText(
      "The Spanish translation could not be completed, so all 7 2Z were credited back to your balance.",
    ),
  ).toBeVisible();
  // Nothing was delivered, so nothing may be loaded or written as if it had
  // been, and the purchase was made exactly once.
  await expect(page.getByPlaceholder("Article title...")).not.toHaveValue(
    TARGET_TITLE,
  );
  expect(writes.filter((w) => w.pathname.endsWith("/translate/")).length).toBe(
    1,
  );
  expect(
    writes.filter((w) => w.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
});

test("insufficient funds after affordable quote removes stale Buy until refreshed", async ({
  page,
}) => {
  const writes = await stubApi(page, { refusal: "insufficient_funds" });
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-confirm")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh price and balance" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.getByTestId("insufficient-funds-buy")).toBeFocused();
  expect(writes.filter((w) => w.pathname.endsWith("/translate/")).length).toBe(
    1,
  );
  await page.getByRole("button", { name: "Refresh price and balance" }).click();
  await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
});

test("an unaffordable quote has no disabled purchase action", async ({
  page,
}) => {
  const writes = await stubApi(page, { unaffordableQuote: true });
  await openAi(page);
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();

  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  await expect(page.getByTestId("insufficient-funds")).toBeVisible();
  await expect(page.getByTestId("translate-ai-confirm")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Refresh price and balance" }),
  ).toBeVisible();
  expect(writes.filter((w) => w.pathname.endsWith("/translate/")).length).toBe(
    0,
  );
});

test("ambiguous purchase close and reopen replays original payload and key", async ({
  page,
}) => {
  await stubApi(page);
  const requests: { key: string | undefined; body: unknown }[] = [];
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
    async (route) => {
      if (route.request().method() === "GET") {
        await route.fulfill({ json: { ...deliveredJob(), status: "queued" } });
        return;
      }
      requests.push({
        key: route.request().headers()["idempotency-key"],
        body: route.request().postDataJSON(),
      });
      await route.fulfill(
        requests.length <= 2
          ? { status: 503, json: {} }
          : { json: { ...deliveredJob(), status: "queued" } },
      );
    },
  );
  await openAi(page);
  const ai = page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI });
  await ai.click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => requests.length).toBe(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // An undecided purchase must not be replaced by today's changed quote.
  let replacementQuotes = 0;
  await page.route(
    (url) => url.pathname.endsWith("/translate/quote/"),
    async (route) => {
      replacementQuotes++;
      await route.fulfill({ status: 503, json: {} });
    },
  );
  await ai.click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  await page.getByTestId("translate-ai-confirm").dblclick();
  await expect.poll(() => requests.length).toBe(3);
  expect(new Set(requests.map((r) => r.key)).size).toBe(1);
  expect(requests[0].key).toMatch(/^[0-9a-f-]{36}$/);
  expect(requests[2].body).toEqual(requests[0].body);
  expect(replacementQuotes).toBe(0);
});

test("reopen reconciles a newer receipt without overwriting editor or wedging purchases", async ({
  page,
}) => {
  await stubApi(page);
  await openAi(page);
  await page.evaluate(
    ({ key, receipt }) => localStorage.setItem(key, JSON.stringify(receipt)),
    {
      key: `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`,
      receipt: {
        page: ARTICLE_ID,
        language: "es",
        job: { ...deliveredJob(), job_id: "old-receipt", status: "queued" },
        interrupted: false,
        checking: false,
      },
    },
  );
  let checks = 0;
  await page.route(
    (url) => url.pathname.endsWith("/translate/"),
    async (route) => {
      expect(route.request().method()).toBe("GET");
      checks++;
      await page.evaluate(async (key) => {
        await new Promise<void>((acquired) => {
          void navigator.locks.request(
            key,
            () =>
              new Promise<void>((release) => {
                (window as any).releaseReceiptLock = release;
                acquired();
              }),
          );
        });
      }, `translation-receipt:${CREATOR.username}:${ARTICLE_ID}:pending`);
      await route.fulfill({ json: deliveredJob() });
    },
  );
  await page.reload();
  await expect(page.getByTestId("translation-job-status")).toContainText(
    "newer translation purchase",
    { timeout: 10000 },
  );
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
  const purchaseButton = page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI });
  // The terminal receipt is visible, but its owned index write is still
  // waiting for another tab's lock. Do not announce completed recovery yet.
  await expect(purchaseButton).toBeDisabled();
  await page.evaluate(() => (window as any).releaseReceiptLock());
  await expect(purchaseButton).toBeEnabled();
  expect(checks).toBe(1);
  const persisted = await page.evaluate(
    (key) => JSON.parse(localStorage.getItem(key) ?? "null"),
    `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`,
  );
  expect(persisted.job.job_id).toBe(deliveredJob().job_id);
  expect(persisted.job.status).toBe("delivered");
  await page.reload();
  await expect(page.getByTestId("translation-job-status")).toContainText(
    "ready as a draft",
  );
});

test("quote failure retries in place and slow cancelled quote never reopens dialog", async ({
  page,
}) => {
  await stubApi(page);
  await openAi(page);
  const ai = page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI });
  let release: (() => void) | undefined;
  let quoteCalls = 0;
  await page.route(
    (url) => url.pathname.endsWith("/translate/quote/"),
    async (route) => {
      quoteCalls++;
      if (quoteCalls === 1) await route.fulfill({ status: 503, json: {} });
      else {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        await route.fulfill({ status: 503, json: {} });
      }
    },
  );
  await ai.click();
  await expect(page.getByTestId("translate-ai-error")).toBeVisible();
  await page.getByRole("button", { name: "Refresh price and balance" }).click();
  await expect.poll(() => quoteCalls).toBe(2);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  release?.();
  await expect(page.getByTestId("translate-ai-dialog")).toHaveCount(0);
  await expect(ai).toBeEnabled();
});

test("dirty original saves before pricing and rejected save never requests quote", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await openAi(page);
  await page.getByPlaceholder("Article title...").fill("Updated source title");
  let quotes = 0;
  await page.route(
    (url) => url.pathname.endsWith("/translate/quote/"),
    async (route) => {
      quotes++;
      expect(
        writes.some(
          (w) =>
            w.method === "PUT" && w.pathname === `/api/zpage/${ARTICLE_ID}/`,
        ),
      ).toBe(true);
      await route.fallback();
    },
  );
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-price")).toBeVisible();
  expect(quotes).toBe(1);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.route(
    (url) => url.pathname === `/api/zpage/${ARTICLE_ID}/`,
    async (route) => {
      if (route.request().method() === "PUT")
        await route.fulfill({
          status: 412,
          json: { detail: "Changed elsewhere" },
        });
      else await route.fallback();
    },
  );
  await page
    .getByPlaceholder("Article title...")
    .fill("Unconfirmed source title");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-error")).toBeVisible();
  expect(quotes).toBe(1);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "Unconfirmed source title",
  );
});

test("target body typed then erased can quote and untouched blank switches freely", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  await openAi(page, true);
  await page
    .locator('[data-language="en"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Add a translation", exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("option", { name: "Spanish", exact: true })
    .first()
    .click();
  // The source is already normalized after this round trip; there are no
  // edits to discard. Await the target hydration, not an optional prompt.
  await expect(page.getByPlaceholder("Article title...")).toHaveValue("");
  const content = page.locator("textarea.writing-area-textarea");
  await content.fill("Some words");
  await content.fill("");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-price")).toBeVisible();
  expect(writes.filter((w) => w.method === "PUT")).toEqual([]);
});

test("meaningful unsaved target remains until explicit delivery choice", async ({
  page,
}) => {
  const writes = await stubApi(page, { blank: true });
  await openAi(page, true);
  await page.getByPlaceholder("Article title...").fill("My target title");
  await page
    .locator("textarea.writing-area-textarea")
    .fill("My own Spanish translation");
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByRole("button", { name: "Keep my text" })).toBeVisible({
    timeout: 10000,
  });
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "My target title",
  );
  expect(writes.filter((w) => w.method === "PUT")).toEqual([]);
  await page
    .getByRole("button", { name: "Load the translation", exact: true })
    .click();
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_TITLE,
  );
});

test("pending settlement failure keeps the original key for the next retry", async ({
  page,
}) => {
  await stubApi(page);
  const keys: string[] = [];
  await page.route(
    (url) => url.pathname.endsWith("/translate/"),
    async (route) => {
      if (route.request().method() === "POST")
        keys.push(route.request().headers()["idempotency-key"]);
      await route.fallback();
    },
  );
  await openAi(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.endsWith(":pending") && JSON.parse(value).settled)
        throw new DOMException("Storage unavailable", "SecurityError");
      return set.call(this, key, value);
    };
  });
  const ai = page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI });
  await ai.click();
  await page.getByTestId("translate-ai-confirm").click();
  //delivered, and offered for Review rather than switched to.
  await expect(page.getByText("Spanish is ready to review.")).toBeVisible();
  await ai.click();
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[1]).toBe(keys[0]);
});

test("newer delivered receipt prompts before resuming dirty target autosave", async ({
  page,
}) => {
  const options = { delivered: false };
  const writes = await stubApi(page, options);
  await openAi(page);
  await page.evaluate(
    ({ key, receipt }) => localStorage.setItem(key, JSON.stringify(receipt)),
    {
      key: `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`,
      receipt: {
        page: ARTICLE_ID,
        language: "es",
        job: { ...deliveredJob(), job_id: "old-receipt", status: "queued" },
        interrupted: false,
        checking: false,
      },
    },
  );
  let release: (() => void) | undefined;
  await page.route(
    (url) => url.pathname.endsWith("/translate/"),
    async (route) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      options.delivered = true;
      await route.fulfill({ json: deliveredJob() });
    },
  );
  await page.reload();
  await expect(page.getByTestId("translation-job-status")).toBeVisible();
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  // No save/discard prompt: see the note in `openAi`.
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    TARGET_DRAFT.title,
  );
  await page
    .getByPlaceholder("Article title...")
    .fill("My unsaved target revision");
  await expect.poll(() => Boolean(release)).toBe(true);
  release?.();
  await expect(
    page.getByRole("button", { name: "Keep my text" }),
  ).toBeVisible();
  await page.waitForTimeout(3000); // Beyond autosave delay: pending decision must hold all PUTs.
  expect(writes.filter((w) => w.method === "PUT")).toEqual([]);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    "My unsaved target revision",
  );
  await page.getByRole("button", { name: "Keep my text" }).click();
  await expect
    .poll(() => writes.filter((w) => w.method === "PUT").length)
    .toBe(1);
  expect(writes.find((w) => w.method === "PUT")?.ifMatch).toBe(
    '"es-delivered"',
  );
});

test("translation storage refusal remains visible in the purchase dialog under full urgent congestion", async ({
  page,
}) => {
  const writes = await stubApi(page);
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/toast.ts";
        let ready = false;
        (await import(module)).toastPresentation.subscribe(
          (value: { ready: boolean }) => (ready = value.ready),
        )();
        return ready;
      }),
    )
    .toBe(true);
  await page.evaluate(async () => {
    const module = "/src/lib/toast.ts";
    const { toast } = await import(module);
    for (let index = 0; index < 52; index++)
      toast.error(`Earlier upload failure ${index}`);
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name: string, value: string) {
      if (name.startsWith("translation-receipt:") && name.endsWith(":pending"))
        throw new DOMException("Storage unavailable", "QuotaExceededError");
      return original.call(this, name, value);
    };
  });
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/toast.ts";
        return (await import(module)).toastQueueStatus();
      }),
    )
    .toEqual({
      rendered: 2,
      queued: 50,
      urgentQueued: 50,
      overflow: 0,
      paymentQueued: false,
    });
  await page.getByTestId("translate-ai-confirm").click();
  await expect(page.getByTestId("translate-ai-purchase-error")).toContainText(
    "Browser storage is unavailable",
  );
  await expect(page.getByTestId("translate-ai-purchase-error")).toBeVisible();
  await expect(page.getByTestId("translate-ai-confirm")).toBeVisible();
  await expect(page.getByTestId("translate-ai-error")).toHaveCount(0);
  expect(
    writes.filter(
      (write) =>
        write.method === "POST" && write.pathname.endsWith("/translate/"),
    ).length,
  ).toBe(0);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    SOURCE_CONTENT,
  );
  await page.route("**/api/auth/user/", (route) =>
    route.fulfill({
      json: { id: 8124, username: "other-account", tuzis: "50" },
    }),
  );
  await page.evaluate(async () => {
    const module = "/src/lib/stores/auth.ts";
    await (
      await import(module)
    ).authStore.checkAuth({ force: true, fresh: true, silent: true });
  });
  await expect(page.getByTestId("translate-ai-purchase-error")).toHaveCount(0);
});

for (const status of [200, 402]) {
  test(`a held translation ${status} settles original storage without adding jobs or outcomes to the next account`, async ({
    page,
  }) => {
    await stubApi(page);
    let held: any;
    await page.route(
      `**/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
      (route) => {
        held = route;
      },
    );
    await page.goto(`/edit?id=${ARTICLE_ID}`);
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      SOURCE_TITLE,
    );
    await page.getByRole("button", { name: /^Translations/ }).click();
    await page
      .locator('[data-language="es"]')
      .getByRole("button", { name: TRANSLATE_WITH_AI })
      .click();
    await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
    await page.getByTestId("translate-ai-confirm").click();
    await expect.poll(() => Boolean(held)).toBe(true);
    await page.evaluate(async () => {
      const module = "/src/lib/stores/auth.ts";
      (await import(module)).authStore.hydrateFromSession({
        id: 8124,
        username: "other-account",
        tuzis: "50",
      });
    });
    await held.fulfill(
      status === 200
        ? { json: deliveredJob() }
        : {
            status: 402,
            json: {
              code: "insufficient_funds",
              cost: "7",
              balance: "0",
              shortfall: "7",
              action: "translation",
            },
          },
    );
    const base = `translation-receipt:${CREATOR.username}:${ARTICLE_ID}`;
    await expect
      .poll(() =>
        page.evaluate(
          (base) =>
            JSON.parse(localStorage.getItem(`${base}:pending`) || "null")
              ?.settled,
          base,
        ),
      )
      .toBe(status === 200 ? "success" : "refused");
    expect(
      await page.evaluate(
        ({ base, identifier }) =>
          Object.keys(localStorage).filter((key) =>
            key.startsWith(`translation-receipt:other-account:${identifier}`),
          ),
        { base, identifier: ARTICLE_ID },
      ),
    ).toEqual([]);
    await expect(
      page.getByRole("button", { name: "Review", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByTestId("translate-ai-error")).toHaveCount(0);
    await expect(page.getByTestId("translate-ai-purchase-error")).toHaveCount(
      0,
    );
    await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      SOURCE_TITLE,
    );
    await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
      SOURCE_CONTENT,
    );
  });
}

test("a queued translation polling401 resumes status checking after same-account reauthentication without buying again", async ({
  page,
}) => {
  const writes = await stubApi(page);
  let polls = 0;
  let deliver = false;
  await page.route(
    `**/api/zpage/${ARTICLE_ID}/variants/es/translate/`,
    async (route) => {
      if (route.request().method() !== "GET") return route.fallback();
      polls++;
      await route.fulfill(
        polls === 1
          ? { status: 401, json: { detail: "Session expired" } }
          : {
              json: {
                ...deliveredJob(),
                status: deliver ? "delivered" : "queued",
              },
            },
      );
    },
  );
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toHaveValue(
    SOURCE_TITLE,
  );
  await page.getByRole("button", { name: /^Translations/ }).click();
  await page
    .locator('[data-language="es"]')
    .getByRole("button", { name: TRANSLATE_WITH_AI })
    .click();
  await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
  await page.getByTestId("translate-ai-confirm").click();
  await expect.poll(() => polls).toBeGreaterThan(0);
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const module = "/src/lib/stores/auth.ts";
        let state: any;
        (await import(module)).authStore.subscribe(
          (value: any) => (state = value),
        )();
        return state.status;
      }),
    )
    .toBe("anonymous");
  await page.evaluate(async (creator) => {
    const module = "/src/lib/stores/auth.ts";
    (await import(module)).authStore.hydrateFromSession(creator);
  }, CREATOR);
  const reconnect = page.getByRole("button", {
    name: "Check translation status",
    exact: true,
  });
  await expect(reconnect).toBeVisible();
  await expect(reconnect).toBeEnabled();
  deliver = true;
  await reconnect.click();
  await expect(
    page.getByRole("button", { name: "Review", exact: true }),
  ).toBeVisible();
  expect(
    writes.filter(
      (write) =>
        write.method === "POST" && write.pathname.endsWith("/translate/"),
    ),
  ).toHaveLength(1);
  await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
    SOURCE_CONTENT,
  );
});

for (const returnToOriginal of [false, true]) {
  test(`single translation refuses to mint or send after account ownership changes during its held intent lock${returnToOriginal ? " and returns to A" : ""}`, async ({
    page,
  }) => {
    const writes = await stubApi(page);
    await page.goto(`/edit?id=${ARTICLE_ID}`);
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      SOURCE_TITLE,
    );
    await page.getByRole("button", { name: /^Translations/ }).click();
    await page
      .locator('[data-language="es"]')
      .getByRole("button", { name: TRANSLATE_WITH_AI })
      .click();
    await expect(page.getByTestId("translate-ai-price")).toContainText("7 2Z");
    await page.evaluate(() => {
      (window as any).translationLockStarted = false;
      navigator.locks.request = ((_name: any, action: any) =>
        new Promise((resolve, reject) => {
          (window as any).translationLockStarted = true;
          (window as any).releaseTranslationLock = () => {
            try {
              resolve(action());
            } catch (error) {
              reject(error);
            }
          };
        })) as any;
    });
    await page.getByTestId("translate-ai-confirm").click();
    await expect
      .poll(() => page.evaluate(() => (window as any).translationLockStarted))
      .toBe(true);
    await page.evaluate(async (returnToOriginal) => {
      const module = "/src/lib/stores/auth.ts",
        { authStore } = await import(module);
      let original: any;
      authStore.subscribe((value: any) => (original = value.creator))();
      authStore.hydrateFromSession({
        id: 8124,
        username: "other-account",
        tuzis: "50",
      });
      if (returnToOriginal) authStore.hydrateFromSession(original);
      (window as any).releaseTranslationLock();
    }, returnToOriginal);
    await expect(page.getByTestId("translate-ai-confirm")).toBeEnabled();
    expect(
      writes.filter(
        (write) =>
          write.method === "POST" && write.pathname.endsWith("/translate/"),
      ),
    ).toHaveLength(0);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter(
          (key) => key.startsWith("f2z:intent:") || key.endsWith(":pending"),
        ),
      ),
    ).toEqual([]);
    await expect(page.getByTestId("translate-ai-error")).toHaveCount(0);
    await expect(page.getByTestId("translate-ai-purchase-error")).toHaveCount(
      0,
    );
    await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
      SOURCE_CONTENT,
    );
  });
}

for (const returnToOriginal of [false, true]) {
  test(`bulk translation refuses persisted intent and dispatch after account ownership changes while its lock waits${returnToOriginal ? " and returns to A" : ""}`, async ({
    page,
  }) => {
    const writes = await stubApi(page);
    await page.goto(`/edit?id=${ARTICLE_ID}`);
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      SOURCE_TITLE,
    );
    await page.evaluate(async (identifier) => {
      const module = "/src/lib/editor/translation-bulk.ts",
        auth = "/src/lib/stores/auth.ts";
      const [{ purchaseBulkTranslations }, { authStore }] = await Promise.all([
        import(module),
        import(auth),
      ]);
      const owns = authStore.captureRequestOwnership();
      let actor: any;
      authStore.subscribe((value: any) => (actor = value.creator.username))();
      (window as any).bulkLockStarted = false;
      (window as any).bulkOwnershipDone = false;
      void purchaseBulkTranslations(
        {
          storage: () => localStorage,
          receiptKey: (page: string) => `translation-receipt:${actor}:${page}`,
          withLock: (_page: string, action: any) =>
            new Promise((resolve, reject) => {
              (window as any).bulkLockStarted = true;
              (window as any).releaseBulkOwnershipLock = () => {
                try {
                  resolve(action());
                } catch (error) {
                  reject(error);
                }
              };
            }),
          isOwned: owns,
          isHere: () => true,
          onIntentChanged: () => {},
          t: () => (_key: string, fallback: string) => fallback,
          list: (languages: string[]) => languages.join(","),
        },
        {
          page: identifier,
          source_digest: "owned-source",
          items: [{ language: "es", price: 7 }],
        },
        ["es"],
        crypto.randomUUID(),
        identifier,
      )
        .catch(() => {})
        .finally(() => ((window as any).bulkOwnershipDone = true));
    }, ARTICLE_ID);
    await expect
      .poll(() => page.evaluate(() => (window as any).bulkLockStarted))
      .toBe(true);
    await page.evaluate(async (returnToOriginal) => {
      const module = "/src/lib/stores/auth.ts",
        { authStore } = await import(module);
      let original: any;
      authStore.subscribe((value: any) => (original = value.creator))();
      authStore.hydrateFromSession({
        id: 8124,
        username: "other-account",
        tuzis: "50",
      });
      if (returnToOriginal) authStore.hydrateFromSession(original);
      (window as any).releaseBulkOwnershipLock();
    }, returnToOriginal);
    await expect
      .poll(() => page.evaluate(() => (window as any).bulkOwnershipDone))
      .toBe(true);
    expect(
      writes.filter(
        (write) =>
          write.method === "POST" && write.pathname.includes("/translate"),
      ),
    ).toHaveLength(0);
    expect(
      await page.evaluate(() =>
        Object.keys(localStorage).filter(
          (key) => key.endsWith(":bulk") || key.startsWith("f2z:intent:"),
        ),
      ),
    ).toEqual([]);
    await expect(page.locator("textarea.writing-area-textarea")).toHaveValue(
      SOURCE_CONTENT,
    );
  });
}
