// The translation jobs store ( workstream D).
//
// The editor used to hold ONE translation in a component slot: starting B
// while A ran replaced A, leaving the editor dropped A's poller, and another
// device saw nothing. These tests pin the store's half of the fix with a fake
// clock and fake network — every poller is a timer we fire by hand.

import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";

import {
  createTranslationJobs,
  formatElapsed,
  indicatorPage,
  jobChip,
  mergeJob,
  normalizeJobsListing,
  readyLanguages,
  receiptJobs,
  summarizeJobs,
  describeWarnings,
  draftWarnings,
  jobWarnings,
  summarizeTray,
  summaryText,
  trayRows,
} from "../src/lib/translation-jobs.ts";
import { isNoChargeRefusal } from "../src/lib/zpage-translation-purchase.js";

function harness({ list = async () => [], statuses = {} } = {}) {
  let clock = 1_000_000;
  const timers = [];
  const statusCalls = [];
  const jobs = createTranslationJobs({
    list,
    status: async (page, language) => {
      statusCalls.push(`${page}:${language}`);
      const answer = statuses[language];
      if (answer instanceof Error) throw answer;
      if (typeof answer === "function") return answer();
      return answer;
    },
    now: () => clock,
    schedule: (fn, ms) => {
      const timer = { fn, at: clock + ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.cancelled = true;
    },
    pollIntervalMs: 3000,
    pollTimeoutMs: 60_000,
  });
  return {
    jobs,
    statusCalls,
    live: () => timers.filter((timer) => !timer.cancelled && !timer.fired),
    advance: async (ms) => {
      clock += ms;
      for (const timer of [...timers]) {
        if (!timer.cancelled && !timer.fired && timer.at <= clock) {
          timer.fired = true;
          await timer.fn();
        }
      }
      // Let the awaited status() promises inside ticks settle.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

const queued = (language, id = `job-${language}`, extra = {}) => ({
  language,
  job_id: id,
  status: "queued",
  price: 7,
  created_at: "2026-10-01T10:00:00Z",
  ...extra,
});
const delivered = (language, id = `job-${language}`, extra = {}) => ({
  ...queued(language, id),
  status: "delivered",
  variant: { is_published: false, is_stale: false },
  ...extra,
});

test("two languages run concurrently, each with its own poller", async () => {
  const statuses = { fr: queued("fr"), es: queued("es") };
  const h = harness({ statuses });
  h.jobs.ingest("page-1", queued("fr"));
  h.jobs.ingest("page-1", queued("es"));
  assert.equal(h.jobs.isPolling("page-1", "fr"), true);
  assert.equal(h.jobs.isPolling("page-1", "es"), true);

  // Spanish lands first; French keeps going, untouched.
  statuses.es = delivered("es");
  await h.advance(3000);
  const state = get(h.jobs);
  assert.equal(state.pages["page-1"].jobs.es.status, "delivered");
  assert.equal(state.pages["page-1"].jobs.fr.status, "queued");
  assert.equal(h.jobs.isPolling("page-1", "es"), false);
  assert.equal(h.jobs.isPolling("page-1", "fr"), true);

  statuses.fr = delivered("fr");
  await h.advance(3000);
  assert.equal(get(h.jobs).pages["page-1"].jobs.fr.status, "delivered");
  assert.equal(h.live().length, 0, "every poller stops at a terminal state");
});

test("a transition is announced once, only when it was watched happening", async () => {
  const statuses = { es: queued("es") };
  const h = harness({ statuses });
  const seen = [];
  h.jobs.onTransition((entry, previous) =>
    seen.push(`${entry.language}:${previous}->${entry.status}`),
  );
  // Last week's delivered job, found on a reload, is not news.
  h.jobs.ingest("page-1", delivered("de"));
  h.jobs.ingest("page-1", queued("es"));
  statuses.es = delivered("es");
  await h.advance(3000);
  await h.advance(3000);
  assert.deepEqual(seen, ["es:queued->delivered"]);
});

test("a status transition cannot carry a queued or earlier draft snapshot forward", () => {
  const warning = { code: "amount_not_in_source", items: ["$500"] };
  const listed = mergeJob(undefined, queued("es", "job-new", { draft: null }), {
    page: "p",
    now: 1,
  });
  const deliveredStatus = mergeJob(
    listed,
    delivered("es", "job-new", { warnings: [warning] }),
    { page: "p", now: 2 },
  );
  assert.equal("draft" in deliveredStatus, false);

  const oldDraft = {
    ...delivered("es", "job-old", {
      draft: {
        job_id: "job-old",
        warnings: [{ code: "old" }],
        revision: '"old"',
      },
    }),
    page: "p",
    firstSeenAt: 1,
    watching: false,
    interrupted: false,
    claimed: false,
  };
  const replacementStatus = mergeJob(
    oldDraft,
    delivered("es", "job-new", { warnings: [warning] }),
    { page: "p", now: 3 },
  );
  assert.equal("draft" in replacementStatus, false);

  const store = createTranslationJobs({
    list: async () => [],
    status: async () => null,
    schedule: () => ({}),
    cancel: () => {},
  });
  store.ingest("p", queued("es", "job-queued", { draft: null }));
  store.ingest("p", delivered("es", "job-queued", { warnings: [warning] }));
  assert.deepEqual(draftWarnings(get(store), "p", "es"), []);
  store.ingest(
    "p",
    delivered("es", "job-old", {
      draft: {
        job_id: "job-old",
        warnings: [{ code: "old" }],
        revision: '"old"',
      },
    }),
  );
  store.ingest(
    "p",
    delivered("es", "job-replacement", { warnings: [warning] }),
  );
  assert.deepEqual(draftWarnings(get(store), "p", "es"), []);
});

test("fresh current-draft snapshots load even when the jobs list is empty", async () => {
  const jobs = createTranslationJobs({
    list: async () => ({
      jobs: [],
      drafts: {
        es: {
          job_id: null,
          warnings: [],
          prior_warnings: [],
          revision: '"manual-draft"',
        },
      },
    }),
    status: async () => null,
    schedule: () => ({}),
    cancel: () => {},
  });
  assert.equal(await jobs.refresh("p"), true);
  assert.deepEqual(get(jobs).pages.p.drafts.es, {
    jobId: null,
    warnings: [],
    priorWarnings: [],
    revision: '"manual-draft"',
  });
});

test("a failed status read is an interruption, not a failure", async () => {
  const statuses = { es: new Error("offline") };
  const h = harness({ statuses });
  h.jobs.ingest("page-1", queued("es"));
  await h.advance(3000);
  let job = get(h.jobs).pages["page-1"].jobs.es;
  assert.equal(job.status, "queued");
  assert.equal(job.interrupted, true);
  assert.equal(h.jobs.isPolling("page-1", "es"), true);
  statuses.es = queued("es");
  await h.advance(3000);
  job = get(h.jobs).pages["page-1"].jobs.es;
  assert.equal(job.interrupted, false);
});

test("the poller stops at its deadline and resumes on return", async () => {
  const statuses = { es: queued("es") };
  const h = harness({ statuses });
  h.jobs.ingest("page-1", queued("es"));
  for (let i = 0; i < 25; i += 1) await h.advance(3000);
  assert.equal(h.jobs.isPolling("page-1", "es"), false);
  assert.equal(get(h.jobs).pages["page-1"].jobs.es.watching, false);
  assert.equal(get(h.jobs).pages["page-1"].jobs.es.status, "queued");

  h.jobs.resume("page-1");
  assert.equal(h.jobs.isPolling("page-1", "es"), true);
  statuses.es = delivered("es");
  await h.advance(3000);
  assert.equal(get(h.jobs).pages["page-1"].jobs.es.status, "delivered");
});

test("the editor's claim stands the store's poller down, release hands it back", async () => {
  const statuses = { es: queued("es") };
  const h = harness({ statuses });
  h.jobs.ingest("page-1", queued("es"));
  h.jobs.claim("page-1", "es");
  assert.equal(h.jobs.isPolling("page-1", "es"), false);
  await h.advance(9000);
  assert.deepEqual(h.statusCalls, [], "never polled twice");
  // The editor feeds its own answers back in while it follows the job.
  h.jobs.ingest("page-1", queued("es"));
  assert.equal(h.jobs.isPolling("page-1", "es"), false);

  // Navigating away: the editor releases, and the store keeps following.
  h.jobs.release("page-1", "es");
  assert.equal(h.jobs.isPolling("page-1", "es"), true);
  statuses.es = delivered("es");
  await h.advance(3000);
  assert.equal(get(h.jobs).pages["page-1"].jobs.es.status, "delivered");
});

test("fresh device: the server list rediscovers running and finished jobs", async () => {
  const h = harness({
    list: async () => [queued("fr"), delivered("es"), delivered("ja")],
    statuses: { fr: queued("fr") },
  });
  assert.equal(await h.jobs.refresh("page-1"), true);
  const state = get(h.jobs);
  assert.equal(state.pages["page-1"].listSupported, true);
  assert.deepEqual(Object.keys(state.pages["page-1"].jobs).sort(), [
    "es",
    "fr",
    "ja",
  ]);
  assert.equal(h.jobs.isPolling("page-1", "fr"), true);
  assert.equal(h.jobs.isPolling("page-1", "es"), false);
  assert.deepEqual(readyLanguages(state, "page-1"), ["es", "ja"]);
});

test("fresh device uses persisted provenance for a draft older than the latest failed job", async () => {
  const warning = { code: "amount_not_in_source", items: ["$500"] };
  const h = harness({
    list: async () => ({
      jobs: [
        queued("es", "failed-retry", {
          status: "refunded",
          variant: { is_published: false, is_stale: false },
          draft: {
            job_id: "delivered-draft",
            warnings: [warning],
            revision: '"draft-revision-7"',
          },
        }),
      ],
      in_flight: 0,
      capacity: 4,
      max_in_flight: 4,
    }),
  });
  assert.equal(await h.jobs.refresh("page-1"), true);
  const state = get(h.jobs);
  assert.equal(state.pages["page-1"].jobs.es.status, "refunded");
  assert.deepEqual(draftWarnings(state, "page-1", "es"), [warning]);
  assert.deepEqual(state.pages["page-1"].drafts.es, {
    jobId: "delivered-draft",
    warnings: [warning],
    priorWarnings: [],
    revision: '"draft-revision-7"',
  });
});

test("no jobs list deployed: unsupported, and receipt-seeded jobs still poll", async () => {
  const h = harness({
    list: async () => null,
    statuses: { es: queued("es") },
  });
  h.jobs.ingest("page-1", queued("es"), { fromReceipt: true });
  assert.equal(await h.jobs.refresh("page-1"), false);
  assert.equal(get(h.jobs).pages["page-1"].listSupported, false);
  assert.equal(h.jobs.isPolling("page-1", "es"), true);
});

test("a list read that fails is an error, not 'unsupported'", async () => {
  const h = harness({
    list: async () => {
      throw new Error("503");
    },
  });
  assert.equal(await h.jobs.refresh("page-1"), false);
  const page = get(h.jobs).pages["page-1"];
  assert.equal(page.error, true);
  assert.equal(page.listSupported, null);
});

test("merge: newer purchase wins, receipts never replace, terminal never regresses", () => {
  const base = { page: "p", now: 5 };
  const held = mergeJob(undefined, delivered("es", "j1"), base);
  assert.equal(held.status, "delivered");
  // A stale poll for the same job cannot resurrect the spinner.
  assert.equal(mergeJob(held, queued("es", "j1"), base), held);
  // A receipt for an older purchase never replaces what the server said.
  assert.equal(
    mergeJob(held, queued("es", "j0"), { ...base, fromReceipt: true }),
    held,
  );
  // A newer purchase for the language replaces it.
  const newer = mergeJob(
    held,
    queued("es", "j2", { created_at: "2026-10-01T11:00:00Z" }),
    base,
  );
  assert.equal(newer.job_id, "j2");
  // …but an OLDER one (by created_at) does not.
  const older = mergeJob(
    newer,
    queued("es", "j3", { created_at: "2026-09-01T00:00:00Z" }),
    base,
  );
  assert.equal(older.job_id, "j2");
});

test("chips: queued vs translating vs ready vs published vs refunded", () => {
  const at = Date.parse("2026-10-01T10:02:05Z");
  const entry = (job) => mergeJob(undefined, job, { page: "p", now: at });
  assert.deepEqual(jobChip(entry(queued("es")), at), {
    kind: "translating",
    elapsedMs: 125_000,
    warnings: 0,
  });
  assert.equal(
    jobChip(entry(queued("es", "j", { started_at: null })), at).kind,
    "queued",
  );
  assert.equal(jobChip(entry(delivered("es")), at).kind, "ready");
  assert.equal(
    jobChip(
      entry(
        delivered("es", "j", {
          variant: { is_published: true },
          warnings: [{ code: "x" }, { code: "y" }],
        }),
      ),
      at,
    ).kind,
    "published",
  );
  assert.equal(
    jobChip(
      entry(delivered("es", "j", { warnings: [{ code: "x" }, { code: "y" }] })),
      at,
    ).warnings,
    2,
  );
  assert.equal(
    jobChip(entry({ ...queued("es"), status: "refunded" }), at).kind,
    "refunded",
  );
  assert.equal(formatElapsed(125_000), "2:05");
  assert.equal(formatElapsed(3_725_000), "1:02:05");
});

test("summary and the indicator's choice of article", () => {
  const h = harness();
  h.jobs.ingest("a", delivered("es"));
  h.jobs.ingest("b", queued("fr"));
  h.jobs.ingest("b", { ...queued("de"), status: "refunded" });
  const state = get(h.jobs);
  assert.deepEqual(summarizeJobs(Object.values(state.pages.b.jobs)), {
    total: 2,
    active: 1,
    ready: 0,
    published: 0,
    failed: 1,
  });
  // Something running outranks something waiting to be read.
  assert.equal(indicatorPage(state), "b");
  h.jobs.stopAll();
});

test("publishing and deleting update the row without a refetch", () => {
  const h = harness();
  h.jobs.ingest("a", delivered("es"));
  h.jobs.markPublished("a", "es");
  assert.equal(jobChip(get(h.jobs).pages.a.jobs.es, 0).kind, "published");
  h.jobs.remove("a", "es");
  assert.equal(get(h.jobs).pages.a.jobs.es, undefined);
});

test("receipts: the never-read job history seeds one job per language", () => {
  const entries = new Map([
    [
      "translation-receipt:u:p",
      JSON.stringify({ language: "es", job: queued("es", "j-es-2") }),
    ],
    [
      "translation-receipt:u:p:job:j-es-1",
      JSON.stringify({
        language: "es",
        job: delivered("es", "j-es-1", { created_at: "2026-09-01T00:00:00Z" }),
      }),
    ],
    [
      "translation-receipt:u:p:job:j-es-2",
      JSON.stringify({ language: "es", job: queued("es", "j-es-2") }),
    ],
    [
      "translation-receipt:u:p:job:j-fr",
      JSON.stringify({ language: "fr", job: delivered("fr", "j-fr") }),
    ],
    ["translation-receipt:u:p:job:broken", "{not json"],
    [
      "translation-receipt:u:other:job:x",
      JSON.stringify({ job: queued("de") }),
    ],
  ]);
  const keys = [...entries.keys()];
  const storage = {
    getItem: (key) => entries.get(key) ?? null,
    key: (index) => keys[index] ?? null,
    length: keys.length,
  };
  const jobs = receiptJobs(storage, "translation-receipt:u:p");
  assert.deepEqual(jobs.map((job) => `${job.language}:${job.job_id}`).sort(), [
    "es:j-es-2",
    "fr:j-fr",
  ]);
});

test("a status answer without `variant` does not inherit 'no draft yet' from the list", () => {
  // The list said the queued job has no draft (`variant: null`); the status
  // endpoint, which knows nothing about variants, then says it delivered.
  // Keeping the stale `null` would hide a fresh delivery from the tray.
  const listed = mergeJob(
    undefined,
    { ...queued("es"), variant: null },
    { page: "p", now: 0 },
  );
  const status = { ...delivered("es") };
  delete status.variant;
  const next = mergeJob(listed, status, { page: "p", now: 1 });
  assert.equal(next.status, "delivered");
  assert.equal("variant" in next, false);
  // A receipt-only row stays receipt-only until something live confirms it.
  const seeded = mergeJob(undefined, delivered("fr"), {
    page: "p",
    now: 0,
    fromReceipt: true,
  });
  assert.equal(seeded.receiptOnly, true);
  assert.equal(
    mergeJob(seeded, delivered("fr"), { page: "p", now: 1 }).receiptOnly,
    false,
  );
});

test("a status read that hangs is bounded: interrupted, still polling, resumable", async () => {
  // A request stalled mid-response used to leave the poller awaiting forever,
  // past its own deadline and still "watching" (codex adversarial review).
  const statuses = { es: () => new Promise(() => {}) };
  const h = harness({ statuses });
  h.jobs.ingest("page-1", queued("es"));
  await h.advance(3000); // the read starts, and never answers
  await h.advance(30_000); // its bound fires
  const job = get(h.jobs).pages["page-1"].jobs.es;
  assert.equal(job.interrupted, true);
  assert.equal(job.status, "queued");
  assert.equal(h.jobs.isPolling("page-1", "es"), true);
  statuses.es = delivered("es");
  await h.advance(3000);
  assert.equal(get(h.jobs).pages["page-1"].jobs.es.status, "delivered");
});

test("only a refusal that proves no charge retires a purchase key", () => {
  const refusal = (status, data) => ({ status, data });
  // Decisions: nothing moved.
  assert.equal(
    isNoChargeRefusal(refusal(402, { code: "insufficient_funds" })),
    true,
  );
  assert.equal(
    isNoChargeRefusal(refusal(409, { code: "source_changed" })),
    true,
  );
  //too long for the clock, decided before the debit.
  assert.equal(
    isNoChargeRefusal(refusal(409, { code: "translation_too_long" })),
    true,
  );
  assert.equal(
    isNoChargeRefusal(
      refusal(409, { code: "x", items: [{ language: "ja", code: "y" }] }),
    ),
    true,
  );
  // The bulk purchase's 400s are decided before the key is claimed.
  for (const code of [
    "too_many_languages",
    "invalid_request",
    "invalid_language",
    "duplicate_language",
    "idempotency_key_required",
  ])
    assert.equal(isNoChargeRefusal(refusal(400, { code })), true, code);
  // Not decisions: the debit may have committed. Keep the key.
  assert.equal(isNoChargeRefusal(refusal(0, null)), false);
  assert.equal(isNoChargeRefusal(refusal(503, "")), false);
  assert.equal(isNoChargeRefusal(refusal(403, { detail: "CSRF" })), false);
  assert.equal(isNoChargeRefusal(refusal(429, { detail: "slow down" })), false);
  assert.equal(
    isNoChargeRefusal(refusal(409, { code: "request_in_progress" })),
    false,
  );
});

test("a delivered job whose draft is gone is not counted anywhere", () => {
  const h = harness();
  h.jobs.ingest("a", delivered("es", "j", { variant: null }));
  const state = get(h.jobs);
  assert.equal(summarizeJobs(Object.values(state.pages.a.jobs)).ready, 0);
  assert.deepEqual(readyLanguages(state, "a"), []);
  assert.equal(indicatorPage(state), null);
});

test("the #2352 listing: an object, variant state at the job's top level", () => {
  const listing = normalizeJobsListing({
    source_digest: "d",
    jobs: [
      { ...queued("fr"), is_published: null, is_stale: null },
      {
        ...delivered("es"),
        variant: undefined,
        is_published: false,
        is_stale: true,
      },
      {
        ...delivered("ja"),
        variant: undefined,
        is_published: null,
        is_stale: null,
      },
      { nonsense: true },
    ],
    in_flight: 2,
    capacity: 8,
    max_in_flight: 10,
  });
  assert.deepEqual(
    listing.jobs.map((job) => [job.language, job.variant]),
    [
      ["fr", null],
      ["es", { is_published: false, is_stale: true }],
      ["ja", null],
    ],
  );
  assert.equal("is_published" in listing.jobs[1], false);
  assert.deepEqual(
    [listing.inFlight, listing.capacity, listing.maxInFlight],
    [2, 8, 10],
  );
  // The first brief's bare array still reads; anything else is "unsupported".
  assert.equal(normalizeJobsListing([queued("fr")]).jobs.length, 1);
  assert.equal(normalizeJobsListing({ count: 0, results: [] }), null);
  assert.equal(normalizeJobsListing(null), null);
});

test("warnings: malformed entries dropped; each named in words with its items", () => {
  const t = (_key, fallback) => fallback;
  assert.deepEqual(jobWarnings(null), []);
  assert.deepEqual(jobWarnings({ warnings: "nope" }), []);
  const warnings = jobWarnings({
    warnings: [
      { code: "amount_not_in_source", items: ["$500"] },
      null,
      { detail: "no code" },
      {
        code: "something_new",
        detail: "Server prose for a code this client predates.",
        items: [],
      },
      { code: "url_not_in_source", items: ["a", "b", "c"] },
    ],
  });
  assert.equal(warnings.length, 3);
  assert.deepEqual(describeWarnings(warnings, t, 2), [
    "Amounts or prices that are not in the original — check every number: $500",
    "Server prose for a code this client predates.",
    "Links that are not in the original — check where they go: a, b…",
  ]);
});

test("the root layout's jobs path never statically imports the generated zPage client", async () => {
  // The store and its API module are reachable from `routes/+layout.svelte`
  // (the app-wide notifier). A static import of `$lib/api/zpage/zpage` put
  // that client on every page, and in dev its URL `/src/lib/api/zpage/…`
  // is matched by any spec's `**/api/zpage/**` API mock, which then answered
  // a module request with JSON and broke the homepage specs ( D).
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "../src/lib/stores/translationJobs.ts",
    "../src/lib/api/zpage-translations.ts",
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(
      source,
      /^import\s+(?!type\b)[^;]*from\s+["']\$lib\/api\/zpage\/zpage["']/m,
      `${file} must load $lib/api/zpage/zpage lazily`,
    );
  }
});

test("a draft keeps server-confirmed warnings through a refunded retry and reload", async () => {
  const memory = new Map();
  const storage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
  };
  let listing;
  const make = () =>
    createTranslationJobs({
      list: async () => listing,
      status: async () => null,
      storage,
      schedule: () => ({}),
      cancel: () => {},
    });
  const warning = { code: "amount_not_in_source", items: ["$500"] };
  listing = {
    jobs: [delivered("es", "job-1", { warnings: [warning] })],
    drafts: {
      es: {
        job_id: "job-1",
        warnings: [warning],
        prior_warnings: [],
        revision: '"revision-1"',
      },
    },
  };
  const first = make();
  first.ingest("p", delivered("es", "job-1", { warnings: [warning] }));
  await first.refresh("p");
  assert.deepEqual(draftWarnings(get(first), "p", "es"), [warning]);

  // The retry fails and is refunded: the draft (and its "$500") stay.
  first.ingest(
    "p",
    queued("es", "job-2", {
      status: "refunded",
      created_at: "2026-10-01T11:00:00Z",
    }),
  );
  listing = {
    jobs: [
      queued("es", "job-2", {
        status: "refunded",
        created_at: "2026-10-01T11:00:00Z",
      }),
    ],
    drafts: {
      es: {
        job_id: "job-1",
        warnings: [warning],
        prior_warnings: [],
        revision: '"revision-1"',
      },
    },
  };
  await first.refresh("p");
  assert.equal(get(first).pages.p.jobs.es.status, "refunded");
  assert.deepEqual(draftWarnings(get(first), "p", "es"), [warning]);

  listing = {
    jobs: [
      queued("es", "job-2", {
        status: "refunded",
        created_at: "2026-10-01T11:00:00Z",
      }),
    ],
    drafts: {
      es: {
        job_id: null,
        warnings: [],
        prior_warnings: [warning],
        revision: '"edited-revision"',
      },
    },
  };
  await first.refresh("p");
  assert.deepEqual(get(first).pages.p.drafts.es.warnings, []);
  assert.deepEqual(get(first).pages.p.drafts.es.priorWarnings, [warning]);

  // A fresh tab on this browser knows it from storage.
  const second = make();
  second.ingest(
    "p",
    queued("es", "job-2", {
      status: "refunded",
      created_at: "2026-10-01T11:00:00Z",
    }),
  );
  await second.refresh("p");
  assert.deepEqual(draftWarnings(get(second), "p", "es"), []);
  assert.deepEqual(get(second).pages.p.drafts.es.priorWarnings, [warning]);

  // A clean delivery replaces the draft, and with it the warnings.
  listing = {
    jobs: [delivered("es", "job-3", { warnings: [] })],
    drafts: {
      es: { job_id: "job-3", warnings: [], revision: '"revision-3"' },
    },
  };
  second.ingest(
    "p",
    delivered("es", "job-3", {
      warnings: [],
      created_at: "2026-10-01T12:00:00Z",
    }),
  );
  await second.refresh("p");
  assert.deepEqual(draftWarnings(get(second), "p", "es"), []);

  // Deleting the variant forgets the record.
  second.remove("p", "es");
  assert.equal(memory.size, 0);
});

test("reset drops an answer still in flight for the previous account", async () => {
  let release;
  const jobs = createTranslationJobs({
    list: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    status: async () => null,
    schedule: () => ({}),
    cancel: () => {},
  });
  const asked = jobs.refresh("p");
  jobs.reset();
  release({ jobs: [delivered("es")], in_flight: 0 });
  assert.equal(await asked, false);
  assert.deepEqual(get(jobs).pages, {});
});

test("tray rows: one per language from jobs and variants; flagged, failed and drafts told apart", () => {
  const now = Date.parse("2026-10-01T10:01:00Z");
  const entry = (job) => ({ ...job, page: "p", firstSeenAt: now });
  const rows = trayRows({
    jobs: [
      entry(queued("de")),
      entry(delivered("es")),
      entry(delivered("fr")),
      entry(queued("it", "job-it", { status: "settled" })),
      entry(delivered("ja", "job-ja", { variant: { is_published: true } })),
    ],
    variants: [
      {
        language: "en",
        status: "source",
        exists: true,
        isSource: true,
        canDelete: false,
      },
      {
        language: "nl",
        status: "draft",
        exists: true,
        isSource: false,
        canDelete: true,
      },
      {
        language: "it",
        status: "draft",
        exists: true,
        isSource: false,
        canDelete: true,
      },
    ],
    drafts: { fr: { jobId: "job-fr", warnings: [{ code: "x" }] } },
    now,
  });
  const kinds = Object.fromEntries(rows.map((row) => [row.language, row.kind]));
  assert.deepEqual(kinds, {
    de: "translating",
    es: "ready",
    fr: "flagged",
    it: "failed",
    ja: "published",
    nl: "draft",
  });
  assert.equal(rows.find((row) => row.language === "it").hasDraft, true);
  const summary = summarizeTray(rows);
  assert.deepEqual(
    { ...summary },
    { ready: 3, clean: 2, flagged: 1, active: 1, attention: 1, published: 1 },
  );
  const t = (_key, fallback, vars = {}) =>
    fallback.replace(/\{(\w+)\}/g, (_, name) => String(vars[name]));
  assert.equal(
    summaryText(summary, t),
    "3 ready to review · 1 translating · 1 need attention",
  );
  assert.equal(summaryText({ ready: 0, active: 0, attention: 0 }, t), "");
});
