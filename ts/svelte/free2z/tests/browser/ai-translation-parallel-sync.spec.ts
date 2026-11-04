import { expect, test } from "@playwright/test";
import {
  PAGE_ID,
  SOURCE_CONTENT,
  openEditor,
  stubParallelApi,
  warmEditorOnce,
} from "./ai-translation-parallel-fixture";

/**
 * What another tab, another device, or an earlier job did to an article's
 * translations must reach this tab before it saves or publishes ( D,
 *  review).
 *
 * Negative controls, each verified by hand when written:
 * - `warningsOf` reading the LATEST job instead of the draft's record: the
 *   refunded retry hides the "$500" and Publish goes straight through.
 * - `publishAllReady` without its click-time re-read: the replaced draft's
 *   warnings are unknown and it is published in bulk.
 * - autosave without its re-read: the source PUT goes out and the job that
 *   another device started is stopped unannounced.
 */

warmEditorOnce();

const AMOUNT_WARNING = {
  code: "amount_not_in_source",
  detail: "An amount in the translation is not in the original.",
  items: ["$500"],
};

const publishWrites = (
  writes: {
    method: string;
    pathname: string;
    body: Record<string, unknown> | null;
    headers: Record<string, string>;
  }[],
  language: string,
) =>
  writes.filter(
    (write) =>
      (write.method === "PATCH" &&
        write.pathname === `/api/zpage/${PAGE_ID}/variants/${language}/`) ||
      (write.method === "PUT" &&
        write.pathname === `/api/zpage/${PAGE_ID}/translations/${language}/` &&
        write.body?.is_published === true),
  );

test("a refunded retry does not wash out the warnings of the draft it left in place", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
        warnings: [AMOUNT_WARNING],
      },
    ],
  });
  await openEditor(page);
  await expect(page.getByTestId("translation-jobs-indicator")).toBeVisible();

  // The creator re-translates Spanish; that retry fails and is refunded. The
  // flagged draft from the first job is still the Spanish draft.
  const first = api.jobs.get("es")!;
  api.jobs.set("es", {
    ...first,
    job_id: "job-es-retry",
    status: "refunded",
    refunded: first.charged,
    warnings: [],
    created_at: new Date().toISOString(),
  });
  await page.reload();
  await expect(page.getByPlaceholder("Article title...")).toBeVisible();

  // The tray says the retry failed, and still offers the saved draft.
  await page.getByTestId("translation-jobs-indicator").click();
  const row = page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]');
  await expect(row).toHaveAttribute("data-status", "failed");
  await row.getByRole("button", { name: "Open the saved draft" }).click();
  await expect(page).toHaveURL(new RegExp(`lang=es&id=${PAGE_ID}`));

  // Publish it with the editor's own button.
  await page
    .getByRole("button", { name: "Publish", exact: true })
    .first()
    .click();
  const publishNow = page.getByRole("button", { name: "Publish now" });
  if (await publishNow.isVisible().catch(() => false)) await publishNow.click();

  const prompt = page.getByRole("dialog", { name: /Publish Spanish/ });
  await expect(prompt).toContainText("Publish Spanish with 1 warnings?");
  await expect(prompt).toContainText("$500");
  await prompt.getByRole("button", { name: "Not yet" }).click();
  await expect(prompt).toHaveCount(0);
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
});

test("Publish all ready re-reads at click time: a draft replaced elsewhere with warnings is left out", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
      {
        language: "de",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await expect(page.getByTestId("translation-tray")).toBeVisible();

  // Meanwhile, on another device: Spanish re-translated, and the new draft
  // came back flagged. This tab has not polled since.
  const es = api.jobs.get("es")!;
  api.jobs.set("es", {
    ...es,
    job_id: "job-es-elsewhere",
    created_at: new Date().toISOString(),
    warnings: [AMOUNT_WARNING],
  });
  api.drafts.set("es", {
    published: false,
    jobId: "job-es-elsewhere",
    warnings: [AMOUNT_WARNING],
    revision: '"es-elsewhere-etag"',
  });

  await page.getByTestId("translation-tray-publish-all").click();
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText(
    "Left out for individual review: Spanish.",
  );
  await prompt.getByRole("button", { name: "Publish them" }).click();
  await expect(page.getByText("Translations published: 1.")).toBeVisible();
  expect(publishWrites(api.writes, "de")).toHaveLength(1);
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
});

test("autosave asks the server first: a job started on another device holds it", async ({
  page,
}) => {
  const api = await stubParallelApi(page);
  await openEditor(page);
  const sourceSaves = () =>
    api.writes.filter(
      (write) =>
        write.method === "PUT" && write.pathname === `/api/zpage/${PAGE_ID}/`,
    );

  // Another device starts a Spanish translation of the saved text. This tab
  // has no idea yet.
  api.jobs.set("es", {
    language: "es",
    job_id: "job-es-other-device",
    status: "queued",
    price: 7,
    charged: "7",
    refunded: "0",
    error: null,
    created_at: new Date().toISOString(),
    settled_at: null,
    zpage_id: 2348,
    variant: null,
  });

  // Typing in the original would stop it on the next autosave — so the
  // autosave asks first, finds the job, and holds: no PUT of the original.
  await page
    .locator("textarea.writing-area-textarea")
    .fill(`${SOURCE_CONTENT}\n\nOne more line.`);
  await page.waitForTimeout(4_500);
  expect(sourceSaves()).toHaveLength(0);
  await expect(
    page.getByTestId("translation-jobs-indicator"),
  ).toHaveAccessibleName("1 translating. Open the translation tray.");
});

test("editing a translation draft asks the server first too: a job into that language started elsewhere holds it", async ({
  page,
}) => {
  // Negative control ( verification, run by hand): with the re-read
  // limited to the original again (`saveMayStopUnseenJobs` returning false
  // for a translation), the Spanish draft PUT goes out and the job another
  // device bought into Spanish is stopped as `variant_changed`, unasked.
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Review" })
    .click();
  await expect(page).toHaveURL(new RegExp(`lang=es&id=${PAGE_ID}`));
  const spanishSaves = () =>
    api.writes.filter(
      (write) =>
        (write.method === "PUT" || write.method === "PATCH") &&
        write.pathname.endsWith("/es/"),
    );

  // Another device buys a Spanish replacement; this tab has not heard.
  api.jobs.set("es", {
    ...api.jobs.get("es")!,
    job_id: "job-es-other-device",
    status: "queued",
    created_at: new Date().toISOString(),
  });
  await page
    .locator("textarea.writing-area-textarea")
    .fill("# Memos\n\nEditado a mano.");
  await page.waitForTimeout(4_500);
  expect(spanishSaves()).toHaveLength(0);
  await expect(page.getByTestId("autosave-paused-for-jobs")).toContainText(
    "Spanish",
  );
});

const runningElsewhere = (language: string) => ({
  language,
  job_id: `job-${language}-elsewhere`,
  status: "queued",
  price: 7,
  charged: "7",
  refunded: "0",
  error: null,
  created_at: new Date().toISOString(),
  settled_at: null,
  zpage_id: 2348,
  variant: null,
});

test("Publish all leaves out a draft replaced while it was asking", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: ["es", "de"].map((language) => ({
      language,
      status: "delivered",
      variant: { is_published: false, is_stale: false },
    })),
  });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await page.getByTestId("translation-tray-publish-all").click();
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText(/German and Spanish|Spanish and German/);

  // While the question is open, another device re-translates Spanish. The
  // new draft is clean — but it is not the one that was listed.
  const es = api.jobs.get("es")!;
  api.jobs.set("es", {
    ...es,
    job_id: "job-es-while-asking",
    created_at: new Date().toISOString(),
  });
  api.drafts.set("es", {
    published: false,
    jobId: "job-es-while-asking",
    warnings: [],
    revision: '"es-while-asking-etag"',
  });
  await prompt.getByRole("button", { name: "Publish them" }).click();
  await expect(page.getByText("Translations published: 1.")).toBeVisible();
  expect(publishWrites(api.writes, "de")).toHaveLength(1);
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
});

test("publication carries the reviewed validator through a replacement after the final listing", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        warnings: [AMOUNT_WARNING],
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  await openEditor(page);
  const reviewedRevision = api.drafts.get("es")!.revision;
  api.replaceOnNextPublish("es", '"replacement-after-listing"');

  await page.getByTestId("translation-jobs-indicator").click();
  await page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Review", exact: true })
    .click();
  await page.getByTestId("translation-review-publish").click();
  const prompt = page.getByRole("dialog", { name: /Publish Spanish/ });
  await expect(prompt).toContainText("Publish Spanish with 1 warnings?");
  await prompt.getByRole("button", { name: "I checked them, publish" }).click();

  await expect.poll(() => publishWrites(api.writes, "es").length).toBe(1);
  const writes = publishWrites(api.writes, "es");
  expect(writes).toHaveLength(1);
  expect(writes[0].headers["if-match"]).toBe(reviewedRevision);
  expect(api.drafts.get("es")!.published).toBe(false);
});

test("bulk publication of the open translation keeps its approved revision", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: ["es", "de"].map((language) => ({
      language,
      status: "delivered",
      variant: { is_published: false, is_stale: false },
    })),
  });
  await openEditor(page, "es");
  const reviewedRevision = api.drafts.get("es")!.revision;
  api.replaceOnNextPublish("es", '"bulk-open-replacement"');

  await page.getByTestId("translation-jobs-indicator").click();
  await expect(page.getByTestId("translation-tray")).toBeVisible();
  await page.getByTestId("translation-tray-publish-all").click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Publish them" })
    .click();

  await expect.poll(() => publishWrites(api.writes, "es").length).toBe(1);
  await expect.poll(() => publishWrites(api.writes, "de").length).toBe(1);
  const writes = publishWrites(api.writes, "es");
  expect(writes).toHaveLength(1);
  expect(writes[0].headers["if-match"]).toBe(reviewedRevision);
  expect(api.drafts.get("es")!.published).toBe(false);
  expect(api.drafts.get("de")!.published).toBe(true);
});

test("missing draft revisions fail closed before publication", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  api.drafts.get("es")!.revision = "";
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Publish", exact: true })
    .click();

  await expect(
    page.getByText(/Could not check the Spanish translation/),
  ).toBeVisible();
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
});

test("when the jobs list cannot be read, nothing is published or saved over it silently", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await expect(page.getByTestId("translation-tray")).toBeVisible();
  // From here on the list answers 500.
  await page.route(`**/api/zpage/${PAGE_ID}/translations/`, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ status: 500, json: { detail: "boom" } })
      : route.fallback(),
  );

  await page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Publish", exact: true })
    .click();
  await expect(
    page.getByText(
      "Could not check the Spanish translation just now, so it was not published. Try again.",
    ),
  ).toBeVisible();
  expect(publishWrites(api.writes, "es")).toHaveLength(0);

  // An explicit save of the original asks rather than saving blind.
  await page.getByTestId("translation-tray").getByLabel("Close").click();
  await page
    .locator("textarea.writing-area-textarea")
    .fill(`${SOURCE_CONTENT}\n\nEdited while the list is down.`);
  await page.keyboard.press("ControlOrMeta+s");
  const ask = page.getByRole("dialog", {
    name: "Could not check for running translations",
  });
  await expect(ask).toBeVisible();
  await ask.getByRole("button", { name: "Keep editing" }).click();
  expect(
    api.writes.filter(
      (write) =>
        write.method === "PUT" && write.pathname === `/api/zpage/${PAGE_ID}/`,
    ),
  ).toHaveLength(0);
});

test("a fresh device: a draft left by a refunded retry is not assumed clean", async ({
  page,
}) => {
  // This browser never saw the delivery that wrote the Spanish draft; the
  // list only has the newest job, which failed.
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "es",
        status: "refunded",
        refunded: "7",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  api.drafts.set("es", { published: false });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  const row = page
    .getByTestId("translation-tray")
    .locator('[data-language="es"]');
  await row.getByRole("button", { name: "Open the saved draft" }).click();
  await expect(page).toHaveURL(new RegExp(`lang=es&id=${PAGE_ID}`));
  await page
    .getByRole("button", { name: "Publish", exact: true })
    .first()
    .click();
  const publishNow = page.getByRole("button", { name: "Publish now" });
  if (await publishNow.isVisible().catch(() => false)) await publishNow.click();
  const prompt = page.getByRole("dialog", { name: /Publish Spanish/ });
  await expect(prompt).toContainText(
    "Publish Spanish without a translation check?",
  );
  await prompt.getByRole("button", { name: "Not yet" }).click();
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
});

test("Publish all leaves unknown-provenance drafts out until individual review", async ({
  page,
}) => {
  const api = await stubParallelApi(page, {
    initialJobs: [
      {
        language: "de",
        status: "delivered",
        variant: { is_published: false, is_stale: false },
      },
    ],
  });
  api.drafts.set("es", { published: false });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  await expect(page.getByTestId("translation-tray-publish-all")).toHaveText(
    "Publish all ready (2)",
  );
  await page.getByTestId("translation-tray-publish-all").click();
  const prompt = page.getByRole("dialog");
  await expect(prompt).toContainText(
    "Left out for individual review: Spanish.",
  );
  await prompt.getByRole("button", { name: "Publish them" }).click();
  await expect(page.getByText("Translations published: 1.")).toBeVisible();
  expect(publishWrites(api.writes, "es")).toHaveLength(0);
  expect(publishWrites(api.writes, "de")).toHaveLength(1);
});

test("hiding the tab asks the server first too: no flush over a job started elsewhere", async ({
  page,
}) => {
  const api = await stubParallelApi(page);
  await openEditor(page);
  api.jobs.set("es", runningElsewhere("es"));
  await page
    .locator("textarea.writing-area-textarea")
    .fill(`${SOURCE_CONTENT}\n\nThen the tab is hidden.`);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1_500);
  expect(
    api.writes.filter(
      (write) =>
        write.method === "PUT" && write.pathname === `/api/zpage/${PAGE_ID}/`,
    ),
  ).toHaveLength(0);
});
