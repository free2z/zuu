import { expect, test, type Page } from "@playwright/test";
import {
  OWNER,
  PAGE_ID,
  SOURCE_CONTENT,
  SOURCE_TITLE,
  openEditor,
  stubParallelApi,
  warmEditorOnce,
} from "./ai-translation-parallel-fixture";

/**
 * Review and publish N translations in any order ( workstream D).
 *
 * Negative control (main @60365b6c2): there is no tray, no Publish anywhere
 * in the Translations panel and no side-by-side, so the first tray assertion
 * of each test fails.
 */

warmEditorOnce();

const delivered = (language: string, extra = {}) => ({
  language,
  status: "delivered",
  variant: { is_published: false, is_stale: false },
  ...extra,
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("a replacement during warning confirmation is never published", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [
        delivered("es", {
          warnings: [
            {
              code: "amount_not_in_source",
              detail: "An amount in the translation is not in the original.",
              items: ["$500"],
            },
          ],
        }),
      ],
    });
    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    await page
      .getByTestId("translation-tray")
      .locator('[data-language="es"]')
      .getByRole("button", { name: "Review" })
      .click();
    await page.getByTestId("translation-review-publish").click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toContainText("Publish Spanish with 1 warnings?");

    // Simulate another device replacing the saved draft while the creator is
    // deciding. The next jobs read must notice both changed provenance and
    // revision before any publish request is sent.
    const replacement = api.drafts.get("es")!;
    replacement.jobId = "remote-job-replacement";
    replacement.warnings = [];
    replacement.revision = '"es-replacement-etag"';
    await prompt
      .getByRole("button", { name: "I checked them, publish" })
      .click();
    await expect(
      page.getByText(/was replaced while you were deciding/),
    ).toBeVisible();
    expect(
      api.writes.filter(
        (write) =>
          write.method === "PATCH" &&
          write.pathname === `/api/zpage/${PAGE_ID}/variants/es/`,
      ),
    ).toHaveLength(0);
  });

  test("an unmatched manual draft shows prior warnings in the review and prompt", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [delivered("es")],
    });
    // The saved text no longer matches any delivered output, so its warning
    // provenance is intentionally unknown on this device.
    const manualDraft = api.drafts.get("es")!;
    manualDraft.jobId = null;
    manualDraft.warnings = [];
    manualDraft.priorWarnings = [
      { code: "amount_not_in_source", detail: "$500", items: ["$500"] },
    ];
    manualDraft.revision = '"es-manual-etag"';

    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    await page
      .getByTestId("translation-tray")
      .locator('[data-language="es"]')
      .getByRole("button", { name: "Review", exact: true })
      .click();
    await expect(
      page.getByTestId("translation-review-prior-warnings"),
    ).toContainText("$500");
    await page.getByTestId("translation-review-publish").click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toContainText(
      "Publish Spanish without a translation check?",
    );
    await expect(prompt).toContainText("previous delivery check flagged");
    await expect(prompt).toContainText("$500");
    expect(api.writes.some((write) => write.body?.is_published === true)).toBe(
      false,
    );
  });

  test("an edited translation is saved before its warning review revision is issued", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [delivered("es")],
    });
    await openEditor(page, "es");
    const text = page.locator("textarea.writing-area-textarea");
    await text.fill("# Edición manual\n\nTexto editado antes de revisar.");
    await clickEditorPublish(page);

    const prompt = page.getByRole("dialog", {
      name: "Publish Spanish without a translation check?",
    });
    await expect(prompt).toContainText(
      "Publish Spanish without a translation check?",
    );
    const saves = api.writes.filter(
      (write) =>
        write.method === "PUT" &&
        write.pathname === `/api/zpage/${PAGE_ID}/translations/es/`,
    );
    expect(saves).toHaveLength(1);
    expect(saves[0].body?.content).toContain("Texto editado antes de revisar.");
    expect(saves[0].body?.is_published).toBe(false);
    expect(saves[0].headers["if-match"]).toBe('"es-etag"');
    expect(api.drafts.get("es")?.revision).toBe('"es-etag-2"');
  });

  test("publish in any order: one from the tray, the rest through the review loop", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [
        delivered("es", {
          warnings: [
            {
              code: "markup_dropped",
              detail: "A link in the original was not carried over.",
              items: ["https://example.test/memo"],
            },
          ],
        }),
        delivered("fr"),
        delivered("ja"),
      ],
    });
    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    const tray = page.getByTestId("translation-tray");
    await expect(page.getByTestId("translation-tray-summary")).toHaveText(
      "3 ready to review",
    );

    // French first, straight from the tray: read, then conditionally write.
    await tray
      .locator('[data-language="fr"]')
      .getByRole("button", { name: "Publish", exact: true })
      .click();
    await expect(tray.locator('[data-language="fr"]')).toHaveAttribute(
      "data-status",
      "published",
    );
    const patch = api.writes.find(
      (write) =>
        write.method === "PATCH" &&
        write.pathname === `/api/zpage/${PAGE_ID}/variants/fr/`,
    );
    expect(patch?.body).toEqual({ is_published: true });
    expect(patch?.headers["if-match"]).toBe('"fr-etag"');

    // Then Japanese, through Review: side by side with the original.
    await tray
      .locator('[data-language="ja"]')
      .getByRole("button", { name: "Review" })
      .click();
    await expect(page).toHaveURL(new RegExp(`lang=ja&id=${PAGE_ID}`));
    const bar = page.getByTestId("translation-review-bar");
    await expect(bar).toContainText("Reviewing Japanese");
    await expect(bar).toContainText("1 of 2");
    await expect(page.getByTestId("translation-review-source")).toContainText(
      SOURCE_TITLE,
    );
    await expect(page.getByPlaceholder("Article title...")).toHaveValue(
      "シールドされたメモの説明",
    );

    // `p` (when focus is not in something you type into) never publishes by
    // itself: it opens a confirmation, and nothing is written until it is
    // confirmed. Then the loop advances to the next ready language.
    await bar.click({ position: { x: 4, y: 4 } });
    await page.keyboard.press("p");
    const ask = page.getByRole("dialog");
    await expect(ask).toContainText("Publish Japanese?");
    expect(
      api.writes.filter(
        (write) =>
          write.method === "PUT" &&
          write.pathname === `/api/zpage/${PAGE_ID}/translations/ja/`,
      ),
    ).toHaveLength(0);
    await ask.getByRole("button", { name: "Publish", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`lang=es&id=${PAGE_ID}`));
    await expect(bar).toContainText("Reviewing Spanish");
    const japaneseSave = api.writes.find(
      (write) =>
        write.method === "PUT" &&
        write.pathname === `/api/zpage/${PAGE_ID}/translations/ja/`,
    );
    expect(japaneseSave?.body?.is_published).toBe(true);

    // The  warnings are on screen for the one being reviewed.
    const strip = page.getByTestId("translation-review-warnings");
    await expect(strip).toContainText("Check 1 warnings");
    await strip.getByRole("button").click();
    await expect(strip).toContainText(
      "A link in the original was not carried over.",
    );
    await page.getByTestId("translation-review-publish").click();
    // A warned draft asks once before it goes live.
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "I checked them, publish" })
      .click();
    await expect(
      page.getByText("Every ready translation is published."),
    ).toBeVisible();
    await expect(bar).toHaveCount(0);
  });

  test("warnings from the check are impossible to miss: chip, list, one confirmation, never in bulk", async ({
    page,
  }) => {
    //  delivers a draft the check flagged instead of refunding it. A
    // creator who cannot read Spanish must not publish "$500" for "$5"
    // without being told, by name, at every way to publish it.
    const api = await stubParallelApi(page, {
      initialJobs: [
        delivered("es", {
          warnings: [
            {
              code: "amount_not_in_source",
              detail: "An amount in the translation is not in the original.",
              items: ["$500"],
            },
            {
              code: "code_identifier_not_preserved",
              detail: "A code identifier was translated.",
              items: ["useState"],
            },
          ],
        }),
        delivered("de"),
      ],
    });
    const publishes = (language: string) =>
      api.writes.filter(
        (write) =>
          (write.method === "PATCH" &&
            write.pathname === `/api/zpage/${PAGE_ID}/variants/${language}/`) ||
          (write.method === "PUT" &&
            write.pathname ===
              `/api/zpage/${PAGE_ID}/translations/${language}/` &&
            write.body?.is_published === true),
      );
    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    const tray = page.getByTestId("translation-tray");

    // 1. The flagged row looks different — an amber "Check 2 warnings"
    //    chip, not "Ready to review" — and offers Review only, no Publish.
    const spanishRow = tray.locator('[data-language="es"]');
    await expect(spanishRow).toHaveAttribute("data-status", "flagged");
    await expect(
      spanishRow.getByTestId("translation-tray-warnings"),
    ).toHaveText("Check 2 warnings");
    await expect(
      spanishRow.getByRole("button", { name: "Publish", exact: true }),
    ).toHaveCount(0);
    // "Publish all ready (n)" counts only the clean ones.
    await expect(page.getByTestId("translation-tray-publish-all")).toHaveText(
      "Publish all ready (1)",
    );
    await expect(
      tray
        .locator('[data-language="de"]')
        .getByTestId("translation-tray-warnings"),
    ).toHaveCount(0);

    // 2. Publish all ready never takes the warned one, and says so.
    await page.getByTestId("translation-tray-publish-all").click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toContainText("German go live now");
    await expect(prompt).toContainText(
      "Left out for individual review: Spanish.",
    );
    await prompt.getByRole("button", { name: "Publish them" }).click();
    await expect(page.getByText("Translations published: 1.")).toBeVisible();
    expect(publishes("de")).toHaveLength(1);
    expect(publishes("es")).toHaveLength(0);

    // 4. Review lists every warning with its items, above the text.
    if (!(await tray.isVisible()))
      await page.getByTestId("translation-jobs-indicator").click();
    await tray
      .locator('[data-language="es"]')
      .getByRole("button", { name: "Review" })
      .click();
    const warnings = page.getByTestId("translation-review-warnings");
    // A compact strip: the count and every flagged item at a glance…
    await expect(warnings).toContainText("Check 2 warnings");
    await expect(
      page.getByTestId("translation-review-warning-item"),
    ).toHaveText(["$500", "useState"]);
    // …whose whole header row expands it, to say what each one is.
    const toggle = page.getByTestId("translation-review-warnings-toggle");
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toContainText("Details");
    await warnings.getByText("Check 2 warnings").click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(
      warnings.locator('[data-code="amount_not_in_source"]'),
    ).toContainText("Amounts or prices that are not in the original");
    await expect(
      page.getByTestId("translation-review-warning-item"),
    ).toHaveText(["$500", "useState"]);
    const inline = page.getByTestId("translation-review-inline-highlights");
    await inline.getByRole("button").click();
    const excerpts = page.getByTestId("translation-review-inline-match");
    await expect(excerpts).toHaveCount(2);
    await expect(excerpts.nth(0).locator("mark")).toHaveText("$500");
    await expect(excerpts.nth(1).locator("mark")).toHaveText("useState");

    // 5. Review's Publish asks once; declining publishes nothing, confirming
    //    publishes exactly once.
    await page.getByTestId("translation-review-publish").click();
    await expect(prompt).toContainText("Publish Spanish with 2 warnings?");
    await expect(prompt).toContainText(
      "Amounts or prices that are not in the original — check every number: $500",
    );
    await expect(prompt).toContainText("useState");
    await prompt.getByRole("button", { name: "Not yet" }).click();
    await expect(prompt).toHaveCount(0);
    expect(publishes("es")).toHaveLength(0);
    await page.getByTestId("translation-review-publish").click();
    await prompt
      .getByRole("button", { name: "I checked them, publish" })
      .click();
    await expect(
      page.getByText("Every ready translation is published."),
    ).toBeVisible();
    expect(publishes("es")).toHaveLength(1);
    expect(publishes("es")[0].headers["if-match"]).toBe('"es-etag"');
  });

  test("Publish all ready lists what it will publish before it does", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [delivered("es"), delivered("de")],
    });
    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    await page.getByTestId("translation-tray-publish-all").click();
    const prompt = page.getByRole("dialog");
    await expect(prompt).toContainText(/German and Spanish|Spanish and German/);
    await prompt.getByRole("button", { name: "Publish them" }).click();
    await expect(page.getByText("Translations published: 2.")).toBeVisible();
    expect(
      api.writes
        .filter((write) => write.method === "PATCH")
        .map((write) => write.pathname)
        .sort(),
    ).toEqual([
      `/api/zpage/${PAGE_ID}/variants/de/`,
      `/api/zpage/${PAGE_ID}/variants/es/`,
    ]);
  });
});

test("a failed translation stays reachable when nothing else is happening", async ({
  page,
}) => {
  // Nothing running, nothing ready: only a refunded French job. The one
  // Translations entry point still says so, and Retry and "See what the AI
  // wrote" are a press away ( review).
  await stubParallelApi(page, {
    initialJobs: [
      {
        language: "fr",
        status: "refunded",
        refunded: "9",
        error: "wrong_script",
        attempted_output_preview: "Mémos protégés…",
      },
    ],
  });
  await openEditor(page);
  const indicator = page.getByTestId("translation-jobs-indicator");
  await expect(indicator).toHaveAccessibleName(
    "1 need attention. Open the translation tray.",
  );
  await indicator.click();
  const row = page
    .getByTestId("translation-tray")
    .locator('[data-language="fr"]');
  await expect(row).toHaveAttribute("data-status", "failed");
  await expect(row.getByTestId("translation-failure")).toHaveText(
    "All 9 2Z are back in your balance.",
  );
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
  const attempt = row.getByRole("button", { name: "See what the AI wrote" });
  expect((await attempt.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(40);
  await attempt.click();
  await expect(row.locator("pre")).toHaveText("Mémos protégés…");
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByTestId("translate-into-dialog")).toBeVisible();
  await expect(page.locator('label[data-language="fr"] input')).toBeChecked();
});

test("mobile: the tray rises from the bottom, full width, with real touch targets", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await stubParallelApi(page, {
    initialJobs: [
      { language: "fr" },
      delivered("es"),
      delivered("ja"),
      {
        language: "de",
        status: "refunded",
        attempted_output_preview: "Geschützte Memos…",
      },
    ],
  });
  await openEditor(page);
  await page.getByTestId("translation-jobs-indicator").click();
  const tray = page.getByTestId("translation-tray");
  await expect(tray).toBeVisible();

  const box = await tray.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.round(box!.x)).toBe(0);
  expect(Math.round(box!.width)).toBe(390);
  expect(Math.round(box!.y + box!.height)).toBe(844);

  // No sideways scroll anywhere on the page.
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  for (const button of await tray.getByRole("button").all()) {
    if (!(await button.isVisible())) continue;
    const size = await button.boundingBox();
    // The text-style "See what the AI wrote" toggle is the one exception: it
    // sits inside the failure sentence it belongs to.
    const text = (await button.textContent()) ?? "";
    if (text.includes("AI wrote")) continue;
    expect(size!.height, text).toBeGreaterThanOrEqual(40);
  }

  // The failed row explains itself and keeps what the AI produced.
  const german = tray.locator('[data-language="de"]');
  await expect(german).toContainText("All 8 2Z are back in your balance");
  await german.getByRole("button", { name: "See what the AI wrote" }).click();
  await expect(german).toContainText("Geschützte Memos…");

  // Escape closes it; the editor underneath was usable the whole time.
  await tray.press("Escape");
  await expect(tray).toHaveCount(0);

  // The review bar keeps Previous / Next / Publish / Done on ONE row, each a
  // 40px target, right above the writing surface ( verification).
  await page.getByTestId("translation-jobs-indicator").click();
  await tray
    .locator('[data-language="es"]')
    .getByRole("button", { name: "Review" })
    .click();
  const bar = page.getByTestId("translation-review-bar");
  await expect(bar).toContainText("Reviewing Spanish");
  const controls = bar.getByTestId("translation-review-controls");
  const boxes = [];
  for (const name of ["Previous", "Next", "Publish", "Done"]) {
    const box = await controls
      .getByRole("button", { name, exact: true })
      .boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.height, name).toBeGreaterThanOrEqual(40);
    expect(box!.width, name).toBeGreaterThanOrEqual(40);
    boxes.push(box!);
  }
  for (const box of boxes) expect(Math.abs(box.y - boxes[0].y)).toBeLessThan(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
});

/*
 * Verification round. Negative controls, each run by hand when
 * written, each tree still compiling:
 * - Previous / Next / Done / `j` not disabled while publishing: Next during
 *   the slow check opens French, and the first test's "Checking…" and
 *   disabled-Next assertions fail (with the target capture still in place,
 *   Spanish is then not published either).
 * - `handlePublishNow` asking `confirmDespiteWarnings` for every publish
 *   again: the brand-new article's publish does nothing and no POST is
 *   published; the original's publish waits on the hung jobs list.
 */
const publishWritesOf = (
  writes: {
    method: string;
    pathname: string;
    body: Record<string, unknown> | null;
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

test.describe("verification round", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Publish, then Next while the check is slow: the bar waits, and only the language clicked is published", async ({
    page,
  }) => {
    const api = await stubParallelApi(page, {
      initialJobs: [delivered("es"), delivered("fr")],
    });
    await openEditor(page);
    await page.getByTestId("translation-jobs-indicator").click();
    await page
      .getByTestId("translation-tray")
      .locator('[data-language="fr"]')
      .getByRole("button", { name: "Review" })
      .click();
    const bar = page.getByTestId("translation-review-bar");
    await expect(bar).toContainText("Reviewing French");

    // No dead band between the review bar and the side-by-side.
    const gap = await bar.evaluate((node) => {
      const header = node.parentElement!;
      return (
        header.getBoundingClientRect().bottom -
        node.getBoundingClientRect().bottom
      );
    });
    expect(gap).toBeLessThanOrEqual(12);

    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/zpage/${PAGE_ID}/translations/`, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.fallback().catch(() => {});
    });
    const publish = page.getByTestId("translation-review-publish");
    await publish.click();
    // Only checking — not "Publishing…" — and nothing moves meanwhile.
    await expect(publish).toHaveText("Checking…");
    await expect(
      bar.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await expect(
      bar.getByRole("button", { name: "Previous", exact: true }),
    ).toBeDisabled();
    await expect(
      bar.getByRole("button", { name: "Done", exact: true }),
    ).toBeDisabled();
    await page.locator("body").press("j");
    await expect(bar).toContainText("Reviewing French");

    release();
    await expect.poll(() => publishWritesOf(api.writes, "fr").length).toBe(1);
    // On to the next one — which is NOT published by the same click.
    await expect(bar).toContainText("Reviewing Spanish");
    await expect(publish).toHaveText("Publish");
    expect(publishWritesOf(api.writes, "es")).toHaveLength(0);
  });

  test("a brand-new article published before its first autosave goes live, created as published", async ({
    page,
  }) => {
    await stubParallelApi(page);
    const posts: Record<string, unknown>[] = [];
    await page.route(
      (url) => url.pathname === "/api/zpage/",
      async (route) => {
        const request = route.request();
        if (request.method() !== "POST") return route.fallback();
        const body = JSON.parse(request.postData() || "{}");
        posts.push(body);
        await route.fulfill({
          status: 201,
          json: {
            id: 99,
            free2zaddr: "brand-new-article",
            vanity: "",
            title: body.title,
            description: "",
            canonical_url: "",
            content: body.content ?? "",
            tags: [],
            p2paddr: "",
            featured_image: null,
            is_published: Boolean(body.is_published),
            is_subscriber_only: false,
            publish_at: null,
            creator: OWNER,
            source_language: "en",
            actual_language: "en",
            requested_language: "en",
            available_languages: ["en"],
            variant_is_published: Boolean(body.is_published),
            created_at: "2026-10-01T00:00:00Z",
            updated_at: "2026-10-01T00:00:00Z",
          },
        });
      },
    );
    await page.goto("/edit");
    const title = page.getByPlaceholder("Article title...");
    await expect(title).toBeVisible();
    await title.fill("A brand new article");
    await page
      .locator("textarea.writing-area-textarea")
      .fill("Body text here.");
    // At once — well inside the autosave delay.
    await clickEditorPublish(page);
    await expect(page.getByText("Article published.")).toBeVisible();
    expect(posts.map((post) => post.is_published)).toEqual([true]);
  });

  test("publishing the original never waits on the translation jobs list", async ({
    page,
  }) => {
    await stubParallelApi(page);
    const sourceWrites = await unpublishedSource(page);
    await openEditor(page);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(`**/api/zpage/${PAGE_ID}/translations/`, async (route) => {
      if (route.request().method() === "GET") await held;
      await route.fallback().catch(() => {});
    });
    await clickEditorPublish(page);
    // Well under the 8s the translation check would wait for.
    await expect(page.getByText("Article published.")).toBeVisible({
      timeout: 4_000,
    });
    expect(sourceWrites.map((write) => write.is_published)).toEqual([true]);
    await expect(page.getByText(/Could not check/)).toHaveCount(0);
    release();
  });
});

async function unpublishedSource(page: Page) {
  const writes: Record<string, unknown>[] = [];
  await page.route(
    (url) =>
      url.pathname === `/api/zpage/${PAGE_ID}/` &&
      !url.searchParams.get("lang"),
    async (route) => {
      const request = route.request();
      const body =
        request.method() === "GET"
          ? {}
          : JSON.parse(request.postData() || "{}");
      if (request.method() !== "GET") writes.push(body);
      await route.fulfill({
        json: {
          id: 2348,
          free2zaddr: PAGE_ID,
          vanity: PAGE_ID,
          title: SOURCE_TITLE,
          description: "",
          canonical_url: "",
          content: SOURCE_CONTENT,
          tags: [],
          category: "TECHNOLOGY",
          is_published: false,
          variant_is_published: false,
          is_subscriber_only: false,
          publish_at: null,
          p2paddr: "",
          creator: OWNER,
          source_language: "en",
          requested_language: "en",
          actual_language: "en",
          fallback_used: false,
          available_languages: ["en"],
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
          published_at: null,
          ...body,
        },
        headers: { ETag: '"en-etag"' },
      });
    },
  );
  return writes;
}

async function clickEditorPublish(page: Page) {
  await page
    .getByRole("button", { name: "Publish", exact: true })
    .first()
    .click();
  const now = page.getByRole("button", { name: "Publish now" });
  if (await now.isVisible().catch(() => false)) await now.click();
}
