import { expect, test, type Page } from "@playwright/test";

/**
 * Shared mock for the parallel translation specs ( workstream D).
 *
 * A stateful stand-in for the jobs API the backend half of  adds —
 * `GET/POST /api/zpage/{id}/translations/` and `…/translations/quote/` — plus
 * the per-language status, variant and save routes the editor already uses.
 * The spec drives the server side by hand (`deliver`, `fail`), so a job lands
 * exactly when the test says and every assertion about "the other one is
 * still running" is about a state the test created.
 *
 * Not a spec. Named `ai-translation-parallel-*` so it sorts next to its specs
 * and into the shard with the most headroom (CLAUDE.md, ).
 */

export const OWNER = {
  id: 2348,
  username: "parallel-translation-owner",
  full_name: "Parallel Translation Owner",
};

export const PAGE_ID = "parallel-translation-fixture";
export const SOURCE_TITLE =
  "Shielded memos, explained for people who just want it to work";
export const SOURCE_CONTENT = [
  "# Shielded memos",
  "",
  "A memo travels with a shielded payment and only the receiver can read it.",
].join("\n");

export const PRICES: Record<string, number> = {
  es: 7,
  fr: 9,
  ja: 11,
  de: 8,
};

const TITLES: Record<string, string> = {
  es: "Memos protegidos, explicados para quien solo quiere que funcione",
  fr: "Les mémos protégés, expliqués simplement",
  ja: "シールドされたメモの説明",
  de: "Geschützte Memos, einfach erklärt",
};

type Job = {
  language: string;
  job_id: string;
  status: string;
  price: number;
  charged: string;
  refunded: string;
  billed?: string;
  error: string | null;
  error_detail?: string | null;
  created_at: string;
  settled_at: string | null;
  warnings?: { code: string; detail: string; items: unknown[] }[];
  attempted_output_preview?: string | null;
  zpage_id: number;
  variant: { is_published: boolean; is_stale: boolean } | null;
};

type Draft = {
  published: boolean;
  jobId?: string | null;
  warnings?: NonNullable<Job["warnings"]>;
  priorWarnings?: NonNullable<Job["warnings"]>;
  revision?: string;
};

export type Write = {
  method: string;
  pathname: string;
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
};

function variantBody(language: string, published: boolean) {
  return {
    id: 2348,
    free2zaddr: PAGE_ID,
    vanity: PAGE_ID,
    title: language === "en" ? SOURCE_TITLE : TITLES[language],
    description: "",
    canonical_url: "",
    content:
      language === "en"
        ? SOURCE_CONTENT
        : `# ${TITLES[language]}\n\nTexto. Check $500 and useState.`,
    tags: [],
    category: "TECHNOLOGY",
    is_published: true,
    variant_is_published: published,
    is_subscriber_only: false,
    publish_at: null,
    p2paddr: "",
    creator: OWNER,
    source_language: "en",
    requested_language: language,
    actual_language: language,
    fallback_used: false,
    available_languages: ["en"],
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    published_at: "2026-10-01T00:00:00Z",
  };
}

export async function stubParallelApi(
  page: Page,
  options: {
    /** The jobs list route exists (the  backend is deployed). */
    listSupported?: boolean;
    /** Jobs the server already knows about when the page opens. */
    initialJobs?: Partial<Job>[];
    /** The bulk POST answers 409 naming these languages, once. */
    refuseOnce?: { language: string; code: string }[];
    /**
     * The first N bulk POSTs commit nothing and answer a bodyless 503 — from
     * the client, indistinguishable from "the debit landed and the answer
     * was lost".
     */
    loseAnswers?: number;
    /**
     * Saved drafts the server has but the editor's variants index does not —
     * saved from another device after the editor loaded. Only the quote's
     * `existing_variant` knows about them.
     */
    remoteDrafts?: string[];
  } = {},
) {
  const listSupported = options.listSupported ?? true;
  const jobs = new Map<string, Job>();
  const drafts = new Map<string, Draft>();
  const writes: Write[] = [];
  let refusal = options.refuseOnce ?? null;
  const remoteDrafts = new Set(options.remoteDrafts ?? []);
  let lostAnswers = options.loseAnswers ?? 0;
  let sequence = 0;
  let replaceOnPublish: { language: string; revision: string } | null = null;

  const makeJob = (language: string, extra: Partial<Job> = {}): Job => ({
    language,
    job_id: `job-${language}-${++sequence}`,
    status: "queued",
    price: PRICES[language] ?? 5,
    charged: String(PRICES[language] ?? 5),
    refunded: "0",
    error: null,
    created_at: new Date(Date.now() - 65_000).toISOString(),
    settled_at: null,
    zpage_id: 2348,
    variant: null,
    ...extra,
  });

  for (const seed of options.initialJobs ?? []) {
    const job = makeJob(seed.language!, seed);
    jobs.set(job.language, job);
    if (job.status === "delivered")
      drafts.set(job.language, {
        published: Boolean(job.variant?.is_published),
        jobId: job.job_id,
        warnings: job.warnings ?? [],
        revision: `"${job.language}-etag"`,
      });
  }

  const control = {
    writes,
    jobs,
    drafts,
    replaceOnNextPublish(language: string, revision: string) {
      replaceOnPublish = { language, revision };
    },
    deliver(language: string, extra: Partial<Job> = {}) {
      const job = jobs.get(language)!;
      drafts.set(language, {
        published: false,
        jobId: job.job_id,
        warnings: extra.warnings ?? job.warnings ?? [],
        revision: `"${language}-etag"`,
      });
      jobs.set(language, {
        ...job,
        status: "delivered",
        variant: { is_published: false, is_stale: false },
        ...extra,
      });
    },
    fail(language: string, extra: Partial<Job> = {}) {
      const job = jobs.get(language)!;
      jobs.set(language, {
        ...job,
        status: "refunded",
        refunded: job.charged,
        error: "provider_failed",
        settled_at: new Date().toISOString(),
        ...extra,
      });
    },
  };

  const variantRows = () => [
    {
      language: "en",
      origin: "source",
      is_published: true,
      is_stale: false,
      title: SOURCE_TITLE,
      description: "",
      updated_at: "2026-10-01T00:00:00Z",
    },
    ...[...drafts].map(([language, draft]) => ({
      language,
      origin: "ai",
      is_published: draft.published,
      is_stale: false,
      title: TITLES[language],
      description: "",
      updated_at: "2026-10-01T00:00:00Z",
    })),
  ];

  /**
   * A job as the  LIST serializes it: the variant's state at the top
   * level, both `null` while no translation exists in that language.
   */
  const listed = (job: Job) => {
    const { variant: _variant, ...rest } = job;
    const draft = drafts.get(job.language);
    return {
      ...rest,
      source_digest: "parallel-source-digest",
      is_published: draft ? draft.published : null,
      is_stale: draft ? false : null,
      draft: draft
        ? {
            job_id: draft.jobId ?? null,
            warnings: draft.warnings ?? [],
            prior_warnings: draft.priorWarnings ?? [],
            revision: draft.revision ?? `"${job.language}-etag"`,
          }
        : null,
    };
  };
  /** As the per-language STATUS endpoint does: no variant state at all. */
  const statusOf = (job: Job) => {
    const { variant: _variant, ...rest } = job;
    return rest;
  };
  const running = () =>
    [...jobs.values()].filter((job) => job.status === "queued").length;

  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const { pathname, searchParams } = url;
      const method = request.method();
      let body: Record<string, unknown> | null = null;
      if (method !== "GET") {
        try {
          body = JSON.parse(request.postData() || "null");
        } catch {
          body = null;
        }
        writes.push({ method, pathname, body, headers: request.headers() });
      }
      const base = `/api/zpage/${PAGE_ID}`;

      if (pathname === "/api/auth/user/") return route.fulfill({ json: OWNER });

      if (pathname === `${base}/translations/` && method === "GET") {
        if (!listSupported)
          return route.fulfill({ status: 404, json: { detail: "Not found." } });
        return route.fulfill({
          json: {
            source_digest: "parallel-source-digest",
            jobs: [...jobs.values()].map(listed),
            drafts: Object.fromEntries(
              [...drafts].map(([language, draft]) => [
                language,
                {
                  job_id: draft.jobId ?? null,
                  warnings: draft.warnings ?? [],
                  prior_warnings: draft.priorWarnings ?? [],
                  revision: draft.revision ?? `"${language}-etag"`,
                },
              ]),
            ),
            in_flight: running(),
            capacity: 10 - running(),
            max_in_flight: 10,
          },
        });
      }

      if (pathname === `${base}/translations/quote/`) {
        if (!listSupported)
          return route.fulfill({ status: 404, json: { detail: "Not found." } });
        const languages = (searchParams.get("languages") ?? "")
          .split(",")
          .filter(Boolean);
        const items = languages.map((language) => ({
          language,
          price: PRICES[language] ?? 5,
          available: !drafts.get(language)?.published,
          reason: drafts.get(language)?.published ? "variant_published" : null,
          existing_variant: drafts.has(language)
            ? { is_published: drafts.get(language)!.published, origin: "ai" }
            : remoteDrafts.has(language)
              ? { is_published: false, origin: "human" }
              : null,
        }));
        return route.fulfill({
          json: {
            items,
            total: items
              .filter((item) => item.available)
              .reduce((sum, item) => sum + item.price, 0),
            source_digest: "parallel-source-digest",
            source_language: "en",
            balance: "100.000",
            affordable: true,
            in_flight: running(),
            capacity: 10 - running(),
            max_items: 10,
          },
        });
      }

      if (pathname === `${base}/translations/` && method === "POST") {
        const items = (body?.items ?? []) as { language: string }[];
        if (lostAnswers > 0) {
          lostAnswers -= 1;
          return route.fulfill({ status: 503, body: "" });
        }
        if (refusal) {
          const refused = refusal;
          refusal = null;
          return route.fulfill({
            status: 409,
            json: {
              code: "items_refused",
              error: "Some languages cannot be bought.",
              items: refused,
            },
          });
        }
        const created = items.map((item) => {
          const job = makeJob(item.language);
          jobs.set(item.language, job);
          return job;
        });
        return route.fulfill({ status: 202, json: { jobs: created } });
      }

      const status = pathname.match(
        new RegExp(`^${base}/variants/([^/]+)/translate/$`),
      );
      if (status && method === "GET") {
        const job = jobs.get(decodeURIComponent(status[1]));
        if (!job)
          return route.fulfill({ status: 404, json: { detail: "No job" } });
        return route.fulfill({ json: statusOf(job) });
      }

      const variant = pathname.match(new RegExp(`^${base}/variants/([^/]+)/$`));
      if (variant) {
        const language = decodeURIComponent(variant[1]);
        if (method === "PATCH") {
          const draft = drafts.get(language);
          if (!draft) return route.fulfill({ status: 404, json: {} });
          if (replaceOnPublish?.language === language) {
            draft.revision = replaceOnPublish.revision;
            replaceOnPublish = null;
          }
          if (
            request.headers()["if-match"] !==
            (draft.revision ?? `"${language}-etag"`)
          )
            return route.fulfill({ status: 412, json: { detail: "Changed" } });
          draft.published = Boolean(body?.is_published);
          return route.fulfill({
            json: variantBody(language, draft.published),
          });
        }
        if (language !== "en" && !drafts.has(language))
          return route.fulfill({ status: 404, json: { detail: "Not found" } });
        return route.fulfill({
          json: variantBody(
            language,
            language === "en" || drafts.get(language)!.published,
          ),
          headers: {
            ETag: drafts.get(language)?.revision ?? `"${language}-etag"`,
          },
        });
      }

      if (pathname === `${base}/variants/`)
        return route.fulfill({ json: variantRows() });

      const save = pathname.match(
        new RegExp(`^${base}/translations/([^/]+)/$`),
      );
      if (save && method === "PUT") {
        const language = decodeURIComponent(save[1]);
        const draft = drafts.get(language);
        if (body?.is_published && replaceOnPublish?.language === language) {
          if (draft) draft.revision = replaceOnPublish.revision;
          replaceOnPublish = null;
        }
        if (
          body?.is_published &&
          draft &&
          request.headers()["if-match"] !== draft.revision
        )
          return route.fulfill({ status: 412, json: { detail: "Changed" } });
        const published = Boolean(body?.is_published);
        drafts.set(language, { published, revision: `"${language}-etag-2"` });
        return route.fulfill({
          json: { ...variantBody(language, published), ...(body ?? {}) },
          headers: { ETag: `"${language}-etag-2"` },
        });
      }

      if (pathname === `${base}/`) {
        const language = searchParams.get("lang");
        if (method === "GET") {
          if (language && language !== "en" && drafts.has(language))
            return route.fulfill({
              json: variantBody(language, drafts.get(language)!.published),
            });
          return route.fulfill({
            json: variantBody("en", true),
            headers: { ETag: '"en-etag"' },
          });
        }
        return route.fulfill({
          json: { ...variantBody("en", true), ...(body ?? {}) },
          headers: { ETag: '"en-etag-2"' },
        });
      }

      return route.fulfill({ json: { count: 0, results: [] } });
    },
  );

  return control;
}

export async function openEditor(page: Page, language?: string) {
  await page.goto(`/edit?${language ? `lang=${language}&` : ""}id=${PAGE_ID}`);
  await expect(page.getByPlaceholder("Article title...")).toBeVisible();
}

/**
 * Open "Translate…" the way a creator does where the jobs list exists: the
 * one Translations entry point (the indicator), then the tray's button.
 */
export async function openTranslateDialog(page: Page) {
  await page.getByTestId("translation-jobs-indicator").click();
  await page.getByTestId("translation-tray-translate").click();
}

/** Tick languages in the "Translate…" dialog and wait for their live total. */
export async function pickLanguages(page: Page, tags: string[]) {
  const dialog = page.getByTestId("translate-into-dialog");
  await expect(dialog).toBeVisible();
  for (const tag of tags) {
    await dialog.locator(`label[data-language="${tag}"] input`).check();
  }
  // One step: the total appears as the selection is priced.
  await expect(dialog.getByTestId("translate-into-total")).toBeVisible();
  return dialog;
}

export function warmEditorOnce() {
  test.describe.configure({ timeout: 90_000 });
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(60_000);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const warm = await context.newPage();
    await stubParallelApi(warm);
    await warm.goto(`/edit?id=${PAGE_ID}`);
    await expect(warm.getByPlaceholder("Article title...")).toBeVisible({
      timeout: 60_000,
    });
    await context.close();
  });
}
