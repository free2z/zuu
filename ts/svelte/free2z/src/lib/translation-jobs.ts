/**
 * Translation jobs, per zPage, per language — the store behind the editor's
 * translation tray ( workstream D).
 *
 * Before this, the editor held ONE translation in a component-local slot.
 * Starting B while A ran replaced A on screen, leaving the article dropped
 * A's poller, and nothing told another device anything was running. Three
 * properties fix that, and each is a rule here rather than a habit at call
 * sites:
 *
 * 1. **The map lives above the route.** This module is a singleton store
 *    (see `$lib/stores/translationJobs`), so navigating away from the editor
 *    and back finds the same jobs, still being watched.
 * 2. **Every job has its own poller**, keyed `(zPage, language)`, which stops
 *    at a terminal status or at its deadline — and resumes when the creator
 *    comes back (`refresh` / `resume`). One slow language never blocks the
 *    view of another.
 * 3. **The server's list is the truth when it exists.** `refresh` merges
 *    `GET /api/zpage/{id}/translations/` (cross-device); receipts kept in
 *    this browser are only a seed, never allowed to replace a newer job the
 *    server told us about.
 *
 * The editor's own single-purchase watcher (the flow the / specs
 * pin) still exists. It `claim`s the language it is following so this store
 * does not poll the same job twice, feeds every answer back through `ingest`,
 * and `release`s it when it stops watching — at which point this store keeps
 * polling. That hand-off is what makes "click away and the progress is still
 * there" true.
 *
 * Deliberately free of `$lib` imports: `tests/translation-jobs.test.mjs`
 * imports this file straight into node with injected fakes for the network
 * and the clock.
 */
import { writable, get } from "svelte/store";

export interface TranslationWarning {
  code: string;
  detail?: string | null;
  items?: unknown[] | null;
}

type Translate = (
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
) => string;

/** One flagged item as text ( sends strings; tolerate objects). */
export function warningItemText(item: unknown): string {
  if (typeof item === "string") return item;
  if (item && typeof item === "object") {
    const value = item as Record<string, unknown>;
    return String(
      value.text ?? value.source ?? value.value ?? JSON.stringify(value),
    );
  }
  return String(item);
}

/**
 * The warnings a delivered translation carries ( best-effort delivery):
 * the draft was written, but the check flagged something in it — an amount
 * that is not in the original ($5 may now read $500), a changed identifier,
 * a link. Anything malformed is dropped rather than shown as "undefined".
 */
export function jobWarnings(
  entry?: { warnings?: TranslationWarning[] | null } | null,
): TranslationWarning[] {
  return Array.isArray(entry?.warnings)
    ? entry!.warnings.filter(
        (warning) =>
          Boolean(warning) &&
          typeof warning === "object" &&
          typeof warning.code === "string",
      )
    : [];
}

/** A warning in plain words. Unknown codes fall back to the server's prose. */
export function warningLabel(warning: TranslationWarning, t: Translate) {
  switch (warning.code) {
    case "amount_not_in_source":
      return t(
        "translationJobs.warningAmount",
        "Amounts or prices that are not in the original — check every number",
      );
    case "code_identifier_not_preserved":
      return t(
        "translationJobs.warningCode",
        "Code that should have been copied exactly but was changed",
      );
    case "reference_not_in_source":
      return t(
        "translationJobs.warningReference",
        "Footnote or reference labels that were changed",
      );
    case "brand_term_not_preserved":
      return t(
        "translationJobs.warningBrand",
        "Names or brand terms that were changed",
      );
    case "markup_not_in_source":
      return t(
        "translationJobs.warningMarkup",
        "Markup that is not in the original",
      );
    case "unsafe_url_scheme":
      return t(
        "translationJobs.warningUnsafeLink",
        "Links with an unsafe address",
      );
    case "url_not_in_source":
      return t(
        "translationJobs.warningLink",
        "Links that are not in the original — check where they go",
      );
    default:
      return warning.detail || warning.code;
  }
}

/** One line per warning, naming its items: what a publish confirmation says. */
export function describeWarnings(
  warnings: readonly TranslationWarning[],
  t: Translate,
  maxItems = 5,
): string[] {
  return warnings.map((warning) => {
    const items = Array.isArray(warning.items) ? warning.items : [];
    if (!items.length) return warningLabel(warning, t);
    const shown = items.slice(0, maxItems).map(warningItemText).join(", ");
    return `${warningLabel(warning, t)}: ${shown}${items.length > maxItems ? "…" : ""}`;
  });
}

/** The shape `GET /api/zpage/{id}/translations/` answers with, per language. */
export interface ServerTranslationJob {
  language: string;
  job_id: string;
  status: string;
  price?: number | string | null;
  charged?: string | null;
  refunded?: string | null;
  billed?: string | null;
  error?: string | null;
  error_detail?: string | null;
  created_at?: string | null;
  /**
   * Not in the  contract yet. When the server sends it, `null` means
   * "waiting for a worker" (the Queued chip) and a timestamp is when the
   * translating started. Absent, a queued job is shown as translating since
   * `created_at` — the honest reading of a contract with one pending state.
   */
  started_at?: string | null;
  settled_at?: string | null;
  warnings?: TranslationWarning[] | null;
  /** Current saved draft and the strong validator required to publish it. */
  draft?: {
    job_id: string | null;
    warnings: TranslationWarning[];
    prior_warnings?: TranslationWarning[];
    revision: string;
  } | null;
  attempted_output_preview?: string | null;
  variant?: { is_published?: boolean; is_stale?: boolean } | null;
  zpage_id?: number;
}

export interface TranslationJobEntry extends ServerTranslationJob {
  page: string;
  /** Client clock when this job id was first seen — the elapsed fallback. */
  firstSeenAt: number;
  /** A poller (ours or the editor's) is currently following this job. */
  watching: boolean;
  /** The last status read failed; the job is not known to have failed. */
  interrupted: boolean;
  /** The editor's own purchase watcher is following it, not this store. */
  claimed: boolean;
  /**
   * Only ever seen in this browser's receipts — nothing live has confirmed
   * it. Such a row defers to the variants index about whether its draft
   * still exists; a job the server reported never does.
   */
  receiptOnly?: boolean;
  /** Client clock when this job's status last changed (or was first seen). */
  changedAt?: number;
}

/**
 * A delivered job whose draft is gone (deleted, here or on another device).
 * The jobs list says `variant: null`; such a row has nothing left to review,
 * publish or count, anywhere — the editor's tray and the global indicator
 * alike (codex adversarial review: the indicator said "1 ready" and opened
 * an empty tray).
 */
export function isDraftGone(job: ServerTranslationJob) {
  return job.status === "delivered" && job.variant === null;
}

/**
 * What `GET /api/zpage/{id}/translations/` answered, normalized.
 *
 * The shipped contract  is an object — `{source_digest, jobs,
 * in_flight, capacity, max_in_flight}` with `is_published`/`is_stale` at each
 * job's top level, both `null` when no translation exists. The first brief
 * said a bare array with a nested `variant`. Both are read, so this frontend
 * and that backend may merge in either order.
 */
export interface JobsListing {
  jobs: ServerTranslationJob[];
  /** Current unpublished drafts, including manual drafts with no job row. */
  drafts?: Record<string, ServerTranslationJob["draft"]>;
  /** Translations running for this ACCOUNT, across all its articles. */
  inFlight: number | null;
  /** How many more it may start right now. */
  capacity: number | null;
  maxInFlight: number | null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One job, with the variant's state folded into `variant`. */
export function normalizeServerJob(raw: unknown): ServerTranslationJob | null {
  if (!raw || typeof raw !== "object") return null;
  const job = { ...(raw as Record<string, unknown>) } as Record<
    string,
    unknown
  >;
  if (typeof job.language !== "string" || typeof job.job_id !== "string")
    return null;
  if ("is_published" in job && job.variant === undefined) {
    job.variant =
      job.is_published === null || job.is_published === undefined
        ? null
        : {
            is_published: Boolean(job.is_published),
            is_stale: Boolean(job.is_stale),
          };
  }
  delete job.is_published;
  delete job.is_stale;
  return job as unknown as ServerTranslationJob;
}

export function normalizeJobsListing(raw: unknown): JobsListing | null {
  const object =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const rows = Array.isArray(raw)
    ? raw
    : Array.isArray(object?.jobs)
      ? (object!.jobs as unknown[])
      : null;
  if (!rows) return null;
  return {
    jobs: rows
      .map(normalizeServerJob)
      .filter((job): job is ServerTranslationJob => job !== null),
    drafts:
      object?.drafts && typeof object.drafts === "object"
        ? (object.drafts as Record<string, ServerTranslationJob["draft"]>)
        : undefined,
    inFlight: count(object?.in_flight),
    capacity: count(object?.capacity),
    maxInFlight: count(object?.max_in_flight),
  };
}

export interface PageJobs {
  /** `null` until asked; `false` when this deployment has no jobs list. */
  listSupported: boolean | null;
  /** The account-wide numbers the last listing carried, if any. */
  inFlight?: number | null;
  capacity?: number | null;
  maxInFlight?: number | null;
  loading: boolean;
  /** The last list read failed (not "unsupported"). */
  error: boolean;
  jobs: Record<string, TranslationJobEntry>;
  /**
   * The warnings of each language's CURRENT DRAFT, recorded from the job that
   * wrote it ( best-effort delivery). Not the latest job's: a retry that
   * fails and is refunded leaves the earlier, flagged draft in place, and its
   * "$500" must still be asked about before it goes live. Persisted, so a
   * reload or another tab on this browser knows it too.
   */
  drafts: Record<string, DraftRecord>;
}

export interface DraftRecord {
  /** The delivered job that produced this exact text, or null if unknown. */
  jobId: string | null;
  warnings: TranslationWarning[];
  /** Warnings from a prior delivery when this draft no longer matches it. */
  priorWarnings: TranslationWarning[];
  /** Strong ETag for the exact draft revision in the server listing. */
  revision?: string;
}

/** The warnings the draft in `language` carries, as far as this browser knows. */
export function draftWarnings(
  state: TranslationJobsState,
  page: string | null | undefined,
  language: string | null | undefined,
): TranslationWarning[] {
  if (!page || !language) return [];
  return state.pages[page]?.drafts?.[language]?.warnings ?? [];
}

export interface TranslationJobsState {
  pages: Record<string, PageJobs>;
  /** The article whose tray is open, if any. */
  trayPage: string | null;
  /** A pending "Review this language" request, consumed by the editor. */
  review: { page: string; language: string } | null;
  /** The article the editor currently has open, if any. */
  editorPage: string | null;
}

export type TranslationChipKind =
  | "queued"
  | "translating"
  | "ready"
  | "published"
  | "refunded"
  | "settled"
  | "unknown";

export const ACTIVE_JOB_STATUS = "queued";
const TERMINAL = new Set(["delivered", "refunded", "settled"]);

export function isActiveJob(job: { status?: string } | null | undefined) {
  return job?.status === ACTIVE_JOB_STATUS;
}

export function isTerminalJob(job: { status?: string } | null | undefined) {
  return TERMINAL.has(job?.status ?? "");
}

function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

/**
 * What one row's chip says, and the clock it counts from.
 *
 * `ready` vs `published` is the variant's publication, not the job's: a job
 * stays `delivered` forever, and the draft it wrote may since have gone live.
 */
export function jobChip(
  entry: TranslationJobEntry,
  now: number,
): {
  kind: TranslationChipKind;
  /** Milliseconds translating (or queued), for the active kinds only. */
  elapsedMs: number | null;
  warnings: number;
} {
  const warnings = Array.isArray(entry.warnings) ? entry.warnings.length : 0;
  switch (entry.status) {
    case "queued": {
      const waiting = "started_at" in entry && entry.started_at === null;
      const since =
        (waiting ? null : parseTime(entry.started_at)) ??
        parseTime(entry.created_at) ??
        entry.firstSeenAt;
      return {
        kind: waiting ? "queued" : "translating",
        elapsedMs: Math.max(0, now - since),
        warnings,
      };
    }
    case "delivered":
      return {
        kind: entry.variant?.is_published ? "published" : "ready",
        elapsedMs: null,
        warnings,
      };
    case "refunded":
      return { kind: "refunded", elapsedMs: null, warnings };
    case "settled":
      return { kind: "settled", elapsedMs: null, warnings };
    default:
      return { kind: "unknown", elapsedMs: null, warnings };
  }
}

/** `0:42`, `3:05`, `1:02:09` — a stopwatch, not a sentence. */
export function formatElapsed(ms: number): string {
  const total = Math.floor(Math.max(0, ms) / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}`
    : `${minutes}:${seconds}`;
}

export interface JobSummary {
  total: number;
  /** Queued or translating. */
  active: number;
  /** Delivered drafts not yet published. */
  ready: number;
  published: number;
  failed: number;
}

export function summarizeJobs(jobs: Iterable<TranslationJobEntry>): JobSummary {
  const summary: JobSummary = {
    total: 0,
    active: 0,
    ready: 0,
    published: 0,
    failed: 0,
  };
  for (const job of jobs) {
    if (isDraftGone(job)) continue;
    summary.total += 1;
    if (job.status === "queued") summary.active += 1;
    else if (job.status === "delivered") {
      if (job.variant?.is_published) summary.published += 1;
      else summary.ready += 1;
    } else if (job.status === "refunded" || job.status === "settled")
      summary.failed += 1;
  }
  return summary;
}

/**
 * One row of the translations tray: a language, whatever we know about it
 * from its latest job, its saved variant, and its draft's warnings ( D,
 *  review "ONE place").
 *
 * - `flagged`: a draft whose producing job was delivered WITH warnings. It
 *   looks different from `ready` and is never published from the tray or in
 *   bulk — Review only.
 * - `failed`: the latest job was refunded or stopped. A draft from an earlier
 *   job may still be there (`hasDraft`), with its own warnings.
 * - `draft`: a saved, unpublished variant no job is about (written by hand,
 *   or older than the jobs list remembers).
 */
export type TrayRowKind =
  | "queued"
  | "translating"
  | "ready"
  | "flagged"
  | "failed"
  | "draft"
  | "published"
  | "unknown";

export interface TrayRow {
  language: string;
  kind: TrayRowKind;
  elapsedMs: number | null;
  /** Warnings on the draft that is there now (not on the latest job). */
  warnings: number;
  job: TranslationJobEntry | null;
  hasDraft: boolean;
  /** For `failed`: how it failed. */
  failure: "refunded" | "settled" | null;
  canDelete: boolean;
}

export interface TrayVariant {
  language: string;
  status: string;
  exists: boolean;
  isSource: boolean;
  canDelete: boolean;
}

export function trayRows({
  jobs,
  variants,
  drafts,
  now,
}: {
  jobs: readonly TranslationJobEntry[];
  variants: readonly TrayVariant[];
  drafts: Readonly<Record<string, DraftRecord>>;
  now: number;
}): TrayRow[] {
  const byLanguage = new Map(jobs.map((job) => [job.language, job]));
  const variantOf = new Map(
    variants
      .filter((variant) => !variant.isSource && variant.exists)
      .map((variant) => [variant.language, variant]),
  );
  const languages = new Set([...byLanguage.keys(), ...variantOf.keys()]);
  for (const variant of variants)
    if (variant.isSource) languages.delete(variant.language);
  const rows: TrayRow[] = [];
  for (const language of languages) {
    const job = byLanguage.get(language) ?? null;
    const variant = variantOf.get(language) ?? null;
    const warnings = drafts[language]?.warnings.length ?? 0;
    const published =
      variant?.status === "published" ||
      (job?.status === "delivered" && Boolean(job.variant?.is_published));
    // A saved variant, or the jobs list saying a translation exists
    // (`is_published` non-null) beside a job that did not replace it.
    const hasDraft =
      Boolean(variant) ||
      (job?.status === "delivered"
        ? !isDraftGone(job)
        : Boolean(job?.variant && !job.variant.is_published));
    const base = {
      language,
      job,
      hasDraft,
      warnings,
      elapsedMs: null as number | null,
      failure: null as TrayRow["failure"],
      canDelete: Boolean(variant?.canDelete ?? hasDraft),
    };
    if (job && isActiveJob(job)) {
      const chip = jobChip(job, now);
      rows.push({
        ...base,
        kind: chip.kind === "queued" ? "queued" : "translating",
        elapsedMs: chip.elapsedMs,
      });
    } else if (published) {
      rows.push({ ...base, kind: "published" });
    } else if (job?.status === "refunded" || job?.status === "settled") {
      rows.push({ ...base, kind: "failed", failure: job.status });
    } else if (job?.status === "delivered" && hasDraft) {
      rows.push({ ...base, kind: warnings ? "flagged" : "ready" });
    } else if (variant) {
      rows.push({ ...base, kind: warnings ? "flagged" : "draft" });
    } else if (job) {
      rows.push({ ...base, kind: "unknown" });
    }
  }
  return rows;
}

export interface TraySummary {
  /** Drafts to review, flagged or not. */
  ready: number;
  /** Of those, the clean ones — what "Publish all ready" may take. */
  clean: number;
  flagged: number;
  active: number;
  /** Failed latest jobs: a Retry is waiting. */
  attention: number;
  published: number;
}

export function summarizeTray(rows: readonly TrayRow[]): TraySummary {
  const summary: TraySummary = {
    ready: 0,
    clean: 0,
    flagged: 0,
    active: 0,
    attention: 0,
    published: 0,
  };
  for (const row of rows) {
    if (row.kind === "ready" || row.kind === "draft") {
      summary.ready += 1;
      summary.clean += 1;
    } else if (row.kind === "flagged") {
      summary.ready += 1;
      summary.flagged += 1;
    } else if (row.kind === "queued" || row.kind === "translating")
      summary.active += 1;
    else if (row.kind === "failed") summary.attention += 1;
    else if (row.kind === "published") summary.published += 1;
  }
  return summary;
}

/**
 * "3 ready to review · 1 translating · 2 need attention" — only the parts
 * that are not zero, and never counting published or finished-and-gone jobs
 * as "ready" ( review).
 */
export function summaryText(
  summary: Pick<TraySummary, "ready" | "active" | "attention">,
  t: Translate,
): string {
  const parts: string[] = [];
  if (summary.ready)
    parts.push(
      t("translationJobs.partReady", "{count} ready to review", {
        count: summary.ready,
      }),
    );
  if (summary.active)
    parts.push(
      t("translationJobs.partActive", "{count} translating", {
        count: summary.active,
      }),
    );
  if (summary.attention)
    parts.push(
      t("translationJobs.partAttention", "{count} need attention", {
        count: summary.attention,
      }),
    );
  return parts.join(" · ");
}

/** Every page's jobs, flattened — what the global indicator counts. */
export function allJobs(state: TranslationJobsState): TranslationJobEntry[] {
  return Object.values(state.pages).flatMap((page) => Object.values(page.jobs));
}

/** Delivered, unpublished languages of one page, in a stable order. */
export function readyLanguages(
  state: TranslationJobsState,
  page: string,
): string[] {
  return Object.values(state.pages[page]?.jobs ?? {})
    .filter(
      (job) =>
        job.status === "delivered" &&
        !isDraftGone(job) &&
        !job.variant?.is_published,
    )
    .map((job) => job.language)
    .sort();
}

/**
 * The page the global indicator should open: the one with something running,
 * else the one with something ready. Ties go to the article already open.
 */
export function indicatorPage(state: TranslationJobsState): string | null {
  let best: { page: string; score: number } | null = null;
  for (const [page, jobs] of Object.entries(state.pages)) {
    const summary = summarizeJobs(Object.values(jobs.jobs));
    const score =
      summary.active * 1000 +
      summary.ready * 10 +
      (page === state.editorPage ? 1 : 0);
    if (summary.active + summary.ready === 0) continue;
    if (!best || score > best.score) best = { page, score };
  }
  return best?.page ?? null;
}

/**
 * Fold one observation of a language's job into what we already know.
 *
 * - Same job id: the newer observation wins field by field, EXCEPT that a
 *   terminal job never goes back to `queued` (a stale poll that raced the
 *   settling one must not resurrect a spinner).
 * - Different job id: the language has a newer purchase. The server list and
 *   the status endpoint both answer "the latest job", so they win; a receipt
 *   from this browser's storage never replaces a job we already hold.
 */
export function mergeJob(
  existing: TranslationJobEntry | undefined,
  incoming: ServerTranslationJob,
  {
    page,
    now,
    fromReceipt = false,
  }: { page: string; now: number; fromReceipt?: boolean },
): TranslationJobEntry {
  if (!existing) {
    return {
      ...incoming,
      page,
      firstSeenAt: now,
      watching: false,
      interrupted: false,
      claimed: false,
      receiptOnly: fromReceipt,
      changedAt: now,
    };
  }
  if (existing.job_id === incoming.job_id) {
    if (isTerminalJob(existing) && !isTerminalJob(incoming)) return existing;
    const merged: TranslationJobEntry = {
      ...existing,
      ...incoming,
      page,
      firstSeenAt: existing.firstSeenAt,
      watching: existing.watching,
      interrupted: false,
      claimed: existing.claimed,
      receiptOnly: Boolean(existing.receiptOnly && fromReceipt),
      changedAt: incoming.status === existing.status ? existing.changedAt : now,
    };
    // The per-language status endpoint carries no `variant`. When the status
    // moved, what the list said about the draft before (usually "none yet")
    // is stale, so forget it rather than let it hide a fresh delivery.
    if (!("variant" in incoming) && incoming.status !== existing.status)
      delete merged.variant;
    // A status response can move a job to delivered without carrying the
    // current-draft snapshot. Never keep the queued listing's old snapshot;
    // the next authoritative listing supplies both provenance and revision.
    if (!("draft" in incoming) && incoming.status === "delivered")
      delete merged.draft;
    return merged;
  }
  if (fromReceipt) return existing;
  const before = parseTime(existing.created_at);
  const after = parseTime(incoming.created_at);
  if (before !== null && after !== null && after < before) return existing;
  return {
    ...incoming,
    page,
    firstSeenAt: now,
    watching: false,
    interrupted: false,
    claimed: existing.claimed,
    changedAt: now,
  };
}

export type TransitionListener = (
  entry: TranslationJobEntry,
  previousStatus: string,
) => void;

export interface TranslationJobsDeps {
  /** The jobs list, or `null` when the deployment has none. */
  list: (page: string) => Promise<JobsListing | ServerTranslationJob[] | null>;
  /** The latest job for one language (`GET.../variants/{lang}/translate/`). */
  status: (page: string, language: string) => Promise<ServerTranslationJob>;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  pollIntervalMs?: number;
  /** How long one poller follows a job before it waits to be resumed. */
  pollTimeoutMs?: number;
  /** Where draft warnings survive a reload. Omit for none (tests, SSR). */
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /**
   * How long ONE status read may take before it counts as an interruption.
   * Without it a request that stalls mid-response leaves the poller awaiting
   * forever — past its own deadline, still "watching", and refusing `resume`
   * (codex adversarial review).
   */
  requestTimeoutMs?: number;
}

function emptyPage(): PageJobs {
  return {
    listSupported: null,
    loading: false,
    error: false,
    jobs: {},
    drafts: {},
  };
}

const DRAFTS_KEY = (page: string) => `translation-draft-warnings:${page}`;

export function createTranslationJobs(deps: TranslationJobsDeps) {
  const now = deps.now ?? (() => Date.now());
  const schedule =
    deps.schedule ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const cancel =
    deps.cancel ??
    ((handle: unknown) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>));
  const interval = deps.pollIntervalMs ?? 3000;
  const timeout = deps.pollTimeoutMs ?? 15 * 60 * 1000;
  const requestTimeout = deps.requestTimeoutMs ?? 30_000;

  /** `promise`, or a rejection once `ms` pass — on the injected clock. */
  function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = schedule(
        () => reject(new Error("status read timed out")),
        ms,
      );
      promise.then(
        (value) => {
          cancel(timer);
          resolve(value);
        },
        (error) => {
          cancel(timer);
          reject(error);
        },
      );
    });
  }

  const store = writable<TranslationJobsState>({
    pages: {},
    trayPage: null,
    review: null,
    editorPage: null,
  });
  const pollers = new Map<
    string,
    { handle: unknown; deadline: number; generation: number }
  >();
  const listeners = new Set<TransitionListener>();
  let generation = 0;
  /** Bumped by `reset`: an answer for an older epoch is dropped. */
  let epoch = 0;

  const key = (page: string, language: string) => `${page}\u0000${language}`;

  function loadDrafts(page: string): Record<string, DraftRecord> {
    try {
      const raw = deps.storage?.getItem(DRAFTS_KEY(page));
      const parsed = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== "object") return {};
      const drafts: Record<string, DraftRecord> = {};
      for (const [language, record] of Object.entries(parsed)) {
        const value = record as Partial<DraftRecord> | null;
        if (value && (typeof value.jobId === "string" || value.jobId === null))
          drafts[language] = {
            jobId: value.jobId,
            warnings: jobWarnings(value as { warnings?: TranslationWarning[] }),
            priorWarnings: jobWarnings({ warnings: value.priorWarnings }),
            ...(typeof value.revision === "string"
              ? { revision: value.revision }
              : {}),
          };
      }
      return drafts;
    } catch {
      return {};
    }
  }

  function saveDrafts(page: string, drafts: Record<string, DraftRecord>) {
    try {
      if (Object.keys(drafts).length)
        deps.storage?.setItem(DRAFTS_KEY(page), JSON.stringify(drafts));
      else deps.storage?.removeItem(DRAFTS_KEY(page));
    } catch {
      /* Storage full or blocked: this tab still knows. */
    }
  }

  function updatePage(page: string, change: (jobs: PageJobs) => PageJobs) {
    store.update((state) => ({
      ...state,
      pages: {
        ...state.pages,
        [page]: change(
          state.pages[page] ?? { ...emptyPage(), drafts: loadDrafts(page) },
        ),
      },
    }));
  }

  /** Record (or forget) what the draft in `language` was written by. */
  function noteDraft(
    page: string,
    language: string,
    record: DraftRecord | null,
  ) {
    const current = get(store).pages[page]?.drafts?.[language] ?? null;
    if (JSON.stringify(current) === JSON.stringify(record)) return;
    let next: Record<string, DraftRecord> = {};
    updatePage(page, (jobs) => {
      next = { ...jobs.drafts };
      if (record) next[language] = record;
      else delete next[language];
      return { ...jobs, drafts: next };
    });
    saveDrafts(page, next);
  }

  function entry(page: string, language: string) {
    return get(store).pages[page]?.jobs[language];
  }

  function setFlags(
    page: string,
    language: string,
    flags: Partial<
      Pick<TranslationJobEntry, "watching" | "interrupted" | "claimed">
    >,
  ) {
    if (!entry(page, language)) return;
    updatePage(page, (jobs) => ({
      ...jobs,
      jobs: {
        ...jobs.jobs,
        [language]: { ...jobs.jobs[language], ...flags },
      },
    }));
  }

  function emit(next: TranslationJobEntry, previousStatus: string) {
    for (const listener of [...listeners]) {
      try {
        listener(next, previousStatus);
      } catch {
        /* A broken listener must not stop the others or the poller. */
      }
    }
  }

  /** Fold an observation in; start or stop the poller to match. */
  function ingest(
    page: string,
    job: ServerTranslationJob,
    options: { fromReceipt?: boolean } = {},
  ): TranslationJobEntry | null {
    if (!page || !job || typeof job.language !== "string" || !job.job_id)
      return null;
    const language = job.language;
    const previous = entry(page, language);
    const next = mergeJob(previous, job, {
      page,
      now: now(),
      fromReceipt: options.fromReceipt,
    });
    if (next !== previous) {
      updatePage(page, (jobs) => ({
        ...jobs,
        jobs: { ...jobs.jobs, [language]: next },
      }));
    }
    // A delivery wrote the draft: from now on the draft's warnings are THIS
    // job's (an empty list is a clean draft). A refund or a running job
    // changes nothing about the draft already there.
    if ("draft" in next) {
      const draft = next.draft;
      if (draft)
        noteDraft(page, language, {
          jobId: draft.job_id,
          warnings: jobWarnings(draft),
          priorWarnings: jobWarnings({ warnings: draft.prior_warnings }),
          revision: draft.revision,
        });
      else noteDraft(page, language, null);
    } else if (next.status === "delivered") {
      // Status polling has no atomic current-draft snapshot. Its warnings may
      // describe a delivery that was already replaced, so it cannot establish
      // provenance or a publish validator on its own.
      noteDraft(page, language, null);
    }
    // A transition is something we SAW happen: queued → terminal on the same
    // job. Finding last week's delivered job on a reload is not news.
    if (
      previous &&
      previous.job_id === next.job_id &&
      previous.status === ACTIVE_JOB_STATUS &&
      isTerminalJob(next)
    ) {
      emit(next, previous.status);
    }
    if (isActiveJob(next)) startPoller(page, language);
    else stopPoller(page, language);
    return next;
  }

  function stopPoller(page: string, language: string) {
    const id = key(page, language);
    const poller = pollers.get(id);
    if (!poller) return;
    cancel(poller.handle);
    pollers.delete(id);
    const current = entry(page, language);
    if (current && !current.claimed)
      setFlags(page, language, { watching: false });
  }

  function startPoller(page: string, language: string) {
    const current = entry(page, language);
    if (!current || !isActiveJob(current) || current.claimed) return;
    const id = key(page, language);
    if (pollers.has(id)) return;
    const mine = ++generation;
    const deadline = now() + timeout;
    const tick = async () => {
      const poller = pollers.get(id);
      if (!poller || poller.generation !== mine) return;
      const watched = entry(page, language);
      if (!watched || watched.claimed || !isActiveJob(watched)) {
        pollers.delete(id);
        return;
      }
      try {
        const latest = await bounded(
          deps.status(page, language),
          requestTimeout,
        );
        if (pollers.get(id)?.generation !== mine) return;
        if (latest?.language === language && latest.job_id) {
          ingest(page, latest);
        } else {
          setFlags(page, language, { interrupted: true });
        }
      } catch {
        if (pollers.get(id)?.generation !== mine) return;
        // A lost connection is not a failed translation. Keep watching.
        setFlags(page, language, { interrupted: true });
      }
      const still = pollers.get(id);
      if (!still || still.generation !== mine) return;
      if (!isActiveJob(entry(page, language))) {
        stopPoller(page, language);
        return;
      }
      if (now() >= still.deadline) {
        // Stop asking, not caring: the job settles server-side either way,
        // and `resume` (tray open, editor return, tab focus) picks it up.
        pollers.delete(id);
        setFlags(page, language, { watching: false });
        return;
      }
      still.handle = schedule(() => void tick(), interval);
    };
    pollers.set(id, {
      handle: schedule(() => void tick(), interval),
      deadline,
      generation: mine,
    });
    setFlags(page, language, { watching: true });
  }

  /** Restart pollers for this page's running jobs (or one language). */
  function resume(page: string, language?: string) {
    const jobs = get(store).pages[page]?.jobs ?? {};
    for (const job of Object.values(jobs)) {
      if (language && job.language !== language) continue;
      if (isActiveJob(job)) startPoller(page, job.language);
    }
  }

  /**
   * Ask the server what this article's jobs are. Returns whether the list is
   * supported; on `false` the caller keeps the per-language fallback.
   */
  async function refresh(page: string): Promise<boolean> {
    if (!page) return false;
    const mine = epoch;
    updatePage(page, (jobs) => ({ ...jobs, loading: true }));
    try {
      const answer = await deps.list(page);
      // Asked for an account that is no longer signed in: not ours to show.
      if (mine !== epoch) return false;
      const listing =
        answer === null
          ? null
          : Array.isArray(answer)
            ? normalizeJobsListing(answer)
            : answer;
      if (listing === null) {
        updatePage(page, (jobs) => ({
          ...jobs,
          listSupported: false,
          loading: false,
          error: false,
        }));
        resume(page);
        return false;
      }
      updatePage(page, (jobs) => ({
        ...jobs,
        listSupported: true,
        loading: false,
        error: false,
        inFlight: listing.inFlight,
        capacity: listing.capacity,
        maxInFlight: listing.maxInFlight,
      }));
      for (const row of listing.jobs) ingest(page, row);
      if (listing.drafts) {
        updatePage(page, (jobs) => {
          const drafts: Record<string, DraftRecord> = {};
          for (const [language, snapshot] of Object.entries(listing.drafts!)) {
            if (!snapshot) continue;
            drafts[language] = {
              jobId: snapshot.job_id,
              warnings: jobWarnings({ warnings: snapshot.warnings }),
              priorWarnings: jobWarnings({
                warnings: snapshot.prior_warnings,
              }),
              revision: snapshot.revision,
            };
          }
          saveDrafts(page, drafts);
          return { ...jobs, drafts };
        });
      }
      resume(page);
      return true;
    } catch {
      if (mine !== epoch) return false;
      updatePage(page, (jobs) => ({ ...jobs, loading: false, error: true }));
      resume(page);
      return get(store).pages[page]?.listSupported === true;
    }
  }

  /** The editor's own watcher follows this language; stand down. */
  function claim(page: string, language: string) {
    const id = key(page, language);
    const poller = pollers.get(id);
    if (poller) {
      cancel(poller.handle);
      pollers.delete(id);
    }
    setFlags(page, language, { claimed: true, watching: true });
  }

  /** The editor stopped watching; keep following it from here. */
  function release(page: string, language: string) {
    setFlags(page, language, { claimed: false, watching: false });
    startPoller(page, language);
  }

  function markPublished(page: string, language: string) {
    const current = entry(page, language);
    if (!current) return;
    updatePage(page, (jobs) => ({
      ...jobs,
      jobs: {
        ...jobs.jobs,
        [language]: {
          ...current,
          variant: { ...(current.variant ?? {}), is_published: true },
        },
      },
    }));
  }

  /** The variant was deleted: its job row has nothing left to act on. */
  function remove(page: string, language: string) {
    noteDraft(page, language, null);
    const id = key(page, language);
    const poller = pollers.get(id);
    if (poller) cancel(poller.handle);
    pollers.delete(id);
    updatePage(page, (jobs) => {
      const rest = { ...jobs.jobs };
      delete rest[language];
      return { ...jobs, jobs: rest };
    });
  }

  function onTransition(listener: TransitionListener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function stopAll() {
    for (const poller of pollers.values()) cancel(poller.handle);
    pollers.clear();
  }

  /** Forget everything: another account signed in (or none is). */
  function reset() {
    epoch += 1;
    stopAll();
    store.set({ pages: {}, trayPage: null, review: null, editorPage: null });
  }

  return {
    subscribe: store.subscribe,
    ingest,
    refresh,
    resume,
    claim,
    release,
    markPublished,
    remove,
    onTransition,
    stopAll,
    reset,
    isPolling: (page: string, language: string) =>
      pollers.has(key(page, language)),
    openTray: (page: string) => store.update((s) => ({ ...s, trayPage: page })),
    closeTray: () => store.update((s) => ({ ...s, trayPage: null })),
    requestReview: (page: string, language: string) =>
      store.update((s) => ({ ...s, review: { page, language } })),
    clearReview: () => store.update((s) => ({ ...s, review: null })),
    setEditorPage: (page: string | null) =>
      store.update((s) => ({ ...s, editorPage: page })),
  };
}

export type TranslationJobsStore = ReturnType<typeof createTranslationJobs>;

/**
 * Jobs this browser remembers buying, from the editor's receipts.
 *
 * The editor keeps `translation-receipt:{user}:{page}` (the latest) and
 * `…:job:{id}` (a bounded history, one per purchase) — the history was written
 * and never read until now. They seed the tray for a deployment with
 * no jobs list, and fill the gap before the list answers on one that has it.
 */
export function receiptJobs(
  storage: Pick<Storage, "getItem" | "key" | "length">,
  base: string,
): ServerTranslationJob[] {
  const found = new Map<string, ServerTranslationJob>();
  const read = (storageKey: string) => {
    try {
      const value = JSON.parse(storage.getItem(storageKey) ?? "null");
      const job = value?.job;
      if (
        job &&
        typeof job.job_id === "string" &&
        typeof (job.language ?? value.language) === "string"
      ) {
        found.set(job.job_id, {
          ...job,
          language: job.language ?? value.language,
        });
      }
    } catch {
      /* One unreadable receipt never hides the others. */
    }
  };
  read(base);
  for (let index = 0; index < storage.length; index += 1) {
    const storageKey = storage.key(index);
    if (storageKey?.startsWith(`${base}:job:`)) read(storageKey);
  }
  // Newest purchase per language wins; ids are opaque, so order by created_at
  // where a receipt kept it and otherwise by what the latest index says.
  const latest = new Map<string, ServerTranslationJob>();
  for (const job of found.values()) {
    const held = latest.get(job.language);
    const heldAt = parseTime(held?.created_at);
    const jobAt = parseTime(job.created_at);
    if (!held || (jobAt !== null && (heldAt === null || jobAt > heldAt)))
      latest.set(job.language, job);
  }
  // The index (`base`) is the authoritative "latest" for its language.
  try {
    const indexed = JSON.parse(storage.getItem(base) ?? "null")?.job;
    if (indexed?.job_id && found.has(indexed.job_id))
      latest.set(indexed.language, found.get(indexed.job_id)!);
  } catch {
    /* ignore */
  }
  return [...latest.values()];
}
