/**
 * The ONE resolver for first-party content cards ( part 2, ).
 *
 * `first-party-embed.ts` decides what an `::embed[]` IS; the card builders in
 * `first-party-embed-cards.ts` decide what a reader may SEE of it. This module
 * is the part in between that both the server loader
 * (`$lib/server/first-party-embed-cards.ts`, SSR'd bodies) and the browser
 * resolver (`$lib/first-party-card-resolver.ts`, client-loaded bodies and the
 * editor previews) share, so there is one planner, one request builder, one
 * bounded reader and one card builder — not a server copy and a client copy:
 *
 *  - **A ledger per page view** (`createFirstPartyCardLedger`). Every markdown
 *    body on the page is planned into ONE ledger: embeds are collected with
 *    the renderer's own collector (so its per-body cap, `MAX_FIRST_PARTY_CARDS`
 *    distinct calls, applies to every body), then grouped by API call
 *    (`firstPartyCardCallKey`: host + API path + asked language). A call is
 *    made at most once per ledger however many bodies embed it — 50 comments
 *    embedding the same page are ONE call — and a ledger opens at most
 *    `maxCalls` calls in total: that is the page-level fan-out budget, and an
 *    embed past it is simply never fetched (neutral card).
 *
 *  - **The API, never the route** (`firstPartyCardRequestPath`). The only
 *    request this module will describe is `GET /api/zpage/<segment>/` or
 *    `GET /api/comments/<uuid>/` plus an optional normalized `lang`. The
 *    identifier has already passed the classifier's grammar; the path is
 *    re-checked against an exact pattern here, at the one place every caller
 *    builds its URL, so nothing an author writes can steer a credentialed
 *    request (the browser's same-origin cookie, or the forwarded SSR cookie)
 *    anywhere else.
 *
 *  - **Bounded** (`readFirstPartyCardBody`). Only a `200` is read, at most
 *    `MAX_FIRST_PARTY_CARD_RESPONSE_BYTES`, and it is immediately PRUNED to
 *    the fields the card builders read (`pruneFirstPartyCardBody`): a ledger
 *    that keeps answers so a later body can reuse them holds a few hundred
 *    bytes per call, never a whole article.
 *
 * Nothing here reads credentials, environment or the network by itself: the
 * caller supplies `fetch` and decides which credentials ride on it (the
 * reader's own, always — see the two callers).
 */
import { collectFirstPartyContentEmbeds } from "./markdown";
import {
  converseCardFromApi,
  firstPartyCardApiPath,
  firstPartyCardLanguage,
  firstPartyContentHost,
  firstPartyContentKey,
  FIRST_PARTY_CARD_SOURCE_MAX,
  zpageCardFromApi,
  type FirstPartyCard,
  type FirstPartyCardMap,
  type FirstPartyContentEmbed,
} from "./first-party-embed-cards";

/**
 * The most distinct card API calls ONE page view makes, across every body on
 * the page (article, bio, converse posts, comments) and across the server and
 * the browser together: the browser ledger is seeded with the calls the
 * server already made, and they count against this budget.
 */
export const MAX_PAGE_FIRST_PARTY_CARD_CALLS = 16;

/**
 * A zPage detail body is at most ~100 000 characters of content plus
 * metadata; anything beyond this is not a card we want to parse.
 */
export const MAX_FIRST_PARTY_CARD_RESPONSE_BYTES = 1_000_000;

/**
 * What a server render hands the browser: the cards it resolved for this
 * reader (only accepted ones — nothing gated), and the call keys it ATTEMPTED
 * (accepted, refused or timed out alike), so the browser neither repeats them
 * nor exceeds the page budget.
 */
export type FirstPartyCardSeed = {
  cards: FirstPartyCardMap;
  calls: string[];
  /**
   * The content keys the server planned onto those calls (accepted or not).
   * Derived from markdown the reader already has. A body the browser loads
   * later may spell a seeded call another way (`/article/post` for a seeded
   * `/alice/post`): that NEW key reopens the call once, while a key the
   * server already answered (card or neutral) never does.
   */
  keys?: string[];
  /**
   * The render carried a session cookie. The browser re-resolves such a seed
   * once it knows who is signed in: a cookie is not an identity (it may have
   * been switched or revoked in another tab since the server rendered).
   */
  session?: boolean;
};

export type FirstPartyCardCall = {
  /** `firstPartyCardCallKey`: host + API path + asked language. */
  key: string;
  apiPath: string;
  language: string | null;
};

const CARD_API_PATH =
  /^\/api\/(?:zpage\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,149}|comments\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/$/;
// A normalized content-language tag (`normalizeContentLanguage` output).
const CARD_LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

/** Is this exactly one of the two card API paths? */
export function isFirstPartyCardApiPath(path: unknown): path is string {
  return typeof path === "string" && CARD_API_PATH.test(path);
}

/**
 * The root-relative request (path and query) for one card call, or `null`
 * when the call is not exactly a card lookup. Every caller — server and
 * browser — builds its URL from this and nothing else.
 */
export function firstPartyCardRequestPath(
  call: Pick<FirstPartyCardCall, "apiPath" | "language">,
): string | null {
  if (!isFirstPartyCardApiPath(call.apiPath)) return null;
  if (
    call.language === null ||
    call.language === undefined ||
    call.language === ""
  ) {
    return call.apiPath;
  }
  if (typeof call.language !== "string" || !CARD_LANGUAGE.test(call.language))
    return null;
  return `${call.apiPath}?lang=${encodeURIComponent(call.language)}`;
}

/** The call one embed needs, for a reader whose UI locale is `locale`. */
export function firstPartyCardCallFor(
  embed: FirstPartyContentEmbed,
  locale: string | null | undefined,
): FirstPartyCardCall {
  const apiPath = firstPartyCardApiPath(embed);
  const language =
    embed.kind === "zpage" ? firstPartyCardLanguage(embed, locale) : null;
  return {
    key: `${firstPartyContentHost(embed)}${apiPath}?lang=${language ?? ""}`,
    apiPath,
    language,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function usernameOnly(value: unknown): { username: unknown } | undefined {
  const person = record(value);
  return person ? { username: person.username } : undefined;
}

function sourceText(value: unknown): unknown {
  return typeof value === "string"
    ? value.slice(0, FIRST_PARTY_CARD_SOURCE_MAX)
    : value;
}

/**
 * Keep exactly what `zpageCardFromApi` / `converseCardFromApi` read, so a
 * kept answer is a few hundred bytes. The upsell markers are kept as
 * presence (`true`), never their redacted content. A test asserts that every
 * builder gives the same card for the pruned body as for the whole one — a
 * builder that starts reading a new field must add it here.
 */
export function pruneFirstPartyCardBody(body: unknown): unknown {
  const value = record(body);
  if (!value) return null;
  const pruned: Record<string, unknown> = {};
  if ("show_modal" in value) pruned.show_modal = true;
  if ("page" in value) pruned.page = true;
  for (const field of [
    "vanity",
    "free2zaddr",
    "title",
    "actual_language",
    "available_languages",
    "uuid",
    "headline",
  ]) {
    if (field in value) pruned[field] = value[field];
  }
  if ("description" in value) {
    // The builder asks `description.trim()` of the WHOLE string before it
    // excerpts the first FIRST_PARTY_CARD_SOURCE_MAX characters, so the
    // shortened copy is kept only when it gives the same answer.
    const short = sourceText(value.description);
    pruned.description =
      typeof short === "string" && !short.trim() ? value.description : short;
  }
  if ("content" in value) pruned.content = sourceText(value.content);
  if ("creator" in value) pruned.creator = usernameOnly(value.creator);
  if ("author" in value) pruned.author = usernameOnly(value.author);
  return pruned;
}

/**
 * The body of a card response, or `null` for anything but a full `200`
 * within the byte cap. Never throws for a bad body; rethrows an abort.
 */
export async function readFirstPartyCardBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.status !== 200 || !response.body) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  const onAbort = () => void reader.cancel(signal.reason).catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw signal.reason;
      const { done, value } = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_FIRST_PARTY_CARD_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
    try {
      return pruneFirstPartyCardBody(JSON.parse(text + decoder.decode()));
    } catch {
      return null;
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function cardFor(
  embed: FirstPartyContentEmbed,
  body: unknown,
  language: string | null,
): FirstPartyCard | null {
  if (body === null || body === undefined) return null;
  return embed.kind === "zpage"
    ? zpageCardFromApi(embed, body, language)
    : converseCardFromApi(embed, body);
}

type LedgerEntry = FirstPartyCardCall & {
  /** Every embed (by content key) this page has that needs this call. */
  embeds: Map<string, FirstPartyContentEmbed>;
  /**
   * pending: asked, no answer yet. settled: answered (`body` may be null).
   * seeded: the server made this call; its accepted cards came in the seed.
   */
  state: "pending" | "settled" | "seeded";
  body: unknown;
};

export type FirstPartyCardPlan = {
  /** Calls this plan opened; the caller must make each and `settle` it. */
  calls: FirstPartyCardCall[];
  /** Cards available right away from calls already answered in this ledger. */
  cards: FirstPartyCardMap;
};

export type FirstPartyCardLedger = {
  plan(
    content: string | null | undefined,
    locale?: string | null,
  ): FirstPartyCardPlan;
  settle(key: string, body: unknown): FirstPartyCardMap;
  /** Every call this ledger has opened (or was seeded with), in order. */
  calls(): string[];
  /** Every content key planned onto a call, in order. */
  keys(): string[];
  /** The content keys planned onto one call. */
  keysOf(callKey: string): string[];
  /** Requests spent on this ledger so far (seeded, opened and reopened). */
  spent(): number;
};

// A memo, not a record: `plan` of a body it has already planned is a no-op.
// Keyed by a hash (not the text) and bounded least-recently-used, so a feed
// of thousands of bodies neither re-lexes all of them on every flush (the
// old clear-at-256 did) nor holds every body's text, and an editor session's
// stream of drafts cannot grow it forever. A collision only means a body is
// not planned again — it keeps whatever cards it has (fail-safe: neutral).
export const PLANNED_MEMO_MAX = 4096;

/** A 64-bit-ish content hash (two FNV-1a lanes + length). Not a MAC. */
export function firstPartyContentHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x5bd1e995) >>> 0;
  }
  return `${a.toString(36)}.${b.toString(36)}.${text.length.toString(36)}`;
}

/** A small least-recently-used set. */
export function createLruSet(max: number) {
  const items = new Map<string, true>();
  return {
    has(key: string) {
      if (!items.has(key)) return false;
      items.delete(key);
      items.set(key, true);
      return true;
    },
    add(key: string) {
      items.delete(key);
      items.set(key, true);
      while (items.size > max) {
        const oldest = items.keys().next().value;
        if (oldest === undefined) break;
        items.delete(oldest);
      }
    },
    get size() {
      return items.size;
    },
  };
}

/**
 * One page view's (or one editor session's) card calls. See the module
 * comment; `maxCalls` is the page-level budget and seeded calls count.
 */
export function createFirstPartyCardLedger(options: {
  /** `firstPartyCardHost(...)` of the host being read. */
  host: string;
  maxCalls: number;
  seed?: FirstPartyCardSeed | null;
  /**
   * Calls already spent on this page view elsewhere (a session seed being
   * re-checked: the server made them) — they count against `maxCalls`.
   */
  reserved?: number;
}): FirstPartyCardLedger {
  const entries = new Map<string, LedgerEntry>();
  const planned = createLruSet(PLANNED_MEMO_MAX);
  // Requests this page view has made or will make: seeded calls (the server
  // made them), opened calls, and REOPENED seeded calls alike. The budget is
  // on this count, not on distinct keys (codex R2: reopened aliases).
  let dispatched = 0;
  const reopenAliases = Array.isArray(options.seed?.keys);
  const seededKeys = new Set<string>(
    (options.seed?.keys ?? []).filter((key) => typeof key === "string"),
  );
  const maxCalls = Math.max(
    0,
    Math.floor(options.maxCalls) -
      Math.max(0, Math.floor(options.reserved ?? 0)),
  );

  for (const key of options.seed?.calls ?? []) {
    if (typeof key !== "string" || entries.has(key)) continue;
    if (dispatched >= maxCalls) break;
    dispatched += 1;
    entries.set(key, {
      key,
      apiPath: "",
      language: null,
      embeds: new Map(),
      state: "seeded",
      body: null,
    });
  }

  return {
    plan(content, locale = null) {
      const calls: FirstPartyCardCall[] = [];
      const cards: FirstPartyCardMap = {};
      // The memo is per language: the same body planned for another locale
      // asks different calls.
      if (!content) return { calls, cards };
      const memo = firstPartyContentHash(`${locale ?? ""}\n${content}`);
      if (planned.has(memo)) return { calls, cards };
      planned.add(memo);
      for (const embed of collectFirstPartyContentEmbeds(
        content,
        options.host,
      )) {
        const call = firstPartyCardCallFor(embed, locale);
        if (!firstPartyCardRequestPath(call)) continue;
        let entry = entries.get(call.key);
        if (!entry) {
          // The page budget: past it, an embed is never fetched.
          if (dispatched >= maxCalls) continue;
          dispatched += 1;
          entry = { ...call, embeds: new Map(), state: "pending", body: null };
          entries.set(call.key, entry);
          calls.push(call);
        }
        const contentKey = firstPartyContentKey(embed);
        if (entry.embeds.has(contentKey)) continue;
        entry.embeds.set(contentKey, embed);
        if (entry.state === "seeded") {
          // A seed that does not say which keys it planned is never reopened.
          if (!reopenAliases || seededKeys.has(contentKey)) continue;
          // A second request for the same call: it needs budget of its own.
          if (dispatched >= maxCalls) continue;
          dispatched += 1;
          // A spelling the server never planned: its card needs the answer,
          // which the seed does not carry. Reopen the call once, if the
          // budget allows a second request.
          Object.assign(entry, call, { state: "pending" as const });
          calls.push(call);
          continue;
        }
        if (entry.state === "settled") {
          const card = cardFor(embed, entry.body, entry.language);
          if (card) cards[contentKey] = card;
        }
      }
      return { calls, cards };
    },

    settle(key, body) {
      const entry = entries.get(key);
      const cards: FirstPartyCardMap = {};
      if (!entry || entry.state !== "pending") return cards;
      entry.state = "settled";
      entry.body = pruneFirstPartyCardBody(body);
      for (const [contentKey, embed] of entry.embeds) {
        const card = cardFor(embed, entry.body, entry.language);
        if (card) cards[contentKey] = card;
      }
      return cards;
    },

    calls() {
      return [...entries.keys()];
    },

    keys() {
      return [...entries.values()].flatMap((entry) => [...entry.embeds.keys()]);
    },

    spent() {
      return dispatched + Math.max(0, Math.floor(options.reserved ?? 0));
    },

    keysOf(callKey) {
      return [...(entries.get(callKey)?.embeds.keys() ?? [])];
    },
  };
}
