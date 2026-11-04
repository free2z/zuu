import { expect, test } from "@playwright/test";
import {
  PAGE_ID,
  SOURCE_CONTENT,
  SOURCE_TITLE,
  openEditor,
  openTranslateDialog,
  pickLanguages,
  stubParallelApi,
  warmEditorOnce,
} from "./ai-translation-parallel-fixture";

/**
 * Many translations at once ( workstream D).
 *
 * Owner report: starting translation B while A ran "lost" A, clicking away
 * seemed to lose all progress, and nothing on another device knew anything
 * was running. Every test here is one of those, made impossible.
 *
 * Negative controls (run against `main` @60365b6c2 while writing these):
 * there is no "Translate…" action, no tray and no jobs store, so the first
 * click of every bulk test times out; with the editor's single slot a second
 * language replaced the first on screen; and a reload or a fresh browser
 * showed nothing running.
 */

warmEditorOnce();
test.use({ viewport: { width: 1280, height: 900 } });

test("two languages translate side by side and land independently, with no editor switch", async ({
  page,
}) => {
  const api = await stubParallelApi(page);
  await openEditor(page);
  const title = page.getByPlaceholder("Article title...");
  await expect(title).toHaveValue(SOURCE_TITLE);

  await openTranslateDialog(page);
  const dialog = await pickLanguages(page, ["es", "fr"]);
  await expect(dialog.getByTestId("translate-into-total")).toHaveText("16 2Z");
  // The confirmation names what is being bought, and says the total once
  // ( verification).
  await expect(
    dialog.getByTestId("translate-into-chosen").locator("li"),
  ).toHaveText(["Spanish", "French"]);
  await expect(dialog.getByText("16 2Z", { exact: true })).toHaveCount(1);
  await expect(dialog.getByTestId("translate-into-confirm")).toHaveText(
    "Translate 2",
  );
  await expect(dialog).not.toContainText(/credits ·\S/);
  await dialog.getByTestId("translate-into-confirm").click();

  // One request, one key, both languages.
  await expect(page.getByTestId("translate-into-dialog")).toHaveCount(0);
  await expect(page.getByTestId("translation-tray")).toBeVisible();
  const purchase = api.writes.find(
    (write) =>
      write.method === "POST" &&
      write.pathname === `/api/zpage/${PAGE_ID}/translations/`,
  );
  expect(purchase?.body?.items).toEqual([
    { language: "es", expected_price: 7 },
    { language: "fr", expected_price: 9 },
  ]);
  expect(purchase?.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);

  const tray = page.getByTestId("translation-tray");
  await expect(tray).toBeVisible();
  const spanish = tray.locator('[data-language="es"]');
  const french = tray.locator('[data-language="fr"]');
  await expect(spanish).toHaveAttribute("data-status", "translating");
  await expect(french).toHaveAttribute("data-status", "translating");

  // Spanish lands; French is untouched and still running.
  api.deliver("es");
  await expect(spanish).toHaveAttribute("data-status", "ready", {
    timeout: 10_000,
  });
  await expect(french).toHaveAttribute("data-status", "translating");
  await expect(page.getByText("Spanish is ready to review.")).toBeVisible();
  await expect(page.getByTestId("translation-tray-summary")).toHaveText(
    "1 ready to review · 1 translating",
  );

  // No automatic switch: the creator is still on the original.
  await expect(page).toHaveURL(new RegExp(`/edit\\?id=${PAGE_ID}$`));
  await expect(title).toHaveValue(SOURCE_TITLE);

  api.fail("fr", { error_detail: "The provider was unavailable." });
  await expect(french).toHaveAttribute("data-status", "failed", {
    timeout: 10_000,
  });
  await expect(french.getByTestId("translation-failure")).toContainText(
    "All 9 2Z are back in your balance",
  );
  await expect(page).toHaveURL(new RegExp(`/edit\\?id=${PAGE_ID}$`));
});

test("a refused line is named, nothing is charged, and the rest can be bought", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    refuseOnce: [{ language: "ja", code: "variant_published" }],
  });
  await openEditor(page);
  await openTranslateDialog(page);
  const dialog = await pickLanguages(page, ["es", "ja"]);
  await expect(dialog.getByTestId("translate-into-total")).toHaveText("18 2Z");
  await dialog.getByTestId("translate-into-confirm").click();

  // All or nothing: the 409 bought nothing, and says which line and why.
  // The refused line is unticked and the rest re-priced on its own.
  const japanese = dialog.locator('[data-language="ja"]');
  await expect(japanese).toContainText("is published");
  await expect(japanese.locator("input")).not.toBeChecked();
  await expect(dialog.getByTestId("translate-into-total")).toHaveText("7 2Z");
  const firstKey = api.writes.at(-1)?.headers["idempotency-key"];

  // What is left is a new decision: a fresh key.
  await dialog.getByTestId("translate-into-confirm").click();
  await expect(page.getByTestId("translate-into-dialog")).toHaveCount(0);
  await expect(page.getByTestId("translation-tray")).toBeVisible();
  const purchases = api.writes.filter(
    (write) =>
      write.method === "POST" &&
      write.pathname === `/api/zpage/${PAGE_ID}/translations/`,
  );
  expect(purchases).toHaveLength(2);
  expect(purchases[1].body?.items).toEqual([
    { language: "es", expected_price: 7 },
  ]);
  expect(purchases[1].headers["idempotency-key"]).not.toBe(firstKey);
});

test("a draft saved on another device is named as replaced, from the quote itself", async ({
  page,
}) => {
  // The editor's variants index predates the French draft; only the quote's
  // `existing_variant` knows it exists. Buying over it replaces it, so the
  // line must say so like the single-language dialog does.
  await stubParallelApi(page, { remoteDrafts: ["fr"] });
  await openEditor(page);
  await openTranslateDialog(page);
  const dialog = await pickLanguages(page, ["es", "fr"]);
  await expect(
    dialog
      .locator('[data-language="fr"]')
      .getByTestId("translate-into-replaces"),
  ).toBeVisible();
  await expect(
    dialog
      .locator('[data-language="es"]')
      .getByTestId("translate-into-replaces"),
  ).toHaveCount(0);
});

test("saving the original asks first, naming the translations it would stop", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [{ language: "es" }, { language: "fr" }],
  });
  await openEditor(page);
  await expect(
    page.getByTestId("translation-jobs-indicator"),
  ).toHaveAccessibleName("2 translating. Open the translation tray.");
  const body = page.locator("textarea.writing-area-textarea");
  await body.fill(`${SOURCE_CONTENT}\n\nOne more line.`);

  // Autosave holds off while the jobs run…
  await page.waitForTimeout(3_500);
  const sourceSaves = () =>
    api.writes.filter(
      (write) =>
        write.method === "PUT" && write.pathname === `/api/zpage/${PAGE_ID}/`,
    );
  expect(sourceSaves()).toHaveLength(0);

  // …and an explicit save names what it would stop.
  await page.keyboard.press("ControlOrMeta+s");
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText("Saving now stops running translations");
  await expect(prompt).toContainText(/Spanish and French|French and Spanish/);
  await prompt.getByRole("button", { name: "Keep editing" }).click();
  expect(sourceSaves()).toHaveLength(0);
  await expect(body).toHaveValue(`${SOURCE_CONTENT}\n\nOne more line.`);

  await page.keyboard.press("ControlOrMeta+s");
  await page.getByRole("button", { name: "Save and stop them" }).click();
  await expect.poll(() => sourceSaves().length).toBe(1);
});

test("leaving the editor keeps every job running, and coming back finds them", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [{ language: "es" }, { language: "fr" }],
  });
  await openEditor(page);
  await expect(
    page.getByTestId("translation-jobs-indicator"),
  ).toHaveAccessibleName("2 translating. Open the translation tray.");

  // A client-side navigation: the store lives above the route.
  await page.evaluate(() => {
    const link = document.createElement("a");
    link.href = "/";
    document.body.append(link);
    link.click();
  });
  await expect(page).toHaveURL(/\/$/);
  const indicator = page.getByTestId("translation-jobs-indicator");
  await expect(indicator).toHaveAccessibleName(
    "2 translating. Open the translation tray.",
  );

  // Still being watched off the editor: the delivery is announced here.
  api.deliver("es");
  await expect(page.getByText("Spanish is ready to review.")).toBeVisible({
    timeout: 10_000,
  });
  await expect(indicator).toHaveAccessibleName(
    "1 ready to review · 1 translating. Open the translation tray.",
  );

  await indicator.click();
  await expect(page).toHaveURL(new RegExp(`/edit\\?id=${PAGE_ID}$`));
  const tray = page.getByTestId("translation-tray");
  await expect(tray).toBeVisible();
  await expect(tray.locator('[data-language="es"]')).toHaveAttribute(
    "data-status",
    "ready",
  );
  await expect(tray.locator('[data-language="fr"]')).toHaveAttribute(
    "data-status",
    "translating",
  );
});

test("a fresh browser rediscovers running and finished jobs from the server", async ({
  browser,
}) => {
  // Nothing in this context's storage: everything shown comes from the list.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await stubParallelApi(page, {
    initialJobs: [
      { language: "fr" },
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
        warnings: [
          { code: "markup_dropped", detail: "A link was dropped.", items: [] },
        ],
      },
    ],
  });
  await openEditor(page);
  const indicator = page.getByTestId("translation-jobs-indicator");
  await expect(indicator).toHaveAccessibleName(
    "1 ready to review · 1 translating. Open the translation tray.",
  );
  await indicator.click();
  const tray = page.getByTestId("translation-tray");
  await expect(tray.locator('[data-language="fr"]')).toContainText(
    /Translating \d+:\d\d/,
  );
  await expect(tray.locator('[data-language="es"]')).toContainText(
    "Check 1 warnings",
  );
  await context.close();
});

test("a lost answer keeps the purchase and its key, across closing the dialog", async ({
  page,
}) => {
  // Two answers lost: the original and the dialog's own automatic replay.
  const api = await stubParallelApi(page, { loseAnswers: 2 });
  await openEditor(page);
  await openTranslateDialog(page);
  const dialog = await pickLanguages(page, ["es"]);
  await dialog.getByTestId("translate-into-confirm").click();
  await expect(dialog.getByTestId("translate-into-error")).toContainText(
    "We could not tell whether that went through",
  );

  // Closing is not abandoning: reopening offers only that same purchase.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  // Until it is settled, its languages may be running: editing the original
  // holds autosave and says why, exactly as for a known job.
  await page
    .locator("textarea.writing-area-textarea")
    .fill(`${SOURCE_CONTENT}\n\nEdited while unresolved.`);
  await expect(page.getByTestId("autosave-paused-for-jobs")).toContainText(
    "Spanish",
  );
  // …and the way out is on screen whatever the jobs list says.
  // On screen whether or not the tray is open (it covers the editor's own
  // notice on a wide screen, so it carries the same one).
  await expect(page.getByTestId("bulk-purchase-unresolved")).toBeVisible();
  await page
    .getByTestId("translation-tray-unresolved")
    .getByRole("button", { name: "Re-send purchase" })
    .click();
  await expect(
    dialog.getByRole("button", { name: "Change languages" }),
  ).toHaveCount(0);
  await dialog.getByTestId("translate-into-confirm").click();
  await expect(page.getByTestId("translate-into-dialog")).toHaveCount(0);
  await expect(page.getByTestId("translation-tray")).toBeVisible();

  const keys = api.writes
    .filter(
      (write) =>
        write.method === "POST" &&
        write.pathname === `/api/zpage/${PAGE_ID}/translations/`,
    )
    .map((write) => write.headers["idempotency-key"]);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

test("a bulk delivery into the version on screen loads it, not a blank over it", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [{ language: "es" }],
  });
  // The Spanish version is open — blank, since its translation is running.
  // (Through the picker: `?lang=es` on a fresh load also switches the UI.)
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await page.getByTestId("translation-tray-add").click();
  await page
    .getByRole("dialog")
    .getByRole("option", { name: "Spanish", exact: true })
    .first()
    .click();
  const title = page.getByPlaceholder("Article title...");
  await expect(page).toHaveURL(new RegExp(`lang=es&id=${PAGE_ID}`));
  await expect(title).toHaveValue("");
  api.deliver("es");
  await expect(title).toHaveValue(
    "Memos protegidos, explicados para quien solo quiere que funcione",
    { timeout: 10_000 },
  );
  expect(
    api.writes.filter((write) => write.pathname.endsWith("/translations/es/")),
  ).toEqual([]);
});

test("more languages than the account may start now: said plainly, nothing to buy", async ({
  page,
}) => {
  // Nine already running for this account; the cap is ten.
  await stubParallelApi(page, {
    initialJobs: ["de", "it", "nl", "pl", "sv", "fi", "da", "cs", "hu"].map(
      (language) => ({ language }),
    ),
  });
  await openEditor(page);
  await openTranslateDialog(page);
  const dialog = await pickLanguages(page, ["es", "fr"]);
  await expect(dialog.getByTestId("translate-into-capacity")).toContainText(
    "Your account can start 1 more right now (9 running).",
  );
  await expect(dialog.getByTestId("translate-into-confirm")).toBeDisabled();
});

test("a quick pick the cap cuts short says so, and a long list of languages folds", async ({
  page,
}) => {
  // Negative control ( verification, run by hand): without
  // `truncatedPick`, "10 widely read" with three already ticked silently
  // adds seven and no note appears.
  await stubParallelApi(page);
  await openEditor(page);
  await openTranslateDialog(page);
  const dialog = page.getByTestId("translate-into-dialog");
  for (const tag of ["it", "ko", "nl"])
    await dialog.locator(`label[data-language="${tag}"] input`).check();
  await dialog.getByRole("button", { name: "10 widely read" }).click();
  await expect(dialog.getByTestId("translate-into-pick-truncated")).toHaveText(
    "10 widely read: only 7 of 10 added — up to 10 languages at once.",
  );
  await expect(
    dialog.locator("label[data-language] input:checked"),
  ).toHaveCount(10);
  const chosen = dialog.getByTestId("translate-into-chosen");
  await expect(chosen.locator("li")).toHaveCount(9);
  const more = dialog.getByTestId("translate-into-chosen-more");
  await expect(more).toHaveText("+2 more");
  await more.click();
  await expect(chosen.locator("li")).toHaveCount(11);
});
