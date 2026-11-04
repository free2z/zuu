import { expect, test, type Page } from "@playwright/test";

/**
 * Shared fixture for the AI translation delivery specs. Split out of
 * `editor-ai-translation-delivery.spec.ts` because a file is the atom of
 * browser sharding and that one file was most of shard 2's 12-minute budget
 * ( tipped it over). Not a spec: nothing here runs on its own.
 */

export const CREATOR = {
  id: 1230,
  username: "translation-delivery-owner",
  full_name: "Translation Delivery Owner",
};

export const ARTICLE_ID = "ai-delivery-fixture";
export const SOURCE_TITLE =
  "How a shielded payment memo becomes a credit on your Free2Z balance, end to end";
export const SOURCE_DESCRIPTION =
  "A production-shaped source subtitle with enough context to prove the editor did not keep its old metadata.";
export const SOURCE_CONTENT = [
  "# The source article",
  "",
  "A long source paragraph explains why the original fields must not survive a language switch.",
  "",
  "- sender privacy",
  "- receiver privacy",
].join("\n");

export const TARGET_TITLE =
  "Cómo un memo de pago protegido se convierte en crédito en tu saldo de Free2Z";
export const TARGET_DESCRIPTION =
  "La descripción traducida llega desde el borrador de IA, no desde el artículo original.";
export const TARGET_CONTENT = [
  "# El artículo traducido",
  "",
  "Este cuerpo traducido es deliberadamente distinto y tiene una forma realista para detectar una hidratación incompleta.",
  "",
  "- privacidad del remitente",
  "- privacidad del destinatario",
].join("\n");

/**
 * The row's purchase button.
 *
 * A row the AI has already translated says "Translate again" rather than
 * "Translate with AI"  — re-translating after editing the original is a
 * real action, but offering it as a first purchase on a row badged "AI" invited
 * the creator to buy what they had just bought. Tests here click the button
 * before AND after a delivery, so they match on the verb. The exact labels are
 * pinned in `tests/editor-translation-manager.test.mjs`.
 */
export const TRANSLATE_WITH_AI = /^Translate (with AI|again)$/;

type SentWrite = {
  pathname: string;
  method: string;
  ifMatch?: string;
  body: Record<string, unknown> | null;
};

export function pageVariant({
  language,
  title,
  description,
  content,
  isPublished,
  updatedAt,
}: {
  language: string;
  title: string;
  description: string;
  content: string;
  isPublished: boolean;
  updatedAt: string;
}) {
  return {
    id: 1230,
    free2zaddr: ARTICLE_ID,
    vanity: ARTICLE_ID,
    title,
    description,
    canonical_url: "https://example.test/article",
    content,
    tags: ["privacy", "source"],
    category: "TECHNOLOGY",
    is_published: isPublished,
    variant_is_published: isPublished,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "u-source-address",
    creator: CREATOR,
    source_language: "en",
    requested_language: language,
    actual_language: language,
    fallback_used: false,
    available_languages: ["en", "es"],
    created_at: "2026-08-20T00:00:00Z",
    updated_at: updatedAt,
    published_at: isPublished ? "2026-08-20T00:00:00Z" : null,
  };
}

export const SOURCE = pageVariant({
  language: "en",
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  content: SOURCE_CONTENT,
  isPublished: true,
  updatedAt: "2026-08-20T00:00:00Z",
});

export const TARGET_DRAFT = pageVariant({
  language: "es",
  title: "Existing Spanish draft that the purchase replaces",
  description: "An older draft description.",
  content: "An older Spanish draft body.",
  isPublished: false,
  updatedAt: "2026-08-20T00:01:00Z",
});

export const TARGET_DELIVERED = pageVariant({
  language: "es",
  title: TARGET_TITLE,
  description: TARGET_DESCRIPTION,
  content: TARGET_CONTENT,
  isPublished: false,
  updatedAt: "2026-08-20T00:02:00Z",
});

export const sourceVariant = {
  language: "en",
  origin: "source",
  is_published: true,
  is_stale: false,
  title: SOURCE_TITLE,
  description: SOURCE_DESCRIPTION,
  updated_at: SOURCE.updated_at,
};

export function translationVariant(delivered: boolean) {
  const target = delivered ? TARGET_DELIVERED : TARGET_DRAFT;
  return {
    language: "es",
    origin: delivered ? "ai" : "human",
    is_published: false,
    is_stale: false,
    title: target.title,
    description: target.description,
    updated_at: target.updated_at,
  };
}

export function deliveredJob() {
  return {
    job_id: "translation-job-1230",
    status: "delivered",
    zpage_id: 1230,
    language: "es",
    source_digest: "source-digest-1230",
    target_digest: null,
    price: 7,
    charged: "7.000",
    refunded: "0.000",
    balance: "93.000",
    ai_model: "fixture-translation-model",
    ai_model_id: "fixture-translation-model-v1",
    error: null,
  };
}

export async function stubApi(
  page: Page,
  options: {
    blank?: boolean;
    refusal?: string;
    unaffordableQuote?: boolean;
    pollFailure?: boolean;
    /** The worker refunds the job instead of delivering it. */
    workerRefund?: boolean;
    delivered?: boolean;
    concurrentVariant?: boolean;
    publishedDelivered?: boolean;
    initialPublishedTarget?: boolean;
    sharedChanged?: boolean;
  } = {},
) {
  let purchases = 0;
  let quotes = 0;
  let polls = 0;
  let delivered = false;
  const writes: SentWrite[] = [];

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const { pathname, searchParams } = new URL(request.url());
      const method = request.method();
      if (options.delivered) delivered = true;
      const initialTarget = options.initialPublishedTarget
        ? { ...TARGET_DRAFT, is_published: true, variant_is_published: true }
        : TARGET_DRAFT;

      let body: Record<string, unknown> | null = null;
      if (method !== "GET") {
        try {
          body = JSON.parse(request.postData() || "null");
        } catch {
          body = null;
        }
        writes.push({
          pathname,
          method,
          body,
          ifMatch: request.headers()["if-match"],
        });
      }

      if (pathname === "/api/auth/user/") {
        await route.fulfill({ json: CREATOR });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/`) {
        const language = searchParams.get("lang");
        if (language === "es") {
          await route.fulfill({
            json: delivered
              ? TARGET_DELIVERED
              : options.blank
                ? {
                    ...SOURCE,
                    available_languages: ["en"],
                    actual_language: "en",
                    requested_language: "es",
                    fallback_used: true,
                  }
                : initialTarget,
          });
          return;
        }
        await route.fulfill({
          json:
            options.blank && !delivered
              ? { ...SOURCE, available_languages: ["en"] }
              : SOURCE,
        });
        return;
      }

      // The editor reads a translation through its own resource so the body
      // and the `ETag` come from one response. Answering it with the
      // catch-all `{count: 0, results: []}` used to leave the composer blank,
      // which is exactly the failure a real proxy or an older pod would cause
      // -- the load now rejects a body that is not this article's variant, and
      // this stub serves the real thing.
      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/es/`) {
        if (options.blank && !delivered) {
          await route.fulfill({ status: 404, json: { detail: "Not found" } });
          return;
        }
        await route.fulfill({
          json: delivered
            ? {
                ...TARGET_DELIVERED,
                p2paddr: options.sharedChanged
                  ? "a-new-payout-address"
                  : TARGET_DELIVERED.p2paddr,
                variant_is_published: Boolean(options.publishedDelivered),
                is_published: Boolean(options.publishedDelivered),
              }
            : initialTarget,
          headers: {
            ETag: `"es-${options.concurrentVariant ? "concurrent" : delivered ? "delivered" : "draft"}"`,
          },
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/en/`) {
        await route.fulfill({
          json:
            options.blank && !delivered
              ? { ...SOURCE, available_languages: ["en"] }
              : SOURCE,
          headers: { ETag: '"en-source"' },
        });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/variants/`) {
        await route.fulfill({
          json:
            options.blank && !delivered
              ? [sourceVariant]
              : [
                  sourceVariant,
                  {
                    ...translationVariant(delivered),
                    is_published:
                      !delivered && Boolean(options.initialPublishedTarget),
                  },
                ],
        });
        return;
      }

      if (
        pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/quote/`
      ) {
        quotes++;
        await route.fulfill({
          json: {
            price: options.refusal === "price_changed" && quotes > 1 ? 9 : 7,
            balance: options.unaffordableQuote ? "1.000" : "100.000",
            affordable: !options.unaffordableQuote,
            source_language: "en",
            language: "es",
            source_digest: "source-digest-1230",
            ai_model: "fixture-translation-model",
            input_tokens: 321,
            estimated_output_tokens: 234,
            chunks: 1,
            existing_variant: { is_published: false, origin: "human" },
          },
        });
        return;
      }

      if (
        pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/` &&
        method === "POST"
      ) {
        purchases++;
        if (options.refusal && purchases === 1) {
          await route.fulfill({
            status: options.refusal === "insufficient_funds" ? 402 : 409,
            json: {
              code: options.refusal,
              error: "Refused",
              cost: "7",
              required: "7",
              available: "1",
              shortfall: "6",
              balance: "1",
            },
          });
          return;
        }
        await route.fulfill({
          json: { ...deliveredJob(), status: "queued" },
        });
        return;
      }

      if (
        pathname === `/api/zpage/${ARTICLE_ID}/variants/es/translate/` &&
        method === "GET"
      ) {
        polls++;
        if (!purchases) {
          await route.fulfill({ status: 404, json: { detail: "No job" } });
          return;
        }
        if (options.pollFailure && polls === 1) {
          await route.fulfill({ status: 503, json: {} });
          return;
        }
        if (options.workerRefund) {
          // What the status endpoint returns after `translate_zpage` refused
          // the model's answer and settled the charge: the 2026-09-18 shape.
          await route.fulfill({
            json: {
              ...deliveredJob(),
              status: "refunded",
              refunded: "7.000",
              balance: "100.000",
              error: "markup_not_in_source",
            },
          });
          return;
        }
        delivered = true;
        await route.fulfill({ json: deliveredJob() });
        return;
      }

      if (pathname === `/api/zpage/${ARTICLE_ID}/translations/es/`) {
        const expected = `"es-${options.concurrentVariant ? "concurrent" : delivered ? "delivered" : "draft"}"`;
        if (request.headers()["if-match"] !== expected) {
          await route.fulfill({
            status: 412,
            json: { detail: "A newer version was saved elsewhere" },
          });
          return;
        }
        const saved = { ...TARGET_DELIVERED, ...(body || {}) };
        await route.fulfill({ json: saved });
        return;
      }

      await route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return writes;
}

export async function openAi(page: Page, blank = false) {
  await page.goto(`/edit?id=${ARTICLE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toBeVisible();
  await page.getByRole("button", { name: /^Translations/ }).click();
  if (blank) {
    await page
      .getByRole("button", { name: "Add a translation", exact: true })
      .click();
    // A picker row is a `role="option"` in a listbox, not a button: the picker
    // became a real ARIA combobox in  so it is usable at 78 languages.
    // `.first()` because a language the creator recently used is listed twice
    // on purpose — once as a suggestion at the top, once in its own group.
    await page
      .getByRole("dialog")
      .getByRole("option", { name: "Spanish", exact: true })
      .first()
      .click();
    // No prompt here, and that is the fix: until  the hydrated tag list
    // marked this production-shaped fixture "dirty" on mount, so opening a
    // blank variant demanded a save/discard decision about edits nobody had
    // made. An untouched document switches straight through.
    await expect(page.getByPlaceholder("Article title...")).toHaveValue("");
  }
}

/** Warm the editor route once per file so the first test does not pay the
 * dev-server compile inside its own timeout. */
export function warmEditorOnce() {
  test.describe.configure({ timeout: 90_000 });

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const warmPage = await context.newPage();
    await stubApi(warmPage);
    await warmPage.goto(`/edit?id=${ARTICLE_ID}`);
    await expect(warmPage.getByPlaceholder("Article title...")).toBeVisible({
      timeout: 60_000,
    });
    await context.close();
  });
}
